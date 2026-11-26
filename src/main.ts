import * as core from '@actions/core';
import * as glob from '@actions/glob';
import { existsSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { ApiError, ConverterStudio, describe, type FormatView } from './api.ts';
import { ConversionError, convertFile, type Converted } from './convert.ts';
import { InputError, readSettings, type Settings } from './inputs.ts';
import { keepUpToDate, MANIFEST_NAME, Manifests, settingsHash } from './manifest.ts';
import { findTarget, formatOfFile, planConversions, type Plan } from './plan.ts';

/** Errors after which no other file can be converted either: the key, or the account's credits. */
const STOPS_ALL = new Set([
  'invalidApiKey',
  'notEnoughCredits',
  'dailyLimit',
  'monthlyLimit',
  'tooManyUnconverted',
]);

/** A path as the logs and outputs show it: relative to the workspace when inside it, with `/`. */
export function shown(path: string, workspace: string): string {
  const below = relative(workspace, path);
  const result = below && !below.startsWith('..') && !isAbsolute(below) ? below : path;
  return result.split(sep).join('/');
}

const size = (bytes: number) =>
  bytes < 1000
    ? `${bytes} B`
    : bytes < 1_000_000
      ? `${(bytes / 1000).toFixed(1)} kB`
      : `${(bytes / 1_000_000).toFixed(1)} MB`;

/**
 * The size of the files converted, before and after, and the credits they cost (for a run that
 * converted any).
 */
export function sizeSummary(results: readonly Converted[]): string | undefined {
  if (results.length === 0) return undefined;
  const before = results.reduce((sum, r) => sum + r.sourceBytes, 0);
  const after = results.reduce((sum, r) => sum + r.bytes, 0);
  const change = before > 0 ? Math.round(((after - before) / before) * 100) : 0;
  const credits = results.reduce((sum, r) => sum + (r.credits ?? 0), 0);
  return `Sizes: ${size(before)} of sources → ${size(after)} of results (${change > 0 ? '+' : ''}${change}%), ${credits === 1 ? '1 credit' : `${credits} credits`}.`;
}

/** Runs `work` on every item, at most `limit` at a time, until `stop()` says so. */
export async function eachLimited<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
  stop: () => boolean,
): Promise<T[]> {
  const notStarted: T[] = [];
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const item = items[next++];
      if (stop()) notStarted.push(item);
      else await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return notStarted;
}

/** The folders the `files` patterns start from (a pattern that names one file: its folder). */
function searchRoots(globber: glob.Globber): string[] {
  return globber.getSearchPaths().map((path) => {
    try {
      return statSync(path).isFile() ? dirname(path) : path;
    } catch {
      return path;
    }
  });
}

function errorText(error: unknown): { message: string; hint?: string; code?: string } {
  if (error instanceof ConversionError || error instanceof ApiError) {
    return { message: error.message, hint: error.hint, code: error.code };
  }
  return { message: describe(error) };
}

/** Writes the step's outputs (also when some files failed, for steps that run `if: always()`). */
function setOutputs(
  results: readonly Converted[],
  plan: Plan | undefined,
  failed: readonly string[],
  workspace: string,
) {
  const show = (path: string) => shown(path, workspace);
  // In the order of the sources, whichever file finished first.
  const sorted = [...results].sort((a, b) => (a.source < b.source ? -1 : 1));
  const map: Record<string, string> = {};
  for (const result of sorted) map[show(result.source)] = show(result.destination);
  core.setOutput('files', sorted.map((r) => show(r.destination)).join('\n'));
  core.setOutput('map', JSON.stringify(map));
  core.setOutput('skipped', JSON.stringify((plan?.skipped ?? []).map((s) => show(s.source))));
  core.setOutput('failed', JSON.stringify([...failed].sort().map(show)));
}

/** Writes the manifests a `changed` run updated, and says which to commit. */
async function saveManifests(manifests: Manifests | null, show: (path: string) => string) {
  const written = (await manifests?.save()) ?? [];
  if (written.length > 0) {
    core.info(
      `Recorded what the results were made from in ${written.map(show).join(', ')}: commit ${written.length === 1 ? 'it' : 'them'} with the results.`,
    );
  }
}

