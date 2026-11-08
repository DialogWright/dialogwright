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
import { registerTestkit, testkitApp } from '../testing/testkit';
import { ANONYMOUS } from '../gate/principal';
import { PLACE_APP_ID, placeApp, placeClient } from '../testing/placeApp';
import type { BargeIn } from '../channel/voiceProviders';

/**
 * Speech over a line the caller could not interrupt (SPEECH_OVER_LINE, server/adapter.ts). The timeline is
 * a live Telnyx call's (2026-11-05, BARGE_IN=none, a speakerphone in a busy room): the greeting sent, the
 * carrier reporting the caller speaking 67 ms later, and 1.9 s in a final prompt of words said to someone
 * else. The words, the greeting and the app are the test app's; the greeting is estimated at 11.6 s.
 */

const CALL = 'CA9';
/** The test app's greeting: 29 words, 11.6 s by the estimate (2.5 words a second). */
const GREETING_MS = 11_600;
const NO_INPUT_MS = 7_000;
const ASIDE = "i'd like a custom scheduling system okay";
const NOMATCH = testkitApp.prompts.manifest.nomatch_open!.text;
const KEYPAD = testkitApp.prompts.manifest.nomatch_dtmf_menu!.text;
const NO_INPUT = testkitApp.prompts.manifest.no_input!.text;

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
  const dir = mkdtempSync(join(tmpdir(), 'speech-over-line-'));
  const opts = { client: placeClient(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-11-05', now: () => 0 };
  const store = new SessionStore((callSid) => ({
    session: newSession(callSid, 0, VOICE_RELAY, ANONYMOUS, PLACE_APP_ID),
    opts: { ...opts, trace: new TraceWriter(join(dir, `${callSid}.jsonl`)) },
    trace: new TraceWriter(join(dir, `${callSid}.jsonl`)),
    frames: new FrameLog(join(dir, `${callSid}.frames.jsonl`)),
  }), 60_000, () => 0);
  const tokens = new CallTokens(60_000, () => 0);
  const deps: AdapterDeps = { store, tokens, log: () => {}, bargeIn, noInputMs: NO_INPUT_MS, ...more };
  const sent: Record<string, unknown>[] = [];
  const sock: SocketLike = { send: (d, cb) => { sent.push(JSON.parse(d) as Record<string, unknown>); cb?.(); }, close: () => {} };
  const ctx = newConnectionContext(tokens.mint(CALL, provider), sock, provider);
  const send = (m: object) => handleSocketMessage(deps, sock, ctx, JSON.stringify(m));
  const caller = (on: boolean) => send({ type: 'info', name: 'clientSpeaking', value: on ? 'on' : 'off' });
  return {
    sent, store, caller,
    start: () => send({ type: 'setup', sessionId: 'VX9', callSid: CALL, from: '+15555550100', to: '+15555550199', customParameters: {} }),
    say: (t: string) => send({ type: 'prompt', voicePrompt: t, lang: 'en-US', last: true }),
    partial: (t: string) => send({ type: 'prompt', voicePrompt: t, lang: 'en-US', last: false }),
    key: (digit: string) => send({ type: 'dtmf', digit }),
    /** What went out as lines, in order. */
    lines: () => sent.filter((f) => f.type === 'text').map((f) => f.token as string),
    session: () => store.get(CALL)!.session,
    records: () => readFileSync(join(dir, `${CALL}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as TraceRecord),
    logs: () => readFileSync(join(dir, `${CALL}.frames.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { dir: string; msg: Record<string, unknown> }),
    replay: () => replayFrameLog(join(dir, `${CALL}.frames.jsonl`), { ...opts, client: placeClient(), trace: null }, undefined, { todayIsoOverride: opts.todayIso }),
  };
}
type Call = ReturnType<typeof liveCall>;

/** The frame log's note just before the prompt with these words, or undefined when there is none. */
function noteBefore(call: Call, words: string): Record<string, unknown> | undefined {
  const logs = call.logs();
  const at = logs.findIndex((l) => l.dir === 'in' && l.msg.type === 'prompt' && l.msg.voicePrompt === words);
  expect(at).toBeGreaterThan(0);
  const before = logs[at - 1]!;
  return before.dir === 'log' && before.msg.speechOverLine !== undefined ? before.msg.speechOverLine as Record<string, unknown> : undefined;
}

const shape = (r: TraceRecord) => [r.event.type, (r.event as { text?: string }).text ?? null, (r.event as { overLine?: true }).overLine ?? null, r.decision.kind, r.gates.find((g) => g.decided)?.gate ?? null];

/** Live, then replayed from the frame log: the same turns, set aside where the call set them aside. */
async function sameOnReplay(call: Call): Promise<void> {
  const live = call.records();
  vi.useRealTimers();
  const replayed = await call.replay();
  expect(replayed.skipped).toEqual([]);
  expect(replayed.records.map(shape)).toEqual(live.map(shape));
}

/** The live call to its first prompt: the greeting, the caller heard 67 ms in, the words 1.9 s in. */
async function overTheGreeting(call: Call, words = ASIDE): Promise<void> {
  await call.start();
  expect(call.lines()).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(67);
  await call.caller(true);
  await vi.advanceTimersByTimeAsync(1_533);
  await call.caller(false);
  await vi.advanceTimersByTimeAsync(300);
  await call.say(words);
}

describe('speech over a line, unless-miss (the default), on Telnyx with BARGE_IN=none', () => {
  it('the live call: words said to someone else over the greeting are set aside, the greeting plays on and the caller is asked after it', async () => {
    const call = liveCall('telnyx', 'none');
    await overTheGreeting(call);
    // Nothing said over the greeting, nothing counted, the question as it was.
    expect(call.lines()).toHaveLength(1);
    expect(call.session().intentAttempts).toBe(0);
    expect(call.session().lastPromptId).toBe('greeting');
    expect(call.session().promptedFor).toBe('intent');
    const last = call.records().at(-1)!;
    expect(last.decision.kind).toBe('ignore');
    expect(last.event).toMatchObject({ type: 'user.speech', text: ASIDE, overLine: true });
    expect(last.gates.filter((g) => g.decided)).toEqual([{ gate: 'speechOverLine', value: null, threshold: null, passed: false, outcome: 'set_aside', decided: true }]);
    // The speech's start is the carrier's report, 67 ms into the greeting.
    expect(noteBefore(call, ASIDE)).toEqual({ mode: 'unless-miss', afterMs: 67, expectedMs: GREETING_MS, start: 'speaking' });
    // The no-input wait asks again from the greeting's end, not from the words.
    await vi.advanceTimersByTimeAsync(GREETING_MS + NO_INPUT_MS - 1_900 - 1);
    expect(call.lines()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(call.lines()[1]?.trim()).toBe(NO_INPUT);
    expect(call.records().at(-1)!.event.type).toBe('user.silence');
    await sameOnReplay(call);
  });

  it('a request said over the greeting is acted on', async () => {
    const call = liveCall('telnyx', 'none');
    await overTheGreeting(call, 'i want to report a problem');
    expect(call.session().form).toBe('report');
    expect(call.lines().at(-1)).toBe('Where is the problem?');
    expect(call.records().at(-1)!.gates.some((g) => g.gate === 'speechOverLine')).toBe(false);
    // Noted all the same: the speech was over the greeting.
    expect(noteBefore(call, 'i want to report a problem')).toMatchObject({ mode: 'unless-miss', afterMs: 67 });
    await sameOnReplay(call);
  });

  it('speech that starts after the greeting\'s estimated end is a miss, as before', async () => {
    const call = liveCall('telnyx', 'none');
    await call.start();
    await vi.advanceTimersByTimeAsync(GREETING_MS + 200);
    await call.caller(true);
    await vi.advanceTimersByTimeAsync(1_000);
    await call.caller(false);
    await vi.advanceTimersByTimeAsync(300);
    await call.say(ASIDE);
    expect(call.lines().at(-1)).toBe(NOMATCH);
    expect(call.session().intentAttempts).toBe(1);
    expect(noteBefore(call, ASIDE)).toBeUndefined();
    await sameOnReplay(call);
  });

  it('a report of the caller long before the prompt is not its speech: the prompt\'s arrival is its start', async () => {
    const call = liveCall('telnyx', 'none');
    await call.start();
    // A cough as the greeting starts, then nothing reported: the words come after the greeting's end.
    await call.caller(true);
    await vi.advanceTimersByTimeAsync(300);
    await call.caller(false);
    await vi.advanceTimersByTimeAsync(GREETING_MS + 500);
    await call.say(ASIDE);
    expect(call.lines().at(-1)).toBe(NOMATCH);
    expect(noteBefore(call, ASIDE)).toBeUndefined();
  });

  it('two real misses, then a third over the keypad line: set aside, and no one is put through', async () => {
    const call = liveCall('telnyx', 'none');
    await call.start();
    await vi.advanceTimersByTimeAsync(GREETING_MS + 500);
    await call.say(ASIDE);
    expect(call.lines().at(-1)).toBe(NOMATCH);
    // After the no-match line (21 words, 8.4 s).
    await vi.advanceTimersByTimeAsync(9_000);
    await call.say('oh sorry');
    expect(call.lines().at(-1)).toBe(KEYPAD);
    expect(call.session().intentAttempts).toBe(2);
    // "i see", heard 0.4 s into the keypad line.
    await vi.advanceTimersByTimeAsync(200);
    await call.caller(true);
    await vi.advanceTimersByTimeAsync(400);
    await call.caller(false);
    await vi.advanceTimersByTimeAsync(300);
    await call.say('i see');
    expect(call.lines().at(-1)).toBe(KEYPAD);
    expect(call.session().intentAttempts).toBe(2);
    expect(call.session().ended).toBe(false);
    expect(call.sent.some((f) => f.type === 'end')).toBe(false);
    expect(call.records().at(-1)!.decision.kind).toBe('ignore');
    // A key at the keypad line is never affected.
    await call.key('1');
    expect(call.session().form).toBe('report');
    await sameOnReplay(call);
  });

  it('a caller who began over the line and comes back in at once: the words joined, and acted on', async () => {
    const call = liveCall('telnyx', 'none');
    await call.start();
    await vi.advanceTimersByTimeAsync(GREETING_MS + 500);
    await call.say('i want to report a problem');
    // "Sure, I can help you report a problem. Where is the problem?": 12 words, 4.8 s.
    expect(call.lines().at(-1)).toBe('Where is the problem?');
    await vi.advanceTimersByTimeAsync(1_000);
    await call.caller(true);
    await vi.advanceTimersByTimeAsync(400);
    await call.caller(false);
    await vi.advanceTimersByTimeAsync(500);
    await call.say('at');
    // A miss over the question: set aside, nothing said.
    expect(call.lines().at(-1)).toBe('Where is the problem?');
    expect(call.records().at(-1)!.decision.kind).toBe('ignore');
    // Back in 0.6 s after they stopped, with the rest.
    await vi.advanceTimersByTimeAsync(100);
    await call.caller(true);
    await vi.advanceTimersByTimeAsync(900);
    await call.caller(false);
    await vi.advanceTimersByTimeAsync(300);
    await call.say('22 Alder Street.');
    expect(call.session().slots.place?.value).toBe('at 22 Alder Street.');
    expect(call.records().at(-1)!.joined).toEqual({ fragments: ['at', '22 Alder Street.'] });
    await sameOnReplay(call);
  });

  it('a partial prompt is never looked at: only a final one is a turn', async () => {
    const call = liveCall('telnyx', 'none');
    await call.start();
    await vi.advanceTimersByTimeAsync(500);
    await call.partial('i would');
    expect(call.logs().some((l) => l.msg.speechOverLine !== undefined)).toBe(false);
  });
});

describe('speech over a line on Twilio, which reports no caller speaking', () => {
  it('the prompt\'s arrival is the speech\'s start: over the greeting, a miss is set aside', async () => {
    const call = liveCall('twilio', 'none');
    await call.start();
    await vi.advanceTimersByTimeAsync(1_900);
    await call.say(ASIDE);
    expect(call.lines()).toHaveLength(1);
    expect(call.session().intentAttempts).toBe(0);
    expect(noteBefore(call, ASIDE)).toEqual({ mode: 'unless-miss', afterMs: 1_900, expectedMs: GREETING_MS, start: 'arrival' });
    await sameOnReplay(call);
  });

  it('after the greeting\'s end, a miss as before', async () => {
    const call = liveCall('twilio', 'none');
    await call.start();
    await vi.advanceTimersByTimeAsync(GREETING_MS + 1);
    await call.say(ASIDE);
    expect(call.lines().at(-1)).toBe(NOMATCH);
  });
});

describe('SPEECH_OVER_LINE=take', () => {
  it('is the old behaviour: the miss over the greeting is said and counted, and nothing is noted', async () => {
    const call = liveCall('telnyx', 'none', { speechOverLine: 'take' });
    await overTheGreeting(call);
    expect(call.lines().at(-1)).toBe(NOMATCH);
    expect(call.session().intentAttempts).toBe(1);
    expect(noteBefore(call, ASIDE)).toBeUndefined();
    expect(call.records().at(-1)!.event).not.toHaveProperty('overLine');
    await sameOnReplay(call);
  });
});

describe('SPEECH_OVER_LINE=ignore', () => {
  it('runs no turn for speech over the line: nothing said, no record, and the no-input wait from the greeting\'s end', async () => {
    const call = liveCall('telnyx', 'none', { speechOverLine: 'ignore' });
    await overTheGreeting(call);
    expect(call.lines()).toHaveLength(1);
    // The greeting's record only.
    expect(call.records()).toHaveLength(1);
    expect(noteBefore(call, ASIDE)).toEqual({ mode: 'ignore', afterMs: 67, expectedMs: GREETING_MS, start: 'speaking' });
    await vi.advanceTimersByTimeAsync(GREETING_MS + NO_INPUT_MS - 1_900 - 1);
    expect(call.lines()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(call.lines()[1]?.trim()).toBe(NO_INPUT);
    await sameOnReplay(call);
  });

  it('a request over the line is not taken either; one after it is', async () => {
    const call = liveCall('twilio', 'none', { speechOverLine: 'ignore' });
    await call.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await call.say('i want to report a problem');
    expect(call.session().form).toBeNull();
    await vi.advanceTimersByTimeAsync(GREETING_MS);
    await call.say('i want to report a problem');
    expect(call.session().form).toBe('report');
    await sameOnReplay(call);
  });
});

describe('speech over a line the caller can interrupt', () => {
  it('BARGE_IN=any with an interruptible greeting: unchanged, the miss is said', async () => {
    const call = liveCall('telnyx', 'any');
    await overTheGreeting(call);
    expect(call.lines().at(-1)).toBe(NOMATCH);
    expect(call.session().intentAttempts).toBe(1);
    expect(noteBefore(call, ASIDE)).toBeUndefined();
  });

  it('BARGE_IN=any with a greeting sent interruptible: false: over it, as with the barge-in off', async () => {
    resetAppsForTest();
    const app = placeApp();
    registerApp({ ...app, prompts: { ...app.prompts, manifest: { ...app.prompts.manifest, greeting: { ...app.prompts.manifest.greeting!, interruptible: false } } } });
    registerTestkit();
    const call = liveCall('twilio', 'any');
    await call.start();
    expect(call.sent[0]).toMatchObject({ type: 'text', interruptible: false });
    await vi.advanceTimersByTimeAsync(1_900);
    await call.say(ASIDE);
    expect(call.lines()).toHaveLength(1);
    expect(noteBefore(call, ASIDE)).toMatchObject({ mode: 'unless-miss', start: 'arrival' });
  });
});
