import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type RunningServer } from './index';
import { loadConfig, type Env } from './config';
import { hostRouting, type HostedApp } from './host';
import { resetAppsForTest } from '../core/app/registry';
import { fakeModel } from '../converse/model/fake';
import { converseFixture } from '../testing/converse/app';
import { BOOKING, CHAT_ORIGIN, yesJev } from '../testing/converse/chat';
import { callFacts, CONVERSE_CALL_SCHEMA, type SocketLike } from './sessions';

/**
 * The server's call factory in its converse form (plan 2, Task 2): a call in an agent app is a converse
 * entry (its ConverseState on the voice channel, no run options, its app's trace), saved under 'converse-1'
 * and taken back by a server that runs that app. Converse calls are still refused a carrier at start, so the
 * store is driven directly.
 */

const servers: RunningServer[] = [];
const dirs: string[] = [];
beforeEach(() => resetAppsForTest());
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  resetAppsForTest();
});

const sock = (): SocketLike => ({ send: (_d, cb) => cb?.(), close: () => {} });

async function boot(dir: string): Promise<RunningServer> {
  const env: Env = {
    PUBLIC_HOST: 'localhost', VOICE_PROVIDERS: 'none', CHAT: 'on', CHAT_ALLOWED_ORIGINS: CHAT_ORIGIN, PORT: '0', SIGNATURE_CHECK: 'off',
    TRACE_DIR: join(dir, 'traces'), AUDIT_DIR: join(dir, 'audit'), AUDIO_DIR: dir, DASHBOARD: 'off', JEV_CLIENT: 'stub',
    SESSION_STORE: `file:${join(dir, 'sessions')}`,
  };
  const { app } = converseFixture();
  const apps = hostRouting<HostedApp>({ apps: [{ id: app.id, app, dir: app.dir, env, own: [], ignored: [] }], numbers: [], defaultApp: app.id, env });
  const server = await startServer(loadConfig(env), { host: '127.0.0.1', client: yesJev(), log: () => {}, env, converseModel: () => fakeModel(BOOKING), apps });
  servers.push(server);
  return server;
}

describe("the server's call factory for an agent app", () => {
  it('makes a converse entry, saved under its schema and restored by a server that runs the app', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'converse-call-'));
    dirs.push(dir);
    const appId = converseFixture().app.id;
    const first = await boot(dir);
    const e = first.store.createConverse('CA1', sock(), 'twilio', appId);
    expect(e.session).toMatchObject({ kind: 'converse', appId, callId: 'CA1', channel: 'voice', messages: [], turnIndex: 0 });
    expect(e).not.toHaveProperty('opts');
    expect(first.store.get('CA1')).toBeUndefined();
    expect(() => first.store.create('CA2', sock(), 'twilio', appId)).toThrow(/agent app/);
    e.session.turnIndex = 2;
    await first.store.persist('CA1');
    await first.store.settled();

    const second = await boot(dir);
    expect(await second.store.restore('CA1', 'twilio')).toBe('restored');
    const back = second.store.getConverse('CA1')!;
    expect(back.session).toEqual(JSON.parse(JSON.stringify(e.session)));
    expect(callFacts(back.session)).toEqual({ appId, ended: false, locale: 'en', channel: 'voice' });
    expect(CONVERSE_CALL_SCHEMA).toBe('converse-1');
  });
});
