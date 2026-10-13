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
import { placeApp } from '../testing/placeApp';
import { choice, noul } from '../testing/answers';
import { defineSlot } from '../slots/defineSlot';
import { spokenToDigits } from '../core/extract/spokenNumber';
import type { App } from '../core/app/types';
import type { AnswerMap, JevClient, Question } from '../jev/types';
import type { BargeIn } from '../channel/voiceProviders';
import { waitsForRest } from '../run/continuation';
import type { TurnResult } from '../core/turn';

/**
 * A `digits` slot on the phone (live calls, 2026-10-13, both carriers):
 *
 * - Its value said back digit by digit (`sayAs`): the voice read "0142" as "one hundred forty-two". The
 *   wire carries each digit; the session, the trace and the frame log's masking keep the value as written.
 * - A number said with a pause (`waitForRestMs`): asked for an eight-digit number, a caller said "Five.",
 *   paused, then the rest; the engine answered the first digit with a re-ask, and the rest was lost. The
 *   re-ask is held for the rest, and the words that follow are joined to the first.
 */

const CALL = 'CA7';
const APP_ID = 'account-line';
const ASK = 'What is your account number?';
const REASK = 'Sorry, what is the account number?';
const FIRST = 'Five.';
const REST = 'five five two zero four one seven.';
const READ_BACK = 'Account 5552 0417. Is that right?';
const READ_BACK_SAID = 'Account 5 5 5 2, 0 4 1 7. Is that right?';
/** The read-back as the trace keeps it: as written, masked by its last four as it always is. */
const READ_BACK_TRACED = 'Account ...0417. Is that right?';

/** The place app's one form, asking an eight-digit account number, said back in two groups of four. */
function accountApp(options: Record<string, unknown> = {}, over: Partial<App> = {}): App {
  const base = placeApp();
  const account = defineSlot('account', { type: 'digits', noun: 'account', length: 8, group: [4, 4], ...options });
  return placeApp({
    id: APP_ID,
    forms: { report: { ...base.forms.report!, slots: ['account'] } },
    slots: { account },
    prompts: {
      manifest: {
        ...base.prompts.manifest,
        ask_account: { text: ASK, interruptible: true },
        ask_account_retry: { text: REASK, interruptible: true },
        confirm_report: { text: 'Account {account}. Is that right?', interruptible: true },
      },
      tags: {},
    },
    ...over,
  });
}

function quiet(q: Question): AnswerMap[string] {
  if (q.type === 'noul') return noul(0.02);
  const labels = q.type === 'choice' ? Object.keys(q.criteria) : q.levels.map((l) => l.label);
  const pick = labels.includes('none') ? 'none' : labels.includes('answering') ? 'answering' : labels[0]!;
  return choice(Object.fromEntries(labels.map((l) => [l, l === pick ? 0.9 : 0.1 / Math.max(1, labels.length - 1)])));
}

/** A model that hears a request to report, and a number as the span of the most digits, said whole. */
function accountClient(): JevClient {
  return {
    ask: async (req) => {
      const text = (req.state as { asr?: { text?: string } } | null)?.asr?.text ?? '';
      const answers: AnswerMap = {};
      for (const [id, q] of Object.entries(req.questions)) answers[id] = quiet(q);
      const set = (id: string, a: AnswerMap[string]) => {
        if (Object.hasOwn(req.questions, id)) answers[id] = a;
      };
      set('addressedToSystem', noul(0.95));
      set('intelligible', noul(0.95));
      set('utteranceComplete', noul(0.9));
      set('intent', /\breport\b/i.test(text) ? choice({ report: 0.95, none: 0.05 })
        : /\bagain\b/i.test(text) ? choice({ repeat_prompt: 0.95, none: 0.05 }) : choice({ none: 0.9, other: 0.1 }));
      set('confirmsYes', noul(/^yes\b/i.test(text) ? 0.95 : 0.02));
      const span = req.questions.accountSpan;
      const spans = span?.type === 'choice' ? Object.keys(span.criteria).filter((s) => s !== 'none') : [];
      const best = spans.sort((a, b) => spokenToDigits(b).length - spokenToDigits(a).length)[0];
      if (best !== undefined) {
        set('accountGiven', noul(0.95));
        set('accountSpan', choice({ [best]: 0.9, none: 0.1 }));
        set('accountComplete', noul(0.9));
      }
      return { answers, model: 'account-test', usage: { inputTokens: 0, outputTokens: 0, estimated: true }, latencyMs: 0, source: 'stub:fixture' };
    },
  };
}

