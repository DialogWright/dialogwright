import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blocksHtml, chatPageHtml, defaultStarters, phoneOf } from './chatPage';
import { startServer, type RunningServer } from './index';
import { loadConfig, type Env } from './config';
import { registerApp, resetAppsForTest } from '../core/app/registry';
import { callbackApp } from '../testing/callback/app';
import { chatLine } from '../prompts/rich';
import type { App } from '../core/app/types';
import type { AppRoute } from './appRoutes';

/** The engine's chat page (app.yaml's chat.page; docs/designs/2026-10-18-chat-page.md). */

describe('the chat page\'s parts', () => {
  it('starts, by default, with the labels of the app\'s forms and informational intents, a capital first', () => {
    const starters = defaultStarters(callbackApp);
    expect(starters.length).toBeGreaterThan(0);
    expect(starters.length).toBeLessThanOrEqual(6);
    for (const s of starters) expect(s[0]).toBe(s[0]!.toUpperCase());
    const labels = Object.values(callbackApp.intents).filter((i) => i.kind === 'control').map((i) => i.label);
    for (const l of labels) expect(starters).not.toContain(l[0]!.toUpperCase() + l.slice(1));
  });

  it('shows a number to call from E.164 only', () => {
    expect(phoneOf('+15555550123')).toEqual({ tel: '+15555550123', shown: '(555) 555-0123' });
    expect(phoneOf('+445550123456')).toEqual({ tel: '+445550123456', shown: '+445550123456' });
    expect(phoneOf('865-555-0123')).toBeNull();
    expect(phoneOf(undefined)).toBeNull();
  });

  it('writes every value as text: a name, a tagline, a starter, the intro\'s words; a colour only as a hex code', () => {
    const html = chatPageHtml({
      name: 'Acme <script>alert(1)</script>',
      tagline: '"quoted" & more',
      logo: null,
      colors: { accent: '#123abc', background: 'red; } body { display:none', text: '#ffffff' },
      intro: 'We **come** to <you>.',
      starters: ['Book </script><script>alert(2)</script>'],
      phone: phoneOf('+15555550123'),
      chatPath: '/chat/acme',
      lang: 'en-US',
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('Acme &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&quot;quoted&quot; &amp; more');
    expect(html).toContain('<p>We <strong>come</strong> to &lt;you&gt;.</p>');
    expect(html).not.toContain('</script><script>alert(2)');
    expect(html).toContain('Book \\u003c/script>\\u003cscript>alert(2)\\u003c/script>');
    expect(html).toContain('--accent: #123abc;');
    expect(html).not.toContain('display:none');
    expect(html).toContain('href="tel:+15555550123"');
    expect(html).toContain('DialogWright.mountConversation(\'#talk\', { endpoint: "/chat/acme"');
    expect(blocksHtml(chatLine('- **a** <b>\n- c', {}).blocks)).toBe('<ul><li><strong>a</strong> &lt;b&gt;</li><li>c</li></ul>');
  });
});

const TARGETS = { MAIN_LINE: '+15555550101', PRIORITY_LINE: '+15555550102', CALLBACK_DESK: '+15555550103', SECURITY_DESK: '+15555550104' };
const TUNNEL = { 'x-forwarded-for': '203.0.113.9', host: 'demo.example.com' };
const dirs: string[] = [];
let running: RunningServer | null = null;
afterEach(async () => {
  await running?.close();
  running = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A server of the callback app with its chat page (and, where given, its own pages). */
async function start(app: App, env: Env = {}): Promise<{ base: string; logs: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'chat-page-'));
  dirs.push(dir);
  const widget = join(dir, 'widget.js');
  writeFileSync(widget, '/* the widget */');
  resetAppsForTest();
  registerApp(app);
  const settings: Env = {
    PUBLIC_HOST: 'demo.example.com', VOICE_PROVIDERS: 'none', PORT: '0', TODAY_OVERRIDE: '2026-10-12', CHAT: 'on', CHAT_ALLOWED_ORIGINS: 'https://demo.example.com',
    WIDGET: 'on', WIDGET_FILE: widget, TRACE_DIR: join(dir, 'traces'), AUDIT_DIR: join(dir, 'audit'), AUDIO_DIR: dir, DASHBOARD: 'off', JEV_CLIENT: 'stub', ...env,
  };
  const logs: string[] = [];
  running = await startServer(loadConfig(settings), { host: '127.0.0.1', log: (l) => logs.push(l), env: { ...TARGETS, ...settings } });
  return { base: `http://127.0.0.1:${running.port}`, logs };
}

function withPage(serve: 'off' | 'local' | 'public', brand: Partial<NonNullable<App['brand']>> = {}): App {
  return { ...callbackApp, brand: { name: 'Example Callbacks', mark: 'EC', tagline: 'Call us back', ...brand }, chat: { page: { serve, starters: ['Set up a callback'], phone: 'MAIN_LINE' } } };
}

describe('the chat page on a server', () => {
  it('serves the brand above the conversation at /<app id>/chat, with its starters, a number to call and a strict policy', async () => {
    const logo = join(mkdtempSync(join(tmpdir(), 'logo-')), 'logo.svg');
    dirs.push(join(logo, '..'));
    writeFileSync(logo, '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const { base, logs } = await start(withPage('public', { logo, colors: { accent: '#5aa9ff' } }));
    const res = await fetch(`${base}/callback/chat`, { headers: TUNNEL });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = await res.text();
    expect(html).toContain('<h1>Example Callbacks</h1>');
    expect(html).toContain('<p class="tagline">Call us back</p>');
    expect(html).toContain('starters: ["Set up a callback"]');
    expect(html).toContain('endpoint: "/chat"');
    expect(html).toContain('(555) 555-0101');
    expect(html).toContain('src="/callback/chat/logo"');
    const image = await fetch(`${base}/callback/chat/logo`);
    expect(image.headers.get('content-type')).toBe('image/svg+xml');
    expect(image.headers.get('content-security-policy')).toContain('sandbox');
    expect(running!.routes.map((r) => [r.label, r.path])).toEqual([['chat page', '/callback/chat']]);
    expect(logs.join('\n')).not.toContain('WARNING');
  });

  it('serves it on the server\'s machine alone with serve: local, and not at all with off or the app\'s CHAT_PAGE=off', async () => {
    let { base } = await start(withPage('local'));
    expect((await fetch(`${base}/callback/chat`)).status).toBe(200);
    expect((await fetch(`${base}/callback/chat`, { headers: TUNNEL })).status).toBe(404);
    await running!.close();
    running = null;
    ({ base } = await start(withPage('off')));
    expect((await fetch(`${base}/callback/chat`)).status).toBe(404);
    await running!.close();
    running = null;
    ({ base } = await start(withPage('public'), { CHAT_PAGE: 'off' }));
    expect((await fetch(`${base}/callback/chat`)).status).toBe(404);
  });

  it('says why there is no page without the widget\'s script', async () => {
    const { base, logs } = await start(withPage('public'), { WIDGET: 'off' });
    expect((await fetch(`${base}/callback/chat`)).status).toBe(404);
    expect(logs.join('\n')).toContain('chat page: off, as WIDGET is off');
  });

  it('gives way to a page the app serves itself at that path', async () => {
    const own: AppRoute = { label: 'own chat page', path: '/chat', localOnly: false, handle: async (_req, res) => { res.end('the app\'s own'); return true; } };
    const app: App = { ...withPage('public'), pages: () => ({ routes: [own] }) };
    const { base } = await start(app);
    expect(await (await fetch(`${base}/callback/chat`)).text()).toBe('the app\'s own');
    expect(running!.routes.map((r) => r.label)).toEqual(['own chat page']);
  });
});
