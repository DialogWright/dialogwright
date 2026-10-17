import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { loadHost, startServer, type HostRouting, type RunningServer } from 'dialogwright';
import { loadConfig } from 'dialogwright/server/config';
import { APP_DIR } from './app';
import { PORTAL_AUDIENCE, PORTAL_ISSUER } from './portal';

/**
 * Harbor on a host's server (host.yaml), its demo portal on, its chat signed in with a portal token:
 * the server fetches the portal's keys from the JWKS it publishes (as on a live server, where
 * CHAT_JWKS_URL is the portal's own public URL), and the chat at /chat/harbor serves a member and a
 * broker each as the token names them.
 */

const PUBLIC = 'harbor.example.com';
const ORIGIN = `https://${PUBLIC}`;
const dirs: string[] = [];
let host: HostRouting;
let running: RunningServer | null = null;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'harbor-host-'));
  dirs.push(dir);
  // Harbor's own settings: the portal's switch (an app's own file, over the server's). Named, so no
  // .env of the author's in the app's folder is read by the test.
  writeFileSync(join(dir, 'harbor.env'), 'HARBOR_DEMO_PORTAL=on\n');
  writeFileSync(join(dir, 'host.yaml'), `apps:\n  - { folder: ${relative(dir, APP_DIR)}, env: harbor.env }\n`);
  host = await loadHost(join(dir, 'host.yaml'), {});
}, 60_000);

afterEach(async () => {
  await running?.close();
  running = null;
});

afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function start(): Promise<{ base: string; ws: string; logs: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'harbor-host-run-'));
  dirs.push(dir);
  const widget = join(dir, 'dialogwright-widget.js');
  writeFileSync(widget, '/* the widget */');
  let base = '';
  const logs: string[] = [];
  const config = loadConfig({
    PUBLIC_HOST: PUBLIC, TWILIO_AUTH_TOKEN: 't', HANDOFF_NUMBER: '+15555550100', PORT: '0', TODAY_OVERRIDE: '2026-10-16',
    TRACE_DIR: join(dir, 'traces'), AUDIT_DIR: join(dir, 'audit'), AUDIO_DIR: dir, DASHBOARD: 'off', JEV_CLIENT: 'stub',
    CHAT: 'on', CHAT_ALLOWED_ORIGINS: ORIGIN, CHAT_SIGNIN: 'jwt', CHAT_JWKS_URL: `https://${PUBLIC}/harbor/portal/jwks.json`, CHAT_ISSUER: PORTAL_ISSUER, CHAT_AUDIENCE: PORTAL_AUDIENCE,
    WIDGET: 'on', WIDGET_FILE: widget,
  });
  // The public URL the keys are published at, reached on this server: what the tunnel does on a live one.
  const chatFetch: typeof fetch = (url, init) => fetch(`${base}${new URL(String(url)).pathname}`, init);
  running = await startServer(config, { host: '127.0.0.1', apps: host, log: (l) => logs.push(l), chatFetch });
  base = `http://127.0.0.1:${running.port}`;
  return { base, ws: `ws://127.0.0.1:${running.port}`, logs };
}

async function portalToken(base: string, person: string): Promise<string> {
  const signIn = await fetch(`${base}/harbor/portal/sign-in`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ person }).toString() });
  const cookie = signIn.headers.get('set-cookie')!.split(';')[0]!;
  const page = await (await fetch(`${base}/harbor/portal/chat`, { headers: { cookie } })).text();
  // On a host, the page's widget names Harbor's chat.
  expect(page).toContain('app: "harbor"');
  return ((await (await fetch(`${base}/harbor/portal/token`, { method: 'POST', headers: { cookie } })).json()) as { token: string }).token;
}

interface Message { type: string; text?: string; code?: string; level?: number }

/** A chat at /chat/harbor started with `token`, each line sent in turn once the reply to the last has come; everything the server sent. */
async function chat(ws: string, token: string, lines: readonly string[]): Promise<Message[]> {
  // Node's WebSocket takes the Origin a browser would send on the portal's page.
  const socket = new WebSocket(`${ws}/chat/harbor`, { headers: { origin: ORIGIN } } as unknown as string[]);
  const received: Message[] = [];
  socket.addEventListener('message', (e) => received.push(JSON.parse(String(e.data)) as Message));
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', () => reject(new Error('the chat socket did not open')));
  });
  const says = (): number => received.filter((m) => m.type === 'say').length;
  const waitFor = async (done: () => boolean): Promise<void> => {
    const deadline = Date.now() + 5000;
    while (!done() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  };
  socket.send(JSON.stringify({ type: 'start', v: 1, token }));
  await waitFor(() => says() > 0 || received.some((m) => m.type === 'error'));
  for (const text of lines) {
    const n = says();
    socket.send(JSON.stringify({ type: 'text', text }));
    await waitFor(() => says() > n);
    await new Promise((r) => setTimeout(r, 50));
  }
  socket.close();
  return received;
}

const said = (ms: readonly Message[]): string => ms.filter((m) => m.type === 'say').map((m) => m.text).join(' ');

describe('Harbor\'s demo portal on a host, signing in its chat', () => {
  it('a member signed in by the portal is answered as themself, with no factor asked', async () => {
    const s = await start();
    expect(s.logs.join('\n')).toContain('WARNING: app harbor: demo portal ON (HARBOR_DEMO_PORTAL=on) at /harbor/portal');
    // The chat settings are as the portal signs: no other line about it.
    expect(s.logs.filter((l) => l.includes('demo portal:'))).toEqual([]);
    const received = await chat(s.ws, await portalToken(s.base, 'member:42716358'), ['is physical therapy covered']);
    expect(received.filter((m) => m.type === 'error')).toEqual([]);
    expect(said(received)).toContain("You've used 4 of them this year.");
    expect(said(received)).not.toMatch(/member ID/i);
  });

  it('a broker signed in by the portal checks a client\'s claim, its diagnosis withheld', async () => {
    const s = await start();
    const received = await chat(s.ws, await portalToken(s.base, 'broker:priya'), ["what's the status of claim 4711"]);
    expect(received.filter((m) => m.type === 'error')).toEqual([]);
    expect(said(received)).toContain('Medical details are withheld for your role.');
    expect(said(received)).not.toContain('hip fracture');
  });

  it('a token the portal did not sign is refused', async () => {
    const s = await start();
    const token = await portalToken(s.base, 'member:42716358');
    const [h, p] = token.split('.') as [string, string, string];
    const received = await chat(s.ws, `${h}.${p}.${Buffer.alloc(64).toString('base64url')}`, []);
    expect(received.some((m) => m.type === 'error' && m.code === 'sign_in_failed')).toBe(true);
  });
});
