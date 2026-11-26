import { resolve } from 'node:path';

/**
 * What to do when a result's file already exists: keep it, replace it, stop, or replace it only
 * when its source or the settings changed since it was made (`manifest.ts`).
 */
export const IF_EXISTS = ['skip', 'overwrite', 'fail', 'changed'] as const;
export type IfExists = (typeof IF_EXISTS)[number];

export const DEFAULT_BASE_URL = 'https://converter.studio/api';
export const DEFAULT_CONCURRENCY = 4;
/** More files at once than this only fills the account's queue (and its rate limit). */
export const MAX_CONCURRENCY = 10;
/** The API's own default: a conversion that costs more waits for a confirmation. */
export const DEFAULT_MAX_CREDITS = 20;
const MAX_MAX_CREDITS = 100_000;

/** The action's inputs, checked. */
export interface Settings {
  readonly apiKey: string;
  /** The `files` input as it was given: paths and glob patterns, one a line. */
  readonly files: string;
  /** The target format as typed: lower case, without a leading dot. */
  readonly to: string;
  /** Conversion options, as the API's `options` object takes them. */
  readonly options: Record<string, unknown>;
  /** Where results go (absolute), or `null` for next to each source file. */
  readonly outputDir: string | null;
  readonly ifExists: IfExists;
  readonly concurrency: number;
  readonly maxCredits: number;
  /** The API's base address: no trailing slash and no `/v1`. */
  readonly baseUrl: string;
}

/** An input the action cannot work with; its message says which and how to fix it. */
export class InputError extends Error {
  override name = 'InputError';
}

/** Reads one input by its name in action.yml (`core.getInput`, or a map in tests). */
export type InputGetter = (name: string) => string;

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The API's base address from the `base-url` input. Only https:// carries the API key, except to
 * this machine (a local test server).
 */
export function normalizeBaseUrl(value: string): string {
  const raw = value.trim() || DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InputError(`The 'base-url' input is not a web address. Use ${DEFAULT_BASE_URL}.`);
  }
  const local = LOOPBACK.has(url.hostname) || url.hostname.endsWith('.localhost');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new InputError(
      `The 'base-url' input must start with https:// (the API key is sent to it). Use ${DEFAULT_BASE_URL}.`,
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new InputError(
      `The 'base-url' input must be a plain address, without a user name, a query or a fragment. Use ${DEFAULT_BASE_URL}.`,
    );
  }
  const path = url.pathname.replace(/\/+$/, '').replace(/\/v1$/i, '');
  return `${url.origin}${path}`;
}

/** A target format: a Converter Studio format ID or a file extension (`webp`, `.jpeg`, `tar.gz`). */
export function normalizeTarget(value: string): string {
  const to = value.trim().toLowerCase().replace(/^\./, '');
  if (!to) {
    throw new InputError(
      "The 'to' input is empty. Set it to the format to convert to, for example 'webp' or 'pdf'.",
    );
  }
  if (!/^[a-z0-9]+(\.[a-z0-9]+)?$/.test(to) || to.length > 16) {
    throw new InputError(
      `The 'to' input ('${value.trim()}') is not a format. Use a format such as 'webp', 'pdf' or 'mp4'.`,
    );
  }
  return to;
}

/** The `options` input: a JSON object, or nothing. */
export function parseOptions(value: string): Record<string, unknown> {
  const text = value.trim();
  if (!text) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new InputError(
      `The 'options' input is not valid JSON (${(error as Error).message}). Write it as a JSON object, for example {"quality": "balanced"}.`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new InputError(
      `The 'options' input must be a JSON object, for example {"quality": "balanced"}.`,
    );
  }
  return parsed as Record<string, unknown>;
}

function integer(input: InputGetter, name: string, fallback: number, min: number, max: number) {
  const text = input(name).trim();
  if (!text) return fallback;
  const value = Number(text);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new InputError(
      `The '${name}' input must be a whole number from ${min} to ${max}, not '${text}'.`,
    );
  }
  return value;
}

/** Reads and checks every input. `workspace` is where relative paths start. */
export function readSettings(input: InputGetter, workspace: string): Settings {
  const apiKey = input('api-key').trim();
  if (!apiKey) {
    throw new InputError(
      "The 'api-key' input is empty. Create an API key on https://converter.studio/account#api-keys, store it as a repository secret (for example CONVERTER_STUDIO_API_KEY) and pass it with 'api-key: ${{ secrets.CONVERTER_STUDIO_API_KEY }}'. Workflows started from a fork's pull request get no secrets.",
    );
  }
  const files = input('files');
  if (!files.split('\n').some((line) => line.trim() && !line.trim().startsWith('#'))) {
    throw new InputError(
      "The 'files' input is empty. List the files to convert, one path or glob pattern a line, for example 'images/**/*.png'.",
    );
  }
  const ifExists = (input('if-exists').trim().toLowerCase() || 'skip') as IfExists;
  if (!IF_EXISTS.includes(ifExists)) {
    throw new InputError(
      `The 'if-exists' input must be ${IF_EXISTS.map((v) => `'${v}'`).join(', ')}, not '${input('if-exists').trim()}'.`,
    );
  }
  const outputDir = input('output-dir').trim();
  return {
    apiKey,
    files,
    to: normalizeTarget(input('to')),
    options: parseOptions(input('options')),
    outputDir: outputDir ? resolve(workspace, outputDir) : null,
    ifExists,
    concurrency: integer(input, 'concurrency', DEFAULT_CONCURRENCY, 1, MAX_CONCURRENCY),
    maxCredits: integer(input, 'max-credits', DEFAULT_MAX_CREDITS, 0, MAX_MAX_CREDITS),
    baseUrl: normalizeBaseUrl(input('base-url')),
  };
}
