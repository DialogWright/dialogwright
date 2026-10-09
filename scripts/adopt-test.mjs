#!/usr/bin/env node
// `pnpm adopt:test`: DialogWright as someone else adopts it, outside this repository. It builds the
// packages (pnpm -r build), packs each (pnpm pack, which puts publishConfig in place), and in a
// temporary folder outside the workspace:
//
//   1. installs the packed create-dialogwright beside the packed dialogwright, as `npm create` would
//      (nothing is published, so the tarballs stand in for the registry), and runs it to write a
//      project of its own, naming the packed dialogwright as its dependency;
//   2. installs the project with npm (third-party packages come from the registry), and the packed
//      @dialogwright/kb-author and @dialogwright/widget beside it;
//   3. runs what the project's README says: the check, the type check, the tests and the stub
//      regression, all green, then the three read-back commands, which change nothing; and checks
//      that the engine's internals are not exported, that kb-author's command runs and that the
//      widget's script is there.
//
// It does it for the plain app and for the one with identity (--plain-only: the plain one alone),
// then removes the folder (--keep: leaves it, and says where). It calls no model and needs no key.
//
// usage: node scripts/adopt-test.mjs [--no-build] [--plain-only] [--keep]
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PACKAGES = ['dialogwright', 'kb-author', 'widget', 'create-dialogwright'];
const args = new Set(process.argv.slice(2));
for (const a of args) {
  if (!['--no-build', '--plain-only', '--keep'].includes(a)) {
    console.error(`adopt:test: ${a} is not an option\nusage: node scripts/adopt-test.mjs [--no-build] [--plain-only] [--keep]`);
    process.exit(2);
  }
}

const started = Date.now();
const say = (line) => console.log(`[adopt:test ${((Date.now() - started) / 1000).toFixed(0).padStart(3)}s] ${line}`);
// A child's environment: none of this workspace's pnpm or vitest variables, no settings file, no model keys.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(npm_|PNPM_|pnpm_|VITEST|INIT_CWD$|ENV_FILE$|JEV_|TYPESAFE_|OPENROUTER_|AI_GATEWAY_|ANTHROPIC_|NODE_OPTIONS$)/.test(k)));
env.NO_COLOR = '1';
env.npm_config_audit = 'false';
env.npm_config_fund = 'false';
env.npm_config_update_notifier = 'false';

