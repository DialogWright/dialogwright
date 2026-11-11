import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { libraryApp } from '../define/fixture/app';
import { registerApp, resetAppsForTest } from '../core/app/registry';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { loadConfig } from '../server/config';
import { startServer, type RunningServer } from '../server/index';
import { driveChat } from './chatDriver';
import type { Persona } from './personas';

const ORIGIN = 'https://eval.example.com';
const persona: Persona = { id: 'p', goal: 'Check a hold.', truth: { name: 'Pat Example' }, manner: 'Plain.', expects: 'answer' };

let running: RunningServer | null = null;
let dir = '';
afterEach(async () => {
  await running?.close();
  running = null;
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
});
beforeAll(() => {
  resetAppsForTest();
  registerApp(libraryApp);
});

async function start(): Promise<string> {
  dir = mkdtempSync(join(tmpdir(), 'eval-driver-'));
  const env = { PUBLIC_HOST: 'localhost', VOICE_PROVIDERS: 'none', CHAT: 'on', CHAT_ALLOWED_ORIGINS: ORIGIN, PORT: '0', TODAY_OVERRIDE: '2026-10-12', TRACE_DIR: join(dir, 'traces'), AUDIT_DIR: join(dir, 'audit'), AUDIO_DIR: dir, DASHBOARD: 'off', JEV_CLIENT: 'stub' };
  running = await startServer(loadConfig(env), { host: '127.0.0.1', log: () => {}, env, client: new HeuristicStubClient({ todayIso: '2026-10-12', app: libraryApp }) });
  return `ws://127.0.0.1:${running.port}/chat`;
}

describe('driveChat', () => {
  it('opens with the greeting, alternates caller and line, and ends when the caller hangs up', async () => {
    const url = await start();
    const lines = ['I want to check a hold', 'the Riverside branch'];
    let i = 0;
    const seen: number[] = [];
    const call = await driveChat({ url, origin: ORIGIN, persona, maxTurns: 6, timeoutMs: 5000, settleMs: 150, caller: async (_p, turns) => { seen.push(turns.length); return lines[i++] ?? null; } });
    expect(call.persona).toBe('p');
    expect(call.turns[0]!.who).toBe('line');
    expect(call.turns.map((t) => t.who)).toEqual(['line', 'caller', 'line', 'caller', 'line']);
    expect(call.turns[1]!.text).toBe('I want to check a hold');
    expect(call.ended).toBe('caller');
    expect(call.firstWordMs).toHaveLength(2);
    expect(call.firstWordMs.every((m) => m >= 0 && m < 5000)).toBe(true);
    expect(call.callId).toMatch(/\S/);
    expect(seen).toEqual([1, 3, 5]);
  });

  it('stops at the turn limit', async () => {
    const url = await start();
    const call = await driveChat({ url, origin: ORIGIN, persona, maxTurns: 1, timeoutMs: 5000, settleMs: 150, caller: async () => 'I want to check a hold' });
    expect(call.ended).toBe('turns');
    expect(call.firstWordMs).toHaveLength(1);
  });
});
