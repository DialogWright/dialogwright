import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { resolve, type TurnContext, type TurnResult } from './turn';
import { newSession, type Session } from './session';
import { DEFAULT_THRESHOLDS } from './thresholds';
import { interruptEvent, speechEvent, startEvent, type UserSpeech } from '../channel/events';
import { choice, noul, score } from '../testing/answers';
import type { AnswerMap, JevClient } from '../jev/types';
import type { SlotSpec } from './slots/types';
import { demoTools } from './tools';
import { VOICE_RELAY } from '../channel/caps';
import { registerApp, resetAppsForTest } from './app/registry';
import { registerTestkit, testkitApp } from '../testing/testkit';
import { ANONYMOUS } from '../gate/principal';
import { PLACE_APP_ID, placeApp, placeClient } from '../testing/placeApp';
import { CODE_MASK } from './spokenCode';
import { Continuation } from '../run/continuation';
import { runScenario, type Scenario } from '../harness-text/runner';
import { runTurn } from '../run/turn';
import { CALLBACK_DIR, callbackApp } from '../testing/callback/app';
import { loadCorpus } from '../jev/corpus';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';

/**
 * Speech over a line the caller could not interrupt (UserSpeech.overLine, SPEECH_OVER_LINE=unless-miss): a
 * turn on it that would be a miss is set aside as side speech is (core/turn.ts overLineMiss), at every
 * question and every rung; one that answers is acted on. The place app (one form asking where a problem
 * is), the test kit for the code prompt, Example Callbacks for an offer. The words are invented.
 */

beforeEach(() => {
  resetAppsForTest();
  registerApp(placeApp());
  registerTestkit();
});

const tc = (): TurnContext => ({ nowMs: 0, todayIso: '2026-11-05', thresholds: { ...DEFAULT_THRESHOLDS }, tools: demoTools() });

function answers(over: AnswerMap = {}): AnswerMap {
  return {
    addressedToSystem: noul(0.95), intelligible: noul(0.95), utteranceComplete: noul(0.9), wantsHuman: noul(0.05),
    rephrasingLastTurn: noul(0.05), confusedByPrompt: noul(0.05), spokeAMenuNumber: noul(0.02),
    frustration: score({ none: 0.9, mild: 0.08, high: 0.02 }),
    intent: choice({ none: 0.9, other: 0.1 }),
    intentChange: choice({ answering: 0.95, adding: 0.03, replacing: 0.02 }),
    confirmsYes: noul(0.02), confirmsNo: noul(0.02),
    ...over,
  };
}

const REPORT: AnswerMap = { intent: choice({ report: 0.95, none: 0.05 }) };
const HIGH: AnswerMap = { frustration: score({ none: 0.05, mild: 0.1, high: 0.85 }) };

function started(app = PLACE_APP_ID): Session {
  return resolve(newSession('s', 0, VOICE_RELAY, ANONYMOUS, app), startEvent(), null, tc()).session;
}

/** Words over a line (`over`), or not, with the model's answers. */
function say(session: Session, text: string, over: boolean, a: AnswerMap = {}): TurnResult {
  const event: UserSpeech = over ? { ...speechEvent(text), overLine: true } : speechEvent(text);
  return resolve(session, event, answers(a), tc());
}

/** Set aside: nothing said, the session as it was but for the barge-in marker, the gate row that says why. */
function expectSetAside(r: TurnResult, before: Session): void {
  expect(r.decision).toEqual({ kind: 'ignore' });
  expect(r.actions).toEqual([]);
  expect(r.setAside).toBe('speech-over-line');
  expect(r.session).toEqual({ ...before, lastInterrupt: null });
  expect(r.rows.filter((g) => g.decided)).toEqual([{ gate: 'speechOverLine', value: null, threshold: null, passed: false, outcome: 'set_aside', decided: true }]);
  expect(r.gateEvents).toEqual([]);
  expect(r.effects).toEqual([]);
}

const promptOf = (r: TurnResult): string | null => (r.decision.kind === 'prompt' ? r.decision.promptId : null);
const atPlace = (): Session => say(started(), 'i want to report a problem', false, REPORT).session;
const atSummary = (): TurnResult => say(atPlace(), '22 Alder Street', false);

