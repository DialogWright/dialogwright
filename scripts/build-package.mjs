#!/usr/bin/env node
// The build of a package of this workspace (its `build` script runs this in the package's folder):
// what a project that installs the package runs, since a project has no tsx for the engine and reads
// JavaScript. The workspace itself never needs it: its package.json files point at src/, and
// `publishConfig` (which `pnpm pack` and `pnpm publish` put in place) points the packed package at
// dist/.
//
//   1. dist/ is emptied, then the compiler, with tsconfig.build.json (whose `include` names the
//      package's entries: what they import is built, and nothing else, so test fixtures stay out),
//      writes the JavaScript and the declarations. As it emits, every relative specifier written as
//      the workspace writes it (`'./check'`, `'../kb'`) becomes one Node resolves (`'./check.js'`,
//      `'../kb/index.js'`), and a JSON import gets `with { type: 'json' }` (build/specifiers.mjs).
//      Only real specifiers change: never text in a string or a comment.
//   2. A first line `#!/usr/bin/env tsx` (a command's file) becomes `#!/usr/bin/env node`.
//   3. Every file under src/ that is not TypeScript, tracked by git, in a folder the build has code in
//      (the slot types' examples, the console's page and script, JSON data), is copied beside the code
//      that reads it, so a path from `import.meta.url` finds it in dist/ as it does in src/. A file git
//      does not track (a .env, a log, a trace) is never copied.
//
// usage: node build-package.mjs [--no-assets] [--out <dir>]
//   --no-assets: copy nothing (a package whose src/ has only code)
//   --out: the folder tsconfig.build.json writes to, emptied first (default: dist)
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { specifierTransformers } from './build/specifiers.mjs';

const pkg = process.cwd();
const args = process.argv.slice(2);
let assets = true;
let out = 'dist';
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--out' && args[i + 1]) out = args[++i];
  else if (args[i] === '--no-assets') assets = false;
  else {
    console.error(`build-package: ${args[i]} is not an option\nusage: node build-package.mjs [--no-assets] [--out <dir>]`);
    process.exit(2);
  }
}

const src = join(pkg, 'src');
const dist = join(pkg, out);
rmSync(dist, { recursive: true, force: true });

// 1. The compiler, the package's own, with the specifiers rewritten as it emits.
const ts = createRequire(join(pkg, 'package.json'))('typescript');
const host = { getCanonicalFileName: (f) => f, getCurrentDirectory: () => pkg, getNewLine: () => '\n' };
function fail(diagnostics) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, host));
  process.exit(1);
}
const config = ts.getParsedCommandLineOfConfigFile(join(pkg, 'tsconfig.build.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => fail([d]) });
if (config.errors.length > 0) fail(config.errors);
const program = ts.createProgram({ rootNames: config.fileNames, options: config.options, projectReferences: config.projectReferences });
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length > 0) fail(diagnostics);
const unresolved = [];
const emitted = program.emit(undefined, undefined, undefined, false, specifierTransformers(ts, { unresolved: (p) => unresolved.push(relative(pkg, p)) }));
if (emitted.diagnostics.length > 0) fail(emitted.diagnostics);
if (unresolved.length > 0) {
  console.error(`build-package: ${unresolved.length} relative specifier${unresolved.length === 1 ? '' : 's'} name no file:`);
  for (const line of unresolved) console.error(`  ${line}`);
  process.exit(1);
}

/** Every file under `dir`, absolute. */
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

// 2. The shebangs.
let built = 0;
for (const file of walk(dist)) {
  if (!file.endsWith('.js')) continue;
  built += 1;
  const text = readFileSync(file, 'utf8');
  if (text.startsWith('#!/usr/bin/env tsx\n')) writeFileSync(file, text.replace(/^#!\/usr\/bin\/env tsx\n/, '#!/usr/bin/env node\n'));
}

// 3. The files src/ reads beside its code: those git tracks (or, outside a git checkout, those that are not hidden).
let copied = 0;
if (assets) {
  const listed = spawnSync('git', ['ls-files', '-z', '--', 'src'], { cwd: pkg, encoding: 'utf8' });
  const files = listed.status === 0
    ? listed.stdout.split('\0').filter(Boolean).map((f) => join(pkg, f))
    : walk(src).filter((f) => !relative(src, f).split(sep).some((part) => part.startsWith('.')));
  for (const file of files) {
    if (file.endsWith('.ts') || !existsSync(file)) continue;
    const to = join(dist, relative(src, file));
    // Only beside code the build has: a folder of test fixtures is never built, so nothing of it is copied.
    if (!existsSync(dirname(to)) || !statSync(dirname(to)).isDirectory()) continue;
    cpSync(file, to);
    copied += 1;
  }
}
console.log(`built ${relative(pkg, dist)}${sep}: ${built} modules, ${copied} files copied from src${sep}`);
