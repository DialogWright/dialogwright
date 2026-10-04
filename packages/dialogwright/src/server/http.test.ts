import { afterEach, describe, expect, it } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clipName, createRequestHandler, decideActionTwiml, type HttpDeps } from './http';
import { loadConfig } from './config';
import { computeTwilioSignature } from './signature';
import { SessionStore } from './sessions';
import { CallTokens } from './tokens';
import { FrameLog } from './frameLog';
import { newSession } from '../core/session';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { TraceWriter } from '../trace/writer';
import { DashboardBus } from './dashboard/bus';
import { validateRoutes, type AppRoute } from './appRoutes';
import { VOICE_RELAY } from '../channel/caps';
import { useTestkit } from '../testing/apps';

useTestkit();

const TOKEN = 'authtok';
let server: Server | null = null;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

function deps(overrides: Record<string, string> = {}, audioDir?: string): HttpDeps & { dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'http-'));
  const config = loadConfig({
    PUBLIC_HOST: 'demo.ngrok.app',
    TWILIO_AUTH_TOKEN: TOKEN,
    HANDOFF_NUMBER: '+15551234567',
    RECONNECT_LIMIT: '1',
    AUDIO_DIR: audioDir ?? dir,
    CHAT: 'off',
    ...overrides,
  });
  const store = new SessionStore((callSid) => ({
    session: newSession(callSid, 0, VOICE_RELAY),
    opts: { client: new HeuristicStubClient(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18' },
    trace: new TraceWriter(join(dir, `${callSid}.jsonl`)),
    frames: new FrameLog(join(dir, `${callSid}.frames.jsonl`)),
  }), 60_000);
  return { config, store, tokens: new CallTokens(60_000), hints: 'depot, parcel', log: () => {}, dir };
}

async function listen(d: HttpDeps): Promise<string> {
  server = createServer(createRequestHandler(d));
  await new Promise<void>((r) => server!.listen(0, r));
  const port = (server.address() as { port: number }).port;
  return `http://127.0.0.1:${port}`;
}

async function post(base: string, path: string, params: Record<string, string>, sign = true, host = 'demo.ngrok.app') {
  const body = new URLSearchParams(params).toString();
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (sign) headers['x-twilio-signature'] = computeTwilioSignature(`https://${host}${path}`, params, TOKEN);
  const res = await fetch(base + path, { method: 'POST', headers, body });
  return { status: res.status, text: await res.text() };
}

async function get(base: string, path: string) {
  const res = await fetch(base + path);
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), body: Buffer.from(await res.arrayBuffer()) };
}

async function head(base: string, path: string) {
  const res = await fetch(base + path, { method: 'HEAD' });
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), body: Buffer.from(await res.arrayBuffer()) };
}