describe('speech over a line that would be a miss is set aside', () => {
  it('at the open question: no no-match line, no attempt', () => {
    const s = started();
    expectSetAside(say(s, 'can you pass me the blue folder', true), s);
    // The same words not over a line: the miss it always was.
    const taken = say(s, 'can you pass me the blue folder', false);
    expect(promptOf(taken)).toBe('nomatch_open');
    expect(taken.session.intentAttempts).toBe(1);
  });

  it('words not made out (intelligible under its bar) at the open question', () => {
    const s = started();
    expectSetAside(say(s, 'mmhm rr', true, { intelligible: noul(0.1) }), s);
  });

  it('at the keypad rung: the second miss is not offered the keypad', () => {
    const one = say(started(), 'blah', false).session;
    expect(one.intentAttempts).toBe(1);
    expectSetAside(say(one, 'no the other one', true), one);
    expect(promptOf(say(one, 'no the other one', false))).toBe('nomatch_dtmf_menu');
  });

  it('a third over-line miss after two real misses: no one is put through', () => {
    const one = say(started(), 'blah', false).session;
    const two = say(one, 'no the other one', false);
    expect(promptOf(two)).toBe('nomatch_dtmf_menu');
    expectSetAside(say(two.session, 'right over there', true), two.session);
    const taken = say(two.session, 'right over there', false);
    expect(taken.decision).toMatchObject({ kind: 'handoff', reason: 'max-attempts' });
  });

  it("at a slot's question: words that give the slot nothing are not re-asked", () => {
    const asked = atPlace();
    expect(asked.promptedFor).toBe('place');
    expectSetAside(say(asked, 'at', true), asked);
    const taken = say(asked, 'at', false);
    expect(promptOf(taken)).toBe('ask_place_retry');
    expect(taken.session.slots.place?.attempts).toBe(1);
  });

  it('at the summary: words that answer it neither way are not counted', () => {
    const summary = atSummary();
    expect(promptOf(summary)).toBe('confirm_report');
    expectSetAside(say(summary.session, 'hang on a sec', true), summary.session);
    const taken = say(summary.session, 'hang on a sec', false);
    expect(taken.session.pendingConfirmation).toMatchObject({ target: 'form', attempts: 1 });
  });

  it('a frustration-only turn caught: no acknowledgement and the question again, nothing kept of it', () => {
    const asked = atPlace();
    expectSetAside(say(asked, 'oh come on this thing', true, HIGH), asked);
    const taken = say(asked, 'oh come on this thing', false, HIGH);
    expect(taken.decision).toMatchObject({ kind: 'prompt', acks: [{ promptId: 'ack_frustration', vars: {} }] });
    expect(taken.session.frustratedTurns).toBe(1);
  });

  it("a topic slot's not-found reply (a question nothing answers)", () => {
    const base = placeApp();
    const notFound: SlotSpec = {
      ...base.slots.place!,
      fill: (_a, ctx) => (/street/i.test(ctx.text)
        ? { kind: 'filled', value: ctx.text, display: ctx.text, confidence: 0.95, confirm: 'none' }
        : { kind: 'invalid', reason: 'unanswered', raw: ctx.text, notFound: true }),
    };
    resetAppsForTest();
    registerApp(placeApp({ slots: { place: notFound } }));
    registerTestkit();
    const asked = atPlace();
    expectSetAside(say(asked, 'do you sell gift cards', true), asked);
    const taken = say(asked, 'do you sell gift cards', false);
    expect(promptOf(taken)).toBe('ask_place_retry');
  });

  it('the barge-in marker goes with a turn set aside, as with side speech: it is not reported on a later turn', () => {
    const asked = resolve(atPlace(), interruptEvent('Where is', 400), null, tc()).session;
    expect(asked.lastInterrupt).not.toBeNull();
    const r = say(asked, 'at', true);
    expect(r.setAside).toBe('speech-over-line');
    expect(r.session).toEqual({ ...asked, lastInterrupt: null });
  });
});

