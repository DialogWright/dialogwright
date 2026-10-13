import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { startServer, SERVER_RECORDS, type RunningServer } from './index';
import { loadConfig, type Env } from './config';
import { loadHost, type HostRouting } from './host';
import { FakeRelay } from '../testing/fakeRelay';
import { useTestkit } from '../testing/apps';
import { HeuristicStubClient } from '../jev/heuristicStub';
import type { AuditEntry } from '../audit/types';
import type { ServerMessage } from '../channel/chat/protocol';
import { HOST_APP_PARAMETER } from '../channel/callData';
import { alertCount, liveList, type CallRow } from './dashboard/view.js';

/**
 * Several apps on one server (host.yaml, server/host.ts), end to end over the host fixture
 * (testing/host/host.yaml: the callback and routed fixture apps): a call to each number reaches its
 * app, any other number the default; each app reads its own settings (both name MAIN_LINE, each its
 * own number); each app's traces and audit land in its own folder, each entry naming its app; each
 * app's chat is at /chat/<app id>, the default's at /chat too; and the console lists every app's
 * calls with the app on each row.
 */

useTestkit();

const FIXTURE = fileURLToPath(new URL('../testing/host/host.yaml', import.meta.url));
/** The numbers callers dial, from the server's settings: invented, 555 range. */
const NUMBERS = { CALLBACK_LINE: '+15555550300', SERVICE_LINE: '+15555550311', SERVICE_LINE_ES: '+15555550312' };
const ORIGIN = 'https://www.example.com';
/** A weekday morning in the routed app's time zone, inside its hours (11:00 in New York). */
const OPEN = Date.parse('2026-09-18T15:00:00Z');

const CALLBACK_GREETING = 'Thanks for calling Example Callbacks. I can set up a callback. How can I help?';
const ROUTED_GREETING = 'Thanks for calling Example Service Line. I can take a report of a problem, or check on a request. How can I help?';
const ROUTED_GREETING_ES = 'Gracias por llamar a Example Service Line. Puedo tomar un reporte de un problema, o revisar una solicitud. ¿En qué le puedo ayudar?';

let host: HostRouting;
beforeAll(async () => {
  host = await loadHost(FIXTURE, { ...NUMBERS });
}, 60_000);

let running: RunningServer | null = null;
const dirs: string[] = [];
const relays: FakeRelay[] = [];
afterEach(async () => {
  for (const r of relays.splice(0)) r.close();
  await running?.close();
  running = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function start(extra: Env = {}): Promise<{ base: string; ws: string; dir: string; logs: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'host-e2e-'));
  dirs.push(dir);
  const logs: string[] = [];
  const config = loadConfig({
    PUBLIC_HOST: 'localhost',
    TWILIO_AUTH_TOKEN: 't',
    HANDOFF_NUMBER: '+15551234567',
    PORT: '0',
    SIGNATURE_CHECK: 'off',
    TODAY_OVERRIDE: '2026-09-18',
    TRACE_DIR: join(dir, 'traces'),
    AUDIT_DIR: join(dir, 'audit'),
    AUDIO_DIR: dir,
    NO_INPUT_MS: '0',
    ...extra,
  });
  running = await startServer(config, { host: '127.0.0.1', apps: host, client: new HeuristicStubClient({ todayIso: '2026-09-18' }), log: (l) => logs.push(l), now: () => OPEN });
  return { base: `http://127.0.0.1:${running.port}`, ws: `ws://127.0.0.1:${running.port}`, dir, logs };
}

const form = (params: Record<string, string>) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(params).toString(),
});

const TELNYX_KEY = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

/** The carrier's answer webhook for a call to `to`: the start document. */
async function answer(base: string, callSid: string, to?: string, carrier = 'twilio'): Promise<string> {
  return (await fetch(`${base}/voice/${carrier}`, form({ CallSid: callSid, From: '+15555550110', CallStatus: 'ringing', ...(to !== undefined ? { To: to } : {}) }))).text();
}

