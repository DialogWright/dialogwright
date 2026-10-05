import { afterEach, describe, expect, it } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequestHandler, type HttpDeps } from '../http';
import { loadConfig } from '../config';
import { SessionStore } from '../sessions';
import { CallTokens } from '../tokens';
import { FrameLog } from '../frameLog';
import { DashboardBus } from '../dashboard/bus';
import { newSession } from '../../core/session';
import { DEFAULT_THRESHOLDS } from '../../core/thresholds';
import { HeuristicStubClient } from '../../jev/heuristicStub';
import { TraceWriter } from '../../trace/writer';
import { VOICE_RELAY } from '../../channel/caps';
import { useTestkit } from '../../testing/apps';
import type { AuditDraft, AuditEntry } from '../../audit/types';
import type { AppRoute } from '../appRoutes';
import { CODE_TTL_MS, CONSOLE_COOKIE, ConsoleAuth } from './auth';

useTestkit();

const TUNNEL = { host: 'demo.example.net', 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https', 'cf-connecting-ip': '203.0.113.9' };
/**
 * What no page without a session may show: the trace's session id and its caller's number. Each is
 * checked with `not.toContain` against pages that carry random text (the sign-in code is 64 hex
 * characters, the page's script nonce is base64), so neither may be a string those alphabets can
 * make by chance: a short fragment like "CA9" or "0199" turns up in one of them now and then. The
 * id has an underscore, which neither alphabet has, and the number is shown whole.
 */
const SID = 'CA9_probe';
const CALLER = '+15555550199';
const TRACE = { v: 1, sessionId: SID, turnIndex: 0, ts: '2026-09-21T00:00:00.000Z', event: { type: 'setup', from: CALLER, to: '+15550000002' }, decision: { kind: 'prompt', promptId: 'greeting', vars: {}, acks: [] }, slots: {}, form: null, gates: [], frames: [], timing: {}, usage: {} };

let server: Server | null = null;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

interface Rig {
  base: string;
  port: number;
  auth: ConsoleAuth;
  audit: Array<{ callId: string; channel: string } & AuditDraft>;
  clock: { t: number };
  dir: string;
  linkFile: string;
  bus: DashboardBus;
}

/** A server in token mode, with a clock the test moves and an audit it reads. */
async function rig(env: Record<string, string> = {}, routes: AppRoute[] = []): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'console-'));
  const linkFile = join(dir, 'private', 'link.json');
  const config = loadConfig({
    PUBLIC_HOST: 'demo.example.net', TWILIO_AUTH_TOKEN: 'authtok', HANDOFF_NUMBER: '+15551234567', CHAT: 'off',
    TRACE_DIR: dir, CONSOLE_AUTH: 'token', CONSOLE_LINK_FILE: linkFile, ...env,
  });
  const clock = { t: Date.parse('2026-10-04T12:00:00Z') };
  const audit: Rig['audit'] = [];
  const sink = {
    append: (callId: string, channel: string, d: AuditDraft): AuditEntry => {
      audit.push({ callId, channel, ...d });
      return { ...d, callId, channel, seq: audit.length, at: '', prevHash: '', hash: '' };
    },
  };
  const auth = new ConsoleAuth({ settings: config.consoleAuth!, publicHost: config.publicHost, audit: sink, now: () => clock.t, log: () => {} });
  const store = new SessionStore((callSid) => ({
    session: newSession(callSid, 0, VOICE_RELAY),
    opts: { client: new HeuristicStubClient(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-10-04' },
    trace: new TraceWriter(join(dir, `${callSid}.jsonl`)),
    frames: new FrameLog(join(dir, `${callSid}.frames.jsonl`)),
  }), 60_000);
  const bus = new DashboardBus();
  const deps: HttpDeps = { config, store, tokens: new CallTokens(60_000), hints: '', log: () => {}, bus, audit: sink, consoleAuth: auth, routes };
  server = createServer(createRequestHandler(deps));
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  auth.start(port);
  writeFileSync(join(dir, `${SID}.jsonl`), JSON.stringify(TRACE) + '\n');
  return { base: `http://127.0.0.1:${port}`, port, auth, audit, clock, dir, linkFile, bus };
}

interface Answer { status: number; headers: IncomingHttpHeaders; body: string }

/** A raw request, so the test controls every header, `Host` and `Cookie` included. */
function raw(base: string, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Answer> {
  const url = new URL(base + path);
  return new Promise((resolve, reject) => {
    const req = request({ host: url.hostname, port: url.port, path, method, headers }, (res) => {
      let text = '';
      res.on('data', (c: Buffer) => (text += c.toString('utf8')));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** The first bytes of a streamed answer (an event stream never ends on its own). */
function peek(base: string, path: string, headers: Record<string, string> = {}): Promise<Answer> {
  const url = new URL(base + path);
  return new Promise((resolve, reject) => {
    const req = request({ host: url.hostname, port: url.port, path, method: 'GET', headers }, (res) => {
      let text = '';
      const done = (): void => { req.destroy(); resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }); };
      if ((res.statusCode ?? 0) !== 200) { res.on('data', (c: Buffer) => (text += c.toString('utf8'))); res.on('end', done); return; }
      res.once('data', (c: Buffer) => { text += c.toString('utf8'); done(); });
    });
    req.on('error', (e) => (String(e).includes('socket hang up') ? undefined : reject(e)));
    req.end();
  });
}

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

/** Signs in through the tunnel with a fresh link; the cookie as a browser sends it back. */
async function signIn(r: Rig): Promise<string> {
  const { code } = r.auth.mint();
  const res = await raw(r.base, 'POST', '/dashboard/login', { ...TUNNEL, ...FORM, origin: 'https://demo.example.net' }, `code=${code}`);
  expect(res.status).toBe(303);
  return cookieOf(res);
}

function cookieOf(res: Answer): string {
  const set = res.headers['set-cookie']?.[0] ?? '';
  return set.split(';')[0]!;
}

function codeOf(url: string): string {
  return new URL(url).searchParams.get('code')!;
}

describe('CONSOLE_AUTH=token: no session', () => {
  it('sends the page to sign in (302), with no data, through the tunnel and on this machine alike', async () => {
    const r = await rig();
    for (const headers of [TUNNEL, {}]) {
      const res = await raw(r.base, 'GET', '/dashboard', headers);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/dashboard/login');
      expect(res.body).not.toContain(SID);
      const slash = await raw(r.base, 'GET', '/dashboard/', headers);
      expect(slash.status).toBe(302);
    }
  });

  it('answers 401 to the live feed, the trace list, a replay, the boot id and the view module', async () => {
    const r = await rig();
    for (const path of ['/dashboard/events', '/dashboard/traces', `/dashboard/traces/${SID}`, '/dashboard/boot', '/dashboard/view.js']) {
      const res = await raw(r.base, 'GET', path, TUNNEL);
      expect(res.status, path).toBe(401);
      expect(res.body, path).not.toContain(SID);
      expect(res.body, path).not.toContain(CALLER);
    }
    expect(r.audit.filter((e) => e.detail.event === 'replay')).toEqual([]);
  });

  it('serves the sign-in page with no call data, the app\'s or the calls\', and its own headers', async () => {
    const r = await rig();
    const { url } = r.auth.mint();
    const res = await raw(r.base, 'GET', new URL(url).pathname + new URL(url).search, TUNNEL);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('<form method="post" action="/dashboard/login">');
    expect(res.body).toContain(`value="${codeOf(url)}"`);
    for (const absent of [SID, CALLER, 'formSlots', 'EventSource', '/dashboard/traces', '/dashboard/events']) expect(res.body, absent).not.toContain(absent);
    // Opening the link signs nothing in: a link preview fetches it too. Only the form's POST does.
    expect(res.headers['set-cookie']).toBeUndefined();
    const plain = await raw(r.base, 'GET', '/dashboard/login', TUNNEL);
    expect(plain.status).toBe(200);
    expect(plain.body).toContain('pnpm console:link');
    expect(plain.body).not.toContain('<form');
  });
});

describe('CONSOLE_AUTH=token: signing in', () => {
  it('a valid code sets a signed, HttpOnly, Secure, SameSite=Strict cookie on /dashboard and redirects to the console', async () => {
    const r = await rig();
    const { code } = r.auth.mint();
    const res = await raw(r.base, 'POST', '/dashboard/login', { ...TUNNEL, ...FORM, origin: 'null' }, `code=${code}`);
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/dashboard');
    const set = res.headers['set-cookie']![0]!;
    expect(set).toMatch(new RegExp(`^${CONSOLE_COOKIE}=v1\\.[0-9a-f]{32}\\.\\d+\\.[A-Za-z0-9_-]{43}; `));
    for (const attr of ['Path=/dashboard', 'HttpOnly', 'Secure', 'SameSite=Strict', `Max-Age=${12 * 3600}`]) expect(set).toContain(attr);
    const cookie = cookieOf(res);
    const page = await raw(r.base, 'GET', '/dashboard', { ...TUNNEL, cookie });
    expect(page.status).toBe(200);
    expect(page.body).toContain('<script type="module" nonce=');
    const traces = await raw(r.base, 'GET', '/dashboard/traces', { ...TUNNEL, cookie });
    expect(traces.status).toBe(200);
    expect(traces.body).toContain(SID);
  });

  it('refuses a code used once already, one expired, one a newer link replaced, and one never made, alike', async () => {
    const r = await rig();
    const used = r.auth.mint().code;
    await raw(r.base, 'POST', '/dashboard/login', { ...TUNNEL, ...FORM }, `code=${used}`);
    const again = await raw(r.base, 'POST', '/dashboard/login', { ...TUNNEL, ...FORM }, `code=${used}`);
    expect(again.status).toBe(403);
    expect(again.headers['set-cookie']).toBeUndefined();

    const old = r.auth.mint().code;
    r.clock.t += CODE_TTL_MS + 1;
    const expired = await raw(r.base, 'POST', '/dashboard/login', { ...TUNNEL, ...FORM }, `code=${old}`);
    expect(expired.status).toBe(403);

    const replaced = r.auth.mint().code;
    r.auth.mint();
    const rotated = await raw(r.base, 'POST', '/dashboard/login', { ...TUNNEL, ...FORM }, `code=${replaced}`);
    expect(rotated.status).toBe(403);

    const never = await raw(r.base, 'POST', '/dashboard/login', { ...TUNNEL, ...FORM }, `code=${randomBytes(32).toString('hex')}`);
    expect(never.status).toBe(403);
    // The same words for each: a refusal says nothing about why to whoever is guessing.
    const words = (a: Answer) => a.body.replace(/nonce="[^"]+"/g, 'nonce=""');
    expect(new Set([again, expired, rotated, never].map(words)).size).toBe(1);
    const reasons = r.audit.filter((e) => e.detail.event === 'sign_in_refused').map((e) => e.detail.reason);
    expect(reasons).toEqual(['used', 'expired', 'replaced', 'unknown']);
  });

  it('refuses a forged cookie, an expired one, one signed with another key, and one signed out', async () => {
    const r = await rig({ CONSOLE_SESSION_HOURS: '1' });
    const good = await signIn(r);
    const value = good.slice(`${CONSOLE_COOKIE}=`.length);
    const [v, sid, exp, mac] = value.split('.');
    const forged = [
      `${v}.${sid}.${Number(exp) + 3600}.${mac}`,
      `${v}.${randomBytes(16).toString('hex')}.${exp}.${mac}`,
      `${v}.${sid}.${exp}.${createHmac('sha256', randomBytes(32)).update(`${v}.${sid}.${exp}`).digest('base64url')}`,
      `${v}.${sid}.${exp}.`,
      'v1..0.x',
      '',
    ];
    for (const f of forged) {
      expect((await raw(r.base, 'GET', '/dashboard/traces', { ...TUNNEL, cookie: `${CONSOLE_COOKIE}=${f}` })).status, f).toBe(401);
      expect((await raw(r.base, 'GET', '/dashboard', { ...TUNNEL, cookie: `${CONSOLE_COOKIE}=${f}` })).status, f).toBe(302);
    }
    expect((await raw(r.base, 'GET', '/dashboard/traces', { ...TUNNEL, cookie: good })).status).toBe(200);
    r.clock.t += 3600 * 1000 + 1;
    expect((await raw(r.base, 'GET', '/dashboard/traces', { ...TUNNEL, cookie: good })).status).toBe(401);
  });

  it('signs out: the cookie is cleared and the session refused from then on, even if a browser keeps it', async () => {
    const r = await rig();
    const cookie = await signIn(r);
    const out = await raw(r.base, 'POST', '/dashboard/logout', { ...TUNNEL, cookie, origin: 'https://demo.example.net' });
    expect(out.status).toBe(303);
    expect(out.headers.location).toBe('/dashboard/login?out=1');
    expect(out.headers['set-cookie']![0]).toMatch(new RegExp(`^${CONSOLE_COOKIE}=; .*Max-Age=0`));
    expect((await raw(r.base, 'GET', '/dashboard/traces', { ...TUNNEL, cookie })).status).toBe(401);
    expect(r.audit.at(-1)).toMatchObject({ callId: 'console', channel: 'console', type: 'console_access', detail: { event: 'sign_out' } });
    // A page on another site cannot post it.
    const other = await signIn(r);
    expect((await raw(r.base, 'POST', '/dashboard/logout', { ...TUNNEL, cookie: other, origin: 'https://elsewhere.example.org' })).status).toBe(403);
    expect((await raw(r.base, 'GET', '/dashboard/traces', { ...TUNNEL, cookie: other })).status).toBe(200);
  });

  it('a session survives a restart with CONSOLE_SESSION_KEY, and not without it', async () => {
    const key = randomBytes(32).toString('hex');
    const r = await rig({ CONSOLE_SESSION_KEY: key });
    const cookie = await signIn(r);
    const config = loadConfig({ PUBLIC_HOST: 'demo.example.net', TWILIO_AUTH_TOKEN: 'authtok', HANDOFF_NUMBER: '+15551234567', CONSOLE_AUTH: 'token', CONSOLE_SESSION_KEY: key, CONSOLE_LINK_FILE: r.linkFile });
    const fakeReq = (c: string) => ({ headers: { cookie: c }, socket: { remoteAddress: '127.0.0.1' } }) as never;
    const restarted = new ConsoleAuth({ settings: config.consoleAuth!, publicHost: 'demo.example.net', now: () => r.clock.t });
    expect(restarted.sessionOf(fakeReq(cookie))).not.toBeNull();
    const noKey = loadConfig({ PUBLIC_HOST: 'demo.example.net', TWILIO_AUTH_TOKEN: 'authtok', HANDOFF_NUMBER: '+15551234567', CONSOLE_AUTH: 'token', CONSOLE_LINK_FILE: r.linkFile });
    expect(new ConsoleAuth({ settings: noKey.consoleAuth!, publicHost: 'demo.example.net', now: () => r.clock.t }).sessionOf(fakeReq(cookie))).toBeNull();
  });

  it('leaves Secure off only on a laptop (PUBLIC_HOST=localhost) for a plain http request on this machine', async () => {
    const r = await rig({ PUBLIC_HOST: 'localhost' });
    const { code } = r.auth.mint();
    const res = await raw(r.base, 'POST', '/dashboard/login', { host: `localhost:${r.port}`, ...FORM }, `code=${code}`);
    expect(res.status).toBe(303);
    expect(res.headers['set-cookie']![0]).not.toContain('Secure');
    expect(res.headers['set-cookie']![0]).toContain('HttpOnly');
  });

  it('rate-limits failed attempts per address, then for everyone through the tunnel, and audits a lock once', async () => {
    const r = await rig();
    const wrong = () => randomBytes(32).toString('hex');
    for (let i = 0; i < 10; i++) expect((await raw(r.base, 'POST', '/dashboard/login', { ...TUNNEL, ...FORM }, `code=${wrong()}`)).status).toBe(403);
    // The eleventh from that address is refused before its code is looked at: a valid code too.
    const { code } = r.auth.mint();
    const limited = await raw(r.base, 'POST', '/dashboard/login', { ...TUNNEL, ...FORM }, `code=${code}`);
    expect(limited.status).toBe(429);
    expect((await raw(r.base, 'POST', '/dashboard/login', { ...TUNNEL, ...FORM }, `code=${wrong()}`)).status).toBe(429);
    const locks = r.audit.filter((e) => e.detail.reason === 'rate_limited');
    expect(locks).toHaveLength(1);
    expect(locks[0]!.detail).toMatchObject({ event: 'sign_in_refused', from: '203.0.113.9' });
    // Another address still signs in with the code, which the refusals did not use up.
    const elsewhere = { ...TUNNEL, 'cf-connecting-ip': '198.51.100.7', 'x-forwarded-for': '198.51.100.7' };
    expect((await raw(r.base, 'POST', '/dashboard/login', { ...elsewhere, ...FORM }, `code=${code}`)).status).toBe(303);
    // An address a client writes first in x-forwarded-for is its own say: the tunnel's last entry counts.
    const spoofed = { host: 'demo.example.net', 'x-forwarded-for': '192.0.2.50, 203.0.113.9' };
    expect((await raw(r.base, 'POST', '/dashboard/login', { ...spoofed, ...FORM }, `code=${wrong()}`)).status).toBe(429);
    // A quarter of an hour later, the address may try again.
    r.clock.t += 15 * 60 * 1000 + 1;
    expect((await raw(r.base, 'POST', '/dashboard/login', { ...TUNNEL, ...FORM }, `code=${wrong()}`)).status).toBe(403);
  });

  it('locks the tunnel for everyone after 100 failures in a quarter of an hour, but not this machine\'s own screen', async () => {
    const r = await rig();
    for (let i = 0; i < 100; i++) {
      const from = `198.51.100.${i % 50}`;
      await raw(r.base, 'POST', '/dashboard/login', { ...TUNNEL, 'cf-connecting-ip': from, 'x-forwarded-for': from, ...FORM }, `code=${randomBytes(32).toString('hex')}`);
    }
    const { code } = r.auth.mint();
    const fresh = { ...TUNNEL, 'cf-connecting-ip': '192.0.2.1', 'x-forwarded-for': '192.0.2.1' };
    expect((await raw(r.base, 'POST', '/dashboard/login', { ...fresh, ...FORM }, `code=${code}`)).status).toBe(429);
    expect((await raw(r.base, 'POST', '/dashboard/login', { ...FORM }, `code=${code}`)).status).toBe(303);
  });

  it('refuses a sign-in posted from another site\'s page, and a body that is not a form', async () => {
    const r = await rig();
    const { code } = r.auth.mint();
    expect((await raw(r.base, 'POST', '/dashboard/login', { ...TUNNEL, ...FORM, origin: 'https://elsewhere.example.org' }, `code=${code}`)).status).toBe(403);
    expect((await raw(r.base, 'POST', '/dashboard/login', { ...TUNNEL, 'content-type': 'application/json' }, JSON.stringify({ code }))).status).toBe(415);
    // Neither used the code up.
    expect((await raw(r.base, 'POST', '/dashboard/login', { ...TUNNEL, ...FORM }, `code=${code}`)).status).toBe(303);
  });
});

describe('CONSOLE_AUTH=token: which address a request comes from (CONSOLE_CLIENT_ADDRESS)', () => {
  /** The address the audit names for a refused sign-in sent with `headers` (each through a tunnel's Host). */
  async function fromOf(r: Rig, headers: Record<string, string>): Promise<unknown> {
    await raw(r.base, 'POST', '/dashboard/login', { host: 'demo.example.net', ...headers, ...FORM }, `code=${randomBytes(32).toString('hex')}`);
    return r.audit.at(-1)!.detail.from;
  }
  const both = { 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '192.0.2.50, 198.51.100.7' };
  const xffOnly = { 'x-forwarded-for': '192.0.2.50, 198.51.100.7' };
  const cfOnly = { 'cf-connecting-ip': '203.0.113.9' };

  it('auto (the default): cf-connecting-ip, else the last x-forwarded-for entry, else the socket', async () => {
    const r = await rig();
    expect(await fromOf(r, both)).toBe('203.0.113.9');
    expect(await fromOf(r, xffOnly)).toBe('198.51.100.7');
    expect(await fromOf(r, {})).toBe('127.0.0.1');
  });

  it('cf-connecting-ip: only Cloudflare\'s header; x-forwarded-for is not read, and without the header it is the socket', async () => {
    const r = await rig({ CONSOLE_CLIENT_ADDRESS: 'cf-connecting-ip' });
    expect(await fromOf(r, both)).toBe('203.0.113.9');
    expect(await fromOf(r, xffOnly)).toBe('127.0.0.1');
  });

  it('x-forwarded-for: the last entry; a cf-connecting-ip a client sent through another tunnel is not read', async () => {
    const r = await rig({ CONSOLE_CLIENT_ADDRESS: 'x-forwarded-for' });
    expect(await fromOf(r, both)).toBe('198.51.100.7');
    expect(await fromOf(r, cfOnly)).toBe('127.0.0.1');
    // So rotating a made-up cf-connecting-ip does not dodge one address's limit.
    for (let i = 0; i < 10; i++) await fromOf(r, { ...xffOnly, 'cf-connecting-ip': `192.0.2.${i}` });
    const { code } = r.auth.mint();
    expect((await raw(r.base, 'POST', '/dashboard/login', { host: 'demo.example.net', ...xffOnly, 'cf-connecting-ip': '192.0.2.99', ...FORM }, `code=${code}`)).status).toBe(429);
  });

  it('remote: the socket\'s address alone, whatever the headers say', async () => {
    const r = await rig({ CONSOLE_CLIENT_ADDRESS: 'remote' });
    expect(await fromOf(r, both)).toBe('127.0.0.1');
    expect(await fromOf(r, xffOnly)).toBe('127.0.0.1');
  });
});

describe('CONSOLE_AUTH=token: the headers', () => {
  it('every console answer carries the CSP, frame, referrer, cache and type headers, signed in or not', async () => {
    const r = await rig();
    const cookie = await signIn(r);
    const answers = [
      await raw(r.base, 'GET', '/dashboard', TUNNEL),
      await raw(r.base, 'GET', '/dashboard/login', TUNNEL),
      await raw(r.base, 'GET', '/dashboard/traces', TUNNEL),
      await raw(r.base, 'GET', '/dashboard/nothing-here', { ...TUNNEL, cookie }),
      await raw(r.base, 'GET', '/dashboard', { ...TUNNEL, cookie }),
      await raw(r.base, 'GET', '/dashboard/view.js', { ...TUNNEL, cookie }),
      await raw(r.base, 'GET', `/dashboard/traces/${SID}`, { ...TUNNEL, cookie }),
      await raw(r.base, 'POST', '/dashboard/link', TUNNEL),
      await peek(r.base, '/dashboard/events', { ...TUNNEL, cookie }),
    ];
    for (const a of answers) {
      expect(a.headers['content-security-policy'], String(a.status)).toMatch(/default-src 'none'.*frame-ancestors 'none'/);
      expect(a.headers['x-frame-options']).toBe('DENY');
      expect(a.headers['referrer-policy']).toBe('no-referrer');
      expect(a.headers['cache-control']).toBe('no-store');
      expect(a.headers['x-content-type-options']).toBe('nosniff');
    }
    // The page's own script and style run by a nonce the policy names; nothing inline runs without it.
    const page = answers[4]!;
    const nonce = /<script type="module" nonce="([^"]+)">/.exec(page.body)![1]!;
    expect(page.body).toContain(`<style nonce="${nonce}">`);
    expect(page.headers['content-security-policy']).toContain(`script-src 'self' 'nonce-${nonce}'`);
    expect(page.headers['content-security-policy']).toContain("connect-src 'self'");
    // And it can sign out.
    expect(page.body).toContain('<form method="post" action="/dashboard/logout"');
  });
});

describe('CONSOLE_AUTH=token: the access log', () => {
  it('appends a sign-in, the live feed\'s first open per session, and every replay of a stored call, never the cookie or the code', async () => {
    const r = await rig();
    const { code } = r.auth.mint();
    const signed = await raw(r.base, 'POST', '/dashboard/login', { ...TUNNEL, ...FORM }, `code=${code}`);
    const cookie = cookieOf(signed);
    await peek(r.base, '/dashboard/events', { ...TUNNEL, cookie });
    await peek(r.base, '/dashboard/events', { ...TUNNEL, cookie });
    await raw(r.base, 'GET', `/dashboard/traces/${SID}`, { ...TUNNEL, cookie });
    await raw(r.base, 'GET', `/dashboard/traces/${SID}`, { ...TUNNEL, cookie });
    // A HEAD reads nothing, and a missing trace is no replay.
    await raw(r.base, 'HEAD', `/dashboard/traces/${SID}`, { ...TUNNEL, cookie });
    await raw(r.base, 'GET', '/dashboard/traces/CA404', { ...TUNNEL, cookie });
    const access = r.audit.filter((e) => e.type === 'console_access' && e.detail.event !== 'link_made');
    expect(access.map((e) => [e.callId, e.detail.event])).toEqual([
      ['console', 'sign_in'],
      ['console', 'live'],
      [SID, 'replay'],
      [SID, 'replay'],
    ]);
    const session = access[0]!.detail.session as string;
    expect(session).toMatch(/^[0-9a-f]{16}$/);
    for (const e of access) {
      expect(e.channel).toBe('console');
      expect(e.detail.session).toBe(session);
    }
    expect(access[0]!.detail).toMatchObject({ from: '203.0.113.9', via: 'tunnel', code: expect.stringMatching(/^[0-9a-f]{8}$/) });
    const written = JSON.stringify(r.audit);
    expect(written).not.toContain(code);
    expect(written).not.toContain(cookie.slice(`${CONSOLE_COOKIE}=`.length));
    expect(written).not.toContain(cookie.split('.')[1]!);
  });
});

describe('CONSOLE_AUTH=token: the link file and pnpm console:link\'s endpoint', () => {
  it('writes the current link where only its owner can read it, and marks it used once it is', async () => {
    if (process.platform === 'win32') return;
    const r = await rig();
    const { statSync } = await import('node:fs');
    expect(statSync(r.linkFile).mode & 0o777).toBe(0o600);
    expect(statSync(join(r.dir, 'private')).mode & 0o777).toBe(0o700);
    const file = JSON.parse(readFileSync(r.linkFile, 'utf8')) as { url: string; port: number; key: string };
    expect(file.url).toMatch(/^https:\/\/demo\.example\.net\/dashboard\/login\?code=[0-9a-f]{64}$/);
    expect(file.port).toBe(r.port);
    await raw(r.base, 'POST', '/dashboard/login', { ...TUNNEL, ...FORM }, `code=${codeOf(file.url)}`);
    expect((JSON.parse(readFileSync(r.linkFile, 'utf8')) as { url: string | null }).url).toBeNull();
  });

  it('mints a new link for this machine with the file\'s key, and the one before it stops working', async () => {
    const r = await rig();
    const file = JSON.parse(readFileSync(r.linkFile, 'utf8')) as { url: string; key: string };
    const res = await raw(r.base, 'POST', '/dashboard/link', { 'x-console-key': file.key });
    expect(res.status).toBe(200);
    const made = JSON.parse(res.body) as { url: string; expiresAt: string };
    expect(made.url).not.toBe(file.url);
    expect((JSON.parse(readFileSync(r.linkFile, 'utf8')) as { url: string }).url).toBe(made.url);
    expect((await raw(r.base, 'POST', '/dashboard/login', { ...TUNNEL, ...FORM }, `code=${codeOf(file.url)}`)).status).toBe(403);
    expect((await raw(r.base, 'POST', '/dashboard/login', { ...TUNNEL, ...FORM }, `code=${codeOf(made.url)}`)).status).toBe(303);
  });

  it('never mints through the tunnel, without the key, or for a browser page, even with the key', async () => {
    const r = await rig();
    const { key } = JSON.parse(readFileSync(r.linkFile, 'utf8')) as { key: string };
    const before = readFileSync(r.linkFile, 'utf8');
    expect((await raw(r.base, 'POST', '/dashboard/link', { ...TUNNEL, 'x-console-key': key })).status).toBe(404);
    expect((await raw(r.base, 'POST', '/dashboard/link', { host: 'demo.example.net', 'x-console-key': key })).status).toBe(404);
    expect((await raw(r.base, 'POST', '/dashboard/link', {})).status).toBe(403);
    expect((await raw(r.base, 'POST', '/dashboard/link', { 'x-console-key': randomBytes(32).toString('hex') })).status).toBe(403);
    expect((await raw(r.base, 'POST', '/dashboard/link', { 'x-console-key': key, origin: 'http://127.0.0.1' })).status).toBe(403);
    expect((await raw(r.base, 'GET', '/dashboard/link', { 'x-console-key': key })).status).toBe(405);
    expect(readFileSync(r.linkFile, 'utf8')).toBe(before);
  });
});

describe('CONSOLE_AUTH=token: an app\'s local-only pages', () => {
  it('stay local only: the console\'s sign-in does not open them through the tunnel', async () => {
    const chat: AppRoute = { label: 'chat', path: '/chat', localOnly: true, handle: async (_req, res) => { res.writeHead(200); res.end('chat'); return true; } };
    const r = await rig({}, [chat]);
    const cookie = await signIn(r);
    expect((await raw(r.base, 'GET', '/chat', { ...TUNNEL, cookie })).status).toBe(404);
    expect((await raw(r.base, 'GET', '/chat')).body).toBe('chat');
  });
});

/** An event stream read until the server ends it, or `ms` pass (then the test's own end). */
function stream(base: string, path: string, headers: Record<string, string>): { text: () => string; ended: Promise<boolean>; opened: Promise<void>; stop: () => void } {
  const url = new URL(base + path);
  let text = '';
  let opened!: () => void;
  const openedP = new Promise<void>((r) => (opened = r));
  let finish!: (byServer: boolean) => void;
  const ended = new Promise<boolean>((r) => (finish = r));
  const req = request({ host: url.hostname, port: url.port, path, method: 'GET', headers }, (res) => {
    res.on('data', (c: Buffer) => { text += c.toString('utf8'); opened(); });
    res.on('end', () => finish(true));
    res.on('error', () => finish(true));
  });
  req.on('error', () => finish(false));
  req.end();
  return { text: () => text, ended, opened: openedP, stop: () => { req.destroy(); finish(false); } };
}

const CALL = { type: 'call_started', callSid: 'CA-REVIEW-7', from: '+15555550123', todayIso: '2026-10-04', thresholds: {} } as const;

describe('CONSOLE_AUTH=token: what a session no longer signed in is sent', () => {
  it('ends an open live feed once its session signs out, before the next event is sent', async () => {
    const r = await rig();
    const cookie = await signIn(r);
    const feed = stream(r.base, '/dashboard/events', { ...TUNNEL, cookie });
    await feed.opened;
    expect((await raw(r.base, 'POST', '/dashboard/logout', { ...TUNNEL, cookie, origin: 'https://demo.example.net' })).status).toBe(303);
    r.bus.publish(CALL as never);
    const byServer = await Promise.race([feed.ended, new Promise<boolean>((res) => setTimeout(() => res(false), 2000))]);
    feed.stop();
    expect(byServer).toBe(true);
    expect(feed.text()).not.toContain('CA-REVIEW-7');
  });

  it('ends an open live feed once its session expires', async () => {
    const r = await rig({ CONSOLE_SESSION_HOURS: '1' });
    const cookie = await signIn(r);
    const feed = stream(r.base, '/dashboard/events', { ...TUNNEL, cookie });
    await feed.opened;
    r.clock.t += 3600 * 1000 + 1;
    r.bus.publish(CALL as never);
    const byServer = await Promise.race([feed.ended, new Promise<boolean>((res) => setTimeout(() => res(false), 2000))]);
    feed.stop();
    expect(byServer).toBe(true);
    expect(feed.text()).not.toContain('CA-REVIEW-7');
  });
});

describe('CONSOLE_AUTH=token: sign-in hardening', () => {
  it('holds parallel attempts from one address to its limit: the count is checked again once each form is read', async () => {
    const r = await rig();
    const wrong = () => randomBytes(32).toString('hex');
    // Every request's headers first, then (once all fifteen wait on their forms) every body.
    const url = new URL(r.base);
    const sent = Array.from({ length: 15 }, () => {
      let status!: Promise<number>;
      const req = request({ host: url.hostname, port: url.port, path: '/dashboard/login', method: 'POST', headers: { ...TUNNEL, ...FORM } });
      status = new Promise((resolve, reject) => {
        req.on('response', (res) => { res.resume(); resolve(res.statusCode ?? 0); });
        req.on('error', reject);
      });
      req.flushHeaders();
      return { req, status };
    });
    await new Promise((res) => setTimeout(res, 100));
    for (const { req } of sent) req.end(`code=${wrong()}`);
    const statuses = await Promise.all(sent.map((s) => s.status));
    expect(statuses.filter((s) => s === 403)).toHaveLength(10);
    expect(statuses.filter((s) => s === 429)).toHaveLength(5);
  });

  it('refuses a form a browser says came from another site, even with Origin null (a page under no-referrer)', async () => {
    const r = await rig();
    const { code } = r.auth.mint();
    for (const site of ['cross-site', 'same-site']) {
      expect((await raw(r.base, 'POST', '/dashboard/login', { ...TUNNEL, ...FORM, origin: 'null', 'sec-fetch-site': site }, `code=${code}`)).status, site).toBe(403);
    }
    // The console's own page: Origin null under its no-referrer policy, and same-origin.
    expect((await raw(r.base, 'POST', '/dashboard/login', { ...TUNNEL, ...FORM, origin: 'null', 'sec-fetch-site': 'same-origin' }, `code=${code}`)).status).toBe(303);
    const cookie = await signIn(r);
    expect((await raw(r.base, 'POST', '/dashboard/logout', { ...TUNNEL, cookie, origin: 'null', 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await raw(r.base, 'GET', '/dashboard/traces', { ...TUNNEL, cookie })).status).toBe(200);
  });

  it('answers a form too large with 413, which the client receives', async () => {
    const r = await rig();
    const res = await raw(r.base, 'POST', '/dashboard/login', { ...TUNNEL, ...FORM }, `code=${'a'.repeat(8192)}`);
    expect(res.status).toBe(413);
  });

  it('refuses a cookie whose expiry is further off than CONSOLE_SESSION_HOURS allows (the hours were lowered)', async () => {
    const key = randomBytes(32).toString('hex');
    const r = await rig({ CONSOLE_SESSION_KEY: key, CONSOLE_SESSION_HOURS: '24' });
    const cookie = await signIn(r);
    const fakeReq = (c: string) => ({ headers: { cookie: c }, socket: { remoteAddress: '127.0.0.1' } }) as never;
    const env = { PUBLIC_HOST: 'demo.example.net', TWILIO_AUTH_TOKEN: 'authtok', HANDOFF_NUMBER: '+15551234567', CONSOLE_AUTH: 'token', CONSOLE_SESSION_KEY: key, CONSOLE_LINK_FILE: r.linkFile };
    const same = new ConsoleAuth({ settings: loadConfig({ ...env, CONSOLE_SESSION_HOURS: '24' }).consoleAuth!, publicHost: 'demo.example.net', now: () => r.clock.t });
    expect(same.sessionOf(fakeReq(cookie))).not.toBeNull();
    const lowered = new ConsoleAuth({ settings: loadConfig({ ...env, CONSOLE_SESSION_HOURS: '2' }).consoleAuth!, publicHost: 'demo.example.net', now: () => r.clock.t });
    expect(lowered.sessionOf(fakeReq(cookie))).toBeNull();
  });
});

describe('CONSOLE_AUTH=token: sign-outs kept across a restart (CONSOLE_SESSION_KEY)', () => {
  const env = (r: Rig, key: string) => ({ PUBLIC_HOST: 'demo.example.net', TWILIO_AUTH_TOKEN: 'authtok', HANDOFF_NUMBER: '+15551234567', CONSOLE_AUTH: 'token', CONSOLE_SESSION_KEY: key, CONSOLE_LINK_FILE: r.linkFile });
  const fakeReq = (c: string) => ({ headers: { cookie: c }, socket: { remoteAddress: '127.0.0.1' } }) as never;

  it('a signed-out cookie stays refused after a restart; one still signed in is not', async () => {
    const key = randomBytes(32).toString('hex');
    const r = await rig({ CONSOLE_SESSION_KEY: key });
    const out = await signIn(r);
    const kept = await signIn(r);
    expect((await raw(r.base, 'POST', '/dashboard/logout', { ...TUNNEL, cookie: out, origin: 'https://demo.example.net' })).status).toBe(303);
    const restarted = new ConsoleAuth({ settings: loadConfig(env(r, key)).consoleAuth!, publicHost: 'demo.example.net', now: () => r.clock.t });
    expect(restarted.sessionOf(fakeReq(out))).toBeNull();
    expect(restarted.sessionOf(fakeReq(kept))).not.toBeNull();
  });

  it('keeps them beside the link file, owner-only, as hashes with their expiry, never a session id or the cookie; expired ones are dropped', async () => {
    const key = randomBytes(32).toString('hex');
    const r = await rig({ CONSOLE_SESSION_KEY: key, CONSOLE_SESSION_HOURS: '1' });
    const first = await signIn(r);
    await raw(r.base, 'POST', '/dashboard/logout', { ...TUNNEL, cookie: first, origin: 'https://demo.example.net' });
    const file = join(r.dir, 'private', 'signed-out.json');
    if (process.platform !== 'win32') {
      const { statSync } = await import('node:fs');
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    const text = readFileSync(file, 'utf8');
    const id = first.split('.')[1]!;
    expect(text).not.toContain(id);
    expect(text).not.toContain(first.slice(`${CONSOLE_COOKIE}=`.length));
    const held = JSON.parse(text) as { v: number; sessions: Array<{ hash: string; expiresAt: string }> };
    expect(held.v).toBe(1);
    expect(held.sessions).toHaveLength(1);
    expect(held.sessions[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
    // An hour on, the first has expired: the next sign-out's write leaves it out.
    r.clock.t += 3600 * 1000 + 1;
    const second = await signIn(r);
    await raw(r.base, 'POST', '/dashboard/logout', { ...TUNNEL, cookie: second, origin: 'https://demo.example.net' });
    const after = JSON.parse(readFileSync(file, 'utf8')) as typeof held;
    expect(after.sessions).toHaveLength(1);
    expect(after.sessions[0]!.hash).not.toBe(held.sessions[0]!.hash);
  });

  it('writes nothing without CONSOLE_SESSION_KEY, where a restart signs everyone out anyway', async () => {
    const r = await rig();
    const cookie = await signIn(r);
    await raw(r.base, 'POST', '/dashboard/logout', { ...TUNNEL, cookie, origin: 'https://demo.example.net' });
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(r.dir, 'private', 'signed-out.json'))).toBe(false);
  });

  it('refuses to start from a sign-out file that is not one, or that others may write', async () => {
    const key = randomBytes(32).toString('hex');
    const r = await rig({ CONSOLE_SESSION_KEY: key });
    const file = join(r.dir, 'private', 'signed-out.json');
    const make = () => new ConsoleAuth({ settings: loadConfig(env(r, key)).consoleAuth!, publicHost: 'demo.example.net', now: () => r.clock.t });
    writeFileSync(file, 'not json', { mode: 0o600 });
    expect(make).toThrow(`${file} is not a sign-out file the server wrote`);
    if (process.platform === 'win32') return;
    const { chmodSync } = await import('node:fs');
    writeFileSync(file, JSON.stringify({ v: 1, sessions: [] }));
    chmodSync(file, 0o666);
    expect(make).toThrow(`${file} can be written by others`);
  });
});

describe('writeOwnerOnly', () => {
  it('leaves no temporary file behind when the write fails', async () => {
    const { mkdirSync, readdirSync } = await import('node:fs');
    const { writeOwnerOnly } = await import('./auth');
    const dir = mkdtempSync(join(tmpdir(), 'owner-only-'));
    const folder = join(dir, '.console-link');
    // A folder where the file should be: the rename fails.
    mkdirSync(join(folder, 'link.json'), { recursive: true, mode: 0o700 });
    expect(() => writeOwnerOnly(join(folder, 'link.json'), '{}')).toThrow();
    expect(readdirSync(folder)).toEqual(['link.json']);
  });
});
