#!/usr/bin/env node
// Run before a package of this workspace is packed or published (its `prepack` and `prepublishOnly`),
// in the package's folder. It exits 1, saying why, unless:
//
//   1. it runs under pnpm (npm_config_user_agent starts with "pnpm/"): only pnpm puts publishConfig
//      (the exports, bin, main and types from dist/) in place of the workspace's fields, which point at
//      src/, and turns `workspace:^` into a version range; what npm packs cannot be installed;
//   2. dist/ exists and every file in it is newer than every file under src/ (unless --no-build, for a
//      package with no build): a stale or missing build is never packed;
//   3. no file git ignores (a .env, a log, a trace) is in a folder the package's `files` names, since
//      `files` takes what is on disk.
//
// usage: node publish-guard.mjs [--no-build]
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const pkg = process.cwd();
const noBuild = process.argv.includes('--no-build');
const name = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).name;
const problems = [];

const agent = process.env.npm_config_user_agent ?? '';
if (!agent.startsWith('pnpm/')) {
  problems.push(`it runs under ${agent.split(' ')[0] || 'no package manager'}, not pnpm: pack and publish with pnpm (pnpm pack, pnpm -r publish), which puts publishConfig in place; npm would pack the workspace's fields, which point at src/`);
}

/** Every file under `dir`, with its modification time. */
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    return e.isDirectory() ? files(path) : e.isFile() ? [{ path, mtime: statSync(path).mtimeMs }] : [];
  });
}

if (!noBuild) {
  const dist = join(pkg, 'dist');
  const built = existsSync(dist) ? files(dist) : [];
  if (built.length === 0) problems.push('there is no build in dist/: run pnpm -r build first');
  else if (existsSync(join(pkg, 'src'))) {
    const oldest = built.reduce((a, b) => (b.mtime < a.mtime ? b : a));
    const newer = files(join(pkg, 'src')).filter((f) => f.mtime >= oldest.mtime);
    if (newer.length > 0) problems.push(`the build in dist/ is older than ${newer.length} file${newer.length === 1 ? '' : 's'} under src/ (${relative(pkg, newer[0].path)}${newer.length > 1 ? ', ...' : ''}): run pnpm -r build again`);
  }
}

const git = (args) => spawnSync('git', args, { cwd: pkg, encoding: 'utf8' });
if (git(['rev-parse', '--is-inside-work-tree']).status === 0) {
  for (const entry of JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).files ?? []) {
    if (!existsSync(join(pkg, entry))) continue;
    // A folder git ignores whole (dist/, and the pages the engine's build copies in) is the build's own.
    if (git(['check-ignore', '-q', entry]).status === 0) continue;
    const ignored = git(['ls-files', '--others', '--ignored', '--exclude-standard', '--', entry]).stdout.split('\n').filter(Boolean);
    if (ignored.length > 0) problems.push(`${entry} has files git ignores, which would be packed: ${ignored.join(', ')} (remove them)`);
  }
}

if (problems.length > 0) {
  for (const p of problems) console.error(`publish-guard (${name}): ${p}`);
  process.exit(1);
}