/** The socket a start document names, and the parameters it carries. */
function startOf(doc: string, ws: string): { url: string; parameters: Record<string, string> } {
  const m = /url="wss:\/\/localhost(\/conversation\/[a-z]+)\?token=([0-9a-f]{32})"/.exec(doc);
  if (!m) throw new Error(`not a start document: ${doc}`);
  const parameters = Object.fromEntries([...doc.matchAll(/<Parameter name="([^"]+)" value="([^"]*)"\/>/g)].map((p) => [p[1]!, p[2]!]));
  return { url: `${ws}${m[1]}?token=${m[2]}`, parameters };
}

/** A whole call's start: answered for `to`, the socket opened, the setup sent (with what the carrier echoes back), the first line heard. */
async function call(s: { base: string; ws: string }, callSid: string, to?: string, setupTo: string | undefined = to, from?: string): Promise<{ relay: FakeRelay; first: string; parameters: Record<string, string> }> {
  const { url, parameters } = startOf(await answer(s.base, callSid, to), s.ws);
  const relay = await FakeRelay.connect(url);
  relays.push(relay);
  relay.setup(callSid, `VX-${callSid}`, { ...(setupTo !== undefined ? { to: setupTo } : { to: '' }), ...(from !== undefined ? { from } : {}), customParameters: parameters });
  const [first] = await relay.waitForTexts(1);
  return { relay, first: first!, parameters };
}

const auditOf = (dir: string): AuditEntry[] => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.jsonl')).flatMap((f) => readFileSync(join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as AuditEntry));
};

