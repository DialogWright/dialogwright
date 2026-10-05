import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forgetNoInput, handleSocketMessage, holdsReply, newConnectionContext, noInputArmed, SPURIOUS_INTERRUPT_SETTLE_MS, SPURIOUS_INTERRUPT_UNREPORTED_SETTLE_MS, type AdapterDeps } from './adapter';
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
import { DEFAULT_INCOMPLETE_WAIT_MS, DEFAULT_NO_INPUT_AFTER_SPEECH_MS, DEFAULT_SPURIOUS_INTERRUPT_WINDOW_MS, type BargeIn } from '../channel/voiceProviders';
import { describeConfig, loadConfig } from './config';
import type { TurnResult } from '../core/turn';

/**
 * Two recoveries on a carrier that reports the caller speaking (Telnyx with TELNYX_EVENTS speaker-events),
 * live and then replayed from the frame log. The timings are live Telnyx calls' (2026-10-05, BARGE_IN=speech,
 * deepgram); the words are the test app's.
 *
 * - A spurious interrupt: Telnyx's barge-in fired 1704 ms into the greeting with no clientSpeaking at all,
 *   and the caller, hearing nothing, sat silent for about 11 s. With no caller heard around it, the
 *   interrupted lines are said again from the start, and the core never takes it as a barge-in.
 * - A caller who is clearly not finished: "seventy six" came as a final prompt, the caller went on 0.68 s
 *   later with the rest of the address, and the re-ask sent meanwhile was talked over. A final prompt the
 *   model reads as unfinished holds its reply up to INCOMPLETE_WAIT_MS; the caller going on in that time
 *   joins the prompts, and nothing is said over them.
 */

const CALL = 'CA9';
const REASK = 'Sorry, where is the problem?';
const FIRST = 'seventy six';
const REST = 'twenty five oak hollow lane';
const JOINED = 'seventy six twenty five oak hollow lane';

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

/** The model hears a bare number, an "um" or a "the" as unfinished; anything else as finished. */
const complete = (text: string): number => (/^(seventy six|um|agent please|the)$/i.test(text.trim()) ? 0.3 : 0.9);

const SPURIOUS = { spuriousInterrupts: { windowMs: DEFAULT_SPURIOUS_INTERRUPT_WINDOW_MS } } as const;
const HOLD = { incompleteWait: { waitMs: DEFAULT_INCOMPLETE_WAIT_MS } } as const;

