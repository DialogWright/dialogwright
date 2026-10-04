import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type RunningServer } from 'dialogwright';
import { loadConfig } from 'dialogwright/server/config';
import { HeuristicStubClient } from 'dialogwright/jev/heuristicStub';
import { app } from './app';
import { CHAT_DEMO_PATH, chatDemoPage, chatDemoRoutes } from './chatDemo';

let running: RunningServer | null = null;
const dirs: string[] = [];
afterEach(async () => {
  await running?.close();
  running = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The four lines of laptop mode the demo needs, and a built widget to serve. */
function laptop(extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'chat-demo-'));
  dirs.push(dir);
  const widget = join(dir, 'dialogwright-widget.js');
  writeFileSync(widget, '/* the widget */');
  return {
    PUBLIC_HOST: 'localhost', TWILIO_AUTH_TOKEN: 't', HANDOFF_NUMBER: '+15551234567', PORT: '0', TODAY_OVERRIDE: '2026-09-18',
    TRACE_DIR: dir, AUDIT_DIR: join(dir, 'audit'), AUDIO_DIR: dir, DASHBOARD: 'off',
    CHAT: 'on', CHAT_ALLOWED_ORIGINS: 'http://localhost:3000', CHAT_SIGNIN: 'mock', WIDGET: 'on', WIDGET_FILE: widget,
    ...extra,
  };
}

async function serve(env: Record<string, string>) {
  const logs: string[] = [];
  running = await startServer(loadConfig(env), { client: new HeuristicStubClient({ todayIso: '2026-09-18' }), log: (l) => logs.push(l), routes: chatDemoRoutes });
  // At the address the README gives and the server prints: localhost, as a laptop's PUBLIC_HOST is.
  return { base: `http://localhost:${running.port}`, logs };
}

const subjects = app.portal!.subjects!();

describe('the chat demo page', () => {
  it('embeds the widget, offering to sign in as each of the app\'s fictional customers', () => {
    const html = chatDemoPage(app);
    expect(html).toContain('<script src="/widget.js"></script>');
    expect(html).toContain('DialogWright.mount(');
    expect(subjects.length).toBeGreaterThan(1);
    for (const s of subjects) expect(html).toContain(`<option value="${s.id}">${s.first} ${s.last}</option>`);
    expect(html.match(/<option /g)).toHaveLength(subjects.length + 1);
    // The token the page gives the widget is the laptop's mock sign-in.
    expect(html).toContain("'mock:' + who.value");
    expect(html).toContain(app.brand!.name.replace('&', '&amp;'));
  });

  it('writes the app\'s words into the page as text, never as markup', () => {
    const html = chatDemoPage({ ...app, brand: { ...app.brand!, name: 'A <b>bold</b> & "quoted" name' } }, [{ id: '1"><x', first: '<i>', last: 'L' }]);
    expect(html).toContain('A &lt;b&gt;bold&lt;/b&gt; &amp; &quot;quoted&quot; name');
    expect(html).toContain('<option value="1&quot;&gt;&lt;x">&lt;i&gt; L</option>');
    expect(html).not.toContain('<b>bold');
  });

  it('is served on a laptop at localhost, to this machine only: through a tunnel it does not exist', async () => {
    const { base } = await serve(laptop());
    const res = await fetch(base + CHAT_DEMO_PATH);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await res.text()).toContain('<script src="/widget.js"></script>');
    expect((await fetch(base + '/widget.js')).status).toBe(200);
    expect((await fetch(base + CHAT_DEMO_PATH, { headers: { 'x-forwarded-for': '203.0.113.9' } })).status).toBe(404);
    expect((await fetch(base + `${CHAT_DEMO_PATH}/other`)).status).toBe(404);
    expect((await fetch(base + CHAT_DEMO_PATH, { method: 'POST', body: 'x' })).status).toBe(404);
  });

  it('is not mounted outside laptop mode, and says what it needs', async () => {
    const { base, logs } = await serve(laptop({ CHAT_SIGNIN: 'none' }));
    expect((await fetch(base + CHAT_DEMO_PATH)).status).toBe(404);
    expect(logs.join('\n')).toContain('chat demo: off (it needs PUBLIC_HOST=localhost, CHAT=on, CHAT_SIGNIN=mock and WIDGET=on)');
  });

  it('is quiet when the deployment has no web chat at all', async () => {
    const env: Record<string, string> = laptop();
    for (const k of ['CHAT', 'CHAT_ALLOWED_ORIGINS', 'CHAT_SIGNIN', 'WIDGET', 'WIDGET_FILE']) delete env[k];
    const { base, logs } = await serve(env);
    expect((await fetch(base + CHAT_DEMO_PATH)).status).toBe(404);
    expect(logs.join('\n')).not.toContain('chat demo');
  });
});
