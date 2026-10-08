import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { runScenario, type Scenario, type ScenarioRun } from '../harness-text/runner';
import { loadCorpus } from '../jev/corpus';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import type { JevClient, JevRequest } from '../jev/types';
import { registerApp, resetAppsForTest } from './app/registry';
import type { App } from './app/types';
import { DEFAULT_THRESHOLDS } from './thresholds';
import type { TurnResult } from './turn';
import { defineSlot, SlotConfigError } from '../slots/defineSlot';
import { TEXTING_DIR, textingApp } from '../testing/texting/app';
import { textingVariants, YES_NO, YES_NO_ASKS } from '../testing/texting/variant';
import { PROPOSALS_DIR, proposalsApp } from '../testing/proposals/app';
import { both, GREETING, proposalsVariants, replace } from '../testing/proposals/variant';

/**
 * The answers an offer takes (design 2026-10-08-offer-answers-and-consent, item 1): `answers:
 * yes-no-or-value` (the default, as before) or `yes-no`, on the caller's number's offer
 * (`callerNumber.answers`) and on a proposal from the facts (`offerAnswers`). With `yes-no` the slot
 * offered takes no value from the turn at its offer; a value said there with no clear yes is a no, and
 * on the keypad 1 is yes and 2 is no. On the texting fixture's variants (src/testing/texting) and the
 * proposals fixture's (src/testing/proposals).
 */

const TODAY = '2026-10-08';
const MOBILE = '+15555550142';
const OPENER = ["I'd like to open a request", "it's about an order"] as const;
const REPORT = "I'd like to report a problem";
const ON_FILE = '+15555550142';

const texting = textingVariants();
const proposals = proposalsVariants();
afterAll(() => {
  texting.remove();
  proposals.remove();
});
const yesNo = texting.variant(YES_NO);
const yesNoAsks = texting.variant(YES_NO_ASKS);
/** The proposal of the address takes a yes or a no only. */
const YES_NO_PLACE = replace('  offer: facts\n', '  offer: facts\n  offerAnswers: yes-no\n');
const placeYesNo = proposals.variant({ 'app.yaml': replace('id: proposals', 'id: proposals-yes-no'), 'slots.yaml': YES_NO_PLACE });
const greetingYesNo = proposals.variant({ ...GREETING, 'app.yaml': replace('id: proposals', 'id: proposals-greeting-yes-no'), 'slots.yaml': both(GREETING['slots.yaml']!, YES_NO_PLACE) });

const textingCorpus = loadCorpus(join(TEXTING_DIR, 'fixtures', 'corpus.jsonl'), textingApp);
const proposalsCorpus = loadCorpus(join(PROPOSALS_DIR, 'fixtures', 'corpus.jsonl'), proposalsApp);
const greetingCorpus = loadCorpus(join(proposals.dirOf(greetingYesNo), 'fixtures', 'corpus.jsonl'), greetingYesNo);

function stub(corpus: ReturnType<typeof loadCorpus>, asked: JevRequest[] = []): JevClient {
  const inner = new FixtureStubClient(corpus, { sharpness: DEFAULT_THRESHOLDS.STUB_SHARPNESS, fallback: new HeuristicStubClient({ todayIso: TODAY }) });
  return { ask: (req) => { asked.push(req); return inner.ask(req); } };
}

function use(app: App): void {
  resetAppsForTest();
  registerApp(app);
}

beforeEach(() => use(yesNo));

/** A call from `callerNumber`: the greeting, then each step in turn. */
async function call(callerNumber: string, corpus: ReturnType<typeof loadCorpus>, steps: Scenario['steps'], asked?: JevRequest[]): Promise<ScenarioRun> {
  return runScenario({ id: 'call', callerNumber, steps, expect: { decision: 'any' } }, { client: stub(corpus, asked), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, now: () => 0 });
}
const says = (...lines: string[]): Scenario['steps'] => lines.map((say) => ({ say }));
const text = (...steps: Scenario['steps']): Promise<ScenarioRun> => call(MOBILE, textingCorpus, steps);

const last = (r: ScenarioRun): TurnResult => r.runs.at(-1)!.result;
const promptOf = (t: TurnResult): string | undefined => ('promptId' in t.decision ? t.decision.promptId : undefined);
const prompts = (r: ScenarioRun): (string | undefined)[] => r.runs.map((x) => promptOf(x.result));
const gates = (r: ScenarioRun): string[] => r.runs.flatMap((x) => x.result.gateEvents.map((e) => `${e.decision.call.tool}:${e.decision.verdict}`));
const offers = (r: ScenarioRun) => r.runs.flatMap((x) => x.result.audit.filter((d) => d.type === 'offer').map((d) => d.detail));

