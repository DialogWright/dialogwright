import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, type RunningServer, type ServerOverrides } from './index';
import { loadConfig, type Env } from './config';
import { hostRouting, loadHost, type HostRouting } from './host';
import { mountAppPages, type AppPagesFactory, type AppRoute } from './appRoutes';
import { registerApp, resetAppsForTest } from '../core/app/registry';
import { callbackApp } from '../testing/callback/app';
import type { App } from '../core/app/types';

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
  const page = (path: string, localOnly: boolean): AppRoute => ({
    label: `demo ${path.slice(1)}`,
    path,
    localOnly,
    async handle(req, res, below) {
      if (req.method !== 'GET') return false;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`app=${deps.app.id} base=${deps.base} path=${below} chat=${deps.chatPath} signin=${deps.chat?.signIn.method ?? 'off'}`);
      return true;
    },
  });
  return { routes: [page('/hello', false), page('/private', true)] };
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
    expect(running!.routes.map((r) => r.path)).toEqual(['/callback/hello', '/callback/private']);
    expect(logs.join('\n')).not.toContain('WARNING: demo pages');
  });

  it('keeps each route\'s localOnly: through the tunnel a local-only page does not exist, a public one does', async () => {
    const { base } = await start({ DEMO_PAGES: 'on' });
    expect((await fetch(`${base}/callback/private`)).status).toBe(200);
    expect((await fetch(`${base}/callback/private`, { headers: TUNNEL })).status).toBe(404);
    expect((await fetch(`${base}/callback/hello`, { headers: TUNNEL })).status).toBe(200);
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

  it('refuses a path that is not one, naming the route', () => {
    expect(() => mountAppPages('/app', [route('portal')])).toThrow(/app route "r": path "portal" must be/);
    expect(() => mountAppPages('/app', [route('/')])).toThrow(/must be/);
  });
});
