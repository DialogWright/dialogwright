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
import { DEFAULT_BARGE_IN_MIN_SPEECH_MS, DEFAULT_SPEECH_GAP_MS, type BargeIn } from '../channel/voiceProviders';
import { DEFAULT_NO_INPUT_AFTER_SPEECH_MS } from './adapter';

/**
 * A caller who had not finished (voice.continueWithinMs, run/continuation.ts) on a carrier whose relay
 * barge-in is off, so no interrupt comes: the carrier's report of the caller speaking again at once after
 * the reply went out stands in for it (server/adapter.ts takeResumed), and with BARGE_IN=server the
 * interrupt the server makes reaches the Continuation as a carrier's would. Live, then replayed.
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

function liveCall(provider: string, bargeIn: BargeIn) {
  const dir = mkdtempSync(join(tmpdir(), 'caller-resumed-'));
  const opts = { client: placeClient(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18', now: () => 0 };
  const store = new SessionStore((callSid) => ({
    session: newSession(callSid, 0, VOICE_RELAY, ANONYMOUS, PLACE_APP_ID),
    opts: { ...opts, trace: new TraceWriter(join(dir, `${callSid}.jsonl`)) },
    trace: new TraceWriter(join(dir, `${callSid}.jsonl`)),
    frames: new FrameLog(join(dir, `${callSid}.frames.jsonl`)),
  }), 60_000, () => 0);
  const tokens = new CallTokens(60_000, () => 0);
  const deps: AdapterDeps = {
    store, tokens, log: () => {}, bargeIn,
    ...(bargeIn === 'server' ? { serverBargeIn: { minSpeechMs: DEFAULT_BARGE_IN_MIN_SPEECH_MS, stopSource: 'https://demo.example.app/relay/silence.wav' } } : {}),
  };
  const sent: Record<string, unknown>[] = [];
  const sock: SocketLike = { send: (d, cb) => { sent.push(JSON.parse(d) as Record<string, unknown>); cb?.(); }, close: () => {} };
  const ctx = newConnectionContext(tokens.mint(CALL, provider), sock, provider);
  const send = (m: object) => handleSocketMessage(deps, sock, ctx, JSON.stringify(m));
  const info = (name: string, value: string) => send({ type: 'info', name, value });
  return {
    sent, store,
    start: () => send({ type: 'setup', sessionId: 'VX7', callSid: CALL, from: '+15555550100', to: '+15555550199', customParameters: {} }),
    say: (t: string) => send({ type: 'prompt', voicePrompt: t, lang: 'en-US', last: true }),
    caller: (on: boolean) => info('clientSpeaking', on ? 'on' : 'off'),
    agent: (on: boolean) => info('agentSpeaking', on ? 'on' : 'off'),
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

/** The call up to the reply to "at": the re-ask has just gone out. */
async function toReask(call: ReturnType<typeof liveCall>): Promise<void> {
  await call.start();
  await call.say('i want to report a problem');
  await call.say('at');
  expect(call.sent.filter((f) => f.type === 'text').at(-1)?.token).toBe(REASK);
}

