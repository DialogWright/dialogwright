import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type RunningServer } from 'dialogwright';
import { loadConfig } from 'dialogwright/server/config';
import { jwksKeys } from 'dialogwright/server/chat/jwks';
import { principalForToken } from 'dialogwright/server/chat/signin';
import { app } from './app';
import { BROKERS, MEMBERS } from './data';
import { registerThisApp } from './index';
import { JWKS_PATH, PORTAL_AUDIENCE, PORTAL_ISSUER, TOKEN_TTL_SEC, claimsFor, personOf } from './portal';

/**
 * The demo portal on a server of Harbor alone: off by default (every path a 404), and when on, its
 * sign-in page, its session, its chat pages and its tokens, each token checked by the engine's own
 * chat sign-in against the keys the portal publishes.
 */

beforeAll(() => registerThisApp());

const PUBLIC = 'harbor.example.com';
const JWKS_URL = `https://${PUBLIC}/harbor${JWKS_PATH}`;
const dirs: string[] = [];
let running: RunningServer | null = null;
afterEach(async () => {
  await running?.close();
  running = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const CHAT_SETTINGS = {
  CHAT: 'on', CHAT_ALLOWED_ORIGINS: `https://${PUBLIC}`, CHAT_SIGNIN: 'jwt', CHAT_JWKS_URL: JWKS_URL, CHAT_ISSUER: PORTAL_ISSUER, CHAT_AUDIENCE: PORTAL_AUDIENCE,
};

async function serve(extra: Record<string, string>): Promise<{ base: string; logs: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'harbor-portal-'));
  dirs.push(dir);
  const widget = join(dir, 'dialogwright-widget.js');
  writeFileSync(widget, '/* the widget */');
  const env = {
    PUBLIC_HOST: PUBLIC, TWILIO_AUTH_TOKEN: 't', HANDOFF_NUMBER: '+15555550100', PORT: '0', TODAY_OVERRIDE: '2026-10-16',
    TRACE_DIR: join(dir, 'traces'), AUDIT_DIR: join(dir, 'audit'), AUDIO_DIR: dir, DASHBOARD: 'off', JEV_CLIENT: 'stub', WIDGET_FILE: widget,
    ...extra,
  };
  const logs: string[] = [];
  running = await startServer(loadConfig(env), { host: '127.0.0.1', env, log: (l) => logs.push(l) });
  return { base: `http://127.0.0.1:${running.port}`, logs };
}

const PATHS = ['/harbor/portal', '/harbor/portal/jwks.json', '/harbor/portal/chat', '/harbor/portal/assets/harbor-mutual-emblem.svg'];

/** Signs in as `person` (member:<id> or broker:<id>): the session cookie the portal set. */
async function signIn(base: string, person: string): Promise<string> {
  const res = await fetch(`${base}/harbor/portal/sign-in`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ person }).toString() });
  expect(res.status).toBe(303);
  expect(res.headers.get('location')).toBe('/harbor/portal/chat');
  const cookie = res.headers.get('set-cookie')!;
  expect(cookie).toMatch(/^harbor_portal=[0-9a-f]{64}; Path=\/harbor\/portal; HttpOnly; SameSite=Lax; Max-Age=3600$/);
  return cookie.split(';')[0]!;
}