function liveCall(provider: string, bargeIn: BargeIn, more: Partial<AdapterDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'barge-recovery-'));
  const opts = { client: placeClient({ utteranceComplete: complete }), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18', now: () => 0 };
  const store = new SessionStore((callSid) => ({
    session: newSession(callSid, 0, VOICE_RELAY, ANONYMOUS, PLACE_APP_ID),
    opts: { ...opts, trace: new TraceWriter(join(dir, `${callSid}.jsonl`)) },
    trace: new TraceWriter(join(dir, `${callSid}.jsonl`)),
    frames: new FrameLog(join(dir, `${callSid}.frames.jsonl`)),
  }), 60_000, () => 0);
  const tokens = new CallTokens(60_000, () => 0);
  const deps: AdapterDeps = { store, tokens, log: () => {}, bargeIn, resay: { minFraction: 0.35 }, ...more };
  const sent: Record<string, unknown>[] = [];
  const sock: SocketLike = { send: (d, cb) => { sent.push(JSON.parse(d) as Record<string, unknown>); cb?.(); }, close: () => {} };
  const ctx = newConnectionContext(tokens.mint(CALL, provider), sock, provider);
  const send = (m: object) => handleSocketMessage(deps, sock, ctx, JSON.stringify(m));
  const info = (name: string, value: string) => send({ type: 'info', name, value });
  const caller = (on: boolean) => info('clientSpeaking', on ? 'on' : 'off');
  const texts = () => sent.filter((f) => f.type === 'text').map((f) => f.token as string);
  return {
    sent, store, caller, texts, deps,
    start: () => send({ type: 'setup', sessionId: 'VX9', callSid: CALL, from: '+15555550100', to: '+15555550199', customParameters: {} }),
    // Not awaited by a test that runs the clock while the call's queue waits (a held reply, a settling interrupt).
    say: (t: string) => send({ type: 'prompt', voicePrompt: t, lang: 'en-US', last: true }),
    cut: (heard: string, ms: number) => send({ type: 'interrupt', utteranceUntilInterrupt: heard, durationUntilInterruptMs: ms }),
    agent: (on: boolean) => info('agentSpeaking', on ? 'on' : 'off'),
    speak: async (...bursts: number[]) => {
      for (const [i, ms] of bursts.entries()) {
        await caller(i % 2 === 0);
        await vi.advanceTimersByTimeAsync(ms);
      }
      if (bursts.length % 2 === 1) await caller(false);
    },
    records: () => readFileSync(join(dir, `${CALL}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as TraceRecord),
    logs: () => readFileSync(join(dir, `${CALL}.frames.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { dir: string; msg: Record<string, unknown> }),
    replay: () => replayFrameLog(join(dir, `${CALL}.frames.jsonl`), { ...opts, client: placeClient({ utteranceComplete: complete }), trace: null }, undefined, { todayIsoOverride: opts.todayIso }),
    session: () => store.get(CALL)!.session,
  };
}

type Call = ReturnType<typeof liveCall>;

const shape = (r: TraceRecord) => [r.event.type, (r.event as { text?: string }).text ?? null, r.decision.kind, r.joined?.fragments ?? null];

/** Live, then replayed from the frame log: the same turns, joined the same way. */
async function sameOnReplay(call: Call): Promise<void> {
  const live = call.records();
  vi.useRealTimers();
  const replayed = await call.replay();
  expect(replayed.skipped).toEqual([]);
  expect(replayed.records.map(shape)).toEqual(live.map(shape));
}

/** The frame log's lines of one kind, by key. */
function logged(call: Call, key: string): unknown[] {
  return call.logs().filter((l) => l.dir === 'log' && l.msg[key] !== undefined).map((l) => l.msg[key]);
}

/** The greeting, as it went out. */
async function greeted(call: Call): Promise<string> {
  await call.start();
  const greeting = call.texts()[0]!;
  expect(greeting).toBeTruthy();
  await vi.advanceTimersByTimeAsync(65);
  await call.agent(true);
  return greeting;
}

describe('a spurious interrupt, RESAY_SPURIOUS_INTERRUPTS on Telnyx (BARGE_IN=speech)', () => {
  it('the live call: Telnyx\'s barge-in 1704 ms into the greeting, no caller heard: the greeting is said again', async () => {
    const call = liveCall('telnyx', 'speech', SPURIOUS);
    const greeting = await greeted(call);
    await vi.advanceTimersByTimeAsync(1_639);
    const cut = call.cut(greeting, 1_704);
    // Waits out the settle for the caller's words: Telnyx reports no caller over the greeting. Nothing is said meanwhile.
    await vi.advanceTimersByTimeAsync(SPURIOUS_INTERRUPT_UNREPORTED_SETTLE_MS - 1);
    expect(call.texts()).toEqual([greeting]);
    await vi.advanceTimersByTimeAsync(1);
    await cut;
    expect(call.texts()).toEqual([greeting, greeting]);
    expect(logged(call, 'spuriousInterrupt')).toEqual([{ afterMs: 1_704, quietMs: null }]);
    expect(logged(call, 'resaid')).toEqual([{ reason: 'spurious-interrupt', afterMs: 1_704, expectedMs: expect.any(Number) }]);
    // The resay comes just before its frames.
    const logs = call.logs();
    const at = logs.findIndex((l) => l.msg.resaid !== undefined);
    expect(logs[at + 1]).toMatchObject({ dir: 'out', msg: { type: 'text', token: greeting } });
    // No barge-in for the core: no turn ran for it, and the next answer is not told of one.
    expect(call.session().lastInterrupt).toBeNull();
    expect(call.records().map((r) => r.event.type)).toEqual(['session.start']);
    await call.say('i want to report a problem');
    expect(call.records().at(-1)!.turnState).toMatchObject({ asr: { bargeIn: false } });
    await sameOnReplay(call);
  });

  it('is said again once only: the re-sent greeting cut off the same way is left to the no-input wait', async () => {
    const call = liveCall('telnyx', 'speech', SPURIOUS);
    const greeting = await greeted(call);
    await vi.advanceTimersByTimeAsync(1_639);
    const first = call.cut(greeting, 1_704);
    await vi.advanceTimersByTimeAsync(SPURIOUS_INTERRUPT_UNREPORTED_SETTLE_MS);
    await first;
    await vi.advanceTimersByTimeAsync(1_500);
    const second = call.cut(greeting, 1_500);
    await vi.advanceTimersByTimeAsync(SPURIOUS_INTERRUPT_UNREPORTED_SETTLE_MS);
    await second;
    expect(call.texts()).toEqual([greeting, greeting]);
    expect(logged(call, 'spuriousInterrupt')).toHaveLength(2);
    expect(logged(call, 'resaid')).toHaveLength(1);
    await sameOnReplay(call);
  });

  it('a real interrupt: the caller heard 200 ms before it is a barge-in, as before', async () => {
    const call = liveCall('telnyx', 'speech', SPURIOUS);
    const greeting = await greeted(call);
    await vi.advanceTimersByTimeAsync(1_439);
    await call.caller(true);
    await vi.advanceTimersByTimeAsync(200);
    // Taken at once: no settle.
    await call.cut(greeting, 1_704);
    expect(call.session().lastInterrupt).toEqual({ heard: greeting, afterMs: 1_704 });
    await vi.advanceTimersByTimeAsync(SPURIOUS_INTERRUPT_UNREPORTED_SETTLE_MS * 2);
    expect(call.texts()).toEqual([greeting]);
    expect(logged(call, 'spuriousInterrupt')).toEqual([]);
    await call.caller(false);
    await vi.advanceTimersByTimeAsync(900);
    await call.say('i want to report a problem');
    expect(call.records().at(-1)!.turnState).toMatchObject({ asr: { bargeIn: true } });
    await sameOnReplay(call);
  });

  it('a caller who stopped speaking 300 ms before it is heard too', async () => {
    const call = liveCall('telnyx', 'speech', SPURIOUS);
    const greeting = await greeted(call);
    await vi.advanceTimersByTimeAsync(800);
    await call.speak(539);
    await vi.advanceTimersByTimeAsync(300);
    await call.cut(greeting, 1_704);
    expect(call.session().lastInterrupt).toEqual({ heard: greeting, afterMs: 1_704 });
    expect(logged(call, 'spuriousInterrupt')).toEqual([]);
  });

  it('the caller heard within the settle (the carrier\'s report coming late): the interrupt was real, nothing is said again', async () => {
    const call = liveCall('telnyx', 'speech', SPURIOUS);
    const greeting = await greeted(call);
    await vi.advanceTimersByTimeAsync(1_639);
    const cut = call.cut(greeting, 1_704);
    await vi.advanceTimersByTimeAsync(68);
    await call.caller(true);
    await cut;
    expect(call.session().lastInterrupt).toEqual({ heard: greeting, afterMs: 1_704 });
    await vi.advanceTimersByTimeAsync(SPURIOUS_INTERRUPT_UNREPORTED_SETTLE_MS * 2);
    expect(call.texts()).toEqual([greeting]);
    expect(logged(call, 'spuriousInterrupt')).toEqual([]);
    await call.caller(false);
    await vi.advanceTimersByTimeAsync(900);
    await call.say('i want to report a problem');
    await sameOnReplay(call);
  });

  it('a short barge-in over the greeting, which Telnyx does not report: its prompt within the longer settle makes it real, and the greeting is not said again', async () => {
    const call = liveCall('telnyx', 'speech', SPURIOUS);
    const greeting = await greeted(call);
    await vi.advanceTimersByTimeAsync(1_639);
    // "agent", over the greeting: no clientSpeaking, the interrupt, then the transcript about a second after the caller stopped.
    const cut = call.cut(greeting, 1_704);
    await vi.advanceTimersByTimeAsync(1_200);
    expect(call.texts()).toEqual([greeting]);
    const said = call.say('i want to report a problem');
    await cut;
    await said;
    expect(call.texts()).toEqual([greeting, 'Sure, I can help you report a problem.', 'Where is the problem?']);
    expect(logged(call, 'spuriousInterrupt')).toEqual([]);
    expect(logged(call, 'resaid')).toEqual([]);
    expect(call.records().at(-1)!.turnState).toMatchObject({ asr: { bargeIn: true } });
    await sameOnReplay(call);
  });

  it('a prompt within the settle is the caller too', async () => {
    const call = liveCall('telnyx', 'speech', SPURIOUS);
    const greeting = await greeted(call);
    await vi.advanceTimersByTimeAsync(1_639);
    const cut = call.cut(greeting, 1_704);
    await vi.advanceTimersByTimeAsync(200);
    const said = call.say('i want to report a problem');
    await cut;
    await said;
    expect(call.texts()).toEqual([greeting, 'Sure, I can help you report a problem.', 'Where is the problem?']);
    expect(logged(call, 'spuriousInterrupt')).toEqual([]);
    expect(call.records().at(-1)!.turnState).toMatchObject({ asr: { bargeIn: true } });
    await sameOnReplay(call);
  });

  it('within continueWithinMs of a re-ask, a spurious interrupt joins nothing: the next prompt is its own', async () => {
    const call = liveCall('telnyx', 'speech', SPURIOUS);
    await call.start();
    await call.speak(900);
    await vi.advanceTimersByTimeAsync(800);
    await call.say('i want to report a problem');
    await vi.advanceTimersByTimeAsync(3_000);
    await call.speak(400);
    await vi.advanceTimersByTimeAsync(900);
    await call.say('at');
    expect(call.texts().at(-1)).toBe(REASK);
    await vi.advanceTimersByTimeAsync(150);
    const cut = call.cut(REASK, 150);
    await vi.advanceTimersByTimeAsync(SPURIOUS_INTERRUPT_SETTLE_MS);
    await cut;
    expect(call.texts().slice(-2)).toEqual([REASK, REASK]);
    expect(logged(call, 'resaid')).toEqual([{ reason: 'spurious-interrupt', afterMs: 150, expectedMs: expect.any(Number) }]);
    // The caller heard the question, and answers it 2.5 s later: their answer alone.
    await vi.advanceTimersByTimeAsync(2_500);
    await call.speak(900);
    await vi.advanceTimersByTimeAsync(800);
    await call.say('22 Alder Street.');
    expect(call.session().slots.place?.value).toBe('22 Alder Street.');
    expect(call.records().at(-1)!.joined).toBeUndefined();
    await sameOnReplay(call);
  });

  it('never for a turn that ends the call', async () => {
    const call = liveCall('telnyx', 'speech', SPURIOUS);
    await call.start();
    await vi.advanceTimersByTimeAsync(3_000);
    await call.say('agent');
    const before = call.texts();
    await vi.advanceTimersByTimeAsync(300);
    await call.cut(before.at(-1)!, 300);
    await vi.advanceTimersByTimeAsync(SPURIOUS_INTERRUPT_UNREPORTED_SETTLE_MS * 2);
    expect(call.texts()).toEqual(before);
    expect(logged(call, 'resaid')).toEqual([]);
  });

  it('off (no setting): the interrupt is a barge-in, as before', async () => {
    const call = liveCall('telnyx', 'speech');
    const greeting = await greeted(call);
    await vi.advanceTimersByTimeAsync(1_639);
    await call.cut(greeting, 1_704);
    expect(call.session().lastInterrupt).toEqual({ heard: greeting, afterMs: 1_704 });
    await vi.advanceTimersByTimeAsync(SPURIOUS_INTERRUPT_UNREPORTED_SETTLE_MS * 2);
    expect(call.texts()).toEqual([greeting]);
  });

  it('Twilio, which reports no caller speaking: the interrupt is a barge-in, as before', async () => {
    const call = liveCall('twilio', 'speech', SPURIOUS);
    await call.start();
    const greeting = call.texts()[0]!;
    await vi.advanceTimersByTimeAsync(1_704);
    await call.cut(greeting, 1_704);
    expect(call.session().lastInterrupt).toEqual({ heard: greeting, afterMs: 1_704 });
    await vi.advanceTimersByTimeAsync(SPURIOUS_INTERRUPT_UNREPORTED_SETTLE_MS * 2);
    expect(call.texts()).toEqual([greeting]);
  });
});

/**
 * To the fragment: the request, then the caller says "seventy six" (595 ms), stops, and its final prompt
 * comes 712 ms later (on the live call 0.55 s, and the turn 0.16 s more; the test's turn takes no time).
 * The prompt is not awaited: its turn holds the reply while the test runs the clock. `before` runs just
 * before the prompt comes.
 */
async function toFragment(call: Call, first = FIRST, before?: () => void): Promise<{ held: Promise<void> }> {
  await call.start();
  await call.speak(900);
  await vi.advanceTimersByTimeAsync(800);
  await call.say('i want to report a problem');
  await vi.advanceTimersByTimeAsync(3_000);
  await call.speak(595);
  await vi.advanceTimersByTimeAsync(712);
  before?.();
  // In an object: an async function's returned promise would be waited for.
  return { held: call.say(first) };
}

/** The joined turn: the whole address, read back, on the session as it was before "seventy six". */
function expectJoined(call: Call): void {
  expect(call.session().slots.place?.value).toBe(JOINED);
  const last = call.records().at(-1)!;
  expect(last.event).toMatchObject({ type: 'user.speech', text: JOINED });
  expect(last.joined).toEqual({ fragments: [FIRST, REST] });
  // The re-ask was never said: the only line after "Where is the problem?" is the read-back.
  expect(call.texts().slice(-2)).toEqual(['Where is the problem?', `A problem at ${JOINED}. Is that right?`]);
}

describe('a reply held for a caller clearly not finished, INCOMPLETE_WAIT_MS on Telnyx (BARGE_IN=speech)', () => {
  it.each([
    ['the seventy-six call: back in 0.68 s after the prompt', 680],
    ['the first call: back in 0.23 s after the prompt', 231],
    ['the second call: back in 0.89 s after the prompt', 888],
  ])('%s: held, joined, and nothing said over the caller', async (_name, backInMs) => {
    const call = liveCall('telnyx', 'speech', HOLD);
    const { held } = await toFragment(call);
    await vi.advanceTimersByTimeAsync(backInMs);
    expect(call.texts().at(-1)).toBe('Where is the problem?');
    await call.caller(true);
    await held;
    expect(logged(call, 'replyHeld')).toEqual([{ ms: backInMs, outcome: 'joined', utteranceComplete: 0.3, turn: expect.any(Number) }]);
    await vi.advanceTimersByTimeAsync(800);
    await call.speak(150, 400);
    await vi.advanceTimersByTimeAsync(900);
    await call.say(REST);
    expectJoined(call);
    await sameOnReplay(call);
  });

  it('a final prompt within the wait, with no report of the caller speaking, joins too', async () => {
    const call = liveCall('telnyx', 'speech', HOLD);
    const { held } = await toFragment(call);
    await vi.advanceTimersByTimeAsync(700);
    const rest = call.say(REST);
    await held;
    await rest;
    expect(logged(call, 'replyHeld')).toEqual([{ ms: 700, outcome: 'joined', utteranceComplete: 0.3, turn: expect.any(Number) }]);
    expectJoined(call);
    await sameOnReplay(call);
  });

  it('a caller speaking as the fragment\'s turn ends is joined at once', async () => {
    const call = liveCall('telnyx', 'speech', HOLD);
    await call.start();
    await call.speak(900);
    await vi.advanceTimersByTimeAsync(800);
    await call.say('i want to report a problem');
    await vi.advanceTimersByTimeAsync(3_000);
    await call.speak(595, 500);
    await call.caller(true);
    await call.say(FIRST);
    expect(logged(call, 'replyHeld')).toEqual([{ ms: 0, outcome: 'joined', utteranceComplete: 0.3, turn: expect.any(Number) }]);
    await vi.advanceTimersByTimeAsync(400);
    await call.caller(false);
    await vi.advanceTimersByTimeAsync(900);
    await call.say(REST);
    expectJoined(call);
    await sameOnReplay(call);
  });

  it('no caller in the wait: the reply goes once it has passed, and the next prompt is its own', async () => {
    const call = liveCall('telnyx', 'speech', HOLD);
    const { held } = await toFragment(call);
    await vi.advanceTimersByTimeAsync(DEFAULT_INCOMPLETE_WAIT_MS - 1);
    expect(call.texts().at(-1)).toBe('Where is the problem?');
    await vi.advanceTimersByTimeAsync(1);
    await held;
    expect(call.texts().at(-1)).toBe(REASK);
    expect(logged(call, 'replyHeld')).toEqual([{ ms: DEFAULT_INCOMPLETE_WAIT_MS, outcome: 'sent', utteranceComplete: 0.3, turn: expect.any(Number) }]);
    // The caller answers the re-ask after hearing it.
    await vi.advanceTimersByTimeAsync(2_500);
    await call.speak(900);
    await vi.advanceTimersByTimeAsync(800);
    await call.say('22 Alder Street.');
    expect(call.session().slots.place?.value).toBe('22 Alder Street.');
    expect(call.records().at(-1)!.joined).toBeUndefined();
    await sameOnReplay(call);
  });

  it('a complete answer is never held', async () => {
    const call = liveCall('telnyx', 'speech', HOLD);
    await (await toFragment(call, 'at the corner')).held;
    expect(call.texts().at(-1)).toBe(REASK);
    expect(logged(call, 'replyHeld')).toEqual([]);
  });

  it('a turn that ends the call is never held, however unfinished the words', async () => {
    const call = liveCall('telnyx', 'speech', HOLD);
    await call.start();
    await call.speak(900);
    await vi.advanceTimersByTimeAsync(800);
    await call.say('agent please');
    expect(call.session().ended).toBe(true);
    expect(logged(call, 'replyHeld')).toEqual([]);
  });

  it('only a turn that only spoke is held: not one that went through the gate, ended the call or was quarantined', () => {
    const spoke = {
      decision: { kind: 'prompt', promptId: 'ask_place_retry', vars: {} },
      actions: [{ type: 'say', promptId: 'ask_place_retry', vars: {} }],
      gateEvents: [], effects: [], quarantined: false,
      session: { ended: false, pendingService: null },
      rows: [{ gate: 'utteranceComplete', value: 0.3, threshold: 0.6, passed: false, outcome: 'noted', decided: false }],
    } as unknown as TurnResult;
    const ask = (result: TurnResult) => holdsReply(result, 0.6);
    expect(ask(spoke)).toBe(0.3);
    expect(ask({ ...spoke, gateEvents: [{} as never] })).toBeNull();
    expect(ask({ ...spoke, effects: [{} as never] })).toBeNull();
    expect(ask({ ...spoke, quarantined: true })).toBeNull();
    expect(ask({ ...spoke, session: { ...spoke.session, ended: true } })).toBeNull();
    expect(ask({ ...spoke, decision: { kind: 'handoff', reason: 'live-agent' } } as unknown as TurnResult)).toBeNull();
    // Finished enough, or not read at all (no model call).
    expect(ask({ ...spoke, rows: [{ ...spoke.rows[0]!, value: 0.6 }] })).toBeNull();
    expect(ask({ ...spoke, rows: [] })).toBeNull();
    expect(holdsReply(spoke, 0.25)).toBeNull();
  });

  it('the no-input wait does not run during the hold', async () => {
    const call = liveCall('telnyx', 'speech', HOLD);
    const { held } = await toFragment(call, FIRST, () => { call.deps.noInputMs = 200; });
    const silences = () => call.logs().filter((l) => l.msg.type === 'silence').length;
    expect(noInputArmed(CALL)).toBe(false);
    await vi.advanceTimersByTimeAsync(DEFAULT_INCOMPLETE_WAIT_MS - 1);
    expect(noInputArmed(CALL)).toBe(false);
    expect(silences()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await held;
    expect(call.texts().at(-1)).toBe(REASK);
    // Armed from the reply's send, as for any reply.
    expect(noInputArmed(CALL)).toBe(true);
    expect(silences()).toBe(0);
  });

  it('held and joined, a caller who then says nothing more is asked again by the no-input wait', async () => {
    const call = liveCall('telnyx', 'speech', HOLD);
    const { held } = await toFragment(call, FIRST, () => { call.deps.noInputMs = 2_000; });
    await vi.advanceTimersByTimeAsync(680);
    await call.caller(true);
    await held;
    // Held while they speak: a cough, then nothing.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(call.logs().some((l) => l.msg.type === 'silence')).toBe(false);
    await call.caller(false);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(call.logs().some((l) => l.msg.type === 'silence')).toBe(true);
  });

  it('held and joined on a cough with no prompt after it: asked again NO_INPUT_AFTER_SPEECH_MS after the cough, not a whole NO_INPUT_MS', async () => {
    const call = liveCall('telnyx', 'speech', HOLD);
    const { held } = await toFragment(call, FIRST, () => { call.deps.noInputMs = 7_000; });
    await vi.advanceTimersByTimeAsync(680);
    await call.caller(true);
    await held;
    await vi.advanceTimersByTimeAsync(200);
    await call.caller(false);
    const silences = () => call.logs().filter((l) => l.msg.type === 'silence').length;
    await vi.advanceTimersByTimeAsync(DEFAULT_NO_INPUT_AFTER_SPEECH_MS - 1);
    expect(silences()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(silences()).toBe(1);
  });

  it('off (no setting): the reply goes at once, as before', async () => {
    const call = liveCall('telnyx', 'speech');
    await (await toFragment(call)).held;
    expect(call.texts().at(-1)).toBe(REASK);
    expect(logged(call, 'replyHeld')).toEqual([]);
  });

  it('Twilio, which reports no caller speaking: never held', async () => {
    const call = liveCall('twilio', 'speech', HOLD);
    await call.start();
    await call.say('i want to report a problem');
    await call.say(FIRST);
    expect(call.texts().at(-1)).toBe(REASK);
    expect(logged(call, 'replyHeld')).toEqual([]);
  });

  it('an app with continueWithinMs 0, which joins nothing: never held', async () => {
    resetAppsForTest();
    registerApp(placeApp({ voice: { continueWithinMs: 0 } }));
    registerTestkit();
    const call = liveCall('telnyx', 'speech', HOLD);
    await (await toFragment(call)).held;
    expect(call.texts().at(-1)).toBe(REASK);
    expect(logged(call, 'replyHeld')).toEqual([]);
  });

  it('INCOMPLETE_WAIT_BELOW sets the reading under which a reply is held', async () => {
    const call = liveCall('telnyx', 'speech', { incompleteWait: { waitMs: DEFAULT_INCOMPLETE_WAIT_MS, below: 0.25 } });
    await (await toFragment(call)).held;
    expect(call.texts().at(-1)).toBe(REASK);
    expect(logged(call, 'replyHeld')).toEqual([]);
  });
});

describe('the settings', () => {
  const telnyx = { PUBLIC_HOST: 'demo.example.app', HANDOFF_NUMBER: '+15551234567', VOICE_PROVIDERS: 'telnyx', TELNYX_PUBLIC_KEY: Buffer.alloc(32, 7).toString('base64') };
  const events = { ...telnyx, TELNYX_EVENTS: 'speaker-events tokens-played' };

  it('default to on, 700 ms, 1000 ms and the gate\'s own GATE_COMPLETE, and are read when set', () => {
    expect(loadConfig(telnyx)).toMatchObject({ resaySpuriousInterrupts: true, spuriousInterruptWindowMs: 700, incompleteWaitMs: 1_000, incompleteWaitBelow: null });
    expect(loadConfig({ ...telnyx, RESAY_SPURIOUS_INTERRUPTS: 'OFF', SPURIOUS_INTERRUPT_WINDOW_MS: '1000', INCOMPLETE_WAIT_MS: '0', INCOMPLETE_WAIT_BELOW: '0.5' }))
      .toMatchObject({ resaySpuriousInterrupts: false, spuriousInterruptWindowMs: 1_000, incompleteWaitMs: 0, incompleteWaitBelow: 0.5 });
  });

  it('refuse a value out of range', () => {
    expect(() => loadConfig({ ...telnyx, RESAY_SPURIOUS_INTERRUPTS: 'yes' })).toThrow('RESAY_SPURIOUS_INTERRUPTS must be on or off, got "yes"');
    for (const bad of ['5001', '-1', 'soon']) expect(() => loadConfig({ ...telnyx, SPURIOUS_INTERRUPT_WINDOW_MS: bad })).toThrow(/SPURIOUS_INTERRUPT_WINDOW_MS must be/);
    for (const bad of ['3001', '-1', 'x']) expect(() => loadConfig({ ...telnyx, INCOMPLETE_WAIT_MS: bad })).toThrow(/INCOMPLETE_WAIT_MS must be/);
    for (const bad of ['0.04', '0.96', 'half']) expect(() => loadConfig({ ...telnyx, INCOMPLETE_WAIT_BELOW: bad })).toThrow(/INCOMPLETE_WAIT_BELOW must be/);
  });

  it('are said at startup where a carrier reports the caller\'s voice, with whether its events are asked for', () => {
    const on = describeConfig(loadConfig(events));
    expect(on).toContain('spurious interrupts said again (no caller heard within 700 ms)');
    expect(on).toContain('replies held up to 1000 ms for an unfinished caller (under GATE_COMPLETE)');
    const without = describeConfig(loadConfig(telnyx));
    expect(without).toContain('spurious interrupts said again (no caller heard within 700 ms; inactive without TELNYX_EVENTS speaker-events)');
    expect(without).toContain('replies held up to 1000 ms for an unfinished caller (under GATE_COMPLETE; inactive without TELNYX_EVENTS speaker-events)');
    const off = describeConfig(loadConfig({ ...events, RESAY_SPURIOUS_INTERRUPTS: 'off', INCOMPLETE_WAIT_MS: '0', INCOMPLETE_WAIT_BELOW: '0.5' }));
    expect(off).toContain('spurious interrupts not said again');
    expect(off).toContain('replies never held');
    expect(describeConfig(loadConfig({ ...events, INCOMPLETE_WAIT_BELOW: '0.5' }))).toContain('(under 0.5)');
    const twilio = describeConfig(loadConfig({ PUBLIC_HOST: 'demo.example.app', TWILIO_AUTH_TOKEN: 'tok', HANDOFF_NUMBER: '+15551234567' }));
    expect(twilio).not.toContain('spurious');
    expect(twilio).not.toContain('replies');
  });
});
