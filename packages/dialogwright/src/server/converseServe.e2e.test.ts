import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, SERVER_RECORDS, type RunningServer } from './index';
import { loadConfig, type Env } from './config';
import { hostRouting, loadHost, type HostedApp, type HostRouting } from './host';
import { registerApp, registeredConverseApps, resetAppsForTest } from '../core/app/registry';
import { fakeModel } from '../converse/model/fake';
import { isConverseApp, type ConverseApp } from '../converse/app';
import { fakeTextProvider } from '../texts/record';
import type { IncomingText } from '../texts/types';
import { registerFolderApp } from '../eval/cli';
import { actionsOfCall } from '../eval/judge';
import { CONVERSE_FIXTURE_DIR, converseFixture } from '../testing/converse/app';
import { callbackApp } from '../testing/callback/app';
import { auditRowsIn, BOOKING, CHAT_ORIGIN, Chat, DAY, says, yesJev } from '../testing/converse/chat';
import type { ServerMessage } from '../channel/chat/protocol';

/**
 * The start paths that serve a converse app: a launcher that registers it (registerConverseApp, as an app
 * package's serve.ts does before serverMain, and as the eval CLI does), host.yaml (loadHost), and the
 * texts that come in for it, on a host of it alone and beside a scripted app.
 */

const CALLBACK_FIXTURE = fileURLToPath(new URL('../testing/callback', import.meta.url));
const CALLBACK_ENV = fileURLToPath(new URL('../testing/host/callback.env', import.meta.url));
const VISIT_LINE = '+15555550160';
const CALLBACK_LINE = '+15555550161';
const VISIT_TEXTS = '+15555550162';

const servers: RunningServer[] = [];
const sockets: Chat[] = [];
const dirs: string[] = [];
beforeEach(() => resetAppsForTest());
afterEach(async () => {
  for (const c of sockets.splice(0)) c.close();
  for (const s of servers.splice(0)) await s.close();
  await new Promise((r) => setTimeout(r, 20));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  resetAppsForTest();
});

function folder(): string {
  const d = mkdtempSync(join(tmpdir(), 'converse-serve-'));
  dirs.push(d);
  return d;
}

function settings(dir: string, extra: Record<string, string> = {}): Env {
  return {
    PUBLIC_HOST: 'localhost', VOICE_PROVIDERS: 'none', CHAT: 'on', CHAT_ALLOWED_ORIGINS: CHAT_ORIGIN, PORT: '0', SIGNATURE_CHECK: 'off',
    TRACE_DIR: join(dir, 'traces'), AUDIT_DIR: join(dir, 'audit'), AUDIO_DIR: dir, DASHBOARD: 'off', JEV_CLIENT: 'stub', ...extra,
  };
}

async function boot(env: Env, apps?: HostRouting<HostedApp>): Promise<{ base: string; logs: string[] }> {
  const logs: string[] = [];
  const server = await startServer(loadConfig(env), { host: '127.0.0.1', client: yesJev(), log: (l) => logs.push(l), env, converseModel: () => fakeModel(BOOKING), textProvider: fakeTextProvider(), ...(apps ? { apps } : {}) });
  servers.push(server);
  return { base: `http://127.0.0.1:${server.port}`, logs };
}

async function greeted(base: string, path = '/chat'): Promise<{ chat: Chat; session: string }> {
  const chat = await Chat.open(base, sockets, path);
  chat.send({ type: 'start', v: 1 });
  await chat.until((r) => r.some((m) => m.type === 'say'));
  return { chat, session: (chat.received[0] as Extract<ServerMessage, { type: 'ready' }>).session };
}

const textIn = (base: string, id: string, to: string): Promise<Response> => fetch(`${base}/messages/twilio`, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ MessageSid: id, From: '+15555550177', To: to, Body: 'hello' }).toString(),
});

describe('a launcher that registers a converse app', () => {
  it('is served by a server started with no host, as a host of it alone; the eval reads its audit where it is written', async () => {
    const app = await registerFolderApp(CONVERSE_FIXTURE_DIR);
    expect(isConverseApp(app)).toBe(true);
    expect(registeredConverseApps().map((a) => a.id)).toEqual(['converse']);
    const dir = folder();
    const { base } = await boot(settings(dir));
    const { chat, session } = await greeted(base);
    expect(says(chat.received)).toEqual(['Example Visits, how can I help?']);
    await chat.say(`Is there a visit free on ${DAY}?`);
    await new Promise((r) => setTimeout(r, 50));
    // A host of one: its audit in AUDIT_DIR/<app id>, which the eval's reader walks.
    expect(existsSync(join(dir, 'audit', 'converse'))).toBe(true);
    expect(actionsOfCall(join(dir, 'audit'), session).map((a) => `${a.tool} ${a.verdict}`)).toEqual(['availability ALLOW']);
  });

  it('starts under JEV_CLIENT=stub (the eval\'s --stub-decision), its decision model the heuristics, which it warns confirm no read-back', async () => {
    await registerFolderApp(CONVERSE_FIXTURE_DIR);
    const dir = folder();
    const env = settings(dir, { JEV_CLIENT: 'stub' });
    const logs: string[] = [];
    const server = await startServer(loadConfig(env), { host: '127.0.0.1', log: (l) => logs.push(l), env, converseModel: () => fakeModel(BOOKING) });
    servers.push(server);
    expect(logs.some((l) => l.startsWith('WARNING: app converse: JEV_CLIENT=stub: a converse app\'s read-backs are read by the decision model'))).toBe(true);
    const { chat } = await greeted(`http://127.0.0.1:${server.port}`);
    expect(says(chat.received)).toEqual(['Example Visits, how can I help?']);
  });

  it('beside a scripted app registered in the same process, is refused as the server starts: they are served as a host', async () => {
    registerApp(callbackApp);
    await registerFolderApp(CONVERSE_FIXTURE_DIR);
    await expect(startServer(loadConfig(settings(folder())), { host: '127.0.0.1', client: yesJev(), log: () => {}, converseModel: () => fakeModel([]) }))
      .rejects.toThrow('this process registered the scripted app "callback" and the converse app "converse": serve them together as a host (host.yaml: pnpm start --host), or register one kind');
  });
});

