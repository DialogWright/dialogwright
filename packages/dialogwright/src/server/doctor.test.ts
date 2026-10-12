import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { formatResult, main, runDoctor, settingsFileCheck, type CheckId, type CheckResult, type DoctorDeps } from './doctor';
import { pgliteSql } from './stores/pgliteSql';
import { ensureSchema } from './stores/postgres';
import { openPostgresAudit } from '../audit/postgres';
import { PostgresNotices } from './stores/notices';
import { FakeS3 } from '../testing/fakeS3';
import type { SqlClient } from './stores/sql';
import { PgUnavailableError } from './stores/sql';

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
      'config ok', 'reach ok', 'console ok', 'carrier ok', 'model ok', 'handoff ok', 'folders ok', 'space ok', 'retention ok', 'clock ok',
    ]);
    expect(d.seen.looked).toEqual(['ivr.example.com']);
    expect(d.seen.fetched).toEqual(['https://ivr.example.com/health', 'https://ivr.example.com/dashboard', 'HEAD https://api.telnyx.com/']);
  });

  describe('6b. the variables app.yaml names (env.<NAME>)', () => {
    const appDir = (yaml: string): string => {
      const dir = tempDir();
      writeFileSync(join(dir, 'app.yaml'), yaml);
      return dir;
    };

    it('says each is set by its length, never its value, and fails one that is unset, too long or has a control character', async () => {
      const dir = appDir('id: lines\nstartParameters:\n  line: env.CALLBACK_LINE\n  site: env.SITE_CODE\n  token: env.LINE_TOKEN\n  tab: env.TABBED\n');
      const env = { ...goodEnv(dir), CALLBACK_LINE: 'support-east', LINE_TOKEN: 'x'.repeat(501), TABBED: 'a\tb' };
      const results = (await runDoctor({ env, cwd: dir, appDir: dir, offline: true }, deps())).filter((r) => r.id === 'variables');
      expect(results).toEqual([
        { id: 'variables', status: 'ok', message: "app.yaml's startParameters.line reads CALLBACK_LINE: set, 12 characters" },
        { id: 'variables', status: 'fail', message: "app.yaml's startParameters.site reads SITE_CODE, which is not set: the server will not start", fix: 'set SITE_CODE in the settings file' },
        { id: 'variables', status: 'fail', message: "app.yaml's startParameters.token reads LINE_TOKEN: set, 501 characters, more than the 500 a custom parameter takes", fix: 'shorten LINE_TOKEN' },
        { id: 'variables', status: 'fail', message: "app.yaml's startParameters.tab reads TABBED: set, 3 characters, with a control character a start document cannot carry", fix: 'write TABBED on one line, with no tab or other control character' },
      ]);
      expect(JSON.stringify(results)).not.toContain('support-east');
    });

    it('knows a called condition by where it is, not by a key named called', async () => {
      const dir = appDir('id: lines\nstartParameters:\n  called: env.CALLED_PARAM\n');
      const env = { ...goodEnv(dir), CALLED_PARAM: 'east' };
      const results = (await runDoctor({ env, cwd: dir, appDir: dir, offline: true }, deps())).filter((r) => r.id === 'variables');
      expect(results).toEqual([{ id: 'variables', status: 'ok', message: "app.yaml's startParameters.called reads CALLED_PARAM: set, 4 characters" }]);
    });

    it('reads routes.yaml\'s too: a called condition\'s number is E.164, and the file is named', async () => {
      const dir = appDir('id: lines\ntransfer:\n  targets:\n    - when: { called: env.SALES_LINE }\n      to: env.SALES_DESK\n  default: env.HANDOFF_NUMBER\n');
      writeFileSync(join(dir, 'routes.yaml'), 'start:\n  - when: { called: [env.SPANISH_LINE, env.OTHER_LINE] }\n    then: locale\n    locale: es\n  - else: continue\n');
      const env = { ...goodEnv(dir), SALES_LINE: '+15555550177', SALES_DESK: '+442079460123', SPANISH_LINE: '+15555550188', OTHER_LINE: 'sip:x@example.com' };
      const results = (await runDoctor({ env, cwd: dir, appDir: dir, offline: true }, deps())).filter((r) => r.id === 'variables');
      expect(results).toEqual([
        { id: 'variables', status: 'ok', message: "app.yaml's transfer.targets.0.when.called reads SALES_LINE: set, a phone number (the number called is compared with it)" },
        { id: 'variables', status: 'ok', message: "app.yaml's transfer.targets.0.to reads SALES_DESK: set, a phone number" },
        expect.objectContaining({ message: expect.stringContaining("app.yaml's transfer.default reads HANDOFF_NUMBER") }),
        { id: 'variables', status: 'ok', message: "routes.yaml's start.0.when.called.0 reads SPANISH_LINE: set, a phone number (the number called is compared with it)" },
        { id: 'variables', status: 'fail', message: "routes.yaml's start.0.when.called.1 reads OTHER_LINE: set, but it is not an E.164 number: the server will not start", fix: 'set OTHER_LINE to the number callers dial, like +15551234567' },
      ]);
    });

    it('holds a transfer target to an E.164 number or a sip: URI, warns of a 555 one, and never says the value', async () => {
      const yaml = 'id: lines\ntransfer:\n  targets:\n    - when: { reason: emergency }\n      to: env.DESK_SIP\n    - when: { reason: security }\n      to: env.SECURITY_LINE\n    - when: { reason: frustrated }\n      to: env.BAD_LINE\n  default: env.MAIN_LINE\n';
      const dir = appDir(yaml);
      const env = { ...goodEnv(dir), DESK_SIP: 'sip:agents@contact.example.net', SECURITY_LINE: '+15555550123', BAD_LINE: 'desk', MAIN_LINE: '+442079460123' };
      const results = (await runDoctor({ env, cwd: dir, appDir: dir, offline: true }, deps())).filter((r) => r.id === 'variables');
      expect(results).toEqual([
        { id: 'variables', status: 'ok', message: "app.yaml's transfer.targets.0.to reads DESK_SIP: set, a SIP address" },
        { id: 'variables', status: 'warn', message: "app.yaml's transfer.targets.1.to reads SECURITY_LINE: a 555 number, so calls handed off there will go nowhere", fix: 'set SECURITY_LINE to a phone a person answers' },
        {
          id: 'variables', status: 'fail',
          message: "app.yaml's transfer.targets.2.to reads BAD_LINE: set, but it is neither an E.164 number (+15551234567) nor a sip: URI (sip:desk@pbx.example.com): the server will not start",
          fix: 'set BAD_LINE to an E.164 number like +15551234567 or a sip: URI like sip:desk@pbx.example.com',
        },
        { id: 'variables', status: 'ok', message: "app.yaml's transfer.default reads MAIN_LINE: set, a phone number" },
      ]);
      expect(JSON.stringify(results)).not.toContain('contact.example.net');
      expect(JSON.stringify(results)).not.toContain('2079460123');
    });

    it('says nothing for an app.yaml that names none, or no app; and skips one it cannot read', async () => {
      const plain = appDir('id: lines\n');
      const quiet = await runDoctor({ env: goodEnv(plain), cwd: plain, appDir: plain, offline: true }, deps());
      expect(quiet.some((r) => r.id === 'variables')).toBe(false);
      expect((await runDoctor({ env: goodEnv(plain), cwd: plain, offline: true }, deps())).some((r) => r.id === 'variables')).toBe(false);
      const broken = appDir('id: [unclosed\n');
      expect(byId(await runDoctor({ env: goodEnv(broken), cwd: broken, appDir: broken, offline: true }, deps()), 'variables')).toMatchObject({ status: 'skip' });
    });
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

  describe('10. the session store', () => {
    it('is not checked with the memory store (the default): a deployment that sets nothing sees what it saw', async () => {
      const dir = tempDir();
      const results = await runDoctor({ env: { ...goodEnv(dir), SESSION_STORE: 'memory' }, cwd: dir }, deps());
      expect(results.map((r) => r.id)).not.toContain('store');
    });

    it('passes a folder the server can write that a reboot keeps, read from where the server runs, and names the fallback', async () => {
      const dir = tempDir();
      const results = await runDoctor({ env: { ...goodEnv(dir), SESSION_STORE: 'file:sessions' }, cwd: dir }, { ...deps(), temporary: () => false });
      expect(results.map((r) => r.id)).toEqual(['config', 'reach', 'console', 'carrier', 'model', 'handoff', 'folders', 'store', 'space', 'retention', 'clock']);
      expect(byId(results, 'store')).toEqual({
        id: 'store', status: 'ok',
        message: `sessions in ${join(dir, 'sessions')}: a restart resumes the calls under way (a carrier that calls back while no server listens needs its fallback document: pnpm fallback)`,
      });
    });

    it('fails a folder the server cannot write', async () => {
      const dir = tempDir();
      const locked = join(dir, 'locked');
      mkdirSync(locked);
      chmodSync(locked, 0o500);
      const r = byId(await runDoctor({ env: { ...goodEnv(dir), SESSION_STORE: 'file:locked/sessions' }, cwd: dir }, { ...deps(), temporary: () => false }), 'store');
      if (process.getuid?.() === 0) return; // root writes anywhere
      expect(r).toEqual({
        id: 'store', status: 'fail', message: `SESSION_STORE folder ${join(dir, 'locked/sessions')} cannot be written`,
        fix: 'make it writable by the user the server runs as, or point SESSION_STORE elsewhere',
      });
    });

    it('warns about a folder on a temporary filesystem, which a reboot empties', async () => {
      const dir = tempDir();
      const r = byId(await runDoctor({ env: { ...goodEnv(dir), SESSION_STORE: `file:${join(dir, 'sessions')}` }, cwd: dir }, { ...deps(), temporary: () => true }), 'store');
      expect(r).toEqual({
        id: 'store', status: 'warn', message: `SESSION_STORE folder ${join(dir, 'sessions')} is on a temporary filesystem: a reboot empties it, and the calls in it with it`,
        fix: 'point SESSION_STORE at a folder that outlives a reboot, beside the app (file:sessions)',
      });
    });

    it('warns when others than its owner can read the folder, which holds what callers said', async () => {
      const dir = tempDir();
      const open = join(dir, 'sessions');
      mkdirSync(open);
      chmodSync(open, 0o755);
      const r = byId(await runDoctor({ env: { ...goodEnv(dir), SESSION_STORE: 'file:sessions' }, cwd: dir }, { ...deps(), temporary: () => false }), 'store');
      expect(r).toEqual({
        id: 'store', status: 'warn', message: `SESSION_STORE folder ${open} can be read by others than its owner (mode 755)`,
        fix: `chmod 700 ${open}`,
      });
    });

    describe('with SESSION_STORE=postgres://...', () => {
      const URL_WITH_PASSWORD = 'postgres://dialogwright:s3cret-pw@db.example:5432/dialogwright';
      const MASKED = 'postgres://dialogwright:***@db.example:5432/dialogwright';
      const pg = (db: PGlite): Pick<DoctorDeps, 'postgres'> & { asked: string[] } => {
        const asked: string[] = [];
        return { asked, postgres: async (url) => (asked.push(url), pgliteSql(db)) };
      };
      const said = (r: CheckResult): string => JSON.stringify(r);

      it('passes a database that answers, at this version, where a test lease is taken and given up; never the password', async () => {
        const dir = tempDir();
        const db = await PGlite.create();
        try {
          await ensureSchema(pgliteSql(db));
          const p = pg(db);
          const results = await runDoctor({ env: { ...goodEnv(dir), SESSION_STORE: URL_WITH_PASSWORD }, cwd: dir }, { ...deps(), ...p });
          expect(results.map((r) => r.id)).toEqual(['config', 'reach', 'console', 'carrier', 'model', 'handoff', 'folders', 'store', 'space', 'retention', 'clock']);
          expect(byId(results, 'store')).toMatchObject({ id: 'store', status: 'ok' });
          // The test's clock is fixed in 2026; PGlite's is this machine's: the offset is said, for information.
          expect(byId(results, 'store').message).toMatch(new RegExp(`^SESSION_STORE ${MASKED.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} answers, its session tables are version 1, and a test lease was taken and given up: the servers on it share their calls; its clock is -?\\d+\\.\\d s from this machine's \\(leases are timed by the database's\\)$`));
          expect(p.asked).toEqual([URL_WITH_PASSWORD]);
          expect(results.map(said).join('\n')).not.toContain('s3cret-pw');
          // The test lease leaves nothing behind.
          expect((await db.query('SELECT * FROM dw_call_leases')).rows).toEqual([]);
        } finally {
          await db.close();
        }
      });

      it('fails a user that may not write a notice (tried in a transaction undone), saying which rights it needs', async () => {
        const dir = tempDir();
        const db = await PGlite.create();
        try {
          await ensureSchema(pgliteSql(db));
          await PostgresNotices.open(pgliteSql(db), { origin: 'x' }).then((n) => n.close());
          await db.exec(`CREATE ROLE dw_app LOGIN; GRANT SELECT, INSERT, UPDATE, DELETE ON dw_schema, dw_calls, dw_call_leases, dw_chats, dw_tokens TO dw_app;
            GRANT SELECT ON dw_notices TO dw_app; SET ROLE dw_app;`);
          const r = byId(await runDoctor({ env: { ...goodEnv(dir), SESSION_STORE: URL_WITH_PASSWORD }, cwd: dir }, { ...deps(), ...pg(db) }), 'store');
          expect(r).toMatchObject({ id: 'store', status: 'fail', fix: 'give the user in SESSION_STORE the right to select, insert and delete on dw_notices and to use the sequence dw_notices_id_seq' });
          expect(r.message).toMatch(/^SESSION_STORE postgres:\/\/dialogwright:\*\*\*@db\.example:5432\/dialogwright: a notice could not be written: permission denied/);
          await db.exec('RESET ROLE; GRANT INSERT ON dw_notices TO dw_app; GRANT USAGE ON SEQUENCE dw_notices_id_seq TO dw_app; SET ROLE dw_app;');
          expect(byId(await runDoctor({ env: { ...goodEnv(dir), SESSION_STORE: URL_WITH_PASSWORD }, cwd: dir }, { ...deps(), ...pg(db) }), 'store').status).toBe('ok');
          expect((await db.query('SELECT * FROM dw_notices')).rows).toEqual([]);
        } finally {
          await db.close();
        }
      });

      it('passes a database whose tables are not made yet, saying the server makes them', async () => {
        const dir = tempDir();
        const db = await PGlite.create();
        try {
          const r = byId(await runDoctor({ env: { ...goodEnv(dir), SESSION_STORE: URL_WITH_PASSWORD }, cwd: dir }, { ...deps(), ...pg(db) }), 'store');
          expect(r).toEqual({ id: 'store', status: 'ok', message: `SESSION_STORE ${MASKED} answers; its session tables are made when the server first starts (version 1)` });
          expect((await db.query("SELECT to_regclass('dw_calls')::text AS t")).rows).toEqual([{ t: null }]);
        } finally {
          await db.close();
        }
      });

      it('fails tables at another version, with what to do', async () => {
        const dir = tempDir();
        const db = await PGlite.create();
        try {
          await ensureSchema(pgliteSql(db));
          await db.query('UPDATE dw_schema SET version = 2');
          const r = byId(await runDoctor({ env: { ...goodEnv(dir), SESSION_STORE: URL_WITH_PASSWORD }, cwd: dir }, { ...deps(), ...pg(db) }), 'store');
          expect(r).toEqual({
            id: 'store', status: 'fail', message: `SESSION_STORE ${MASKED}: its session tables are version 2, and this server reads 1`,
            fix: 'run the newer server, or point SESSION_STORE at another database',
          });
        } finally {
          await db.close();
        }
      });

      it('fails a database that does not answer, with the driver\'s reason and its password taken out', async () => {
        const dir = tempDir();
        const r = byId(await runDoctor({ env: { ...goodEnv(dir), SESSION_STORE: URL_WITH_PASSWORD }, cwd: dir }, {
          ...deps(),
          postgres: async () => ({
            query: async () => { throw new Error(`password authentication failed for ${URL_WITH_PASSWORD}`); },
            transaction: async () => { throw new Error('unused'); },
            close: async () => {},
          }),
        }), 'store');
        expect(r).toEqual({
          id: 'store', status: 'fail', message: `SESSION_STORE ${MASKED} cannot be reached: password authentication failed for ${MASKED}`,
          fix: "check the host, the port, the database, the user and the password in SESSION_STORE, and that this machine may connect to it (the database's allowed hosts, a firewall)",
        });
      });

      it('fails when the pg package is not installed, naming the command that adds it', async () => {
        const dir = tempDir();
        const r = byId(await runDoctor({ env: { ...goodEnv(dir), SESSION_STORE: URL_WITH_PASSWORD }, cwd: dir }, { ...deps(), postgres: async () => { throw new PgUnavailableError(new Error("Cannot find package 'pg'")); } }), 'store');
        expect(r).toEqual({ id: 'store', status: 'fail', message: `SESSION_STORE ${MASKED}: the pg package is not installed here`, fix: 'pnpm add pg (or npm install pg) in the project' });
      });

      it('asks nothing with --offline', async () => {
        const dir = tempDir();
        const p = { asked: [] as string[], postgres: async (url: string) => { p.asked.push(url); throw new Error('asked'); } };
        const r = byId(await runDoctor({ env: { ...goodEnv(dir), SESSION_STORE: URL_WITH_PASSWORD }, cwd: dir, offline: true }, { ...deps(), ...p }), 'store');
        expect(r).toEqual({ id: 'store', status: 'skip', message: `SESSION_STORE ${MASKED}: not asked (--offline)` });
        expect(p.asked).toEqual([]);
      });
    });

    it('says the retention policy: none set, everything kept; set, what goes and when, and where the log rolls', async () => {
      const dir = tempDir();
      expect(byId(await runDoctor({ env: goodEnv(dir), cwd: dir }, deps()), 'retention')).toEqual({
        id: 'retention', status: 'ok',
        message: "traces kept for ever; the audit kept for ever (a record: AUDIT_RETENTION_DAYS only for how long it must be kept); no free-space warning; the server's log where its service manager puts it (no LOG_FILE)",
      });
      const set = byId(await runDoctor({ env: { ...goodEnv(dir), TRACE_RETENTION_DAYS: '30', TRACE_MAX_GB: '5', DISK_WARN_FREE_GB: '2', LOG_FILE: join(dir, 'server.log'), LOG_MAX_MB: '10', LOG_KEEP: '5' }, cwd: dir }, deps()), 'retention');
      expect(set.message).toBe(`traces kept 30 days and at most 5 GB; the audit kept for ever (a record: AUDIT_RETENTION_DAYS only for how long it must be kept); /health warns under 2 GB free; the server's log in ${join(dir, 'server.log')}, rolled at 10 MB, 5 kept`);
    });

    describe('with AUDIT_STORE=postgres://... (check 11)', () => {
      const URL_WITH_PASSWORD = 'postgres://audit:s3cret-pw@db.example:5432/records';
      const MASKED = 'postgres://audit:***@db.example:5432/records';

      it('passes a database at this version where an entry can be written, writing nothing; says one not made yet; never the password', async () => {
        const dir = tempDir();
        const db = await PGlite.create();
        try {
          const postgres = async (): Promise<SqlClient> => pgliteSql(db);
          const fresh = byId(await runDoctor({ env: { ...goodEnv(dir), AUDIT_STORE: URL_WITH_PASSWORD }, cwd: dir }, { ...deps(), postgres }), 'audit');
          expect(fresh).toEqual({ id: 'audit', status: 'ok', message: `AUDIT_STORE ${MASKED} answers; its audit tables are made when the server first starts (version 2)` });
          await openPostgresAudit(pgliteSql(db));
          const results = await runDoctor({ env: { ...goodEnv(dir), AUDIT_STORE: URL_WITH_PASSWORD }, cwd: dir }, { ...deps(), postgres });
          expect(results.map((r) => r.id)).toEqual(['config', 'reach', 'console', 'carrier', 'model', 'handoff', 'folders', 'audit', 'space', 'retention', 'clock']);
          expect(byId(results, 'audit')).toEqual({ id: 'audit', status: 'ok', message: `AUDIT_STORE ${MASKED} answers, its audit tables are version 2, and an entry can be written (tried in a transaction undone): pnpm audit:verify reads it` });
          expect((await db.query('SELECT * FROM dw_audit_entries')).rows).toEqual([]);
          expect((await db.query('SELECT * FROM dw_audit_anchors')).rows).toEqual([]);
          expect(JSON.stringify(results)).not.toContain('s3cret-pw');
          await db.query("UPDATE dw_schema SET version = 3 WHERE name = 'audit'");
          expect(byId(await runDoctor({ env: { ...goodEnv(dir), AUDIT_STORE: URL_WITH_PASSWORD }, cwd: dir }, { ...deps(), postgres }), 'audit')).toEqual({
            id: 'audit', status: 'fail', message: `AUDIT_STORE ${MASKED}: its audit tables are version 3, and this server reads 2`, fix: 'run the newer server, or point AUDIT_STORE at another database',
          });
          const offline = byId(await runDoctor({ env: { ...goodEnv(dir), AUDIT_STORE: URL_WITH_PASSWORD }, cwd: dir, offline: true }, { ...deps(), postgres: async () => { throw new Error('asked'); } }), 'audit');
          expect(offline).toEqual({ id: 'audit', status: 'skip', message: `AUDIT_STORE ${MASKED}: not asked (--offline)` });
        } finally {
          await db.close();
        }
      });
    });

    describe('with TRACE_STORE=s3://... (check 12)', () => {
      const KEYS = { accessKeyId: 'AKIDDIAGNOSE', secretAccessKey: 'diagnose-secret-never-said' };

      it('writes a test object, reads it back and deletes it; fails a store that refuses, saying why and never a key', async () => {
        const dir = tempDir();
        const s3 = await FakeS3.start({ bucket: 'call-traces', region: 'us-east-1', credentials: KEYS });
        try {
          const env = { ...goodEnv(dir), TRACE_STORE: 's3://call-traces/prod', S3_ENDPOINT: s3.endpoint, S3_ACCESS_KEY_ID: KEYS.accessKeyId, S3_SECRET_ACCESS_KEY: KEYS.secretAccessKey, S3_FORCE_PATH_STYLE: 'on' };
          const ok = byId(await runDoctor({ env, cwd: dir }, deps()), 'traces');
          expect(ok).toEqual({ id: 'traces', status: 'ok', message: `TRACE_STORE s3://call-traces/prod/ at 127.0.0.1:${s3.port} (us-east-1) takes a test object, lists it, gives it back and deletes it: each server writes its calls' segments there` });
          expect(s3.objects.size).toBe(0);
          expect(s3.requests.map((r) => r.method)).toEqual(['PUT', 'GET', 'GET', 'DELETE']);
          expect(s3.requests[0]!.key).toMatch(/^prod\/dw-diagnose-[0-9a-f]{8}\.txt$/);
          const wrong = byId(await runDoctor({ env: { ...env, S3_SECRET_ACCESS_KEY: 'not-the-secret' }, cwd: dir }, deps()), 'traces');
          expect(wrong.status).toBe('fail');
          expect(wrong.message).toMatch(/^TRACE_STORE s3:\/\/call-traces\/prod\/ at 127\.0\.0\.1:\d+ \(us-east-1\): S3 put prod\/dw-diagnose-[0-9a-f]{8}\.txt: 403 SignatureDoesNotMatch$/);
          expect(JSON.stringify(wrong)).not.toContain('not-the-secret');
          expect(JSON.stringify(wrong)).not.toContain(KEYS.accessKeyId);
          const before = s3.requests.length;
          expect(byId(await runDoctor({ env, cwd: dir, offline: true }, deps()), 'traces').status).toBe('skip');
          expect(s3.requests.length).toBe(before);
        } finally {
          await s3.close();
        }
      });
    });

    it('takes the temporary folders this machine has for temporary', async () => {
      const { onTemporaryFilesystem } = await import('./doctor');
      expect(onTemporaryFilesystem(join(tmpdir(), 'x', 'sessions'))).toBe(true);
      expect(onTemporaryFilesystem('/tmp/sessions')).toBe(true);
      expect(onTemporaryFilesystem(join(ROOT, 'apps', 'clinic', 'sessions'))).toBe(false);
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
    expect(out.at(-1)).toBe('11 checks: 10 ok, 1 warn, 0 fail');
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
    expect(root.scripts.diagnose).toBe('tsx packages/dialogwright/src/define/cli.ts diagnose');
  });
});

describe('pnpm diagnose with a host file (host.yaml: several apps on one server)', () => {
  /** Two apps that both name MAIN_LINE, each with its own; the server's settings beside host.yaml. */
  function hosted(serverExtra: Record<string, string> = {}): string {
    const dir = tempDir();
    for (const id of ['one', 'two']) {
      mkdirSync(join(dir, 'apps', id), { recursive: true });
      writeFileSync(join(dir, 'apps', id, 'app.yaml'), `id: ${id}\ntransfer:\n  default: env.MAIN_LINE\n`);
    }
    writeFileSync(join(dir, 'apps', 'one', '.env'), 'MAIN_LINE=+447700900201\n', { mode: 0o600 });
    // An app's .env from before the host, with a server setting in it: not read under a host.
    writeFileSync(join(dir, 'apps', 'two', '.env'), 'MAIN_LINE=sip:desk@pbx.example.com\nTWILIO_AUTH_TOKEN=not-read\n', { mode: 0o600 });
    writeFileSync(join(dir, 'host.yaml'), 'apps: [apps/one, apps/two]\nnumbers:\n  - { number: env.ONE_LINE, app: one }\n');
    writeFileSync(join(dir, '.env'), Object.entries({ ...goodEnv(dir), ONE_LINE: '+447700900301', ...serverExtra }).map(([k, v]) => `${k}=${v}`).join('\n'), { mode: 0o600 });
    return dir;
  }

  it('checks the server, then the numbers, then each app with its own variables, never a value', async () => {
    const dir = hosted();
    const out: string[] = [];
    const code = await main(['--offline'], { out: (l) => out.push(l), env: {}, invokedFrom: dir, root: dir }, deps());
    expect(code).toBe(0);
    expect(out[0]).toBe(`the apps of ${join(dir, 'host.yaml')} (one, two): settings from ${join(dir, '.env')} (offline)`);
    expect(out).toContain("ok    host.yaml's numbers: ONE_LINE (one), each set and its own; any other number reaches one");
    expect(out).toContain("ok    app one: app.yaml's transfer.default reads MAIN_LINE: set, a phone number");
    expect(out).toContain("ok    app two: app.yaml's transfer.default reads MAIN_LINE: set, a SIP address");
    expect(out.find((l) => l.includes('app two:') && l.includes('TWILIO_AUTH_TOKEN'))).toMatch(/^warn  app two: .*sets TWILIO_AUTH_TOKEN, which the app's YAML does not name/);
    expect(out.join('\n')).not.toContain('+447700900201');
    expect(out.join('\n')).not.toContain('not-read');
  });

  it('fails an app variable that only another app sets, and a number unset', async () => {
    const dir = hosted();
    rmSync(join(dir, 'apps', 'one', '.env'));
    writeFileSync(join(dir, '.env'), Object.entries(goodEnv(dir)).map(([k, v]) => `${k}=${v}`).join('\n'), { mode: 0o600 });
    const out: string[] = [];
    expect(await main(['--host', 'host.yaml', '--offline'], { out: (l) => out.push(l), env: {}, invokedFrom: dir, root: dir }, deps())).toBe(1);
    expect(out).toContain("fail  app one: app.yaml's transfer.default reads MAIN_LINE, which is not set: the server will not start  ->  set MAIN_LINE in the settings file");
    expect(out.find((l) => l.startsWith('fail  host.yaml'))).toContain("host.yaml's numbers name ONE_LINE, which is not set");
  });

  it('takes --app for one app as before, and says a host file\'s problems', async () => {
    const dir = hosted();
    writeFileSync(join(dir, 'host.yaml'), 'apps: [apps/one, apps/nowhere]\n');
    const out: string[] = [];
    expect(await main(['--offline'], { out: (l) => out.push(l), env: {}, invokedFrom: dir, root: dir }, deps())).toBe(1);
    expect(out[0]).toMatch(/^fail  .*host\.yaml:1:18  the app folder apps\/nowhere does not exist/);
    expect(await main(['--app', 'one', '--host', 'host.yaml'], { out: (l) => out.push(l), env: {}, invokedFrom: dir, root: dir }, deps())).toBe(2);
  });
});