/** The action: find the files, convert each with Converter Studio, write the results. */
export async function run(): Promise<void> {
  const workspace = resolve(process.env.GITHUB_WORKSPACE || process.cwd());
  const show = (path: string) => shown(path, workspace);
  let settings: Settings;
  try {
    settings = readSettings((name) => core.getInput(name), workspace);
  } catch (error) {
    core.setFailed(error instanceof InputError ? error.message : describe(error));
    return;
  }
  core.setSecret(settings.apiKey);

  const results: Converted[] = [];
  const failed: string[] = [];
  let plan: Plan | undefined;
  // `if-exists: changed`: the manifests next to the results, and what each source hashes to.
  const manifests =
    settings.ifExists === 'changed' ? new Manifests((message) => core.warning(message)) : null;
  try {
    const client = new ConverterStudio({
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      onRetry: (reason, waitMs) =>
        core.info(`Converter Studio: ${reason}; trying again in ${Math.ceil(waitMs / 1000)} s`),
    });

    const globber = await glob.create(settings.files, { matchDirectories: false });
    // The manifests of `if-exists: changed` are never sources (a folder pattern finds them too).
    const sources = [...new Set((await globber.glob()).map((path) => resolve(path)))]
      .filter((path) => basename(path) !== MANIFEST_NAME)
      .sort();
    if (sources.length === 0) {
      throw new InputError(
        `No files match the 'files' input:\n${settings.files.trim()}\nPaths and patterns start at ${workspace}. Patterns are case-sensitive on Linux and macOS (*.heic does not match IMG_1.HEIC).`,
      );
    }

    // The key first: a wrong one is one clear error, not one per file.
    await client.checkKey();

    let formats: FormatView[] = [];
    try {
      formats = await client.formats();
    } catch (error) {
      core.warning(
        `Converter Studio's format list could not be read (${errorText(error).message}); converting without checking the formats first.`,
      );
    }
    const target = formats.length ? findTarget(formats, settings.to) : undefined;
    if (formats.length && !target) {
      throw new InputError(
        `Converter Studio has no format '${settings.to}'. Formats: ${formats.map((f) => f.id).join(', ')}.`,
      );
    }
    const to = target?.id ?? settings.to;
    const extension = target?.extensions[0] ?? to;

    plan = planConversions({
      sources,
      roots: searchRoots(globber),
      outputDir: settings.outputDir,
      extension,
      alternates: target?.category === 'image' ? ['zip'] : [],
      ifExists: settings.ifExists,
      exists: (path) => existsSync(path),
      caseInsensitive: process.platform === 'win32' || process.platform === 'darwin',
      refuse: (source) => {
        const from = target ? formatOfFile(formats, source) : undefined;
        return from && !from.to.includes(to)
          ? `Converter Studio doesn't convert ${from.name} to ${target!.name}.`
          : undefined;
      },
    });

    if (settings.ifExists === 'fail' && plan.existing.length > 0) {
      throw new InputError(
        `${plan.existing.length === 1 ? 'A result already exists' : `${plan.existing.length} results already exist`}, and 'if-exists' is 'fail':\n${plan.existing
          .map((e) => `  ${show(e.destination)} (from ${show(e.source)})`)
          .join('\n')}\nNothing was converted.`,
      );
    }
    for (const { source, destination } of plan.skipped) {
      core.info(`Skipped ${show(source)}: ${show(destination)} already exists`);
    }
    const settingsKey = settingsHash(to, settings.options);
    let hashes = new Map<string, string>();
    if (manifests) {
      const checked = await keepUpToDate(plan, manifests, settingsKey);
      for (const { source, destination } of checked.plan.skipped.slice(plan.skipped.length)) {
        core.info(
          `Skipped ${show(source)}: ${show(destination)} is up to date (same source and settings)`,
        );
      }
      for (const { source, destination, reason } of checked.again) {
        core.info(`Converting ${show(source)} again (${show(destination)}: ${reason})`);
      }
      plan = checked.plan;
      hashes = checked.hashes;
    }
    for (const { source, message } of plan.refused) {
      failed.push(source);
      core.error(`${show(source)}: ${message}`, { title: 'Not converted', file: show(source) });
    }

    const total = plan.tasks.length;
    core.info(
      total === 0
        ? 'Nothing to convert.'
        : `Converting ${total === 1 ? '1 file' : `${total} files`} to ${(target?.name ?? to).toUpperCase()}, ${Math.min(settings.concurrency, total)} at a time.`,
    );

    let stopped: string | undefined;
    const notStarted = await eachLimited(
      plan.tasks,
      settings.concurrency,
      async (task) => {
        try {
          const result = await convertFile(client, task, {
            to,
            options: settings.options,
            maxCredits: settings.maxCredits,
            ifExists: settings.ifExists,
          });
          results.push(result);
          const sha256 = hashes.get(task.source);
          if (manifests && sha256)
            await manifests.set(result.destination, task.source, sha256, settingsKey);
          const cost =
            result.credits === null
              ? ''
              : `, ${result.credits === 1 ? '1 credit' : `${result.credits} credits`}`;
          core.info(
            `Converted ${show(task.source)} → ${show(result.destination)} (${size(result.bytes)}${cost})`,
          );
        } catch (error) {
          failed.push(task.source);
          const { message, hint, code } = errorText(error);
          core.error(`${show(task.source)}: ${message}${hint ? `\n${hint}` : ''}`, {
            title: 'Converter Studio',
            file: show(task.source),
          });
          if (code && STOPS_ALL.has(code)) stopped ??= message;
        }
      },
      () => stopped !== undefined,
    );
    for (const task of notStarted) failed.push(task.source);
    if (notStarted.length > 0) {
      core.error(
        `${notStarted.length === 1 ? '1 file was' : `${notStarted.length} files were`} not converted after: ${stopped}`,
      );
    }

    await saveManifests(manifests, show);
    const parts = [`${results.length} converted`];
    if (plan.skipped.length) parts.push(`${plan.skipped.length} skipped`);
    if (failed.length) parts.push(`${failed.length} not converted`);
    core.info(`Converter Studio: ${parts.join(', ')}.`);
    const sizes = sizeSummary(results);
    if (sizes) core.info(sizes);
    setOutputs(results, plan, failed, workspace);
    if (failed.length > 0) {
      core.setFailed(
        `${failed.length} of ${failed.length + results.length + plan.skipped.length} files could not be converted.`,
      );
    }
  } catch (error) {
    // What was converted before the error is recorded all the same.
    await saveManifests(manifests, show).catch((saveError: unknown) =>
      core.warning(`The ${MANIFEST_NAME} files could not be written: ${describe(saveError)}`),
    );
    setOutputs(results, plan, failed, workspace);
    const { message, hint } = errorText(error);
    core.setFailed(error instanceof InputError ? message : `${message}${hint ? `\n${hint}` : ''}`);
  }
}
