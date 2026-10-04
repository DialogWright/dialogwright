import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { startServer, type RunningServer, type ServerOverrides } from '../index';
import { loadConfig } from '../config';
import { useTestkit } from '../../testing/apps';
import { testkitApp } from '../../testing/testkit/index';
import { registerApp, resetAppsForTest } from '../../core/app/registry';
import { libraryApp } from '../../define/fixture/app';
import { lineLang, promptText } from '../../prompts/render';
import { loadScenarios, runScenario } from '../../harness-text/runner';
import { scenariosDir, defaultCorpusFile } from '../../run/fixtures';
import { loadCorpus } from '../../jev/corpus';
import { FixtureStubClient } from '../../jev/fixtureStub';
import { HeuristicStubClient } from '../../jev/heuristicStub';
import { DEFAULT_THRESHOLDS } from '../../core/thresholds';
import { demoTools } from '../../core/tools';
import { newSession } from '../../core/session';
import { WEB_CHAT } from '../../channel/caps';
import { startEvent, textEvent, type SessionEvent } from '../../channel/events';
import { actionsToChatMessages, type ServerMessage } from '../../channel/chat/protocol';
import { runChatTurnActions, type ChatTurnEntry } from '../chatTurn';
import type { JevClient } from '../../jev/types';
import { CHAT_MAX_WAITING } from './socket';
import { replayEvents } from '../dashboard/view.js';
import { readFrameLog } from '../frameLog';
import type { DashboardEvent } from '../dashboard/events';

useTestkit();

const ORIGIN = 'https://www.example.com';
const OPENER = 'has parcel 7102 been delivered';
const AGENT = 'i want to talk to a person';

let running: RunningServer | null = null;
let tempDirs: string[] = [];
const clients: ChatClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await running?.close();
  // The server's side of each socket closes after the client's: let it, before the trace directory goes.
  await new Promise((resolve) => setTimeout(resolve, 20));
  running = null;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

let stub: JevClient;
beforeAll(() => {
  stub = new FixtureStubClient(loadCorpus(defaultCorpusFile()), { sharpness: DEFAULT_THRESHOLDS.STUB_SHARPNESS, fallback: new HeuristicStubClient({ todayIso: '2026-09-18' }) });
}, 60_000);

type Msg = ServerMessage;

/** A chat client as a site's page is one: it connects with its page's origin and speaks the chat wire. */
class ChatClient {
  readonly received: Msg[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  private waiters: Array<() => void> = [];

  private constructor(private readonly ws: WebSocket) {
    this.closed = new Promise((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    ws.on('message', (data) => {
      this.received.push(JSON.parse(data.toString()) as Msg);
      const w = this.waiters;
      this.waiters = [];
      for (const fn of w) fn();
    });
  }

  static connect(url: string, origin: string | null = ORIGIN): Promise<ChatClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, origin === null ? {} : { origin });
      ws.once('open', () => {
        const c = new ChatClient(ws);
        clients.push(c);
        resolve(c);
      });
      ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      ws.once('error', reject);
    });
  }

  send(msg: unknown): void {
    this.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  /** Wait until `pred` holds over what has arrived. */
  async until(pred: (received: Msg[]) => boolean, ms = 4000): Promise<Msg[]> {
    const deadline = Date.now() + ms;
    while (!pred(this.received)) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out; received ${JSON.stringify(this.received)}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    return this.received;
  }

  /** Everything after the first `count` messages, once a message of `type` has arrived after them. */
  async through(type: Msg['type'], from: number): Promise<Msg[]> {
    await this.until((r) => r.slice(from).some((m) => m.type === type));
    const rest = this.received.slice(from);
    return rest.slice(0, rest.findIndex((m) => m.type === type) + 1);
  }

  close(): void {
    this.ws.close();
  }
}

