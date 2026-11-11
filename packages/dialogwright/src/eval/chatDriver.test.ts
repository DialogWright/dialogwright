import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { libraryApp } from '../define/fixture/app';
import { registerApp, resetAppsForTest } from '../core/app/registry';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { loadConfig } from '../server/config';
import { startServer, type RunningServer } from '../server/index';
import { driveChat, turnEndSignal } from './chatDriver';
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
    expect(call.callerEnded).toEqual({ how: 'hang_up' });
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

describe('driveChat: the number a persona calls from', () => {
  /** A chat server that keeps each start it is sent, answers ready and a greeting, then ends. */
  async function recorder(): Promise<{ url: string; starts: Record<string, unknown>[]; close: () => Promise<void> }> {
    const { WebSocketServer } = await import('ws');
    const starts: Record<string, unknown>[] = [];
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    wss.on('connection', (ws) => {
      ws.once('message', (d) => {
        starts.push(JSON.parse(d.toString()) as Record<string, unknown>);
        ws.send(JSON.stringify({ type: 'ready', session: 's1' }));
        ws.send(JSON.stringify({ type: 'say', text: 'Hello.' }));
        ws.send(JSON.stringify({ type: 'end' }));
      });
    });
    const port = (wss.address() as { port: number }).port;
    return { url: `ws://127.0.0.1:${port}/chat`, starts, close: () => new Promise((resolve) => wss.close(() => resolve())) };
  }

  it('names it in the start\'s context (callerNumber) where the persona has one, and names none otherwise', async () => {
    const r = await recorder();
    try {
      await driveChat({ url: r.url, origin: ORIGIN, persona: { ...persona, callingFrom: '+15555550142' }, maxTurns: 1, timeoutMs: 2000, settleMs: 50, caller: async () => null });
      await driveChat({ url: r.url, origin: ORIGIN, persona, maxTurns: 1, timeoutMs: 2000, settleMs: 50, caller: async () => null });
    } finally {
      await r.close();
    }
    expect(r.starts).toEqual([{ type: 'start', v: 1, stream: true, context: { callerNumber: '+15555550142' } }, { type: 'start', v: 1, stream: true }]);
  });
});

describe('driveChat: the first sentence', () => {
  it('asks for the reply streamed, times the first sentence (its say_delta), and keeps the reply from its say alone', async () => {
    const { WebSocketServer } = await import('ws');
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    wss.on('connection', (ws) => {
      ws.once('message', () => {
        ws.send(JSON.stringify({ type: 'ready', session: 's1' }));
        ws.send(JSON.stringify({ type: 'say', text: 'Hello.' }));
        ws.on('message', () => {
          setTimeout(() => ws.send(JSON.stringify({ type: 'say_delta', text: 'Sure. ' })), 20);
          setTimeout(() => ws.send(JSON.stringify({ type: 'say_delta', text: 'Friday is free.' })), 300);
          setTimeout(() => ws.send(JSON.stringify({ type: 'say', text: 'Sure. Friday is free.' })), 310);
        });
      });
    });
    const port = (wss.address() as { port: number }).port;
    try {
      let asked = 0;
      const call = await driveChat({ url: `ws://127.0.0.1:${port}/chat`, origin: ORIGIN, persona, maxTurns: 1, timeoutMs: 2000, settleMs: 100, caller: async () => (asked++ === 0 ? 'Is Friday free?' : null) });
      expect(call.firstWordMs).toHaveLength(1);
      expect(call.firstWordMs[0]).toBeLessThan(250);
      expect(call.turns.at(-1)).toMatchObject({ who: 'line', text: 'Sure. Friday is free.' });
    } finally {
      await new Promise((resolve) => wss.close(() => resolve(undefined)));
    }
  });
});

