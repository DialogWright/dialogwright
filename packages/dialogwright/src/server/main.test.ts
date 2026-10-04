import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CRASH_CLOSE_MS, describeCrash, SIGNAL_REPEAT_MS } from './index';

/**
 * The process entry point (index.ts main), in a child process running a tiny launcher
 * (fixture/mainLauncher.ts): the settings file it reads, what it does on a crash, and the stop signals.
 * The child gets a small environment of its own (never the test runner's, which could name a real
 * model), and every settings file is a throwaway one in a temp folder.
 */

const PACKAGE_DIR = fileURLToPath(new URL('../../', import.meta.url));
const LAUNCHER = fileURLToPath(new URL('./fixture/mainLauncher.ts', import.meta.url));

interface Launched {
  child: ChildProcess;
  output(): string;
  waitFor(pattern: RegExp, ms?: number): Promise<void>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const children: ChildProcess[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'main-'));
  dirs.push(d);
  return d;
}

/** What the server needs to start, on any free port, writing into a temp folder. */
function baseEnv(dir: string): Record<string, string> {
  return {
    PUBLIC_HOST: 'localhost',
    TWILIO_AUTH_TOKEN: 't',
    HANDOFF_NUMBER: '+15551234567',
    PORT: '0',
    TRACE_DIR: join(dir, 'traces'),
    AUDIT_DIR: join(dir, 'audit'),
    AUDIO_DIR: dir,
    TODAY_OVERRIDE: '2026-09-18',
  };
}

