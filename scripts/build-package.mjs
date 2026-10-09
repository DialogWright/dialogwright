#!/usr/bin/env node
// The build of a package of this workspace (its `build` script runs this in the package's folder):
// what a project that installs the package runs, since a project has no tsx for the engine and reads
// JavaScript. The workspace itself never needs it: its package.json files point at src/, and
// `publishConfig` (which `pnpm pack` and `pnpm publish` put in place) points the packed package at
// dist/.
//
//   1. dist/ is emptied, then `tsc -p tsconfig.build.json` writes the JavaScript and the declarations.
//   2. Every relative specifier tsc kept as it was written (`'./check'`, `'../kb'`) is made one Node
//      resolves (`'./check.js'`, `'../kb/index.js'`), in the .js and the .d.ts files, and a JSON
//      import gets its `with { type: 'json' }`.
//   3. Every file under src/ that is not TypeScript (the slot types' examples.yaml, the console's page
//      and script, JSON data, the fixture apps' folders) is copied beside the code that reads it, so a
//      path from `import.meta.url` finds it in dist/ as it does in src/.
//
// A first line `#!/usr/bin/env tsx` (a command's file) becomes `#!/usr/bin/env node`.
//
// usage: node build-package.mjs [--skip <folder name>]... [--no-assets] [--out <dir>]
//   --skip: a folder name under src/ whose files are not copied (repeatable; __snapshots__ always is)
//   --no-assets: copy nothing (a package whose src/ has only code)
//   --out: the folder tsconfig.build.json writes to, emptied first (default: dist)
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';

const pkg = process.cwd();
const args = process.argv.slice(2);
const skip = new Set(['__snapshots__', 'node_modules']);
let assets = true;
let out = 'dist';
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--skip' && args[i + 1]) skip.add(args[++i]);
  else if (args[i] === '--out' && args[i + 1]) out = args[++i];
  else if (args[i] === '--no-assets') assets = false;
  else {
    console.error(`build-package: ${args[i]} is not an option\nusage: node build-package.mjs [--skip <folder name>]... [--no-assets] [--out <dir>]`);
    process.exit(2);
  }
}

const src = join(pkg, 'src');
const dist = join(pkg, out);
rmSync(dist, { recursive: true, force: true });

// 1. The compiler, the package's own.
const tsc = createRequire(join(pkg, 'package.json')).resolve('typescript/bin/tsc');
const compiled = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], { cwd: pkg, stdio: 'inherit' });
if (compiled.status !== 0) process.exit(compiled.status ?? 1);

/** Every file under `dir`, absolute. */
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    return e.isDirectory() ? (skip.has(e.name) ? [] : walk(path)) : [path];
  });
}

// 3 first, so step 2 sees the JSON files a specifier may name.
let copied = 0;
if (assets) {
  for (const file of walk(src)) {
    if (file.endsWith('.ts')) continue;
    const to = join(dist, relative(src, file));
    mkdirSync(dirname(to), { recursive: true });
    cpSync(file, to);
    copied += 1;
  }
}

// 2. The specifiers.
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|^\s*import\s*)(['"])(\.\.?\/[^'"\n]*|\.\.?)\2/gm;
const isFile = (path) => existsSync(path) && statSync(path).isFile();
const unresolved = [];
let rewritten = 0;
for (const file of walk(dist)) {
  const declaration = file.endsWith('.d.ts');
  if (!declaration && !file.endsWith('.js')) continue;
  const text = readFileSync(file, 'utf8');
  const here = dirname(file);
  let next = text.replace(SPECIFIER, (whole, lead, quote, spec) => {
    const target = resolve(here, spec);
    if (/\.(js|mjs|cjs|json)$/.test(spec) && isFile(target)) return whole;
    for (const [suffix, probe] of [['.js', '.js'], ['/index.js', '/index.js']]) {
      if (isFile(target + probe) || (declaration && isFile(target + probe.replace(/\.js$/, '.d.ts')))) {
        rewritten += 1;
        return `${lead}${quote}${spec.replace(/\/$/, '')}${suffix}${quote}`;
      }
    }
    unresolved.push(`${relative(pkg, file)}: ${spec}`);
    return whole;
  });
  // A JSON module needs its type said, in Node; tsx and vitest read one without.
  if (!declaration) next = next.replace(/^#!\/usr\/bin\/env tsx\n/, '#!/usr/bin/env node\n').replace(/(\bimport\s+[\w$]+\s+from\s*(['"])[^'"\n]+\.json\2)(?!\s*(?:with|assert)\b)/g, "$1 with { type: 'json' }");
  if (next !== text) writeFileSync(file, next);
}
if (unresolved.length > 0) {
  console.error(`build-package: ${unresolved.length} relative specifier${unresolved.length === 1 ? '' : 's'} name no file in dist/:`);
  for (const line of unresolved) console.error(`  ${line}`);
  process.exit(1);
}
console.log(`built ${relative(pkg, dist)}${sep}: ${rewritten} specifiers made explicit, ${copied} files copied from src${sep}`);
