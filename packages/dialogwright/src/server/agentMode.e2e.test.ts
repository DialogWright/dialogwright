import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type RunningServer } from './index';
import { loadConfig } from './config';
import { registerApp, resetAppsForTest } from '../core/app/registry';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { businessFixtureApp } from '../define/__fixtures__/business/app';

/**
 * The server and an app in agent mode: it builds the app's agent model from style.yaml's `agent` with the
 * app's own settings and says so at start, with its budgets; without the model's key it starts, warns, and
 * runs as a scripted app. No model is asked: the key is only read.
 */

let running: RunningServer | null = null;
const dirs: string[] = [];
afterEach(async () => {
  await running?.close();
  running = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function start(env: Record<string, string>): Promise<string[]> {
  await running?.close();
  running = null;
  resetAppsForTest();
  registerApp(businessFixtureApp);
  const dir = mkdtempSync(join(tmpdir(), 'agent-mode-'));
  dirs.push(dir);
  const config = loadConfig({ PUBLIC_HOST: 'localhost', TWILIO_AUTH_TOKEN: 't', HANDOFF_NUMBER: '+15551234567', PORT: '0', SIGNATURE_CHECK: 'off', TODAY_OVERRIDE: '2026-11-09', TRACE_DIR: dir, AUDIT_DIR: join(dir, 'audit'), AUDIO_DIR: dir });
  const logs: string[] = [];
  running = await startServer(config, { host: '127.0.0.1', client: new HeuristicStubClient({ todayIso: '2026-11-09', app: businessFixtureApp }), log: (l) => logs.push(l), env });
  return logs;
}

describe('an app in agent mode on the server', () => {
  it('builds its agent model from style.yaml with its own settings, and says so, never the key', async () => {
    const logs = await start({ INCEPTION_API_KEY: 'in-test-not-real', AGENT_TIMEOUT_VOICE_MS: '1500' });
    expect(logs).toContain('agent mode: mercury-3 on inception at instant, within 1500 ms on a call and 4000 ms in a chat, its judge 500 and 1000 ms, an answer not in its shape or refused by a content filter asked again once where time allows');
    expect(logs.join('\n')).not.toContain('in-test-not-real');
  });

  it('holds the agent reply\'s judge to RENDER_CHECK_TIMEOUT_MS, as a generated line\'s (the review of Task 7)', async () => {
    const logs = await start({ INCEPTION_API_KEY: 'in-test-not-real', RENDER_CHECK_TIMEOUT_MS: '700' });
    expect(logs).toContain('agent mode: mercury-3 on inception at instant, within 1800 ms on a call and 4000 ms in a chat, its judge 700 and 700 ms, an answer not in its shape or refused by a content filter asked again once where time allows');
  });

  it('without the key, starts and warns: the app runs as a scripted app', async () => {
    const logs = await start({});
    expect(logs).toContain("WARNING: agent mode: mercury-3 on inception (style.yaml's agent), but INCEPTION_API_KEY is unset: the app runs as a scripted app, on its fixed questions with the decision model understanding (pnpm diagnose fails)");
  });

  it('refuses a budget out of range', async () => {
    await expect(start({ INCEPTION_API_KEY: 'x', AGENT_TIMEOUT_CHAT_MS: '20000' })).rejects.toThrow('AGENT_TIMEOUT_CHAT_MS must be a whole number of ms from 300 to 15000');
  });
});
