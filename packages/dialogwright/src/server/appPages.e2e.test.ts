import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, type RunningServer, type ServerOverrides } from './index';
import { loadConfig, type Env } from './config';
import { hostRouting, loadHost, type HostRouting } from './host';
import { mountAppPages, validateRoutes, type AppPagesFactory, type AppRoute } from './appRoutes';
import { registerApp, resetAppsForTest } from '../core/app/registry';
import { callbackApp } from '../testing/callback/app';
import type { App } from '../core/app/types';
import { fakeTextProvider } from '../texts/record';

/**
 * An app's own pages (App.pages): mounted under `/<app id>` by a server of one app and by a host's
 * server alike, each handed the path below its base, its app's chat path and its own settings, each
 * route's `localOnly` kept, and none at all when the app's own switch is off.
 */

const FIXTURE = fileURLToPath(new URL('../testing/host/host.yaml', import.meta.url));
const NUMBERS = { CALLBACK_LINE: '+15555550300', SERVICE_LINE: '+15555550311', SERVICE_LINE_ES: '+15555550312' };
/** The callback app's transfer targets, which a server of that one app reads from its environment. */
const TARGETS = { MAIN_LINE: '+15555550101', PRIORITY_LINE: '+15555550102', CALLBACK_DESK: '+15555550103', SECURITY_DESK: '+15555550104' };

/** A page that says what it was given, and a local-only one, both behind the app's own DEMO_PAGES switch. */
const demoPages: AppPagesFactory = (deps) => {
  if (deps.env('DEMO_PAGES') !== 'on') return { routes: [], warnings: ['demo pages: off (DEMO_PAGES=on turns them on)'] };
  const page = (path: string, localOnly: boolean, auth?: 'console'): AppRoute => ({
    label: `demo ${path.slice(1)}`,
    path,
    localOnly,
    ...(auth !== undefined ? { auth } : {}),
    async handle(req, res, below) {
      if (req.method !== 'GET') return false;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`app=${deps.app.id} base=${deps.base} path=${below} chat=${deps.chatPath} signin=${deps.chat?.signIn.method ?? 'off'}`);
      return true;
    },
  });
  return { routes: [page('/hello', false), page('/private', true), page('/records', true, 'console')] };
};

/** A page that texts (AppPageDeps.texts): a POST sends one, with a key, and says what the sender answered. */
const sendPages: AppPagesFactory = (deps) => {
  const send: AppRoute = {
    label: 'demo send',
    path: '/send',
    localOnly: true,
    auth: 'console',
    async handle(req, res) {
      if (req.method !== 'POST') return false;
      const receipt = deps.texts === undefined ? null : await deps.texts.send({ to: '+15555550177', body: 'Your request is ready.', key: 'page-key-1' });
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(receipt === null ? 'no sender' : receipt.status);
      return true;
    },
  };
  return { routes: [send] };
};

const withPages = (app: App): App => ({ ...app, pages: demoPages });

const dirs: string[] = [];
let running: RunningServer | null = null;
afterEach(async () => {
  await running?.close();
  running = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function start(env: Env, overrides: Partial<ServerOverrides> = {}): Promise<{ base: string; logs: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'app-pages-'));
  dirs.push(dir);
  const logs: string[] = [];
  const config = loadConfig({
    PUBLIC_HOST: 'demo.example.com', TWILIO_AUTH_TOKEN: 't', HANDOFF_NUMBER: '+15551234567', PORT: '0', TODAY_OVERRIDE: '2026-10-12',
    TRACE_DIR: join(dir, 'traces'), AUDIT_DIR: join(dir, 'audit'), AUDIO_DIR: dir, DASHBOARD: 'off', JEV_CLIENT: 'stub',
    ...env,
  });
  running = await startServer(config, { host: '127.0.0.1', log: (l) => logs.push(l), env: { ...TARGETS, ...env }, ...overrides });
  return { base: `http://127.0.0.1:${running.port}`, logs };
}