function launch(env: Record<string, string>, args: string[] = []): Launched {
  const own: Record<string, string> = { ...env };
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'SystemRoot']) if (process.env[name] !== undefined) own[name] = process.env[name]!;
  const child = fork(LAUNCHER, args, { cwd: PACKAGE_DIR, execArgv: ['--import', 'tsx'], env: own, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  children.push(child);
  let out = '';
  const waiters: { pattern: RegExp; resolve: () => void }[] = [];
  const take = (chunk: Buffer): void => {
    out += chunk.toString('utf8');
    for (const w of [...waiters]) {
      if (w.pattern.test(out)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve();
      }
    }
  };
  child.stdout!.on('data', take);
  child.stderr!.on('data', take);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  return {
    child,
    output: () => out,
    exited,
    waitFor: (pattern, ms = 20_000) =>
      new Promise<void>((resolve, reject) => {
        if (pattern.test(out)) return resolve();
        const timer = setTimeout(() => reject(new Error(`no ${pattern} within ${ms} ms; output:\n${out}`)), ms);
        waiters.push({ pattern, resolve: () => (clearTimeout(timer), resolve()) });
        void exited.then(() => setTimeout(() => reject(new Error(`exited before ${pattern}; output:\n${out}`)), 50));
      }),
  };
}

const LISTENING = /listening on \d+/;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('the settings file', () => {
  it('reads ENV_FILE before the config, and a variable already in the environment wins over it', async () => {
    const dir = tempDir();
    const file = join(dir, 'line.env');
    const { HANDOFF_NUMBER: _h, PORT: _p, ...rest } = baseEnv(dir);
    writeFileSync(file, '# a throwaway settings file\nPORT=0\nHANDOFF_NUMBER=+15550001111\nTIMEZONE=America/Chicago\n');
    const fromFile = launch({ ...rest, ENV_FILE: file });
    await fromFile.waitFor(LISTENING);
    expect(fromFile.output()).toContain('handoff +15550001111');
    expect(fromFile.output()).toContain('timezone America/Chicago');
    expect(fromFile.output()).toContain(`settings from ${file}`);
    fromFile.child.kill('SIGTERM');
    expect((await fromFile.exited).code).toBe(0);

    const overridden = launch({ ...rest, ENV_FILE: file, HANDOFF_NUMBER: '+15550002222' });
    await overridden.waitFor(LISTENING);
    expect(overridden.output()).toContain('handoff +15550002222');
    expect(overridden.output()).toContain('timezone America/Chicago');
    overridden.child.kill('SIGTERM');
    await overridden.exited;
  }, 60_000);

  it('takes --env-file <path> as well', async () => {
    const dir = tempDir();
    const file = join(dir, 'line.env');
    const { HANDOFF_NUMBER: _h, ...rest } = baseEnv(dir);
    writeFileSync(file, 'HANDOFF_NUMBER=+15550003333\n');
    const l = launch(rest, ['--env-file', file]);
    await l.waitFor(LISTENING);
    expect(l.output()).toContain('handoff +15550003333');
    l.child.kill('SIGTERM');
    await l.exited;
  }, 30_000);

  it('refuses to start when the file is missing, naming it', async () => {
    const dir = tempDir();
    const missing = join(dir, 'missing.env');
    const l = launch({ ...baseEnv(dir), ENV_FILE: missing });
    const { code } = await l.exited;
    expect(code).toBe(1);
    expect(l.output()).toContain(`error: ENV_FILE does not exist: ${missing}`);
  }, 30_000);
});

describe('a crash', () => {
  it('logs an uncaught exception with its stack and its cause, closes, and exits 1, so a supervisor restarts the process', async () => {
    const dir = tempDir();
    const l = launch({ ...baseEnv(dir), LAUNCHER_MODE: 'throw' });
    const { code } = await l.exited;
    expect(code).toBe(1);
    const out = l.output();
    expect(out).toMatch(/fatal: uncaught exception: Error: launcher boom\n\s+at /);
    expect(out).toMatch(/caused by: Error: the cause of it\n\s+at /);
    expect(out).toContain('closing (up to 3 s');
    // The best-effort close ran before the exit.
    expect(out).toContain('[launcher] sidecars closed');
  }, 30_000);

  it('exits 1 within its deadline even when the close does not finish', async () => {
    const dir = tempDir();
    const l = launch({ ...baseEnv(dir), LAUNCHER_MODE: 'throw-hold' });
    await l.waitFor(/fatal: uncaught exception/);
    const t0 = Date.now();
    const { code } = await l.exited;
    expect(code).toBe(1);
    expect(Date.now() - t0).toBeLessThan(CRASH_CLOSE_MS + 2_000);
    expect(l.output()).not.toContain('[launcher] sidecars closed');
  }, 30_000);

  it('does the same for an unhandled rejection', async () => {
    const dir = tempDir();
    const l = launch({ ...baseEnv(dir), LAUNCHER_MODE: 'reject' });
    const { code } = await l.exited;
    expect(code).toBe(1);
    expect(l.output()).toContain('fatal: unhandled rejection: Error: launcher rejection');
    expect(l.output()).toContain('[launcher] sidecars closed');
  }, 30_000);

  it('describes a value that is not an Error by its kind, never its contents', () => {
    expect(describeCrash({ authorization: 'Bearer not-a-real-key' })).toBe('an Object, not an Error');
    expect(describeCrash('gone')).toBe('gone (a string, not an Error)');
    expect(describeCrash(null)).toBe('null (not an Error)');
  });
});

describe('the stop signals', () => {
  it('stops cleanly on one signal', async () => {
    const l = launch(baseEnv(tempDir()));
    await l.waitFor(LISTENING);
    l.child.kill('SIGTERM');
    expect((await l.exited).code).toBe(0);
    expect(l.output()).toContain('shutting down');
    expect(l.output()).not.toContain('forced exit');
  }, 30_000);

  for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]] as const) {
    it(`exits at once on a second ${signal} while the first stop is still under way, with ${code}`, async () => {
      const l = launch({ ...baseEnv(tempDir()), LAUNCHER_MODE: 'hold' });
      await l.waitFor(LISTENING);
      l.child.kill(signal);
      await l.waitFor(/shutting down/);
      await sleep(SIGNAL_REPEAT_MS + 200);
      l.child.kill(signal);
      expect((await l.exited).code).toBe(code);
      expect(l.output()).toContain('forced exit');
    }, 30_000);
  }

  it('takes a repeat of the signal at once as the same stop (a Ctrl-C can reach the server through pnpm and tsx as well)', async () => {
    const l = launch({ ...baseEnv(tempDir()), LAUNCHER_MODE: 'hold' });
    await l.waitFor(LISTENING);
    l.child.kill('SIGINT');
    await sleep(20);
    l.child.kill('SIGINT');
    await sleep(500);
    expect(l.child.exitCode).toBeNull();
    expect(l.output()).toContain('shutting down');
    expect(l.output()).not.toContain('forced exit');
  }, 30_000);
});
