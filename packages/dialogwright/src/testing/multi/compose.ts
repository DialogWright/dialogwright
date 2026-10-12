import { spawn } from 'node:child_process';
import { openPgClient, type SqlClient } from '../../server/stores/sql';
import { traceReaderOf } from '../../trace/store';
import { MULTI_SERVER_ENV, MULTI_SERVERS, TakeoverError, until, type Stack } from './driver';

/**
 * The two-server stack as the compose file runs it (deploy/compose/docker-compose.yml): the driver
 * reaches the balancer, each app container, Postgres and the S3-compatible store on the ports the file
 * publishes on 127.0.0.1, and makes a server go with `docker compose kill` (SIGKILL: a crash) or
 * `docker compose stop` (SIGTERM: the drain, then the exit). It runs on the machine that runs Docker
 * (`pnpm multi:test`), never in a container: killing a container from inside another would need the
 * Docker socket, which is the host's root.
 */

/** The ports the compose file publishes on 127.0.0.1 by default, each its MULTI_*_PORT variable. */
export const MULTI_PORTS = {
  MULTI_LB_PORT: 18080,
  MULTI_APP_A_PORT: 18081,
  MULTI_APP_B_PORT: 18082,
  MULTI_PG_PORT: 15432,
  MULTI_S3_PORT: 19000,
} as const;

/** The variables `pnpm multi:test` makes for each run (never stored): the compose file refuses to start without them. */
export const MULTI_SECRETS = ['MULTI_PG_PASSWORD', 'MULTI_S3_ACCESS_KEY', 'MULTI_S3_SECRET_KEY', 'MULTI_TWILIO_AUTH_TOKEN', 'MULTI_TELNYX_PUBLIC_KEY'] as const;

export interface ComposeOptions {
  /** The compose file. */
  file: string;
  /** The compose project's name. */
  project: string;
  /** The environment the compose commands run with: the secrets and any port given. */
  env: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

const portOf = (env: NodeJS.ProcessEnv, name: keyof typeof MULTI_PORTS): number => Number(env[name] ?? MULTI_PORTS[name]);

/** Runs `docker compose -p <project> -f <file> ...args`; resolves with its output, or a TakeoverError with it when it fails. */
export function compose(o: ComposeOptions, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['compose', '-p', o.project, '-f', o.file, ...args], { env: o.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr.on('data', (c: Buffer) => (out += c.toString()));
    child.on('error', (e) => reject(new TakeoverError(`docker compose ${args.join(' ')}: ${e.message}`)));
    child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new TakeoverError(`docker compose ${args.join(' ')} exited ${code}: ${out.trim().split('\n').slice(-10).join('\n')}`))));
  });
}

/** Whether a server answers on `base`: its /ready's status, or null when nothing answers. */
async function readyOf(base: string): Promise<number | null> {
  try {
    return (await fetch(`${base}/ready`, { signal: AbortSignal.timeout(2000) })).status;
  } catch {
    return null;
  }
}

export interface ComposeStack extends Stack {
  close(): Promise<void>;
}

export async function composeStack(o: ComposeOptions): Promise<ComposeStack> {
  for (const name of MULTI_SECRETS) if (!o.env[name]) throw new TakeoverError(`${name} is not set: pnpm multi:test makes it for each run`);
  const lb = `127.0.0.1:${portOf(o.env, 'MULTI_LB_PORT')}`;
  const direct: Record<string, string> = {
    'app-a': `http://127.0.0.1:${portOf(o.env, 'MULTI_APP_A_PORT')}`,
    'app-b': `http://127.0.0.1:${portOf(o.env, 'MULTI_APP_B_PORT')}`,
  };
  const directOf = (name: string): string => {
    const d = direct[name];
    if (d === undefined) throw new TakeoverError(`no server ${name} in the compose stack`);
    return d;
  };
  const sql: SqlClient = await openPgClient(`postgres://dialogwright:${encodeURIComponent(o.env.MULTI_PG_PASSWORD!)}@127.0.0.1:${portOf(o.env, 'MULTI_PG_PORT')}/dialogwright`, { max: 2, queryTimeoutMs: 30_000, log: o.log });
  const traces = traceReaderOf(MULTI_SERVER_ENV.TRACE_STORE!, {
    ...MULTI_SERVER_ENV,
    S3_ENDPOINT: `http://127.0.0.1:${portOf(o.env, 'MULTI_S3_PORT')}`,
    S3_ACCESS_KEY_ID: o.env.MULTI_S3_ACCESS_KEY,
    S3_SECRET_ACCESS_KEY: o.env.MULTI_S3_SECRET_KEY,
  })!;
  return {
    lb: { base: `http://${lb}`, ws: `ws://${lb}` },
    servers: MULTI_SERVERS,
    direct: directOf,
    sql,
    traces,
    async kill(name) {
      await compose(o, ['kill', '-s', 'SIGKILL', name]);
      await until(async () => ((await readyOf(directOf(name))) === null ? true : undefined), 30_000, `${name} to be gone after the kill`);
    },
    async stop(name) {
      // The service's stop_grace_period is past DRAIN_MS: the server drains and exits on its own, with 0
      // (a server still running at the grace period's end is killed: 137).
      await compose(o, ['stop', name]);
      const ps = await compose(o, ['ps', '--all', '--format', '{{.ExitCode}}', name]);
      if (ps.trim() !== '0') throw new TakeoverError(`${name} stopped with exit code ${ps.trim()}, not 0: its drain did not end it by itself`);
    },
    async start(name) {
      // Itself alone: its dependencies (the database, the store and its bucket) are up already.
      await compose(o, ['up', '--detach', '--no-deps', name]);
      await until(async () => ((await readyOf(directOf(name))) === 200 ? true : undefined), 120_000, `${name} to say /ready 200 after its start`);
    },
    logs: (name) => compose(o, ['logs', '--no-color', '--no-log-prefix', name]),
    close: () => sql.close(),
  };
}

/** Until the balancer and both servers answer /ready with 200: the stack is up. */
export async function composeReady(o: ComposeOptions, ms = 300_000): Promise<void> {
  const bases = [`http://127.0.0.1:${portOf(o.env, 'MULTI_LB_PORT')}`, `http://127.0.0.1:${portOf(o.env, 'MULTI_APP_A_PORT')}`, `http://127.0.0.1:${portOf(o.env, 'MULTI_APP_B_PORT')}`];
  await until(async () => {
    for (const b of bases) if ((await readyOf(b)) !== 200) return undefined;
    return true;
  }, ms, `the balancer and both servers to say /ready 200 (${bases.join(', ')})`);
}
