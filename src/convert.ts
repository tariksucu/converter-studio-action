import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, openAsBlob } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  ApiError,
  type ConversionView,
  type ConverterStudio,
  hintFor,
  LONG_POLL_SECONDS,
  type UploadReceipt,
  type UploadSlot,
} from './api.ts';
import type { IfExists } from './inputs.ts';
import { extensionOf, type Task } from './plan.ts';

/** One request carries at most this much when the API does not say (the CDN stops at 100 MB). */
export const DEFAULT_PART_BYTES = 95 * 1024 * 1024;
/** The longest file name the API takes. */
const MAX_NAME_LENGTH = 255;
/** How many times an upload goes on from where the API says it stopped. */
const MAX_RESUMES = 3;

/** Statuses a conversion never leaves. */
const FINAL = new Set(['done', 'failed', 'expired', 'canceled']);
/** Statuses a conversion stays in until someone acts (or never leaves). */
const SETTLED = new Set([...FINAL, 'quoted']);

/** A file that was not converted: the API's message, its code and what to do about it. */
export class ConversionError extends Error {
  override name = 'ConversionError';
  readonly code: string | undefined;
  readonly hint: string | undefined;

  constructor(message: string, code?: string, hint?: string) {
    super(message);
    this.code = code;
    this.hint = hint ?? hintFor(code);
  }
}

/** The settings every file of a run is converted with. */
export interface ConversionSettings {
  /** The target's format ID. */
  readonly to: string;
  readonly options: Record<string, unknown>;
  readonly maxCredits: number;
  readonly ifExists: IfExists;
}

export interface Converted {
  readonly source: string;
  /** Where the result was written. */
  readonly destination: string;
  readonly credits: number | null;
  readonly bytes: number;
}

/** A file name the API takes: at most 255 characters, keeping its extension. */
export function uploadName(name: string): string {
  const trimmed = name.trim() || 'file';
  if (trimmed.length <= MAX_NAME_LENGTH) return trimmed;
  const extension = extensionOf(trimmed);
  const suffix = extension && extension.length < 16 ? `.${extension}` : '';
  return trimmed.slice(0, MAX_NAME_LENGTH - suffix.length) + suffix;
}

const incomplete = () =>
  new ConversionError(
    'The upload of the file did not finish',
    'uploadFailed',
    'Converter Studio received a different number of bytes than the file has. Run the workflow again.',
  );

/**
 * Uploads a file into its slot: in one request, or in parts of the slot's `partBytes` with
 * `Upload-Offset` for a larger file. The bytes are read from disk as they are sent.
 * `undefined`: the last request was sent again and the API no longer knew the upload, which it
 * also says once the upload is complete; the conversion request tells which it was.
 */
export async function uploadFile(
  client: ConverterStudio,
  slot: UploadSlot,
  path: string,
  size: number,
): Promise<Extract<UploadReceipt, { status: 'ready' }> | undefined> {
  const file = await openAsBlob(path);
  if (file.size !== size)
    throw new ConversionError('The file changed while it was read', 'changed');
  const partBytes = slot.partBytes > 0 ? slot.partBytes : DEFAULT_PART_BYTES;
  if (size <= partBytes) {
    const receipt = await client.sendPart(slot, file, null);
    if (receipt === undefined) return undefined;
    if (receipt.status !== 'ready') throw incomplete();
    return receipt;
  }
  let offset = 0;
  let resumes = 0;
  while (offset < size) {
    const end = Math.min(size, offset + partBytes);
    const receipt = await client.sendPart(slot, file.slice(offset, end), offset);
    if (receipt === undefined) {
      if (end === size) return undefined;
      throw incomplete();
    }
    if (receipt.status === 'ready') return receipt;
    if (receipt.status === 'gap') {
      // The API has less than was sent: go on from there, a few times at most.
      if (++resumes > MAX_RESUMES || receipt.received >= offset) throw incomplete();
      offset = receipt.received;
      continue;
    }
    if (receipt.received !== end) throw incomplete();
    offset = end;
  }
  throw incomplete();
}

