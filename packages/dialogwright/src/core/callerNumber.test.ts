import { beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { loadScenarios, runScenario, type Scenario, type ScenarioRun } from '../harness-text/runner';
import { loadCorpus } from '../jev/corpus';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import type { JevClient, JevRequest } from '../jev/types';
import { spokenText } from '../prompts/render';
import { registerApp, resetAppsForTest } from './app/registry';
import type { App } from './app/types';
import { DEFAULT_THRESHOLDS } from './thresholds';
import { newSession } from './session';
import { resolve, type TurnContext, type TurnResult } from './turn';
import { startEvent, withCallerNumber } from '../channel/events';
import { VOICE_RELAY } from '../channel/caps';
import { mockCodeVerifier } from './tools';
import { CALLBACK_DIR, callbackApp } from '../testing/callback/app';
import { SCREENED_DIR, ScreenedSystems, screenedApp } from '../testing/screened/app';
import { callerCandidate, callerDigits, callerNumberOf, keptCallerNumber, lastFour, usesCallerNumber, WITHHELD_PLACEHOLDERS } from './callerNumber';
import { redactRecordSlots } from '../trace/redact';
import { redactRecord } from '../server/dashboard/events';

/**
 * The number the caller is calling from, offered for a slot that holds a phone number (a digits
 * slot's `callerNumber`, core/callerNumber.ts), on the engine's fixture for it: Example Callbacks
 * (src/testing/callback), one form that asks a name, a callback number and what the call is about,
 * and reads all three back. The calls run through the harness with the fixture's corpus behind the
 * stub, as a regression run does.
 */

const TODAY = '2026-10-07';
const FIXTURES = join(CALLBACK_DIR, 'fixtures');
resetAppsForTest();
registerApp(callbackApp);
const corpus = loadCorpus(join(FIXTURES, 'corpus.jsonl'));

/** The fixture stub, each request it was asked kept in `asked`. */
function stub(asked: JevRequest[] = [], app: App = callbackApp, file = join(FIXTURES, 'corpus.jsonl')): JevClient {
  const inner = new FixtureStubClient(app === callbackApp ? corpus : loadCorpus(file), { sharpness: DEFAULT_THRESHOLDS.STUB_SHARPNESS, fallback: new HeuristicStubClient({ todayIso: TODAY }) });
  return { ask: (req) => { asked.push(req); return inner.ask(req); } };
}

function use(app: App): void {
  resetAppsForTest();
  registerApp(app);
}

beforeEach(() => use(callbackApp));

const CALLING_FROM = '+15555550142';
const OPENER = ['can someone call me back', 'Jordan Avery'] as const;

/** A call: the greeting, then each line said in turn; from `callerNumber` when given, as a carrier sends it. */
async function call(callerNumber: string | undefined, ...says: string[]): Promise<ScenarioRun> {
  const scenario: Scenario = { id: 'call', steps: says.map((say) => ({ say })), expect: { decision: 'any' }, ...(callerNumber !== undefined ? { callerNumber } : {}) };
  return runScenario(scenario, { client: stub(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, now: () => 0 });
}

const last = (r: ScenarioRun): TurnResult => r.runs.at(-1)!.result;
const heard = (t: TurnResult): string => spokenText(callbackApp, t.decision);
const promptOf = (t: TurnResult): string | undefined => ('promptId' in t.decision ? t.decision.promptId : undefined);

const OFFER = "Is the number you're calling from, ending in 0142, the best one to reach you?";
const ASK_PHONE = "What's the best number to reach you?";
const ASK_REASON = 'And what is the call about, an order, a bill, or something else?';

describe('the number a carrier sends', () => {
  it('is its digits, however it is written', () => {
    expect(callerDigits('+15555550142')).toBe('15555550142');
    expect(callerDigits(' +1 (555) 555-0142 ')).toBe('15555550142');
    expect(callerDigits('555.555.0142')).toBe('5555550142');
  });

  it('is no number when absent, empty, a word or anything that is not a number', () => {
    for (const raw of [null, undefined, '', '   ', 'anonymous', 'Anonymous', 'unknown', 'restricted', 'private', 'sip:caller@example.com', 'client:jordan', '+1555abc0142']) {
      expect(callerDigits(raw), String(raw)).toBeNull();
    }
  });

  it('is no number when it is one of the withheld placeholders, with or without a country code', () => {
    expect(WITHHELD_PLACEHOLDERS).toEqual(['266696687', '7378742833', '86282452253', '2562533']);
    for (const p of WITHHELD_PLACEHOLDERS) {
      expect(callerDigits(`+${p}`), p).toBeNull();
      expect(callerDigits(`+1${p}`), `1${p}`).toBeNull();
    }
  });

  it('gives a slot its value and display: the country code taken off when the rest has the length, the mask held', () => {
    expect(callerCandidate(callbackApp, 'phone', '15555550142')).toEqual({ value: '5555550142', display: '555 555 0142' });
    expect(callerCandidate(callbackApp, 'phone', '5555550142')).toEqual({ value: '5555550142', display: '555 555 0142' });
    // Another country's number, a short one, and one the mask refuses (a leading 1 after the country code).
    expect(callerCandidate(callbackApp, 'phone', '445555550142')).toBeNull();
    expect(callerCandidate(callbackApp, 'phone', '5550142')).toBeNull();
    expect(callerCandidate(callbackApp, 'phone', '11555550142')).toBeNull();
    // A slot that does not offer it.
    expect(callerCandidate(callbackApp, 'reason', '15555550142')).toBeNull();
  });

  it('holds a number in international form to the slot\'s country code: another country\'s is no number, whatever its length', () => {
    expect(callerNumberOf('+15555550142')).toBe('+15555550142');
    expect(callerNumberOf(' +1 (555) 555-0142 ')).toBe('+15555550142');
    expect(callerNumberOf('5555550142')).toBe('5555550142');
    expect(callerNumberOf('anonymous')).toBeNull();
    expect(callerCandidate(callbackApp, 'phone', '+15555550142')).toEqual({ value: '5555550142', display: '555 555 0142' });
    // Ten digits from another country (+354, seven digits after it): with no + they would fit the
    // mask; in international form they are no number for a slot whose country code is 1.
    expect(callerCandidate(callbackApp, 'phone', '+3545550142')).toBeNull();
    expect(callerCandidate(callbackApp, 'phone', '3545550142')).toEqual({ value: '3545550142', display: '354 555 0142' });
    expect(keptCallerNumber(callbackApp, '+3545550142')).toBeUndefined();
    // A +1 number with a digit too many or too few.
    expect(callerCandidate(callbackApp, 'phone', '+155555501420')).toBeNull();
    expect(callerCandidate(callbackApp, 'phone', '+1555555014')).toBeNull();
  });

  it('refuses RESTRICTED, which fits a ten-digit phone mask, by the placeholder list and not by the mask', () => {
    // The mask alone would take it: ten digits, the first 2 to 9.
    expect(/^[2-9]\d{9}$/.test('7378742833')).toBe(true);
    expect(callerCandidate(callbackApp, 'phone', '7378742833')).toBeNull();
    expect(keptCallerNumber(callbackApp, '+7378742833')).toBeUndefined();
    expect(keptCallerNumber(callbackApp, `+1${WITHHELD_PLACEHOLDERS[1]}`)).toBeUndefined();
  });

  it('is kept only by an app with a slot that offers it, and only when a slot can use it', () => {
    expect(usesCallerNumber(callbackApp)).toBe(true);
    expect(usesCallerNumber(screenedApp)).toBe(false);
    expect(keptCallerNumber(callbackApp, CALLING_FROM)).toBe('+15555550142');
    expect(keptCallerNumber(screenedApp, CALLING_FROM)).toBeUndefined();
    expect(keptCallerNumber(callbackApp, '+445555550142')).toBeUndefined();
    expect(keptCallerNumber(callbackApp, undefined)).toBeUndefined();
    expect(lastFour('555 555 0142')).toBe('0142');
  });
});

describe('the offer', () => {
  it('takes the place of the slot\'s question, by the last four digits, with the slot still empty', async () => {
    const t = last(await call(CALLING_FROM, ...OPENER));
    expect(t.decision).toMatchObject({ kind: 'prompt', promptId: 'offer_phone', target: 'phone', vars: { last4: '0142' }, options: ['yes', 'no'] });
    expect(heard(t)).toBe(OFFER);
    expect(t.session.slots.phone).toMatchObject({ value: null, confirmed: false, attempts: 0 });
    expect(t.session.pendingConfirmation).toEqual({ target: 'slot', slot: 'phone', value: '5555550142', display: '555 555 0142', offered: true });
    expect(t.session.callerOffered).toEqual(['phone']);
  });

  it('tells the model only what the caller heard: the last four, never the whole number', async () => {
    const asked: JevRequest[] = [];
    await runScenario({ id: 'call', callerNumber: CALLING_FROM, steps: [...OPENER, "yes, that's fine"].map((say) => ({ say })), expect: { decision: 'any' } }, { client: stub(asked), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, now: () => 0 });
    const atOffer = asked.at(-1)!;
    expect((atOffer.state as { pendingConfirmation: unknown }).pendingConfirmation).toEqual({ target: 'phone', value: 'the number they are calling from, ending in 0142' });
    for (const req of asked) expect(JSON.stringify(req)).not.toContain('5555550142');
  });

  it('a yes fills the slot with the number, confirmed, and the form goes on', async () => {
    const t = last(await call(CALLING_FROM, ...OPENER, "yes, that's fine"));
    expect(heard(t)).toBe(ASK_REASON);
    expect(t.session.slots.phone).toMatchObject({ value: '5555550142', display: '555 555 0142', confirmed: true, attempts: 0 });
    expect(t.session.pendingConfirmation).toBeNull();
  });

  it('a no asks the slot\'s own question, with no attempt counted', async () => {
    const t = last(await call(CALLING_FROM, ...OPENER, 'no'));
    expect(t.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_phone', target: 'phone' });
    expect(heard(t)).toBe(ASK_PHONE);
    expect(t.session.slots.phone).toMatchObject({ value: null, attempts: 0 });
    expect(t.session.pendingConfirmation).toBeNull();
  });

  it('a no with a number fills the number said, and the form goes on', async () => {
    const t = last(await call(CALLING_FROM, ...OPENER, 'no, use my cell, five five five five five five zero one nine nine'));
    expect(heard(t)).toBe(ASK_REASON);
    expect(t.session.slots.phone).toMatchObject({ value: '5555550199', display: '555 555 0199' });
    expect(t.session.pendingConfirmation).toBeNull();
  });

  it('a number said with no yes or no answers the slot and closes the offer', async () => {
    const t = last(await call(CALLING_FROM, ...OPENER, 'my cell is five five five five five five zero one nine nine'));
    expect(heard(t)).toBe(ASK_REASON);
    expect(t.session.slots.phone).toMatchObject({ value: '5555550199' });
    expect(t.session.pendingConfirmation).toBeNull();
  });

  it('words that answer neither re-ask the offer, as any read-back is re-asked, counting a turn', async () => {
    const t = last(await call(CALLING_FROM, ...OPENER, 'hmm, which one'));
    expect(promptOf(t)).toBe('offer_phone');
    expect(heard(t)).toBe(OFFER);
    expect(t.session.slots.phone!.attempts).toBe(1);
    expect(t.session.pendingConfirmation).toMatchObject({ target: 'slot', slot: 'phone', offered: true });
  });

  it('a yes that says more fills the rest of the form as well', async () => {
    const t = last(await call(CALLING_FROM, ...OPENER, "yes, and it's about an order"));
    expect(t.session.slots.phone).toMatchObject({ value: '5555550142', confirmed: true });
    expect(t.session.slots.reason).toMatchObject({ value: 'order' });
    expect(heard(t)).toBe('I have Jordan Avery, at 555 555 0142, about an order. Shall I set up the callback?');
  });

  it('a number of the wrong shape closes the offer and retries the slot\'s question, with or without a no', async () => {
    for (const said of ['use five five five', 'no, use five five five']) {
      const t = last(await call(CALLING_FROM, ...OPENER, said));
      expect(promptOf(t), said).toBe('ask_phone_retry');
      expect(t.session.slots.phone, said).toMatchObject({ value: null, attempts: 1 });
      expect(t.session.pendingConfirmation, said).toBeNull();
    }
  });

  it('silence re-asks the offer after the no-input line', async () => {
    const r = await runScenario({ id: 'call', callerNumber: CALLING_FROM, steps: [...OPENER.map((say) => ({ say })), { silence: true }], expect: { decision: 'any' } }, { client: stub(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, now: () => 0 });
    const t = last(r);
    expect(t.decision).toMatchObject({ kind: 'prompt', promptId: 'offer_phone', acks: [{ promptId: 'no_input', vars: {} }] });
  });

  it('a number keyed at the offer fills the slot as keyed', async () => {
    const r = await runScenario({ id: 'call', callerNumber: CALLING_FROM, steps: [...OPENER.map((say) => ({ say })), { dtmf: '5555550199' }], expect: { decision: 'any' } }, { client: stub(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, now: () => 0 });
    const t = last(r);
    expect(heard(t)).toBe(ASK_REASON);
    expect(t.session.slots.phone).toMatchObject({ value: '5555550199', confirmed: true });
    expect(t.session.pendingConfirmation).toBeNull();
  });

  it('the summary reads the whole number back after a yes', async () => {
    const t = last(await call(CALLING_FROM, ...OPENER, "yes, that's fine", "it's about an order"));
    expect(heard(t)).toBe('I have Jordan Avery, at 555 555 0142, about an order. Shall I set up the callback?');
  });

  it('is made once per form: a number reopened at the summary is asked, not offered again', async () => {
    const t = last(await call(CALLING_FROM, ...OPENER, "yes, that's fine", "it's about an order", 'no, the number is wrong'));
    expect(t.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_phone' });
    expect(t.session.slots.phone!.value).toBeNull();
    expect(t.session.pendingConfirmation).toBeNull();
  });

  it('is never made for a number given before the form reached it and reopened at the summary', async () => {
    const r = await call(CALLING_FROM, 'can someone call me back', 'Jordan Avery, call me at five five five five five five zero one nine nine', "it's about an order", 'no, the number is wrong', "actually it's about a bill");
    expect(r.runs.map((x) => promptOf(x.result))).not.toContain('offer_phone');
    const t = last(r);
    expect(promptOf(t)).toBe('ask_phone');
    expect(t.session.slots.reason!.value).toBe('bill');
  });

  it('the written callback carries the number the caller said yes to', async () => {
    const t = last(await call(CALLING_FROM, ...OPENER, "yes, that's fine", "it's about an order", 'yes, please'));
    expect(t.decision).toMatchObject({ kind: 'complete', promptId: 'callback_booked' });
    expect(t.gateEvents.map((e) => `${e.decision.call.tool}:${e.decision.verdict}`)).toEqual(['requestCallback:ALLOW']);
    // The gate event's call is the redacted copy: the number by its last four, as the slot masks it.
    expect(t.gateEvents[0]!.decision.call.params.phone).toBe('...0142');
  });
});

describe('no offer', () => {
  it('when the call has no number', async () => {
    expect(heard(last(await call(undefined, ...OPENER)))).toBe(ASK_PHONE);
  });

  it('when the number is withheld, or does not fit the slot', async () => {
    for (const from of ['+7378742833', '+266696687', 'anonymous', 'Restricted', '+', '', '+445555550142', '+3545550142', 'sip:caller@example.com']) {
      const t = last(await call(from, ...OPENER));
      expect(heard(t), from).toBe(ASK_PHONE);
      expect(t.session.callerNumber, from).toBeUndefined();
    }
  });

  it('on a chat, whatever the scenario says', async () => {
    const r = await runScenario({ id: 'chat', as: 'web', callerNumber: CALLING_FROM, steps: OPENER.map((say) => ({ say })), expect: { decision: 'any' } }, { client: stub(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, now: () => 0 });
    const t = last(r);
    expect(promptOf(t)).toBe('ask_phone');
    expect(t.session.callerNumber).toBeUndefined();
  });

  it('on an identity factor, even when its spec says it offers one', () => {
    const factorApp: App = { ...callbackApp, id: 'callback-factor', identity: { ...callbackApp.identity!, factorSlots: ['phone'] } } as App;
    expect(usesCallerNumber(factorApp)).toBe(false);
    expect(callerCandidate(factorApp, 'phone', '15555550142')).toBeNull();
  });
});

describe('the trace', () => {
  it('says on the start record whether the number was kept', async () => {
    expect((await call(CALLING_FROM)).runs[0]!.record.callerNumber).toBe('kept');
    expect((await call('+7378742833')).runs[0]!.record.callerNumber).toBe('none');
    expect((await call(undefined)).runs[0]!.record.callerNumber).toBe('none');
    // Only the start record.
    expect((await call(CALLING_FROM, ...OPENER)).runs.slice(1).every((r) => r.record.callerNumber === undefined)).toBe(true);
  });

  it('masks the number on the start event and the offer as the slot masks its value, in the file and on the console', async () => {
    const r = await call(CALLING_FROM, ...OPENER);
    for (const run of [r.runs[0]!, r.runs.at(-1)!]) {
      expect(JSON.stringify(redactRecordSlots(run.record, 'length'))).not.toContain('5555550142');
      expect(JSON.stringify(redactRecord(run.record))).not.toContain('5555550142');
    }
    expect(redactRecordSlots(r.runs[0]!.record, 'length').event).toMatchObject({ type: 'session.start', callerNumber: '...0142' });
    expect(redactRecord(r.runs[0]!.record).event).toMatchObject({ type: 'session.start', callerNumber: '…0142' });
    expect(redactRecordSlots(r.runs.at(-1)!.record, 'length').pendingConfirmation).toMatchObject({ value: '...0142', display: '...0142', offered: true });
  });
});

describe('an app without the option', () => {
  const screenedCorpus = join(SCREENED_DIR, 'fixtures', 'corpus.jsonl');
  const stamp = (r: ScenarioRun) => r.runs.map((x) => ({ ...x.record, ts: '', timing: null }));

  it('runs a call from a number exactly as one from none: the same requests, the same records', async () => {
    use(screenedApp);
    const steps = ["there's water in my basement", 'yes, I own it', 'Cedar Falls'].map((say) => ({ say }));
    const askedWith: JevRequest[] = [];
    const askedWithout: JevRequest[] = [];
    const opts = (asked: JevRequest[]) => ({ client: stub(asked, screenedApp, screenedCorpus), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, now: () => 0 });
    const withNumber = await runScenario({ id: 'call', callerNumber: CALLING_FROM, steps, expect: { decision: 'any' } }, opts(askedWith));
    const without = await runScenario({ id: 'call', steps, expect: { decision: 'any' } }, opts(askedWithout));
    expect(JSON.stringify(askedWith)).toBe(JSON.stringify(askedWithout));
    expect(JSON.stringify(stamp(withNumber))).toBe(JSON.stringify(stamp(without)));
    expect(JSON.stringify(withNumber.runs[0]!.record)).not.toContain('callerNumber');
  });

  it('keeps nothing of a number its start event carries anyway', () => {
    use(screenedApp);
    const tc: TurnContext = { nowMs: 0, todayIso: TODAY, thresholds: { ...DEFAULT_THRESHOLDS }, tools: { sys: new ScreenedSystems(), lookups: { ownerOf: () => null, scopeOf: () => [] }, codes: mockCodeVerifier } };
    const base = newSession('s', 0, VOICE_RELAY, undefined, 'screened');
    const a = resolve(base, withCallerNumber(startEvent(), CALLING_FROM), null, tc);
    const b = resolve(base, startEvent(), null, tc);
    expect(a.session).toEqual(b.session);
    expect('callerNumber' in a.session).toBe(false);
  });
});

describe('the fixture\'s scripted calls', () => {
  const scenarios: Scenario[] = loadScenarios(join(FIXTURES, 'scenarios'));
  it('has one for each case', () => {
    expect(scenarios.map((s) => s.id)).toEqual(['offer-yes', 'offer-no-then-said', 'offer-no-with-a-number', 'withheld-number-asks', 'no-number-asks', 'chat-asks', 'offer-required-no-then-nothing']);
  });
  it('a required offer (the defaults, onNo and ifNone ask): a no asks the slot, and with no number its ladder ends at a person, never the summary', async () => {
    const required = scenarios.find((s) => s.id === 'offer-required-no-then-nothing')!;
    const r = await runScenario(required, { client: stub(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, now: () => 0 });
    expect(r.runs.map((x) => ('promptId' in x.result.decision ? x.result.decision.promptId : x.result.decision.kind))).toEqual(['greeting', 'ask_caller', 'offer_phone', 'ask_phone', 'ask_phone', 'ask_phone_dtmf', 'handoff_max_attempts']);
    expect(r.runs.flatMap((x) => x.result.gateEvents)).toEqual([]);
  });
  for (const scenario of scenarios) {
    it(`${scenario.id} meets its expectation`, async () => {
      const r = await runScenario(scenario, { client: stub(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, now: () => 0 });
      expect(r.mismatches).toEqual([]);
      expect(r.pass).toBe(true);
    });
  }
});

