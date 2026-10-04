import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { main, type StartChild, type StartDeps } from './start';
import { SIGNAL_REPEAT_MS } from './index';

/**
 * `pnpm start` (start.ts): the settings file, the quick tunnel and the server, with every process faked.
 * No test runs cloudflared, pnpm or the network.
 */

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const QUICK = readFileSync(fileURLToPath(new URL('./fixture/cloudflared-quick-2024.txt', import.meta.url)), 'utf8');
const HOST = 'example-quiet-harbor-words.trycloudflare.com';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A workspace with one app, `alpha`, and its settings file when `env` is given. */
function workspace(env?: string): { root: string; app: string } {
  const root = mkdtempSync(join(tmpdir(), 'start-'));
  dirs.push(root);
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n');
  const app = join(root, 'apps', 'alpha');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: '@example/alpha', scripts: { serve: 'tsx src/serve.ts' } }));
  writeFileSync(join(app, 'app.yaml'), 'id: alpha\n');
  if (env !== undefined) writeFileSync(join(app, '.env'), env);
  return { root, app };
}

interface FakeChild extends StartChild {
  command: string;
  args: string[];
  options: { cwd?: string; env?: NodeJS.ProcessEnv; detached?: boolean };
  signals: NodeJS.Signals[];
  exit(code: number | null, signal?: NodeJS.Signals | null): void;
}

interface Harness {
  deps: StartDeps;
  out: string[];
  spawned: FakeChild[];
  stop(signal: NodeJS.Signals): void;
  advance(ms: number): void;
}

/** Deps whose cloudflared prints `tunnelOutput` as it starts, and whose server runs until told to exit. */
function harness(root: string, over: { cloudflared?: string | null; tunnelOutput?: string; env?: Record<string, string> } = {}): Harness {
  const out: string[] = [];
  const spawned: FakeChild[] = [];
  let stopHandler: ((s: NodeJS.Signals) => void) | null = null;
  let t = 1_000_000;
  const deps: StartDeps = {
    out: (l) => out.push(l),
    env: over.env ?? {},
    invokedFrom: root,
    root,
    which: (cmd) => (cmd === 'cloudflared' ? (over.cloudflared === undefined ? '/usr/local/bin/cloudflared' : over.cloudflared) : `/usr/local/bin/${cmd}`),
    spawn: (command, args, options) => {
      const child = Object.assign(new EventEmitter(), {
        command, args, options, signals: [] as NodeJS.Signals[], pid: 4000 + spawned.length,
        stdout: new PassThrough(), stderr: new PassThrough(),
        exit: (code: number | null, signal: NodeJS.Signals | null = null) => (child as unknown as EventEmitter).emit('exit', code, signal),
      }) as unknown as FakeChild;
      spawned.push(child);
      if (command.endsWith('cloudflared')) setImmediate(() => (child.stderr as PassThrough).write(over.tunnelOutput ?? QUICK));
      return child;
    },
    signal: (child, signal) => {
      const c = child as FakeChild;
      c.signals.push(signal);
      // cloudflared stops when told to; the server stops when the test says.
      if (c.command.endsWith('cloudflared')) setImmediate(() => c.exit(null, signal));
    },
    onStop: (h) => {
      stopHandler = h;
    },
    now: () => t,
    tunnelTimeoutMs: 200,
  };
  return { deps, out, spawned, stop: (s) => stopHandler?.(s), advance: (ms) => void (t += ms) };
}

const tick = () => new Promise((r) => setImmediate(r));
async function until(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !pred(); i++) await new Promise((r) => setTimeout(r, 5));
  if (!pred()) throw new Error('timed out');
}

const PHONE = 'VOICE_PROVIDERS=telnyx\nTELNYX_PUBLIC_KEY=not-read-by-start\nHANDOFF_NUMBER=+15555550123\nPORT=3100\n';