/** Waits until a conversion is done, failed, expired, canceled or waits for a confirmation. */
export async function waitForConversion(
  client: ConverterStudio,
  start: ConversionView,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms)),
): Promise<ConversionView> {
  let view = start;
  let quotedChecks = 0;
  for (;;) {
    if (SETTLED.has(view.status)) {
      // A price within maxCredits is confirmed when the status is read: look once more.
      const withinLimit =
        view.status === 'quoted' &&
        view.credits !== null &&
        view.maxCredits !== null &&
        view.credits <= view.maxCredits;
      if (!withinLimit || ++quotedChecks > 5) return view;
    }
    const asked = Date.now();
    view = await client.getConversion(view.id, view.status === 'quoted' ? 0 : LONG_POLL_SECONDS);
    // The server answers as soon as something changes; never ask more than once a second.
    const pause = 1000 - (Date.now() - asked);
    if (!FINAL.has(view.status) && pause > 0) await sleep(pause);
  }
}

const credits = (n: number | null) => (n === 1 ? '1 credit' : `${n ?? 'more'} credits`);

/** The error for a conversion that ended without a result. */
export function unfinished(view: ConversionView): ConversionError {
  if (view.status === 'quoted') {
    return new ConversionError(
      `The conversion costs ${credits(view.credits)}, more than 'max-credits' (${view.maxCredits ?? 0}) allows`,
      'quoted',
      "Raise 'max-credits' to let conversions this large go ahead. Nothing was charged.",
    );
  }
  const fallback: Record<string, string> = {
    failed: 'The conversion did not succeed',
    expired: 'The result of the conversion was deleted after its time ran out',
    canceled: 'The conversion was canceled',
  };
  // The API's message says what happened to the credits; the hint (if any) what to change.
  return new ConversionError(
    view.error?.message ?? fallback[view.status] ?? view.next,
    view.error?.code ?? view.status,
  );
}

/**
 * Converts one file: an upload slot (the API checks the plan's size limit first), the bytes, the
 * conversion (with an Idempotency-Key, so a request sent again after a lost answer never starts a
 * second one), waiting for it, and the result's download next to its destination, renamed into
 * place once complete.
 */
export async function convertFile(
  client: ConverterStudio,
  task: Task,
  settings: ConversionSettings,
  sleep?: (ms: number) => Promise<void>,
): Promise<Converted> {
  const { size } = await stat(task.source);
  if (size === 0) throw new ConversionError('The file is empty', 'empty');
  const slot = await client.createUpload(uploadName(basename(task.source)), size);
  const receipt = await uploadFile(client, slot, task.source, size);
  if (receipt && receipt.file.size !== size) throw incomplete();

  const created = await client.createConversion(
    {
      uploadId: slot.id,
      to: settings.to,
      options: settings.options,
      maxCredits: settings.maxCredits,
    },
    `github-action-${randomUUID()}`,
  );
  const view = await waitForConversion(client, created, sleep);
  if (view.status !== 'done' || !view.downloadUrl) throw unfinished(view);

  // A PDF made into pictures is a ZIP of its pages when it has more than one.
  const extension = (view.outputName && extensionOf(view.outputName)) || task.extension;
  const destination =
    extension === task.extension ? task.destination : join(task.dir, `${task.stem}.${extension}`);
  if (
    destination !== task.destination &&
    settings.ifExists !== 'overwrite' &&
    existsSync(destination)
  ) {
    throw new ConversionError(
      `The result is a ${extension.toUpperCase()} file, and ${basename(destination)} already exists, so it was not saved`,
      'exists',
      "Set 'if-exists' to 'overwrite' to replace it.",
    );
  }
  await mkdir(task.dir, { recursive: true });
  const partial = join(task.dir, `.${task.stem}.${randomBytes(6).toString('hex')}.part`);
  try {
    const bytes = await client.download(view.downloadUrl, partial);
    if (view.outputSize !== null && bytes !== view.outputSize) {
      throw new ConversionError(
        'The download of the result was incomplete',
        'downloadFailed',
        'Run the workflow again.',
      );
    }
    await rename(partial, destination);
    return { source: task.source, destination, credits: view.credits, bytes };
  } catch (error) {
    if (error instanceof ApiError) throw new ConversionError(error.message, error.code, error.hint);
    throw error;
  } finally {
    await rm(partial, { force: true });
  }
}
