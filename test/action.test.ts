/**
 * The bundled action (dist/index.js, what the runner runs) against a stand-in API, started the
 * way a runner starts it. `npm run build` first: these tests check what is committed.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { runAction } from './runner.ts';
import { startStub, STUB_KEY, type Stub } from './stub-api.ts';

let stub: Stub;
let ws: string;

async function put(files: Record<string, string>) {
  for (const [name, contents] of Object.entries(files)) {
    await mkdir(dirname(join(ws, name)), { recursive: true });
    await writeFile(join(ws, name), contents);
  }
}

const run = (inputs: Record<string, string>) =>
  runAction(ws, { 'api-key': STUB_KEY, 'base-url': stub.base, ...inputs });

const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8'));

/** The `::error …::message` lines of a run. */
const errors = (stdout: string) =>
  stdout
    .split('\n')
    .filter((line) => line.startsWith('::error'))
    .map((line) => decodeURIComponent(line.replace(/^::error[^:]*::/, '').replace(/%0A/g, '\n')));

describe('the bundled action, run like a runner runs it', () => {
  before(async () => {
    stub = await startStub();
  });
  after(async () => {
    await stub.close();
  });
  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), 'cvs-ws-'));
    stub.calls.length = 0;
    stub.faults.length = 0;
  });
  afterEach(async () => {
    await rm(ws, { recursive: true, force: true });
  });

  it('converts the files that globs match, several at once, and lists them in the outputs', async () => {
    await put({
      'images/a.png': 'a',
      'images/b.png': 'b',
      'images/deep/c.jpeg': 'c',
      'images/deep/d.JPG': 'd',
      'images/skip-me.png': 'x',
      'images/notes.txt': 'not an image',
      'other/e.png': 'e',
    });
    const result = await run({
      files: 'images/**/*.png\nimages/**/*.jpeg\nimages/**/*.JPG\n!images/skip-me.png',
      to: 'webp',
      concurrency: '3',
    });
    assert.equal(result.code, 0, result.stdout);
    const written = ['images/a.webp', 'images/b.webp', 'images/deep/c.webp', 'images/deep/d.webp'];
    // In the order of the sources, whichever finished first.
    assert.deepEqual(result.outputs.files.split('\n'), written);
    assert.deepEqual(JSON.parse(result.outputs.map), {
      'images/a.png': 'images/a.webp',
      'images/b.png': 'images/b.webp',
      'images/deep/c.jpeg': 'images/deep/c.webp',
      'images/deep/d.JPG': 'images/deep/d.webp',
    });
    assert.equal(result.outputs.failed, '[]');
    assert.equal(result.outputs.skipped, '[]');
    assert.equal(await readFile(join(ws, 'images/deep/d.webp'), 'utf8'), 'converted to webp: d');
    assert.equal(existsSync(join(ws, 'images/skip-me.webp')), false);
    assert.equal(existsSync(join(ws, 'other/e.webp')), false);
    assert.match(result.stdout, /Converting 4 files to WEBP, 3 at a time\./);
    assert.match(result.stdout, /Converted images\/a\.png → images\/a\.webp \(20 B, 1 credit\)/);
    assert.match(result.stdout, /Converter Studio: 4 converted\./);
    // The files went up at the same time: the four uploads came before the first download.
    const order = stub.calls.map((c) =>
      c.method === 'PUT' ? 'up' : c.path.endsWith('/download') ? 'down' : '',
    );
    assert.ok(order.filter((o) => o === 'up').length === 4);
    assert.ok(order.indexOf('down') > order.indexOf('up') + 1, 'uploads overlap');
  });

  it('writes into output-dir with the folders below the pattern', async () => {
    await put({ 'docs/guide.docx': 'g', 'docs/api/ref.docx': 'r' });
    const result = await run({ files: 'docs/**/*.docx', to: 'pdf', 'output-dir': 'dist/pdf' });
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(result.outputs.files.split('\n').sort(), [
      'dist/pdf/api/ref.pdf',
      'dist/pdf/guide.pdf',
    ]);
  });

  it('takes a folder as every file in it, and a plain path', async () => {
    await put({ 'scans/one.pdf': '1', 'scans/two.pdf': '2', 'cover.png': 'c' });
    const result = await run({ files: 'scans\ncover.png', to: 'jpg', 'output-dir': 'out' });
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(result.outputs.files.split('\n').sort(), [
      'out/cover.jpg',
      'out/scans/one.jpg',
      'out/scans/two.jpg',
    ]);
  });

  it('keeps an existing result and spends nothing on it (if-exists: skip)', async () => {
    await put({ 'a.png': 'a', 'a.webp': 'already here', 'b.png': 'b' });
    const result = await run({ files: '*.png', to: 'webp' });
    assert.equal(result.code, 0, result.stdout);
    assert.equal(await readFile(join(ws, 'a.webp'), 'utf8'), 'already here');
    assert.equal(result.outputs.files, 'b.webp');
    assert.deepEqual(JSON.parse(result.outputs.skipped), ['a.png']);
    assert.match(result.stdout, /Skipped a\.png: a\.webp already exists/);
    assert.equal(stub.calls.filter((c) => c.method === 'PUT').length, 1, 'only b.png went up');
  });

  it('replaces an existing result (if-exists: overwrite)', async () => {
    await put({ 'a.png': 'a', 'a.webp': 'old' });
    const before = await stat(join(ws, 'a.webp'));
    const result = await run({ files: 'a.png', to: 'webp', 'if-exists': 'overwrite' });
    assert.equal(result.code, 0, result.stdout);
    assert.equal(await readFile(join(ws, 'a.webp'), 'utf8'), 'converted to webp: a');
    assert.notEqual((await stat(join(ws, 'a.webp'))).ino, before.ino, 'renamed into place');
  });

  it('stops before converting anything when a result exists (if-exists: fail)', async () => {
    await put({ 'a.png': 'a', 'b.png': 'b', 'b.webp': 'old' });
    const result = await run({ files: '*.png', to: 'webp', 'if-exists': 'fail' });
    assert.equal(result.code, 1);
    assert.match(
      errors(result.stdout).join('\n'),
      /A result already exists, and 'if-exists' is 'fail':\n {2}b\.webp \(from b\.png\)\nNothing was converted\./,
    );
    assert.equal(stub.calls.filter((c) => c.method !== 'GET').length, 0);
    assert.equal(existsSync(join(ws, 'a.webp')), false);
  });

  it('converts again only what changed since the last run (if-exists: changed)', async () => {
    const uploads = () => stub.calls.filter((c) => c.method === 'PUT').length;
    await put({ 'img/a.png': 'a', 'img/b.png': 'b', 'img/deep/c.png': 'c' });
    // The folder with its results left out: the manifests the folder holds are left out anyway.
    const inputs = { files: 'img\n!img/**/*.webp', to: 'webp', 'if-exists': 'changed' };

    // First run: everything, and a manifest next to the results.
    const first = await run(inputs);
    assert.equal(first.code, 0, first.stdout);
    assert.equal(uploads(), 3);
    const manifest = (await readJson(join(ws, 'img/.converter-studio.json'))) as {
      results: Record<string, { source: string }>;
    };
    assert.deepEqual(Object.keys(manifest.results), ['a.webp', 'b.webp']);
    assert.equal(manifest.results['a.webp'].source, 'a.png');
    assert.ok(existsSync(join(ws, 'img/deep/.converter-studio.json')));
    assert.match(first.stdout, /commit them with the results/);

    // Nothing changed (as in a fresh checkout, where file times say nothing): nothing to do. The
    // manifests are not taken for sources, though the folder pattern finds them.
    stub.calls.length = 0;
    const second = await run(inputs);
    assert.equal(second.code, 0, second.stdout);
    assert.equal(uploads(), 0);
    assert.deepEqual(JSON.parse(second.outputs.skipped), [
      'img/a.png',
      'img/b.png',
      'img/deep/c.png',
    ]);
    assert.match(second.stdout, /Skipped img\/a\.png: img\/a\.webp is up to date/);

    // An edited source: that file only.
    await put({ 'img/b.png': 'b, edited' });
    stub.calls.length = 0;
    const third = await run(inputs);
    assert.equal(third.code, 0, third.stdout);
    assert.equal(third.outputs.files, 'img/b.webp');
    assert.equal(await readFile(join(ws, 'img/b.webp'), 'utf8'), 'converted to webp: b, edited');
    assert.match(third.stdout, /Converting img\/b\.png again \(img\/b\.webp: its source changed\)/);

    // Other options: every file.
    stub.calls.length = 0;
    const fourth = await run({ ...inputs, options: '{"quality": "small"}' });
    assert.equal(fourth.code, 0, fourth.stdout);
    assert.equal(uploads(), 3);
    assert.match(fourth.stdout, /'to' or 'options' changed/);
  });

  it('converts a result with no record again, once (if-exists: changed)', async () => {
    await put({ 'a.png': 'a', 'a.webp': 'made before, by hand' });
    const result = await run({ files: 'a.png', to: 'webp', 'if-exists': 'changed' });
    assert.equal(result.code, 0, result.stdout);
    assert.equal(await readFile(join(ws, 'a.webp'), 'utf8'), 'converted to webp: a');
    assert.match(result.stdout, /has no record of what it was made from/);
    stub.calls.length = 0;
    const again = await run({ files: 'a.png', to: 'webp', 'if-exists': 'changed' });
    assert.equal(again.code, 0, again.stdout);
    assert.equal(stub.calls.filter((c) => c.method === 'PUT').length, 0);
  });

  it('writes no manifest unless asked to (if-exists: skip, the default)', async () => {
    await put({ 'a.png': 'a' });
    const result = await run({ files: '.', to: 'webp' });
    assert.equal(result.code, 0, result.stdout);
    assert.equal(existsSync(join(ws, '.converter-studio.json')), false);
  });

  it('ends with the sizes before and after, and the credits', async () => {
    await put({ 'a.png': 'aaaaaaaaaa', 'b.png': 'bbbbbbbbbb', 'c.png': 'c', 'c.webp': 'old' });
    const result = await run({ files: '*.png', to: 'webp' });
    assert.equal(result.code, 0, result.stdout);
    // "converted to webp: " + the source: 29 bytes from 10.
    assert.match(
      result.stdout,
      /Converter Studio: 2 converted, 1 skipped\.\nSizes: 20 B of sources → 58 B of results \(\+190%\), 2 credits\.\n/,
    );
  });

  it("fails once, with the API's message, for a wrong key, and never prints the key", async () => {
    await put({ 'a.png': 'a', 'b.png': 'b' });
    const result = await runAction(ws, {
      'api-key': 'cvs_live_wrong_key',
      'base-url': stub.base,
      files: '*.png',
      to: 'webp',
    });
    assert.equal(result.code, 1);
    const messages = errors(result.stdout);
    assert.equal(messages.length, 1);
    assert.match(
      messages[0],
      /^The API key is missing, wrong or deleted\.\nCheck the repository secret passed as 'api-key'/,
    );
    assert.equal(stub.calls.filter((c) => c.path === '/v1/uploads').length, 0);
    // The key appears once: in the command that tells the runner to mask it.
    const lines = result.stdout.split('\n').filter((line) => line.includes('cvs_live_wrong_key'));
    assert.deepEqual(lines, ['::add-mask::cvs_live_wrong_key']);
  });

  it('reports a failed file, converts the others, and fails the step', async () => {
    await put({ 'good.png': 'fine', 'bad.png': 'FAIL' });
    const result = await run({ files: '*.png', to: 'webp' });
    assert.equal(result.code, 1);
    assert.equal(result.outputs.files, 'good.webp');
    assert.deepEqual(JSON.parse(result.outputs.failed), ['bad.png']);
    const annotation = result.stdout
      .split('\n')
      .find((line) => line.startsWith('::error') && line.includes('bad.png'));
    assert.match(
      annotation ?? '',
      /^::error title=Converter Studio,file=bad\.png::bad\.png: The file could not be converted\./,
    );
    assert.match(result.stdout, /::error::1 of 2 files could not be converted\./);
    assert.equal(existsSync(join(ws, 'bad.webp')), false);
  });

  it('leaves out what the format list says cannot be converted, without uploading it', async () => {
    await put({ 'a.png': 'a', 'notes.docx': 'd' });
    const result = await run({ files: '*.*', to: 'jpg' });
    assert.equal(result.code, 1);
    assert.equal(result.outputs.files, 'a.jpg');
    assert.match(
      errors(result.stdout).join('\n'),
      /notes\.docx: Converter Studio doesn't convert Word to JPG\./,
    );
    assert.equal(stub.calls.filter((c) => c.method === 'PUT').length, 1);
  });

  it('accepts an extension as the target, and checks it', async () => {
    await put({ 'a.png': 'a' });
    const jpeg = await run({ files: 'a.png', to: 'jpeg' });
    assert.equal(jpeg.code, 0, jpeg.stdout);
    assert.equal(jpeg.outputs.files, 'a.jpg');
    const unknown = await run({ files: 'a.png', to: 'xyz' });
    assert.equal(unknown.code, 1);
    assert.match(
      errors(unknown.stdout)[0],
      /^Converter Studio has no format 'xyz'\. Formats: png, jpg/,
    );
  });

  it('stops at the price limit and says which input to raise', async () => {
    await put({ 'long.png': 'PRICEY' });
    const result = await run({ files: 'long.png', to: 'webp' });
    assert.equal(result.code, 1);
    assert.match(
      errors(result.stdout)[0],
      /long\.png: The conversion costs 50 credits, more than 'max-credits' \(20\) allows\nRaise 'max-credits'/,
    );
    const raised = await run({ files: 'long.png', to: 'webp', 'max-credits': '60' });
    assert.equal(raised.code, 0, raised.stdout);
  });

  it('stops starting files once the credits are gone', async () => {
    const poor = await startStub({ credits: 1 });
    try {
      await put({ '1.png': '1', '2.png': '2', '3.png': '3' });
      const result = await runAction(ws, {
        'api-key': STUB_KEY,
        'base-url': poor.base,
        files: '*.png',
        to: 'webp',
        concurrency: '1',
      });
      assert.equal(result.code, 1);
      assert.equal(result.outputs.files, '1.webp');
      assert.deepEqual(JSON.parse(result.outputs.failed), ['2.png', '3.png']);
      assert.match(
        result.stdout,
        /1 file was not converted after: You don't have enough credits left\./,
      );
      assert.equal(poor.calls.filter((c) => c.path === '/v1/uploads').length, 2);
    } finally {
      await poor.close();
    }
  });

  it('says what to check when nothing matches', async () => {
    const result = await run({ files: 'photos/*.heic', to: 'jpg' });
    assert.equal(result.code, 1);
    assert.match(
      errors(result.stdout)[0],
      /^No files match the 'files' input:\nphotos\/\*\.heic\n.*case-sensitive/,
    );
    assert.equal(stub.calls.length, 0);
  });

  it('refuses bad inputs before calling the API', async () => {
    await put({ 'a.png': 'a' });
    const result = await run({ files: 'a.png', to: 'webp', options: '{"quality": small}' });
    assert.equal(result.code, 1);
    assert.match(errors(result.stdout)[0], /^The 'options' input is not valid JSON/);
    assert.equal(stub.calls.length, 0);
    const empty = await runAction(ws, { 'api-key': '', files: 'a.png', to: 'webp' });
    assert.equal(empty.code, 1);
    assert.match(errors(empty.stdout)[0], /^The 'api-key' input is empty\./);
  });

  it('never prints an upload or download link (they carry tokens)', async () => {
    await put({ 'a.png': 'a' });
    stub.faults.push({ method: 'PUT', path: /^\/v1\/uploads\//, status: 'drop', times: 1 });
    const result = await run({ files: 'a.png', to: 'webp' });
    assert.equal(result.code, 0, result.stdout);
    assert.match(result.stdout, /Converter Studio: upload interrupted \(.+\); trying again in 2 s/);
    assert.doesNotMatch(result.stdout + result.stderr, /token=|\/download|\/v1\/uploads\//);
  });
});