async function tokenFor(base: string, cookie: string): Promise<string> {
  const res = await fetch(`${base}/harbor/portal/token`, { method: 'POST', headers: { cookie } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

/** The engine's chat sign-in, as the server runs it: the portal's keys read from its JWKS (fetched from this server). */
function engineSignIn(base: string) {
  const keyFor = jwksKeys({ url: JWKS_URL, fetch: (url, init) => fetch(`${base}${new URL(String(url)).pathname}`, init) });
  return (token: string, nowSec = Math.floor(Date.now() / 1000)) =>
    principalForToken(app, { method: 'jwt', keyFor, issuer: PORTAL_ISSUER, audience: PORTAL_AUDIENCE }, token, nowSec);
}

describe('the demo portal, off', () => {
  it('is off by default: every portal path is a 404, and nothing is said of it', async () => {
    const { base, logs } = await serve({});
    for (const p of PATHS) expect((await fetch(base + p)).status, p).toBe(404);
    expect((await fetch(`${base}/harbor/portal/token`, { method: 'POST' })).status).toBe(404);
    expect(logs.join('\n')).not.toContain('demo portal');
  });

  it('is off for anything but on', async () => {
    const { base } = await serve({ HARBOR_DEMO_PORTAL: 'yes' });
    expect((await fetch(`${base}/harbor/portal`)).status).toBe(404);
  });
});

describe('the demo portal, on', () => {
  it('lists every fictional member and broker on its sign-in page, branded, and says it is a demo', async () => {
    const { base, logs } = await serve({ HARBOR_DEMO_PORTAL: 'on', ...CHAT_SETTINGS, WIDGET: 'on' });
    const res = await fetch(`${base}/harbor/portal`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const html = await res.text();
    for (const m of MEMBERS) expect(html).toContain(`value="member:${m.id}">${m.first} ${m.last} <span>`);
    for (const b of BROKERS) expect(html).toContain(`value="broker:${b.id}">${b.name} <span>· ${b.role === 'office_admin' ? 'office administrator' : 'service rep'}, ${b.office}</span>`);
    expect(html).toContain('harbor-mutual-logo-horizontal.png');
    expect(html).toContain('fictional insurer');
    expect(html).toContain('HARBOR_DEMO_PORTAL=on');
    // The images it shows, and its loud line at startup; the chat settings are as it signs, so nothing else.
    expect((await fetch(`${base}/harbor/portal/assets/harbor-mutual-logo-horizontal.png`)).headers.get('content-type')).toBe('image/png');
    expect((await fetch(`${base}/harbor/portal/assets/harbor-mutual-emblem.svg`)).headers.get('content-type')).toBe('image/svg+xml');
    expect((await fetch(`${base}/harbor/portal/assets/other.png`)).status).toBe(404);
    const warnings = logs.filter((l) => l.includes('demo portal'));
    expect(warnings).toEqual([`WARNING: demo portal ON (HARBOR_DEMO_PORTAL=on) at /harbor/portal: anyone who reaches it can sign in as any of Harbor Mutual's fictional members and brokers`]);
  });

  it('says what the chat needs when the server is not set up for its tokens', async () => {
    const { logs } = await serve({ HARBOR_DEMO_PORTAL: 'on' });
    const said = logs.join('\n');
    expect(said).toContain(`demo portal: CHAT is off, so its pages have no chat to open: set CHAT=on, with CHAT_SIGNIN=jwt, CHAT_ISSUER=${PORTAL_ISSUER}, CHAT_AUDIENCE=${PORTAL_AUDIENCE}, CHAT_JWKS_URL=${JWKS_URL}`);
    expect(said).toContain('demo portal: WIDGET is off');
  });

  it('publishes one Ed25519 public key, and no private part', async () => {
    const { base } = await serve({ HARBOR_DEMO_PORTAL: 'on' });
    const jwks = (await (await fetch(base + '/harbor/portal/jwks.json')).json()) as { keys: Record<string, string>[] };
    expect(jwks.keys).toHaveLength(1);
    expect(Object.keys(jwks.keys[0]!).sort()).toEqual(['alg', 'crv', 'kid', 'kty', 'use', 'x']);
    expect(jwks.keys[0]).toMatchObject({ kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', use: 'sig' });
  });

  it('signs a member in: their page with the widget on Harbor\'s chat, and a token the engine takes as that member at level 2', async () => {
    const { base } = await serve({ HARBOR_DEMO_PORTAL: 'on', ...CHAT_SETTINGS, WIDGET: 'on' });
    const cookie = await signIn(base, 'member:42716358');
    const html = await (await fetch(`${base}/harbor/portal/chat`, { headers: { cookie } })).text();
    expect(html).toContain('Welcome back, Jordan.');
    expect(html).toContain('<script src="/widget.js"></script>');
    expect(html).toContain('DialogWright.mount(');
    // A server of Harbor alone: its chat is /chat, with no app to name.
    expect(html).not.toContain('app: "harbor"');
    const token = await tokenFor(base, cookie);
    const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as Record<string, unknown>;
    expect(claims).toMatchObject({ iss: PORTAL_ISSUER, aud: PORTAL_AUDIENCE, sub: '42716358' });
    expect((claims.exp as number) - (claims.iat as number)).toBe(TOKEN_TTL_SEC);
    const r = await engineSignIn(base)(token);
    expect(r).toMatchObject({ ok: true, principal: { kind: 'member', id: '42716358', level: 2 } });
  });

  it('signs a broker in: their page lists their office\'s clients, and their token is a broker with role and office', async () => {
    const { base } = await serve({ HARBOR_DEMO_PORTAL: 'on', ...CHAT_SETTINGS, WIDGET: 'on' });
    const cookie = await signIn(base, 'broker:dana');
    const html = await (await fetch(`${base}/harbor/portal/chat`, { headers: { cookie } })).text();
    expect(html).toContain('Broker portal');
    expect(html).toContain('Dana Ruiz');
    expect(html).toContain('Margaret Hale, member ID 5520 3318');
    expect(html).not.toContain('Jordan Ellis');
    expect(html).toContain("position: 'inline'");
    const token = await tokenFor(base, cookie);
    const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as Record<string, unknown>;
    expect(claims).toMatchObject({ sub: 'broker:dana', broker_id: 'dana', role: 'service_rep', office_id: 'LB-01' });
    const r = await engineSignIn(base)(token);
    expect(r).toMatchObject({ ok: true, principal: { kind: 'broker', id: 'dana', role: 'service_rep', level: 2, attrs: { officeId: 'LB-01' } } });
  });

  it('refuses a token past its hour, and one whose claims were changed', async () => {
    const { base } = await serve({ HARBOR_DEMO_PORTAL: 'on', ...CHAT_SETTINGS });
    const token = await tokenFor(base, await signIn(base, 'member:42716358'));
    const check = engineSignIn(base);
    expect(await check(token, Math.floor(Date.now() / 1000) + TOKEN_TTL_SEC + 120)).toEqual({ ok: false, reason: 'expired' });
    const [h, p, s] = token.split('.') as [string, string, string];
    const other = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), sub: '55203318' })).toString('base64url');
    expect(await check(`${h}.${other}.${s}`)).toEqual({ ok: false, reason: 'signature' });
    // A broker claim added to a member's token is no broker either.
    const broker = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), broker_id: 'priya' })).toString('base64url');
    expect(await check(`${h}.${broker}.${s}`)).toEqual({ ok: false, reason: 'signature' });
  });

  it('gives no token, and no chat page, to anyone not signed in, and ends a session on sign-out', async () => {
    const { base } = await serve({ HARBOR_DEMO_PORTAL: 'on', ...CHAT_SETTINGS });
    expect((await fetch(`${base}/harbor/portal/token`, { method: 'POST' })).status).toBe(401);
    expect((await fetch(`${base}/harbor/portal/token`, { method: 'POST', headers: { cookie: 'harbor_portal=feed' } })).status).toBe(401);
    const page = await fetch(`${base}/harbor/portal/chat`, { redirect: 'manual' });
    expect(page.status).toBe(303);
    expect(page.headers.get('location')).toBe('/harbor/portal');
    const bad = await fetch(`${base}/harbor/portal/sign-in`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'person=member:99999999' });
    expect(bad.status).toBe(400);
    const cookie = await signIn(base, 'broker:priya');
    const out = await fetch(`${base}/harbor/portal/sign-out`, { method: 'POST', redirect: 'manual', headers: { cookie } });
    expect(out.status).toBe(303);
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await fetch(`${base}/harbor/portal/token`, { method: 'POST', headers: { cookie } })).status).toBe(401);
  });

  it('marks its cookie Secure when the request came over https', async () => {
    const { base } = await serve({ HARBOR_DEMO_PORTAL: 'on' });
    const res = await fetch(`${base}/harbor/portal/sign-in`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-proto': 'https' }, body: 'person=member:55203318' });
    expect(res.headers.get('set-cookie')).toMatch(/; Secure$/);
  });
});

describe('the portal\'s pieces', () => {
  const listings = { members: app.portal!.subjects!(), brokers: app.portal!.delegates!() };

  it('reads a person from the form, and refuses anything else', () => {
    expect(personOf('member:42716358')).toEqual({ kind: 'member', id: '42716358' });
    expect(personOf('broker:dana')).toEqual({ kind: 'broker', id: 'dana' });
    for (const raw of [null, '', 'admin:dana', 'member:', 'member:1 2', 'broker:<x>']) expect(personOf(raw), String(raw)).toBeNull();
  });

  it('makes claims only for someone listed', () => {
    expect(claimsFor({ kind: 'member', id: '72046185' }, listings, 1000)).toMatchObject({ sub: '72046185', iat: 1000, exp: 1000 + TOKEN_TTL_SEC });
    expect(claimsFor({ kind: 'member', id: 'dana' }, listings, 1000)).toBeNull();
    expect(claimsFor({ kind: 'broker', id: '42716358' }, listings, 1000)).toBeNull();
  });
});
