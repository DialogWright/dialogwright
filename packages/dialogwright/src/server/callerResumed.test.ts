import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forgetNoInput, handleSocketMessage, newConnectionContext, type AdapterDeps } from './adapter';
import { SessionStore, type SocketLike } from './sessions';
import { CallTokens } from './tokens';
import { FrameLog } from './frameLog';
import { replayFrameLog } from '../harness-text/replay';
import { newSession } from '../core/session';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { TraceWriter } from '../trace/writer';
import type { TraceRecord } from '../trace/types';
import { VOICE_RELAY } from '../channel/caps';
import { registerApp, resetAppsForTest } from '../core/app/registry';
import { registerTestkit } from '../testing/testkit';
import { ANONYMOUS } from '../gate/principal';
import { PLACE_APP_ID, placeApp, placeClient } from '../testing/placeApp';
import { DEFAULT_RESUME_AFTER_PAUSE_MS, type BargeIn } from '../channel/voiceProviders';
import { DEFAULT_NO_INPUT_AFTER_SPEECH_MS } from './adapter';
import { describeConfig, loadConfig } from './config';

/**
 * A caller who had not finished (voice.continueWithinMs, run/continuation.ts) on a carrier whose relay
 * barge-in is off, so no interrupt comes: the carrier's report of the caller coming back in soon after
 * their own pause, and soon after the reply went out, stands in for it (server/adapter.ts takeResumed).
 * Live, then replayed. The timings are two live Telnyx calls' (2026-10-05); the words are the test app's.
 */

const CALL = 'CA7';
const REASK = 'Sorry, where is the problem?';

beforeEach(() => {
  resetAppsForTest();
  registerApp(placeApp());
  registerTestkit();
  vi.useFakeTimers();
});
afterEach(() => {
  forgetNoInput(CALL);
  vi.useRealTimers();
});

