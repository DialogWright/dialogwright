import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type RunningServer } from './index';
import { loadConfig, type Env } from './config';
import { hostRouting, type HostedApp } from './host';
import { verifyChain } from '../audit/verify';
import { FakeRelay } from '../testing/fakeRelay';
import { auditRowsIn, BOOKING, CALLER, DAY, done, text, yesJev } from '../testing/converse/chat';
import { converseFixture } from '../testing/converse/app';
import { fakeModel } from '../converse/model/fake';
import type { ConverseApp } from '../converse/app';
import type { ConverseModel, ModelEvent, ModelRequest } from '../converse/model/types';
import type { JevClient } from '../jev/types';
import { registerApp, resetAppsForTest } from '../core/app/registry';
import { callbackApp } from '../testing/callback/app';

/**
 * A converse app's phone call over a real server and socket (FakeRelay), on Twilio and on Telnyx: the greeting,
 * a booking read back and confirmed, the end; a yes said over the read-back that confirms nothing; a restart in
 * the middle of a turn, on which the new server asks the model again once and the booking is made once; and a
 * scripted app's call on the same server, as it was.
 */

const TELNYX_PUBLIC_KEY = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const GREETING = 'Example Visits, how can I help?';
// On a call the caller's last four are said digit by digit (converse/speakable.ts).
const READ_BACK = "A visit Tuesday, January 15, 9 to 12 for Sam Example, on the number you're calling from, ending in 0 1 2 3. Is that right?";
const CLOSING = 'Thanks for getting in touch. Goodbye.';

const servers: RunningServer[] = [];
const relays: FakeRelay[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const r of relays.splice(0)) r.close();
  for (const s of servers.splice(0)) await s.close().catch(() => {});
  await new Promise((r) => setTimeout(r, 20));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  resetAppsForTest();
});

type Carrier = 'twilio' | 'telnyx';

function folder(): string {
  const d = mkdtempSync(join(tmpdir(), 'converse-voice-'));
  dirs.push(d);
  return d;
}

function settings(dir: string, carrier: Carrier, extra: Record<string, string> = {}): Env {
  return {
    PUBLIC_HOST: 'localhost', VOICE_PROVIDERS: carrier, SIGNATURE_CHECK: 'off', PORT: '0', HANDOFF_NUMBER: '+15555550199',
    ...(carrier === 'telnyx' ? { TELNYX_PUBLIC_KEY } : { TWILIO_AUTH_TOKEN: 't' }),
    TRACE_DIR: join(dir, 'traces'), AUDIT_DIR: join(dir, 'audit'), AUDIO_DIR: dir, DASHBOARD: 'off', JEV_CLIENT: 'stub', NO_INPUT_MS: '0',
    ...extra,
  };
}

async function boot(app: ConverseApp, model: ConverseModel, env: Env, jev: JevClient = yesJev()): Promise<{ server: RunningServer; base: string; logs: string[] }> {
  const logs: string[] = [];
  const apps = hostRouting({ apps: [{ id: app.id, app, dir: app.dir, env, own: [], ignored: [] }], numbers: [], defaultApp: app.id, env });
  const server = await startServer(loadConfig(env), { host: '127.0.0.1', client: jev, log: (l) => logs.push(l), env, apps, converseModel: () => model });
  servers.push(server);
  return { server, base: `http://127.0.0.1:${server.port}`, logs };
}

const form = (params: Record<string, string>): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(params).toString(),
});

/** The socket a start document names, on the server under test (the document says wss://localhost). */
function socketUrl(doc: string, base: string): string {
  const m = /url="wss:\/\/localhost(\/conversation\/[a-z]+)\?token=([0-9a-f]{32})"/.exec(doc);
  if (!m) throw new Error(`not a start document: ${doc}`);
  return `${base.replace('http', 'ws')}${m[1]}?token=${m[2]}`;
}

/** The carrier's socket for the call, its setup in the carrier's own shape (Telnyx's: callControlId, from and to null). */
async function connect(url: string, carrier: Carrier, callId: string, from = CALLER, to = '+15555550101'): Promise<FakeRelay> {
  const relay = await FakeRelay.connect(url);
  relays.push(relay);
  if (carrier === 'telnyx') {
    relay.send({
      type: 'setup', from: null, to: null, direction: null, callControlId: callId, callSid: '5e9fcc12-0000-4000-8000-000000000000',
      callStatus: 'active', customParameters: { telnyx_call_from: from, telnyx_call_to: to }, sessionId: '05ff737c-0000-4000-8000-000000000000',
    });
  } else {
    relay.setup(callId, `VX-${callId}`, { from, to });
  }
  return relay;
}