/** A host file beside the fixtures: the converse fixture and the callback fixture, each reached by a number. */
function hostFile(dir: string): string {
  const file = join(dir, 'host.yaml');
  writeFileSync(file, [
    'apps:',
    `  - { folder: ${relative(dir, CONVERSE_FIXTURE_DIR)} }`,
    `  - { folder: ${relative(dir, CALLBACK_FIXTURE)}, env: ${relative(dir, CALLBACK_ENV)} }`,
    'numbers:',
    '  - { number: env.VISIT_LINE, app: converse }',
    '  - { number: env.CALLBACK_LINE, app: callback }',
    'default: callback',
    '',
  ].join('\n'));
  return file;
}

describe('host.yaml with a converse app', () => {
  it('loads it from its folder (app.yaml mode: converse, its module\'s ConverseApp) and serves its chat beside a scripted app\'s', async () => {
    const dir = folder();
    const env = settings(dir, { VISIT_LINE, CALLBACK_LINE });
    const host = await loadHost(hostFile(dir), env);
    expect(host.apps.map((a) => [a.id, isConverseApp(a.app)])).toEqual([['callback', false], ['converse', true]]);
    const { base } = await boot(env, host);
    expect(says((await greeted(base, '/chat/converse')).chat.received)).toEqual(['Example Visits, how can I help?']);
    expect(says((await greeted(base, '/chat/callback')).chat.received)).toHaveLength(1);
    expect(says((await greeted(base, '/chat/callback')).chat.received)[0]).not.toBe('Example Visits, how can I help?');
  });
});

describe('a text that comes in for a converse app', () => {
  it('beside a scripted app, reaches the converse app\'s own hook when host.yaml lists the number for it, and is recorded in its audit', async () => {
    const dir = folder();
    const env = settings(dir, { VISIT_LINE, CALLBACK_LINE });
    const loaded = await loadHost(hostFile(dir), env);
    const got: { app: string; m: IncomingText }[] = [];
    const host = { ...loaded, apps: loaded.apps.map((a) => (isConverseApp(a.app) ? { ...a, app: { ...a.app, onText: (m: IncomingText) => void got.push({ app: a.id, m }) } as ConverseApp } : a)) };
    const { base } = await boot(env, host);
    expect((await textIn(base, 'SM1', VISIT_LINE)).status).toBe(200);
    expect((await textIn(base, 'SM2', CALLBACK_LINE)).status).toBe(200);
    await vi.waitFor(() => expect(got).toHaveLength(1));
    expect(got.map((g) => [g.app, g.m.id])).toEqual([['converse', 'SM1']]);
    await vi.waitFor(() => expect(auditRowsIn(join(dir, 'audit', 'callback')).filter((r) => r.type === 'text_received').map((r) => r.callId)).toEqual(['SM2']));
    expect(auditRowsIn(join(dir, 'audit', 'converse')).filter((r) => r.type === 'text_received').map((r) => r.callId)).toEqual(['SM1']);
  });

  it('on a host of converse apps alone, with no hook, is recorded in its audit and handed to no app; another number\'s under the server\'s own', async () => {
    const dir = folder();
    const env = settings(dir, { TEXT_FROM: VISIT_TEXTS, TWILIO_ACCOUNT_SID: `AC${'4'.repeat(32)}`, TWILIO_AUTH_TOKEN: 't' });
    const { app } = converseFixture();
    const host = hostRouting<HostedApp>({ apps: [{ id: app.id, app, dir: app.dir, env, own: [], ignored: [] }], numbers: [], defaultApp: app.id, env });
    const { base, logs } = await boot(env, host);
    expect((await textIn(base, 'SM3', VISIT_TEXTS)).status).toBe(200);
    expect((await textIn(base, 'SM4', '+15555550198')).status).toBe(200);
    await vi.waitFor(() => expect(auditRowsIn(join(dir, 'audit', SERVER_RECORDS)).map((r) => r.callId)).toEqual(['SM4']));
    await vi.waitFor(() => expect(auditRowsIn(join(dir, 'audit', 'converse')).filter((r) => r.type === 'text_received').map((r) => r.callId)).toEqual(['SM3']));
    expect(logs.some((l) => /onText failed/.test(l))).toBe(false);
  });
});
