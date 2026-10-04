import { spawn, type SpawnOptions } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { carrierSteps } from './carrierSteps';
import { integer, type Env } from './config';
import { readEnvFile } from './envFile';
import { SIGNAL_REPEAT_MS } from './signals';
import { isLoopbackHost } from './localOnly';
import { CLOUDFLARED_INSTALL, findOnPath, QUICK_TUNNEL_TIMEOUT_MS, waitForQuickTunnel, type TunnelProcess } from './tunnel';
import { chooseApp, workspaceApps, WORKSPACE_ROOT } from './workspace';

/**
 * `pnpm start [--app <name>] [--env-file <path>] [--tunnel quick|named|none]`: an app's server with its
 * settings file (`<app>/.env`, which `pnpm configure` writes), and the tunnel the carrier reaches it by.
 *
 * - `quick`, the default when PUBLIC_HOST is unset (or `quick`): it starts `cloudflared tunnel --url
 *   http://localhost:<PORT>`, Cloudflare's quick tunnel, which needs no account; reads the hostname it is
 *   given; starts the server with that PUBLIC_HOST; and prints the webhook URL to paste into the carrier,
 *   which changes every run. Without cloudflared it says how to install it.
 * - `named`: PUBLIC_HOST is a named tunnel's hostname, and that tunnel runs on its own (its service).
 * - `none`, the default when PUBLIC_HOST is set: the server alone, as `pnpm --filter <app> serve` with
 *   ENV_FILE set.
 *
 * The server runs as `pnpm --filter <app> serve` with ENV_FILE naming the file. A stop (Ctrl-C or SIGTERM)
 * is passed to the server once, and a second one later is passed again (which stops it at once, index.ts
 * main); cloudflared is stopped only once the server has, so live calls keep their way in while they drain.
 * If cloudflared stops on its own, the server is stopped too: no carrier can reach it.
 */

/** A process start runs: cloudflared, or the server. */
export interface StartChild extends TunnelProcess {
  pid?: number;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

export interface StartDeps {
  out(line: string): void;
  /** The environment: it wins over the settings file, and the server is given it. */
  env: Env;
  /** Where the command was run (pnpm's INIT_CWD), which relative paths are from. */
  invokedFrom: string;
  /** The repository root, where the apps are and the server is run from. */
  root?: string;
  /** An executable on PATH, or null. */
  which(command: string): string | null;
  spawn(command: string, args: readonly string[], options: SpawnOptions): StartChild;
  /** Signals a child and the processes it started (its process group). */
  signal(child: StartChild, signal: NodeJS.Signals): void;
  /** Installs the handler for this process's own SIGINT and SIGTERM. */
  onStop(handler: (signal: NodeJS.Signals) => void): void;
  now(): number;
  tunnelTimeoutMs?: number;
}

export const START_USAGE = 'usage: pnpm start [--app <name>] [--env-file <path>] [--tunnel quick|named|none]';
const TUNNELS = ['quick', 'named', 'none'] as const;
type Tunnel = (typeof TUNNELS)[number];

/** Runs the command; resolves with its exit code once the server has stopped. */
export async function main(argv: readonly string[], deps: StartDeps): Promise<number> {
  const say = (line: string) => deps.out(`[start] ${line}`);
  const flags: { app?: string; envFile?: string; tunnel?: Tunnel } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const v = argv[i + 1];
    if (a === '--app' && v !== undefined) flags.app = argv[++i];
    else if (a === '--env-file' && v !== undefined) flags.envFile = argv[++i];
    else if (a === '--tunnel' && v !== undefined && (TUNNELS as readonly string[]).includes(v)) flags.tunnel = argv[++i] as Tunnel;
    else {
      deps.out(START_USAGE);
      return 2;
    }
  }
  const root = deps.root ?? WORKSPACE_ROOT;
  const chosen = chooseApp(workspaceApps(root), flags.app, deps.invokedFrom, 'start');
  if ('error' in chosen) {
    deps.out(chosen.error);
    return 2;
  }
  const app = chosen.app;
  const named = flags.envFile ?? (deps.env.ENV_FILE?.trim() || undefined);
  const file = named === undefined ? join(app.dir, '.env') : isAbsolute(named) ? named : resolve(deps.invokedFrom, named);
  if (!existsSync(file)) {
    deps.out(`no settings file at ${file}: run pnpm configure first (or name one with --env-file)`);
    return 1;
  }
  const settings: Env = { ...readEnvFile(file) };
  for (const [k, v] of Object.entries(deps.env)) if (v !== undefined) settings[k] = v;
  const host = settings.PUBLIC_HOST?.trim() ?? '';
  const noHost = host === '' || host === 'quick';
  const tunnel: Tunnel = flags.tunnel ?? (noHost ? 'quick' : 'none');
  if (tunnel === 'named' && noHost) {
    deps.out("--tunnel named needs PUBLIC_HOST: your named tunnel's hostname, in the settings file");
    return 1;
  }
  if (tunnel === 'none' && noHost) {
    deps.out('--tunnel none needs PUBLIC_HOST in the settings file: localhost on a laptop, or a hostname you already have');
    return 1;
  }
  let port: number;
  try {
    port = integer(settings, 'PORT', 3000);
  } catch (e) {
    deps.out(e instanceof Error ? e.message : String(e));
    return 1;
  }
  const carriers = (settings.VOICE_PROVIDERS ?? 'twilio').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  say(`${app.name}, settings from ${file}`);