describe('answers on the caller\'s number\'s offer', () => {
  it('is carried onto the slot only when it is yes-no: the default is as before', () => {
    expect(yesNo.slots.textTo!.callerNumber!.answers).toBe('yes-no');
    expect(textingApp.slots.textTo!.callerNumber!.answers).toBeUndefined();
    const spec = (answers?: string) => defineSlot('phone', { type: 'digits', noun: 'phone', length: 10, callerNumber: { countryCode: '1', ...(answers !== undefined ? { answers } : {}) } });
    expect(spec('yes-no-or-value').callerNumber!.answers).toBeUndefined();
    expect(spec().callerNumber!.answers).toBeUndefined();
    expect(() => spec('digits')).toThrow(SlotConfigError);
  });

  it('makes the same offer, with yes and no its options, and asks the model what a default offer asks', async () => {
    const askedYesNo: JevRequest[] = [];
    const askedDefault: JevRequest[] = [];
    const steps = says(...OPENER, 'hmm, which one');
    const r = await call(MOBILE, textingCorpus, steps, askedYesNo);
    use(textingApp);
    await call(MOBILE, textingCorpus, steps, askedDefault);
    expect(last(r).decision).toMatchObject({ kind: 'prompt', promptId: 'offer_textTo', target: 'textTo', vars: { last4: '0142' }, options: ['yes', 'no'] });
    expect(JSON.stringify(askedYesNo)).toBe(JSON.stringify(askedDefault));
    // Asked again, and not settled.
    expect(offers(r)).toEqual([]);
  });

  it('a yes fills the slot with the number, as before', async () => {
    const r = await text(...says(...OPENER, 'yes, please text me'));
    expect(last(r).session.slots.textTo).toMatchObject({ value: '5555550142', confirmed: true });
    expect(offers(r).map((d) => d.answer)).toEqual(['yes']);
  });

  it('a number said with the no is not taken: the no follows onNo (skip), and the audit says no', async () => {
    const r = await text(...says(...OPENER, 'no, text my cell, five five five five five five zero one nine nine'));
    const t = last(r);
    expect(t.session.slots.textTo).toMatchObject({ value: null, declined: true, attempts: 0 });
    expect(promptOf(t)).toBe('confirm_open_request');
    expect(offers(r)).toMatchObject([{ answer: 'no', by: 'speech' }]);
    // No fill row for the number: the slot took nothing.
    expect(r.runs.at(-1)!.result.fillEvents.map((e) => e.slot)).not.toContain('textTo');
  });

  it('a number said with neither a yes nor a no is a no', async () => {
    const r = await text(...says(...OPENER, 'text five five five five five five zero one nine nine instead'));
    expect(last(r).session.slots.textTo).toMatchObject({ value: null, declined: true });
    expect(promptOf(last(r))).toBe('confirm_open_request');
    expect(offers(r).map((d) => d.answer)).toEqual(['no']);
  });

  it('with onNo ask, the no asks the slot\'s own question, with no attempt counted and the number not taken', async () => {
    use(yesNoAsks);
    for (const said of ['no, text my cell, five five five five five five zero one nine nine', 'text five five five five five five zero one nine nine instead', 'no thanks']) {
      const r = await text(...says(...OPENER, said));
      const t = last(r);
      expect(promptOf(t), said).toBe('ask_textTo');
      expect(t.session.slots.textTo, said).toMatchObject({ value: null, attempts: 0 });
      expect(t.session.slots.textTo!.declined, said).toBeUndefined();
      expect(offers(r).map((d) => d.answer), said).toEqual(['no']);
    }
    // And the slot's question, once asked, takes the number as any slot does.
    const t = last(await text(...says(...OPENER, 'no thanks', 'five five five five five five zero one nine nine')));
    expect(t.session.slots.textTo).toMatchObject({ value: '5555550199' });
  });

  it('on the keypad, a 1 alone is yes and a 2 alone is no, once the keys stop or with #', async () => {
    // Each key is its own turn: the first is held, and nothing is settled until the keys stop (the
    // no-input wait, shortened after a key: a silence turn) or # ends them.
    for (const keys of [[{ dtmf: '1' }, { silence: true }], [{ dtmf: '1#' }]] as Scenario['steps'][]) {
      const one = await text(...says(...OPENER), ...keys);
      expect(prompts(one).slice(3), JSON.stringify(keys)).toEqual([undefined, 'confirm_open_request_text']);
      expect(last(one).session.slots.textTo).toMatchObject({ value: '5555550142', confirmed: true });
      expect(offers(one)).toMatchObject([{ answer: 'yes', by: 'keypad' }]);
      expect(gates(one)).toEqual(['findCallerByPhone:ALLOW']);
    }
    const two = await text(...says(...OPENER), { dtmf: '2' }, { silence: true });
    expect(prompts(two).slice(3)).toEqual([undefined, 'confirm_open_request']);
    expect(last(two).session.slots.textTo).toMatchObject({ value: null, declined: true });
    expect(offers(two)).toMatchObject([{ answer: 'no', by: 'keypad' }]);
    expect(gates(two)).toEqual(['findCallerByPhone:ALLOW']);
    const five = await text(...says(...OPENER), { dtmf: '5' }, { silence: true });
    expect(prompts(five).slice(3)).toEqual([undefined, 'offer_textTo']);
    expect(last(five).session.slots.textTo).toMatchObject({ value: null, attempts: 1 });
    expect(offers(five)).toEqual([]);
  });

  it('a number keyed at the offer is one answer to neither: asked again once, nothing recorded, and no key spills into the next question', async () => {
    for (const keys of [[{ dtmf: '2125550199' }, { silence: true }], [{ dtmf: '2125550199#' }]] as Scenario['steps'][]) {
      const r = await text(...says(...OPENER), ...keys);
      const keyed = r.runs.slice(3);
      // Every key but the last turn is held; the last turn asks the offer once more.
      expect(keyed.slice(0, -1).every((x) => x.result.decision.kind === 'ignore'), JSON.stringify(keys)).toBe(true);
      expect(promptOf(last(r)), JSON.stringify(keys)).toBe('offer_textTo');
      expect(last(r).session.slots.textTo).toMatchObject({ value: null, attempts: 1 });
      expect(last(r).session.dtmfBuffer).toBe('');
      expect(offers(r)).toEqual([]);
      expect(gates(r)).toEqual(['findCallerByPhone:ALLOW']);
      expect(r.runs.flatMap((x) => x.result.audit.map((d) => d.type))).not.toContain('offer');
    }
    // The offer asked again takes its answer as before.
    const then = await text(...says(...OPENER), { dtmf: '2125550199' }, { silence: true }, { dtmf: '1' }, { silence: true });
    expect(promptOf(last(then))).toBe('confirm_open_request_text');
    expect(offers(then)).toMatchObject([{ answer: 'yes', by: 'keypad' }]);
  });

  it('the default takes a number said or keyed at the offer, as before', async () => {
    use(textingApp);
    const said = await text(...says(...OPENER, 'no, text my cell, five five five five five five zero one nine nine'));
    expect(last(said).session.slots.textTo!.value).toBe('5555550199');
    expect(offers(said).map((d) => d.answer)).toEqual(['other']);
    const keyed = await text(...says(...OPENER), { dtmf: '5555550199' });
    expect(last(keyed).session.slots.textTo!.value).toBe('5555550199');
  });
});

