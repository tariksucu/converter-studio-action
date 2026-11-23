import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  DEFAULT_BASE_URL,
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_CREDITS,
  readSettings,
} from '../src/inputs.ts';
import { CLIENT_NAME, VERSION } from '../src/version.ts';
import { actionMetadata, PACKAGE } from './runner.ts';

describe('the package', () => {
  it('names itself with the version in package.json', async () => {
    const manifest = JSON.parse(await readFile(join(PACKAGE, 'package.json'), 'utf8')) as {
      version: string;
    };
    assert.equal(VERSION, manifest.version);
    assert.equal(CLIENT_NAME, `github-action/${manifest.version}`);
  });

  it('runs the bundle on the Node version GitHub runs JavaScript actions with', async () => {
    const metadata = await actionMetadata();
    assert.equal(metadata.using, 'node24');
    assert.equal(metadata.main, 'dist/index.js');
  });

  it('has what a Marketplace listing needs', async () => {
    const { top, branding } = await actionMetadata();
    assert.equal(top.name, 'Converter Studio File Converter');
    assert.equal(top.author, 'Converter Studio');
    // The Marketplace's release form flags descriptions of 125 characters or more.
    assert.ok(top.description.length < 125, `${top.description.length} characters`);
    assert.ok(top.description.includes('Converter Studio'));
    assert.deepEqual(branding, { icon: 'refresh-cw', color: 'blue' });
  });

  it('declares the inputs the code reads, with the same defaults', async () => {
    const { inputs } = await actionMetadata();
    const read: string[] = [];
    readSettings((name) => {
      read.push(name);
      return { 'api-key': 'k', files: 'a', to: 'webp' }[name] ?? '';
    }, '/');
    assert.deepEqual([...inputs.keys()].sort(), [...new Set(read)].sort());
    assert.deepEqual(
      [...inputs].filter(([, i]) => i.required).map(([name]) => name),
      ['api-key', 'files', 'to'],
    );
    assert.equal(inputs.get('if-exists')?.default, 'skip');
    assert.equal(inputs.get('concurrency')?.default, String(DEFAULT_CONCURRENCY));
    assert.equal(inputs.get('max-credits')?.default, String(DEFAULT_MAX_CREDITS));
    assert.equal(inputs.get('base-url')?.default, DEFAULT_BASE_URL);
  });

  it('declares the outputs the action sets', async () => {
    const { outputs } = await actionMetadata();
    const source = await readFile(join(PACKAGE, 'src', 'main.ts'), 'utf8');
    const set = [...source.matchAll(/core\.setOutput\('([a-z-]+)'/g)].map((m) => m[1]);
    assert.deepEqual(outputs.sort(), set.sort());
  });
});
