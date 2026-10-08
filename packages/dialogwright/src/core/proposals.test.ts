import { beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { loadScenarios, runScenario, type Scenario, type ScenarioRun } from '../harness-text/runner';
import { loadCorpus } from '../jev/corpus';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import type { JevClient, JevRequest } from '../jev/types';
import { spokenText } from '../prompts/render';
import { registerApp, resetAppsForTest } from './app/registry';
import { gateOf } from './app/lookup';
import type { App } from './app/types';
import { DEFAULT_THRESHOLDS } from './thresholds';
import type { TurnResult } from './turn';
import { compileGate } from '../gate/compiled';
import { factsCandidate, factsOfferSlots } from './factsOffer';
import { sessionRoundTrip } from '../testing/sessionRoundTrip';
import { PROPOSALS_DIR, ProposalSystems, proposalsApp, type ProposalFacts } from '../testing/proposals/app';
import { textingApp } from '../testing/texting/app';
import { callbackApp } from '../testing/callback/app';
import { screenedApp } from '../testing/screened/app';
import { testkitApp } from '../testing/testkit';
import { mockCodeVerifier } from './tools';
import { Continuation } from '../run/continuation';
import { newSession, type Session } from './session';
import { VOICE_RELAY } from '../channel/caps';
import { ANONYMOUS } from '../gate/principal';
import { redactRecordSlots } from '../trace/redact';
import { redactRecord } from '../server/dashboard/events';
import { interruptEvent, speechEvent, startEvent, withCallerNumber, type SessionEvent } from '../channel/events';

/**
 * A slot that proposes a value from the facts (`offer: facts`, FactsConfig.offers): the street the
 * call-start lookup found for the number calling, proposed for a report's address as a yes or no, on
 * the engine's fixture for it, Example Service Desk (src/testing/proposals). It reuses the offer of
 * the caller's number (the pending read-back with `offered`, the `offer` audit row, once per slot per
 * form), and it is a proposal, never identity: a yes fills that slot and nothing else.
 */

const TODAY = '2026-10-07';
const FIXTURES = join(PROPOSALS_DIR, 'fixtures');
const corpus = loadCorpus(join(FIXTURES, 'corpus.jsonl'), proposalsApp);

function stub(asked: JevRequest[] = []): JevClient {
  const inner = new FixtureStubClient(corpus, { sharpness: DEFAULT_THRESHOLDS.STUB_SHARPNESS, fallback: new HeuristicStubClient({ todayIso: TODAY }) });
  return { ask: (req) => { asked.push(req); return inner.ask(req); } };
}

function use(app: App): void {
  resetAppsForTest();
  registerApp(app);
}

beforeEach(() => use(proposalsApp));

/** On file: the street 22 Alder Street. */
const ON_FILE = '+15555550142';
/** Not on file. */
const NOT_ON_FILE = '+15555550199';
const REPORT = "I'd like to report a problem";
const OFFER = "I see an account for the number you're calling from. Is this about 22 Alder Street?";

interface CallOptions {
  callerNumber?: string;
  as?: string;
  asked?: JevRequest[];
  tools?: ReturnType<typeof toolsOf>;
}

const toolsOf = () => ({ ...proposalsApp.systems(), codes: mockCodeVerifier });

/** A call: the greeting, then each step in turn. */
async function call(o: CallOptions, ...steps: Scenario['steps']): Promise<ScenarioRun> {
  const scenario: Scenario = {
    id: 'call', steps, expect: { decision: 'any' },
    ...(o.callerNumber !== undefined ? { callerNumber: o.callerNumber } : {}),
    ...(o.as !== undefined ? { as: o.as } : {}),
  };
  return runScenario(scenario, { client: stub(o.asked), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, now: () => 0, ...(o.tools ? { tools: o.tools } : {}) });
}
const says = (...lines: string[]): Scenario['steps'] => lines.map((say) => ({ say }));

const last = (r: ScenarioRun): TurnResult => r.runs.at(-1)!.result;
const heard = (t: TurnResult): string => spokenText(proposalsApp, t.decision);
const promptOf = (t: TurnResult): string | undefined => ('promptId' in t.decision ? t.decision.promptId : undefined);
const prompts = (r: ScenarioRun): (string | undefined)[] => r.runs.map((x) => promptOf(x.result));
const gates = (r: ScenarioRun): string[] => r.runs.flatMap((x) => x.result.gateEvents.map((e) => `${e.decision.call.tool}:${e.decision.verdict}`));
const offers = (r: ScenarioRun) => r.runs.flatMap((x) => x.result.audit.filter((d) => d.type === 'offer').map((d) => d.detail));

/** The fixture as another app: its id, and what `change` makes of it. */
function variant(id: string, change: (app: App) => Partial<App>): App {
  return { ...proposalsApp, id, ...change(proposalsApp) } as App;
}

/** The fixture with the address slot proposing nothing (no `offer`). */
const withoutOffer = (id: string): App => variant(id, (app) => {
  const { offer: _offer, ...place } = app.slots.place!;
  return { slots: { ...app.slots, place } };
});

describe('the proposal: the worked example', () => {
  it('is made at the slot, inside the form, by the street the lookup found, in place of the question', async () => {
    const r = await call({ callerNumber: ON_FILE }, ...says(REPORT));
    // The greeting names nothing: the lookup ran before it, and the greeting is the app's as always.
    expect(promptOf(r.runs[0]!.result)).toBe('greeting');
    expect((r.runs[0]!.result.session.facts as ProposalFacts).serviceAddress).toBe('22 Alder Street');
    const t = last(r);
    expect(t.decision).toMatchObject({ kind: 'prompt', promptId: 'offer_place', target: 'place', vars: { place: '22 Alder Street' }, options: ['yes', 'no'] });
    expect(heard(t)).toBe(`Sure, I can help you report a problem. ${OFFER}`);
    expect(t.session.slots.place).toMatchObject({ value: null, attempts: 0 });
    expect(t.session.pendingConfirmation).toEqual({ target: 'slot', slot: 'place', value: '22 Alder Street', display: '22 Alder Street', offered: true, from: 'facts' });
  });

  it('a yes fills that slot, confirmed, and the form goes on', async () => {
    const t = last(await call({ callerNumber: ON_FILE }, ...says(REPORT, 'yes')));
    expect(t.session.slots.place).toMatchObject({ value: '22 Alder Street', display: '22 Alder Street', confirmed: true, attempts: 0 });
    expect(promptOf(t)).toBe('ask_problem');
    expect(t.session.pendingConfirmation).toBeNull();
  });

  it('a yes changes nothing else: not the principal, the level, the identity attempts, or another slot', async () => {
    const r = await call({ callerNumber: ON_FILE }, ...says(REPORT, 'yes'));
    const before = r.runs.at(-2)!.result.session;
    const after = last(r).session;
    expect(after.principal).toEqual({ kind: 'anonymous', level: 0 });
    expect(after.principal).toEqual(before.principal);
    expect(after.identityAttempts).toEqual(before.identityAttempts);
    expect(after.intentAttempts).toBe(before.intentAttempts);
    expect(after.stepUp).toBeNull();
    for (const id of ['problem', 'accountId', 'dob']) expect(after.slots[id], id).toEqual(before.slots[id]);
    expect(after.facts).toEqual(before.facts);
    // The yes ran nothing through the gate.
    expect(last(r).gateEvents).toEqual([]);
  });

  it('what else the yes said fills the form\'s other slots', async () => {
    const t = last(await call({ callerNumber: ON_FILE }, ...says(REPORT, 'yes, and nothing is working at all')));
    expect(t.session.slots.place!.value).toBe('22 Alder Street');
    expect(t.session.slots.problem!.value).toBe('out');
    expect(promptOf(t)).toBe('confirm_report_problem');
    expect(heard(t)).toBe("You're reporting nothing working at all, at this address: 22 Alder Street. Shall I file that?");
  });

  it('a no asks the slot\'s own question, with no attempt counted', async () => {
    const t = last(await call({ callerNumber: ON_FILE }, ...says(REPORT, 'no')));
    expect(promptOf(t)).toBe('ask_place');
    expect(t.session.slots.place).toMatchObject({ value: null, attempts: 0 });
    expect(t.session.slots.place!.declined).toBeUndefined();
  });

  it('a different address said, with the no or without one, fills the slot as said', async () => {
    for (const said of ["no, I'm at my mother's, 7 Birch Lane", "it's at 7 Birch Lane"]) {
      const t = last(await call({ callerNumber: ON_FILE }, ...says(REPORT, said)));
      expect(t.session.slots.place, said).toMatchObject({ value: '7 Birch Lane', display: '7 Birch Lane' });
      expect(promptOf(t), said).toBe('ask_problem');
    }
  });

  it('silence asks it again, as any read-back is asked again, and the end of its ladder asks the slot', async () => {
    const r = await call({ callerNumber: ON_FILE }, ...says(REPORT), { silence: true });
    expect(promptOf(last(r))).toBe('offer_place');
    expect(heard(last(r))).toBe(`I didn't hear anything. ${OFFER}`);
    expect(last(r).session.slots.place!.attempts).toBe(1);
    const unanswered = await call({ callerNumber: ON_FILE }, ...says(REPORT), { silence: true }, { silence: true }, { silence: true });
    // The slot has no keypad: the end of the offer's ladder is the slot's retry, then its own ladder.
    expect(prompts(unanswered)).toEqual(['greeting', 'offer_place', 'offer_place', 'ask_place_retry', 'handoff_max_attempts']);
    expect(offers(unanswered)).toMatchObject([{ answer: 'none', by: null }]);
  });

  it('a key pressed at it answers nothing (the slot has no keypad): the proposal stands, and a yes still takes it', async () => {
    const r = await call({ callerNumber: ON_FILE }, ...says(REPORT), { dtmf: '1' });
    expect(last(r).decision.kind).toBe('ignore');
    expect(last(r).session.pendingConfirmation).toMatchObject({ target: 'slot', slot: 'place', offered: true, from: 'facts' });
    expect(offers(r)).toEqual([]);
    const yes = await call({ callerNumber: ON_FILE }, ...says(REPORT), { dtmf: '1' }, { say: 'yes' });
    expect(last(yes).session.slots.place).toMatchObject({ value: '22 Alder Street', confirmed: true });
    expect(offers(yes)).toMatchObject([{ answer: 'yes', by: 'speech' }]);
  });

  it('words that answer neither ask it again, and settle nothing', async () => {
    const r = await call({ callerNumber: ON_FILE }, ...says(REPORT, 'hmm, which account'));
    expect(promptOf(last(r))).toBe('offer_place');
    expect(last(r).session.slots.place!.value).toBeNull();
    expect(offers(r)).toEqual([]);
  });

  it('the summary still reads the address back before the report is filed', async () => {
    const tools = toolsOf();
    const r = await call({ callerNumber: ON_FILE, tools }, ...says(REPORT, 'yes', 'nothing is working at all', 'yes, file it'));
    expect(prompts(r)).toEqual(['greeting', 'offer_place', 'ask_problem', 'confirm_report_problem', 'anything_else']);
    expect(gates(r)).toEqual(['findAccountByPhone:ALLOW', 'reportProblem:ALLOW']);
    expect((tools.sys as ProposalSystems).reports).toEqual([{ ref: 'P201', place: '22 Alder Street', problem: 'out' }]);
  });
});

describe('offered once per slot per form', () => {
  it('a no is not followed by the proposal again, and the slot reopened at the summary is asked', async () => {
    const r = await call({ callerNumber: ON_FILE }, ...says(REPORT, 'yes', 'nothing is working at all', 'no, the address is wrong'));
    expect(promptOf(last(r))).toBe('ask_place');
    expect(last(r).session.callerOffered).toEqual(['place']);
    // A silence at the reopened question is the question again, never the proposal.
    const quiet = await call({ callerNumber: ON_FILE }, ...says(REPORT, 'no'), { silence: true });
    expect(prompts(quiet)).toEqual(['greeting', 'offer_place', 'ask_place', 'ask_place']);
  });

  it('the slot reopened at the summary is asked, never proposed, whichever way the app reads a change', async () => {
    for (const mode of ['set-aside', 'decides'] as const) {
      use(variant(`proposals-change-${mode}`, () => ({ changeSlotWithValue: mode })));
      const r = await call({ callerNumber: ON_FILE }, ...says(REPORT, 'yes', 'nothing is working at all', 'no, the address is wrong'), { silence: true });
      expect(prompts(r).slice(-2), mode).toEqual(['ask_place', 'ask_place']);
      expect(last(r).session.slots.place!.value, mode).toBeNull();
      expect(offers(r).map((d) => d.answer), mode).toEqual(['yes']);
    }
  });

  it('a second report on the call is a new form, and proposes again', async () => {
    const r = await call({ callerNumber: ON_FILE }, ...says(REPORT, 'yes', 'nothing is working at all', 'yes, file it', REPORT));
    expect(promptOf(last(r))).toBe('offer_place');
    expect(offers(r).map((d) => d.answer)).toEqual(['yes']);
  });

  it('a slot already said with the request is not proposed', async () => {
    const t = last(await call({ callerNumber: ON_FILE }, ...says('nothing is working at 7 Birch Lane')));
    expect(t.session.slots.place!.value).toBe('7 Birch Lane');
    expect(promptOf(t)).toBe('confirm_report_problem');
  });
});

describe('no proposal', () => {
  it('when the lookup found nothing for the number: the slot is asked as always', async () => {
    const r = await call({ callerNumber: NOT_ON_FILE }, ...says(REPORT));
    expect(r.runs[0]!.result.session.facts).toEqual({});
    expect(promptOf(last(r))).toBe('ask_place');
    expect(last(r).session.callerOffered).toBeUndefined();
  });

  it('when the lookup was refused', async () => {
    const gate = gateOf(proposalsApp);
    const a = gate.source.actions.findAccountByPhone!;
    const refusing = compileGate({ ...gate.source, actions: { ...gate.source.actions, findAccountByPhone: { ...a, rules: [...a.rules, { rule: 'noneOf', field: 'callerNumber', values: [ON_FILE] }] } } }, gate.tables, gate.subjectKind, gate.identityTools);
    use(variant('proposals-refused', () => ({ gate: refusing })));
    const r = await call({ callerNumber: ON_FILE }, ...says(REPORT));
    expect(gates(r)).toEqual(['findAccountByPhone:BLOCK']);
    expect(promptOf(last(r))).toBe('ask_place');
  });

  it('with no number: a withheld one, none at all, and a chat', async () => {
    for (const o of [{ callerNumber: 'anonymous' }, { callerNumber: '+7378742833' }, {}, { as: 'web', callerNumber: ON_FILE }] as CallOptions[]) {
      const r = await call(o, ...says(REPORT));
      expect(gates(r), JSON.stringify(o)).toEqual([]);
      expect(promptOf(last(r)), JSON.stringify(o)).toBe('ask_place');
    }
  });

  it('for a candidate with nothing in it, and for an app with no offers', async () => {
    const facts = proposalsApp.facts!;
    use(variant('proposals-empty', () => ({ facts: { ...facts, offers: () => ({ place: { value: '', display: ' ' } }) } })));
    expect(promptOf(last(await call({ callerNumber: ON_FILE }, ...says(REPORT))))).toBe('ask_place');
    const { offers: _offers, ...noOffers } = facts;
    use(variant('proposals-no-offers', () => ({ facts: noOffers })));
    expect(promptOf(last(await call({ callerNumber: ON_FILE }, ...says(REPORT))))).toBe('ask_place');
  });

  it('when the app\'s offers throws: the slot is asked as always, the turn goes on, and nothing of the error is kept', async () => {
    const facts = proposalsApp.facts!;
    const secret = 'a message holding 22 Alder Street';
    use(variant('proposals-throws', () => ({ facts: { ...facts, offers: () => { throw new Error(secret); } } })));
    const r = await call({ callerNumber: ON_FILE }, ...says(REPORT, "It's 14 Birch Lane"));
    expect(prompts(r)).toEqual(['greeting', 'ask_place', 'ask_problem']);
    expect(last(r).session.slots.place!.value).toBe('14 Birch Lane');
    expect(offers(r)).toEqual([]);
    expect(JSON.stringify(r.runs.map((x) => x.record))).not.toContain(secret);
    // An answer that is no map of candidates proposes nothing either.
    for (const odd of [null, 'place', { place: 'ok' }]) {
      use(variant('proposals-odd', () => ({ facts: { ...facts, offers: () => odd as never } })));
      expect(promptOf(last(await call({ callerNumber: ON_FILE }, ...says(REPORT)))), JSON.stringify(odd)).toBe('ask_place');
    }
  });

  it('never on an identity factor, even when the app\'s facts name one', () => {
    const spec = proposalsApp.slots.accountId!;
    const app = variant('proposals-factor', (a) => ({
      slots: { ...a.slots, accountId: { ...spec, offer: 'facts' } },
      facts: { ...a.facts!, offers: () => ({ accountId: { value: '55501234', display: '5550 1234' } }) },
    }));
    expect(factsOfferSlots(app)).toEqual(['place']);
    expect(factsCandidate(app, 'accountId', {})).toBeNull();
  });
});

describe('beside an offer of the caller\'s number on the same form', () => {
  /** The fixture with a callback number (the callback fixture's phone, callerNumber) asked between the address and the problem. */
  const withCallback = (): App => variant('proposals-callback', (app) => {
    const lines = Object.fromEntries(Object.entries(callbackApp.prompts.manifest).filter(([id]) => /^(ask|offer|confirm|ack)_phone/.test(id)));
    const form = app.forms.report_problem!;
    return {
      slots: { ...app.slots, phone: callbackApp.slots.phone! },
      forms: { ...app.forms, report_problem: { ...form, slots: ['place', 'phone', 'problem'] } },
      prompts: { ...app.prompts, manifest: { ...app.prompts.manifest, ...lines } },
    };
  });

  it('each slot makes its own offer once, and each settled offer is its own row', async () => {
    use(withCallback());
    const r = await call({ callerNumber: ON_FILE }, ...says(REPORT, 'yes', 'yes'));
    expect(prompts(r)).toEqual(['greeting', 'offer_place', 'offer_phone', 'ask_problem']);
    const t = last(r);
    expect(t.session.slots.place).toMatchObject({ value: '22 Alder Street', confirmed: true });
    expect(t.session.slots.phone).toMatchObject({ value: '5555550142', confirmed: true });
    expect(t.session.callerOffered).toEqual(['place', 'phone']);
    expect(offers(r).map((d) => [d.slot, d.source, d.answer, d.last4])).toEqual([['place', 'facts', 'yes', undefined], ['phone', 'caller-number', 'yes', '0142']]);
    expect(t.session.principal).toEqual({ kind: 'anonymous', level: 0 });
  });

  it('a no to the proposal leaves the number\'s offer to come', async () => {
    use(withCallback());
    const r = await call({ callerNumber: ON_FILE }, ...says(REPORT, 'no', "It's 14 Birch Lane"));
    expect(prompts(r)).toEqual(['greeting', 'offer_place', 'ask_place', 'offer_phone']);
  });
});

describe('a caller who had not finished, at the proposal', () => {
  it('a yes whose reply was cut off at once is joined to what came next: the fragment\'s row stays, and the joined turn\'s follows it', async () => {
    const c = new Continuation(300);
    const o = { client: stub(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, now: () => 0, tools: toolsOf() };
    let session: Session = newSession('p1', 0, VOICE_RELAY, ANONYMOUS, proposalsApp.id);
    const runs: Awaited<ReturnType<Continuation['run']>>[] = [];
    const events: SessionEvent[] = [withCallerNumber(startEvent(), ON_FILE), speechEvent(REPORT), speechEvent('yes'), interruptEvent('What are', 120), speechEvent('and nothing is working at all')];
    for (const e of events) {
      const r = await c.run(session, e, o);
      session = r.result.session;
      runs.push(r);
    }
    expect(runs.at(-1)!.joined).toEqual(['yes', 'and nothing is working at all']);
    expect(session.slots.place).toMatchObject({ value: '22 Alder Street', confirmed: true });
    expect(session.principal).toEqual({ kind: 'anonymous', level: 0 });
    const rows = runs.flatMap((r) => r.result.audit.filter((d) => d.type === 'offer').map((d) => d.detail.answer));
    expect(rows).toEqual(['yes', 'yes']);
  });
});

describe('identity after a yes', () => {
  it('a protected action still asks for the factors, and the proposal is no factor', async () => {
    const r = await call({ callerNumber: ON_FILE }, ...says(REPORT, 'yes', 'nothing is working at all', 'yes, file it', 'and can you check on my request'));
    const t = last(r);
    expect(promptOf(t)).toBe('ask_accountId');
    expect(t.session.principal).toEqual({ kind: 'anonymous', level: 0 });
    expect(gates(r).at(-1)).toBe('findAccount:STEP_UP');
    expect(t.session.slots.accountId!.value).toBeNull();
  });

  it('the factors verify the caller as they would on any call', async () => {
    const r = await call({ callerNumber: ON_FILE }, ...says(REPORT, 'yes', 'nothing is working at all', 'yes, file it', 'and can you check on my request', 'five five five zero one two three four', 'April twelfth nineteen eighty'));
    expect(last(r).session.principal).toMatchObject({ kind: 'customer', level: 1, id: '55501234' });
    expect(heard(last(r))).toContain('Your latest request, P100, is open.');
  });
});

describe('the model request', () => {
  it('on the offer\'s answer carries only what the proposal said: the street, as the pending read-back', async () => {
    const asked: JevRequest[] = [];
    await call({ callerNumber: ON_FILE, asked }, ...says(REPORT, 'yes'));
    const answer = asked.at(-1)!;
    const state = JSON.stringify(answer);
    expect(state).toContain('"pendingConfirmation":{"target":"place","value":"22 Alder Street"}');
    expect(state).toContain(OFFER);
    // Nothing else of the account: not its number, its holder, its status, nor the number calling.
    for (const never of ['55501234', 'Avery', 'P100', '5555550142', '0142']) expect(state, never).not.toContain(never);
  });

  it('before the offer is what a call from a number not on file sends: the lookup alone changes no request', async () => {
    const onFile: JevRequest[] = [];
    const notOnFile: JevRequest[] = [];
    await call({ callerNumber: ON_FILE, asked: onFile }, ...says(REPORT));
    await call({ callerNumber: NOT_ON_FILE, asked: notOnFile }, ...says(REPORT));
    expect(JSON.stringify(onFile)).toBe(JSON.stringify(notOnFile));
  });

  it('for an app with no offer: facts slot is what a call with no number sends, the lookup and its facts notwithstanding', async () => {
    use(withoutOffer('proposals-plain'));
    const steps = says(REPORT, 'It\'s 14 Birch Lane', 'nothing is working at all');
    const withNumber: JevRequest[] = [];
    const without: JevRequest[] = [];
    const r = await call({ callerNumber: ON_FILE, asked: withNumber }, ...steps);
    await call({ asked: without }, ...steps);
    expect(JSON.stringify(withNumber)).toBe(JSON.stringify(without));
    expect(prompts(r)).toEqual(['greeting', 'ask_place', 'ask_problem', 'confirm_report_problem']);
    expect((r.runs[0]!.result.session.facts as ProposalFacts).serviceAddress).toBe('22 Alder Street');
  });
});

describe('the offer audit row', () => {
  it('is written for each settled proposal, with the line as said, the answer and how, and no last four', async () => {
    expect(offers(await call({ callerNumber: ON_FILE }, ...says(REPORT, 'yes')))).toEqual([
      { slot: 'place', source: 'facts', promptId: 'offer_place', said: OFFER, answer: 'yes', by: 'speech', locale: 'en-US' },
    ]);
    expect(offers(await call({ callerNumber: ON_FILE }, ...says(REPORT, 'no'))).map((d) => d.answer)).toEqual(['no']);
    expect(offers(await call({ callerNumber: ON_FILE }, ...says(REPORT, "no, I'm at my mother's, 7 Birch Lane"))).map((d) => d.answer)).toEqual(['other']);
    expect(offers(await call({ callerNumber: ON_FILE }, ...says(REPORT, "it's at 7 Birch Lane"))).map((d) => d.answer)).toEqual(['other']);
    expect(offers(await call({ callerNumber: NOT_ON_FILE }, ...says(REPORT)))).toEqual([]);
  });

  it('writes the value proposed as the slot\'s value is recorded', async () => {
    const spec = proposalsApp.slots.place!;
    use(variant('proposals-masked', (app) => ({ slots: { ...app.slots, place: { ...spec, redact: 'mask' } } })));
    const [row] = offers(await call({ callerNumber: ON_FILE }, ...says(REPORT, 'yes')));
    expect(row!.said).toBe("I see an account for the number you're calling from. Is this about •?");
    // A statement (redact: length) never says its words back, so it never proposes (check refuses it too).
    use(variant('proposals-statement', (app) => ({ slots: { ...app.slots, place: { ...spec, redact: 'length' } } })));
    expect(factsOfferSlots(proposalsApp)).toEqual(['place']);
    const r = await call({ callerNumber: ON_FILE }, ...says(REPORT));
    expect(promptOf(last(r))).toBe('ask_place');
    expect(offers(r)).toEqual([]);
  });
});

describe('the trace and the console', () => {
  it('mask the value proposed as they mask the slot\'s own value: in the line said, its vars, the pending read-back and the next turn\'s line just played', async () => {
    const spec = proposalsApp.slots.place!;
    for (const redact of ['mask', 'last4'] as const) {
      use(variant(`proposals-trace-${redact}`, (app) => ({ slots: { ...app.slots, place: { ...spec, redact } } })));
      // A yes (the slot then holds it), and a no (the slot then empty: only the model's read-back had it).
      for (const answer of ['yes', 'no']) {
        const r = await call({ callerNumber: ON_FILE }, ...says(REPORT), { silence: true }, { say: answer });
        expect(JSON.stringify(r.runs.map((x) => x.record)), `${redact} ${answer}`).toContain('22 Alder Street');
        for (const run of r.runs) {
          expect(JSON.stringify(redactRecordSlots(run.record, 'length')), `${redact} ${answer}`).not.toContain('Alder');
          expect(JSON.stringify(redactRecord(run.record)), `${redact} ${answer}`).not.toContain('Alder');
        }
      }
    }
  });
});

describe('the fixture\'s scripted calls', () => {
  const scenarios: Scenario[] = loadScenarios(join(FIXTURES, 'scenarios'));
  it('has one for each case', () => {
    expect(scenarios.map((s) => s.id)).toEqual([
      'propose-yes', 'propose-yes-with-more', 'propose-no-asks', 'propose-another-address', 'propose-unanswered-then-yes', 'propose-address-reopened',
      'no-proposal-not-on-file', 'no-proposal-withheld', 'no-proposal-chat', 'propose-yes-then-status-asks-identity', 'propose-yes-then-status-verified',
    ]);
  });
  for (const scenario of scenarios) {
    it(`${scenario.id} meets its expectation`, async () => {
      const r = await runScenario(scenario, { client: stub(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, now: () => 0 });
      expect(r.mismatches).toEqual([]);
      expect(r.pass).toBe(true);
    });
  }
});

describe('a saved session resumes exactly, on the fixture', () => {
  it('runs every corpus entry and scripted call as the live session does, at every turn', async () => {
    const report = await sessionRoundTrip('stub');
    expect(report.mismatches).toEqual([]);
    expect(report.turns).toBeGreaterThan(50);
  }, 60_000);
});

describe('apps without it', () => {
  it('have no slot that proposes from the facts', () => {
    for (const app of [testkitApp, screenedApp, callbackApp, textingApp]) {
      expect(factsOfferSlots(app), app.id).toEqual([]);
      expect(Object.values(app.slots).some((spec) => spec.offer !== undefined), app.id).toBe(false);
      expect(app.facts?.offers, app.id).toBeUndefined();
    }
  });
});