describe('driveChat: a turn\'s end (the chat runtime\'s onTurnEnd)', () => {
  const SLIP = 'We are open Saturdays too.';
  const CORRECTION = 'Sorry, I should correct that: we are open every day, 9 to 5.';

  /** A chat server whose reply to a caller is a say, then after `lateMs` a correction, the turn's end told once both are sent. */
  async function correcting(lateMs: number) {
    const { WebSocketServer } = await import('ws');
    const ends = turnEndSignal();
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    wss.on('connection', (ws) => {
      ws.once('message', () => {
        ws.send(JSON.stringify({ type: 'ready', session: 's1' }));
        ws.send(JSON.stringify({ type: 'say', text: 'Hello.' }));
        ends.ended('s1');
        ws.on('message', (d) => {
          if ((JSON.parse(d.toString()) as { type: string }).type !== 'text') return;
          setTimeout(() => ws.send(JSON.stringify({ type: 'say', text: SLIP })), 20);
          setTimeout(() => {
            ws.send(JSON.stringify({ type: 'say', text: CORRECTION }));
            ends.ended('s1');
          }, 20 + lateMs);
        });
      });
    });
    const port = (wss.address() as { port: number }).port;
    return { url: `ws://127.0.0.1:${port}/chat`, ends, close: () => new Promise<void>((resolve) => wss.close(() => resolve())) };
  }

  it('keeps a reply and a correction that follows it after more than settleMs as one line turn, ending it at the turn\'s end', async () => {
    const s = await correcting(500);
    try {
      let asked = 0;
      const call = await driveChat({ url: s.url, origin: ORIGIN, persona, maxTurns: 2, timeoutMs: 5000, settleMs: 100, turnEnds: s.ends, caller: async () => (asked++ === 0 ? 'Are you open Saturday?' : null) });
      expect(call.turns.map((t) => t.who)).toEqual(['line', 'caller', 'line']);
      expect(call.turns[0]!.text).toBe('Hello.');
      expect(call.turns[2]!.text).toBe(`${SLIP} ${CORRECTION}`);
      expect(call.ended).toBe('caller');
    } finally {
      await s.close();
    }
  });

  it('with no turn ends, settles as before: the reply ends settleMs after its last line, before the correction', async () => {
    const s = await correcting(500);
    try {
      let asked = 0;
      const call = await driveChat({ url: s.url, origin: ORIGIN, persona, maxTurns: 1, timeoutMs: 5000, settleMs: 100, caller: async () => (asked++ === 0 ? 'Are you open Saturday?' : null) });
      expect(call.turns.at(-1)).toMatchObject({ who: 'line', text: SLIP });
    } finally {
      await s.close();
    }
  });

  it('ends a reply at the turn\'s end of an engine\'s own server (ServerOverrides.onTurnEnd), not after settling', async () => {
    dir = mkdtempSync(join(tmpdir(), 'eval-driver-'));
    const ends = turnEndSignal();
    const env = { PUBLIC_HOST: 'localhost', VOICE_PROVIDERS: 'none', CHAT: 'on', CHAT_ALLOWED_ORIGINS: ORIGIN, PORT: '0', TODAY_OVERRIDE: '2026-10-12', TRACE_DIR: join(dir, 'traces'), AUDIT_DIR: join(dir, 'audit'), AUDIO_DIR: dir, DASHBOARD: 'off', JEV_CLIENT: 'stub' };
    running = await startServer(loadConfig(env), { host: '127.0.0.1', log: () => {}, env, client: new HeuristicStubClient({ todayIso: '2026-10-12', app: libraryApp }), onTurnEnd: ends.ended });
    const lines = ['I want to check a hold'];
    let i = 0;
    const began = Date.now();
    // A settle far longer than the test may take: each reply must end at its turn's end.
    const call = await driveChat({ url: `ws://127.0.0.1:${running.port}/chat`, origin: ORIGIN, persona, maxTurns: 4, timeoutMs: 20_000, settleMs: 20_000, turnEnds: ends, caller: async () => lines[i++] ?? null });
    expect(Date.now() - began).toBeLessThan(5000);
    expect(call.turns.map((t) => t.who)).toEqual(['line', 'caller', 'line']);
    expect(call.ended).toBe('caller');
  });
});