function makeConfig(extra: Record<string, string> = {}) {
  const traceDir = mkdtempSync(join(tmpdir(), 'chat-'));
  tempDirs.push(traceDir);
  return loadConfig({
    PUBLIC_HOST: 'localhost',
    TWILIO_AUTH_TOKEN: 't',
    HANDOFF_NUMBER: '+15551234567',
    PORT: '0',
    SIGNATURE_CHECK: 'off',
    TODAY_OVERRIDE: '2026-09-18',
    TRACE_DIR: traceDir,
    AUDIT_DIR: join(traceDir, 'audit'),
    AUDIO_DIR: traceDir,
    DASHBOARD: 'off',
    CHAT: 'on',
    CHAT_ALLOWED_ORIGINS: ORIGIN,
    ...extra,
  });
}

async function start(extra: Record<string, string> = {}, overrides: Omit<ServerOverrides, 'log'> = {}) {
  const config = makeConfig(extra);
  const logs: string[] = [];
  running = await startServer(config, { client: stub, log: (line) => logs.push(line), ...overrides });
  return { config, logs, url: `ws://127.0.0.1:${running.port}/chat` };
}

/** What the same events say, run in process as a chat session of the testkit, as chat messages. */
async function expectedMessages(events: SessionEvent[]): Promise<Msg[][]> {
  const entry: ChatTurnEntry = {
    id: 'expected', session: newSession('expected', 0, WEB_CHAT), auditEntries: [], lastActivityMs: 0,
    opts: { client: stub, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18', now: () => 0, tools: demoTools() },
  };
  const deps = { audit: { append: () => { throw new Error('unused'); } }, log: () => {} };
  const out: Msg[][] = [];
  for (const e of events) out.push(actionsToChatMessages(await runChatTurnActions(deps, entry, e, () => 0, 'desk'), 'en-US'));
  return out;
}

function auditEntries(config: ReturnType<typeof makeConfig>): Array<{ type: string; callId: string; channel: string; detail: Record<string, unknown> }> {
  return readdirSync(config.auditDir).flatMap((f) => readFileSync(join(config.auditDir, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l)));
}

/** The console's replay of a chat, from the trace and frame log the server wrote for it. */
function replayOf(config: ReturnType<typeof makeConfig>, session: string): DashboardEvent[] {
  const records = readFileSync(join(config.traceDir, `${session}.jsonl`), 'utf8').trim().split('\n').map((l) => ({ ...JSON.parse(l), spokenText: '' }));
  return replayEvents(records, readFrameLog(join(config.traceDir, `${session}.frames.jsonl`)), {});
}

const says = (ms: Msg[]): string[] => ms.flatMap((m) => (m.type === 'say' ? [m.text] : []));

describe('the chat endpoint', () => {
  it('refuses an upgrade from a site that is not allowed, before it is one, and opens for an allowed one', async () => {
    const { url, logs } = await start();
    await expect(ChatClient.connect(url, 'https://www.example.com.evil.test')).rejects.toThrow('HTTP 403');
    await expect(ChatClient.connect(url, null)).rejects.toThrow('HTTP 403');
    expect(logs.some((l) => l.includes('chat upgrade refused'))).toBe(true);
    const ok = await ChatClient.connect(url);
    ok.send({ type: 'ping' });
    expect(await ok.until((r) => r.length > 0)).toEqual([{ type: 'pong' }]);
  });

  it('says what the testkit web chat scenario says: ready, then each line, turn by turn', async () => {
    const { url } = await start();
    const scenario = loadScenarios(scenariosDir()).find((s) => s.id === 'web-signin-track')!;
    const run = await runScenario(scenario, { client: stub, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18', now: () => 0 });
    // The opening turn, then the first step (the opener), each as the scenario's own actions.
    const greeting = actionsToChatMessages(run.runs[0]!.result.actions, 'en-US');
    const opener = run.runs.filter((_, i) => run.stepOf[i] === 0).flatMap((r) => actionsToChatMessages(r.result.actions, 'en-US'));
    expect(says(greeting).length).toBeGreaterThan(0);
    expect(says(opener).length).toBeGreaterThan(0);

    const c = await ChatClient.connect(url);
    c.send({ type: 'start', v: 1 });
    await c.until((r) => r.length >= 1 + greeting.length);
    const [ready, ...first] = c.received;
    expect(ready).toMatchObject({ type: 'ready', locale: 'en-US' });
    const r = ready as Extract<Msg, { type: 'ready' }>;
    expect(r.session).toMatch(/^[0-9a-f]{32}$/);
    expect(r.resume).toMatch(/^[0-9a-f]{32}$/);
    expect(r.resume).not.toBe(r.session);
    expect(first).toEqual(greeting);
    c.send({ type: 'text', text: OPENER });
    await c.until((m) => m.length >= 1 + greeting.length + opener.length);
    expect(c.received.slice(1 + greeting.length)).toEqual(opener);
    expect(running!.chat!.liveCount()).toBe(1);
  });

  it('closes a connection that never starts, saying why', async () => {
    const { url } = await start({}, { setupTimeoutMs: 100 });
    const c = await ChatClient.connect(url);
    expect(await c.closed).toEqual({ code: 1008, reason: 'no start' });
    expect(c.received).toEqual([{ type: 'error', code: 'not_allowed', message: 'the first message is start' }]);
  });

  it('answers a message before start with not_allowed, and a second start likewise', async () => {
    const { url } = await start();
    const c = await ChatClient.connect(url);
    c.send({ type: 'text', text: 'hello' });
    expect((await c.until((r) => r.length >= 1))[0]).toMatchObject({ type: 'error', code: 'not_allowed' });
    c.send({ type: 'start', v: 1 });
    await c.until((r) => r.some((m) => m.type === 'ready') && r.some((m) => m.type === 'say'));
    const n = c.received.length;
    c.send({ type: 'start', v: 1 });
    expect((await c.until((r) => r.length > n))[n]).toMatchObject({ type: 'error', code: 'not_allowed' });
  });

  it('resumes a dropped chat where it was, on a new socket, with the same session', async () => {
    const { url } = await start();
    const [greeting, opener, again] = await expectedMessages([startEvent({ channel: 'chat' }), textEvent(OPENER), textEvent(AGENT)]);
    const c = await ChatClient.connect(url);
    c.send({ type: 'start', v: 1 });
    await c.until((r) => r.length >= 1 + greeting!.length);
    c.send({ type: 'text', text: OPENER });
    await c.until((r) => r.length >= 1 + greeting!.length + opener!.length);
    const ready = c.received[0] as Extract<Msg, { type: 'ready' }>;
    c.close();
    await c.closed;

    const d = await ChatClient.connect(url);
    d.send({ type: 'start', v: 1, resume: ready.resume });
    const [back] = await d.until((r) => r.length >= 1);
    // Nothing but ready: the client keeps its own transcript. A fresh resume token each time.
    expect(back).toMatchObject({ type: 'ready', session: ready.session, locale: 'en-US' });
    expect((back as Extract<Msg, { type: 'ready' }>).resume).not.toBe(ready.resume);
    d.send({ type: 'text', text: AGENT });
    await d.until((r) => r.some((m) => m.type === 'end'));
    expect(d.received.slice(1)).toEqual([...again!, { type: 'end' }]);

    // The used token does not open it again.
    const e = await ChatClient.connect(url);
    e.send({ type: 'start', v: 1, resume: ready.resume });
    await e.until((r) => r.some((m) => m.type === 'ready'));
    expect(e.received[0]).toMatchObject({ type: 'error', code: 'session_unknown' });
    expect((e.received[1] as Extract<Msg, { type: 'ready' }>).session).not.toBe(ready.session);
  });

  it('a second resume takes the chat over: the socket it replaced is closed', async () => {
    const { url } = await start();
    const c = await ChatClient.connect(url);
    c.send({ type: 'start', v: 1 });
    await c.until((r) => r.some((m) => m.type === 'say'));
    const ready = c.received[0] as Extract<Msg, { type: 'ready' }>;
    const d = await ChatClient.connect(url);
    d.send({ type: 'start', v: 1, resume: ready.resume });
    await d.until((r) => r.some((m) => m.type === 'ready'));
    expect(await c.closed).toEqual({ code: 1000, reason: 'resumed elsewhere' });
    d.send({ type: 'ping' });
    await d.until((r) => r.some((m) => m.type === 'pong'));
    expect(running!.chat!.liveCount()).toBe(1);
  });

  it('closes after ten malformed messages, and tells a person who typed too much without counting it', async () => {
    const { url } = await start();
    const c = await ChatClient.connect(url);
    c.send({ type: 'start', v: 1 });
    await c.until((r) => r.some((m) => m.type === 'say'));
    const n = c.received.length;
    c.send({ type: 'text', text: 'x'.repeat(501) });
    await c.until((r) => r.length > n);
    expect(c.received[n]).toEqual({ type: 'error', code: 'too_long', message: 'a message is at most 500 characters' });
    for (let i = 0; i < 9; i += 1) c.send('not json');
    await c.until((r) => r.filter((m) => m.type === 'error' && m.code === 'bad_message').length === 9);
    c.send({ type: 'ping' });
    await c.until((r) => r.some((m) => m.type === 'pong'));
    c.send('{"type":"nope"}');
    expect(await c.closed).toEqual({ code: 1007, reason: 'malformed messages' });
  });

  it('ends on a transfer: the transfer, then end, the socket closed and the audit closed', async () => {
    const { url, config } = await start();
    const [, handoff] = await expectedMessages([startEvent({ channel: 'chat' }), textEvent(AGENT)]);
    const c = await ChatClient.connect(url);
    c.send({ type: 'start', v: 1 });
    await c.until((r) => r.some((m) => m.type === 'say'));
    const n = c.received.length;
    c.send({ type: 'text', text: AGENT });
    expect((await c.closed).code).toBe(1000);
    expect(c.received.slice(n)).toEqual([...handoff!, { type: 'end' }]);
    expect(c.received.slice(n).map((m) => m.type)).toEqual(['say', 'transfer', 'end']);
    expect(c.received.slice(n)[1]).toEqual({ type: 'transfer', reason: 'live-agent' });
    const session = (c.received[0] as Extract<Msg, { type: 'ready' }>).session;
    const audit = auditEntries(config).filter((e) => e.callId === session);
    expect(audit[0]).toMatchObject({ type: 'call_started', channel: 'chat' });
    expect(audit.find((e) => e.type === 'call_ended')).toMatchObject({ type: 'call_ended', channel: 'chat', detail: { reason: 'handoff' } });
    expect(running!.chat!.liveCount()).toBe(0);
    // The console replays it as the chat it was, handed over for its reason.
    const replayed = replayOf(config, session);
    expect(replayed[0]).toMatchObject({ type: 'call_started', callSid: session, channel: 'chat' });
    expect(replayed.filter((e) => e.type === 'handoff' || e.type === 'ended').map((e) => [e.type, (e as { reason: string }).reason])).toEqual([['handoff', 'live-agent'], ['ended', 'handoff']]);
  });

  it('ends a chat nobody writes to, and says so', async () => {
    let clock = 1_000_000;
    const { url, config } = await start({ CHAT_IDLE_MS: '60000', DASHBOARD: 'on' }, { now: () => clock });
    const ended: DashboardEvent[] = [];
    running!.bus!.subscribe((e) => {
      if (e.type === 'ended') ended.push(e);
    });
    const c = await ChatClient.connect(url);
    c.send({ type: 'start', v: 1 });
    await c.until((r) => r.some((m) => m.type === 'say'));
    clock += 30_000;
    running!.sweep();
    expect(running!.chat!.liveCount()).toBe(1);
    clock += 30_000;
    running!.sweep();
    expect(running!.chat!.liveCount()).toBe(0);
    expect((await c.closed).code).toBe(1000);
    expect(c.received.at(-1)).toEqual({ type: 'end' });
    const session = (c.received[0] as Extract<Msg, { type: 'ready' }>).session;
    expect(auditEntries(config).filter((e) => e.callId === session).at(-1)).toMatchObject({ type: 'call_ended', channel: 'chat', detail: { reason: 'abandoned' } });
    // The console, live and in replay, says it was abandoned.
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ type: 'ended', callSid: session, reason: 'abandoned' });
    expect(replayOf(config, session).filter((e) => e.type === 'ended').map((e) => (e as { reason: string }).reason)).toEqual(['abandoned']);
  });

  it('outlives a frame log it can no longer write: a drop and an idle end with the trace directory gone', async () => {
    let clock = 1_000_000;
    const { url, config, logs } = await start({ CHAT_IDLE_MS: '60000' }, { now: () => clock });
    const c = await ChatClient.connect(url);
    c.send({ type: 'start', v: 1 });
    await c.until((r) => r.some((m) => m.type === 'say'));
    rmSync(config.traceDir, { recursive: true, force: true });
    c.close();
    await c.closed;
    await new Promise((resolve) => setTimeout(resolve, 20));
    clock += 60_000;
    running!.sweep();
    expect(running!.chat!.liveCount()).toBe(0);
    expect(logs.some((l) => l.includes('close handler failed'))).toBe(true);
    // The server still serves.
    const d = await ChatClient.connect(url);
    d.send({ type: 'ping' });
    await d.until((r) => r.some((m) => m.type === 'pong'));
  });

  it('holds at most CHAT_MAX_SESSIONS chats: a new one over it is told busy and closed, a resume never is', async () => {
    const { url, logs } = await start({ CHAT_MAX_SESSIONS: '1' });
    const c = await ChatClient.connect(url);
    c.send({ type: 'start', v: 1 });
    await c.until((r) => r.some((m) => m.type === 'say'));
    const ready = c.received[0] as Extract<Msg, { type: 'ready' }>;

    const d = await ChatClient.connect(url);
    d.send({ type: 'start', v: 1 });
    expect(await d.closed).toEqual({ code: 1013, reason: 'busy' });
    expect(d.received).toEqual([{ type: 'error', code: 'busy', message: 'too many chats are open: try again later' }]);
    expect(logs.filter((l) => l.includes('CHAT_MAX_SESSIONS'))).toEqual(['chat refused: 1 chat sessions are live, the most CHAT_MAX_SESSIONS allows']);

    // The live session, dropped, resumes whatever the count.
    c.close();
    await c.closed;
    const e = await ChatClient.connect(url);
    e.send({ type: 'start', v: 1, resume: ready.resume });
    await e.until((r) => r.length >= 1);
    expect(e.received[0]).toMatchObject({ type: 'ready', session: ready.session });

    // Once it ends, a new chat may start.
    e.send({ type: 'text', text: AGENT });
    await e.closed;
    const f = await ChatClient.connect(url);
    f.send({ type: 'start', v: 1 });
    await f.until((r) => r.some((m) => m.type === 'say'));
    expect(f.received[0]).toMatchObject({ type: 'ready' });
  });

  it('tells a client that sends faster than its replies come to wait, and runs what it took', async () => {
    // A model that takes its time, so messages queue behind the turn in hand.
    const slow: JevClient = { ask: async (req) => { await new Promise((resolve) => setTimeout(resolve, 30)); return stub.ask(req); } };
    const { url } = await start({}, { client: slow });
    const c = await ChatClient.connect(url);
    c.send({ type: 'start', v: 1 });
    await c.until((r) => r.some((m) => m.type === 'say'));
    const n = c.received.length;
    for (let i = 0; i < CHAT_MAX_WAITING + 3; i += 1) c.send({ type: 'text', text: OPENER });
    await c.until((r) => r.slice(n).filter((m) => m.type === 'error').length === 3);
    expect(c.received.slice(n).filter((m) => m.type === 'error')).toEqual(Array(3).fill({ type: 'error', code: 'busy', message: 'wait for the reply to what was sent' }));
    // Not counted as malformed, and the chat goes on once the queue has drained.
    await new Promise((resolve) => setTimeout(resolve, 30 * 4 * (CHAT_MAX_WAITING + 1)));
    const m = c.received.length;
    c.send({ type: 'ping' });
    await c.until((r) => r.slice(m).some((x) => x.type === 'pong'));
  });

  it('writes the frame log without the resume token', async () => {
    const { url, config } = await start();
    const c = await ChatClient.connect(url);
    c.send({ type: 'start', v: 1 });
    await c.until((r) => r.some((m) => m.type === 'say'));
    const ready = c.received[0] as Extract<Msg, { type: 'ready' }>;
    const frames = readFileSync(join(config.traceDir, `${ready.session}.frames.jsonl`), 'utf8');
    expect(frames).toContain('"type":"ready"');
    expect(frames).toContain('"dir":"out"');
    expect(frames).not.toContain(ready.resume);
  });

  it('is not served with CHAT off: the upgrade is refused like any unknown path', async () => {
    const { url } = await start({ CHAT: 'off' });
    expect(running!.chat).toBeUndefined();
    await expect(ChatClient.connect(url)).rejects.toThrow('HTTP 404');
  });
});

/** Keys are made here, for this run, and never stored; the identity provider's keys are served by a local server. */
const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const idpKey = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const ISSUER = 'https://id.example.com';
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
const CUSTOMER = '55501234';
function idToken(claims: Record<string, unknown>, key: KeyObject = idpKey.privateKey): string {
  const head = b64url(JSON.stringify({ alg: 'ES256', kid: 'site-1', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const body = b64url(JSON.stringify({ iss: ISSUER, aud: 'chat-widget', iat: now, exp: now + 300, ...claims }));
  const sig = cryptoSign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${b64url(sig)}`;
}

/** The identity provider's key set on a local server, and a fetch that sends the https URL there (the config takes https only). */
async function identityProvider(): Promise<{ fetch: typeof fetch; fetched: () => number; close: () => Promise<void> }> {
  let count = 0;
  const server = createServer((req, res) => {
    count += 1;
    if (req.url !== '/.well-known/jwks.json') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'max-age=300' });
    res.end(JSON.stringify({ keys: [{ ...idpKey.publicKey.export({ format: 'jwk' }), kid: 'site-1', use: 'sig', alg: 'ES256' }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const local = ((url: string | URL, init?: RequestInit) => fetch(String(url).replace(ISSUER, `http://127.0.0.1:${port}`), init)) as typeof fetch;
  return { fetch: local, fetched: () => count, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

const JWT_ENV = { CHAT_SIGNIN: 'jwt', CHAT_JWKS_URL: JWKS_URL, CHAT_ISSUER: ISSUER, CHAT_AUDIENCE: 'chat-widget' };

describe('signing in to the chat', () => {
  let idp: Awaited<ReturnType<typeof identityProvider>>;
  beforeAll(async () => {
    idp = await identityProvider();
  });
  afterAll(async () => {
    await idp.close();
  });

  it('a token from the site signs in a subject mid-chat, and the next line treats them as verified', async () => {
    const { url } = await start(JWT_ENV, { chatFetch: idp.fetch });
    const c = await ChatClient.connect(url);
    c.send({ type: 'start', v: 1 });
    await c.until((r) => r.some((m) => m.type === 'say'));
    c.send({ type: 'text', text: OPENER });
    const n = (await c.until((r) => r.filter((m) => m.type === 'say').length >= 2)).length;
    c.send({ type: 'sign_in', token: idToken({ sub: CUSTOMER }) });
    // What the testkit's web chat scenario expects once the customer signs in (web.json).
    await c.until((r) => says(r.slice(n)).join(' ').includes('was delivered Wednesday, September 16'));
    expect(c.received[n]).toEqual({ type: 'signed_in', level: 2 });
    expect(idp.fetched()).toBe(1);
  });

  it('a token on start signs in at once: ready and the greeting, then signed_in and its line', async () => {
    const { url } = await start(JWT_ENV, { chatFetch: idp.fetch });
    const c = await ChatClient.connect(url);
    c.send({ type: 'start', v: 1, token: idToken({ sub: CUSTOMER }) });
    await c.until((r) => r.some((m) => m.type === 'signed_in') && r.at(-1)?.type === 'say');
    const types = c.received.map((m) => m.type);
    expect(types[0]).toBe('ready');
    expect(types.indexOf('signed_in')).toBeGreaterThan(1);
    expect(types.slice(1, types.indexOf('signed_in')).every((t) => t === 'say')).toBe(true);
  });

  it('refuses a token that does not verify, saying why, and never writes the token anywhere', async () => {
    const { url, logs, config } = await start(JWT_ENV, { chatFetch: idp.fetch });
    const forged = idToken({ sub: CUSTOMER }, generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey);
    const c = await ChatClient.connect(url);
    c.send({ type: 'start', v: 1 });
    await c.until((r) => r.some((m) => m.type === 'say'));
    const n = c.received.length;
    c.send({ type: 'sign_in', token: forged });
    await c.until((r) => r.length > n);
    expect(c.received[n]).toEqual({ type: 'error', code: 'sign_in_failed', message: 'the sign-in was refused (signature)' });
    const session = (c.received[0] as Extract<Msg, { type: 'ready' }>).session;
    expect(logs).toContain(`chat ${session}: sign-in refused (signature)`);
    // The token, and its signature alone, appear in no log line and no file the server wrote.
    const sig = forged.split('.')[2]!;
    expect(logs.join('\n')).not.toContain(sig);
    for (const f of readdirSync(config.traceDir)) if (f.endsWith('.jsonl')) expect(readFileSync(join(config.traceDir, f), 'utf8'), f).not.toContain(sig);
    // The chat goes on, anonymous.
    c.send({ type: 'text', text: OPENER });
    await c.until((r) => r.slice(n + 1).some((m) => m.type === 'say'));
  });

  it('mock: mock:<id> signs in on a laptop', async () => {
    const { url } = await start({ CHAT_SIGNIN: 'mock' });
    const c = await ChatClient.connect(url);
    c.send({ type: 'start', v: 1 });
    await c.until((r) => r.some((m) => m.type === 'say'));
    const n = c.received.length;
    c.send({ type: 'sign_in', token: `mock:${CUSTOMER}` });
    expect((await c.through('say', n))[0]).toEqual({ type: 'signed_in', level: 2 });
  });

  it('none: a token is not allowed, on start or later, and the chat goes on', async () => {
    const { url } = await start();
    const c = await ChatClient.connect(url);
    c.send({ type: 'start', v: 1, token: `mock:${CUSTOMER}` });
    await c.until((r) => r.some((m) => m.type === 'say') && r.some((m) => m.type === 'error'));
    expect(c.received[0]).toMatchObject({ type: 'ready' });
    expect(c.received.find((m) => m.type === 'error')).toEqual({ type: 'error', code: 'not_allowed', message: 'sign-in is off for this chat' });
    const n = c.received.length;
    c.send({ type: 'sign_in', token: `mock:${CUSTOMER}` });
    await c.until((r) => r.length > n);
    expect(c.received[n]).toEqual({ type: 'error', code: 'not_allowed', message: 'sign-in is off for this chat' });
  });

  it('a second sign-in the core does not take is refused, not reported as signed in', async () => {
    const { url } = await start({ CHAT_SIGNIN: 'mock' });
    const c = await ChatClient.connect(url);
    c.send({ type: 'start', v: 1, token: `mock:${CUSTOMER}` });
    await c.until((r) => r.some((m) => m.type === 'signed_in'));
    await c.until((r) => r.at(-1)?.type === 'say');
    const n = c.received.length;
    c.send({ type: 'sign_in', token: 'mock:55505678' });
    await c.until((r) => r.length > n);
    expect(c.received[n]).toEqual({ type: 'error', code: 'sign_in_failed', message: 'the sign-in was refused (the chat is already signed in)' });
  });
});

describe('a delegate signing in to the chat (principals.fromClaims)', () => {
  beforeAll(() => {
    // The testkit, with a fromClaims that names depot staff by the token's sub.
    resetAppsForTest();
    registerApp({
      ...testkitApp,
      principals: { ...testkitApp.principals!, fromClaims: (c) => (c.sub === 'taylor' ? testkitApp.principals!.delegatePrincipal!('taylor') : null) },
    });
  });
  afterAll(() => {
    useTestkit();
  });

  it('starts the chat as the delegate when the start carries their token', async () => {
    const { url, config } = await start({ CHAT_SIGNIN: 'mock' });
    const c = await ChatClient.connect(url);
    c.send({ type: 'start', v: 1, token: 'mock:taylor' });
    await c.until((r) => r.some((m) => m.type === 'say'));
    expect(c.received.slice(0, 2).map((m) => m.type)).toEqual(['ready', 'signed_in']);
    const session = (c.received[0] as Extract<Msg, { type: 'ready' }>).session;
    // The audit's call_started names the delegate: the session began signed in as them.
    expect(auditEntries(config).find((e) => e.callId === session && e.type === 'call_started')).toMatchObject({ channel: 'chat', detail: { principal: 'agent', level: 2 } });
  });

  it('refuses a delegate signing in mid-chat: a delegate signs in as the chat starts', async () => {
    const { url } = await start({ CHAT_SIGNIN: 'mock' });
    const c = await ChatClient.connect(url);
    c.send({ type: 'start', v: 1 });
    await c.until((r) => r.some((m) => m.type === 'say'));
    const n = c.received.length;
    c.send({ type: 'sign_in', token: 'mock:taylor' });
    await c.until((r) => r.length > n);
    expect(c.received[n]).toEqual({ type: 'error', code: 'sign_in_failed', message: 'the sign-in was refused (a delegate signs in as the chat starts)' });
  });
});

describe('a chat asks for its language', () => {
  beforeAll(() => {
    // The engine's library fixture, which speaks Spanish beside its default (define/fixture/locale/es).
    resetAppsForTest();
    registerApp(libraryApp);
  });
  afterAll(() => {
    useTestkit();
  });

  it('start { locale } opens the chat in the app\'s matching language, each line saying its language', async () => {
    const { url } = await start({}, { client: new HeuristicStubClient({ todayIso: '2026-09-18' }) });
    const c = await ChatClient.connect(url);
    c.send({ type: 'start', v: 1, locale: 'es-MX' });
    await c.until((r) => r.some((m) => m.type === 'say'));
    expect(c.received[0]).toMatchObject({ type: 'ready', locale: 'es' });
    const line = c.received[1] as Extract<Msg, { type: 'say' }>;
    // A chat's greeting (greeting_chat), in the locale's own words.
    expect(line).toEqual({ type: 'say', text: promptText(libraryApp, 'greeting_chat', {}, 'es'), lang: lineLang(libraryApp, 'es') });
    expect(line.text).toMatch(/^Hola/);
  });

  it('a language the app does not speak gets its default', async () => {
    const { url } = await start({}, { client: new HeuristicStubClient({ todayIso: '2026-09-18' }) });
    const c = await ChatClient.connect(url);
    c.send({ type: 'start', v: 1, locale: 'fr' });
    await c.until((r) => r.some((m) => m.type === 'say'));
    expect(c.received[0]).toMatchObject({ type: 'ready', locale: 'en-US' });
    expect(c.received[1]).toMatchObject({ type: 'say', lang: 'en-US' });
    expect((c.received[1] as Extract<Msg, { type: 'say' }>).text).toBe(promptText(libraryApp, 'greeting_chat', {}, 'en-US'));
  });
});