describe('pnpm start', () => {
  it('opens a quick tunnel when PUBLIC_HOST is unset, then runs the server with its hostname and the settings file', async () => {
    const { root, app } = workspace(PHONE);
    const h = harness(root);
    const done = main([], h.deps);
    await until(() => h.spawned.length === 2);
    const [tunnel, server] = h.spawned;
    expect([tunnel!.command, ...tunnel!.args]).toEqual(['/usr/local/bin/cloudflared', 'tunnel', '--no-autoupdate', '--url', 'http://localhost:3100']);
    expect(tunnel!.options.detached).toBe(true);
    expect([server!.command, ...server!.args]).toEqual(['pnpm', '--filter', '@example/alpha', 'serve']);
    expect(server!.options.cwd).toBe(root);
    expect(server!.options.env).toMatchObject({ ENV_FILE: join(app, '.env'), PUBLIC_HOST: HOST });
    const said = h.out.join('\n');
    expect(said).toContain(`quick tunnel: https://${HOST}`);
    expect(said).toContain(`https://${HOST}/voice/telnyx`);
    expect(said).toContain('It changes every time pnpm start runs');
    expect(said).toContain('Send a TeXML Webhook to the URL');
    expect(said).toContain(`  PUBLIC_HOST=${HOST} pnpm diagnose --app alpha`);
    server!.exit(0);
    expect(await done).toBe(0);
    expect(tunnel!.signals).toEqual(['SIGTERM']);
  });

  it('says how to install cloudflared when it is not on PATH, and starts nothing', async () => {
    const { root } = workspace(PHONE);
    const h = harness(root, { cloudflared: null });
    expect(await main([], h.deps)).toBe(1);
    expect(h.spawned).toEqual([]);
    const said = h.out.join('\n');
    expect(said).toContain('cloudflared is not installed');
    expect(said).toContain('brew install cloudflared');
    expect(said).toContain('apt');
    expect(said).toContain('https://github.com/cloudflare/cloudflared/releases');
    expect(said).toContain('pnpm start --tunnel none');
  });

  it('stops cloudflared and says why when no hostname comes', async () => {
    const { root } = workspace(PHONE);
    const h = harness(root, { tunnelOutput: '2026-10-04T17:02:11Z INF Requesting new quick Tunnel on trycloudflare.com...\n' });
    expect(await main([], h.deps)).toBe(1);
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0]!.signals).toEqual(['SIGTERM']);
    expect(h.out.join('\n')).toContain('cloudflared gave no quick tunnel hostname within 0.2 seconds');
    expect(h.out.join('\n')).toContain('no config.yml in ~/.cloudflared');
  });

  it('stops cloudflared on a stop that comes while the tunnel is still opening, and starts no server', async () => {
    const { root } = workspace(PHONE);
    const h = harness(root, { tunnelOutput: '2026-10-04T17:02:11Z INF Requesting new quick Tunnel on trycloudflare.com...\n' });
    h.deps.tunnelTimeoutMs = 5_000;
    const done = main([], h.deps);
    await until(() => h.spawned.length === 1);
    h.stop('SIGINT');
    expect(await done).toBe(130);
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0]!.signals).toEqual(['SIGTERM']);
    expect(h.out.join('\n')).toContain('stopped before the tunnel was open');
  });

  it('takes a hangup (the terminal closed) as a stop, passed to the server as SIGTERM', async () => {
    const { root } = workspace(PHONE);
    const h = harness(root);
    const done = main([], h.deps);
    await until(() => h.spawned.length === 2);
    const [tunnel, server] = h.spawned;
    h.stop('SIGHUP');
    expect(server!.signals).toEqual(['SIGTERM']);
    server!.exit(0);
    expect(await done).toBe(0);
    expect(tunnel!.signals).toEqual(['SIGTERM']);
  });

  it('passes one stop to the server, a repeat at once being the same, and stops the tunnel only once the server has', async () => {
    const { root } = workspace(PHONE);
    const h = harness(root);
    const done = main([], h.deps);
    await until(() => h.spawned.length === 2);
    const [tunnel, server] = h.spawned;
    h.stop('SIGINT');
    h.advance(10);
    h.stop('SIGINT');
    expect(server!.signals).toEqual(['SIGINT']);
    expect(tunnel!.signals).toEqual([]);
    h.advance(SIGNAL_REPEAT_MS + 10);
    h.stop('SIGINT');
    expect(server!.signals).toEqual(['SIGINT', 'SIGINT']);
    server!.exit(130);
    expect(await done).toBe(130);
    expect(tunnel!.signals).toEqual(['SIGTERM']);
  });

  it('stops the server when the tunnel goes', async () => {
    const { root } = workspace(PHONE);
    const h = harness(root);
    const done = main([], h.deps);
    await until(() => h.spawned.length === 2);
    const [tunnel, server] = h.spawned;
    tunnel!.exit(1);
    await tick();
    expect(server!.signals).toEqual(['SIGTERM']);
    expect(h.out.join('\n')).toContain('cloudflared stopped (exit 1): the carrier cannot reach the server, so it is stopping too');
    server!.exit(0);
    expect(await done).toBe(1);
  });

  it('runs no tunnel with PUBLIC_HOST set, or with --tunnel none, and leaves PUBLIC_HOST to the file', async () => {
    const { root, app } = workspace(`${PHONE}PUBLIC_HOST=ivr.example.com\n`);
    for (const argv of [[], ['--tunnel', 'none'], ['--tunnel', 'named']]) {
      const h = harness(root);
      const done = main(argv, h.deps);
      await until(() => h.spawned.length === 1);
      const [server] = h.spawned;
      expect(server!.command).toBe('pnpm');
      expect(server!.options.env!.ENV_FILE).toBe(join(app, '.env'));
      expect(server!.options.env!.PUBLIC_HOST).toBeUndefined();
      expect(h.out.join('\n')).toContain('https://ivr.example.com/voice/telnyx');
      server!.exit(0);
      expect(await done).toBe(0);
    }
  });

  it('refuses --tunnel named without PUBLIC_HOST', async () => {
    const { root } = workspace(PHONE);
    const h = harness(root);
    expect(await main(['--tunnel', 'named'], h.deps)).toBe(1);
    expect(h.out.join('\n')).toContain("--tunnel named needs PUBLIC_HOST: your named tunnel's hostname, in the settings file");
    expect(h.spawned).toEqual([]);
  });

  it('refuses --tunnel none without PUBLIC_HOST, which the server would refuse too', async () => {
    const { root } = workspace(PHONE);
    const h = harness(root);
    expect(await main(['--tunnel', 'none'], h.deps)).toBe(1);
    expect(h.out.join('\n')).toContain('--tunnel none needs PUBLIC_HOST in the settings file: localhost on a laptop, or a hostname you already have');
    expect(h.spawned).toEqual([]);
  });

  it('asks for pnpm configure first when there is no settings file', async () => {
    const { root, app } = workspace();
    const h = harness(root);
    expect(await main([], h.deps)).toBe(1);
    expect(h.out.join('\n')).toContain(`no settings file at ${join(app, '.env')}: run pnpm configure first (or name one: ENV_FILE=<path> pnpm start)`);
  });

  it('takes a settings file named with --env-file or ENV_FILE, from where pnpm was run', async () => {
    const { root } = workspace();
    const file = join(root, 'line.env');
    writeFileSync(file, `${PHONE}PUBLIC_HOST=localhost\n`);
    for (const [argv, env] of [[['--env-file', 'line.env', '--app', 'alpha'], {}], [['--app', 'alpha'], { ENV_FILE: 'line.env' }]] as const) {
      const h = harness(root, { env: { ...env } });
      const done = main([...argv], h.deps);
      await until(() => h.spawned.length === 1);
      expect(h.spawned[0]!.options.env!.ENV_FILE).toBe(file);
      expect(h.out.join('\n')).toContain('the console, on this machine: http://localhost:3100/dashboard');
      // No carrier reaches localhost: no webhook to paste.
      expect(h.out.join('\n')).not.toContain('voice webhook');
      h.spawned[0]!.exit(0);
      await done;
    }
  });

  it('is pnpm start at the repository root, and pnpm configure beside it, each run by tsx itself', () => {
    // Not through a second pnpm (pnpm --filter): pnpm turns a terminal's Ctrl-C, reaching it twice, into
    // a SIGTERM for the command, and returns the prompt while the server is still draining.
    const scripts = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
    expect(scripts.start).toBe('tsx packages/dialogwright/src/server/start.ts');
    expect(scripts.configure).toBe('tsx packages/dialogwright/src/server/setup.ts');
  });
});
