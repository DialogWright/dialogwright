#!/usr/bin/env node
// `pnpm multi:test`: many servers for real. It builds this repository's image of an app (the Dockerfile
// at the root), starts the compose stack (deploy/compose/docker-compose.yml: Postgres, an S3-compatible
// store and its bucket, two app servers and an HAProxy balancer), and runs the takeover driver
// (packages/dialogwright/src/testing/multi) against it from this machine: on Twilio and on Telnyx, a call
// whose server is killed (`docker compose kill`, SIGKILL) and one whose server is stopped (`docker compose
// stop`, SIGTERM: the drain), each taken over by the other server, with every check the in-process test
// makes. Then it writes the stack's logs to deploy/compose/logs/ and takes the stack down with its
// volumes and network, whether it passed or not (--keep: leaves it up, and says how to take it down).
//
// The stack's secrets (the database's password, the store's keys, the carriers') are made here for
// each run and given to compose in its environment; none is written anywhere.
//
// usage: node scripts/multi-test.mjs [--in-process] [--keep] [--app <name>] [--scenario <id>] [--go-after <n>]
//   --in-process: no Docker: the same driver, the same call and the same checks against two servers of
//                 the app in one process (PGlite and a fake S3 store)
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const COMPOSE_FILE = join(ROOT, 'deploy', 'compose', 'docker-compose.yml');
const LOGS = join(ROOT, 'deploy', 'compose', 'logs');
const PROJECT = 'dialogwright-multi';
const DRIVER = join(ROOT, 'packages', 'dialogwright', 'src', 'testing', 'multi', 'cli.ts');
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');
const USAGE = 'usage: pnpm multi:test [--in-process] [--keep] [--app <name>] [--scenario <id>] [--go-after <n>]';
/**
 * The call each takeover places, unless the flags name another: the clinic's cancellation, its server
 * going once the summary is read back, so the server that goes has run a tool (the lookup) and the one
 * that takes the call over runs the write (the cancellation): a turn run twice would show in the audit.
 */
const DEFAULTS = { app: 'clinic', scenario: 'cancel-happy', goAfter: '3' };

export const NO_DOCKER = [
  'pnpm multi:test needs Docker with Compose (`docker compose`), and it is not available here:',
  'install Docker Desktop, Docker Engine or Colima, start it, and run this again. It builds the app\'s image,',
  'starts Postgres, an S3-compatible store, two app servers and a balancer, and runs the takeover test against them.',
  'Without Docker, `pnpm multi:test --in-process` runs the same driver and checks against two servers in one process.',
];

const args = process.argv.slice(2);
const flags = { inProcess: false, keep: false, ...DEFAULTS };
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  const v = args[i + 1];
  if (a === '--in-process') flags.inProcess = true;
  else if (a === '--keep') flags.keep = true;
  else if (a === '--app' && v) flags.app = args[++i];
  else if (a === '--scenario' && v) flags.scenario = args[++i];
  else if (a === '--go-after' && v) flags.goAfter = args[++i];
  else {
    console.error(`multi:test: ${a} is not an option\n${USAGE}`);
    process.exit(2);
  }
}

const started = Date.now();
const say = (line) => console.log(`[multi:test ${((Date.now() - started) / 1000).toFixed(0).padStart(3)}s] ${line}`);
const driverArgs = (stack) => [DRIVER, '--stack', stack, '--app', join(ROOT, 'apps', flags.app), '--scenario', flags.scenario, '--go-after', flags.goAfter];