/** start, with where the audit is written. */
async function startWithAudit(env: Env, overrides: Partial<ServerOverrides> = {}): Promise<{ base: string; audit: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'app-pages-'));
  dirs.push(dir);
  const config = loadConfig({
    PUBLIC_HOST: 'demo.example.com', TWILIO_AUTH_TOKEN: 't', HANDOFF_NUMBER: '+15551234567', PORT: '0', TODAY_OVERRIDE: '2026-10-12',
    TRACE_DIR: join(dir, 'traces'), AUDIT_DIR: join(dir, 'audit'), AUDIO_DIR: dir, DASHBOARD: 'off', JEV_CLIENT: 'stub',
    ...env,
  });
  running = await startServer(config, { host: '127.0.0.1', log: () => {}, env: { ...TARGETS, ...env }, ...overrides });
  return { base: `http://127.0.0.1:${running.port}`, audit: join(dir, 'audit') };
}

/** A GET from this machine with the `Host` given, as a page whose name was pointed at 127.0.0.1 would send it. */
function rawGet(port: string, path: string, host: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: Number(port), path, method: 'GET', headers: { host } }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Through a tunnel: the headers it adds, addressed to the public name. */
const TUNNEL = { 'x-forwarded-for': '203.0.113.9', host: 'demo.example.com' };

