import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { startServer, type RunningServer } from './index';
import { loadConfig, type Env } from './config';
import { hostRouting } from './host';
import { verifyChain } from '../audit/verify';
import type { JevClient } from '../jev/types';
import type { ServerMessage } from '../channel/chat/protocol';
import type { ConverseModel, ModelEvent } from '../converse/model/types';
import { fakeModel } from '../converse/model/fake';
import type { ConverseApp } from '../converse/app';
import { defineConverseApp } from '../converse/app';
import { CONVERSE_FIXTURE_DIR, converseFixture } from '../testing/converse/app';
import { registerApp, resetAppsForTest } from '../core/app/registry';
import { callbackApp } from '../testing/callback/app';
import type { HostedApp } from './host';

/**
 * The web chat on the converse runtime: a converse app (src/testing/converse) served over the real chat
 * socket, its model a fake script. The greeting follows ready; a reply streamed in sentences reaches a
 * client as one `say` (and as `say_delta` pieces first to a client that asks for them); a read-back
 * answered yes books the visit; the audit is one chain and the trace holds converse records; and a
 * restart in the middle of a read-back resumes the chat on the new server, where the yes books it once.
 */

const ORIGIN = 'https://www.example.com';
const CALLER = '+15555550123';
const DAY = '2030-01-15';
const SLOT = `${DAY}:morning`;
const READ_BACK = 'A visit Tuesday, January 15, 9 to 12 for Sam Example, on ending in 0123. Is that right?';

const servers: RunningServer[] = [];
const sockets: Chat[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const c of sockets.splice(0)) c.close();
  for (const s of servers.splice(0)) await s.close();
  await new Promise((r) => setTimeout(r, 20));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function folder(): string {
  const d = mkdtempSync(join(tmpdir(), 'converse-chat-'));
  dirs.push(d);
  return d;
}

function settings(dir: string, extra: Record<string, string> = {}): Env {
  return {
    PUBLIC_HOST: 'localhost', VOICE_PROVIDERS: 'none', CHAT: 'on', CHAT_ALLOWED_ORIGINS: ORIGIN, PORT: '0',
    TRACE_DIR: join(dir, 'traces'), AUDIT_DIR: join(dir, 'audit'), AUDIO_DIR: dir, DASHBOARD: 'off', JEV_CLIENT: 'stub',
    ...extra,
  };
}

/** A decision model that reads a yes where the caller's words say "yes", and keeps what it was asked. */
function yesJev(): JevClient & { asked: unknown[] } {
  const asked: unknown[] = [];
  return {
    asked,
    async ask(req) {
      asked.push(req.state);
      const said = String((req.state as { said?: unknown }).said ?? '').toLowerCase();
      const yes = /\byes\b/.test(said);
      return {
        answers: { confirmsYes: { type: 'noul', noul: yes ? 0.95 : 0.05 }, confirmsNo: { type: 'noul', noul: yes ? 0.05 : 0.9 } },
        model: 'fake', usage: { inputTokens: 0, outputTokens: 0, estimated: true }, latencyMs: 1, source: 'jev',
      };
    },
  };
}

async function boot(app: ConverseApp, model: ConverseModel, env: Env, jev: JevClient = yesJev()): Promise<{ server: RunningServer; base: string; logs: string[] }> {
  const logs: string[] = [];
  const apps = hostRouting({ apps: [{ id: app.id, app, dir: app.dir, env, own: [], ignored: [] }], numbers: [], defaultApp: app.id, env });
  const server = await startServer(loadConfig(env), { host: '127.0.0.1', client: jev, log: (l) => logs.push(l), env, apps, converseModel: () => model });
  servers.push(server);
  return { server, base: `http://127.0.0.1:${server.port}`, logs };
}

const text = (delta: string): ModelEvent => ({ type: 'text', delta });
const call = (id: string, name: string, args: Record<string, unknown>): ModelEvent => ({ type: 'tool_call', id, name, args });
const done = (stop: 'end' | 'tool' = 'end'): ModelEvent => ({ type: 'done', stop, usage: { inputTokens: 120, outputTokens: 12 } });

/** The model's side of a booking: a lookup, a question, the booking read back, its confirmation, and the end. */
const BOOKING: ModelEvent[][] = [
  [text('Let me look. '), call('c1', 'availability', { day: DAY }), done('tool')],
  [text('We have the morning, 9 to 12, '), text('or the afternoon. Which would suit you?'), done()],
  [call('c2', 'book', { window: SLOT, name: 'Sam Example', phone: 'caller' }), done('tool')],
  [text('You are booked for Tuesday morning.'), done()],
  [call('c3', 'end_call', {}), done('tool')],
];