/** Runs a command; exits the test with its output when it fails (or, with `expect`, exits with another code). */
function run(command, argv, cwd, { expect = 0, quiet = false } = {}) {
  const r = spawnSync(command, argv, { cwd, env: { ...env, INIT_CWD: cwd }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.status !== expect) {
    console.error(output);
    console.error(`adopt:test: \`${command} ${argv.join(' ')}\` in ${cwd} exited ${r.status ?? r.signal}, not ${expect}`);
    finish(1);
  }
  if (!quiet) say(`ok  ${command} ${argv.join(' ')}`);
  return output;
}

let base = null;
function finish(code) {
  if (base !== null) {
    if (args.has('--keep') || code !== 0) console.log(`adopt:test: the projects are in ${base}${code === 0 ? '' : ' (kept, since it failed)'}`);
    else rmSync(base, { recursive: true, force: true });
  }
  process.exit(code);
}
const check = (ok, what) => {
  if (!ok) {
    console.error(`adopt:test: ${what}`);
    finish(1);
  }
  say(`ok  ${what}`);
};

// The build and the packs.
if (!args.has('--no-build')) run('pnpm', ['-r', 'build'], ROOT);
base = realpathSync(mkdtempSync(join(tmpdir(), 'dialogwright-adopt-')));
check(!base.startsWith(realpathSync(ROOT)), `the projects are outside the workspace (${base})`);
const packs = join(base, 'packs');
mkdirSync(packs);
const tarball = {};
for (const name of PACKAGES) {
  const dir = join(ROOT, 'packages', name);
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const before = new Set(readdirSync(packs));
  run('pnpm', ['pack', '--pack-destination', packs], dir, { quiet: true });
  const made = readdirSync(packs).filter((f) => !before.has(f));
  check(made.length === 1, `pnpm pack ${manifest.name}: ${made.join(', ')}`);
  tarball[name] = join(packs, made[0]);
}

// What the packed engine carries, and how a project reaches it.
const listing = run('tar', ['-tzf', tarball.dialogwright], base, { quiet: true }).split('\n');
for (const file of ['package/bin/dialogwright.mjs', 'package/dist/index.js', 'package/dist/index.d.ts', 'package/dist/testing/index.js', 'package/dist/server/dashboard/page.html', 'package/dist/slots/digits/examples.yaml', 'package/schemas/app.schema.json', 'package/templates/standalone/gitignore', 'package/templates/app/.env.example', 'package/docs/authoring-an-app.md', 'package/skills/create-app/SKILL.md']) {
  check(listing.includes(file), `the packed dialogwright has ${file.slice('package/'.length)}`);
}
check(!listing.some((f) => f.startsWith('package/src/')), 'the packed dialogwright has no src/');
// The engine's test fixtures stay in the repository: nothing the five entries import needs them.
const fixtures = listing.filter((f) => /\/(__fixtures__|fixture)\/|^package\/dist\/testing\/(testkit|callback|proposals|recognized|routed|screened|texting)\/|^package\/dist\/.*\.jsonl$/.test(f));
check(fixtures.length === 0, `the packed dialogwright has no test fixtures${fixtures.length > 0 ? `: ${fixtures.slice(0, 5).join(', ')}` : ''}`);
// Nothing git ignores is packed: no settings file, no log, no trace (publish-guard.mjs refuses them too).
for (const name of PACKAGES) {
  const files = run('tar', ['-tzf', tarball[name]], base, { quiet: true }).split('\n').filter(Boolean);
  const stray = files.filter((f) => /(^|\/)\.env($|\.(?!example$))|\.log$|(^|\/)(traces|sessions|\.console-link)\/|^package\/templates\/.*\/audit\//.test(f));
  check(stray.length === 0, `the packed ${name} has no .env, log or trace${stray.length > 0 ? `: ${stray.join(', ')}` : ''}`);
}

/** Writes a project with the packed create-dialogwright, as `npm create dialogwright` would, and installs it. */
function project(name, extra) {
  const creator = join(base, `creator-${name}`);
  mkdirSync(creator);
  writeFileSync(join(creator, 'package.json'), JSON.stringify({ name: `creator-${name}`, private: true, dependencies: { 'create-dialogwright': `file:${tarball['create-dialogwright']}`, dialogwright: `file:${tarball.dialogwright}` } }, null, 2));
  run('npm', ['install'], creator, { quiet: true });
  say(`ok  create-dialogwright installed beside the packed dialogwright (${name})`);
  const out = run(join(creator, 'node_modules', '.bin', 'create-dialogwright'), [name, '--dir', join(base, name), '--dialogwright', `file:${tarball.dialogwright}`, ...extra], base);
  check(out.includes(`created ${join(base, name)}: a project of its own`) || out.includes(`created ${name}: a project of its own`), `create-dialogwright wrote ${name}`);
  const dir = join(base, name);
  run('npm', ['install'], dir);
  return dir;
}

/**
 * `npx dialogwright start --tunnel none` with the settings configure wrote: the server answers GET
 * /health, and a SIGTERM drains it and ends every process start began (npm, tsx and the server).
 */
async function startSmoke(dir, port) {
  const child = spawn('npx', ['dialogwright', 'start', '--tunnel', 'none'], { cwd: dir, env: { ...env, INIT_CWD: dir }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => (output += chunk));
  const exited = new Promise((done) => child.on('exit', (code, signal) => done(code ?? signal)));
  let health = null;
  for (let i = 0; i < 120 && health === null; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) health = await res.json();
    } catch {
      // Not listening yet.
    }
  }
  if (health === null) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    console.error(output);
  }
  check(health !== null && health.ok === true, `npx dialogwright start serves GET /health on ${port}`);
  process.kill(-child.pid, 'SIGTERM');
  const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 20_000))]);
  if (code === 'timeout') console.error(output);
  check(code !== 'timeout' && output.includes('drained'), `a SIGTERM drains the server and start exits (${code})`);
  let left = true;
  for (let i = 0; i < 40 && left; i += 1) {
    try {
      process.kill(-child.pid, 0);
      await new Promise((r) => setTimeout(r, 250));
    } catch {
      left = false;
    }
  }
  let listening = true;
  try {
    await fetch(`http://127.0.0.1:${port}/health`);
  } catch {
    listening = false;
  }
  check(!left && !listening, 'every process start began has exited, and nothing listens on the port');
}