describe('http routes', () => {
  it('serves health, counting live sessions apart from ended ones still retained', async () => {
    const d = deps();
    const base = await listen(d);
    expect(await (await fetch(base + '/health')).json()).toEqual({ ok: true, sessions: 0, retained: 0 });
    const sock = { send: () => {}, close: () => {} };
    d.store.create('CA1', sock);
    d.store.create('CA2', sock);
    expect(await (await fetch(base + '/health')).json()).toEqual({ ok: true, sessions: 2, retained: 0 });
    d.store.end('CA2');
    const res = await fetch(base + '/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sessions: 1, retained: 1 });
  });

  it('answers /voice with connect TwiML and a token bound to the call', async () => {
    const d = deps();
    const base = await listen(d);
    const r = await post(base, '/voice', { CallSid: 'CA1', From: '+1', To: '+2' });
    expect(r.status).toBe(200);
    const token = /token=([0-9a-f]{32})/.exec(r.text)?.[1];
    expect(token).toBeDefined();
    expect(d.tokens.verify(token!, 'CA1')).toBe(true);
    expect(r.text).toContain('hints="depot, parcel"');
  });

  it('logs a /voice call with the caller number masked to its last four', async () => {
    const lines: string[] = [];
    const base = await listen({ ...deps(), log: (l) => lines.push(l) });
    await post(base, '/voice', { CallSid: 'CA1', From: '+15555550199', To: '+2' });
    expect(lines).toContain('/voice CA1 from …0199');
    expect(lines.join('\n')).not.toContain('5555550199');
  });

  it('masks the caller number in the raw frame log for the /cr-action webhook, at write time', async () => {
    const d = deps();
    const base = await listen(d);
    const sock = { send: () => {}, close: () => {} };
    d.store.create('CA1', sock);
    await post(base, '/cr-action', {
      CallSid: 'CA1', CallStatus: 'completed', SessionStatus: 'completed',
      From: '+15555550199', To: '+15555550100', Caller: '+15555550199', Called: '+15555550100',
    });
    const line = readFileSync(join(d.dir, 'CA1.frames.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { dir: string; msg: Record<string, unknown> }).find((l) => l.dir === 'http');
    expect(line?.msg).toMatchObject({ route: '/cr-action', From: '…0199', To: '…0100', Caller: '…0199', Called: '…0100' });
    expect(JSON.stringify(line)).not.toContain('5555550199');
  });

  it('rejects a missing or bad signature', async () => {
    const base = await listen(deps());
    expect((await post(base, '/voice', { CallSid: 'CA1' }, false)).status).toBe(403);
    expect((await post(base, '/cr-action', { CallSid: 'CA1' }, true, 'other.host')).status).toBe(403);
  });

  it('honors SIGNATURE_CHECK=off', async () => {
    const base = await listen(deps({ SIGNATURE_CHECK: 'off' }));
    expect((await post(base, '/voice', { CallSid: 'CA1' }, false)).status).toBe(200);
  });

  it('returns 404 elsewhere', async () => {
    const base = await listen(deps());
    expect((await fetch(base + '/nope')).status).toBe(404);
  });

  it('returns 413 for an oversized body', async () => {
    const base = await listen(deps());
    const big = 'x'.repeat(70 * 1024);
    const r = await post(base, '/voice', { CallSid: 'CA1', Big: big });
    expect(r.status).toBe(413);
  });

  it('returns 400 for /voice without CallSid', async () => {
    const base = await listen(deps());
    const r = await post(base, '/voice', { From: '+1' });
    expect(r.status).toBe(400);
  });

  it('answers HEAD /health', async () => {
    const base = await listen(deps());
    const res = await fetch(base + '/health', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('serves audio clips with the right type and cache headers, and nothing else under /audio', async () => {
    const audioDir = mkdtempSync(join(tmpdir(), 'audio-'));
    const base = await listen(deps({}, audioDir));
    const get_ = (path: string) => get(base, path);
    const head_ = (path: string) => head(base, path);
    writeFileSync(join(audioDir, 'greeting.0.wav'), Buffer.from('RIFFdata'));
    writeFileSync(join(audioDir, 'Loud.0.WAV'), Buffer.from('RIFFloud'));
    const ok = await get_('/audio/greeting.0.wav');
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('audio/wav');
    expect(ok.headers['cache-control']).toBe('public, max-age=86400');
    expect(ok.body.toString()).toBe('RIFFdata');
    // No Twilio signature header is sent, and /audio still answers 200: this route is not gated
    // by the signature check that /voice and /cr-action apply.
    const headRes = await head_('/audio/greeting.0.wav');
    expect(headRes.status).toBe(200);
    expect(headRes.headers['content-length']).toBe(String(Buffer.byteLength('RIFFdata')));
    expect(headRes.body.length).toBe(0);
    expect((await get_('/audio/Loud.0.WAV')).headers['content-type']).toBe('audio/wav');
    expect((await get_('/audio/missing.wav')).status).toBe(404);
    expect((await get_('/audio/notes.txt')).status).toBe(404);
    // fetch's URL parser collapses a literal `../` before the request is even sent, so these
    // traversal attempts are shaped to survive that normalization and actually reach the
    // server: an escaped `/` inside what would otherwise be a `..` segment.
    expect((await get_('/audio/..%2fpackage.json')).status).toBe(404);
    expect((await get_('/audio/%2e%2e%2fetc%2fpasswd')).status).toBe(404);
    expect((await get_('/audio/sub%2fclip.wav')).status).toBe(404);
    expect((await get_('/audio/%E0%A4%A')).status).toBe(404);
  });

  it('serves a clip when the request carries a content-hash query string', async () => {
    const audioDir = mkdtempSync(join(tmpdir(), 'audio-'));
    const base = await listen(deps({}, audioDir));
    writeFileSync(join(audioDir, 'greeting.0.wav'), Buffer.from('RIFFdata'));
    const res = await get(base, '/audio/greeting.0.wav?v=abc1234567');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('audio/wav');
    expect(res.headers['cache-control']).toBe('public, max-age=86400');
    expect(res.body.toString()).toBe('RIFFdata');
  });
});

describe('routes by voice provider', () => {
  it('answers /voice/twilio at the provider\'s own paths and the legacy /voice at the old ones', async () => {
    const d = deps();
    const base = await listen(d);
    const a = await post(base, '/voice/twilio', { CallSid: 'CA1', From: '+15555550100' });
    expect(a.status).toBe(200);
    expect(a.text).toContain('url="wss://demo.ngrok.app/conversation/twilio?token=');
    expect(a.text).toContain('<Connect action="https://demo.ngrok.app/cr-action/twilio">');
    const token = /token=([0-9a-f]{32})/.exec(a.text)![1]!;
    expect(d.tokens.verify(token, 'CA1')).toBe(true);
    const b = await post(base, '/voice', { CallSid: 'CA2', From: '+15555550100' });
    expect(b.text).toContain('url="wss://demo.ngrok.app/conversation?token=');
    expect(b.text).toContain('<Connect action="https://demo.ngrok.app/cr-action">');
  });

  it('checks the signature over the provider\'s own path, and logs the call by its path', async () => {
    const lines: string[] = [];
    const base = await listen({ ...deps(), log: (l) => lines.push(l) });
    expect((await post(base, '/voice/twilio', { CallSid: 'CA1' }, false)).status).toBe(403);
    expect((await post(base, '/voice/twilio', { CallSid: 'CA1', From: '+15555550199' })).status).toBe(200);
    expect(lines).toContain('/voice/twilio: signature rejected');
    expect(lines).toContain('/voice/twilio CA1 from …0199');
    expect((await post(base, '/voice/twilio', { From: '+15555550199' })).status).toBe(400);
  });

  it('is 404 for a provider that is not enabled or not known, and for a GET', async () => {
    const base = await listen(deps());
    expect((await post(base, '/voice/telnyx', { CallSid: 'x' })).status).toBe(404);
    expect((await post(base, '/cr-action/acme', { CallSid: 'x' })).status).toBe(404);
    expect((await post(base, '/voice/twilio/extra', { CallSid: 'x' })).status).toBe(404);
    expect((await fetch(base + '/voice/twilio')).status).toBe(404);
  });

  it('reconnects through /cr-action/twilio to the provider\'s socket, and through /cr-action to the legacy one', async () => {
    const d = deps();
    const base = await listen(d);
    d.store.create('CA1', { send: () => {}, close: () => {} });
    const r = await post(base, '/cr-action/twilio', { CallSid: 'CA1', CallStatus: 'in-progress', SessionStatus: 'failed' });
    expect(r.status).toBe(200);
    expect(r.text).toContain('url="wss://demo.ngrok.app/conversation/twilio?token=');
    d.store.create('CA2', { send: () => {}, close: () => {} });
    const legacy = await post(base, '/cr-action', { CallSid: 'CA2', CallStatus: 'in-progress', SessionStatus: 'failed' });
    expect(legacy.text).toContain('url="wss://demo.ngrok.app/conversation?token=');
  });

  it('ends a call through /cr-action/twilio and logs the webhook under its own route', async () => {
    const d = deps();
    const base = await listen(d);
    d.store.create('CA1', { send: () => {}, close: () => {} });
    const r = await post(base, '/cr-action/twilio', { CallSid: 'CA1', HandoffData: '{"reasonCode":"completed"}', From: '+15555550199' });
    expect(r.text).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
    const line = readFileSync(join(d.dir, 'CA1.frames.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { dir: string; msg: Record<string, unknown> }).find((l) => l.dir === 'http');
    expect(line?.msg).toMatchObject({ route: '/cr-action/twilio', From: '…0199' });
  });

  it('answers a legacy /cr-action that names no call by hanging up, as it always has', async () => {
    const base = await listen(deps());
    const r = await post(base, '/cr-action', { CallStatus: 'completed' });
    expect(r.status).toBe(200);
    expect(r.text).toContain('<Hangup/>');
  });
});

/** A raw request, so the test controls every header, `Host` included. */
function raw(base: string, method: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  const url = new URL(base + path);
  return new Promise((resolve, reject) => {
    const req = request({ host: url.hostname, port: url.port, path, method, headers }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString('utf8')));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('CONSOLE_LOCAL_ONLY', () => {
  // A stand-in chat, mounted local-only as an app's chat is: answers every /chat route it is handed,
  // so a 404 can only come from the guard.
  const fakeChat: AppRoute = {
    label: 'chat', path: '/chat', localOnly: true,
    handle: async (_req, res, path) => {
      if (!path.startsWith('/chat')) return false;
      res.writeHead(200);
      res.end('chat');
      return true;
    },
  };
  const tunnelled: Array<[string, Record<string, string>]> = [
    ['x-forwarded-for', { 'x-forwarded-for': '203.0.113.9' }],
    ['x-forwarded-proto', { 'x-forwarded-proto': 'https' }],
    ['an ngrok header', { 'ngrok-skip-browser-warning': '1' }],
    ['the public Host', { host: 'demo.ngrok.app' }],
  ];

  it.each(tunnelled)('answers 404 on the console and chat to a request with %s', async (_label, headers) => {
    const d = { ...deps(), bus: new DashboardBus(), routes: [fakeChat] };
    const base = await listen(d);
    for (const [method, path] of [['GET', '/dashboard'], ['GET', '/dashboard/traces'], ['GET', '/chat'], ['POST', '/chat/login'], ['POST', '/chat/turn']] as const) {
      expect((await raw(base, method, path, headers)).status, `${method} ${path}`).toBe(404);
    }
  });

  it('hands a route only the paths that are its own, and the guard calls the same paths its own', async () => {
    const handed: string[] = [];
    const chat: AppRoute = { ...fakeChat, handle: async (_req, res, path) => { handed.push(path); res.writeHead(200); res.end('chat'); return true; } };
    const d = { ...deps(), bus: new DashboardBus(), routes: [chat] };
    const base = await listen(d);
    const tunnel = { 'x-forwarded-for': '203.0.113.9' };
    // Its own: the path itself and anything under it, kept off the tunnel by the guard.
    for (const path of ['/chat', '/chat/', '/chat/login', '/chat?x=1']) {
      expect((await raw(base, 'GET', path, tunnel)).status, `tunnel ${path}`).toBe(404);
      expect((await raw(base, 'GET', path)).body, `direct ${path}`).toBe('chat');
    }
    expect(handed.sort()).toEqual(['/chat', '/chat', '/chat/', '/chat/login']);
    // Not its own: never handed to it, with or without the tunnel, so it cannot answer them.
    handed.length = 0;
    for (const path of ['/chatX', '/chat2/turn', '/%63hat', '/%63hat/login', '//chat', '/CHAT', '/portal/../chat', '/chat%2fturn']) {
      expect((await raw(base, 'GET', path, tunnel)).status, `tunnel ${path}`).toBe(404);
      expect((await raw(base, 'GET', path)).status, `direct ${path}`).toBe(404);
    }
    expect(handed).toEqual([]);
  });

  it('keeps odd spellings of the console off the tunnel or off the console', async () => {
    const d = { ...deps(), bus: new DashboardBus(), routes: [fakeChat] };
    const base = await listen(d);
    const tunnel = { 'x-forwarded-for': '203.0.113.9' };
    // Under /dashboard by name: guarded. Not under it by name: not the console, whatever a decoder might make of it.
    for (const path of ['/dashboard/', '/dashboard/../chat', '/dashboardX', '/%64ashboard', '/portal/../dashboard']) {
      const r = await raw(base, 'GET', path, tunnel);
      expect(r.status, path).toBe(404);
      expect(r.body, path).not.toContain('<html');
    }
    expect((await raw(base, 'GET', '/dashboardX')).status).toBe(404);
  });

  it('serves the console and chat to a direct localhost request', async () => {
    const d = { ...deps(), bus: new DashboardBus(), routes: [fakeChat] };
    const base = await listen(d);
    expect((await raw(base, 'GET', '/dashboard')).status).toBe(200);
    expect((await raw(base, 'GET', '/dashboard/view.js')).status).toBe(200);
    expect(await raw(base, 'GET', '/chat')).toEqual({ status: 200, body: 'chat' });
    expect(await raw(base, 'POST', '/chat/login')).toEqual({ status: 200, body: 'chat' });
  });

  it('serves the console through the tunnel with CONSOLE_LOCAL_ONLY=off', async () => {
    const d = { ...deps({ CONSOLE_LOCAL_ONLY: 'off' }), bus: new DashboardBus(), routes: [fakeChat] };
    const base = await listen(d);
    const headers = { host: 'demo.ngrok.app', 'x-forwarded-for': '203.0.113.9' };
    expect((await raw(base, 'GET', '/dashboard', headers)).status).toBe(200);
    expect((await raw(base, 'GET', '/chat', headers)).status).toBe(200);
  });

  it('leaves the Twilio webhooks and clips reachable through the tunnel', async () => {
    const d = { ...deps(), bus: new DashboardBus(), routes: [fakeChat] };
    const base = await listen(d);
    const r = await post(base, '/voice', { CallSid: 'CA1', From: '+1', To: '+2' });
    expect(r.status).toBe(200);
    const params = { CallSid: 'CA1', CallStatus: 'completed' };
    const body = new URLSearchParams(params).toString();
    const res = await fetch(base + '/cr-action', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-forwarded-for': '203.0.113.9',
        'x-forwarded-proto': 'https',
        'x-twilio-signature': computeTwilioSignature('https://demo.ngrok.app/cr-action', params, TOKEN),
      },
      body,
    });
    expect(res.status).toBe(200);
    // A clip that does not exist is a 404 from the clip route, not the guard: the route still runs.
    writeFileSync(join(d.dir, 'greeting.wav'), Buffer.from('RIFF'));
    expect((await raw(base, 'GET', '/audio/greeting.wav', { host: 'demo.ngrok.app', 'x-forwarded-for': '203.0.113.9' })).status).toBe(200);
  });
});

describe('app route paths', () => {
  const route = (path: string, label = 'r'): AppRoute => ({ label, path, localOnly: false, handle: async () => false });

  it('accepts lowercase letters, digits and hyphens in segments', () => {
    expect(() => validateRoutes([route('/chat'), route('/portal-2'), route('/portal/help-1')])).not.toThrow();
  });

  it.each(['chat', '/', '/chat/', '/Chat', '/chat x', '/chat.html', '/%63hat', '/chat/../x', '/a//b', '/chat?x', '/chat_x', ''])('refuses the path %j', (path) => {
    expect(() => validateRoutes([route(path, 'odd')])).toThrow(/app route "odd": path .* must be/);
  });

  it('refuses a path on or under one the engine serves, and routes that overlap', () => {
    for (const path of ['/dashboard', '/dashboard/x', '/health', '/audio', '/voice', '/cr-action', '/conversation']) {
      expect(() => validateRoutes([route(path)]), path).toThrow(/overlaps/);
    }
    expect(() => validateRoutes([route('/chat', 'a'), route('/chat/more', 'b')])).toThrow(/overlaps route "a"/);
    expect(() => validateRoutes([route('/chat/more', 'a'), route('/chat', 'b')])).toThrow(/overlaps route "a"/);
    expect(() => validateRoutes([route('/chat', 'a'), route('/chatty', 'b')])).not.toThrow();
  });

  it('the request handler refuses bad routes at mount, not at the first request', () => {
    expect(() => createRequestHandler({ ...deps(), routes: [route('/Bad')] })).toThrow(/must be/);
  });
});

describe('clipName', () => {
  it('decodes a well-formed clip name and rejects traversal, wrong extensions, and bad percent-encoding', () => {
    expect(clipName('greeting.0.wav')).toBe('greeting.0.wav');
    expect(clipName('Loud.0.WAV')).toBe('Loud.0.WAV');
    expect(clipName('..%2fpackage.json')).toBeNull();
    expect(clipName('%2e%2e%2fetc%2fpasswd')).toBeNull();
    expect(clipName('sub%2fclip.wav')).toBeNull();
    expect(clipName('notes.txt')).toBeNull();
    expect(clipName('%E0%A4%A')).toBeNull();
  });
});

describe('decideActionTwiml', () => {
  it('hangs up on completed, dials on any other handoff reason, and revokes the token', () => {
    const d = deps();
    d.tokens.mint('CA1');
    expect(decideActionTwiml(d, { CallSid: 'CA1', HandoffData: '{"reasonCode":"completed"}' }).twiml).toContain('<Hangup/>');
    expect(d.tokens.verify('x', 'CA1')).toBe(false);
    expect(decideActionTwiml(d, { CallSid: 'CA2', HandoffData: '{"reasonCode":"live-agent"}' }).twiml).toContain('<Dial>+15551234567</Dial>');
    expect(decideActionTwiml(d, { CallSid: 'CA3', HandoffData: 'not json' }).twiml).toContain('<Dial>');
  });

  it('decides on the reason code alone, whatever else the handoff data carries', () => {
    const d = deps();
    // The end frame also reports completed forms, the unstarted queue and the slots the call
    // collected; those ride through to Twilio untouched and must not change the decision here.
    const data = '{"reasonCode":"billing","completed":["reschedule"],"queued":["cancel"],"slots":{"accountId":"5550 5678"}}';
    const r = decideActionTwiml(d, { CallSid: 'CA1', HandoffData: data });
    expect(r.twiml).toContain('<Dial>+15551234567</Dial>');
    expect(r.note).toBe('dial:billing');
  });

  it('reconnects a live call up to the limit, then apologizes and dials', () => {
    const d = deps();
    d.store.create('CA1', { send: () => {}, close: () => {} });
    const first = decideActionTwiml(d, { CallSid: 'CA1', CallStatus: 'in-progress', SessionStatus: 'failed' });
    expect(first.twiml).toContain('<ConversationRelay');
    const token = /token=([0-9a-f]{32})/.exec(first.twiml)![1]!;
    expect(d.tokens.verify(token, 'CA1')).toBe(true);
    expect(d.store.get('CA1')?.reconnects).toBe(1);
    const second = decideActionTwiml(d, { CallSid: 'CA1', CallStatus: 'in-progress', SessionStatus: 'failed' });
    expect(second.twiml).toContain('<Say>');
    expect(second.twiml).toContain('<Dial>+15551234567</Dial>');
    expect(d.store.get('CA1')?.ended).toBe(true);
  });

  it('hangs up for an unknown or finished call', () => {
    const d = deps();
    expect(decideActionTwiml(d, { CallSid: 'CA9', CallStatus: 'completed' }).twiml).toContain('<Hangup/>');
    d.store.create('CA1', { send: () => {}, close: () => {} });
    d.store.end('CA1');
    expect(decideActionTwiml(d, { CallSid: 'CA1', CallStatus: 'in-progress' }).twiml).toContain('<Hangup/>');
  });

  it('hangs up when the caller hung up', () => {
    const d = deps();
    d.store.create('CA1', { send: () => {}, close: () => {} });
    const token = d.tokens.mint('CA1');
    const result = decideActionTwiml(d, { CallSid: 'CA1', CallStatus: 'completed', SessionStatus: 'completed' });
    expect(result.twiml).toContain('<Hangup/>');
    expect(d.store.get('CA1')?.ended).toBe(true);
    expect(d.tokens.verify(token, 'CA1')).toBe(false);
  });

  it('treats empty HandoffData as absent', () => {
    const d = deps();
    d.store.create('CA1', { send: () => {}, close: () => {} });
    const result = decideActionTwiml(d, { CallSid: 'CA1', HandoffData: '', CallStatus: 'in-progress', SessionStatus: 'failed' });
    expect(result.twiml).toContain('<ConversationRelay');
    expect(result.twiml).not.toContain('<Dial>');
  });
});
