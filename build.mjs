// Bundles the action into dist/ (the runner runs dist/index.js as it is, without `npm install`):
// one ES module for Node 24, and dist/licenses.txt with the licenses of the bundled packages.
//
//   node build.mjs          # writes dist/
//   node build.mjs --check  # fails if dist/ is not what the sources build to
import { build } from 'esbuild';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
const check = process.argv.includes('--check');

const result = await build({
  // Paths in the bundle's comments are relative to the package, wherever the build starts from.
  absWorkingDir: root,
  entryPoints: [join(root, 'src/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  outfile: join(dist, 'index.js'),
  // Some bundled CommonJS packages call require() for Node's own modules.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
  },
  legalComments: 'none',
  metafile: true,
  write: false,
  logLevel: 'warning',
});

/** The bundled packages (from the metafile) and their license texts. */
function licenses(metafile) {
  const packages = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    const match = /^(.*node_modules\/((?:@[^/]+\/)?[^/]+))\//.exec(input);
    if (!match) continue;
    const dir = join(root, match[1]);
    if (packages.has(dir)) continue;
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const file = readdirSync(dir).find((name) => /^(licen[sc]e|copying)(\.|$)/i.test(name));
    packages.set(dir, {
      name: manifest.name,
      version: manifest.version,
      license: manifest.license ?? 'see the text',
      text: file ? readFileSync(join(dir, file), 'utf8').trim() : '(no license file)',
    });
  }
  return [...packages.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => `${p.name} ${p.version} (${p.license})\n\n${p.text}\n`)
    .join('\n---\n\n');
}

const files = new Map(result.outputFiles.map((file) => [file.path, Buffer.from(file.contents)]));
files.set(
  join(dist, 'licenses.txt'),
  Buffer.from(
    `The packages bundled into dist/index.js, and their licenses.\n\n---\n\n${licenses(result.metafile)}`,
  ),
);

if (check) {
  const stale = [...files].filter(
    ([path, contents]) => !existsSync(path) || !readFileSync(path).equals(contents),
  );
  const extra = existsSync(dist)
    ? readdirSync(dist).filter((name) => !files.has(join(dist, name)))
    : [];
  if (stale.length || extra.length) {
    for (const [path] of stale)
      console.error(`dist/ is out of date: ${path.slice(root.length + 1)}`);
    for (const name of extra)
      console.error(`dist/ has a file the build does not make: dist/${name}`);
    console.error('Run `npm run build` and commit dist/.');
    process.exit(1);
  }
  console.log('dist/ is up to date.');
} else {
  mkdirSync(dist, { recursive: true });
  for (const [path, contents] of files) writeFileSync(path, contents);
  const kb = (files.get(join(dist, 'index.js')).length / 1024).toFixed(0);
  console.log(`dist/index.js (${kb} KiB) and dist/licenses.txt written.`);
}