/** A call answered and its socket set up, with what the server sent so far. */
async function call(base: string, carrier: Carrier, callId: string, to = '+15555550101'): Promise<FakeRelay> {
  const doc = await (await fetch(`${base}/voice/${carrier}`, form({ CallSid: callId, From: CALLER, To: to, CallStatus: 'ringing' }))).text();
  return connect(socketUrl(doc, base), carrier, callId, CALLER, to);
}

/** The text frames that end a reply (`last: true`). */
const finals = (relay: FakeRelay): string[] => relay.received.filter((m) => m.type === 'text' && m.last === true).map((m) => (m.token as string).trimEnd());

/** Sends the caller's words, and waits for the reply's last line; returns it. */
async function say(relay: FakeRelay, words: string): Promise<string> {
  const before = finals(relay).length;
  relay.prompt(words);
  await relay.waitFor(() => finals(relay).length > before, 4000);
  return finals(relay).at(-1)!;
}

/** The call up to the booking read back: the greeting, a day asked about, a window and a name given. */
async function upToReadBack(relay: FakeRelay): Promise<void> {
  await relay.waitFor(() => finals(relay).length >= 1);
  expect(finals(relay)).toEqual([GREETING]);
  expect(await say(relay, `Is there a visit free on ${DAY}?`)).toBe('Which would suit you?');
  expect(await say(relay, 'The morning please, for Sam Example, on this number.')).toBe(READ_BACK);
}

/** Telnyx's report that it played `text` (its agentSpeaking and tokensPlayed). */
function played(relay: FakeRelay, text: string): void {
  relay.send({ type: 'info', name: 'agentSpeaking', value: 'on' });
  relay.send({ type: 'info', name: 'tokensPlayed', value: text });
}

const auditOf = (dir: string): ReturnType<typeof auditRowsIn> => auditRowsIn(join(dir, 'audit', 'converse'));

