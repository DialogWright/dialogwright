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

/**
 * A `digits` slot on the phone (live calls, 2026-10-13, both carriers):
 *
 * - Its value said back digit by digit (`sayAs`): the voice read "0142" as "one hundred forty-two". The
 *   wire carries each digit; the session, the trace and the frame log's masking keep the value as written.
 * - A number said with a pause (`waitForRestMs`): after a nine-digit miss, a caller asked again for an
 *   eight-digit number said "Five." and paused; the keypad line answered it, the caller spoke over it
 *   235 ms later, and Telnyx (barge-in off) transcribed nothing while the line it could not interrupt
 *   played: the rest was lost. Words that are only the start of the number are held, before any turn,
 *   and the words that follow are joined to them; one turn runs, so nothing is undone.
 */

const CALL = 'CA7';
const APP_ID = 'account-line';
const ASK = 'What is your account number?';
const REASK = 'Sorry, what is the account number?';
const KEYPAD = 'Please key in the account number on your keypad.';
const FIRST = 'Five.';
const REST = 'five five two zero four one seven.';
const READ_BACK = 'Account 5552 0417. Is that right?';
const READ_BACK_SAID = 'Account 5 5 5 2, 0 4 1 7. Is that right?';
/** The read-back as the trace keeps it: as written, masked by its last four as it always is. */
const READ_BACK_TRACED = 'Account ...0417. Is that right?';