describe('speech over a line that answers is acted on', () => {
  it('a request at the open question', () => {
    const r = say(started(), 'i want to report a problem', true, REPORT);
    expect(r.setAside).toBeUndefined();
    expect(r.session.form).toBe('report');
    expect(promptOf(r)).toBe('ask_place');
  });

  it("a value at a slot's question", () => {
    const r = say(atPlace(), '22 Alder Street', true);
    expect(r.setAside).toBeUndefined();
    expect(r.session.slots.place?.value).toBe('22 Alder Street');
  });

  it('a yes at the summary', () => {
    const r = say(atSummary().session, 'yes', true, { confirmsYes: noul(0.95) });
    expect(r.setAside).toBeUndefined();
    expect(r.session.completed).toEqual(['report']);
  });

  it('a correction at the summary, with a no and without one: taken', () => {
    const summary = atSummary().session;
    const no = say(summary, 'no, 14 Birch Lane', true, { confirmsNo: noul(0.95) });
    expect(no.setAside).toBeUndefined();
    expect(no.session.slots.place?.value).toBe('no, 14 Birch Lane');
    const bare = say(summary, 'it is 14 Birch Lane', true);
    expect(bare.setAside).toBeUndefined();
    expect(bare.session.slots.place?.value).toBe('it is 14 Birch Lane');
  });

  it('lines the summary hook says in answer are a reply, never a miss', () => {
    const base = placeApp();
    resetAppsForTest();
    registerApp(placeApp({ forms: { report: { ...base.forms.report!, onSummaryAnswer: () => ({ moved: false, acks: [{ promptId: 'reported', vars: {} }] }) } } }));
    registerTestkit();
    const r = say(atSummary().session, 'what about the other one', true);
    expect(r.setAside).toBeUndefined();
    expect(r.decision).toMatchObject({ kind: 'prompt', acks: [{ promptId: 'reported', vars: {} }] });
  });

  it('a request for a person', () => {
    const r = say(started(), 'agent please', true, { wantsHuman: noul(0.95) });
    expect(r.setAside).toBeUndefined();
    expect(r.decision).toMatchObject({ kind: 'handoff', reason: 'live-agent' });
  });

  it('a request to hear it again', () => {
    const r = say(started(), 'can you say that again', true, { intent: choice({ repeat_prompt: 0.95, none: 0.05 }) });
    expect(r.setAside).toBeUndefined();
    expect(r.decision.kind).toBe('replay');
  });

  it('side speech is side speech, as before: its own row decides', () => {
    const r = say(started(), 'honey grab my coat', true, { addressedToSystem: noul(0.1) });
    expect(r.decision.kind).toBe('ignore');
    expect(r.setAside).toBeUndefined();
    expect(r.rows.find((g) => g.decided)?.gate).toBe('addressedToSystem');
  });
});

describe('at the code prompt', () => {
  // The test kit first: the tools a turn gets (demoTools) are the default app's systems.
  beforeEach(() => {
    resetAppsForTest();
    registerTestkit();
    registerApp(placeApp());
  });
  const ANSWERING = choice({ answering: 0.95, adding: 0.03, replacing: 0.02 });
  const ID_TEXT = 'five five five zero one two three four';
  const atCode = (): Session => {
    let s = started(testkitApp.id);
    s = say(s, 'where is my parcel', false, { intent: choice({ track_parcel: 0.95, none: 0.05 }) }).session;
    s = say(s, ID_TEXT, false, { intentChange: ANSWERING, containsAccountId: noul(0.95), accountIdComplete: noul(0.95), accountIdSpan: choice({ [ID_TEXT]: 0.9, none: 0.1 }) }).session;
    s = say(s, 'april twelfth nineteen eighty five', false, { intentChange: ANSWERING, dobGiven: noul(0.95), dobMonth: choice({ april: 0.9 }), dobDay: choice({ '12': 0.9 }), dobYear: choice({ 'nineteen eighty five': 0.9, none: 0.1 }) }).session;
    expect(s.promptedFor).toBe('otp');
    return s;
  };

  it('a code said aloud at the last rung is a code said: the call goes to a person, as ever, never set aside', () => {
    const last = { ...atCode(), codeReasks: 2 };
    const r = say(last, `it's ${CODE_MASK}`, true, { intentChange: ANSWERING });
    expect(r.setAside).toBeUndefined();
    expect(r.decision).toMatchObject({ kind: 'handoff', reason: 'max-attempts' });
    expect(r.audit.length).toBeGreaterThan(0);
  });

  it('a code said aloud earlier: a fresh code is sent, never set aside', () => {
    const r = say(atCode(), `it's ${CODE_MASK}`, true, { intentChange: ANSWERING });
    expect(r.setAside).toBeUndefined();
    expect(r.gateEvents.length).toBeGreaterThan(0);
  });

  it('other words over the code prompt are a miss, set aside', () => {
    const last = { ...atCode(), codeReasks: 2 };
    expectSetAside(say(last, 'hold on a second', true, { intentChange: ANSWERING }), last);
  });
});