/** The README's commands, in a project, all green; then the read back, the internals and the other two packages. */
async function exercise(dir) {
  const checked = run('npx', ['dialogwright', 'check'], dir);
  check(checked.trim().endsWith(': ok'), `npx dialogwright check: ${checked.trim().split('\n').at(-1)}`);
  run('npm', ['run', 'typecheck'], dir);
  const tests = run('npm', ['test'], dir);
  check(/Test Files\s+2 passed/.test(tests) && !/failed|skipped/.test(tests.split('Test Files')[1] ?? ''), 'npm test: every test file passed');
  const regress = run('npm', ['run', 'regress'], dir);
  check(regress.includes('no changes') && /scenarios\s+(\d+)\/\1 pass expectation,\s+\1\/\1 match expected/.test(regress), 'npm run regress: no changes, every scripted call passes');
  const pages = ['policy.matrix', 'POLICY.md', 'APP-MAP.md'];
  const before = pages.map((p) => readFileSync(join(dir, p), 'utf8'));
  for (const command of ['policy:matrix', 'policy:card', 'app:diagram']) {
    const out = run('npx', ['dialogwright', command], dir);
    check(/: unchanged$/m.test(out), `npx dialogwright ${command}: unchanged`);
  }
  check(pages.every((p, i) => readFileSync(join(dir, p), 'utf8') === before[i]), 'the read back is as it shipped');
  // Running it: the settings for a laptop with no keys, then what is misconfigured, offline.
  const port = String(39000 + Math.floor(Math.random() * 2000));
  const configured = run('npx', ['dialogwright', 'configure', '--non-interactive', '--mode', 'try', '--port', port], dir);
  check(existsSync(join(dir, '.env')) && configured.includes('npx dialogwright start'), 'npx dialogwright configure wrote .env, and names the next command as the project runs it');
  const diagnosed = run('npx', ['dialogwright', 'diagnose', '--offline'], dir);
  check(/ 0 fail/.test(diagnosed), `npx dialogwright diagnose --offline: ${diagnosed.trim().split('\n').at(-1)}`);
  await startSmoke(dir, port);
  rmSync(join(dir, '.env'));
  // create-app from the installed package always writes a project of its own: never apps/<name> inside this one.
  const second = join(dir, '..', `${dir.split('/').at(-1)}-second`);
  run('npx', ['dialogwright', 'create-app', 'second-line', '--dir', second], dir);
  const secondPkg = JSON.parse(readFileSync(join(second, 'package.json'), 'utf8'));
  check(existsSync(join(second, '.gitignore')) && secondPkg.dependencies.dialogwright.startsWith('^') && !existsSync(join(dir, 'apps')), `npx dialogwright create-app writes a project of its own (dialogwright ${secondPkg.dependencies.dialogwright})`);
  const help = run('npx', ['dialogwright', 'help'], dir, { quiet: true });
  check(help.includes('regress') && help.includes('configure'), 'npx dialogwright help lists the commands');
  const internal = run(process.execPath, ['--input-type=module', '-e', "import('dialogwright/core/app/registry').then(() => process.exit(0), (e) => { console.log(e.code); process.exit(3); })"], dir, { expect: 3, quiet: true });
  check(internal.includes('ERR_PACKAGE_PATH_NOT_EXPORTED'), 'the per-file subpaths are not exported');
  const entries = run(process.execPath, ['--input-type=module', '-e', "for (const e of ['dialogwright', 'dialogwright/testing', 'dialogwright/slot-kit', 'dialogwright/policy', 'dialogwright/kb/onnx']) { const m = await import(e); console.log(e, Object.keys(m).length); }"], dir, { quiet: true });
  check(entries.trim().split('\n').length === 5, `the five entries load in Node: ${entries.trim().split('\n').join('; ')}`);
}

const plain = project('adopt-plain', []);
run('npm', ['install', '--save-dev', `file:${tarball['kb-author']}`, `file:${tarball.widget}`], plain);
await exercise(plain);
const kb = run('npx', ['dialogwright-kb'], plain, { expect: 2, quiet: true });
check(kb.includes('the commands are kb:ingest'), 'npx dialogwright-kb runs (kb-author\'s own command)');
const kbEntry = run(process.execPath, ['--input-type=module', '-e', "const m = await import('@dialogwright/kb-author'); console.log(Object.keys(m).length);"], plain, { quiet: true });
check(Number(kbEntry.trim()) > 0, '@dialogwright/kb-author loads in Node');
check(existsSync(join(plain, 'node_modules', '@dialogwright', 'widget', 'dist', 'dialogwright-widget.js')), "the widget's script is where the server looks for it (node_modules/@dialogwright/widget/dist)");
check(existsSync(join(plain, 'node_modules', '@dialogwright', 'widget', 'dist', 'types', 'index.d.ts')), "the widget's declarations are packed");
if (!args.has('--plain-only')) await exercise(project('adopt-identity', ['--identity', '--display', 'Example Water']));
say('all green');
finish(0);
