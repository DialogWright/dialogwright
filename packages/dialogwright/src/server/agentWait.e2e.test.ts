import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type RunningServer } from './index';
import { loadConfig } from './config';
import { FakeRelay } from '../testing/fakeRelay';
import { registerApp, resetAppsForTest } from '../core/app/registry';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { BUSINESS_FIXTURE_DIR, code } from '../define/__fixtures__/business/app';
import { defineApp } from '../define/defineApp';
import type { AgentAnswer, AgentClient, AgentContext, AgentResult } from '../agent/types';
import type { TraceRecord } from '../trace/types';
import { safeFileStem } from './fileStem';

/**
 * A line while the agent model is slow, on the phone (business.yaml's `waiting`; the agent-mode design, call 60):
 * the fixture business with `waiting: { afterMs: 200, upToMs: 1500 }` behind the server, on Twilio and on Telnyx,
 * its agent model a fake that answers after a delay set by the caller's words. The line goes out first and the
 * turn's own line after it, never over it; on Telnyx, once Telnyx reports the line played, or without its events,
 * after the line's estimated length. What the caller says over the line answers nothing (waitWindows): an "okay"
 * to "One sec." is neither the yes to the read-back after it nor a miss at a field's question.
 */

const dir = mkdtempSync(join(tmpdir(), 'agent-wait-e2e-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
cpSync(BUSINESS_FIXTURE_DIR, dir, { recursive: true });
appendFileSync(join(dir, 'business.yaml'), '\nwaiting:\n  afterMs: 200\n  upToMs: 1500\n  lines: ["One sec.", "Okay, one moment."]\n');
const app = defineApp(dir, code);
const TODAY = '2026-11-09';

const HOLD = 'I would like to place a hold on The Quiet Harbor';
const DETAILS = 'Avery Lane, two copies, Thursday morning, and call me at 555 555 0144';
const said = (reply: string, values: [string, string, string][] = []): AgentAnswer => ({ reply, values: values.map(([field, value, words]) => ({ field, value, words })), action: 'none', fromFacts: false });
const ANSWERS: Record<string, AgentAnswer> = {
  [HOLD]: said('Happy to help with that. What name is it under?', [['title', 'The Quiet Harbor', 'The Quiet Harbor']]),
  'Avery Lane': said('Thanks, Avery.', [['patronName', 'Avery Lane', 'Avery Lane']]),
  [DETAILS]: said('Thanks, Avery.', [['patronName', 'Avery Lane', 'Avery Lane'], ['copies', 'two', 'two copies'], ['day', '2026-11-12', 'Thursday'], ['window', 'morning', 'morning'], ['callbackNumber', '5555550144', '555 555 0144']]),
  'yes': said('Great!'),
  'okay': said('Okay.'),
};

/** The fake model: each answer after `slow[words]` ms (else at once). */
function slowAgent(slow: Record<string, number>): AgentClient {
  return {
    model: 'fake-agent',
    async answer(ctx: AgentContext, timeoutMs: number): Promise<AgentResult> {
      const words = ctx.conversation.at(-1)!.text;
      const delayMs = slow[words] ?? 0;
      await new Promise((r) => setTimeout(r, Math.min(delayMs, timeoutMs + 50)));
      if (delayMs > timeoutMs) return { ok: false, reason: 'timeout', detail: `fake: no answer within ${timeoutMs} ms`, ms: timeoutMs };
      const out = ANSWERS[words] ?? said('');
      return { ok: true, answer: out, ms: delayMs, raw: JSON.stringify(out) };
    },
  };
}

const { publicKey } = generateKeyPairSync('ed25519');
const TELNYX_PUBLIC_KEY = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

let running: RunningServer | null = null;
let traceDir = '';
const dirs: string[] = [];
afterEach(async () => {
  await running?.close();
  running = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function start(slow: Record<string, number>, env: Record<string, string> = {}): Promise<string> {
  resetAppsForTest();
  registerApp(app);
  traceDir = mkdtempSync(join(tmpdir(), 'agent-wait-trace-'));
  dirs.push(traceDir);
  const config = loadConfig({
    PUBLIC_HOST: 'localhost', TWILIO_AUTH_TOKEN: 't', VOICE_PROVIDERS: 'twilio,telnyx', TELNYX_PUBLIC_KEY, HANDOFF_NUMBER: '+15551234567', PORT: '0', SIGNATURE_CHECK: 'off',
    TODAY_OVERRIDE: TODAY, TRACE_DIR: traceDir, AUDIT_DIR: join(traceDir, 'audit'), AUDIO_DIR: traceDir, DASHBOARD: 'off', BARGE_IN: 'none', ...env,
  });
  running = await startServer(config, {
    host: '127.0.0.1', client: new HeuristicStubClient({ todayIso: TODAY, app }), log: () => {},
    agent: { client: slowAgent(slow), timeoutMs: { voice: 300, chat: 300 } },
  });
  return `ws://127.0.0.1:${running.port}`;
}

async function connect(ws: string, carrier: 'twilio' | 'telnyx', callSid: string): Promise<FakeRelay> {
  const path = carrier === 'twilio' ? '/conversation' : '/conversation/telnyx';
  const relay = await FakeRelay.connect(`${ws}${path}?token=${carrier === 'twilio' ? running!.tokens.mint(callSid) : running!.tokens.mint(callSid, 'telnyx')}`);
  relay.setup(callSid, undefined, carrier === 'twilio' ? { from: '+15555550199' } : { from: null, customParameters: { telnyx_call_from: '+15555550199' } });
  await relay.waitForTexts(1);
  return relay;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const records = (callSid: string): TraceRecord[] => readFileSync(join(traceDir, `${safeFileStem(callSid)}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as TraceRecord);
const frameLog = (callSid: string): { dir: string; msg: Record<string, unknown> }[] => readFileSync(join(traceDir, `${safeFileStem(callSid)}.frames.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { dir: string; msg: Record<string, unknown> });
/** Telnyx reports a line played (TELNYX_EVENTS tokens-played). */
const played = (relay: FakeRelay, text: string) => {
  relay.send({ type: 'info', name: 'agentSpeaking', value: 'on' });
  relay.send({ type: 'info', name: 'tokensPlayed', value: text });
};

describe('a line while the agent model is slow, on the phone', () => {
  it('Twilio: the line goes out once the answer is late, and the turn\'s own line after it', async () => {
    const ws = await start({ 'Avery Lane': 700 });
    const relay = await connect(ws, 'twilio', 'CA-wait-1');
    try {
      relay.prompt(HOLD);
      await relay.waitForTexts(2);
      relay.prompt('Avery Lane');
      const texts = (await relay.waitForTexts(4)).map((t) => t.trim());
      expect(texts[2]).toBe('One sec.');
      expect(texts[3]).not.toBe('One sec.');
      expect(records('CA-wait-1').at(-1)!.filler).toMatchObject({ promptId: 'agent_wait_1', said: true });
    } finally {
      relay.close();
    }
  });

  it('Telnyx with its events: the turn\'s own line waits until Telnyx reports the line played, never cut over it', async () => {
    const ws = await start({ 'Avery Lane': 500 }, { TELNYX_EVENTS: 'speaker-events tokens-played' });
    const relay = await connect(ws, 'telnyx', 'v3:wait-2');
    try {
      relay.prompt(HOLD);
      await relay.waitForTexts(2);
      relay.prompt('Avery Lane');
      await relay.waitForTexts(3);
      expect(relay.texts().at(-1)!.trim()).toBe('One sec.');
      // The answer is in (500 ms), and the reply waits for the line to have played.
      await pause(700);
      expect(relay.texts()).toHaveLength(3);
      played(relay, 'One sec.');
      const texts = await relay.waitForTexts(4);
      expect(texts[3]!.trim()).not.toBe('One sec.');
    } finally {
      relay.close();
    }
  });

  it('Telnyx with no playback report: the turn\'s own line after the line\'s estimated length', async () => {
    const ws = await start({ 'Avery Lane': 500 });
    const relay = await connect(ws, 'telnyx', 'v3:wait-3');
    try {
      relay.prompt(HOLD);
      await relay.waitForTexts(2);
      relay.prompt('Avery Lane');
      const texts = (await relay.waitForTexts(4, 5000)).map((t) => t.trim());
      expect(texts[2]).toBe('One sec.');
      expect(texts[3]).not.toBe('One sec.');
      expect(frameLog('v3:wait-3').some((l) => l.dir === 'log' && l.msg.earlyPlayed !== undefined)).toBe(true);
    } finally {
      relay.close();
    }
  });
});

describe('what the caller says over the line answers nothing (the review of call 60)', () => {
  it('an "okay" over the line before the read-back is not its yes: no turn, nothing filed, the read-back said; a yes after it files', async () => {
    const ws = await start({ [DETAILS]: 700 });
    const relay = await connect(ws, 'twilio', 'CA-wait-4');
    try {
      relay.prompt(HOLD);
      await relay.waitForTexts(2);
      relay.prompt(DETAILS);
      await relay.waitForTexts(3);
      expect(relay.texts().at(-1)!.trim()).toBe('One sec.');
      // Over "One sec.", before the read-back: Twilio reports no speech, so its arrival is its start.
      relay.prompt('okay');
      const texts = await relay.waitForTexts(4);
      expect(texts[3]!.trim()).toMatch(/^Here's the hold: .*Is that right\?$/);
      await pause(300);
      expect(relay.texts()).toHaveLength(4);
      expect(records('CA-wait-4').some((r) => (r.event as { text?: string }).text === 'okay')).toBe(false);
      expect(frameLog('CA-wait-4').some((l) => l.dir === 'log' && l.msg.overWaitLine !== undefined)).toBe(true);
      expect(records('CA-wait-4').some((r) => (r.gateEvents ?? []).some((e) => e.decision.call.tool === 'placeHold'))).toBe(false);
      // The caller's yes, after hearing the read-back, files the hold.
      relay.prompt('yes');
      await relay.waitForTexts(5);
      expect((records('CA-wait-4').at(-1)!.gateEvents ?? []).some((e) => e.decision.call.tool === 'placeHold' && e.decision.verdict === 'ALLOW')).toBe(true);
    } finally {
      relay.close();
    }
  });

  it('an "okay" over the line before a field\'s question is not a miss: no turn, no attempt counted', async () => {
    const ws = await start({ 'Avery Lane': 700 }, { TELNYX_EVENTS: 'speaker-events tokens-played' });
    const relay = await connect(ws, 'telnyx', 'v3:wait-5');
    try {
      relay.prompt(HOLD);
      await relay.waitForTexts(2);
      relay.prompt('Avery Lane');
      await relay.waitForTexts(3);
      // The caller starts speaking over "One sec." (reported), and the prompt comes once the question is out.
      relay.send({ type: 'info', name: 'clientSpeaking', value: 'on' });
      await pause(350);
      relay.send({ type: 'info', name: 'clientSpeaking', value: 'off' });
      played(relay, 'One sec.');
      // The reply: "Thanks, Avery." and the next field's question.
      await relay.waitForTexts(5);
      relay.prompt('okay');
      await pause(400);
      expect(relay.texts()).toHaveLength(5);
      const recs = records('v3:wait-5');
      expect(recs.some((r) => (r.event as { text?: string }).text === 'okay')).toBe(false);
      expect(Object.values(recs.at(-1)!.slots).every((s) => (s?.attempts ?? 0) === 0)).toBe(true);
      expect(frameLog('v3:wait-5').find((l) => l.dir === 'log' && l.msg.overWaitLine !== undefined)?.msg).toMatchObject({ overWaitLine: { start: 'speaking' } });
    } finally {
      relay.close();
    }
  });
});