describe('an app\'s own pages on a server of one app', () => {
  beforeAll(() => {
    resetAppsForTest();
    registerApp(withPages(callbackApp));
  });

  it('serves them under /<app id>, handing each the path below its base and the app\'s chat path', async () => {
    const { base, logs } = await start({ DEMO_PAGES: 'on', CHAT: 'on', CHAT_ALLOWED_ORIGINS: 'https://www.example.com' });
    const res = await fetch(`${base}/callback/hello`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('app=callback base=/callback path=/hello chat=/chat signin=none');
    // Only under its base: the bare path is no page.
    expect((await fetch(`${base}/hello`)).status).toBe(404);
    expect((await fetch(`${base}/callback/other`)).status).toBe(404);
    expect(running!.routes.map((r) => r.path)).toEqual(['/callback/hello', '/callback/private', '/callback/records']);
    expect(logs.join('\n')).not.toContain('WARNING: demo pages');
  });

  it('keeps each route\'s localOnly: through the tunnel a local-only page does not exist, a public one does', async () => {
    const { base } = await start({ DEMO_PAGES: 'on' });
    expect((await fetch(`${base}/callback/private`)).status).toBe(200);
    expect((await fetch(`${base}/callback/private`, { headers: TUNNEL })).status).toBe(404);
    expect((await fetch(`${base}/callback/hello`, { headers: TUNNEL })).status).toBe(200);
  });

  it('serves a console page as the console is: with CONSOLE_AUTH=local, on this machine and never through the tunnel', async () => {
    const { base, logs } = await start({ DEMO_PAGES: 'on' });
    expect((await fetch(`${base}/callback/records`)).status).toBe(200);
    expect((await fetch(`${base}/callback/records`, { headers: TUNNEL })).status).toBe(404);
    expect(running!.routes.find((r) => r.path === '/callback/records')?.auth).toBe('console');
    expect(logs.join('\n')).toContain('console: /dashboard, /callback/private and /callback/records local only');
  });

  it('never serves a console page through the tunnel with no sign-in, even with CONSOLE_LOCAL_ONLY=off (which opens the app\'s other local-only pages)', async () => {
    const { base, logs } = await start({ DEMO_PAGES: 'on', CONSOLE_LOCAL_ONLY: 'off' });
    expect((await fetch(`${base}/callback/records`)).status).toBe(200);
    const res = await fetch(`${base}/callback/records`, { headers: TUNNEL });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('app=callback');
    expect((await fetch(`${base}/callback/private`, { headers: TUNNEL })).status).toBe(200);
    expect(logs.join('\n')).toContain('/callback/records local only all the same (a console page is never public)');
  });

  it('refuses a request from this machine addressed to another name (DNS rebinding): the console page and the local-only page alike', async () => {
    const { base } = await start({ DEMO_PAGES: 'on' });
    const port = new URL(base).port;
    for (const path of ['/callback/records', '/callback/private']) {
      expect((await rawGet(port, path, 'attacker.example:3000')).status, path).toBe(404);
      // An ssh tunnel to the console sends Host: localhost:<port>.
      expect((await rawGet(port, path, `localhost:${port}`)).status, path).toBe(200);
      expect((await rawGet(port, path, `[::1]:${port}`)).status, path).toBe(200);
    }
  });

  it('serves a console page behind the console\'s sign-in with CONSOLE_AUTH=token: through the tunnel, and on this machine, only signed in', async () => {
    const { base, logs } = await start({ DEMO_PAGES: 'on', DASHBOARD: 'on', CONSOLE_AUTH: 'token', CONSOLE_LINK_FILE: join(dirs.at(-1) ?? tmpdir(), 'link', 'link.json') });
    for (const headers of [TUNNEL, {}]) {
      const res = await fetch(`${base}/callback/records`, { headers, redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/dashboard/login?next=%2Fcallback%2Frecords');
    }
    // The app's other local-only page is still local only.
    expect((await fetch(`${base}/callback/private`, { headers: TUNNEL })).status).toBe(404);
    expect(logs.join('\n')).toContain('console: /dashboard and /callback/records behind sign-in on https://demo.example.com/dashboard (CONSOLE_AUTH=token); pnpm console:link prints a sign-in link; /callback/private local only');
  });

  it('serves nothing when the app\'s own switch is off, and says so', async () => {
    const { base, logs } = await start({});
    expect((await fetch(`${base}/callback/hello`)).status).toBe(404);
    expect(running!.routes).toEqual([]);
    expect(logs).toContain('WARNING: demo pages: off (DEMO_PAGES=on turns them on)');
  });

  it('mounts a launcher\'s routes beside them, and refuses one that sits on an app\'s base', async () => {
    const launcher: AppRoute = { label: 'launcher page', path: '/extra', localOnly: false, handle: async (_req, res) => { res.end('launcher'); return true; } };
    const { base } = await start({ DEMO_PAGES: 'on' }, { routes: () => ({ routes: [launcher] }) });
    expect(await (await fetch(`${base}/extra`)).text()).toBe('launcher');
    expect((await fetch(`${base}/callback/hello`)).status).toBe(200);
    await running!.close();
    running = null;
    const clash: AppRoute = { ...launcher, path: '/callback' };
    await expect(start({ DEMO_PAGES: 'on' }, { routes: () => ({ routes: [clash] }) })).rejects.toThrow(/overlaps route "launcher page" at \/callback/);
  });
});

describe('an app\'s own pages on a host of several apps', () => {
  let host: HostRouting;
  beforeAll(async () => {
    resetAppsForTest();
    registerApp(callbackApp);
    const loaded = await loadHost(FIXTURE, { ...NUMBERS });
    // Both apps with the same pages; the switch on in the callback app's own settings alone.
    host = hostRouting({
      apps: loaded.apps.map((a) => ({ ...a, app: withPages(a.app), settings: { ...(a.settings ?? a.env), ...(a.id === 'callback' ? { DEMO_PAGES: 'on' } : {}) } })),
      numbers: loaded.numbers.map((n) => ({ variable: n.variable, app: n.app })),
      defaultApp: loaded.defaultApp,
      env: { ...NUMBERS },
    });
  }, 60_000);

  it('mounts each app\'s under its own id, with its own chat path and its own settings', async () => {
    const { base, logs } = await start({ ...NUMBERS, CHAT: 'on', CHAT_ALLOWED_ORIGINS: 'https://www.example.com' }, { apps: host });
    expect(await (await fetch(`${base}/callback/hello`)).text()).toBe('app=callback base=/callback path=/hello chat=/chat/callback signin=none');
    // The routed app's switch is off in its own settings: none of its paths exist, and its warning names it.
    expect((await fetch(`${base}/routed/hello`)).status).toBe(404);
    expect(logs).toContain('WARNING: app routed: demo pages: off (DEMO_PAGES=on turns them on)');
    expect((await fetch(`${base}/callback/private`, { headers: TUNNEL })).status).toBe(404);
  });

  it('keeps two apps\' pages of one name apart', async () => {
    const both = hostRouting({
      apps: host.apps.map((a) => ({ ...a, settings: { ...a.settings, DEMO_PAGES: 'on' } })),
      numbers: host.numbers.map((n) => ({ variable: n.variable, app: n.app })),
      defaultApp: host.defaultApp,
      env: { ...NUMBERS },
    });
    const { base } = await start({ ...NUMBERS }, { apps: both });
    expect(await (await fetch(`${base}/callback/hello`)).text()).toContain('app=callback base=/callback');
    expect(await (await fetch(`${base}/routed/hello`)).text()).toBe('app=routed base=/routed path=/hello chat=/chat/routed signin=off');
  });
});

describe('mountAppPages', () => {
  const route = (path: string): AppRoute => ({ label: 'r', path, localOnly: true, handle: async () => false, sweep: () => {} });

  it('puts each path under the base and keeps the rest of the route', () => {
    const [m] = mountAppPages('/my_app', [route('/portal/help')]);
    expect(m!.path).toBe('/my_app/portal/help');
    expect(m!.localOnly).toBe(true);
    expect(m!.sweep).toBeTypeOf('function');
  });

  it('keeps a console page\'s auth, and refuses one that is not local only (it would be public where the console has no sign-in)', () => {
    expect(mountAppPages('/app', [{ ...route('/records'), auth: 'console' }])[0]!.auth).toBe('console');
    expect(mountAppPages('/app', [route('/records')])[0]).not.toHaveProperty('auth');
    expect(() => validateRoutes(mountAppPages('/app', [{ ...route('/records'), localOnly: false, auth: 'console' }]))).toThrow(/app route "r": auth: 'console' needs localOnly: true/);
  });

  it('refuses a path that is not one, naming the route', () => {
    expect(() => mountAppPages('/app', [route('portal')])).toThrow(/app route "r": path "portal" must be/);
    expect(() => mountAppPages('/app', [route('/')])).toThrow(/must be/);
  });
});

describe('an app\'s pages texting (AppPageDeps.texts)', () => {
  beforeAll(() => {
    resetAppsForTest();
    registerApp({ ...callbackApp, pages: sendPages });
  });

  it('gives the app\'s pages its sender where the server has one (TEXT_FROM), each text recorded in the app\'s audit under its key', async () => {
    const provider = fakeTextProvider();
    const { base, audit } = await startWithAudit({ TWILIO_AUTH_TOKEN: 't', TEXT_FROM: '+15555550100', TWILIO_ACCOUNT_SID: `AC${'3'.repeat(32)}` }, { textProvider: provider });
    const res = await fetch(`${base}/callback/send`, { method: 'POST' });
    expect(await res.text()).toBe('queued');
    expect(provider.sent).toEqual([{ from: '+15555550100', to: '+15555550177', body: 'Your request is ready.', key: 'page-key-1' }]);
    const rows = readdirSync(audit).filter((f) => f.endsWith('.jsonl')).flatMap((f) => readFileSync(join(audit, f), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as { type: string; callId: string; channel: string; detail: Record<string, unknown> }));
    expect(rows.filter((r) => r.type === 'text_sent')).toMatchObject([{ callId: 'page-key-1', channel: 'sms', detail: { number: '...0177', bodyLength: 22, status: 'queued' } }]);
    // A second send with the key is not sent again (the app's keys, as its tools'), and with no sender the page has none.
    expect(await (await fetch(`${base}/callback/send`, { method: 'POST' })).text()).toBe('queued');
    expect(provider.sent).toHaveLength(1);
    await running!.close();
    running = null;
    const none = await start({});
    expect(await (await fetch(`${none.base}/callback/send`, { method: 'POST' })).text()).toBe('no sender');
  });
});
