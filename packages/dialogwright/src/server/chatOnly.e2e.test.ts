import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { startServer, type RunningServer } from './index';
import { loadConfig } from './config';
import { registerApp, resetAppsForTest } from '../core/app/registry';
import { callbackApp } from '../testing/callback/app';

/**
 * A server of the web chat alone (VOICE_PROVIDERS=none): no carrier's secret, no handoff number, no
 * voice webhook, and the chat as on any server.
 */

const TARGETS = { MAIN_LINE: '+15555550101', PRIORITY_LINE: '+15555550102', CALLBACK_DESK: '+15555550103', SECURITY_DESK: '+15555550104' };

let running: RunningServer | null = null;
let dir = '';
afterEach(async () => {
  await running?.close();
  running = null;
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
});

beforeAll(() => {
  resetAppsForTest();
  registerApp(callbackApp);
});

const until = async (ok: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
  if (!ok()) throw new Error('timed out');
};

describe('a server of the web chat alone', () => {
  it('starts with no carrier secret or handoff number, answers no voice webhook, and chats', async () => {
    dir = mkdtempSync(join(tmpdir(), 'chat-only-'));
    const env = {
      PUBLIC_HOST: 'chat.example.com', VOICE_PROVIDERS: 'none', CHAT: 'on', CHAT_ALLOWED_ORIGINS: 'https://www.example.com', PORT: '0',
      TODAY_OVERRIDE: '2026-10-12', TRACE_DIR: join(dir, 'traces'), AUDIT_DIR: join(dir, 'audit'), AUDIO_DIR: dir, DASHBOARD: 'off', JEV_CLIENT: 'stub',
    };
    const logs: string[] = [];
    running = await startServer(loadConfig(env), { host: '127.0.0.1', log: (l) => logs.push(l), env: { ...TARGETS, ...env } });
    const base = `http://127.0.0.1:${running.port}`;
    for (const path of ['/voice', '/voice/twilio', '/voice/telnyx']) expect((await fetch(`${base}${path}`, { method: 'POST' })).status).toBe(404);
    const socket = new WebSocket(`ws://127.0.0.1:${running.port}/chat`, { origin: 'https://www.example.com' });
    const got: { type: string; text?: string }[] = [];
    socket.on('message', (d) => got.push(JSON.parse(d.toString()) as { type: string; text?: string }));
    await new Promise((resolve) => socket.once('open', resolve));
    try {
      socket.send(JSON.stringify({ type: 'start', v: 1 }));
      await until(() => got.some((m) => m.type === 'say'));
      expect(got[0]!.type).toBe('ready');
      expect(got.find((m) => m.type === 'say')!.text).toBe(callbackApp.prompts.manifest.greeting_chat?.text ?? callbackApp.prompts.manifest.greeting!.text);
    } finally {
      socket.close();
    }
  });
});
