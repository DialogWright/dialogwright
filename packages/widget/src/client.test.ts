import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';
import WebSocket from 'ws';
import {
  CHAT_PROTOCOL_VERSION as ENGINE_VERSION,
  CHAT_TEXT_MAX as ENGINE_TEXT_MAX,
  type ChatErrorCode as EngineErrorCode,
  type ClientMessage as EngineClientMessage,
  type ServerMessage as EngineServerMessage,
} from 'dialogwright/channel/chat/protocol';
import { libraryApp } from 'dialogwright/define/fixture/app';
import { createChatClient, type ChatClient, type ChatClientEvent, type ChatClientOptions } from './client';
import { CHAT_PROTOCOL_VERSION, CHAT_TEXT_MAX, type ChatErrorCode, type ClientMessage, type ServerMessage } from './protocol';
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

  it('starts afresh when the chat it resumes has ended, telling the page, and signs in again', async () => {
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
    // Handled, so not reported as an error.
    expect(t.of('error')).toEqual([]);
    await waitFor(() => t.of('signed_in').length === 2);
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
  });
});