function liveCall(provider: string, bargeIn: BargeIn, more: Partial<AdapterDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'caller-resumed-'));
  const opts = { client: placeClient(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18', now: () => 0 };
  const store = new SessionStore((callSid) => ({
    session: newSession(callSid, 0, VOICE_RELAY, ANONYMOUS, PLACE_APP_ID),
    opts: { ...opts, trace: new TraceWriter(join(dir, `${callSid}.jsonl`)) },
    trace: new TraceWriter(join(dir, `${callSid}.jsonl`)),
    frames: new FrameLog(join(dir, `${callSid}.frames.jsonl`)),
  }), 60_000, () => 0);
  const tokens = new CallTokens(60_000, () => 0);
  const deps: AdapterDeps = { store, tokens, log: () => {}, bargeIn, ...more };
  const sent: Record<string, unknown>[] = [];
  const sock: SocketLike = { send: (d, cb) => { sent.push(JSON.parse(d) as Record<string, unknown>); cb?.(); }, close: () => {} };
  const ctx = newConnectionContext(tokens.mint(CALL, provider), sock, provider);
  const send = (m: object) => handleSocketMessage(deps, sock, ctx, JSON.stringify(m));
  const info = (name: string, value: string) => send({ type: 'info', name, value });
  const caller = (on: boolean) => info('clientSpeaking', on ? 'on' : 'off');
  return {
    sent, store, caller,
    start: () => send({ type: 'setup', sessionId: 'VX7', callSid: CALL, from: '+15555550100', to: '+15555550199', customParameters: {} }),
    say: (t: string) => send({ type: 'prompt', voicePrompt: t, lang: 'en-US', last: true }),
    agent: (on: boolean) => info('agentSpeaking', on ? 'on' : 'off'),
    /** The caller heard speaking for each of `bursts` ms in turn, with the pauses between them: on, burst, off, pause, on... */
    speak: async (...bursts: number[]) => {
      for (const [i, ms] of bursts.entries()) {
        await caller(i % 2 === 0);
        await vi.advanceTimersByTimeAsync(ms);
      }
      if (bursts.length % 2 === 1) await caller(false);
    },
    records: () => readFileSync(join(dir, `${CALL}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as TraceRecord),
    logs: () => readFileSync(join(dir, `${CALL}.frames.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { dir: string; msg: Record<string, unknown> }),
    replay: () => replayFrameLog(join(dir, `${CALL}.frames.jsonl`), { ...opts, client: placeClient(), trace: null }, undefined, { todayIsoOverride: opts.todayIso }),
    place: () => store.get(CALL)!.session.slots.place?.value,
  };
}

const shape = (r: TraceRecord) => [r.event.type, (r.event as { text?: string }).text ?? null, r.decision.kind, r.joined?.fragments ?? null];

/** Live, then replayed from the frame log: the same turns, joined the same way. */
async function sameOnReplay(call: ReturnType<typeof liveCall>): Promise<void> {
  const live = call.records();
  vi.useRealTimers();
  const replayed = await call.replay();
  expect(replayed.skipped).toEqual([]);
  expect(replayed.records.map(shape)).toEqual(live.map(shape));
}

/**
 * The call up to "at": the request, then the caller says "at" (`speakMs`), stops, and the final prompt
 * comes `promptMs` later. The test's turn takes no time, so the re-ask goes out as the prompt comes: on
 * a live call the prompt's delay and the turn's time are one gap here.
 */
async function toReask(call: ReturnType<typeof liveCall>, speakMs: number, promptMs: number): Promise<void> {
  await call.start();
  await call.speak(900);
  await vi.advanceTimersByTimeAsync(800);
  await call.say('i want to report a problem');
  await vi.advanceTimersByTimeAsync(3_000);
  await call.speak(speakMs);
  await vi.advanceTimersByTimeAsync(promptMs);
  await call.say('at');
  expect(call.sent.filter((f) => f.type === 'text').at(-1)?.token).toBe(REASK);
}

/** The frame log's callerResumed line, and that the prompt it joins comes next. */
function resumedLine(call: ReturnType<typeof liveCall>): Record<string, unknown> {
  const logs = call.logs();
  const at = logs.findIndex((l) => l.dir === 'log' && l.msg.callerResumed !== undefined);
  expect(logs[at + 1]).toMatchObject({ dir: 'in', msg: { type: 'prompt', voicePrompt: '22 Alder Street.' } });
  return logs[at]!.msg;
}

describe.each(['none', 'any'] as const)('a caller who came back in, BARGE_IN=%s on Telnyx', (mode) => {
  it('the first live call: back in 24 ms after the reply went out, 0.54 s after they stopped', async () => {
    const call = liveCall('telnyx', mode);
    // Stopped at 08.662, the prompt at 08.972, the reply out at 09.179: one gap of 517 ms here.
    await toReask(call, 400, 517);
    await vi.advanceTimersByTimeAsync(24);
    // Back in at 09.203, the rest of the number in bursts, and its prompt at 10.582.
    await call.speak(343, 130, 410);
    await vi.advanceTimersByTimeAsync(496);
    await call.say('22 Alder Street.');
    expect(call.place()).toBe('at 22 Alder Street.');
    expect(call.records().at(-1)!.joined).toEqual({ fragments: ['at', '22 Alder Street.'] });
    expect(resumedLine(call)).toEqual({ callerResumed: { pauseMs: 541, intoReplyMs: 24 } });
    await sameOnReplay(call);
  });

  it('the second live call: back in 0.70 s after the reply went out, 1.68 s after they stopped', async () => {
    const call = liveCall('telnyx', mode);
    // Speaking 13.831 to 14.009, the prompt at 14.801, the reply out at 14.993: one gap of 984 ms here.
    await toReask(call, 178, 984);
    await vi.advanceTimersByTimeAsync(65);
    await call.agent(true);
    await vi.advanceTimersByTimeAsync(631);
    // Back in at 15.689, with pauses of 60 to 500 ms, until 17.873; the prompt at 18.250.
    await call.speak(500, 60, 700, 500, 424);
    await vi.advanceTimersByTimeAsync(377);
    await call.say('22 Alder Street.');
    expect(call.place()).toBe('at 22 Alder Street.');
    expect(call.records().at(-1)!.joined).toEqual({ fragments: ['at', '22 Alder Street.'] });
    expect(resumedLine(call)).toEqual({ callerResumed: { pauseMs: 1_680, intoReplyMs: 696 } });
    await sameOnReplay(call);
  });

  it('back in 1.2 s after the reply went out is an answer to it, though the pause was short', async () => {
    const call = liveCall('telnyx', mode);
    await toReask(call, 400, 300);
    await vi.advanceTimersByTimeAsync(1_200);
    await call.speak(400);
    await vi.advanceTimersByTimeAsync(800);
    await call.say('22 Alder Street.');
    expect(call.place()).toBe('22 Alder Street.');
    expect(call.logs().some((l) => l.msg.callerResumed !== undefined)).toBe(false);
    await sameOnReplay(call);
  });

  it('back in 2.5 s after they stopped is a new utterance, though the reply had just gone out', async () => {
    const call = liveCall('telnyx', mode);
    await toReask(call, 400, 2_000);
    await vi.advanceTimersByTimeAsync(500);
    await call.speak(400);
    await vi.advanceTimersByTimeAsync(800);
    await call.say('22 Alder Street.');
    expect(call.place()).toBe('22 Alder Street.');
    expect(call.logs().some((l) => l.msg.callerResumed !== undefined)).toBe(false);
    await sameOnReplay(call);
  });

  it('a caller still speaking as the prompt comes is back in already', async () => {
    const call = liveCall('telnyx', mode);
    await call.start();
    await call.speak(900);
    await vi.advanceTimersByTimeAsync(800);
    await call.say('i want to report a problem');
    await vi.advanceTimersByTimeAsync(2_000);
    // The caller answers, and is still talking when "at" comes as a final prompt.
    await call.caller(true);
    await call.say('at');
    await vi.advanceTimersByTimeAsync(200);
    await call.caller(false);
    await vi.advanceTimersByTimeAsync(800);
    await call.say('22 Alder Street.');
    expect(call.place()).toBe('at 22 Alder Street.');
    expect(resumedLine(call)).toEqual({ callerResumed: { pauseMs: 0, intoReplyMs: 0 } });
    await sameOnReplay(call);
  });

  it('an "mm" at once, then a pause longer than RESUME_AFTER_PAUSE_MS, then the answer: the answer is its own', async () => {
    const call = liveCall('telnyx', mode);
    await toReask(call, 400, 800);
    await vi.advanceTimersByTimeAsync(50);
    await call.speak(150);
    // The caller listens to the question, then answers it.
    await vi.advanceTimersByTimeAsync(DEFAULT_RESUME_AFTER_PAUSE_MS + 1);
    await call.speak(400);
    await vi.advanceTimersByTimeAsync(800);
    await call.say('22 Alder Street.');
    expect(call.place()).toBe('22 Alder Street.');
    expect(call.records().at(-1)!.joined).toBeUndefined();
    await sameOnReplay(call);
  });

  it('a final prompt long after the caller stopped is not the speech that came back in', async () => {
    const call = liveCall('telnyx', mode);
    await toReask(call, 400, 800);
    await vi.advanceTimersByTimeAsync(20);
    await call.speak(100);
    await vi.advanceTimersByTimeAsync(DEFAULT_NO_INPUT_AFTER_SPEECH_MS + 1);
    await call.say('22 Alder Street.');
    expect(call.place()).toBe('22 Alder Street.');
    await sameOnReplay(call);
  });
});

describe('RESUME_AFTER_PAUSE_MS and RESUME_INTO_REPLY_MS', () => {
  it('are the adapter\'s bounds: the second live call is not joined with either set below its timings', async () => {
    for (const more of [{ resumeAfterPauseMs: 1_600 }, { resumeIntoReplyMs: 600 }]) {
      const call = liveCall('telnyx', 'none', more);
      await toReask(call, 178, 984);
      await vi.advanceTimersByTimeAsync(696);
      await call.speak(500, 60, 700, 500, 424);
      await vi.advanceTimersByTimeAsync(377);
      await call.say('22 Alder Street.');
      expect(call.place(), JSON.stringify(more)).toBe('22 Alder Street.');
      forgetNoInput(CALL);
    }
  });

  const telnyx = { PUBLIC_HOST: 'demo.example.app', HANDOFF_NUMBER: '+15551234567', VOICE_PROVIDERS: 'telnyx', TELNYX_PUBLIC_KEY: Buffer.alloc(32, 7).toString('base64') };

  it('default to 2000 and 1000, and are read when set', () => {
    const c = loadConfig(telnyx);
    expect([c.resumeAfterPauseMs, c.resumeIntoReplyMs]).toEqual([2_000, 1_000]);
    const set = loadConfig({ ...telnyx, RESUME_AFTER_PAUSE_MS: '1500', RESUME_INTO_REPLY_MS: '0' });
    expect([set.resumeAfterPauseMs, set.resumeIntoReplyMs]).toEqual([1_500, 0]);
  });

  it('refuse a value out of range', () => {
    for (const bad of ['10001', '-1', 'soon', '1.5']) expect(() => loadConfig({ ...telnyx, RESUME_AFTER_PAUSE_MS: bad })).toThrow(/RESUME_AFTER_PAUSE_MS must be/);
    for (const bad of ['5001', '-1', 'x']) expect(() => loadConfig({ ...telnyx, RESUME_INTO_REPLY_MS: bad })).toThrow(/RESUME_INTO_REPLY_MS must be/);
  });

  it('are said at startup where a carrier reports the caller\'s voice', () => {
    expect(describeConfig(loadConfig(telnyx))).toContain('caller resumes within 2000 ms of a pause, 1000 ms into the reply');
    expect(describeConfig(loadConfig({ PUBLIC_HOST: 'demo.example.app', TWILIO_AUTH_TOKEN: 'tok', HANDOFF_NUMBER: '+15551234567' }))).not.toContain('caller resumes');
  });
});

describe('a carrier that reports no caller speaking', () => {
  it('Twilio: nothing changes; only its interrupt joins', async () => {
    const call = liveCall('twilio', 'any');
    await call.start();
    await call.say('i want to report a problem');
    await call.say('at');
    await vi.advanceTimersByTimeAsync(800);
    await call.say('22 Alder Street.');
    expect(call.place()).toBe('22 Alder Street.');
    expect(call.logs().some((l) => l.msg.callerResumed !== undefined)).toBe(false);
  });
});

describe('an app with continueWithinMs 0', () => {
  it('takes every final prompt alone, whatever the caller does', async () => {
    resetAppsForTest();
    registerApp(placeApp({ voice: { continueWithinMs: 0 } }));
    registerTestkit();
    const call = liveCall('telnyx', 'none');
    await toReask(call, 400, 517);
    await vi.advanceTimersByTimeAsync(24);
    await call.speak(343, 130, 410);
    await vi.advanceTimersByTimeAsync(496);
    await call.say('22 Alder Street.');
    expect(call.place()).toBe('22 Alder Street.');
    expect(call.logs().some((l) => l.msg.callerResumed !== undefined)).toBe(false);
  });
});
