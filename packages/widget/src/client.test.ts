import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';
import WebSocket from 'ws';
import {
  CHAT_PROTOCOL_VERSION as ENGINE_VERSION,
  CHAT_TEXT_MAX as ENGINE_TEXT_MAX,
  type ChatErrorCode as EngineErrorCode,
  type ClientMessage as EngineClientMessage,
  type ServerMessage as EngineServerMessage,
  parseClientMessage,
} from 'dialogwright/channel/chat/protocol';
import { libraryApp } from 'dialogwright/define/fixture/app';
import { testkitApp } from 'dialogwright/testing/testkit/index';
import { createChatClient, type ChatClient, type ChatClientEvent, type ChatClientOptions } from './client';
import { CHAT_PROTOCOL_VERSION, CHAT_TEXT_MAX, isLocaleTag, type ChatErrorCode, type ClientMessage, type ServerMessage } from './protocol';
import { startTestServer, TEST_ORIGIN, type TestServer } from './testServer';

let server: TestServer | null = null;
const clients: ChatClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await server?.close();
  server = null;
});

/** A page's sockets: `ws` with the page's Origin, each one kept so a test can drop it as a network would. */
function sockets() {
  const opened: WebSocket[] = [];
  const socket = (url: string) => {
    const ws = new WebSocket(url, { headers: { origin: TEST_ORIGIN } });
    // As a browser's socket: a failure to connect is a close the client hears, never a thrown error.
    ws.on('error', () => {});
    opened.push(ws);
    return ws as unknown as globalThis.WebSocket;
  };
  return { socket, opened, drop: () => opened.at(-1)!.terminate() };
}

/** A client on the test server, its events recorded. */
function client(o: Partial<ChatClientOptions> = {}) {
  const s = sockets();
  const events: ChatClientEvent[] = [];
  const c = createChatClient({ endpoint: server!.chatUrl, socket: s.socket, onEvent: (e) => events.push(e), ...o });
  clients.push(c);
  const of = <T extends ChatClientEvent['type']>(type: T) => events.filter((e): e is Extract<ChatClientEvent, { type: T }> => e.type === type);
  return { c, events, of, ...s };
}