describe('a host of two apps', () => {
  it('sends a call to each number to its app, and a call to any other number, or none, to the default', async () => {
    const s = await start();
    const one = await call(s, 'CA0000000000000000000000000000cb01', NUMBERS.CALLBACK_LINE);
    expect(one.first).toBe(CALLBACK_GREETING);
    expect(one.parameters[HOST_APP_PARAMETER]).toBe('callback');
    const two = await call(s, 'CA0000000000000000000000000000sl01', NUMBERS.SERVICE_LINE);
    expect(two.first).toBe(ROUTED_GREETING);
    expect(two.parameters[HOST_APP_PARAMETER]).toBe('routed');
    // The second service line reaches the same app, whose voice.numbers (env.SPANISH_LINE, from its own
    // settings file) starts the call in Spanish: the start document asks for it.
    const es = await call(s, 'CA0000000000000000000000000000sl02', NUMBERS.SERVICE_LINE_ES);
    expect(es.parameters.locale).toBe('es');
    expect(es.first).toBe(ROUTED_GREETING_ES);
    expect(two.parameters.locale).toBe('en-US');
    expect(s.logs).toContain('app routed: numbers by language: …0312 (SPANISH_LINE) starts in es; any other number starts in en-US');
    const other = await call(s, 'CA0000000000000000000000000000ot01', '+15555550999');
    expect(other.first).toBe(CALLBACK_GREETING);
    const none = await call(s, 'CA0000000000000000000000000000no01', undefined);
    expect(none.first).toBe(CALLBACK_GREETING);
    expect(running!.store.get('CA0000000000000000000000000000sl01')!.session.appId).toBe('routed');
    expect(running!.store.get('CA0000000000000000000000000000ot01')!.session.appId).toBe('callback');
    expect(s.logs).toContain('app routed: numbers SERVICE_LINE, SERVICE_LINE_ES; its own AFTER_HOURS_DESK, MAIN_LINE, SPANISH_LINE, VIP_DESK');
    expect(s.logs.some((l) => /\/voice\/twilio CA0000000000000000000000000000sl01 from \S+ \(app routed\)$/.test(l))).toBe(true);
  });

  it('telnyx: sends a call to each number to its app, the setup reading the number called where Telnyx puts it', async () => {
    const s = await start({ VOICE_PROVIDERS: 'twilio,telnyx', TELNYX_PUBLIC_KEY: TELNYX_KEY });
    const { url, parameters } = startOf(await answer(s.base, 'v3:host-telnyx-one', NUMBERS.SERVICE_LINE, 'telnyx'), s.ws);
    expect(url).toContain('/conversation/telnyx?token=');
    expect(parameters[HOST_APP_PARAMETER]).toBe('routed');
    const relay = await FakeRelay.connect(url);
    relays.push(relay);
    // As Telnyx sends it: no `to`, the number called among the custom parameters.
    relay.setup('v3:host-telnyx-one', 'VX-t1', { to: null, customParameters: { ...parameters, telnyx_call_to: NUMBERS.SERVICE_LINE } });
    expect((await relay.waitForTexts(1))[0]).toBe(ROUTED_GREETING);
    // A setup with no app named reads the number called from Telnyx's own parameter, and reaches the app.
    // Its language is the start document's (voice.numbers, chosen as the call is answered): a setup that
    // carries none of its parameters starts in the app's default, as a number written out always has.
    const token = running!.tokens.mint('v3:host-telnyx-two', 'telnyx') as string;
    const second = await FakeRelay.connect(`${s.ws}/conversation/telnyx?token=${token}`);
    relays.push(second);
    second.setup('v3:host-telnyx-two', 'VX-t2', { to: null, customParameters: { telnyx_call_to: NUMBERS.SERVICE_LINE_ES } });
    expect((await second.waitForTexts(1))[0]).toBe(ROUTED_GREETING);
    expect(running!.store.get('v3:host-telnyx-two')!.session.appId).toBe('routed');
    // The answer to that number on Telnyx asks for Spanish, and a setup with the document's parameters starts in it.
    const es = startOf(await answer(s.base, 'v3:host-telnyx-three', NUMBERS.SERVICE_LINE_ES, 'telnyx'), s.ws);
    expect(es.parameters.locale).toBe('es');
    const third = await FakeRelay.connect(es.url);
    relays.push(third);
    third.setup('v3:host-telnyx-three', 'VX-t3', { to: null, customParameters: { ...es.parameters, telnyx_call_to: NUMBERS.SERVICE_LINE_ES } });
    expect((await third.waitForTexts(1))[0]).toBe(ROUTED_GREETING_ES);
    // The server says so of the setup that came without the document's parameters, once, with no number in it; of the others, nothing.
    const missing = s.logs.filter((l) => l.includes('carries no locale parameter'));
    expect(missing).toEqual(["v3:host-telnyx-two: the setup carries no locale parameter, so the call starts in en-US: the carrier did not hand back the start document's parameters, where the language (voice.numbers) is chosen"]);
    expect(missing.join('\n')).not.toMatch(/\d{4}/);
  });

  it('starts the call in the app the answer chose, whatever number the setup carries, and by the setup\'s number when the answer named none', async () => {
    const s = await start();
    // The setup names another number (or none): the app the answer webhook chose stands.
    const named = await call(s, 'CA0000000000000000000000000000sl03', NUMBERS.SERVICE_LINE, '');
    expect(named.first).toBe(ROUTED_GREETING);
    // A start document without the app's id (one written before it, or a carrier that drops it): the setup's number decides.
    const token = running!.tokens.mint('CA0000000000000000000000000000sl04', 'twilio') as string;
    const relay = await FakeRelay.connect(`${s.ws}/conversation/twilio?token=${token}`);
    relays.push(relay);
    relay.setup('CA0000000000000000000000000000sl04', 'VX-sl04', { to: NUMBERS.SERVICE_LINE });
    expect((await relay.waitForTexts(1))[0]).toBe(ROUTED_GREETING);
  });

  it('lets an app\'s code read its own settings with ctx.env: the routed app\'s vip predicate finds VIP_NUMBERS in its own settings file, which the server\'s settings and process.env lack', async () => {
    expect(process.env.VIP_NUMBERS).toBeUndefined();
    // Its YAML names no VIP_NUMBERS, so the server reads none for it: only its code does, by name.
    expect(host.get('routed').env.VIP_NUMBERS).toBeUndefined();
    expect(host.get('routed').settings?.VIP_NUMBERS).toBe('+15555550177');
    expect(host.get('callback').settings?.VIP_NUMBERS).toBeUndefined();
    const s = await start();
    const vip = await call(s, 'CA0000000000000000000000000000sl07', NUMBERS.SERVICE_LINE, NUMBERS.SERVICE_LINE, '+15555550177');
    expect(vip.first).toBe('Welcome back. Let me connect you to your team.');
    const other = await call(s, 'CA0000000000000000000000000000sl08', NUMBERS.SERVICE_LINE, NUMBERS.SERVICE_LINE, '+15555550178');
    expect(other.first).toBe(ROUTED_GREETING);
    // What its own file sets beyond its YAML is named, as its code's, never as a fault.
    expect(s.logs).toContain('app routed: its own settings file also sets VIP_NUMBERS, not named by its YAML: available to its code through ctx.env');
    expect(s.logs.some((l) => l.startsWith('WARNING') && l.includes('VIP_NUMBERS'))).toBe(false);
  });

  it('puts each app\'s handoff through to its own MAIN_LINE: two apps\' same-named variables stay separate', async () => {
    const s = await start();
    await call(s, 'CA0000000000000000000000000000cb02', NUMBERS.CALLBACK_LINE);
    await call(s, 'CA0000000000000000000000000000sl05', NUMBERS.SERVICE_LINE);
    const handoff = (callSid: string) => fetch(`${s.base}/cr-action/twilio`, form({ CallSid: callSid, CallStatus: 'in-progress', SessionStatus: 'ended', HandoffData: JSON.stringify({ reasonCode: 'needs-human' }) })).then((r) => r.text());
    expect(await handoff('CA0000000000000000000000000000cb02')).toContain('+15555550101');
    expect(await handoff('CA0000000000000000000000000000sl05')).toContain('+15555550201');
    // A call put through with no decision (a server stopping, say) goes to its own app's default too.
    await running!.drain(0);
    expect(await answer(s.base, 'CA0000000000000000000000000000sl06', NUMBERS.SERVICE_LINE)).toContain('+15555550201');
    expect(await answer(s.base, 'CA0000000000000000000000000000cb03', NUMBERS.CALLBACK_LINE)).toContain('+15555550101');
    expect(s.logs).toContain('app callback: transfer targets: PRIORITY_LINE, CALLBACK_DESK, SECURITY_DESK, MAIN_LINE; default MAIN_LINE');
    expect(s.logs).toContain('app routed: transfer targets: AFTER_HOURS_DESK, VIP_DESK, MAIN_LINE; default MAIN_LINE');
  });

  it('keeps each app\'s records in its own folder, each audit entry naming its app, and the console\'s in the server\'s own', async () => {
    const s = await start();
    const a = await call(s, 'CA0000000000000000000000000000cb04', NUMBERS.CALLBACK_LINE);
    const b = await call(s, 'CA0000000000000000000000000000sl07', NUMBERS.SERVICE_LINE);
    a.relay.close();
    b.relay.close();
    await running!.close();
    running = null;
    expect(existsSync(join(s.dir, 'traces', 'callback', 'CA0000000000000000000000000000cb04.jsonl'))).toBe(true);
    expect(existsSync(join(s.dir, 'traces', 'routed', 'CA0000000000000000000000000000sl07.jsonl'))).toBe(true);
    expect(existsSync(join(s.dir, 'traces', 'routed', 'CA0000000000000000000000000000cb04.jsonl'))).toBe(false);
    const callback = auditOf(join(s.dir, 'audit', 'callback'));
    const routed = auditOf(join(s.dir, 'audit', 'routed'));
    expect(new Set(callback.map((e) => e.callId))).toEqual(new Set(['CA0000000000000000000000000000cb04']));
    expect(new Set(routed.map((e) => e.callId))).toEqual(new Set(['CA0000000000000000000000000000sl07']));
    expect(callback.every((e) => e.app === 'callback')).toBe(true);
    expect(routed.every((e) => e.app === 'routed')).toBe(true);
    // Nothing of a call in the server's own folder, nor beside the apps' folders.
    expect(auditOf(join(s.dir, 'audit', SERVER_RECORDS))).toEqual([]);
    expect(readdirSync(join(s.dir, 'audit')).sort()).toEqual([SERVER_RECORDS, 'callback', 'routed']);
  });

  it('serves each app\'s chat at /chat/<app id>, the default\'s at /chat too, and refuses a path that names no app', async () => {
    const s = await start({ CHAT: 'on', CHAT_ALLOWED_ORIGINS: ORIGIN, DASHBOARD: 'off' });
    const greeting = async (path: string): Promise<string> => {
      const ws = new WebSocket(`${s.ws}${path}`, { origin: ORIGIN });
      const received: ServerMessage[] = [];
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('unexpected-response', (_q, r) => reject(new Error(`HTTP ${r.statusCode}`)));
      });
      ws.on('message', (d) => received.push(JSON.parse(d.toString()) as ServerMessage));
      ws.send(JSON.stringify({ type: 'start', v: 1 }));
      const deadline = Date.now() + 4000;
      while (!received.some((m) => m.type === 'say') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      ws.close();
      const say = received.find((m) => m.type === 'say');
      return say && say.type === 'say' ? say.text : '';
    };
    expect(await greeting('/chat/routed')).toBe('Hi, this is Example Service Line. I can take a report of a problem, or check on a request. What can I help with?');
    expect(await greeting('/chat/callback')).toBe('Hi, this is Example Callbacks. I can set up a callback. What can I help with?');
    expect(await greeting('/chat')).toBe('Hi, this is Example Callbacks. I can set up a callback. What can I help with?');
    await expect(greeting('/chat/nobody')).rejects.toThrow('HTTP 404');
    expect(s.logs).toContain(`chat: /chat (callback), /chat/callback, /chat/routed for ${ORIGIN}, sign-in none`);
  });

  it('lists every app\'s calls in the console, with the app on each row, and one app\'s with ?app=', async () => {
    const s = await start();
    const a = await call(s, 'CA0000000000000000000000000000cb05', NUMBERS.CALLBACK_LINE);
    const b = await call(s, 'CA0000000000000000000000000000sl08', NUMBERS.SERVICE_LINE);
    a.relay.close();
    b.relay.close();
    const rows = (await (await fetch(`${s.base}/dashboard/traces`)).json()) as { callSid: string; app?: string; appName?: string }[];
    expect(rows.map((r) => [r.callSid, r.app, r.appName]).sort()).toEqual([
      ['CA0000000000000000000000000000cb05', 'callback', 'Example Callbacks'],
      ['CA0000000000000000000000000000sl08', 'routed', 'Example Service Line'],
    ]);
    const one = (await (await fetch(`${s.base}/dashboard/traces?app=routed`)).json()) as { callSid: string }[];
    expect(one.map((r) => r.callSid)).toEqual(['CA0000000000000000000000000000sl08']);
    // A replay is read from its own app's folder, with its own app's lines.
    const replay = (await (await fetch(`${s.base}/dashboard/traces/CA0000000000000000000000000000sl08`)).json()) as { app?: string; records: { spokenText: string }[] };
    expect(replay.app).toBe('routed');
    expect(replay.records[0]!.spokenText).toBe(ROUTED_GREETING);
    // Addressed by its app, as its row says: the same id is not looked for in another app's records.
    expect((await fetch(`${s.base}/dashboard/traces/CA0000000000000000000000000000sl08?app=routed`)).status).toBe(200);
    expect((await fetch(`${s.base}/dashboard/traces/CA0000000000000000000000000000sl08?app=callback`)).status).toBe(404);
    // The page knows every app's console words and names; the live feed names each call's app.
    const page = await (await fetch(`${s.base}/dashboard`)).text();
    expect(page).toContain('"apps":[{"id":"callback","name":"Example Callbacks"');
    const seen: { type: string; app?: string }[] = [];
    running!.bus!.subscribe((e) => seen.push(e as { type: string; app?: string }))();
    // The bus keeps every call it saw start (the Live list), each call_started with its app.
    expect(seen.filter((e) => e.type === 'call_started')).toMatchObject([
      { type: 'call_started', callSid: 'CA0000000000000000000000000000cb05', app: 'callback' },
      { type: 'call_started', callSid: 'CA0000000000000000000000000000sl08', app: 'routed' },
    ]);
  });

  it('shows both apps\' calls in progress on the console\'s Live list, raises an alert when one turns frustrated, and finds them on the Calls page by the last four and by how they ended', async () => {
    const s = await start();
    const a = await call(s, 'CA0000000000000000000000000000cb06', NUMBERS.CALLBACK_LINE, NUMBERS.CALLBACK_LINE, '+15555550144');
    const b = await call(s, 'CA0000000000000000000000000000sl09', NUMBERS.SERVICE_LINE, NUMBERS.SERVICE_LINE, '+15555550155');
    // The Live list's feed, as the console's home page reads it: every row first, then each change.
    const ac = new AbortController();
    const res = await fetch(`${s.base}/dashboard/events?view=calls`, { signal: ac.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const rows = new Map<string, CallRow>();
    let read = 0;
    const take = (): void => {
      const blocks = buf.split('\n\n').slice(0, -1);
      for (const block of blocks.slice(read)) {
        const event = /^event: (\S+)$/m.exec(block)?.[1];
        const data = block.split('data: ')[1];
        if (event === 'rows') for (const r of (JSON.parse(data!) as { rows: CallRow[] }).rows) rows.set(r.callSid!, r);
        if (event === 'row') { const r = JSON.parse(data!) as CallRow; rows.set(r.callSid!, r); }
      }
      read = blocks.length;
    };
    const until = async (ok: () => boolean): Promise<void> => {
      const deadline = Date.now() + 4000;
      while (!ok() && Date.now() < deadline) { buf += dec.decode((await reader.read()).value, { stream: true }); take(); }
      expect(ok()).toBe(true);
    };
    try {
      await until(() => rows.size === 2);
      const shown = () => liveList([...rows.values()], Date.now(), null);
      expect(shown().map((r) => [r.callSid, r.app, r.from, r.channel, r.provider, r.status]).sort()).toEqual([
        ['CA0000000000000000000000000000cb06', 'callback', '…0144', 'voice', 'twilio', 'on-track'],
        ['CA0000000000000000000000000000sl09', 'routed', '…0155', 'voice', 'twilio', 'on-track'],
      ]);
      expect(alertCount(shown())).toBe(0);
      // The service line's caller loses patience: the row turns frustrated, and the alerts count it.
      b.relay.prompt('this is ridiculous, I already told you');
      await until(() => rows.get('CA0000000000000000000000000000sl09')?.status === 'frustrated');
      expect(alertCount(shown())).toBe(1);
      expect(JSON.stringify([...rows.values()])).not.toContain('+1555');
    } finally {
      ac.abort();
      await reader.cancel().catch(() => {});
    }
    // Both hang up: the carrier's action webhook says so.
    for (const [relay, sid] of [[a.relay, 'CA0000000000000000000000000000cb06'], [b.relay, 'CA0000000000000000000000000000sl09']] as const) {
      relay.close();
      await fetch(`${s.base}/cr-action/twilio`, form({ CallSid: sid, CallStatus: 'completed', SessionStatus: 'completed' }));
    }
    const calls = async (q: string) => ((await (await fetch(`${s.base}/dashboard/calls${q}`)).json()) as { rows: (CallRow & { appName?: string })[] }).rows;
    const deadline = Date.now() + 4000;
    while ((await calls('?ending=hangup')).length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect((await calls('?last4=0155')).map((r) => [r.callSid, r.app, r.appName, r.ending?.kind])).toEqual([['CA0000000000000000000000000000sl09', 'routed', 'Example Service Line', 'hangup']]);
    expect((await calls('?ending=hangup')).map((r) => r.callSid).sort()).toEqual(['CA0000000000000000000000000000cb06', 'CA0000000000000000000000000000sl09']);
    expect(await calls('?ending=person')).toEqual([]);
    expect((await calls('?app=callback&last4=0144')).map((r) => r.callSid)).toEqual(['CA0000000000000000000000000000cb06']);
  });
});