describe('offerAnswers on a proposal from the facts', () => {
  beforeEach(() => use(placeYesNo));
  const report = (...steps: Scenario['steps']): Promise<ScenarioRun> => call(ON_FILE, proposalsCorpus, steps);

  it('is carried onto the slot as written, and is absent by default', () => {
    expect(placeYesNo.slots.place!.offerAnswers).toBe('yes-no');
    expect(proposalsApp.slots.place!.offerAnswers).toBeUndefined();
    expect(defineSlot('place', { type: 'text', what: 'an address', offer: 'facts', offerAnswers: 'yes-no-or-value' }).offerAnswers).toBe('yes-no-or-value');
    expect(() => defineSlot('place', { type: 'text', what: 'an address', offer: 'facts', offerAnswers: 'maybe' })).toThrow(SlotConfigError);
  });

  it('an address said with the no, or in place of a yes or no, is a no: the slot\'s question is asked', async () => {
    for (const said of ["no, I'm at my mother's, 7 Birch Lane", "it's at 7 Birch Lane"]) {
      const r = await report(...says(REPORT, said));
      expect(promptOf(last(r)), said).toBe('ask_place');
      expect(last(r).session.slots.place, said).toMatchObject({ value: null, attempts: 0 });
      expect(offers(r).map((d) => d.answer), said).toEqual(['no']);
    }
  });

  it('a yes fills the slot with the proposal, as before', async () => {
    const t = last(await report(...says(REPORT, 'yes')));
    expect(t.session.slots.place).toMatchObject({ value: '22 Alder Street', confirmed: true });
  });

  it('at the greeting: a value said is a no, and the keypad\'s 1 is yes', async () => {
    use(greetingYesNo);
    const said = await call(ON_FILE, greetingCorpus, says("it's at 7 Birch Lane"));
    expect(prompts(said)).toEqual(['offer_place', 'greet_after_offer']);
    expect(last(said).session.slots.place!.value).toBeNull();
    expect(offers(said).map((d) => d.answer)).toEqual(['no']);
    const no = await call(ON_FILE, greetingCorpus, says("no, I'm at my mother's, 7 Birch Lane"));
    expect(last(no).session.slots.place!.value).toBeNull();
    expect(offers(no).map((d) => d.answer)).toEqual(['no']);
    const one = await call(ON_FILE, greetingCorpus, [{ dtmf: '1' }, { silence: true }]);
    expect(prompts(one)).toEqual(['offer_place', undefined, 'greet_after_offer']);
    expect(last(one).session.slots.place).toMatchObject({ value: '22 Alder Street', confirmed: true });
    expect(offers(one)).toMatchObject([{ answer: 'yes', by: 'keypad' }]);
    const two = await call(ON_FILE, greetingCorpus, [{ dtmf: '2#' }]);
    expect(prompts(two)).toEqual(['offer_place', undefined, 'greet_after_offer']);
    expect(offers(two)).toMatchObject([{ answer: 'no', by: 'keypad' }]);
  });
});
