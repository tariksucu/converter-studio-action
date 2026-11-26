import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import type { Plan } from './plan.ts';

/**
 * `if-exists: changed` keeps a small manifest next to the results, `.converter-studio.json` in
 * each folder that holds some: for every result, a hash of the source it was made from and of the
 * settings it was made with. Committed with the results, it says in a fresh checkout (where file
 * times mean nothing) whether a result is still what its source and settings make.
 */
export const MANIFEST_NAME = '.converter-studio.json';
const MANIFEST_VERSION = 1;
const ABOUT =
  'Written by the Converter Studio GitHub Action (if-exists: changed): the source and settings each result in this folder was made from. Commit it with the results; delete it to convert them again.';

/** What one result was made from. */
export interface ResultRecord {
  /** The source, relative to the manifest's folder (for people reading it; not compared). */
  readonly source: string;
  /** SHA-256 of the source's bytes. */
  readonly sha256: string;
  /** SHA-256 of the target format and the options (see `settingsHash`). */
  readonly settings: string;
}

interface ManifestFile {
  about: string;
  version: number;
  results: Record<string, ResultRecord>;
}

/** JSON with the keys of every object in order, so the same settings always hash the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The hash of what decides a result besides its source: the target format and the options. An
 * archive's `password` is left out: it opens the archive and changes nothing in the result, and
 * the manifest is committed (a hash of a short password could be guessed back).
 */
export function settingsHash(to: string, options: Record<string, unknown>): string {
  const rest = { ...options };
  delete rest.password;
  return createHash('sha256')
    .update(canonical({ to, options: rest }))
    .digest('hex');
}

/** SHA-256 of a file, read as a stream. */
export async function fileHash(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Why a result is made again, or `undefined` when it is up to date. */
export function staleness(
  record: ResultRecord | undefined,
  sha256: string,
  settings: string,
): string | undefined {
  if (!record) return `${MANIFEST_NAME} has no record of what it was made from`;
  if (record.sha256 !== sha256) return 'its source changed';
  if (record.settings !== settings) return "'to' or 'options' changed";
  return undefined;
}

/** The manifests of the folders a run reads and writes, read once each. */
export class Manifests {
  // Promises, so files converted at the same time in one folder share one manifest.
  private readonly folders = new Map<string, Promise<ManifestFile>>();
  private readonly changed = new Set<string>();
  private readonly warn: (message: string) => void;

  constructor(warn: (message: string) => void = () => {}) {
    this.warn = warn;
  }

  private folder(dir: string): Promise<ManifestFile> {
    let manifest = this.folders.get(dir);
    if (!manifest) {
      manifest = this.read(join(dir, MANIFEST_NAME));
      this.folders.set(dir, manifest);
    }
    return manifest;
  }

  private async read(path: string): Promise<ManifestFile> {
    const empty: ManifestFile = { about: ABOUT, version: MANIFEST_VERSION, results: {} };
    if (!existsSync(path)) return empty;
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<ManifestFile>;
      if (
        parsed.version !== MANIFEST_VERSION ||
        !parsed.results ||
        typeof parsed.results !== 'object'
      )
        throw new Error(`unknown version ${String(parsed.version)}`);
      return { ...empty, results: { ...parsed.results } };
    } catch (error) {
      this.warn(
        `${path} could not be read (${(error as Error).message}); its results are converted again and it is written anew.`,
      );
      return empty;
    }
  }

  /** The record of a result (an absolute path), if its folder's manifest has one. */
  async get(result: string): Promise<ResultRecord | undefined> {
    const record = (await this.folder(dirname(result))).results[basename(result)];
    return record && typeof record.sha256 === 'string' && typeof record.settings === 'string'
      ? record
      : undefined;
  }

  /** Notes what a result was made from. */
  async set(result: string, source: string, sha256: string, settings: string): Promise<void> {
    const dir = dirname(result);
    const manifest = await this.folder(dir);
    manifest.results[basename(result)] = {
      source: relative(dir, source).split(sep).join('/'),
      sha256,
      settings,
    };
    this.changed.add(dir);
  }

  /**
   * Writes the manifests that changed (whole, through a temporary file), without the records of
   * results that are no longer there, and returns their paths.
   */
  async save(): Promise<string[]> {
    const written: string[] = [];
    for (const dir of [...this.changed].sort()) {
      const manifest = await this.folder(dir);
      const results: Record<string, ResultRecord> = {};
      for (const name of Object.keys(manifest.results).sort()) {
        if (existsSync(join(dir, name))) results[name] = manifest.results[name];
      }
      const path = join(dir, MANIFEST_NAME);
      const partial = `${path}.${process.pid}.part`;
      try {
        await writeFile(
          partial,
          `${JSON.stringify({ about: ABOUT, version: MANIFEST_VERSION, results }, null, 2)}\n`,
        );
        await rename(partial, path);
      } finally {
        await rm(partial, { force: true });
      }
      written.push(path);
    }
    this.changed.clear();
    return written;
  }
}

/**
 * For `if-exists: changed`: the plan without the files whose result is up to date (they move to
 * `skipped`), the hash of every file still to convert, and why each existing result is made again.
 */
export async function keepUpToDate(
  plan: Plan,
  manifests: Manifests,
  settings: string,
  hash: (path: string) => Promise<string> = fileHash,
): Promise<{
  plan: Plan;
  hashes: Map<string, string>;
  again: { source: string; destination: string; reason: string }[];
}> {
  const existing = new Map(plan.existing.map((e) => [e.source, e.destination]));
  const hashes = new Map<string, string>();
  const kept: { source: string; destination: string }[] = [];
  const again: { source: string; destination: string; reason: string }[] = [];
  for (const task of plan.tasks) {
    const sha256 = await hash(task.source);
    const found = existing.get(task.source);
    if (found === undefined) {
      hashes.set(task.source, sha256);
      continue;
    }
    const reason = staleness(await manifests.get(found), sha256, settings);
    if (reason === undefined) kept.push({ source: task.source, destination: found });
    else {
      hashes.set(task.source, sha256);
      again.push({ source: task.source, destination: found, reason });
    }
  }
  const keep = new Set(kept.map((k) => k.source));
  return {
    plan: {
      ...plan,
      tasks: plan.tasks.filter((t) => !keep.has(t.source)),
      skipped: [...plan.skipped, ...kept],
      existing: plan.existing.filter((e) => !keep.has(e.source)),
    },
    hashes,
    again,
  };
}
