/**
 * Runs the bundled action (dist/index.js) the way a GitHub runner does: a Node 24 process in the
 * workspace, every input as an `INPUT_<NAME>` variable (the defaults from action.yml for the ones
 * a workflow leaves out), the outputs written to the file in `GITHUB_OUTPUT`, and workflow
 * commands (`::error::`, `::add-mask::`) on standard output.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..');
export const ENTRY = join(PACKAGE, 'dist', 'index.js');

/** The `inputs` and `outputs` of action.yml, and how it runs (a small reader for this file only). */
export async function actionMetadata(): Promise<{
  top: Record<string, string>;
  inputs: Map<string, { required: boolean; default: string | undefined }>;
  outputs: string[];
  branding: Record<string, string>;
  using: string | undefined;
  main: string | undefined;
}> {
  const text = await readFile(join(PACKAGE, 'action.yml'), 'utf8');
  const top: Record<string, string> = {};
  const inputs = new Map<string, { required: boolean; default: string | undefined }>();
  const outputs: string[] = [];
  const branding: Record<string, string> = {};
  let section = '';
  let current: string | undefined;
  let using: string | undefined;
  let main: string | undefined;
  const unquote = (value: string) =>
    value
      .trim()
      .replace(/^'(.*)'$/, '$1')
      .replace(/^"(.*)"$/, '$1');
  for (const line of text.split('\n')) {
    const head = /^([a-z]+):\s*(.*)$/.exec(line);
    if (head) {
      section = head[1];
      if (head[2]) top[section] = unquote(head[2]);
      continue;
    }
    const brand = /^ {2}(icon|color):\s*(.*)$/.exec(line);
    if (brand && section === 'branding') {
      branding[brand[1]] = unquote(brand[2]);
      continue;
    }
    const key = /^ {2}([a-z-]+):\s*(.*)$/.exec(line);
    if (key) {
      current = key[1];
      if (section === 'inputs') inputs.set(current, { required: false, default: undefined });
      if (section === 'outputs') outputs.push(current);
      if (section === 'runs' && current === 'using') using = unquote(key[2]);
      if (section === 'runs' && current === 'main') main = unquote(key[2]);
      continue;
    }
    const field = /^ {4}(required|default):\s*(.*)$/.exec(line);
    if (field && section === 'inputs' && current) {
      const input = inputs.get(current)!;
      if (field[1] === 'required') input.required = field[2].trim() === 'true';
      else input.default = unquote(field[2]);
    }
  }
  return { top, inputs, outputs, branding, using, main };
}

/** What `core.setOutput` wrote: `name<<delimiter`, the value's lines, the delimiter. */
export function parseOutputFile(text: string): Record<string, string> {
  const outputs: Record<string, string> = {};
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const head = /^([^<]+)<<(.+)$/.exec(lines[i]);
    if (!head) continue;
    const value: string[] = [];
    for (i++; i < lines.length && lines[i] !== head[2]; i++) value.push(lines[i]);
    outputs[head[1]] = value.join('\n');
  }
  return outputs;
}

export interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputs: Record<string, string>;
}

/** Runs the action in `workspace` with `inputs` (by their names in action.yml). */
export async function runAction(
  workspace: string,
  inputs: Record<string, string>,
  env: Record<string, string> = {},
): Promise<Run> {
  const metadata = await actionMetadata();
  const temp = await mkdtemp(join(tmpdir(), 'cvs-runner-'));
  const outputFile = join(temp, 'output');
  await writeFile(outputFile, '');
  const variables: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? temp,
    CI: 'true',
    GITHUB_ACTIONS: 'true',
    GITHUB_WORKSPACE: workspace,
    GITHUB_OUTPUT: outputFile,
    GITHUB_STATE: join(temp, 'state'),
    GITHUB_ENV: join(temp, 'env'),
    GITHUB_STEP_SUMMARY: join(temp, 'summary'),
    RUNNER_TEMP: temp,
    RUNNER_OS: 'Linux',
    ...env,
  };
  for (const [name, input] of metadata.inputs) {
    const value = inputs[name] ?? input.default;
    if (value !== undefined) variables[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] = value;
  }
  for (const name of Object.keys(inputs)) {
    if (!metadata.inputs.has(name)) throw new Error(`action.yml has no input '${name}'`);
  }
  try {
    const child = spawn(process.execPath, [ENTRY], { cwd: workspace, env: variables });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const code = await new Promise<number | null>((done) => child.on('close', done));
    return { code, stdout, stderr, outputs: parseOutputFile(await readFile(outputFile, 'utf8')) };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
