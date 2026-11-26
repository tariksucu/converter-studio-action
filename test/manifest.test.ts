import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  fileHash,
  keepUpToDate,
  MANIFEST_NAME,
  Manifests,
  settingsHash,
  staleness,
} from '../src/manifest.ts';
import type { Plan, Task } from '../src/plan.ts';

let dir: string;

interface Written {
  about: string;
  version: number;
  results: Record<string, { source: string; sha256: string; settings: string }>;
}

const readManifest = async (path: string) => JSON.parse(await readFile(path, 'utf8')) as Written;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cvs-manifest-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const task = (name: string): Task => ({
  source: join(dir, `${name}.png`),
  destination: join(dir, `${name}.webp`),
  dir,
  stem: name,
  extension: 'webp',
});

describe('settingsHash', () => {
  it('is the same for the same settings in any key order, and differs otherwise', () => {
    const a = settingsHash('webp', { quality: 'small', resize: { width: 800, fit: 'inside' } });
    const b = settingsHash('webp', { resize: { fit: 'inside', width: 800 }, quality: 'small' });
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.notEqual(
      a,
      settingsHash('avif', { quality: 'small', resize: { width: 800, fit: 'inside' } }),
    );
    assert.notEqual(
      a,
      settingsHash('webp', { quality: 'high', resize: { width: 800, fit: 'inside' } }),
    );
    assert.notEqual(settingsHash('webp', {}), settingsHash('webp', { quality: 'small' }));
  });

  it('leaves out an archive password (it changes nothing in the result)', () => {
    assert.equal(settingsHash('zip', { password: 'secret' }), settingsHash('zip', {}));
    assert.equal(
      settingsHash('zip', { password: 'a', archiveLevel: 9 }),
      settingsHash('zip', { archiveLevel: 9, password: 'b' }),
    );
  });
});

describe('staleness', () => {
  const record = { source: 'a.png', sha256: 'aa', settings: 'ss' };
  it('says why a result is made again, or nothing when it is up to date', () => {
    assert.equal(staleness(record, 'aa', 'ss'), undefined);
    assert.equal(staleness(record, 'bb', 'ss'), 'its source changed');
    assert.equal(staleness(record, 'aa', 'tt'), "'to' or 'options' changed");
    assert.match(staleness(undefined, 'aa', 'ss')!, /has no record/);
  });
});

describe('Manifests', () => {
  it('records results, writes one sorted manifest per folder and reads it back', async () => {
    await writeFile(join(dir, 'b.png'), 'b');
    await writeFile(join(dir, 'b.webp'), 'B');
    await writeFile(join(dir, 'a.webp'), 'A');
    const manifests = new Manifests();
    await Promise.all([
      manifests.set(join(dir, 'b.webp'), join(dir, 'b.png'), 'hb', 's1'),
      manifests.set(join(dir, 'a.webp'), join(dir, 'src', 'a.png'), 'ha', 's1'),
    ]);
    assert.deepEqual(await manifests.save(), [join(dir, MANIFEST_NAME)]);
    const written = await readManifest(join(dir, MANIFEST_NAME));
    assert.equal(written.version, 1);
    assert.match(written.about, /Commit it with the results/);
    assert.deepEqual(Object.keys(written.results), ['a.webp', 'b.webp']);
    assert.deepEqual(written.results['a.webp'], {
      source: 'src/a.png',
      sha256: 'ha',
      settings: 's1',
    });

    const again = new Manifests();
    assert.deepEqual(await again.get(join(dir, 'b.webp')), {
      source: 'b.png',
      sha256: 'hb',
      settings: 's1',
    });
    assert.equal(await again.get(join(dir, 'c.webp')), undefined);
    assert.deepEqual(await again.save(), [], 'nothing changed, nothing written');
  });

  it('drops the records of results that are gone', async () => {
    await writeFile(join(dir, 'a.webp'), 'A');
    await writeFile(
      join(dir, MANIFEST_NAME),
      JSON.stringify({
        version: 1,
        results: { 'gone.webp': { source: 'gone.png', sha256: 'x', settings: 'y' } },
      }),
    );
    const manifests = new Manifests();
    await manifests.set(join(dir, 'a.webp'), join(dir, 'a.png'), 'ha', 's');
    await manifests.save();
    const written = await readManifest(join(dir, MANIFEST_NAME));
    assert.deepEqual(Object.keys(written.results), ['a.webp']);
  });

  it('warns about a manifest it cannot read, and starts it anew', async () => {
    await writeFile(join(dir, MANIFEST_NAME), '<<<<<<< HEAD\n{');
    const warnings: string[] = [];
    const manifests = new Manifests((message) => warnings.push(message));
    assert.equal(await manifests.get(join(dir, 'a.webp')), undefined);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /could not be read/);
  });
});

describe('keepUpToDate', () => {
  it('keeps the results made from the same source and settings, and says why the others go again', async () => {
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(task);
    const hashes: Record<string, string> = {
      [a.source]: 'ha',
      [b.source]: 'hb-new',
      [c.source]: 'hc',
      [d.source]: 'hd',
    };
    for (const name of ['a.webp', 'b.webp', 'c.webp']) await writeFile(join(dir, name), name);
    const manifests = new Manifests();
    await manifests.set(a.destination, a.source, 'ha', 'S');
    await manifests.set(b.destination, b.source, 'hb-old', 'S');
    // c.webp exists, but nothing says what it was made from; d has no result yet.
    const plan: Plan = {
      tasks: [a, b, c, d],
      skipped: [],
      existing: [a, b, c].map((t) => ({ source: t.source, destination: t.destination })),
      refused: [],
    };
    const checked = await keepUpToDate(plan, manifests, 'S', (path) =>
      Promise.resolve(hashes[path]),
    );
    assert.deepEqual(
      checked.plan.tasks.map((t) => t.stem),
      ['b', 'c', 'd'],
    );
    assert.deepEqual(checked.plan.skipped, [{ source: a.source, destination: a.destination }]);
    assert.deepEqual(
      checked.again.map((x) => [x.source, x.reason.replace(MANIFEST_NAME, 'M')]),
      [
        [b.source, 'its source changed'],
        [c.source, 'M has no record of what it was made from'],
      ],
    );
    assert.deepEqual([...checked.hashes.keys()].sort(), [b.source, c.source, d.source].sort());

    const otherSettings = await keepUpToDate(plan, manifests, 'T', (path) =>
      Promise.resolve(hashes[path]),
    );
    assert.equal(otherSettings.plan.tasks.length, 4, 'new settings: every file again');
  });

  it('hashes a file by its bytes', async () => {
    await writeFile(join(dir, 'x'), 'hello');
    assert.equal(
      await fileHash(join(dir, 'x')),
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
    assert.equal(existsSync(join(dir, MANIFEST_NAME)), false);
  });
});