describe('at an offer (the number the caller is calling from)', () => {
  const TODAY = '2026-10-07';
  const stub = (): JevClient => new FixtureStubClient(loadCorpus(join(CALLBACK_DIR, 'fixtures', 'corpus.jsonl')), { sharpness: DEFAULT_THRESHOLDS.STUB_SHARPNESS, fallback: new HeuristicStubClient({ todayIso: TODAY }) });
  const opts = () => ({ client: stub(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, now: () => 0 });

  async function atOffer(): Promise<Session> {
    resetAppsForTest();
    registerApp(callbackApp);
    const scenario: Scenario = { id: 'offer', steps: [{ say: 'can someone call me back' }, { say: 'Jordan Avery' }], expect: { decision: 'any' }, callerNumber: '+15555550142' };
    const run = await runScenario(scenario, opts());
    const s = run.runs.at(-1)!.result.session;
    expect(s.pendingConfirmation).toMatchObject({ target: 'slot', slot: 'phone', offered: true });
    return s;
  }

  it('a yes is taken', async () => {
    const r = (await runTurn(await atOffer(), { ...speechEvent('yes'), overLine: true }, opts())).result;
    expect(r.setAside).toBeUndefined();
    expect(r.session.slots.phone?.value).toBe('5555550142');
  });

  it('words that answer it neither way are set aside, the offer standing', async () => {
    const s = await atOffer();
    const r = (await runTurn(s, { ...speechEvent('um'), overLine: true }, opts())).result;
    expect(r.setAside).toBe('speech-over-line');
    expect(r.session.pendingConfirmation).toEqual(s.pendingConfirmation);
  });
});

describe('a joined turn (run/continuation.ts)', () => {
  const opts = () => ({ client: placeClient(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-11-05', now: () => 0 });

  it("set aside, it returns the session it was given, after the first fragment's turn the caller heard, not the one before it", async () => {
    const continuation = new Continuation(300);
    let s = (await continuation.run(newSession('s', 0, VOICE_RELAY, ANONYMOUS, PLACE_APP_ID), startEvent(), opts())).result.session;
    s = (await continuation.run(s, speechEvent('i want to report a problem'), opts())).result.session;
    // "at", taken: the re-ask said, an attempt counted; the caller cuts it at once.
    const at = await continuation.run(s, speechEvent('at'), opts());
    expect(promptOf(at.result)).toBe('ask_place_retry');
    s = (await continuation.run(at.result.session, interruptEvent('Sorry,', 120), opts())).result.session;
    const joined = await continuation.run(s, { ...speechEvent('um'), overLine: true }, opts());
    expect(joined.joined).toEqual(['at', 'um']);
    expect(joined.result.setAside).toBe('speech-over-line');
    expect(joined.result.session).toEqual({ ...s, lastInterrupt: null });
    expect(joined.result.session.slots.place?.attempts).toBe(1);
    expect(joined.record.slots.place?.attempts).toBe(1);
  });

  it('a turn set aside is never continued: the prompt after it is its own', async () => {
    const continuation = new Continuation(300);
    let s = (await continuation.run(newSession('s', 0, VOICE_RELAY, ANONYMOUS, PLACE_APP_ID), startEvent(), opts())).result.session;
    s = (await continuation.run(s, speechEvent('i want to report a problem'), opts())).result.session;
    const aside = await continuation.run(s, { ...speechEvent('at'), overLine: true }, opts());
    expect(aside.result.setAside).toBe('speech-over-line');
    continuation.resumed();
    expect(continuation.continuing).toBe(false);
    const next = await continuation.run(aside.result.session, speechEvent('22 Alder Street.'), opts());
    expect(next.joined).toBeNull();
    expect(next.result.session.slots.place?.value).toBe('22 Alder Street.');
  });
});
