import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type RunningServer } from './index';
import { loadConfig, type Env } from './config';
import { hostRouting, type HostedApp } from './host';
import { resetAppsForTest } from '../core/app/registry';
import { fakeModel } from '../converse/model/fake';
import { converseFixture } from '../testing/converse/app';
import { BOOKING, CHAT_ORIGIN, Chat, says, yesJev } from '../testing/converse/chat';
import { FileCallStateStore, FileChatStateStore } from './stores/file';
import { tokenHash } from './stores/types';
import { DashboardBus } from './dashboard/bus';
import { handleDashboardRequest } from './dashboard/routes';
import { forgetSummaries } from './dashboard/calls';
import type { CallRow } from './dashboard/view.js';
import { registerTestkit } from '../testing/testkit';

/**
 * A call and a trace saved before `mode: converse` became `mode: agent` (plan 3, Task 5, review focus 1):
 * the records are written here as the runtime wrote them then (a ConverseState of `kind: 'converse'` under
 * the schema 'converse-1', a trace record of `kind: 'converse'`), by hand and not by the code under test,
 * so a change to what the code writes could not change what is read back. The rename touched the mode
 * string and the words only; each record is still read.
 */

const servers: RunningServer[] = [];
const sockets: Chat[] = [];
const dirs: string[] = [];
let consoleServer: Server | null = null;
beforeEach(() => resetAppsForTest());
afterEach(async () => {
  for (const c of sockets.splice(0)) c.close();
  for (const s of servers.splice(0)) await s.close();
  await new Promise<void>((r) => (consoleServer ? consoleServer.close(() => r()) : r()));
  consoleServer = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  forgetSummaries();
  resetAppsForTest();
});

function folder(): string {
  const d = mkdtempSync(join(tmpdir(), 'before-rename-'));
  dirs.push(d);
  return d;
}

/** A converse call's state as the runtime saved it before the rename. */
function oldState(appId: string, callId: string, channel: 'chat' | 'voice'): Record<string, unknown> {
  return {
    kind: 'converse', v: 1, appId, callId, channel,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Is there a visit free on Tuesday?' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Let me look.' }] },
    ],
    pending: null, seen: {}, failures: 0, refusals: {}, caller: {}, turnIndex: 1,
  };
}

async function boot(dir: string): Promise<{ server: RunningServer; base: string; logs: string[]; appId: string }> {
  const env: Env = {
    PUBLIC_HOST: 'localhost', VOICE_PROVIDERS: 'none', CHAT: 'on', CHAT_ALLOWED_ORIGINS: CHAT_ORIGIN, PORT: '0', SIGNATURE_CHECK: 'off',
    TRACE_DIR: join(dir, 'traces'), AUDIT_DIR: join(dir, 'audit'), AUDIO_DIR: dir, DASHBOARD: 'off', JEV_CLIENT: 'stub',
    SESSION_STORE: `file:${join(dir, 'sessions')}`,
  };
  const { app } = converseFixture();
  const logs: string[] = [];
  const apps = hostRouting<HostedApp>({ apps: [{ id: app.id, app, dir: app.dir, env, own: [], ignored: [] }], numbers: [], defaultApp: app.id, env });
  const server = await startServer(loadConfig(env), { host: '127.0.0.1', client: yesJev(), log: (l) => logs.push(l), env, converseModel: () => fakeModel(BOOKING), apps });
  servers.push(server);
  return { server, base: `http://127.0.0.1:${server.port}`, logs, appId: app.id };
}

describe('a converse call and trace saved before the rename', () => {
  it('a converse call saved on the voice channel resumes', async () => {
    const dir = folder();
    const appId = converseFixture().app.id;
    await new FileCallStateStore(join(dir, 'sessions', 'calls')).save({
      callId: 'CA1', provider: 'twilio', schema: 'converse-1', session: oldState(appId, 'CA1', 'voice') as never, reconnects: 0,
      createdAtMs: Date.now(), lastActivityMs: Date.now(), auditTail: [],
    });
    const { server } = await boot(dir);
    expect(await server.store.restore('CA1', 'twilio')).toBe('restored');
    const back = server.store.getConverse('CA1')!;
    expect(back.session).toMatchObject({ kind: 'converse', appId, callId: 'CA1', channel: 'voice', turnIndex: 1 });
    expect(back.session.messages).toHaveLength(2);
  });

  it('a converse chat saved before it resumes, with its words', async () => {
    const dir = folder();
    const appId = converseFixture().app.id;
    await new FileChatStateStore(join(dir, 'sessions', 'chats')).save({
      id: 'chat-old', schema: 'converse-1', session: oldState(appId, 'chat-old', 'chat'), resumeHash: tokenHash('0123456789abcdef0123456789abcdef'),
      createdAtMs: Date.now(), lastActivityMs: Date.now(), auditTail: [],
    });
    const { base, logs } = await boot(dir);
    const c = await Chat.open(base, sockets);
    c.send({ type: 'start', v: 1, resume: '0123456789abcdef0123456789abcdef' });
    const [ready] = await c.until((r) => r.length >= 1);
    expect(ready).toMatchObject({ type: 'ready', session: 'chat-old' });
    expect(logs).toContain('chat chat-old: restored from the session store');
    expect(says(c.received)).toEqual([]);
  });

  it('a converse trace lists and opens in the console', async () => {
    registerTestkit();
    const dir = folder();
    const T0 = Date.parse('2026-11-11T15:00:00.000Z');
    const ts = (s: number): string => new Date(T0 + s * 1000).toISOString();
    const model = (ms: number): unknown => ({ id: 'fake', ms, firstTextMs: ms === 0 ? null : 120, usage: { inputTokens: 200, outputTokens: 20 }, costUsd: 0.0004 });
    const records = [
      { v: 3, kind: 'converse', sessionId: 'chat-old', turnIndex: 0, ts: ts(0), said: null, replies: ['Example Visits, how can I help?'], tools: [], model: model(0) },
      { v: 3, kind: 'converse', sessionId: 'chat-old', turnIndex: 1, ts: ts(5), said: 'Is there a visit free on Tuesday?', replies: ['We have the morning.'], tools: [{ name: 'availability', args: { day: '•' }, outcome: 'ran' }], model: model(900) },
    ];
    writeFileSync(join(dir, 'chat-old.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    writeFileSync(join(dir, 'chat-old.frames.jsonl'), [{ ts: ts(0), dir: 'in', msg: { type: 'start', v: 1 } }, { ts: ts(8), dir: 'log', msg: { ended: 'caller' } }].map((r) => JSON.stringify(r)).join('\n') + '\n');
    for (const f of ['chat-old.jsonl', 'chat-old.frames.jsonl']) utimesSync(join(dir, f), (T0 + 8000) / 1000, (T0 + 8000) / 1000);
    const bus = new DashboardBus();
    consoleServer = createServer((req, res) => {
      if (!handleDashboardRequest(req, res, { bus, traceDir: dir, enabled: true })) { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((r) => consoleServer!.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(consoleServer.address() as { port: number }).port}`;

    const listed = await fetch(`${base}/dashboard/calls`);
    expect(listed.status).toBe(200);
    const { rows } = (await listed.json()) as { rows: CallRow[] };
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ callSid: 'chat-old', channel: 'chat', turns: 1, status: 'ended' });
    const opened = await fetch(`${base}/dashboard/traces/chat-old`);
    expect(opened.status).toBe(200);
    const one = (await opened.json()) as { records: { kind?: string }[] };
    expect(one.records.map((r) => r.kind)).toEqual(['converse', 'converse']);
  });
});