describe.each(['none', 'server'] as const)('a caller who came back in at once, BARGE_IN=%s on Telnyx', (mode) => {
  it('speech that starts within the window and runs into the next final prompt continues the one before it (the live call)', async () => {
    const call = liveCall('telnyx', mode);
    await toReask(call);
    // As on the live call (2026-10-05): the caller is heard again 24 ms after the reply went out, before it plays.
    await vi.advanceTimersByTimeAsync(24);
    await call.caller(true);
    await vi.advanceTimersByTimeAsync(43);
    await call.agent(true);
    await vi.advanceTimersByTimeAsync(300);
    await call.caller(false);
    await vi.advanceTimersByTimeAsync(130);
    await call.caller(true);
    await vi.advanceTimersByTimeAsync(410);
    await call.caller(false);
    await vi.advanceTimersByTimeAsync(490);
    await call.say('22 Alder Street.');
    expect(call.place()).toBe('at 22 Alder Street.');
    expect(call.records().at(-1)!.joined).toEqual({ fragments: ['at', '22 Alder Street.'] });
    const logs = call.logs();
    const at = logs.findIndex((l) => l.dir === 'log' && l.msg.callerResumed !== undefined);
    expect(logs[at]!.msg).toEqual({ callerResumed: { afterMs: 24 } });
    expect(logs[at + 1]).toMatchObject({ dir: 'in', msg: { type: 'prompt', voicePrompt: '22 Alder Street.' } });
    await sameOnReplay(call);
  });

  it('a caller still speaking as the reply goes out came back in at once', async () => {
    const call = liveCall('telnyx', mode);
    await call.start();
    await call.say('i want to report a problem');
    // The caller answers the question after hearing it, and is still talking when "at" comes as a final prompt.
    await vi.advanceTimersByTimeAsync(2_000);
    await call.caller(true);
    await call.say('at');
    await vi.advanceTimersByTimeAsync(200);
    await call.caller(false);
    await vi.advanceTimersByTimeAsync(800);
    await call.say('22 Alder Street.');
    expect(call.place()).toBe('at 22 Alder Street.');
    expect(call.logs().find((l) => l.msg.callerResumed !== undefined)?.msg).toEqual({ callerResumed: { afterMs: 0 } });
    await sameOnReplay(call);
  });

  it('speech that starts after the window is an answer of its own', async () => {
    const call = liveCall('telnyx', mode);
    await toReask(call);
    await vi.advanceTimersByTimeAsync(301);
    await call.caller(true);
    await vi.advanceTimersByTimeAsync(150);
    await call.caller(false);
    await vi.advanceTimersByTimeAsync(800);
    await call.say('22 Alder Street.');
    expect(call.place()).toBe('22 Alder Street.');
    expect(call.logs().some((l) => l.msg.callerResumed !== undefined)).toBe(false);
    await sameOnReplay(call);
  });

  it('an "mm" at once, then a pause longer than the gap, then the answer: the answer is its own', async () => {
    const call = liveCall('telnyx', mode);
    await toReask(call);
    await vi.advanceTimersByTimeAsync(50);
    await call.caller(true);
    await vi.advanceTimersByTimeAsync(150);
    await call.caller(false);
    // The caller listens to the question, then answers it.
    await vi.advanceTimersByTimeAsync(DEFAULT_SPEECH_GAP_MS + 1);
    await call.caller(true);
    await vi.advanceTimersByTimeAsync(150);
    await call.caller(false);
    await vi.advanceTimersByTimeAsync(800);
    await call.say('22 Alder Street.');
    expect(call.place()).toBe('22 Alder Street.');
    expect(call.records().at(-1)!.joined).toBeUndefined();
    await sameOnReplay(call);
  });

  it('a final prompt long after the caller stopped is not the speech that came back in', async () => {
    const call = liveCall('telnyx', mode);
    await toReask(call);
    await vi.advanceTimersByTimeAsync(20);
    await call.caller(true);
    await vi.advanceTimersByTimeAsync(100);
    await call.caller(false);
    await vi.advanceTimersByTimeAsync(DEFAULT_NO_INPUT_AFTER_SPEECH_MS + 1);
    await call.say('22 Alder Street.');
    expect(call.place()).toBe('22 Alder Street.');
    await sameOnReplay(call);
  });
});

describe('BARGE_IN=server: the interrupt it makes reaches the Continuation as a carrier\'s does', () => {
  it('a line cut at once joins the next prompt; cut late, it is an ordinary barge-in', async () => {
    const early = liveCall('telnyx', 'server');
    await toReask(early);
    await early.agent(true);
    await vi.advanceTimersByTimeAsync(100);
    await early.caller(true);
    await vi.advanceTimersByTimeAsync(DEFAULT_BARGE_IN_MIN_SPEECH_MS);
    expect(early.sent.filter((f) => f.type === 'play')).toHaveLength(1);
    const cut = early.logs().find((l) => l.dir === 'in' && l.msg.type === 'interrupt');
    expect(cut?.msg.durationUntilInterruptMs).toBe(100);
    await early.caller(false);
    await vi.advanceTimersByTimeAsync(5_000);
    // Long after the caller stopped: no callerResumed, so only the interrupt within the window joins.
    await early.say('22 Alder Street.');
    expect(early.place()).toBe('at 22 Alder Street.');
    await sameOnReplay(early);
    forgetNoInput(CALL);
    vi.useFakeTimers();

    const late = liveCall('telnyx', 'server');
    await toReask(late);
    await late.agent(true);
    await vi.advanceTimersByTimeAsync(1_500);
    await late.caller(true);
    await vi.advanceTimersByTimeAsync(DEFAULT_BARGE_IN_MIN_SPEECH_MS);
    expect(late.sent.filter((f) => f.type === 'play')).toHaveLength(1);
    await late.caller(false);
    await vi.advanceTimersByTimeAsync(800);
    await late.say('22 Alder Street.');
    expect(late.place()).toBe('22 Alder Street.');
    await sameOnReplay(late);
  });
});

describe('a carrier that reports no caller speaking', () => {
  it('Twilio: nothing changes; only its interrupt joins', async () => {
    const call = liveCall('twilio', 'any');
    await toReask(call);
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
    await call.start();
    await call.say('i want to report a problem');
    await call.caller(true);
    await call.say('at');
    await call.caller(false);
    await call.say('22 Alder Street.');
    expect(call.place()).toBe('22 Alder Street.');
    expect(call.logs().some((l) => l.msg.callerResumed !== undefined)).toBe(false);
  });
});