/** Runs the driver; resolves with its exit code. */
function driver(stack, env) {
  return new Promise((resolve) => {
    const child = spawn(TSX, driverArgs(stack), { cwd: ROOT, env, stdio: 'inherit' });
    child.on('error', (e) => {
      console.error(`multi:test: the driver could not start: ${e.message}`);
      resolve(1);
    });
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

if (flags.inProcess) {
  say(`in process: two servers of apps/${flags.app}, scenario ${flags.scenario}`);
  process.exit(await driver('in-process', process.env));
}

// Docker, its daemon and Compose, or a clear stop.
const probe = (argv) => spawnSync('docker', argv, { encoding: 'utf8' });
const version = probe(['version', '--format', '{{.Server.Version}}']);
if (version.error || version.status !== 0) {
  for (const line of NO_DOCKER) console.error(line);
  const detail = version.error ? version.error.message : `${version.stderr ?? ''}`.trim().split('\n').at(-1);
  if (detail) console.error(`(docker: ${detail})`);
  process.exit(1);
}
const composeVersion = probe(['compose', 'version', '--short']);
if (composeVersion.error || composeVersion.status !== 0) {
  for (const line of NO_DOCKER) console.error(line);
  console.error('(docker is here, but `docker compose` is not: install the Compose plugin)');
  process.exit(1);
}
say(`Docker ${version.stdout.trim()}, Compose ${composeVersion.stdout.trim()}`);

// This run's secrets, made now and never written down.
const hex = (n) => randomBytes(n).toString('hex');
const env = {
  ...process.env,
  APP: flags.app,
  MULTI_PG_PASSWORD: hex(16),
  MULTI_S3_ACCESS_KEY: `multi${hex(6)}`,
  MULTI_S3_SECRET_KEY: hex(20),
  MULTI_TWILIO_AUTH_TOKEN: hex(16),
  MULTI_TELNYX_PUBLIC_KEY: generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  MULTI_COMPOSE_FILE: COMPOSE_FILE,
  MULTI_PROJECT: PROJECT,
};
const composeArgs = (...rest) => ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, ...rest];
/** A compose command, its output passed through; its exit code. */
function compose(...rest) {
  const r = spawnSync('docker', composeArgs(...rest), { cwd: ROOT, env, stdio: 'inherit' });
  return r.status ?? 1;
}
function captured(...rest) {
  const r = spawnSync('docker', composeArgs(...rest), { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}

/** The untagged images there are now. */
const danglingImages = () => (probe(['images', '--filter', 'dangling=true', '--quiet', '--no-trunc']).stdout ?? '').split('\n').filter(Boolean);
const danglingBefore = new Set(danglingImages());

let down = false;
function takeDown() {
  if (down) return;
  down = true;
  rmSync(LOGS, { recursive: true, force: true });
  mkdirSync(LOGS, { recursive: true });
  writeFileSync(join(LOGS, 'ps.txt'), captured('ps', '--all'));
  for (const service of ['app-a', 'app-b', 'lb', 'postgres', 's3', 's3-bucket']) writeFileSync(join(LOGS, `${service}.log`), captured('logs', '--no-color', '--timestamps', service));
  say(`the stack's logs are in ${LOGS}`);
  if (flags.keep) {
    say(`left up (--keep): take it down with  docker compose -p ${PROJECT} -f ${COMPOSE_FILE} down --volumes --remove-orphans  (the variables it names must be set, any values)`);
    return;
  }
  // Only this stack's own: its containers, its volumes, its network, and the images of its earlier builds
  // that this build left untagged (by the stack's label). The image itself stays, cached for the next run.
  compose('down', '--volumes', '--remove-orphans', '--timeout', '10');
  spawnSync('docker', ['image', 'prune', '--force', '--filter', 'label=dialogwright.multi-test=1'], { env, stdio: 'ignore' });
  // Docker's legacy builder (no BuildKit) also leaves each stage and layer of a changed build as an untagged
  // image, unlabelled: those that were not untagged before this run are this run's own (removing one may
  // leave its parent untagged, which is its own too). One at a time: one that cannot go stops nothing else.
  for (let round = 0; round < 500; round += 1) {
    const left = danglingImages().filter((id) => !danglingBefore.has(id));
    const gone = left.filter((id) => spawnSync('docker', ['image', 'rm', id], { env, stdio: 'ignore' }).status === 0);
    if (gone.length === 0) break;
  }
  say('the stack is down, its volumes and network removed');
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    say(`${signal}: taking the stack down`);
    takeDown();
    process.exit(130);
  });
}

let code = 1;
try {
  // A stack left by a run that was cut short is taken down first.
  compose('down', '--volumes', '--remove-orphans', '--timeout', '5');
  say(`building the image of apps/${flags.app} and starting the stack`);
  if (compose('up', '--build', '--detach') !== 0) throw new Error('docker compose up failed');
  code = await driver('compose', env);
} catch (e) {
  console.error(`multi:test: ${e instanceof Error ? e.message : String(e)}`);
  code = 1;
} finally {
  takeDown();
}
say(code === 0 ? 'all green' : 'FAILED');
process.exit(code);