async function waitFor(ok: () => boolean, ms = 4000): Promise<void> {
  const until = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('the chat client', () => {
  it('starts a session, sends text and hears the lines', async () => {
    server = await startTestServer();
    const t = client();
    const ready = await t.c.ready;
    expect(ready.session).toMatch(/^[0-9a-f]{32}$/);
    expect(ready.locale).toBe('en-US');
    await waitFor(() => t.of('say').length > 0);
    const greeting = t.of('say').length;
    await t.c.send(server.opener);
    await waitFor(() => t.of('say').length > greeting);
    expect(t.events.map((e) => e.type).filter((e) => e !== 'say').slice(0, 3)).toEqual(['connection', 'ready', 'connection']);
    expect(t.events[0]).toEqual({ type: 'connection', state: 'connecting' });
    expect(t.of('connection').at(-1)).toEqual({ type: 'connection', state: 'open' });
    expect(t.of('say')[0]!.lang).toBe('en-US');
  });

  it('resumes the same session after the socket drops, again and again, with the latest resume token', async () => {
    server = await startTestServer();
    const t = client({ backoffMs: [10] });
    const first = await t.c.ready;
    await waitFor(() => t.of('say').length > 0);
    for (let i = 2; i <= 3; i++) {
      t.drop();
      await waitFor(() => t.of('ready').length === i);
    }
    // A used resume token opens nothing, so the third ready proves the client kept the second's token.
    expect(t.of('ready').map((r) => r.session)).toEqual([first.session, first.session, first.session]);
    expect(t.of('restarted')).toEqual([]);
    expect(t.of('connection').map((e) => e.state)).toEqual(['connecting', 'open', 'reconnecting', 'open', 'reconnecting', 'open']);
    // Nothing is said again on a resume: the greeting was heard once.
    expect(t.of('say')).toHaveLength(1);
  });

  it('sends what was typed while it was reconnecting, once the chat is back', async () => {
    server = await startTestServer();
    const t = client({ backoffMs: [50] });
    await t.c.ready;
    await waitFor(() => t.of('say').length > 0);
    t.drop();
    await waitFor(() => t.of('connection').at(-1)?.state === 'reconnecting');
    await t.c.send(server.opener);
    await waitFor(() => t.of('say').length > 1);
    expect(t.of('ready')).toHaveLength(2);
  });

  it('starts afresh when the chat it resumes has ended, telling the page, and signed in again', async () => {
    server = await startTestServer({ env: { CHAT_IDLE_MS: '1' } });
    const t = client({ backoffMs: [100], getToken: async () => `mock:${server!.subjectId}` });
    const first = await t.c.ready;
    await waitFor(() => t.of('signed_in').length === 1);
    t.drop();
    // While it is away, the server ends the idle chat.
    await pause(10);
    server.running.sweep();
    await waitFor(() => t.of('ready').length === 2);
    const again = t.of('ready')[1]!;
    expect(again.session).not.toBe(first.session);
    const types = t.events.map((e) => e.type);
    expect(types.lastIndexOf('restarted')).toBe(types.lastIndexOf('ready') - 1);
    await waitFor(() => t.of('signed_in').length === 2);
    // Handled, so not reported as an error; and nothing refused.
    expect(t.of('error')).toEqual([]);
  });

  it('a delegate comes back signed in too: the new chat starts with their token, as only a start can take it', async () => {
    // The testkit, with a fromClaims that names depot staff by the token's sub (as the engine's own tests do).
    const app = { ...testkitApp, principals: { ...testkitApp.principals!, fromClaims: (c: Record<string, unknown>) => (c.sub === 'taylor' ? testkitApp.principals!.delegatePrincipal!('taylor') : null) } };
    server = await startTestServer({ app, env: { CHAT_IDLE_MS: '1' } });
    const t = client({ backoffMs: [50], getToken: async () => 'mock:taylor' });
    const first = await t.c.ready;
    await waitFor(() => t.of('signed_in').length === 1 && t.of('say').length > 0);
    // A plain drop: the same chat, still theirs, and the token beside the resume is not refused.
    t.drop();
    await waitFor(() => t.of('ready').length === 2);
    expect(t.of('ready')[1]!.session).toBe(first.session);
    t.drop();
    await pause(10);
    server.running.sweep();
    await waitFor(() => t.of('signed_in').length === 2);
    expect(t.of('ready')).toHaveLength(3);
    expect(t.of('ready')[2]!.session).not.toBe(first.session);
    expect(t.of('restarted')).toHaveLength(1);
    expect(t.of('error')).toEqual([]);
  });

  it('a chat that was not signed in starts afresh without asking the site for a token', async () => {
    server = await startTestServer({ env: { CHAT_IDLE_MS: '1' } });
    let asked = 0;
    const t = client({ backoffMs: [50], getToken: async () => { asked += 1; return null; } });
    await t.c.ready;
    await waitFor(() => t.of('say').length > 0);
    t.drop();
    await pause(10);
    server.running.sweep();
    await waitFor(() => t.of('ready').length === 2);
    expect(t.of('restarted')).toHaveLength(1);
    expect(asked).toBe(1);
    expect(t.of('signed_in')).toEqual([]);
  });

  it('signs in with the token the site gives it, at the start', async () => {
    server = await startTestServer();
    let asked = 0;
    const t = client({ getToken: async () => { asked += 1; return `mock:${server!.subjectId}`; } });
    await t.c.ready;
    await waitFor(() => t.of('signed_in').length > 0);
    expect(t.of('signed_in')[0]).toEqual({ type: 'signed_in', level: 2 });
    expect(asked).toBe(1);
  });

  it('signs in when the site says so, mid-chat', async () => {
    server = await startTestServer();
    let token: string | null = null;
    const t = client({ getToken: async () => token });
    await t.c.ready;
    await waitFor(() => t.of('say').length > 0);
    expect(t.of('signed_in')).toEqual([]);
    token = `mock:${server.subjectId}`;
    await t.c.signIn();
    await waitFor(() => t.of('signed_in').length > 0);
  });

  it('reports a sign-in the server refuses', async () => {
    server = await startTestServer();
    const t = client({ getToken: async () => 'not-a-mock-token' });
    await t.c.ready;
    await waitFor(() => t.of('error').length > 0);
    expect(t.of('error')[0]).toMatchObject({ type: 'error', code: 'sign_in_failed' });
  });

  it('asks for a language, and hears each line in it', async () => {
    // The engine's library fixture speaks Spanish beside its default.
    server = await startTestServer({ app: libraryApp });
    const t = client({ locale: 'es-MX' });
    expect((await t.c.ready).locale).toBe('es');
    await waitFor(() => t.of('say').length > 0);
    expect(t.of('say')[0]!.text).toMatch(/^Hola/);
  });

  it('hands a transfer on, hears the end, and does not reconnect', async () => {
    server = await startTestServer();
    const t = client({ backoffMs: [10] });
    await t.c.ready;
    await waitFor(() => t.of('say').length > 0);
    await t.c.send(server.agentLine);
    await waitFor(() => t.of('connection').at(-1)?.state === 'closed');
    const types = t.events.map((e) => e.type);
    expect(types.indexOf('transfer')).toBeGreaterThan(0);
    expect(types.indexOf('end')).toBeGreaterThan(types.indexOf('transfer'));
    await pause(100);
    expect(t.opened).toHaveLength(1);
  });

  it('when the server is full, says busy, backs off, then stops and says the chat is unavailable', async () => {
    server = await startTestServer({ env: { CHAT_MAX_SESSIONS: '1' } });
    const holder = client();
    await holder.c.ready;
    let rejected: unknown = null;
    const t = client({ backoffMs: [10, 20] });
    t.c.ready.catch((e: unknown) => { rejected = e; });
    await waitFor(() => t.of('connection').at(-1)?.state === 'unavailable');
    // The first try, then one per backoff step, and no more.
    expect(t.opened).toHaveLength(3);
    expect(t.of('error').map((e) => e.code)).toEqual(['busy', 'busy', 'busy']);
    await pause(100);
    expect(t.opened).toHaveLength(3);
    expect(rejected).toBeInstanceOf(Error);
  });

  it('stops, saying unavailable, when the server will not take the connection (an origin it does not allow)', async () => {
    server = await startTestServer();
    const opened: WebSocket[] = [];
    const events: ChatClientEvent[] = [];
    const c = createChatClient({
      endpoint: server.chatUrl,
      backoffMs: [10, 20],
      onEvent: (e) => events.push(e),
      socket: (url) => {
        const ws = new WebSocket(url, { headers: { origin: 'https://elsewhere.example.com' } });
        ws.on('error', () => {});
        opened.push(ws);
        return ws as unknown as globalThis.WebSocket;
      },
    });
    clients.push(c);
    const rejected = c.ready.then(() => null, (e: unknown) => e);
    await waitFor(() => events.at(-1)?.type === 'connection' && (events.at(-1) as { state: string }).state === 'unavailable');
    // The first try, then one per backoff step, and no more.
    expect(opened).toHaveLength(3);
    await pause(100);
    expect(opened).toHaveLength(3);
    expect(await rejected).toBeInstanceOf(Error);
    expect(events.filter((e) => e.type === 'ready')).toEqual([]);
  });

  it('stops at once, saying unavailable, when the endpoint cannot be opened at all', async () => {
    const events: ChatClientEvent[] = [];
    const c = createChatClient({ endpoint: 'not a url', onEvent: (e) => events.push(e), socket: () => { throw new SyntaxError('invalid URL'); } });
    clients.push(c);
    await expect(c.ready).rejects.toThrow('the chat endpoint cannot be opened: invalid URL');
    expect(events).toEqual([{ type: 'connection', state: 'connecting' }, { type: 'connection', state: 'unavailable' }]);
  });

  it('keeps bringing a dropped chat back by default, and stops after maxReconnects when the site sets it', async () => {
    server = await startTestServer();
    const keeps = client({ backoffMs: [5] });
    const limited = client({ backoffMs: [5], maxReconnects: 2 });
    await keeps.c.ready;
    await limited.c.ready;
    // The server goes away: every reconnect fails.
    await server.close();
    server = null;
    await waitFor(() => limited.of('connection').at(-1)?.state === 'unavailable');
    // The first socket, then two reconnects.
    expect(limited.opened).toHaveLength(3);
    await waitFor(() => keeps.opened.length > 8);
    expect(keeps.of('connection').at(-1)?.state).toBe('reconnecting');
    expect(keeps.of('connection').some((e) => e.state === 'unavailable')).toBe(false);
  });

  it('refuses options it cannot work with', () => {
    const base = { endpoint: 'ws://localhost:1/chat', onEvent: () => {} };
    expect(() => createChatClient({ ...base, backoffMs: [100, -1] })).toThrow('backoffMs must be a list of delays in ms');
    expect(() => createChatClient({ ...base, backoffMs: [Number.NaN] })).toThrow('backoffMs must be a list of delays in ms');
    expect(() => createChatClient({ ...base, maxReconnects: 1.5 })).toThrow('maxReconnects must be a whole number of tries, or Infinity');
    expect(() => createChatClient({ ...base, maxReconnects: -1 })).toThrow('maxReconnects must be a whole number');
  });

  it('closes when the page says so, and does not reconnect', async () => {
    server = await startTestServer();
    const t = client({ backoffMs: [10] });
    await t.c.ready;
    t.c.close();
    await waitFor(() => t.of('connection').at(-1)?.state === 'closed');
    await pause(100);
    expect(t.opened).toHaveLength(1);
  });

  it('speaks the engine\'s protocol: its copy of the wire is the engine\'s', () => {
    expect(CHAT_PROTOCOL_VERSION).toBe(ENGINE_VERSION);
    expect(CHAT_TEXT_MAX).toBe(ENGINE_TEXT_MAX);
    // Checked by the type checker (pnpm typecheck): a message added to one side and not the other fails it.
    expectTypeOf<ServerMessage>().toEqualTypeOf<EngineServerMessage>();
    expectTypeOf<ClientMessage>().toEqualTypeOf<EngineClientMessage>();
    expectTypeOf<ChatErrorCode>().toEqualTypeOf<EngineErrorCode>();
    // The language tags the widget asks with are those a start may carry.
    for (const tag of ['en', 'es-MX', 'zh_Hant_TW', 'sr-Latn-RS', 'x', 'en US', 'en-', '123', 'a'.repeat(9), `en${'-abcdefgh'.repeat(4)}`]) {
      expect(isLocaleTag(tag), tag).toBe(parseClientMessage(JSON.stringify({ type: 'start', v: 1, locale: tag })).ok);
    }
  });
});

/** A socket the test speaks for: it records what the client sends, and says what a server would. */
class FakeSocket {
  readyState = 0;
  readonly sent: ClientMessage[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  send(data: string): void {
    this.sent.push(JSON.parse(data) as ClientMessage);
  }
  close(): void {
    this.drop(1000);
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  say(m: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  drop(code = 1006): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason: '' });
  }
}

describe('the chat client, its messages in order', () => {
  function fake(o: Partial<ChatClientOptions> = {}) {
    const made: FakeSocket[] = [];
    const events: ChatClientEvent[] = [];
    const c = createChatClient({
      endpoint: 'wss://chat.example.com/chat',
      backoffMs: [1],
      onEvent: (e) => events.push(e),
      socket: () => {
        const s = new FakeSocket();
        made.push(s);
        return s as unknown as globalThis.WebSocket;
      },
      ...o,
    });
    clients.push(c);
    /** The latest socket, once the client has opened it (it asks the site for a token first). */
    const next = async (n: number): Promise<FakeSocket> => {
      await waitFor(() => made.length >= n);
      return made[n - 1]!;
    };
    return { c, made, events, next };
  }
  const ready = (resume: string, session = 's1'): ServerMessage => ({ type: 'ready', session, resume, locale: 'en-US' });
  const texts = (s: FakeSocket) => s.sent.filter((m) => m.type === 'text');
  const R1 = 'a'.repeat(32);
  const R2 = 'b'.repeat(32);
  const R3 = 'c'.repeat(32);

  it('after a restart, holds what was typed until the new chat is signed in, and never sends sign_in', async () => {
    const t = fake({ getToken: async () => 'mock:55501234' });
    const one = await t.next(1);
    one.open();
    expect(one.sent).toEqual([{ type: 'start', v: 1, token: 'mock:55501234' }]);
    one.say(ready(R1));
    one.say({ type: 'signed_in', level: 2 });
    one.drop();
    // Typed while it is away.
    await t.c.send('where is my parcel');
    const two = await t.next(2);
    two.open();
    // The resume brings the token, for the new chat if this one has ended.
    expect(two.sent).toEqual([{ type: 'start', v: 1, token: 'mock:55501234', resume: R1 }]);
    two.say({ type: 'error', code: 'session_unknown', message: 'that chat has ended; a new one starts' });
    two.say(ready(R2, 's2'));
    two.say({ type: 'say', text: 'Hello.', lang: 'en-US' });
    await t.c.send('and another');
    expect(texts(two)).toEqual([]);
    two.say({ type: 'signed_in', level: 2 });
    expect(texts(two).map((m) => m.text)).toEqual(['where is my parcel', 'and another']);
    expect(two.sent.some((m) => m.type === 'sign_in')).toBe(false);
    expect(t.events.filter((e) => e.type === 'restarted')).toHaveLength(1);
  });

  it('sends what it held when the new chat\'s sign-in is refused', async () => {
    const t = fake({ getToken: async () => 'mock:55501234' });
    const one = await t.next(1);
    one.open();
    one.say(ready(R1));
    one.say({ type: 'signed_in', level: 2 });
    one.drop();
    await t.c.send('hello');
    const two = await t.next(2);
    two.open();
    two.say({ type: 'error', code: 'session_unknown', message: 'that chat has ended; a new one starts' });
    two.say(ready(R2, 's2'));
    expect(texts(two)).toEqual([]);
    two.say({ type: 'error', code: 'sign_in_failed', message: 'the sign-in was refused (expired)' });
    expect(texts(two).map((m) => m.text)).toEqual(['hello']);
    // The new chat is not signed in: the next reconnect resumes it without a token.
    two.drop();
    const three = await t.next(3);
    three.open();
    expect(three.sent).toEqual([{ type: 'start', v: 1, resume: R2 }]);
  });

  it('sends at once what is typed on a chat resumed, signed in or not', async () => {
    const t = fake({ getToken: async () => 'mock:55501234' });
    const one = await t.next(1);
    one.open();
    one.say(ready(R1));
    one.say({ type: 'signed_in', level: 2 });
    one.drop();
    await t.c.send('hello');
    const two = await t.next(2);
    two.open();
    two.say(ready(R3));
    // The same chat, which keeps its sign-in: nothing to wait for.
    expect(texts(two).map((m) => m.text)).toEqual(['hello']);
  });

  it('without a token, sends what it held as soon as the new chat is ready', async () => {
    const t = fake();
    const one = await t.next(1);
    one.open();
    expect(one.sent).toEqual([{ type: 'start', v: 1 }]);
    one.say(ready(R1));
    one.drop();
    await t.c.send('hello');
    const two = await t.next(2);
    two.open();
    two.say({ type: 'error', code: 'session_unknown', message: 'that chat has ended; a new one starts' });
    two.say(ready(R2, 's2'));
    expect(texts(two).map((m) => m.text)).toEqual(['hello']);
  });
});