  // The quick tunnel, before the server: the server needs its hostname.
  let cloudflared: StartChild | null = null;
  let publicHost = host;
  if (tunnel === 'quick') {
    const bin = deps.which('cloudflared');
    if (bin === null) {
      for (const line of CLOUDFLARED_INSTALL) deps.out(line);
      return 1;
    }
    if (!noHost) say(`--tunnel quick: the quick tunnel's hostname stands in for PUBLIC_HOST=${host} this run`);
    say(`opening a quick tunnel to http://localhost:${port} (cloudflared; no account)`);
    cloudflared = deps.spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      publicHost = await waitForQuickTunnel(cloudflared, deps.tunnelTimeoutMs ?? QUICK_TUNNEL_TIMEOUT_MS);
    } catch (e) {
      say(e instanceof Error ? e.message : String(e));
      deps.signal(cloudflared, 'SIGTERM');
      return 1;
    }
    // From now on only its errors are worth a line; the rest is read and dropped, so its pipe never fills.
    for (const stream of [cloudflared.stdout, cloudflared.stderr]) {
      stream?.on('data', (chunk: Buffer | string) => {
        for (const line of chunk.toString().split('\n')) if (/\b(ERR|FTL)\b/.test(line)) deps.out(`[cloudflared] ${line.trim()}`);
      });
    }
  }

  const laptop = tunnel !== 'quick' && isLoopbackHost(publicHost);
  const base = laptop ? `http://localhost:${port}` : `https://${publicHost}`;
  if (tunnel === 'quick') say(`quick tunnel: https://${publicHost}`);
  for (const c of carriers) say(`${c} voice webhook (POST): ${base}/voice/${c}`);
  if (tunnel === 'quick') {
    deps.out('');
    for (const c of carriers) for (const line of carrierSteps(c, `${base}/voice/${c}`)) deps.out(line);
    deps.out('');
    deps.out('It changes every time pnpm start runs, so paste the new one each time. For a hostname that stays, use a named');
    deps.out('tunnel on your own domain and set PUBLIC_HOST (https://dialogwright.com/guides/home-server.html#tunnel).');
    deps.out('');
  } else if (tunnel === 'named') {
    say(`the named tunnel for ${publicHost} runs on its own (cloudflared tunnel run <name>, or its service)`);
  }
  if (laptop || tunnel === 'quick') say(`the console, on this machine: http://localhost:${port}/dashboard`);

  const env: NodeJS.ProcessEnv = { ...deps.env, ENV_FILE: file, ...(tunnel === 'quick' ? { PUBLIC_HOST: publicHost } : {}) };
  const server = deps.spawn('pnpm', ['--filter', app.name, 'serve'], { cwd: root, env, detached: true, stdio: 'inherit' });

  return await new Promise<number>((done) => {
    let serverCode: number | null = null;
    let serverGone = false;
    let tunnelGone = cloudflared === null;
    let lostTunnel = false;
    let firstStop: number | null = null;
    const finish = (): void => {
      if (serverGone && tunnelGone) done(lostTunnel ? 1 : (serverCode ?? 1));
    };
    const serverExited = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (serverGone) return;
      serverGone = true;
      serverCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
      if (cloudflared !== null && !tunnelGone) deps.signal(cloudflared, 'SIGTERM');
      finish();
    };
    server.on('exit', serverExited);
    server.on('error', (err) => {
      say(`the server could not start: ${err.message}`);
      serverExited(1, null);
    });
    cloudflared?.on('exit', (code, signal) => {
      tunnelGone = true;
      if (!serverGone) {
        lostTunnel = true;
        say(`cloudflared stopped (exit ${code ?? signal}): the carrier cannot reach the server, so it is stopping too`);
        deps.signal(server, 'SIGTERM');
      }
      finish();
    });
    deps.onStop((signal) => {
      const at = deps.now();
      // A repeat at once is the same stop, passed on again by pnpm and tsx (index.ts SIGNAL_REPEAT_MS).
      if (firstStop !== null && at - firstStop < SIGNAL_REPEAT_MS) return;
      firstStop ??= at;
      if (!serverGone) deps.signal(server, signal);
      else if (cloudflared !== null && !tunnelGone) deps.signal(cloudflared, 'SIGTERM');
    });
  });
}

/** Signals the child's process group (it was started detached, so it leads one), else the child alone. */
function signalGroup(child: StartChild & { kill?(signal: NodeJS.Signals): boolean }, signal: NodeJS.Signals): void {
  try {
    if (child.pid !== undefined) {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {
    // The group is gone, or this platform has none.
  }
  try {
    child.kill?.(signal);
  } catch {
    // Gone already.
  }
}

// Run when invoked directly (tsx start.ts); importing it runs nothing.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const children: StartChild[] = [];
  process.on('exit', () => {
    for (const c of children) signalGroup(c, 'SIGTERM');
  });
  process.exitCode = await main(process.argv.slice(2), {
    out: (line) => console.log(line),
    env: process.env,
    invokedFrom: process.env.INIT_CWD?.trim() || process.cwd(),
    which: (command) => findOnPath(command, process.env),
    spawn: (command, args, options) => {
      const child = spawn(command, [...args], options);
      children.push(child);
      child.on('exit', () => children.splice(children.indexOf(child), 1));
      return child;
    },
    signal: signalGroup,
    onStop: (handler) => {
      process.on('SIGINT', handler);
      process.on('SIGTERM', handler);
    },
    now: () => Date.now(),
  });
}