/** The place app's one form, asking an eight-digit account number, said back in two groups of four. */
function accountApp(options: Record<string, unknown> = {}, over: Partial<App> = {}): App {
  const base = placeApp();
  const account = defineSlot('account', { type: 'digits', noun: 'account', length: 8, group: [4, 4], keypad: true, ...options });
  return placeApp({
    id: APP_ID,
    forms: { report: { ...base.forms.report!, slots: ['account'] } },
    slots: { account },
    prompts: {
      manifest: {
        ...base.prompts.manifest,
        ask_account: { text: ASK, interruptible: true },
        ask_account_retry: { text: REASK, interruptible: true },
        ask_account_dtmf: { text: KEYPAD, interruptible: false },
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

/** To the account question; then `misses` wrong numbers, each answered by the slot's ladder. */
async function toAccount(call: Call, misses = 0): Promise<void> {
  await call.start();
  await call.say('i want to report a problem');
  expect(call.wire().at(-1)).toBe(ASK);
  for (let i = 0; i < misses; i++) await call.say('five five five zero one one two three four');
}

/** The first digit, its turn not awaited (its words may be held). In an object: an async function's returned promise would be waited for. */
function firstDigit(call: Call): { held: Promise<void> } {
  return { held: call.say(FIRST) };
}

/** The frame log's lines of one kind, by key, with no silence turn among the frames. */
function silences(call: Call): number {
  return call.frameLog().filter((l) => l.dir === 'in' && l.msg.type === 'silence').length;
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

describe('a number said with a pause (waitForRestMs): the words held, before any turn', () => {
  it('the live call: Telnyx, barge-in off, a nine-digit miss, then "Five.", the caller back in 235 ms later, then the rest: filled, the keypad line never said', async () => {
    const call = liveCall(accountApp(), 'telnyx', 'none');
    await toAccount(call, 1);
    expect(call.wire().at(-1)).toBe(REASK);
    expect(call.session().slots.account?.attempts).toBe(1);
    const { held } = firstDigit(call);
    await vi.advanceTimersByTimeAsync(235);
    await call.caller(true);
    // Held while they speak, however long.
    await vi.advanceTimersByTimeAsync(4_000);
    expect(call.wire().at(-1)).toBe(REASK);
    await call.caller(false);
    await vi.advanceTimersByTimeAsync(600);
    await call.say(REST);
    await held;
    expect(call.wire()).not.toContain(KEYPAD);
    expect(call.wire().at(-1)).toBe(READ_BACK_SAID);
    expect(call.session().slots.account).toMatchObject({ value: '55520417', attempts: 1 });
    expect(logged(call, 'wordsHeld')).toEqual([{ slot: 'account', ms: 4_835, fragments: 2, end: 'rest' }]);
    expect(call.records().at(-1)!.joined).toEqual({ fragments: [FIRST, REST], waitedFor: 'account' });
    expect(silences(call)).toBe(0);
    await sameOnReplay(call);
  });

  it('Twilio: a partial prompt in the wait starts it again, and the final one joins', async () => {
    const call = liveCall(accountApp());
    await toAccount(call);
    const { held } = firstDigit(call);
    await vi.advanceTimersByTimeAsync(1_400);
    await call.partial('five five');
    await vi.advanceTimersByTimeAsync(1_400);
    expect(call.wire().at(-1)).toBe(ASK);
    await call.say(REST);
    await held;
    expect(call.wire().slice(-2)).toEqual([ASK, READ_BACK_SAID]);
    expect(call.session().slots.account).toMatchObject({ value: '55520417', attempts: 0 });
    expect(logged(call, 'wordsHeld')).toEqual([{ slot: 'account', ms: 2_800, fragments: 2, end: 'rest' }]);
    await sameOnReplay(call);
  });

  it('a number said in four parts is joined whole: the hold goes on while the words are still the start of it', async () => {
    const call = liveCall(accountApp());
    await toAccount(call);
    const held = call.say('five five');
    for (const part of ['five two', 'zero four']) {
      await vi.advanceTimersByTimeAsync(1_000);
      await call.say(part);
    }
    await vi.advanceTimersByTimeAsync(1_000);
    await call.say('one seven');
    await held;
    expect(call.wire().slice(-2)).toEqual([ASK, READ_BACK_SAID]);
    expect(call.records().at(-1)!.joined).toEqual({ fragments: ['five five', 'five two', 'zero four', 'one seven'], waitedFor: 'account' });
    await sameOnReplay(call);
  });

  it('nothing more: the words run alone when the wait is over, once, as they would have', async () => {
    const call = liveCall(accountApp());
    await toAccount(call);
    const { held } = firstDigit(call);
    await vi.advanceTimersByTimeAsync(1_499);
    expect(call.wire().at(-1)).toBe(ASK);
    await vi.advanceTimersByTimeAsync(1);
    await held;
    expect(call.wire().at(-1)).toBe(REASK);
    expect(call.session().slots.account?.attempts).toBe(1);
    expect(logged(call, 'wordsHeld')).toEqual([{ slot: 'account', ms: 1_500, fragments: 1, end: 'timeout' }]);
    expect(call.records().at(-1)!.joined).toBeUndefined();
    await call.say('five five five two zero four one seven');
    expect(call.wire().at(-1)).toBe(READ_BACK_SAID);
    await sameOnReplay(call);
  });

  it('a cough on Telnyx, no prompt after it: the words run alone once the caller stops and the wait passes, with no silence turn and no second failure', async () => {
    const call = liveCall(accountApp(), 'telnyx', 'none', { noInputMs: 2_000 });
    await toAccount(call, 1);
    const { held } = firstDigit(call);
    await vi.advanceTimersByTimeAsync(300);
    await call.caller(true);
    await vi.advanceTimersByTimeAsync(200);
    await call.caller(false);
    await vi.advanceTimersByTimeAsync(1_499);
    expect(call.wire().at(-1)).toBe(REASK);
    await vi.advanceTimersByTimeAsync(1);
    await held;
    // "Five." alone: the second miss, the keypad line; nothing else.
    expect(call.wire().at(-1)).toBe(KEYPAD);
    expect(call.session().slots.account?.attempts).toBe(2);
    expect(call.session().ended).toBe(false);
    expect(silences(call)).toBe(0);
    expect(logged(call, 'wordsHeld')).toEqual([{ slot: 'account', ms: 2_000, fragments: 1, end: 'timeout' }]);
    await sameOnReplay(call);
  });

  it('a partial on Twilio with no final after it: the words run alone, with no silence turn and no second failure', async () => {
    const call = liveCall(accountApp(), 'twilio', 'any', { noInputMs: 2_000 });
    await toAccount(call, 1);
    const { held } = firstDigit(call);
    await vi.advanceTimersByTimeAsync(500);
    await call.partial('uh');
    await vi.advanceTimersByTimeAsync(1_500);
    await held;
    expect(call.wire().at(-1)).toBe(KEYPAD);
    expect(call.session().slots.account?.attempts).toBe(2);
    expect(silences(call)).toBe(0);
    await sameOnReplay(call);
  });

  it('on the last attempt too: two misses, then "Five." and the rest, filled rather than handed to a person', async () => {
    const call = liveCall(accountApp(), 'telnyx', 'none');
    await toAccount(call, 2);
    expect(call.wire().at(-1)).toBe(KEYPAD);
    expect(call.session().slots.account?.attempts).toBe(2);
    const { held } = firstDigit(call);
    await vi.advanceTimersByTimeAsync(800);
    await call.say(REST);
    await held;
    expect(call.session().ended).toBe(false);
    expect(call.session().slots.account?.value).toBe('55520417');
    expect(call.wire().at(-1)).toBe(READ_BACK_SAID);
    await sameOnReplay(call);
  });

  it('a key pressed in the wait runs the words at once, then the key', async () => {
    const call = liveCall(accountApp());
    await toAccount(call);
    const { held } = firstDigit(call);
    await vi.advanceTimersByTimeAsync(300);
    const key = call.key('5');
    await held;
    await key;
    expect(logged(call, 'wordsHeld')).toEqual([{ slot: 'account', ms: 300, fragments: 1, end: 'key' }]);
    expect(call.wire()).toContain(REASK);
    await sameOnReplay(call);
  });

  it('the slot\'s own wait; 0 holds nothing; nor does continueWithinMs 0 stop it', async () => {
    const slow = liveCall(accountApp({ waitForRestMs: 3_000 }));
    await toAccount(slow);
    const { held } = firstDigit(slow);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(slow.wire().at(-1)).toBe(ASK);
    await vi.advanceTimersByTimeAsync(1);
    await held;
    expect(slow.wire().at(-1)).toBe(REASK);
    forgetNoInput(CALL);
    const at = liveCall(accountApp({ waitForRestMs: 0 }));
    await toAccount(at);
    await firstDigit(at).held;
    expect(at.wire().at(-1)).toBe(REASK);
    expect(logged(at, 'wordsHeld')).toEqual([]);
    forgetNoInput(CALL);
    const off = liveCall(accountApp({}, { voice: { continueWithinMs: 0 } }));
    await toAccount(off);
    const second = firstDigit(off);
    await vi.advanceTimersByTimeAsync(500);
    await off.say(REST);
    await second.held;
    expect(off.wire().slice(-2)).toEqual([ASK, READ_BACK_SAID]);
    await sameOnReplay(off);
  });

  it('a whole number, a number too long, and words with no digits are never held', async () => {
    const call = liveCall(accountApp());
    await toAccount(call);
    await call.say('five five five zero one one two three four');
    expect(call.wire().at(-1)).toBe(REASK);
    await call.say('i do not have it');
    await call.say('five five five two zero four one seven');
    expect(call.wire().at(-1)).toBe(READ_BACK_SAID);
    expect(logged(call, 'wordsHeld')).toEqual([]);
  });

  it('replay joins as the log says, whatever the slot says now', async () => {
    const call = liveCall(accountApp());
    await toAccount(call);
    const { held } = firstDigit(call);
    await vi.advanceTimersByTimeAsync(700);
    await call.say(REST);
    await held;
    const live = call.records();
    // The slot no longer waits: the log's line still joins the two prompts.
    resetAppsForTest();
    registerApp(accountApp({ waitForRestMs: 0 }));
    registerTestkit();
    vi.useRealTimers();
    const replayed = await call.replay();
    expect(replayed.records.map(shape)).toEqual(live.map(shape));
  });
});
