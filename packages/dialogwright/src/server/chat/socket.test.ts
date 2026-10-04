import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { startServer, type RunningServer, type ServerOverrides } from '../index';
import { loadConfig } from '../config';
import { useTestkit } from '../../testing/apps';
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
  });

  it('ends a chat nobody writes to, and says so', async () => {
    let clock = 1_000_000;
    const { url, config } = await start({ CHAT_IDLE_MS: '60000' }, { now: () => clock });
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
