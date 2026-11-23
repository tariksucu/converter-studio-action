import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import type { FormatView } from '../src/api.ts';
import {
  commonRoot,
  extensionOf,
  findTarget,
  formatOfFile,
  planConversions,
  type PlanInput,
  stemOf,
} from '../src/plan.ts';

const ws = resolve('/work/repo');
const at = (...parts: string[]) => join(ws, ...parts);

const formats: FormatView[] = [
  { id: 'jpg', name: 'JPG', category: 'image', extensions: ['jpg', 'jpeg'], to: ['webp'] },
  { id: 'tgz', name: 'TAR.GZ', category: 'archive', extensions: ['tar.gz', 'tgz'], to: ['zip'] },
];

const plan = (input: Partial<PlanInput> & Pick<PlanInput, 'sources'>) =>
  planConversions({
    roots: [ws],
    outputDir: null,
    extension: 'webp',
    alternates: [],
    ifExists: 'skip',
    exists: () => false,
    caseInsensitive: false,
    ...input,
  });

describe('names', () => {
  it('splits a name like Converter Studio does', () => {
    assert.equal(extensionOf('photo.JPG'), 'jpg');
    assert.equal(extensionOf('site.tar.gz'), 'tar.gz');
    assert.equal(extensionOf('notes'), '');
    assert.equal(extensionOf('.env'), '');
    assert.equal(stemOf('dir/report.final.docx'), 'report.final');
    assert.equal(stemOf('site.tar.gz'), 'site');
    assert.equal(stemOf('README'), 'README');
  });

  it('finds formats by ID or extension', () => {
    assert.equal(findTarget(formats, 'jpeg')?.id, 'jpg');
    assert.equal(findTarget(formats, 'tar.gz')?.id, 'tgz');
    assert.equal(findTarget(formats, 'gif'), undefined);
    assert.equal(formatOfFile(formats, 'a/b/IMG_1.JPEG')?.id, 'jpg');
    assert.equal(formatOfFile(formats, 'backup.tar.gz')?.id, 'tgz');
    assert.equal(formatOfFile(formats, 'unknown.xyz'), undefined);
  });

  it('finds the common folder', () => {
    assert.equal(commonRoot([at('a', 'b'), at('a', 'c'), at('a')]), at('a'));
    assert.equal(commonRoot([at('a', 'b', 'c')]), at('a', 'b', 'c'));
    assert.equal(commonRoot([]), null);
  });
});

describe('planConversions', () => {
  it('puts results next to their sources by default', () => {
    const result = plan({ sources: [at('img', 'a.png'), at('img', 'deep', 'b.JPG')] });
    assert.deepEqual(
      result.tasks.map((t) => t.destination),
      [at('img', 'a.webp'), at('img', 'deep', 'b.webp')],
    );
  });

  it('keeps the folders below the patterns in output-dir', () => {
    const result = plan({
      sources: [at('docs', 'a.docx'), at('docs', 'guides', 'b.docx')],
      roots: [at('docs')],
      outputDir: at('dist', 'pdf'),
      extension: 'pdf',
    });
    assert.deepEqual(
      result.tasks.map((t) => t.destination),
      [at('dist', 'pdf', 'a.pdf'), at('dist', 'pdf', 'guides', 'b.pdf')],
    );
  });

  it('uses the common folder of several patterns', () => {
    const result = plan({
      sources: [at('images', 'a.png'), at('photos', '2026', 'b.heic')],
      roots: [at('images'), at('photos')],
      outputDir: at('out'),
    });
    assert.deepEqual(
      result.tasks.map((t) => t.destination),
      [at('out', 'images', 'a.webp'), at('out', 'photos', '2026', 'b.webp')],
    );
  });

  it('names a same-format result like the website (never the source itself)', () => {
    const result = plan({ sources: [at('scan.pdf')], extension: 'pdf' });
    assert.equal(result.tasks[0].destination, at('scan-compressed.pdf'));
    const elsewhere = plan({ sources: [at('scan.pdf')], extension: 'pdf', outputDir: at('small') });
    assert.equal(elsewhere.tasks[0].destination, at('small', 'scan.pdf'));
  });

  it('never replaces a file that is being converted', () => {
    const result = plan({ sources: [at('a.jpg'), at('a.png')], extension: 'png' });
    assert.deepEqual(
      result.tasks.map((t) => t.source),
      [at('a.png')],
    );
    assert.equal(result.refused.length, 1);
    assert.equal(result.refused[0].source, at('a.jpg'));
    assert.match(result.refused[0].message, /replace another file/);
  });

  it('converts neither of two files with the same result', () => {
    const result = plan({ sources: [at('photo.jpg'), at('photo.png'), at('other.png')] });
    assert.deepEqual(
      result.tasks.map((t) => t.source),
      [at('other.png')],
    );
    assert.deepEqual(
      result.refused.map((r) => r.source),
      [at('photo.jpg'), at('photo.png')],
    );
    assert.match(result.refused[0].message, /photo\.png/);
  });

  it('compares names without case where the file system does', () => {
    const sources = [at('Photo.jpg'), at('photo.png')];
    assert.equal(plan({ sources }).tasks.length, 2);
    assert.equal(plan({ sources, caseInsensitive: true }).tasks.length, 0);
  });

  it('skips, lists or replaces existing results', () => {
    const exists = (path: string) => path === at('a.webp') || path === at('doc.zip');
    const sources = [at('a.png'), at('b.png'), at('doc.pdf')];
    const skip = plan({ sources, exists, alternates: ['zip'] });
    assert.deepEqual(
      skip.tasks.map((t) => t.source),
      [at('b.png')],
    );
    assert.deepEqual(skip.skipped, [
      { source: at('a.png'), destination: at('a.webp') },
      { source: at('doc.pdf'), destination: at('doc.zip') },
    ]);
    const failing = plan({ sources, exists, ifExists: 'fail' });
    assert.equal(failing.tasks.length, 3);
    assert.deepEqual(failing.existing, [{ source: at('a.png'), destination: at('a.webp') }]);
    const overwrite = plan({ sources, exists, ifExists: 'overwrite' });
    assert.equal(overwrite.tasks.length, 3);
    assert.equal(overwrite.skipped.length, 0);
  });

  it('leaves out files the format list says cannot be converted', () => {
    const result = plan({
      sources: [at('a.png'), at('b.txt')],
      refuse: (source) => (source.endsWith('.txt') ? 'no' : undefined),
    });
    assert.deepEqual(
      result.tasks.map((t) => t.source),
      [at('a.png')],
    );
    assert.deepEqual(result.refused, [{ source: at('b.txt'), message: 'no' }]);
  });
});
