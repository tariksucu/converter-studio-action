import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { ApiError, ConverterStudio, describe as describeError, retryDelay } from '../src/api.ts';
import {
  ConversionError,
  convertFile,
  uploadName,
  type ConversionSettings,
} from '../src/convert.ts';
import type { Task } from '../src/plan.ts';
import { CLIENT_NAME } from '../src/version.ts';
import { startStub, STUB_KEY, type Stub } from './stub-api.ts';

const fast = () => Promise.resolve();
let stub: Stub;
let dir: string;

const client = (apiKey = STUB_KEY) =>
  new ConverterStudio({ baseUrl: stub.base, apiKey, sleep: fast, maxRetries: 3 });

async function file(name: string, contents: string | Buffer): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, contents);
  return path;
}

const task = (source: string, stem: string, extension: string): Task => ({
  source,
  destination: join(dir, 'out', `${stem}.${extension}`),
  dir: join(dir, 'out'),
  stem,
  extension,
});

const settings = (to: string, more: Partial<ConversionSettings> = {}): ConversionSettings => ({
  to,
  options: {},
  maxCredits: 20,
  ifExists: 'skip',
  ...more,
});

describe('convertFile against a stand-in API', () => {
  before(async () => {
    stub = await startStub({ partBytes: 10 });
  });
  after(async () => {
    await stub.close();
  });
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cvs-action-'));
    stub.calls.length = 0;
    stub.faults.length = 0;
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('uploads, converts and writes the result; the key goes to the API only', async () => {
    const source = await file('photo.png', 'png bytes');
    const result = await convertFile(
      client(),
      task(source, 'photo', 'webp'),
      settings('webp'),
      fast,
    );
    assert.equal(result.destination, join(dir, 'out', 'photo.webp'));
    assert.equal(result.credits, 1);
    assert.equal(await readFile(result.destination, 'utf8'), 'converted to webp: png bytes');
    assert.equal(result.bytes, 'converted to webp: png bytes'.length);
    // Nothing else is left in the folder (no partial download).
    assert.deepEqual(await readdir(join(dir, 'out')), ['photo.webp']);

    for (const call of stub.calls) assert.equal(call.headers.client, CLIENT_NAME, call.path);
    const keyed = stub.calls.filter((c) => c.headers.authorization === `Bearer ${STUB_KEY}`);
    assert.deepEqual(
      keyed
        .map((c) => `${c.method} ${c.path}`)
        .filter((c) => !c.startsWith('GET /v1/conversions/')),
      ['POST /v1/uploads', 'POST /v1/conversions'],
    );
    const put = stub.calls.find((c) => c.method === 'PUT')!;
    assert.equal(put.headers.authorization, undefined);
    assert.equal(put.headers.contentLength, String('png bytes'.length));
    const download = stub.calls.find((c) => c.path.endsWith('/download'))!;
    assert.equal(download.headers.authorization, undefined);
    const create = stub.calls.find((c) => c.path === '/v1/conversions')!;
    assert.match(create.headers.idempotencyKey ?? '', /^github-action-[0-9a-f-]{36}$/);
    const { uploadId, ...rest } = create.body as { uploadId: string };
    assert.match(uploadId, /^up_/);
    assert.deepEqual(rest, { to: 'webp', maxCredits: 20 });
  });

  it('sends the options as the API takes them', async () => {
    const source = await file('scan.pdf', 'pdf bytes');
    await convertFile(
      client(),
      task(source, 'scan', 'txt'),
      settings('txt', { options: { ocr: true, ocrLanguage: 'en' } }),
      fast,
    );
    const create = stub.calls.find((c) => c.path === '/v1/conversions')!;
    assert.deepEqual((create.body as { options: unknown }).options, {
      ocr: true,
      ocrLanguage: 'en',
    });
  });

  it('sends a large file in parts, and goes on from where the API stopped', async () => {
    const bytes = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz!');
    const source = await file('big.png', bytes);
    const result = await convertFile(client(), task(source, 'big', 'jpg'), settings('jpg'), fast);
    assert.equal(
      await readFile(result.destination, 'utf8'),
      `converted to jpg: ${bytes.toString()}`,
    );
    const offsets = stub.calls.filter((c) => c.method === 'PUT').map((c) => c.headers.uploadOffset);
    assert.deepEqual(offsets, ['0', '10', '20', '30']);

    // The API kept only 4 bytes of the second part once: the upload goes on from byte 14.
    stub.calls.length = 0;
    let cut = false;
    stub.hooks.afterPart = (upload) => {
      if (!cut && upload.bytes.length === 20) {
        cut = true;
        upload.bytes = upload.bytes.subarray(0, 14);
      }
    };
    try {
      const again = await convertFile(client(), task(source, 'big2', 'jpg'), settings('jpg'), fast);
      assert.equal(
        await readFile(again.destination, 'utf8'),
        `converted to jpg: ${bytes.toString()}`,
      );
    } finally {
      stub.hooks.afterPart = undefined;
    }
    const resumed = stub.calls.filter((c) => c.method === 'PUT').map((c) => c.headers.uploadOffset);
    assert.deepEqual(resumed, ['0', '10', '20', '14', '24', '34']);
  });

  it('sends a part again after a lost connection', async () => {
    const source = await file('big.png', Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz!'));
    stub.faults.push({ method: 'PUT', path: /^\/v1\/uploads\//, status: 'drop', times: 1 });
    const result = await convertFile(client(), task(source, 'big', 'jpg'), settings('jpg'), fast);
    assert.match(
      await readFile(result.destination, 'utf8'),
      /0123456789abcdefghijklmnopqrstuvwxyz!$/,
    );
  });

  it('waits out a rate limit and a busy server', async () => {
    const source = await file('a.png', 'png');
    stub.faults.push(
      { method: 'POST', path: /^\/v1\/uploads$/, status: 429, times: 1, retryAfter: '1' },
      { method: 'GET', path: /^\/v1\/conversions\//, status: 503, times: 2 },
    );
    const result = await convertFile(client(), task(source, 'a', 'webp'), settings('webp'), fast);
    assert.equal(result.credits, 1);
    assert.equal(stub.calls.filter((c) => c.path === '/v1/uploads').length, 2);
  });

  it('gets the same conversion when the answer to starting it was lost (Idempotency-Key)', async () => {
    const source = await file('a.png', 'png, started once');
    stub.faults.push({ method: 'POST', path: /^\/v1\/conversions$/, status: 'lost', times: 1 });
    const result = await convertFile(client(), task(source, 'a', 'webp'), settings('webp'), fast);
    assert.equal(result.credits, 1);
    const creates = stub.calls.filter((c) => c.path === '/v1/conversions');
    assert.equal(creates.length, 2);
    assert.equal(creates[0].headers.idempotencyKey, creates[1].headers.idempotencyKey);
    const jobsOfThisFile = [...stub.jobs.values()].filter(
      (j) => j.input.toString() === 'png, started once',
    );
    assert.equal(jobsOfThisFile.length, 1, 'one conversion, one charge');
  });

  it('goes on when an upload finished but its answer was lost', async () => {
    const source = await file('a.png', 'png');
    stub.faults.push({ method: 'PUT', path: /^\/v1\/uploads\//, status: 'lost', times: 1 });
    const result = await convertFile(client(), task(source, 'a', 'webp'), settings('webp'), fast);
    assert.equal(await readFile(result.destination, 'utf8'), 'converted to webp: png');
  });

  it("reports a failed conversion with the API's message", async () => {
    const source = await file('broken.png', 'FAIL');
    await assert.rejects(
      convertFile(client(), task(source, 'broken', 'webp'), settings('webp'), fast),
      (error: Error) =>
        error instanceof ConversionError &&
        error.message === 'The file could not be converted.' &&
        error.code === 'conversionFailed',
    );
    await assert.rejects(readdir(join(dir, 'out')));
  });

  it('stops at a price above max-credits and says what to change', async () => {
    const source = await file('long.png', 'PRICEY');
    await assert.rejects(
      convertFile(client(), task(source, 'long', 'webp'), settings('webp'), fast),
      (error: Error) =>
        error instanceof ConversionError &&
        error.code === 'quoted' &&
        /50 credits, more than 'max-credits' \(20\)/.test(error.message) &&
        /Raise 'max-credits'/.test(error.hint ?? ''),
    );
    const ok = await convertFile(
      client(),
      task(source, 'long', 'webp'),
      settings('webp', { maxCredits: 50 }),
      fast,
    );
    assert.equal(ok.credits, 50);
  });

  it('writes a ZIP of pages under the ZIP name, unless one is there already', async () => {
    const source = await file('deck.pdf', 'PAGES');
    const result = await convertFile(client(), task(source, 'deck', 'png'), settings('png'), fast);
    assert.equal(result.destination, join(dir, 'out', 'deck.zip'));
    await assert.rejects(
      convertFile(client(), task(source, 'deck', 'png'), settings('png'), fast),
      (error: Error) => error instanceof ConversionError && error.code === 'exists',
    );
    const replaced = await convertFile(
      client(),
      task(source, 'deck', 'png'),
      settings('png', { ifExists: 'overwrite' }),
      fast,
    );
    assert.equal(replaced.destination, join(dir, 'out', 'deck.zip'));
  });

  it("refuses a wrong key with the API's message and what to do", async () => {
    const source = await file('a.png', 'png');
    await assert.rejects(client('cvs_live_wrong').checkKey(), (error: Error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 401);
      assert.equal(error.code, 'invalidApiKey');
      assert.equal(error.message, 'The API key is missing, wrong or deleted.');
      assert.match(error.hint ?? '', /account#api-keys/);
      return true;
    });
    await assert.rejects(
      convertFile(client('cvs_live_wrong'), task(source, 'a', 'webp'), settings('webp'), fast),
      (error: Error) => error instanceof ApiError && error.code === 'invalidApiKey',
    );
  });

  it('refuses an unknown option before uploading anything else', async () => {
    const source = await file('a.png', 'png');
    await assert.rejects(
      convertFile(
        client(),
        task(source, 'a', 'webp'),
        settings('webp', { options: { bogus: 1 } }),
        fast,
      ),
      (error: Error) =>
        error instanceof ApiError &&
        error.code === 'invalidRequest' &&
        /options/.test(error.hint ?? ''),
    );
  });

  it('refuses an empty file without calling the API', async () => {
    const source = await file('empty.png', '');
    await assert.rejects(
      convertFile(client(), task(source, 'empty', 'webp'), settings('webp'), fast),
      (error: Error) => error instanceof ConversionError && error.code === 'empty',
    );
    assert.equal(stub.calls.length, 0);
  });
});

describe('transport details', () => {
  it('keeps long names within 255 characters with their extension', () => {
    const name = `${'x'.repeat(300)}.heic`;
    assert.equal(uploadName(name).length, 255);
    assert.ok(uploadName(name).endsWith('.heic'));
    assert.equal(uploadName('  '), 'file');
  });

  it('waits as long as the API asks, within a minute', () => {
    const answer = (headers: Record<string, string>) =>
      new Response(null, { status: 429, headers });
    assert.equal(retryDelay(answer({ 'Retry-After': '7' }), 0), 7000);
    assert.equal(retryDelay(answer({ 'Retry-After': '600' }), 0), 60_000);
    assert.equal(retryDelay(answer({ 'X-RateLimit-Reset': '3' }), 0), 3000);
    assert.equal(retryDelay(undefined, 0), 2000);
    assert.equal(retryDelay(undefined, 2), 8000);
    assert.equal(retryDelay(undefined, 10), 60_000);
  });

  it('never repeats an address (upload and download links carry tokens)', () => {
    const error = new Error(
      'request to https://converter.studio/api/v1/uploads/abc?token=secret failed',
    );
    assert.equal(describeError(error), 'request to <address> failed');
    assert.equal(describeError(new Error('bad token=secret')), 'bad token=…');
    const refused = new TypeError('fetch failed', {
      cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }),
    });
    assert.equal(describeError(refused), 'ECONNREFUSED');
  });
});