class Chat {
  readonly received: ServerMessage[] = [];
  readonly closed: Promise<number>;
  private waiters: (() => void)[] = [];
  private constructor(private readonly ws: WebSocket) {
    this.closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
    ws.on('message', (data) => {
      this.received.push(JSON.parse(data.toString()) as ServerMessage);
      for (const w of this.waiters.splice(0)) w();
    });
  }

  static open(base: string): Promise<Chat> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${base.replace('http', 'ws')}/chat`, { origin: ORIGIN });
      ws.once('open', () => {
        const c = new Chat(ws);
        sockets.push(c);
        resolve(c);
      });
      ws.once('error', reject);
    });
  }

  send(m: unknown): void {
    this.ws.send(JSON.stringify(m));
  }

  async until(pred: (r: ServerMessage[]) => boolean, ms = 4000): Promise<ServerMessage[]> {
    const deadline = Date.now() + ms;
    while (!pred(this.received)) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out; received ${JSON.stringify(this.received)}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.waiters.push(() => (clearTimeout(t), resolve()));
      });
    }
    return this.received;
  }

  /** Sends `words` and waits for the line's next `say`; returns every message that came after the send. */
  async say(words: string): Promise<ServerMessage[]> {
    const before = this.received.length;
    this.send({ type: 'text', text: words });
    await this.until((r) => r.slice(before).some((m) => m.type === 'say'));
    return this.received.slice(before);
  }

  close(): void {
    this.ws.close();
  }
}

const says = (ms: ServerMessage[]): string[] => ms.flatMap((m) => (m.type === 'say' ? [m.text] : []));

function auditRows(dir: string): { type: string; callId: string; detail: Record<string, unknown> }[] {
  const d = join(dir, 'audit', 'converse');
  return readdirSync(d).filter((f) => f.endsWith('.jsonl')).flatMap((f) => readFileSync(join(d, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { type: string; callId: string; detail: Record<string, unknown> }));
}

describe('the web chat on the converse runtime', () => {
  it('sends ready, then the greeting', async () => {
    const { app } = converseFixture();
    const { base } = await boot(app, fakeModel([]), settings(folder()));
    const c = await Chat.open(base);
    c.send({ type: 'start', v: 1 });
    await c.until((r) => r.some((m) => m.type === 'say'));
    expect(c.received[0]).toMatchObject({ type: 'ready', locale: 'en' });
    expect(c.received[1]).toEqual({ type: 'say', text: 'Example Visits, how can I help?', lang: 'en' });
    expect(c.received).toHaveLength(2);
  });

  it('sends a reply streamed in sentences as one say, and its sentences as say_delta first to a client that asks for them', async () => {
    const { app } = converseFixture();
    const script: ModelEvent[][] = [BOOKING[0]!, BOOKING[1]!, BOOKING[0]!, BOOKING[1]!];
    const { base } = await boot(app, fakeModel(script), settings(folder()));
    const plain = await Chat.open(base);
    plain.send({ type: 'start', v: 1 });
    await plain.until((r) => r.some((m) => m.type === 'say'));
    const reply = await plain.say(`Is there a visit free on ${DAY}?`);
    await new Promise((r) => setTimeout(r, 50));
    expect(plain.received.slice(-reply.length)).toEqual([{ type: 'say', text: 'Let me look. We have the morning, 9 to 12, or the afternoon. Which would suit you?', lang: 'en' }]);

    const streaming = await Chat.open(base);
    streaming.send({ type: 'start', v: 1, stream: true });
    await streaming.until((r) => r.some((m) => m.type === 'say'));
    const streamed = await streaming.say(`Is there a visit free on ${DAY}?`);
    expect(streamed.filter((m) => m.type === 'say_delta').map((m) => (m as { text: string }).text.trim())).toEqual(['Let me look.', 'We have the morning, 9 to 12, or the afternoon.', 'Which would suit you?']);
    expect(says(streamed)).toEqual(['Let me look. We have the morning, 9 to 12, or the afternoon. Which would suit you?']);
    expect(streamed.at(-1)!.type).toBe('say');
  });

  it('books a visit after its read-back is answered yes; the audit is one chain and the trace is the converse runtime\'s', async () => {
    const dir = folder();
    const { app, booked } = converseFixture();
    const { base } = await boot(app, fakeModel(BOOKING), settings(dir));
    const c = await Chat.open(base);
    c.send({ type: 'start', v: 1, context: { callerNumber: CALLER } });
    await c.until((r) => r.some((m) => m.type === 'say'));
    const session = (c.received[0] as Extract<ServerMessage, { type: 'ready' }>).session;
    await c.say(`Is there a visit free on ${DAY}?`);
    expect(says(await c.say('The morning please, for Sam Example, on this number.'))).toEqual([READ_BACK]);
    expect(booked).toEqual([]);
    expect(says(await c.say('yes, that is right'))).toEqual(['You are booked for Tuesday morning.']);
    expect(booked).toMatchObject([{ window: SLOT, name: 'Sam Example', phone: CALLER }]);
    const last = await c.say('That is all, thanks.');
    await c.until((r) => r.some((m) => m.type === 'end'));
    expect(says(last)).toEqual(['Thanks for getting in touch. Goodbye.']);
    expect(c.received.at(-1)).toEqual({ type: 'end' });
    expect(await c.closed).toBe(1000);

    await new Promise((r) => setTimeout(r, 50));
    const auditDir = join(dir, 'audit', 'converse');
    for (const f of readdirSync(auditDir).filter((n) => n.endsWith('.jsonl'))) expect(verifyChain(join(auditDir, f))).toMatchObject({ ok: true });
    const rows = auditRows(dir).filter((r) => r.callId === session);
    expect(rows.filter((r) => r.type === 'confirmed').map((r) => r.detail.action)).toEqual(['book']);
    expect(rows.filter((r) => r.type === 'gate').map((r) => `${r.detail.tool} ${r.detail.verdict}`)).toEqual(['availability ALLOW', 'book BLOCK', 'book ALLOW']);
    expect(rows.at(-1)).toMatchObject({ type: 'call_ended', detail: { reason: 'completed' } });

    const trace = readFileSync(join(dir, 'traces', 'converse', `${session}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(trace.map((r) => [r.kind, r.v, r.turnIndex])).toEqual([['converse', 3, 0], ['converse', 3, 1], ['converse', 3, 2], ['converse', 3, 3], ['converse', 3, 4]]);
    expect(trace[2]).toMatchObject({ said: 'The morning please, for Sam Example, on this number.', tools: [{ name: 'book', outcome: 'readBack', args: { phone: expect.stringMatching(/0123$/) } }] });
    expect(trace[3]).toMatchObject({ readBack: { confirmed: true }, tools: [{ name: 'book', outcome: 'confirmed' }] });
    // The caller's number reaches the tool whole and the records by its last four.
    expect(JSON.stringify(trace)).not.toContain(CALLER);
  });

  it('lists a converse chat on the console\'s Calls page, and its detail has its turns', async () => {
    const dir = folder();
    const { app } = converseFixture();
    const { base } = await boot(app, fakeModel(BOOKING), settings(dir, { DASHBOARD: 'on' }));
    const c = await Chat.open(base);
    c.send({ type: 'start', v: 1, context: { callerNumber: CALLER } });
    await c.until((r) => r.some((m) => m.type === 'say'));
    const session = (c.received[0] as Extract<ServerMessage, { type: 'ready' }>).session;
    await c.say(`Is there a visit free on ${DAY}?`);
    await c.say('The morning please, for Sam Example, on this number.');
    await c.say('yes');
    await c.say('That is all, thanks.');
    await c.until((r) => r.some((m) => m.type === 'end'));
    await new Promise((r) => setTimeout(r, 50));
    expect((await fetch(`${base}/dashboard`)).status).toBe(200);
    const calls = (await (await fetch(`${base}/dashboard/calls`)).json()) as { rows: Record<string, unknown>[] };
    expect(calls.rows).toEqual([expect.objectContaining({ callSid: session, app: 'converse', appName: 'Example Visits', channel: 'chat', from: 'web chat', turns: 4, tasks: [{ id: 'book', label: 'book' }], ending: { kind: 'handled', text: 'handled' } })]);
    const replay = (await (await fetch(`${base}/dashboard/traces/${session}?app=converse`)).json()) as { app: string; records: Record<string, unknown>[] };
    expect(replay.app).toBe('converse');
    expect(replay.records.map((r) => r.kind)).toEqual(['converse', 'converse', 'converse', 'converse', 'converse']);
    // The line as the trace keeps it: each value the business records masked (agent.yaml audit), masked.
    expect(replay.records[2]).toMatchObject({ said: 'The morning please, for Sam Example, on this number.', spokenText: 'A visit • for <11 chars>, on ...0123. Is that right?', tools: [{ name: 'book', outcome: 'readBack' }] });
    expect(JSON.stringify(replay)).not.toContain(CALLER);
  });

  it('takes no caller number from a chat\'s context unless app.yaml says so', async () => {
    const dir = folder();
    // The fixture's agent.yaml alone: no app.yaml, so chat.callerNumberFromContext is false.
    const own = join(dir, 'converse');
    rmSync(own, { recursive: true, force: true });
    const { mkdirSync } = await import('node:fs');
    mkdirSync(own);
    copyFileSync(join(CONVERSE_FIXTURE_DIR, 'agent.yaml'), join(own, 'agent.yaml'));
    const app = defineConverseApp(own, { tools: { availability: async () => [{ id: SLOT, label: 'Tuesday, January 15, 9 to 12' }], book: async () => 'booked' } });
    expect(app.chat.callerNumberFromContext).toBe(false);
    const model = fakeModel([BOOKING[0]!, BOOKING[1]!, BOOKING[2]!, [text('What number should we use?'), done()]]);
    const { base } = await boot(app, model, settings(dir));
    const c = await Chat.open(base);
    c.send({ type: 'start', v: 1, context: { callerNumber: CALLER } });
    await c.until((r) => r.some((m) => m.type === 'say'));
    await c.say(`Is there a visit free on ${DAY}?`);
    expect(says(await c.say('The morning, for Sam Example, on this number.'))).toEqual(['What number should we use?']);
    const results = model.requests.at(-1)!.messages.flatMap((m) => m.content).filter((x) => x.type === 'tool_result');
    expect(results.at(-1)).toMatchObject({ isError: true, content: expect.stringContaining('not known on this call') });
  });

  it('resumes a chat in the middle of a read-back on a restarted server, where the yes books it once', async () => {
    const dir = folder();
    const env = settings(dir, { SESSION_STORE: `file:${join(dir, 'sessions')}` });
    const { app, booked, calendar } = converseFixture();
    // One script across both servers: the model is asked where the chat left off.
    const model = fakeModel(BOOKING);
    const first = await boot(app, model, env);
    const c = await Chat.open(first.base);
    c.send({ type: 'start', v: 1, context: { callerNumber: CALLER } });
    await c.until((r) => r.some((m) => m.type === 'say'));
    const ready = c.received[0] as Extract<ServerMessage, { type: 'ready' }>;
    await c.say(`Is there a visit free on ${DAY}?`);
    expect(says(await c.say('The morning please, for Sam Example, on this number.'))).toEqual([READ_BACK]);
    await new Promise((r) => setTimeout(r, 50));
    await first.server.close();
    servers.splice(servers.indexOf(first.server), 1);
    expect(await c.closed).toBe(1001);
    const chats = join(dir, 'sessions', 'chats');
    expect(readdirSync(chats)).toHaveLength(1);
    const saved = JSON.parse(readFileSync(join(chats, readdirSync(chats)[0]!), 'utf8')) as { schema: unknown; session: { kind: string; pending: unknown } };
    expect(saved.schema).toBe('converse-1');
    expect(saved.session).toMatchObject({ kind: 'converse', pending: { action: 'book' } });

    const second = await boot(app, model, env);
    const d = await Chat.open(second.base);
    d.send({ type: 'start', v: 1, resume: ready.resume });
    const [back] = await d.until((r) => r.length >= 1);
    expect(back).toMatchObject({ type: 'ready', session: ready.session, locale: 'en' });
    expect(second.logs).toContain(`chat ${ready.session}: restored from the session store`);
    expect(says(await d.say('yes'))).toEqual(['You are booked for Tuesday morning.']);
    expect(booked).toHaveLength(1);
    expect((calendar as unknown as { bookings: unknown[] }).bookings).toHaveLength(1);
    const rows = auditRows(dir).filter((r) => r.callId === ready.session);
    expect(rows.filter((r) => r.type === 'confirmed').map((r) => r.detail.action)).toEqual(['book']);
    const auditDir = join(dir, 'audit', 'converse');
    for (const f of readdirSync(auditDir).filter((n) => n.endsWith('.jsonl'))) expect(verifyChain(join(auditDir, f))).toMatchObject({ ok: true });
    expect(existsSync(join(dir, 'traces', 'converse', `${ready.session}.jsonl`))).toBe(true);
  }, 20_000);

  it('serves a converse app\'s own pages under its id', async () => {
    const own = join(folder(), 'converse');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(own);
    copyFileSync(join(CONVERSE_FIXTURE_DIR, 'agent.yaml'), join(own, 'agent.yaml'));
    const page = {
      label: 'a page', path: '/hello', localOnly: false,
      handle: async (_req: unknown, res: import('node:http').ServerResponse) => {
        res.writeHead(200, { 'content-type': 'text/plain' }).end('hello from the app');
        return true;
      },
    };
    const app = defineConverseApp(own, { tools: { availability: async () => [], book: async () => 'booked' }, pages: { routes: [page] } });
    const { base } = await boot(app, fakeModel([]), settings(folder()));
    const res = await fetch(`${base}/converse/hello`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello from the app');
  });

  it('ends a chat the person ends: the read-back waiting is dropped, and the end recorded', async () => {
    const dir = folder();
    const { app, booked } = converseFixture();
    const { base } = await boot(app, fakeModel(BOOKING), settings(dir));
    const c = await Chat.open(base);
    c.send({ type: 'start', v: 1, context: { callerNumber: CALLER } });
    await c.until((r) => r.some((m) => m.type === 'say'));
    const session = (c.received[0] as Extract<ServerMessage, { type: 'ready' }>).session;
    await c.say(`Is there a visit free on ${DAY}?`);
    await c.say('The morning please, for Sam Example, on this number.');
    c.send({ type: 'end' });
    await c.until((r) => r.at(-1)?.type === 'end');
    expect(await c.closed).toBe(1000);
    await new Promise((r) => setTimeout(r, 50));
    expect(booked).toEqual([]);
    const rows = auditRows(dir).filter((r) => r.callId === session);
    expect(rows.slice(-2)).toMatchObject([{ type: 'converse_left', detail: { pending: 'book' } }, { type: 'call_ended', detail: { reason: 'hangup' } }]);
    const trace = readFileSync(join(dir, 'traces', 'converse', `${session}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(trace.at(-1)).toMatchObject({ kind: 'converse', said: null, replies: [] });
  });

  it('refuses a converse app\'s calls as the server starts, and still serves its chat', async () => {
    const dir = folder();
    const { app } = converseFixture();
    const env = settings(dir, { VOICE_PROVIDERS: 'twilio', TWILIO_AUTH_TOKEN: 't', HANDOFF_NUMBER: '+15555550199' });
    const { base, logs } = await boot(app, fakeModel([]), env);
    expect(logs.some((l) => l.includes('app converse') && l.includes('converse') && l.includes('takes no calls'))).toBe(true);
    expect((await fetch(`${base}/voice/twilio`, { method: 'POST' })).status).toBe(404);
    const c = await Chat.open(base);
    c.send({ type: 'start', v: 1 });
    await c.until((r) => r.some((m) => m.type === 'say'));
    expect(says(c.received)).toEqual(['Example Visits, how can I help?']);
  });

  it('refuses to start where a number of a host with a phone line would put a call through to a converse app', async () => {
    resetAppsForTest();
    registerApp(callbackApp);
    try {
      const dir = folder();
      const { app } = converseFixture();
      const env = settings(dir, { VOICE_PROVIDERS: 'twilio', TWILIO_AUTH_TOKEN: 't', HANDOFF_NUMBER: '+15555550199', MAIN_LINE: '+15555550101', PRIORITY_LINE: '+15555550102', CALLBACK_DESK: '+15555550103', SECURITY_DESK: '+15555550104', VISIT_LINE: '+15555550105' });
      const apps = hostRouting<HostedApp>({
        apps: [{ id: 'callback', app: callbackApp, env, own: [], ignored: [] }, { id: app.id, app, dir: app.dir, env, own: [], ignored: [] }],
        numbers: [{ variable: 'VISIT_LINE', app: app.id }], defaultApp: 'callback', env,
      });
      await expect(startServer(loadConfig(env), { host: '127.0.0.1', client: yesJev(), log: () => {}, env, apps, converseModel: () => fakeModel([]) }))
        .rejects.toThrow('app "converse" is a converse app, which takes no calls yet (its chat only), but host.yaml lists VISIT_LINE for it');
    } finally {
      resetAppsForTest();
    }
  });
});
