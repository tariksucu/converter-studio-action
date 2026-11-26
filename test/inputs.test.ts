import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  DEFAULT_BASE_URL,
  InputError,
  normalizeBaseUrl,
  normalizeTarget,
  parseOptions,
  readSettings,
} from '../src/inputs.ts';

const workspace = resolve('/work/repo');
const inputs =
  (values: Record<string, string>) =>
  (name: string): string =>
    values[name] ?? '';
const minimal = { 'api-key': 'cvs_live_x', files: 'images/*.png', to: 'webp' };

describe('readSettings', () => {
  it('fills in the defaults', () => {
    const settings = readSettings(inputs(minimal), workspace);
    assert.deepEqual(settings, {
      apiKey: 'cvs_live_x',
      files: 'images/*.png',
      to: 'webp',
      options: {},
      outputDir: null,
      ifExists: 'skip',
      concurrency: 4,
      maxCredits: 20,
      baseUrl: DEFAULT_BASE_URL,
    });
  });

  it('reads every input', () => {
    const settings = readSettings(
      inputs({
        ...minimal,
        'api-key': '  cvs_live_y \n',
        to: '.JPEG',
        options: '{"quality": "small", "maxKb": 300}',
        'output-dir': 'public/img',
        'if-exists': 'Overwrite',
        concurrency: '10',
        'max-credits': '0',
        'base-url': 'http://localhost:8080/api/',
      }),
      workspace,
    );
    assert.equal(settings.apiKey, 'cvs_live_y');
    assert.equal(settings.to, 'jpeg');
    assert.deepEqual(settings.options, { quality: 'small', maxKb: 300 });
    assert.equal(settings.outputDir, resolve(workspace, 'public/img'));
    assert.equal(settings.ifExists, 'overwrite');
    assert.equal(settings.concurrency, 10);
    assert.equal(settings.maxCredits, 0);
    assert.equal(settings.baseUrl, 'http://localhost:8080/api');
  });

  it('keeps an absolute output folder', () => {
    const out = resolve('/tmp/out');
    assert.equal(readSettings(inputs({ ...minimal, 'output-dir': out }), workspace).outputDir, out);
  });

  it('says how to pass the key when it is empty (a fork pull request gets no secrets)', () => {
    assert.throws(
      () => readSettings(inputs({ ...minimal, 'api-key': ' ' }), workspace),
      (error: Error) =>
        error instanceof InputError &&
        error.message.includes('secrets.CONVERTER_STUDIO_API_KEY') &&
        error.message.includes('fork'),
    );
  });

  it('takes if-exists: changed, and names every choice when one is wrong', () => {
    assert.equal(
      readSettings(inputs({ ...minimal, 'if-exists': ' Changed ' }), workspace).ifExists,
      'changed',
    );
    assert.throws(
      () => readSettings(inputs({ ...minimal, 'if-exists': 'newer' }), workspace),
      /'if-exists' input must be 'skip', 'overwrite', 'fail', 'changed', not 'newer'/,
    );
  });

  it('refuses empty files, unknown if-exists and numbers out of range', () => {
    const bad: Record<string, string>[] = [
      { files: ' \n# only a comment\n' },
      { 'if-exists': 'rename' },
      { concurrency: '0' },
      { concurrency: '11' },
      { concurrency: '2.5' },
      { 'max-credits': '-1' },
      { 'max-credits': 'lots' },
      { to: '' },
      { to: 'we bp' },
      { options: '[1, 2]' },
      { options: '{quality: small}' },
      { 'base-url': 'ftp://converter.studio' },
    ];
    for (const values of bad) {
      assert.throws(
        () => readSettings(inputs({ ...minimal, ...values }), workspace),
        InputError,
        JSON.stringify(values),
      );
    }
  });
});

describe('normalizeBaseUrl', () => {
  it('drops a trailing slash and /v1', () => {
    assert.equal(normalizeBaseUrl(''), DEFAULT_BASE_URL);
    assert.equal(normalizeBaseUrl('https://converter.studio/api/v1/'), DEFAULT_BASE_URL);
    assert.equal(normalizeBaseUrl('http://127.0.0.1:8080'), 'http://127.0.0.1:8080');
    assert.equal(normalizeBaseUrl('http://[::1]:8080/api'), 'http://[::1]:8080/api');
  });

  it('sends the key over plain http only to this machine', () => {
    assert.throws(() => normalizeBaseUrl('http://converter.studio/api'), /https:\/\//);
    assert.throws(() => normalizeBaseUrl('https://user:pw@converter.studio/api'), InputError);
    assert.throws(() => normalizeBaseUrl('https://converter.studio/api?x=1'), InputError);
    assert.throws(() => normalizeBaseUrl('not a url'), InputError);
  });
});

describe('normalizeTarget and parseOptions', () => {
  it('takes format IDs and extensions', () => {
    assert.equal(normalizeTarget(' WebP '), 'webp');
    assert.equal(normalizeTarget('.tar.gz'), 'tar.gz');
    assert.throws(() => normalizeTarget('../etc'), InputError);
  });

  it('takes a JSON object or nothing', () => {
    assert.deepEqual(parseOptions(''), {});
    assert.deepEqual(parseOptions('\n{"ocr": true,\n "ocrLanguage": "en"}\n'), {
      ocr: true,
      ocrLanguage: 'en',
    });
    assert.throws(() => parseOptions('null'), InputError);
    assert.throws(() => parseOptions('"webp"'), InputError);
  });
});