beforeEach(() => {
  resetAppsForTest();
  vi.useFakeTimers();
});
afterEach(() => {
  forgetNoInput(CALL);
  vi.useRealTimers();
});

function liveCall(app: App, provider = 'twilio', bargeIn: BargeIn = 'any', more: Partial<AdapterDeps> = {}) {
  // The default app, which a replayed session is (harness-text/replay.ts).
  resetAppsForTest();
  registerApp(app);
  registerTestkit();
  const dir = mkdtempSync(join(tmpdir(), 'digits-wire-'));
  const opts = { client: accountClient(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-10-13', now: () => 0 };
  const store = new SessionStore((callSid) => ({
    session: newSession(callSid, 0, VOICE_RELAY, ANONYMOUS, app.id),
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
  const records = () => readFileSync(join(dir, `${CALL}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as TraceRecord);
  return {
    deps,
    start: () => send({ type: 'setup', sessionId: 'VX7', callSid: CALL, from: '+15555550100', to: '+15555550199', customParameters: {} }),
    // Not awaited by a test that runs the clock while the call's queue waits (a held reply).
    say: (t: string) => send({ type: 'prompt', voicePrompt: t, lang: 'en-US', last: true }),
    partial: (t: string) => send({ type: 'prompt', voicePrompt: t, lang: 'en-US', last: false }),
    key: (digit: string) => send({ type: 'dtmf', digit }),
    caller: (on: boolean) => send({ type: 'info', name: 'clientSpeaking', value: on ? 'on' : 'off' }),
    /** The lines as they went out on the wire. */
    wire: () => sent.filter((f) => f.type === 'text').map((f) => (f.token as string).trimEnd()),
    records,
    /** The lines as the trace has them said. */
    said: () => records().flatMap((r) => r.actions.flatMap((a) => (a.type === 'say' ? a.parts.flatMap((p) => ('text' in p ? [p.text] : [])) : []))),
    frameLog: () => readFileSync(join(dir, `${CALL}.frames.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { dir: string; msg: Record<string, unknown> }),
    replay: () => replayFrameLog(join(dir, `${CALL}.frames.jsonl`), { ...opts, client: accountClient(), trace: null }, undefined, { todayIsoOverride: opts.todayIso }),
    session: () => store.get(CALL)!.session,
  };
}

type Call = ReturnType<typeof liveCall>;

/** The frame log's lines of one kind, by key. */
function logged(call: Call, key: string): unknown[] {
  return call.frameLog().filter((l) => l.dir === 'log' && l.msg[key] !== undefined).map((l) => l.msg[key]);
}

const shape = (r: TraceRecord) => [r.event.type, (r.event as { text?: string }).text ?? null, r.decision.kind, r.joined ?? null];

/** Live, then replayed from the frame log: the same turns, joined the same way. */
async function sameOnReplay(call: Call): Promise<void> {
  const live = call.records();
  vi.useRealTimers();
  const replayed = await call.replay();
  // A partial prompt (Twilio's) is in the log, and no turn of replay's.
  expect(replayed.skipped.filter((s) => !s.endsWith('non-final prompt'))).toEqual([]);
  expect(replayed.records.map(shape)).toEqual(live.map(shape));
}

/** To the account question, then the first digit, its turn not awaited (its reply may be held). */
async function toFirstDigit(call: Call): Promise<{ held: Promise<void> }> {
  await call.start();
  await call.say('i want to report a problem');
  expect(call.wire().at(-1)).toBe(ASK);
  // In an object: an async function's returned promise would be waited for.
  return { held: call.say(FIRST) };
}

describe('a digits value said back digit by digit (sayAs)', () => {
  it('on the wire only: the trace, the session and the console keep the value as written', async () => {
    const call = liveCall(accountApp({ waitForRestMs: 0 }));
    await call.start();
    await call.say('i want to report a problem');
    await call.say('five five five two zero four one seven');
    expect(call.wire().at(-1)).toBe(READ_BACK_SAID);
    expect(call.said().at(-1)).toBe(READ_BACK_TRACED);
    expect(call.session().slots.account).toMatchObject({ value: '55520417', display: '5552 0417' });
    expect(call.session().lastPromptText).toBe(READ_BACK);
  });

  it('a repeat of the line says it digit by digit too, with no variables left', async () => {
    const call = liveCall(accountApp({ waitForRestMs: 0 }));
    await call.start();
    await call.say('i want to report a problem');
    await call.say('five five five two zero four one seven');
    await call.say('can you say that again');
    expect(call.records().at(-1)!.decision.kind).toBe('replay');
    expect(call.wire().at(-1)).toBe(READ_BACK_SAID);
    expect(call.said().at(-1)).toBe(READ_BACK_TRACED);
  });

  it('the frame log masks the value as it went out, spelled out, as the trace masks it', async () => {
    const call = liveCall(accountApp({ waitForRestMs: 0 }));
    await call.start();
    await call.say('i want to report a problem');
    await call.say('five five five two zero four one seven');
    const out = call.frameLog().filter((l) => l.dir === 'out' && l.msg.type === 'text').map((l) => l.msg.token as string);
    expect(out.at(-1)).not.toContain('5 5 5 2');
    expect(out.at(-1)).toContain('0417');
  });

  it('sayAs: number leaves it to the voice, as before', async () => {
    const call = liveCall(accountApp({ waitForRestMs: 0, sayAs: 'number' }));
    await call.start();
    await call.say('i want to report a problem');
    await call.say('five five five two zero four one seven');
    expect(call.wire().at(-1)).toBe(READ_BACK);
  });

  it("the app's own spokenDigits rule spells it first, its way", async () => {
    const call = liveCall(accountApp({ waitForRestMs: 0 }, { voice: { spokenDigits: [{ pattern: /(Account) (\d{4} \d{4})/g, spell: 'lead' }] } }));
    await call.start();
    await call.say('i want to report a problem');
    await call.say('five five five two zero four one seven');
    expect(call.wire().at(-1)).toBe('Account 5 5 5 2   0 4 1 7. Is that right?');
  });
});

describe('a number said with a pause (waitForRestMs)', () => {
  it('Twilio: the re-ask is held, a partial prompt in the wait is the caller going on, and the words are joined', async () => {
    const call = liveCall(accountApp());
    const { held } = await toFirstDigit(call);
    await vi.advanceTimersByTimeAsync(700);
    expect(call.wire().at(-1)).toBe(ASK);
    await call.partial('five five');
    await held;
    expect(logged(call, 'replyHeld')).toEqual([{ ms: 700, outcome: 'joined', slot: 'account', turn: expect.any(Number) }]);
    await vi.advanceTimersByTimeAsync(900);
    await call.say(REST);
    // The re-ask was never said: the line after the question is the read-back of the whole number.
    expect(call.wire().slice(-2)).toEqual([ASK, READ_BACK_SAID]);
    expect(call.session().slots.account).toMatchObject({ value: '55520417', attempts: 0 });
    expect(call.records().at(-1)!.joined).toEqual({ fragments: [FIRST, REST], waitedFor: 'account' });
    await sameOnReplay(call);
  });

  it('a final prompt within the wait joins too', async () => {
    const call = liveCall(accountApp());
    const { held } = await toFirstDigit(call);
    await vi.advanceTimersByTimeAsync(1_200);
    const rest = call.say(REST);
    await held;
    await rest;
    expect(logged(call, 'replyHeld')).toEqual([{ ms: 1_200, outcome: 'joined', slot: 'account', turn: expect.any(Number) }]);
    expect(call.wire().slice(-2)).toEqual([ASK, READ_BACK_SAID]);
    await sameOnReplay(call);
  });

  it('Telnyx with the barge-in off: the caller heard speaking in the wait joins', async () => {
    const call = liveCall(accountApp(), 'telnyx', 'none');
    const { held } = await toFirstDigit(call);
    await vi.advanceTimersByTimeAsync(900);
    await call.caller(true);
    await held;
    expect(logged(call, 'replyHeld')).toEqual([{ ms: 900, outcome: 'joined', slot: 'account', turn: expect.any(Number) }]);
    await vi.advanceTimersByTimeAsync(1_500);
    await call.caller(false);
    await call.say(REST);
    expect(call.wire().slice(-2)).toEqual([ASK, READ_BACK_SAID]);
    expect(call.session().slots.account?.value).toBe('55520417');
    await sameOnReplay(call);
  });

  it('no one goes on: the re-ask goes when the wait is over, the miss counted, and the next prompt is its own', async () => {
    const call = liveCall(accountApp());
    const { held } = await toFirstDigit(call);
    await vi.advanceTimersByTimeAsync(1_499);
    expect(call.wire().at(-1)).toBe(ASK);
    await vi.advanceTimersByTimeAsync(1);
    await held;
    expect(call.wire().at(-1)).toBe(REASK);
    expect(logged(call, 'replyHeld')).toEqual([{ ms: 1_500, outcome: 'sent', slot: 'account', turn: expect.any(Number) }]);
    expect(call.session().slots.account?.attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(3_000);
    await call.say('five five five two zero four one seven');
    expect(call.records().at(-1)!.joined).toBeUndefined();
    expect(call.wire().at(-1)).toBe(READ_BACK_SAID);
    await sameOnReplay(call);
  });

  it('the slot\'s own wait, and 0 waits not at all', async () => {
    const slow = liveCall(accountApp({ waitForRestMs: 3_000 }));
    const { held } = await toFirstDigit(slow);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(slow.wire().at(-1)).toBe(ASK);
    await vi.advanceTimersByTimeAsync(1);
    await held;
    expect(slow.wire().at(-1)).toBe(REASK);
    forgetNoInput(CALL);
    const at = liveCall(accountApp({ waitForRestMs: 0 }));
    await (await toFirstDigit(at)).held;
    expect(at.wire().at(-1)).toBe(REASK);
    expect(logged(at, 'replyHeld')).toEqual([]);
  });

  it('waits with continueWithinMs at 0, which joins nothing else', async () => {
    const call = liveCall(accountApp({}, { voice: { continueWithinMs: 0 } }));
    const { held } = await toFirstDigit(call);
    await vi.advanceTimersByTimeAsync(500);
    const rest = call.say(REST);
    await held;
    await rest;
    expect(call.wire().slice(-2)).toEqual([ASK, READ_BACK_SAID]);
    expect(call.records().at(-1)!.joined).toEqual({ fragments: [FIRST, REST], waitedFor: 'account' });
    await sameOnReplay(call);
  });

  it('a whole number is never held, nor a number too long', async () => {
    const call = liveCall(accountApp());
    await call.start();
    await call.say('i want to report a problem');
    await call.say('five five five two zero four one seven');
    expect(call.wire().at(-1)).toBe(READ_BACK_SAID);
    await call.say('no');
    expect(logged(call, 'replyHeld')).toEqual([]);
    forgetNoInput(CALL);
    const long = liveCall(accountApp());
    await long.start();
    await long.say('i want to report a problem');
    await long.say('five five five two zero four one seven seven');
    expect(long.wire().at(-1)).toBe(REASK);
    expect(logged(long, 'replyHeld')).toEqual([]);
  });

  it('a key pressed in the wait sends the re-ask at once', async () => {
    const call = liveCall(accountApp());
    const { held } = await toFirstDigit(call);
    await vi.advanceTimersByTimeAsync(300);
    const key = call.key('5');
    await held;
    await key;
    expect(call.wire()).toContain(REASK);
    expect(logged(call, 'replyHeld')).toEqual([{ ms: 300, outcome: 'sent', slot: 'account', turn: expect.any(Number) }]);
  });
});

describe('waitsForRest', () => {
  const result = (over: Partial<TurnResult> = {}): TurnResult => ({
    decision: { kind: 'prompt', promptId: 'ask_account_retry', vars: {}, acks: [], target: 'account', options: [] },
    actions: [{ type: 'say', parts: [{ text: REASK }], interruptible: true }],
    gateEvents: [], effects: [], quarantined: false,
    session: { ended: false, pendingService: null, appId: APP_ID },
    fillEvents: [{ slot: 'account', outcome: { kind: 'invalid', reason: 'length', raw: '5' }, rest: true }],
    ...over,
  } as unknown as TurnResult);

  it('is the slot and its wait, for a turn that only asks again a slot whose fill is marked as the start of a value', () => {
    registerApp(accountApp());
    registerTestkit();
    expect(waitsForRest(result())).toEqual({ slot: 'account', ms: 1500 });
    expect(waitsForRest(result({ fillEvents: [{ slot: 'account', outcome: { kind: 'invalid', reason: 'length', raw: '5' } }] }))).toBeNull();
    expect(waitsForRest(result({ decision: { kind: 'prompt', promptId: 'ask_place', vars: {}, acks: [], target: 'intent', options: [] } }))).toBeNull();
    expect(waitsForRest(result({ gateEvents: [{} as never] }))).toBeNull();
    expect(waitsForRest(result({ decision: { kind: 'handoff' } as never }))).toBeNull();
  });
});
