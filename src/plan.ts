import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { FormatView } from './api.ts';
import type { IfExists } from './inputs.ts';

/** A file's extension as Converter Studio counts it (`tar.gz` is one), lower case, or `''`. */
export function extensionOf(fileName: string): string {
  const match = /\.(tar\.gz|[^./\\]+)$/i.exec(basename(fileName));
  return match && match.index > 0 ? match[1].toLowerCase() : '';
}

/** A file's name without its extension: `report.final.docx` → `report.final`, `site.tar.gz` → `site`. */
export function stemOf(fileName: string): string {
  const name = basename(fileName);
  const extension = extensionOf(name);
  return extension ? name.slice(0, name.length - extension.length - 1) : name;
}

/** The format a target names: a format ID (`jpg`) or one of its extensions (`jpeg`). */
export function findTarget(formats: readonly FormatView[], to: string): FormatView | undefined {
  return formats.find((f) => f.id === to) ?? formats.find((f) => f.extensions.includes(to));
}

/** The format a file's extension suggests (Converter Studio itself goes by the file's bytes). */
export function formatOfFile(
  formats: readonly FormatView[],
  fileName: string,
): FormatView | undefined {
  const extension = extensionOf(fileName);
  return extension ? formats.find((f) => f.extensions.includes(extension)) : undefined;
}

/** The deepest folder that holds all of `dirs` (absolute), or `null` when there is none (two drives). */
export function commonRoot(dirs: readonly string[]): string | null {
  if (dirs.length === 0) return null;
  const split = dirs.map((dir) => resolve(dir).split(sep));
  const first = split[0];
  let length = first.length;
  for (const parts of split.slice(1)) {
    let i = 0;
    while (i < length && i < parts.length && parts[i] === first[i]) i++;
    length = i;
  }
  if (length === 0) return null;
  const root = first.slice(0, length).join(sep);
  return root === '' ? sep : root;
}

/** One file to convert, and where its result goes. */
export interface Task {
  /** The source file (absolute). */
  readonly source: string;
  /** Where the result goes (absolute), with the target format's extension. */
  readonly destination: string;
  /** The destination's folder. */
  readonly dir: string;
  /** The destination's name without its extension (the result's extension may differ: a ZIP of pages). */
  readonly stem: string;
  readonly extension: string;
}

export interface PlanInput {
  /** The files that matched (absolute). */
  readonly sources: readonly string[];
  /** Folders the patterns start from: with `outputDir`, results keep their place below them. */
  readonly roots: readonly string[];
  readonly outputDir: string | null;
  /** The extension of the target format. */
  readonly extension: string;
  /** Other extensions a result can have (a PDF made into pictures is a ZIP when it has several pages). */
  readonly alternates: readonly string[];
  readonly ifExists: IfExists;
  readonly exists: (path: string) => boolean;
  /** Whether two names that differ only in case are the same file (Windows, macOS). */
  readonly caseInsensitive: boolean;
  /** Why a file cannot be converted, when that is known before uploading it. */
  readonly refuse?: (source: string) => string | undefined;
}

export interface Plan {
  readonly tasks: Task[];
  /** Results that exist already and are kept (`if-exists: skip`). */
  readonly skipped: { readonly source: string; readonly destination: string }[];
  /** Results that exist already, for `if-exists: fail`. */
  readonly existing: { readonly source: string; readonly destination: string }[];
  /** Files that are not converted, and why. */
  readonly refused: { readonly source: string; readonly message: string }[];
}

/**
 * Where each file's result goes and which files are converted. Results go next to their source,
 * or below `outputDir` in the same folders as below the patterns' common folder. A result never
 * replaces a source file, and two sources never share a result.
 */
export function planConversions(input: PlanInput): Plan {
  const key = (path: string) => (input.caseInsensitive ? path.toLowerCase() : path);
  const root = commonRoot(input.roots);
  const sources = new Set(input.sources.map(key));
  const planned: Task[] = [];
  const refused: { source: string; message: string }[] = [];

  for (const source of input.sources) {
    const reason = input.refuse?.(source);
    if (reason) {
      refused.push({ source, message: reason });
      continue;
    }
    let dir = dirname(source);
    if (input.outputDir) {
      const below = root ? relative(root, dir) : '';
      dir =
        below && !below.startsWith('..') && !isAbsolute(below)
          ? join(input.outputDir, below)
          : input.outputDir;
    }
    let stem = stemOf(source) || 'converted';
    // The same format in and out (a smaller PDF) next to the source: the website's name for it.
    if (key(join(dir, `${stem}.${input.extension}`)) === key(source)) stem = `${stem}-compressed`;
    const destination = join(dir, `${stem}.${input.extension}`);
    if (sources.has(key(destination))) {
      refused.push({
        source,
        message: `Its result would replace another file that is being converted (${basename(destination)}). Set 'output-dir', or leave that file out of 'files'.`,
      });
      continue;
    }
    planned.push({ source, destination, dir, stem, extension: input.extension });
  }

  // Two sources with one result (photo.png and photo.jpg → photo.webp): neither is converted.
  const byDestination = new Map<string, Task[]>();
  for (const task of planned) {
    const list = byDestination.get(key(task.destination)) ?? [];
    list.push(task);
    byDestination.set(key(task.destination), list);
  }
  const tasks: Task[] = [];
  const skipped: { source: string; destination: string }[] = [];
  const existing: { source: string; destination: string }[] = [];
  for (const task of planned) {
    const shared = byDestination.get(key(task.destination)) ?? [];
    if (shared.length > 1) {
      const others = shared.filter((t) => t !== task).map((t) => basename(t.source));
      refused.push({
        source: task.source,
        message: `Its result ${basename(task.destination)} would also be the result of ${others.join(', ')}. Convert them in separate steps, or into different output folders.`,
      });
      continue;
    }
    const found = [task.extension, ...input.alternates]
      .map((extension) => join(task.dir, `${task.stem}.${extension}`))
      .find((path) => input.exists(path));
    if (found && input.ifExists === 'skip')
      skipped.push({ source: task.source, destination: found });
    else {
      if (found) existing.push({ source: task.source, destination: found });
      tasks.push(task);
    }
  }
  return { tasks, skipped, existing, refused };
}
