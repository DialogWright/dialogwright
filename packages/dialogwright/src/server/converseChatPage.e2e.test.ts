import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type RunningServer } from './index';
import { loadConfig, type Env } from './config';
import { hostRouting, type HostedApp } from './host';
import { defineConverseApp, type ConverseApp } from '../converse/app';
import { fakeModel } from '../converse/model/fake';
import { resetAppsForTest } from '../core/app/registry';
import { CONVERSE_FIXTURE_DIR } from '../testing/converse/app';
import { CHAT_ORIGIN, yesJev } from '../testing/converse/chat';

/**
 * A converse app's chat page: the engine's, built from app.yaml's chat.page as a scripted app's is, at
 * /<app id>/chat, its script connecting to the app's own chat path (/chat on a server of one app,
 * /chat/<app id> beside others).
 */

const servers: RunningServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  resetAppsForTest();
});

function folder(): string {
  const d = mkdtempSync(join(tmpdir(), 'converse-page-'));
  dirs.push(d);
  return d;
}

const TOOLS = { availability: async () => [], book: async () => 'booked' };

/** The fixture's business with an app.yaml of this text. */
function appWith(appYaml: string): ConverseApp {
  const own = join(folder(), 'converse');
  mkdirSync(own);
  copyFileSync(join(CONVERSE_FIXTURE_DIR, 'agent.yaml'), join(own, 'agent.yaml'));
  writeFileSync(join(own, 'app.yaml'), appYaml);
  return defineConverseApp(own, { tools: TOOLS });
}

const PAGE = `id: converse
mode: converse
brand:
  name: Example Visits
  mark: EV
  tagline: Visits, booked
chat:
  page:
    serve: public
    intro: An invented visit line.
    starters: [Book a visit]
`;

function settings(extra: Record<string, string> = {}): Env {
  const dir = folder();
  const widget = join(dir, 'widget.js');
  writeFileSync(widget, '/* the widget */');
  return {
    PUBLIC_HOST: 'localhost', VOICE_PROVIDERS: 'none', CHAT: 'on', CHAT_ALLOWED_ORIGINS: CHAT_ORIGIN, PORT: '0', WIDGET: 'on', WIDGET_FILE: widget,
    TRACE_DIR: join(dir, 'traces'), AUDIT_DIR: join(dir, 'audit'), AUDIO_DIR: dir, DASHBOARD: 'off', JEV_CLIENT: 'stub', ...extra,
  };
}

async function boot(apps: HostedApp[], env: Env): Promise<{ base: string; logs: string[] }> {
  const logs: string[] = [];
  const host = hostRouting({ apps: apps.map((app) => ({ id: app.id, app, dir: (app as ConverseApp).dir ?? '.', env, own: [], ignored: [] })), numbers: [], defaultApp: apps[0]!.id, env });
  const server = await startServer(loadConfig(env), { host: '127.0.0.1', client: yesJev(), log: (l) => logs.push(l), env, apps: host, converseModel: () => fakeModel([]) });
  servers.push(server);
  return { base: `http://127.0.0.1:${server.port}`, logs };
}

describe("a converse app's chat page", () => {
  it('is served at /<app id>/chat from app.yaml, its script connecting to /chat on a server of one app', async () => {
    const { base, logs } = await boot([appWith(PAGE)], settings());
    const res = await fetch(`${base}/converse/chat`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<h1>Example Visits</h1>');
    expect(html).toContain('<p class="tagline">Visits, booked</p>');
    expect(html).toContain('An invented visit line.');
    expect(html).toContain('starters: ["Book a visit"]');
    expect(html).toContain('endpoint: "/chat"');
    expect(logs.join('\n')).not.toContain('WARNING');
  });

  it('connects to /chat/<app id> beside another app', async () => {
    const { base } = await boot([appWith(PAGE), appWith(PAGE.replace('id: converse', 'id: second'))], settings());
    const html = await (await fetch(`${base}/converse/chat`)).text();
    expect(html).toContain('endpoint: "/chat/converse"');
  });

  it('is not served without chat.page, with serve: off or CHAT_PAGE=off, and says why without the widget', async () => {
    let { base } = await boot([appWith('id: converse\nmode: converse\n')], settings());
    expect((await fetch(`${base}/converse/chat`)).status).toBe(404);
    await servers.pop()!.close();
    ({ base } = await boot([appWith(PAGE.replace('serve: public', 'serve: off'))], settings()));
    expect((await fetch(`${base}/converse/chat`)).status).toBe(404);
    await servers.pop()!.close();
    ({ base } = await boot([appWith(PAGE)], settings({ CHAT_PAGE: 'off' })));
    expect((await fetch(`${base}/converse/chat`)).status).toBe(404);
    await servers.pop()!.close();
    const off = await boot([appWith(PAGE)], settings({ WIDGET: 'off' }));
    expect((await fetch(`${off.base}/converse/chat`)).status).toBe(404);
    expect(off.logs.join('\n')).toContain('chat page: off, as WIDGET is off');
  });

  it('gives way to a page the app serves itself at that path', async () => {
    const own = join(folder(), 'converse');
    mkdirSync(own);
    copyFileSync(join(CONVERSE_FIXTURE_DIR, 'agent.yaml'), join(own, 'agent.yaml'));
    writeFileSync(join(own, 'app.yaml'), PAGE);
    const page = { label: 'own', path: '/chat', localOnly: false, handle: async (_req: unknown, res: import('node:http').ServerResponse) => { res.writeHead(200).end("the app's own"); return true; } };
    const app = defineConverseApp(own, { tools: TOOLS, pages: { routes: [page] } });
    const { base } = await boot([app], settings());
    expect(await (await fetch(`${base}/converse/chat`)).text()).toBe("the app's own");
  });
});