describe.each(['twilio', 'telnyx'] as const)('a converse app\'s call on %s', (carrier) => {
  const callId = carrier === 'telnyx' ? 'v3:converse-voice-telnyx-1' : 'CAconversevoice00000000000000001';

  it('a call is greeted, books a visit after the read-back and a yes, and ends', async () => {
    const dir = folder();
    const { app, booked } = converseFixture();
    const { base } = await boot(app, fakeModel(BOOKING), settings(dir, carrier));
    const relay = await call(base, carrier, callId);
    await upToReadBack(relay);
    // Each reply streamed: its sentences before its last line, all interruptible.
    const texts = relay.received.filter((m) => m.type === 'text');
    expect(texts.slice(1, 4).map((m) => [(m.token as string), m.last, m.interruptible])).toEqual([
      ['Let me look. ', false, true], ['We have the morning, 9 to 12, or the afternoon. ', false, true], ['Which would suit you?', true, true],
    ]);
    expect(await say(relay, 'yes')).toBe('You are booked for Tuesday morning.');
    expect(booked).toHaveLength(1);
    relay.prompt("that's all, thanks");
    await relay.waitFor(() => finals(relay).at(-1) === CLOSING);
    if (carrier === 'telnyx') played(relay, CLOSING);
    const end = await relay.waitFor((m) => m.type === 'end');
    expect(JSON.parse(end.handoffData as string)).toEqual({ reasonCode: 'completed', completed: ['book'] });
    relay.assertKnownTypes();
    await new Promise((r) => setTimeout(r, 50));
    // The audit is one chain, the call's rows on the voice channel, its end recorded.
    const auditDir = join(dir, 'audit', 'converse');
    for (const f of readdirSync(auditDir).filter((n) => n.endsWith('.jsonl'))) expect(verifyChain(join(auditDir, f))).toMatchObject({ ok: true });
    const rows = auditOf(dir).filter((r) => r.callId === callId) as unknown as { type: string; channel: string; detail: Record<string, unknown> }[];
    expect(rows.every((r) => r.channel === 'voice')).toBe(true);
    expect(rows.filter((r) => r.type === 'confirmed').map((r) => r.detail.action)).toEqual(['book']);
    expect(rows.at(-1)).toMatchObject({ type: 'call_ended', detail: { reason: 'completed' } });
    const stem = callId.replace(/[^A-Za-z0-9_-]/g, '_');
    const trace = readFileSync(join(dir, 'traces', 'converse', `${stem}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(trace.length).toBe(5);
    expect(trace.every((r) => r.kind === 'converse' && r.sessionId === callId)).toBe(true);
    // The frame log: the lines said, the end by its reason and the actions done.
    const frames = readFileSync(join(dir, 'traces', 'converse', `${stem}.frames.jsonl`), 'utf8');
    expect(frames).toContain('You are booked for Tuesday morning.');
    expect(frames).not.toContain('+15555550123');
  }, 20_000);

  it('a yes over the read-back confirms nothing', async () => {
    const dir = folder();
    const { app, booked } = converseFixture();
    const model = fakeModel([...BOOKING.slice(0, 3), [text('Shall I read it again?'), done()]]);
    const { base } = await boot(app, model, settings(dir, carrier));
    const relay = await call(base, carrier, callId);
    await upToReadBack(relay);
    if (carrier === 'twilio') relay.interrupt('A visit Tuesday, January 15,', 900);
    else {
      played(relay, 'A visit Tuesday, January 15,');
      relay.send({ type: 'info', name: 'clientSpeaking', value: 'on' });
    }
    expect(await say(relay, 'yes')).toBe('Shall I read it again?');
    expect(booked).toEqual([]);
    expect(JSON.stringify(model.requests.at(-1)!.messages)).toContain('The caller spoke over the read-back before it finished, so it is not confirmed.');
    await new Promise((r) => setTimeout(r, 50));
    expect(auditOf(dir).filter((r) => r.type === 'confirmed')).toEqual([]);
  }, 20_000);

  it('a restart after a yes over a read-back heard in part confirms nothing when asked again', async () => {
    const dir = folder();
    const env = settings(dir, carrier, { SESSION_STORE: `file:${join(dir, 'sessions')}` });
    const { app, booked } = converseFixture();
    let asked!: () => void;
    const waiting = new Promise<void>((r) => (asked = r));
    const script = fakeModel(BOOKING.slice(0, 3));
    let n = 0;
    const firstModel: ConverseModel = {
      id: 'first',
      stream: (req, signal) => (n++ < 3 ? script.stream(req, signal) : (async function* (): AsyncIterable<ModelEvent> {
        asked();
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        yield { type: 'error', kind: 'timeout', detail: 'aborted' };
      })()),
    };
    const first = await boot(app, firstModel, env);
    const relay = await call(first.base, carrier, callId);
    await upToReadBack(relay);
    if (carrier === 'twilio') relay.interrupt('A visit Tuesday, January 15,', 900);
    else {
      played(relay, 'A visit Tuesday, January 15,');
      relay.send({ type: 'info', name: 'clientSpeaking', value: 'on' });
    }
    relay.prompt('yes');
    await waiting;
    const calls = join(dir, 'sessions', 'calls');
    const file = join(calls, readdirSync(calls)[0]!);
    const saved = readFileSync(file, 'utf8');
    expect(JSON.parse(saved)).toMatchObject({ turnWords: 'yes', turnHeard: { cutIn: true, spokeBefore: false } });
    relay.close();
    await new Promise((r) => setTimeout(r, 50));
    await first.server.close();
    servers.splice(servers.indexOf(first.server), 1);
    writeFileSync(file, saved);

    const second = fakeModel([[text('Shall I read it again?'), done()]]);
    const next = await boot(app, second, env);
    const doc = await (await fetch(`${next.base}/cr-action/${carrier}`, form({ CallSid: callId, CallStatus: 'in-progress', SessionStatus: 'failed' }))).text();
    const again = await connect(socketUrl(doc, next.base), carrier, callId);
    await again.waitFor(() => finals(again).length >= 1, 4000);
    expect(finals(again)).toEqual(['Shall I read it again?']);
    expect(booked).toEqual([]);
    expect(JSON.stringify(second.requests[0]!.messages)).toContain('The caller spoke over the read-back before it finished, so it is not confirmed.');
  }, 20_000);

  it('a restart mid-turn asks the model again once', async () => {
    const dir = folder();
    const env = settings(dir, carrier, { SESSION_STORE: `file:${join(dir, 'sessions')}` });
    const { app, booked, calendar } = converseFixture();
    // The first server's model: the booking up to its read-back, then, after the yes, an answer that never comes.
    let asked!: () => void;
    const waiting = new Promise<void>((r) => (asked = r));
    const hangs: ConverseModel = {
      id: 'hangs',
      async *stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
        void req;
        asked();
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        yield { type: 'error', kind: 'timeout', detail: 'aborted' };
      },
    };
    const script = fakeModel(BOOKING.slice(0, 3));
    let n = 0;
    const firstModel: ConverseModel = { id: 'first', stream: (req, signal) => (n++ < 3 ? script.stream(req, signal) : hangs.stream(req, signal)) };
    const first = await boot(app, firstModel, env);
    const relay = await call(first.base, carrier, callId);
    await upToReadBack(relay);
    relay.prompt('yes');
    await waiting;
    expect(booked).toHaveLength(1);
    // What the store holds as the turn runs: the call from before the yes, with its words to ask again.
    const calls = join(dir, 'sessions', 'calls');
    const file = join(calls, readdirSync(calls)[0]!);
    const saved = readFileSync(file, 'utf8');
    expect(JSON.parse(saved)).toMatchObject({ schema: 'converse-1', turnWords: 'yes', session: { kind: 'converse', pending: { action: 'book' } } });
    // The server goes away with the turn running (as if killed: the store keeps what it held then).
    relay.close();
    await new Promise((r) => setTimeout(r, 50));
    await first.server.close();
    servers.splice(servers.indexOf(first.server), 1);
    writeFileSync(file, saved);

    const second = fakeModel([[text('You are booked for Tuesday morning.'), done()]]);
    const next = await boot(app, second, env);
    const doc = await (await fetch(`${next.base}/cr-action/${carrier}`, form({ CallSid: callId, CallStatus: 'in-progress', SessionStatus: 'failed' }))).text();
    const again = await connect(socketUrl(doc, next.base), carrier, callId);
    await again.waitFor(() => finals(again).length >= 1, 4000);
    expect(finals(again)).toEqual(['You are booked for Tuesday morning.']);
    expect(second.requests).toHaveLength(1);
    // The yes was asked again: the booking's code ran twice under one key, and the calendar booked it once.
    expect(booked).toHaveLength(2);
    expect(booked[1]!.key).toBe(booked[0]!.key);
    expect((calendar as unknown as { bookings: unknown[] }).bookings).toHaveLength(1);
    const results = second.requests[0]!.messages.flatMap((m) => m.content).filter((c) => c.type === 'tool_result');
    expect(results.at(-1)).toMatchObject({ content: expect.stringContaining('book: already booked') });
  }, 20_000);
});

describe('a converse app\'s call on telnyx: the frame log', () => {
  it('a report of a line played is masked as the trace masks the line', async () => {
    const dir = folder();
    const { app } = converseFixture();
    const { base } = await boot(app, fakeModel(BOOKING), settings(dir, 'telnyx'));
    const callId = 'v3:converse-voice-telnyx-masked';
    const relay = await call(base, 'telnyx', callId);
    await upToReadBack(relay);
    played(relay, READ_BACK);
    expect(await say(relay, 'yes')).toBe('You are booked for Tuesday morning.');
    await new Promise((r) => setTimeout(r, 50));
    const frames = readFileSync(join(dir, 'traces', 'converse', `${callId.replace(/[^A-Za-z0-9_-]/g, '_')}.frames.jsonl`), 'utf8');
    // The caller's own words are kept as they said them (as the trace keeps them); the line's, as the trace masks them.
    const lines = frames.trim().split('\n').filter((l) => l.includes('tokensPlayed') || l.includes('"dir":"out"'));
    expect(lines.some((l) => l.includes('tokensPlayed') && l.includes('<11 chars>'))).toBe(true);
    expect(lines.filter((l) => l.includes('Sam Example'))).toEqual([]);
  }, 20_000);
});

describe('a converse app\'s call on telnyx: a line reported while its turn runs', () => {
  it('a report of a line whose turn still runs keeps none of the turn\'s masked values', async () => {
    const dir = folder();
    const { app } = converseFixture();
    // The lookup waits until the test lets it go: the line before it is reported played meanwhile.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const lookup = app.tools.availability!;
    app.tools.availability = async (p, ctx) => (await held, lookup(p, ctx));
    const line = `Let me look at ${DAY}.`;
    const model = fakeModel([[text(`${line} `), { type: 'tool_call', id: 'c1', name: 'availability', args: { day: DAY } }, done('tool')], [text('We have the morning free.'), done()]]);
    const { base } = await boot(app, model, settings(dir, 'telnyx'));
    const callId = 'v3:converse-voice-telnyx-running';
    const relay = await call(base, 'telnyx', callId);
    await relay.waitFor(() => finals(relay).length >= 1);
    relay.prompt('Is anything free on Tuesday?');
    await relay.waitFor((m) => m.type === 'text' && (m.token as string).startsWith('Let me look at'));
    played(relay, line);
    await new Promise((r) => setTimeout(r, 50));
    release();
    await relay.waitFor(() => finals(relay).at(-1) === 'We have the morning free.');
    await new Promise((r) => setTimeout(r, 50));
    const frames = readFileSync(join(dir, 'traces', 'converse', `${callId.replace(/[^A-Za-z0-9_-]/g, '_')}.frames.jsonl`), 'utf8');
    const reports = frames.trim().split('\n').filter((l) => l.includes('tokensPlayed'));
    expect(reports).toHaveLength(1);
    expect(reports[0]).not.toContain(DAY);
    // The line itself, written once its turn has ended, is masked as the trace masks it.
    expect(frames.trim().split('\n').filter((l) => l.includes('"dir":"out"') && l.includes(DAY))).toEqual([]);
  }, 20_000);
});

describe('a host of a scripted app and a converse app', () => {
  /** The callback fixture's settings, and the converse app's number. */
  const hostEnv = (dir: string): Env => settings(dir, 'twilio', {
    MAIN_LINE: '+15555550101', PRIORITY_LINE: '+15555550102', CALLBACK_DESK: '+15555550103', SECURITY_DESK: '+15555550104', VISIT_LINE: '+15555550105',
  });

  async function hostOf(withConverse: boolean): Promise<{ base: string }> {
    const dir = folder();
    const env = hostEnv(dir);
    const { app } = converseFixture();
    const scripted = { id: 'callback', app: callbackApp, env, own: [], ignored: [] };
    const hosted = withConverse ? [scripted, { id: app.id, app, dir: app.dir, env, own: [], ignored: [] }] : [scripted];
    const apps = hostRouting<HostedApp>({ apps: hosted, numbers: withConverse ? [{ variable: 'VISIT_LINE', app: app.id }] : [], defaultApp: 'callback', env });
    const server = await startServer(loadConfig(env), { host: '127.0.0.1', log: () => {}, env, apps, converseModel: () => fakeModel([[text('Sure, Tuesday works.'), done()]]) });
    servers.push(server);
    return { base: `http://127.0.0.1:${server.port}` };
  }

  /** A scripted call to the main line: the greeting, one answer, and everything the server sent. */
  async function scriptedCall(base: string): Promise<unknown[]> {
    const relay = await call(base, 'twilio', 'CAscriptedonahost000000000000001', '+15555550101');
    await relay.waitForTexts(1);
    relay.prompt('I would like a callback please');
    await relay.waitFor(() => relay.received.length >= 3, 4000);
    await new Promise((r) => setTimeout(r, 100));
    return relay.received.map((m) => ({ ...m }));
  }

  it('a scripted app\'s call on the same server is unchanged', async () => {
    resetAppsForTest();
    registerApp(callbackApp);
    const alone = await scriptedCall((await hostOf(false)).base);
    const both = await hostOf(true);
    expect(await scriptedCall(both.base)).toEqual(alone);
    // And a call to the converse app's number is the converse app's.
    const relay = await call(both.base, 'twilio', 'CAconverseonahost000000000000001', '+15555550105');
    await relay.waitFor(() => finals(relay).length >= 1);
    expect(finals(relay)).toEqual([GREETING]);
  }, 20_000);
});
