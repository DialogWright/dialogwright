import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defineConverseApp } from '../converse/app';
import { fakeModel } from '../converse/model/fake';
import { CONVERSE_FIXTURE_DIR } from '../testing/converse/app';
import { done, text } from '../testing/converse/chat';
import { ClaimsCases, CLAIMS_CASES_FILE } from './claimsCases';
import { EVAL_USAGE, evalCommand } from './cli';
import { startEvalServer } from './server';
import WebSocket from 'ws';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const folder = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'claims-cases-'));
  dirs.push(d);
  return d;
};

const state = (business: string, reply: string) => ({ business, today: 'Wednesday, November 11, 2026 (2026-11-11)', actions: [{ action: 'lookup', args: {}, result: 'ok' }], reply });
const lines = (dir: string): Record<string, unknown>[] => readFileSync(join(dir, CLAIMS_CASES_FILE), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Record<string, unknown>);

describe('--claims-cases: the cases file', () => {
  it('writes the business line first, then one line per read reply under its persona and run, in the order read', () => {
    const dir = folder();
    const c = new ClaimsCases(dir);
    const reading = { contradicted: 0.2, notDone: 0.1, gap: 0.05 };
    c.onClaimsRead('call-a', { turn: 0, state: state('B1', 'First.'), reading });
    c.onClaimsRead('call-b', { turn: 0, state: state('B1', 'Other.'), reading: null });
    c.onClaimsRead('call-a', { turn: 1, state: state('B1', 'Second.'), reading });
    c.write('call-a', 'regular', 2);
    c.write('call-b', 'newcomer', 0);
    c.write('call-never', 'quiet', 0);
    const l = lines(dir);
    expect(l[0]).toEqual({ v: 1, business: 'B1' });
    expect(l).toHaveLength(4);
    expect(l[1]).toEqual({ id: 'regular-2/t0', persona: 'regular', run: 2, turn: 0, today: 'Wednesday, November 11, 2026 (2026-11-11)', actions: [{ action: 'lookup', args: {}, result: 'ok' }], reply: 'First.', reading });
    expect(l[2]!.id).toBe('regular-2/t1');
    expect(l[3]).toMatchObject({ id: 'newcomer-0/t0', reading: null });
  });

  it('writes a business line again before the cases it applies to when the business changes', () => {
    const dir = folder();
    const c = new ClaimsCases(dir);
    c.onClaimsRead('a', { turn: 0, state: state('B1', 'x'), reading: null });
    c.onClaimsRead('b', { turn: 0, state: state('B2', 'y'), reading: null });
    c.write('a', 'p', 0);
    c.write('b', 'q', 0);
    expect(lines(dir).map((x) => x.business ?? x.id)).toEqual(['B1', 'p-0/t0', 'B2', 'q-0/t0']);
  });

  it('leaves an empty file where nothing was read', () => {
    const dir = folder();
    new ClaimsCases(dir);
    expect(readFileSync(join(dir, CLAIMS_CASES_FILE), 'utf8')).toBe('');
  });
});

describe('--claims-cases: the server and the command line', () => {
  it('gives a hook on the eval server the state the check was sent for a reply, and what it read', async () => {
    const ORIGIN = 'https://eval.example.com';
    const work = folder();
    const env = { PUBLIC_HOST: 'localhost', VOICE_PROVIDERS: 'none', CHAT: 'on', CHAT_ALLOWED_ORIGINS: ORIGIN, PORT: '0', AUDIO_DIR: folder(), DASHBOARD: 'off', JEV_CLIENT: 'stub' };
    const app = defineConverseApp(CONVERSE_FIXTURE_DIR, { tools: { availability: async () => [], book: async () => 'booked' } });
    const got: { callId: string; turn: number; state: unknown; reading: unknown }[] = [];
    const s = await startEvalServer(app, env, { work, converseModel: () => fakeModel([[text('We are open weekdays.'), done()]]), onClaimsRead: (callId, r) => void got.push({ callId, ...r }) });
    try {
      const ws = new WebSocket(s.url, { origin: ORIGIN });
      await new Promise<void>((resolve, reject) => (ws.once('open', () => resolve()), ws.once('error', reject)));
      let says = 0;
      ws.on('message', (d) => {
        if ((JSON.parse(d.toString()) as { type: string }).type === 'say') says += 1;
      });
      const until = async (n: number): Promise<void> => {
        for (let i = 0; i < 500 && says < n; i++) await new Promise((r) => setTimeout(r, 10));
      };
      ws.send(JSON.stringify({ type: 'start', v: 1 }));
      await until(1);
      ws.send(JSON.stringify({ type: 'text', text: 'Are you open Saturday?' }));
      await until(2);
      for (let i = 0; i < 100 && got.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
      ws.close();
    } finally {
      await s.close();
    }
    expect(got).toHaveLength(1);
    expect(got[0]!.state).toMatchObject({ reply: 'We are open weekdays.', actions: [] });
    expect(got[0]!.turn).toBe(1);
    expect(got[0]!.reading).toEqual({ contradicted: 0.04, notDone: 0.04, gap: 0.04 });
  }, 10_000);

  it('refuses --claims-cases with --publish, and says the flag in the usage', async () => {
    const err: string[] = [];
    const code = await evalCommand(['.', '--personas', 'p.yaml', '--claims-cases', '--publish'], { out: () => {}, err: (l) => void err.push(l), invokedFrom: process.cwd(), env: {} });
    expect(code).toBe(2);
    expect(err.join('\n')).toMatch(/--claims-cases and --publish do not go together/);
    expect(EVAL_USAGE).toContain('--claims-cases');
  });
});
