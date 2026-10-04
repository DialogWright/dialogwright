import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatResult, main, runDoctor, settingsFileCheck, type CheckId, type CheckResult, type DoctorDeps } from './doctor';

/**
 * `pnpm diagnose` (doctor.ts): each check's ok and its warn or fail, with fetch, DNS, the clock and the
 * free space stubbed, so no test reaches the network or depends on this machine's disk. The settings are
 * throwaway values; a settings file is written in a temp folder.
 */

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);
const GB = 1024 ** 3;
const TELNYX_PUBLIC_KEY = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      chmodSync(d, 0o700);
    } catch {
      // Already gone.
    }
    rmSync(d, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'doctor-'));
  dirs.push(d);
  return d;
}

/** A phone line through a named tunnel, on Telnyx, with a model: everything a doctor should pass. */
function goodEnv(dir: string): Record<string, string> {
  return {
    PUBLIC_HOST: 'ivr.example.com',
    VOICE_PROVIDERS: 'telnyx',
    TELNYX_PUBLIC_KEY,
    // Ofcom's range for drama (07700 900xxx): fictional, and not a 555 number.
    HANDOFF_NUMBER: '+447700900123',
    JEV_CLIENT: 'jev',
    JEV_PROVIDER: 'openrouter',
    OPENROUTER_API_KEY: 'test-key-not-real',
    TRACE_DIR: join(dir, 'traces'),
    AUDIT_DIR: join(dir, 'audit'),
  };
}

interface Seen {
  fetched: string[];
  looked: string[];
  /** Each request's method and headers, to show none carries a key. */
  requests: { url: string; method: string; headers: Record<string, string> }[];
}

/**
 * Stubs answering as a healthy server behind its tunnel would, each part overridable. The server's own
 * answers carry this machine's time (through a tunnel, it is this machine's clock); `date` is the time
 * other hosts answer a HEAD with, and `clock` replaces their answer.
 */
function deps(over: Partial<{ health: Response | Error; dashboard: Response | Error; clock: Response | Error; lookup: Error | null; date: number; free: number | null }> = {}): DoctorDeps & { seen: Seen } {
  const seen: Seen = { fetched: [], looked: [], requests: [] };
  const own = new Date(NOW).toUTCString();
  const date = new Date(over.date ?? NOW).toUTCString();
  return {
    seen,
    now: () => NOW,
    lookup: async (host) => {
      seen.looked.push(host);
      if (over.lookup) throw over.lookup;
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      seen.fetched.push(method === 'GET' ? url : `${method} ${url}`);
      seen.requests.push({ url, method, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
      if (method === 'HEAD') {
        if (over.clock instanceof Error) throw over.clock;
        return over.clock ?? new Response(null, { status: 404, headers: { date } });
      }
      const which = url.endsWith('/health') ? over.health : over.dashboard;
      if (which instanceof Error) throw which;
      if (which) return which;
      return url.endsWith('/health')
        ? new Response(JSON.stringify({ ok: true, sessions: 0, retained: 0 }), { status: 200, headers: { date: own } })
        : new Response('not found', { status: 404, headers: { date: own } });
    }) as typeof fetch,
    freeBytes: () => (over.free === undefined ? 50 * GB : over.free),
  };
}

const byId = (results: CheckResult[], id: CheckId): CheckResult => {
  const r = results.find((x) => x.id === id);
  if (!r) throw new Error(`no ${id} check in ${JSON.stringify(results)}`);
  return r;
};

describe('pnpm diagnose', () => {
  it('passes a deployment with nothing wrong, asking its own health through the tunnel', async () => {
    const dir = tempDir();
    const d = deps();
    const results = await runDoctor({ env: goodEnv(dir), cwd: dir }, d);
    expect(results.map((r) => `${r.id} ${r.status}`)).toEqual([
      'config ok', 'reach ok', 'console ok', 'carrier ok', 'model ok', 'handoff ok', 'folders ok', 'space ok', 'clock ok',
    ]);
    expect(d.seen.looked).toEqual(['ivr.example.com']);
    expect(d.seen.fetched).toEqual(['https://ivr.example.com/health', 'https://ivr.example.com/dashboard', 'HEAD https://api.telnyx.com/']);
  });

  describe('1. the config', () => {
    it('fails with the startup message, and skips what needs it', async () => {
      const dir = tempDir();
      const { HANDOFF_NUMBER: _h, ...env } = goodEnv(dir);
      const results = await runDoctor({ env, cwd: dir }, deps());
      expect(byId(results, 'config')).toMatchObject({ status: 'fail', message: 'missing required environment variable HANDOFF_NUMBER' });
      expect(results.map((r) => r.id)).toEqual(['config']);
    });

    it('warns that a quick tunnel sets PUBLIC_HOST each run when it is unset', async () => {
      const dir = tempDir();
      const { PUBLIC_HOST: _p, ...env } = goodEnv(dir);
      const d = deps();
      const results = await runDoctor({ env, cwd: dir }, d);
      expect(byId(results, 'config')).toMatchObject({ status: 'warn', message: expect.stringContaining('PUBLIC_HOST is not set: pnpm start --tunnel quick sets it each run') });
      expect(byId(results, 'reach').status).toBe('skip');
      // Nothing of the server's is asked; only the carrier's host, for the clock.
      expect(d.seen.fetched).toEqual(['HEAD https://api.telnyx.com/']);
    });
  });

  describe('2. reaching it through PUBLIC_HOST', () => {
    it('fails when the name does not resolve', async () => {
      const dir = tempDir();
      const results = await runDoctor({ env: goodEnv(dir), cwd: dir }, deps({ lookup: new Error('ENOTFOUND') }));
      expect(byId(results, 'reach')).toMatchObject({ status: 'fail', message: 'ivr.example.com does not resolve (ENOTFOUND)', fix: 'the carrier cannot reach this server: is the tunnel running?' });
    });

    it('fails when health does not answer', async () => {
      const dir = tempDir();
      const results = await runDoctor({ env: goodEnv(dir), cwd: dir }, deps({ health: new Error('timed out') }));
      expect(byId(results, 'reach')).toMatchObject({ status: 'fail', message: 'https://ivr.example.com/health did not answer (timed out)', fix: 'the carrier cannot reach this server: is the tunnel running?' });
      expect(byId(results, 'console').status).toBe('skip');
    });

    it('fails when something else answers', async () => {
      const dir = tempDir();
      const results = await runDoctor({ env: goodEnv(dir), cwd: dir }, deps({ health: new Response('bad gateway', { status: 502 }) }));
      expect(byId(results, 'reach')).toMatchObject({ status: 'fail', message: 'https://ivr.example.com/health answered 502' });
    });

    it('is skipped offline, and on a laptop', async () => {
      const dir = tempDir();
      const d = deps();
      const offline = await runDoctor({ env: goodEnv(dir), cwd: dir, offline: true }, d);
      expect(['reach', 'console', 'clock'].map((id) => byId(offline, id as CheckId).status)).toEqual(['skip', 'skip', 'skip']);
      const laptop = await runDoctor({ env: { ...goodEnv(dir), PUBLIC_HOST: 'localhost' }, cwd: dir }, d);
      expect(byId(laptop, 'reach')).toMatchObject({ status: 'skip', message: expect.stringContaining('localhost') });
      // A laptop uses no carrier: the clock is read from the model's host alone.
      expect(d.seen.fetched).toEqual(['HEAD https://openrouter.ai/']);
    });
  });

  describe('3. the console is not public', () => {
    it('fails when /dashboard answers through the tunnel', async () => {
      const dir = tempDir();
      const results = await runDoctor({ env: { ...goodEnv(dir), CONSOLE_LOCAL_ONLY: 'off' }, cwd: dir }, deps({ dashboard: new Response('<html>', { status: 200 }) }));
      expect(byId(results, 'console')).toMatchObject({ status: 'fail', message: 'https://ivr.example.com/dashboard answered 200: the console is public', fix: 'set CONSOLE_LOCAL_ONLY=on (the default): anyone could watch calls' });
    });

    /** deps(), with the console's own paths answered as `answers` says (by the end of the URL). */
    function consoleDeps(answers: Record<string, Response | Error>): DoctorDeps & { seen: Seen } {
      const d = deps();
      const inner = d.fetch;
      d.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const answer = Object.entries(answers).find(([end]) => url.endsWith(end))?.[1];
        if (answer === undefined) return inner(input, init);
        d.seen.fetched.push(url);
        expect(init?.redirect).toBe('manual');
        if (answer instanceof Error) throw answer;
        return answer;
      }) as typeof fetch;
      return d;
    }
    const signIn = () => new Response(null, { status: 302, headers: { location: '/dashboard/login' } });
    const refused = () => new Response('sign in first: /dashboard/login', { status: 401 });

    it('with CONSOLE_AUTH=token, passes when the page sends to sign in and its data asks for one', async () => {
      const dir = tempDir();
      const d = consoleDeps({ '/dashboard': signIn(), '/dashboard/traces': refused() });
      const results = await runDoctor({ env: { ...goodEnv(dir), CONSOLE_AUTH: 'token' }, cwd: dir }, d);
      expect(byId(results, 'console')).toMatchObject({ status: 'ok', message: 'the console asks for sign-in through the tunnel (CONSOLE_AUTH=token): /dashboard goes to /dashboard/login, and its data answers 401' });
      expect(d.seen.fetched).toContain('https://ivr.example.com/dashboard/traces');
    });

    it('with CONSOLE_AUTH=token, fails when the page or its data answers without a sign-in', async () => {
      const dir = tempDir();
      const env = { ...goodEnv(dir), CONSOLE_AUTH: 'token' };
      const page = await runDoctor({ env, cwd: dir }, consoleDeps({ '/dashboard': new Response('<html>', { status: 200 }), '/dashboard/traces': refused() }));
      expect(byId(page, 'console')).toMatchObject({ status: 'fail', message: 'https://ivr.example.com/dashboard answered 200 without a sign-in: the console is public', fix: 'restart the server with these settings (CONSOLE_AUTH=token): anyone could watch calls' });
      const data = await runDoctor({ env, cwd: dir }, consoleDeps({ '/dashboard': signIn(), '/dashboard/traces': new Response('[]', { status: 200 }) }));
      expect(byId(data, 'console')).toMatchObject({ status: 'fail', message: 'https://ivr.example.com/dashboard/traces answered 200 without a sign-in: the calls are public' });
      const elsewhere = await runDoctor({ env, cwd: dir }, consoleDeps({ '/dashboard': new Response(null, { status: 302, headers: { location: 'https://elsewhere.example.org/' } }), '/dashboard/traces': refused() }));
      expect(byId(elsewhere, 'console').status).toBe('fail');
    });

    it('with CONSOLE_AUTH=token, warns when the running server still keeps the console local (404)', async () => {
      const dir = tempDir();
      const results = await runDoctor({ env: { ...goodEnv(dir), CONSOLE_AUTH: 'token' }, cwd: dir }, consoleDeps({ '/dashboard': new Response('not found', { status: 404 }) }));
      expect(byId(results, 'console')).toMatchObject({ status: 'warn', message: 'https://ivr.example.com/dashboard answered 404: the running server keeps the console local, though CONSOLE_AUTH is token here', fix: 'restart the server to take CONSOLE_AUTH=token' });
    });
  });

  describe('4. the carrier', () => {
    it('fails a Twilio auth token that is not 32 hexadecimal characters', async () => {
      const dir = tempDir();
      const env = { ...goodEnv(dir), VOICE_PROVIDERS: 'twilio', TWILIO_AUTH_TOKEN: 'not-a-token' };
      expect(byId(await runDoctor({ env, cwd: dir }, deps()), 'carrier')).toMatchObject({
        status: 'fail',
        message: 'TWILIO_AUTH_TOKEN is 11 characters, not the 32 hexadecimal characters of an auth token',
        fix: "copy the account's auth token from the Twilio Console: every call would be refused as unsigned",
      });
      expect(byId(await runDoctor({ env: { ...env, TWILIO_AUTH_TOKEN: '0123456789abcdef0123456789abcdef' }, cwd: dir }, deps()), 'carrier').status).toBe('ok');
    });

    it('warns when signatures are not checked on a public host', async () => {
      const dir = tempDir();
      expect(byId(await runDoctor({ env: { ...goodEnv(dir), SIGNATURE_CHECK: 'off' }, cwd: dir }, deps()), 'carrier')).toMatchObject({ status: 'warn', fix: 'set SIGNATURE_CHECK=on: anyone could post a webhook' });
    });
  });

  describe('5. the model', () => {
    it('warns that a stub understands only by examples', async () => {
      const dir = tempDir();
      const { JEV_CLIENT: _c, ...env } = goodEnv(dir);
      expect(byId(await runDoctor({ env, cwd: dir }, deps()), 'model')).toMatchObject({ status: 'warn', message: 'JEV_CLIENT is stub: callers will be understood only by examples' });
      expect(byId(await runDoctor({ env: { ...env, JEV_CLIENT: 'heuristic' }, cwd: dir }, deps()), 'model').status).toBe('warn');
    });

    it('names the model, the provider and the key variable, never the key', async () => {
      const dir = tempDir();
      const r = byId(await runDoctor({ env: goodEnv(dir), cwd: dir }, deps()), 'model');
      expect(r).toMatchObject({ status: 'ok', message: 'model typesafe/jev-1.13 from openrouter, key in OPENROUTER_API_KEY' });
      expect(JSON.stringify(r)).not.toContain('test-key-not-real');
    });
  });

  describe('6. the handoff number', () => {
    it('warns about a 555 number', async () => {
      const dir = tempDir();
      for (const n of ['+15555550123', '+15550001111']) {
        expect(byId(await runDoctor({ env: { ...goodEnv(dir), HANDOFF_NUMBER: n }, cwd: dir }, deps()), 'handoff')).toMatchObject({ status: 'warn', message: `HANDOFF_NUMBER ${n} is a 555 number: calls handed off will go nowhere` });
      }
    });
  });

  describe('7. the folders and the space', () => {
    it('fails a folder the server cannot write, read from where the server runs', async () => {
      const dir = tempDir();
      const locked = join(dir, 'locked');
      mkdirSync(locked);
      chmodSync(locked, 0o500);
      const env = { ...goodEnv(dir), TRACE_DIR: 'locked/traces', AUDIT_DIR: 'audit' };
      const r = byId(await runDoctor({ env, cwd: dir }, deps()), 'folders');
      if (process.getuid?.() === 0) return; // root writes anywhere
      expect(r).toMatchObject({ status: 'fail', message: `TRACE_DIR ${join(dir, 'locked/traces')} cannot be written` });
    });

    it('warns below a gigabyte free', async () => {
      const dir = tempDir();
      expect(byId(await runDoctor({ env: goodEnv(dir), cwd: dir }, deps({ free: 0.5 * GB })), 'space')).toMatchObject({ status: 'warn', message: expect.stringContaining('0.5 GB free') });
    });
  });

  describe('9. the clock', () => {
    it("fails when it is more than a minute from the carrier's clock, read from a HEAD that carries no key", async () => {
      const dir = tempDir();
      const d = deps({ date: NOW - 125_000 });
      const r = byId(await runDoctor({ env: goodEnv(dir), cwd: dir }, d), 'clock');
      expect(r).toMatchObject({ status: 'fail', message: 'the clock is 125 s ahead of api.telnyx.com', fix: 'let the clock set itself (Telnyx refuses a webhook whose signature is more than five minutes off)' });
      const head = d.seen.requests.filter((q) => q.method === 'HEAD');
      expect(head).toEqual([{ url: 'https://api.telnyx.com/', method: 'HEAD', headers: {} }]);
    });

    it("never compares with PUBLIC_HOST's Date, which through a tunnel is this machine's own clock", async () => {
      const dir = tempDir();
      // The server's own answers carry NOW; the carrier's is two minutes behind: the check must see the gap.
      const r = byId(await runDoctor({ env: goodEnv(dir), cwd: dir }, deps({ date: NOW - 120_000 })), 'clock');
      expect(r.status).toBe('fail');
      expect(r.message).not.toContain('ivr.example.com');
    });

    it('reads it even when the server cannot be reached', async () => {
      const dir = tempDir();
      const r = byId(await runDoctor({ env: goodEnv(dir), cwd: dir }, deps({ lookup: Object.assign(new Error('x'), { code: 'ENOTFOUND' }) })), 'clock');
      expect(r).toEqual({ id: 'clock', status: 'ok', message: 'the clock is within a minute of api.telnyx.com' });
    });

    it("falls back to the model provider's host, and never to a model on this machine", async () => {
      const dir = tempDir();
      const answered: string[] = [];
      const d = deps();
      const inner = d.fetch;
      d.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === 'HEAD') answered.push(String(input));
        if (String(input).startsWith('https://api.telnyx.com')) throw new Error('offline');
        return inner(input, init);
      }) as typeof fetch;
      expect(byId(await runDoctor({ env: goodEnv(dir), cwd: dir }, d), 'clock')).toMatchObject({ status: 'ok', message: 'the clock is within a minute of openrouter.ai' });
      expect(answered).toEqual(['https://api.telnyx.com/', 'https://openrouter.ai/']);

      const local = { ...goodEnv(dir), JEV_PROVIDER: 'custom', JEV_BASE_URL: 'http://localhost:8000', JEV_MODEL: 'local-model' };
      const d2 = deps({ clock: new Error('offline') });
      expect(byId(await runDoctor({ env: local, cwd: dir }, d2), 'clock')).toMatchObject({ status: 'skip', message: 'the clock: no Date from api.telnyx.com' });
      expect(d2.seen.fetched.filter((u) => u.startsWith('HEAD'))).toEqual(['HEAD https://api.telnyx.com/']);
    });

    it('is skipped with nothing to compare with, and offline', async () => {
      const dir = tempDir();
      const laptop = { ...goodEnv(dir), PUBLIC_HOST: 'localhost', JEV_CLIENT: 'heuristic' };
      const d = deps();
      expect(byId(await runDoctor({ env: laptop, cwd: dir }, d), 'clock')).toMatchObject({ status: 'skip', message: expect.stringContaining('no other server this setup uses') });
      expect(d.seen.fetched).toEqual([]);
      const off = deps();
      expect(byId(await runDoctor({ env: goodEnv(dir), cwd: dir, offline: true }, off), 'clock')).toMatchObject({ status: 'skip', message: 'the clock: not asked (--offline)' });
      expect(off.seen.fetched).toEqual([]);
    });
  });

  it('prints one line per check, with the fix, and exits 1 only when one fails', async () => {
    const dir = tempDir();
    const file = join(dir, 'line.env');
    writeFileSync(file, Object.entries({ ...goodEnv(dir), HANDOFF_NUMBER: '+15555550123' }).map(([k, v]) => `${k}=${v}`).join('\n'), { mode: 0o600 });
    const out: string[] = [];
    const code = await main(['--env-file', file], { out: (l) => out.push(l), env: {}, invokedFrom: dir }, deps());
    expect(code).toBe(0);
    expect(out).toContain('warn  HANDOFF_NUMBER +15555550123 is a 555 number: calls handed off will go nowhere  ->  set it to a phone a person answers');
    expect(out).toContain(`ok    ${file} is readable by its owner alone`);
    expect(out.at(-1)).toBe('10 checks: 9 ok, 1 warn, 0 fail');
    expect(out.join('\n')).not.toContain('test-key-not-real');
    const failing = await main(['--env-file', join(dir, 'missing.env')], { out: (l) => out.push(l), env: {}, invokedFrom: dir }, deps());
    expect(failing).toBe(1);
    expect(out).toContain(`fail  ENV_FILE does not exist: ${join(dir, 'missing.env')}  ->  run pnpm configure, or name the file: ENV_FILE=<path> pnpm diagnose`);
  });

  it('warns when the settings file can be read by others, since it holds keys', async () => {
    const dir = tempDir();
    const file = join(dir, 'line.env');
    writeFileSync(file, Object.entries(goodEnv(dir)).map(([k, v]) => `${k}=${v}`).join('\n'));
    chmodSync(file, 0o644);
    const out: string[] = [];
    await main([], { out: (l) => out.push(l), env: { ENV_FILE: file }, invokedFrom: dir }, deps());
    expect(out).toContain(`warn  ${file} can be read by others (mode 644), and it holds keys  ->  chmod 600 ${file}`);
    expect(settingsFileCheck(file, 'win32').status).toBe('skip');
  });

  it('formats a skipped check plainly', () => {
    expect(formatResult({ id: 'clock', status: 'skip', message: 'the clock: no answer to read the time from' })).toBe('skip  the clock: no answer to read the time from');
  });

  it('is a script at the repository root', () => {
    const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(root.scripts.diagnose).toBe('tsx packages/dialogwright/src/server/doctor.ts');
  });
});
