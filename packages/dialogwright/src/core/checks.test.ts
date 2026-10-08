import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadScenarios, runScenario, type Scenario, type ScenarioRun } from '../harness-text/runner';
import { loadCorpus } from '../jev/corpus';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { spokenText } from '../prompts/render';
import { choice, noul, score } from '../testing/answers';
import { registerApp, resetAppsForTest } from './app/registry';
import type { App, FormCheck, FormDef } from './app/types';
import { DEFAULT_THRESHOLDS } from './thresholds';
import { closeForm, cloneSession, newSession, setForm, type Session } from './session';
import { resolve, type TurnContext, type TurnResult } from './turn';
import { keyEvents, speechEvent } from '../channel/events';
import { VOICE_RELAY } from '../channel/caps';
import { ANONYMOUS } from '../gate/principal';
import { compilePolicy } from '../define/policyFile';
import { loadAppFolder } from '../define/load';
import { runChecks } from './checks';
import { newTurnOut } from './lifecycle';
import { mockCodeVerifier } from './tools';
import { testkitApp } from '../testing/testkit';
import { SCREENED_DIR, ScreenedSystems, screenedApp, screenedCode } from '../testing/screened/app';
import { openFileStores } from '../server/stores/file';
import { contractCall } from '../testing/storeContract';

/**
 * A form's checks (forms.yaml `checks`, core/checks.ts), on the engine's fixture for them: Example
 * Home Visits (src/testing/screened), one form that asks whether the caller owns the home, the town
 * and how urgent it is before it books a day and a time, with a check on each of the three. The
 * calls run through the harness with the fixture's corpus behind the stub, as a regression run does.
 */

const TODAY = '2026-09-18';
const FIXTURES = join(SCREENED_DIR, 'fixtures');
// The corpus is read against the default app: the fixture is registered first.
resetAppsForTest();
registerApp(screenedApp);
const corpus = loadCorpus(join(FIXTURES, 'corpus.jsonl'));
const client = new FixtureStubClient(corpus, { sharpness: DEFAULT_THRESHOLDS.STUB_SHARPNESS, fallback: new HeuristicStubClient({ todayIso: TODAY }) });

/** Registers `app` as the only (so the default) app: the harness runs against the default. */
function use(app: App): void {
  resetAppsForTest();
  registerApp(app);
}

beforeEach(() => use(screenedApp));

/** A call: the greeting, then each line said in turn. */
async function call(...says: string[]): Promise<ScenarioRun> {
  return runScenario({ id: 'call', steps: says.map((say) => ({ say })), expect: { decision: 'any' } }, { client, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, now: () => 0 });
}

const last = (r: ScenarioRun): TurnResult => r.runs.at(-1)!.result;
const heard = (t: TurnResult): string => spokenText(screenedApp, t.decision);
const gates = (t: TurnResult): string[] => t.gateEvents.map((e) => `${e.decision.call.tool}:${e.decision.verdict}${e.decision.reason ? `:${e.decision.reason}` : ''}`);
const rows = (t: TurnResult): string[] => t.audit.map((d) => d.type);
const ackIds = (t: TurnResult): string[] => ('acks' in t.decision ? t.decision.acks.map((a) => a.promptId) : []);

const OWNER_QUESTION = 'Do you own the home, or rent it?';
const RENTER_LINE = "Thank you for calling. Our visits are for homeowners, so I'm sorry we can't help with a rented home, but the owner is welcome to call us. Goodbye.";
const AREA_LINE = "Thank you for calling. We only work in Millbrook, Cedar Falls, Ashford and Riverton, so I'm sorry we can't help with a home outside them. Goodbye.";

/** Up to the summary: an owner in Cedar Falls, it can wait, Monday morning. */
const TO_SUMMARY = ["there's water in my basement", 'yes, I own it', 'Cedar Falls', 'it can wait, whenever suits', 'Monday', 'the morning'] as const;

describe('a renter', () => {
  it('is told on the turn they say so, before the town or any booking question, and the call ends', async () => {
    const r = await call("there's water in my basement", 'I rent it');
    const opener = r.runs[1]!.result;
    expect(heard(opener)).toBe(`Sure, I can help you book a free visit. ${OWNER_QUESTION}`);
    // No check is ready on the opener: none of the slots they read is filled.
    expect(opener.gateEvents).toEqual([]);
    const t = last(r);
    expect(t.decision).toMatchObject({ kind: 'complete', form: 'book_visit', promptId: 'decline_renter', completed: [] });
    expect(heard(t)).toBe(RENTER_LINE);
    expect(gates(t)).toEqual(['checkOwner:BLOCK:not-owner']);
    // One gate row, no tool result (a check has no tool), the form stopped, then the call's end.
    expect(rows(t)).toEqual(['gate', 'form_stopped', 'call_ended']);
    expect(t.audit[1]).toEqual({ type: 'form_stopped', detail: { form: 'book_visit', action: 'checkOwner', reason: 'not-owner', then: 'end' } });
    expect(t.audit[0]!.detail).toMatchObject({ tool: 'checkOwner', call: 'checkOwner(ownership=rent)', verdict: 'BLOCK', reason: 'not-owner' });
    // Nothing was asked of the town or the booking, and nothing is pending.
    expect(t.session.slots.town!.value).toBeNull();
    expect(t.session.pendingConfirmation).toBeNull();
    expect(t.stopped).toEqual({ form: 'book_visit', action: 'checkOwner', reason: 'not-owner', then: 'end' });
  });

  it('said with the request: refused on the same turn, without the "Sure, I can help" line, and the later checks never run', async () => {
    const t = last(await call("I rent a place in Ashford, water is seeping in and it's getting worse"));
    expect(t.decision).toMatchObject({ kind: 'complete', promptId: 'decline_renter' });
    expect(ackIds(t)).toEqual([]);
    expect(heard(t)).toBe(RENTER_LINE);
    // In the order written: the urgency passes, the ownership refuses, the town is never asked of the gate.
    expect(gates(t)).toEqual(['checkUrgency:ALLOW', 'checkOwner:BLOCK:not-owner']);
    expect(rows(t)).toEqual(['gate', 'gate', 'form_stopped', 'call_ended']);
  });
});

describe('a home outside the area', () => {
  it('passes the ownership check, then is told at the town', async () => {
    const r = await call('can someone come and look at a crack in my wall', 'yes, I own it', 'Lakeview');
    const owner = r.runs[2]!.result;
    expect(gates(owner)).toEqual(['checkOwner:ALLOW']);
    expect(heard(owner)).toBe('Which town is the home in?');
    // The pass is kept: by action, the hash of what it passed with.
    expect(Object.keys(owner.session.checked ?? {})).toEqual(['checkOwner']);
    const t = last(r);
    expect(gates(t)).toEqual(['checkArea:BLOCK:out-of-area']);
    expect(heard(t)).toBe(AREA_LINE);
    expect(t.audit.find((d) => d.type === 'form_stopped')!.detail).toEqual({ form: 'book_visit', action: 'checkArea', reason: 'out-of-area', then: 'end' });
  });
});

describe('everything in one breath', () => {
  it('fills the qualifying and the booking slots, runs the three checks, says checksPassed, and goes to the summary', async () => {
    const r = await call("I own a house in Riverton, water is coming into the basement and it's getting worse, can someone come out on a Saturday morning", 'yes, book it');
    const first = r.runs[1]!.result;
    expect(gates(first)).toEqual(['checkUrgency:ALLOW', 'checkOwner:ALLOW', 'checkArea:ALLOW']);
    // A check's ALLOW runs no tool: its gate row has no tool result after it.
    expect(rows(first)).toEqual(['gate', 'gate', 'gate']);
    expect(ackIds(first)).toEqual(['ack_intent', 'visit_qualifies']);
    expect(heard(first)).toBe('Sure, I can help you book a free visit. Good news, we work in Riverton, and the visit is free. A free visit about a leak in Riverton, on Saturday in the morning. Shall I book it?');
    // The yes changed nothing a check reads, so the gate is asked only about the booking.
    const t = last(r);
    expect(gates(t)).toEqual(['bookVisit:ALLOW']);
    expect(t.decision).toMatchObject({ kind: 'complete', promptId: 'visit_booked', completed: ['book_visit'] });
  });
});

describe('a qualifying answer and the day and time said on the opener', () => {
  // One form with checks: the turn that opens it fills every slot of it, so "a Saturday morning" said
  // with the request is kept for the booking's questions, which are never asked. (A line of two forms,
  // qualify then book, lost them: the turn fills only the form it opens.)
  it('fills them on the opening turn, runs the ownership check at once, and never asks the day or the time', async () => {
    const r = await call('I own my house, can someone come out on a Saturday morning', 'a crack in the wall', 'Cedar Falls', 'it can wait, whenever suits', 'yes, book it');
    const opener = r.runs[1]!.result;
    expect(opener.session.slots.ownership!.value).toBe('own');
    expect(opener.session.slots.visitDay!.value).toBe('saturday');
    expect(opener.session.slots.timeOfDay!.value).toBe('morning');
    expect(gates(opener)).toEqual(['checkOwner:ALLOW']);
    expect(heard(opener)).toBe("Sure, I can help you book a free visit. What's the problem with the home, a leak, a crack, or a draft?");
    // The questions asked over the call: the problem, the town and the urgency; never the ownership, the day or the time.
    const asked = r.runs.map((run) => run.result.session.lastPromptId);
    expect(asked).not.toContain('ask_ownership');
    expect(asked).not.toContain('ask_visitDay');
    expect(asked).not.toContain('ask_timeOfDay');
    // The urgency's turn passes the last check and goes straight to the summary, with the day and time read back.
    expect(heard(r.runs[4]!.result)).toBe('Good news, we work in Cedar Falls, and the visit is free. A free visit about a crack in Cedar Falls, on Saturday in the morning. Shall I book it?');
    const t = last(r);
    expect(gates(t)).toEqual(['bookVisit:ALLOW']);
    expect(t.decision).toMatchObject({ kind: 'complete', promptId: 'visit_booked', completed: ['book_visit'] });
  });
});

describe('something urgent', () => {
  it('said mid-qualify as a request: the priority intent takes the turn before any slot fills or check runs', async () => {
    const t = last(await call("there's water in my basement", 'yes, I own it', 'oh no, water is pouring in right now'));
    expect(t.decision).toMatchObject({ kind: 'handoff', reason: 'urgent' });
    expect(t.gateEvents).toEqual([]);
    expect(t.stopped).toBeUndefined();
  });

  it('given as the answer to how urgent it is: the check hands the call to the office', async () => {
    const t = last(await call("there's water in my basement", 'yes, I own it', 'Cedar Falls', 'it needs someone right away'));
    expect(t.decision).toMatchObject({ kind: 'handoff', reason: 'urgent', promptId: 'handoff_urgent' });
    expect(heard(t)).toBe("That sounds urgent. I'm putting you through to our office right now.");
    expect(gates(t)).toEqual(['checkUrgency:NEEDS_HUMAN:urgent']);
    expect(rows(t)).toEqual(['gate', 'form_stopped', 'handoff', 'call_ended']);
    expect(t.audit[1]!.detail).toEqual({ form: 'book_visit', action: 'checkUrgency', reason: 'urgent', then: 'handoff' });
  });
});

describe('checksPassed', () => {
  it('is said once, on the turn the last check passes, and not again after a correction re-runs a check', async () => {
    const r = await call(...TO_SUMMARY, "no, it's in Ashford", 'yes, book it');
    const said = r.runs.map((run) => ackIds(run.result).filter((id) => id === 'visit_qualifies').length);
    expect(said.reduce((a, b) => a + b, 0)).toBe(1);
    // The urgency is the last of the three answered: its turn says it.
    expect(heard(r.runs[4]!.result)).toBe('Good news, we work in Cedar Falls, and the visit is free. Which day suits you, Monday, Wednesday or Saturday?');
  });
});

describe('a correction at the summary', () => {
  it('that disqualifies ends the call before any write', async () => {
    const t = last(await call(...TO_SUMMARY, "no wait, it's my landlord's house, I rent"));
    expect(t.decision).toMatchObject({ kind: 'complete', promptId: 'decline_renter' });
    expect(gates(t)).toEqual(['checkOwner:BLOCK:not-owner']);
    expect(t.session.pendingConfirmation).toBeNull();
  });

  it('with the yes ("yes, but I rent it"): the completion runs the checks first, and the write is never attempted', async () => {
    const r = await call(...TO_SUMMARY, 'yes, but I rent it');
    const t = last(r);
    expect(t.decision).toMatchObject({ kind: 'complete', promptId: 'decline_renter', completed: [] });
    expect(gates(t)).toEqual(['checkOwner:BLOCK:not-owner']);
    expect(r.runs.flatMap((run) => gates(run.result)).filter((g) => g.startsWith('bookVisit'))).toEqual([]);
  });

  it('that re-qualifies: the check runs again, passes, and the summary is read again', async () => {
    const r = await call(...TO_SUMMARY, "no, it's in Ashford", 'yes, book it');
    const corrected = r.runs[7]!.result;
    expect(gates(corrected)).toEqual(['checkArea:ALLOW']);
    expect(heard(corrected)).toBe('A free visit about a leak in Ashford, on Monday in the morning. Shall I book it?');
    const t = last(r);
    expect(gates(t)).toEqual(['bookVisit:ALLOW']);
    expect(t.decision).toMatchObject({ kind: 'complete', promptId: 'visit_booked' });
  });
});

describe('the fixture\'s scripted calls', () => {
  const scenarios: Scenario[] = loadScenarios(join(FIXTURES, 'scenarios'));
  it('has one for each case', () => {
    expect(scenarios.map((s) => s.id)).toEqual([
      'renter-ends-before-the-town', 'out-of-area', 'one-breath-qualifies', 'day-and-time-up-front-kept', 'one-breath-renter', 'urgent-mid-qualify-priority',
      'urgent-by-the-check', 'urgent-at-the-summary-corrects', 'summary-correction-disqualifies', 'summary-yes-but-renting', 'summary-correction-requalifies',
    ]);
  });
  for (const scenario of scenarios) {
    it(`${scenario.id} meets its expectation`, async () => {
      const r = await runScenario(scenario, { client, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, now: () => 0 });
      expect(r.mismatches).toEqual([]);
      expect(r.pass).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------------------------
// The outcomes, on variants of the fixture
// ---------------------------------------------------------------------------------------------

/** The fixture with book_visit's checks replaced (and anything else of the app over it). */
function variant(id: string, checks: readonly FormCheck[], over: Partial<App> = {}): App {
  const form: FormDef = { ...screenedApp.forms.book_visit!, checks };
  return { ...screenedApp, id, forms: { ...screenedApp.forms, book_visit: form }, ...over };
}

const OWNER = (on?: FormCheck['on']): FormCheck => (on === undefined ? { action: 'checkOwner', with: ['ownership'] } : { action: 'checkOwner', with: ['ownership'], on });

describe('each ending', () => {
  it('anything-else: the line, the form closed uncounted, and the call carries on', async () => {
    use(variant('screened-else', [OWNER({ 'not-owner': { say: 'decline_renter', then: 'anything-else' } })]));
    const t = last(await call("there's water in my basement", 'I rent it'));
    expect(t.decision).toMatchObject({ kind: 'prompt', promptId: 'anything_else', target: 'intent' });
    expect(ackIds(t)).toEqual(['decline_renter']);
    expect(t.session.form).toBeNull();
    expect(t.session.completed).toEqual([]);
    expect(t.session.checked).toBeUndefined();
    expect(t.stopped?.then).toBe('anything-else');
  });

  it('handoff with a reason of its own and a line before it', async () => {
    use(variant('screened-handoff', [OWNER({ 'not-owner': { say: 'decline_renter', then: 'handoff', reason: 'urgent' } })]));
    const t = last(await call("there's water in my basement", 'I rent it'));
    expect(t.decision).toMatchObject({ kind: 'handoff', reason: 'urgent' });
    expect(ackIds(t)).toEqual(['decline_renter']);
  });

  it('a reason `on` does not list: the app\'s block line where it has one, and the call carries on', async () => {
    use(variant('screened-block', [OWNER()], { blockPromptId: (reason) => (reason === 'not-owner' ? 'decline_renter' : null) }));
    const t = last(await call("there's water in my basement", 'I rent it'));
    expect(t.decision).toMatchObject({ kind: 'prompt', promptId: 'anything_else' });
    expect(ackIds(t)).toEqual(['decline_renter']);
    expect(t.stopped).toEqual({ form: 'book_visit', action: 'checkOwner', reason: 'not-owner', then: 'anything-else' });
  });

  it('a reason `on` does not list, with no block line: a person', async () => {
    use(variant('screened-person', [OWNER()]));
    const t = last(await call("there's water in my basement", 'I rent it'));
    expect(t.decision).toMatchObject({ kind: 'handoff', reason: 'needs-human' });
    expect(t.stopped?.then).toBe('handoff');
  });

  it('a STEP_UP from a check, in an app without identity, goes to a person, whatever `on` says', async () => {
    const policy = loadAppFolder(SCREENED_DIR).config!.policy;
    const stepUp = (() => ({ result: { id: 'needs-more', description: 'needs a verified caller', compared: 'level 0 < 1', pass: false }, fail: { verdict: 'STEP_UP' as const, needLevel: 1 as const } }));
    const tables = compilePolicy(
      { ...policy, actions: { ...policy.actions, checkOwner: { ...policy.actions.checkOwner!, rules: ['identity', { custom: 'needs-more' }] } } },
      { customRules: { ...screenedCode.customRules, 'needs-more': stepUp } },
    );
    use(variant('screened-stepup', [OWNER({ 'not-owner': { say: 'decline_renter', then: 'end' } })], { policy: tables }));
    const t = last(await call("there's water in my basement", 'yes, I own it'));
    expect(gates(t)).toEqual(['checkOwner:STEP_UP']);
    expect(t.decision).toMatchObject({ kind: 'handoff', reason: 'needs-human' });
    expect(t.stopped).toEqual({ form: 'book_visit', action: 'checkOwner', reason: null, then: 'handoff' });
  });
});

/** The engine's own questions, each answered plainly, for a turn resolved by hand. */
const PLAIN = {
  addressedToSystem: noul(0.95), intelligible: noul(0.95), utteranceComplete: noul(0.9), wantsHuman: noul(0.05),
  rephrasingLastTurn: noul(0.1), confusedByPrompt: noul(0.1), spokeAMenuNumber: noul(0.05),
  frustration: score({ none: 0.8, mild: 0.15, high: 0.05 }),
  intent: choice({ none: 0.9, other: 0.1 }),
  intentChange: choice({ answering: 0.95, adding: 0.03, replacing: 0.02 }),
};

describe('end with a request queued', () => {
  it('says the line, then goes on to the queued request instead of ending the call', () => {
    const app = variant('screened-queued', screenedApp.forms.book_visit!.checks!, { intents: { ...screenedApp.intents, urgent: { ...screenedApp.intents.urgent!, priority: false } } });
    use(app);
    const s = newSession('queued', 0, VOICE_RELAY, ANONYMOUS, app.id);
    setForm(s, 'book_visit');
    s.entered = 'book_visit';
    s.queued = ['urgent'];
    s.promptedFor = 'ownership';
    s.slots.problem = { ...s.slots.problem!, value: 'leak', display: 'a leak' };
    const tc: TurnContext = { nowMs: 0, todayIso: TODAY, thresholds: { ...DEFAULT_THRESHOLDS }, tools: { ...app.systems(), codes: mockCodeVerifier } };
    const t = resolve(s, speechEvent('I rent it', true), { ...PLAIN, ownership: choice({ rent: 0.95, none: 0.05 }) }, tc);
    expect(t.decision).toMatchObject({ kind: 'handoff', reason: 'urgent' });
    expect(ackIds(t)).toEqual(['decline_renter', 'bridge_next']);
    expect(t.session.completed).toEqual([]);
    expect(t.audit.map((d) => d.type)).toEqual(['gate', 'form_stopped', 'handoff', 'call_ended']);
  });
});

/** A turn context on a fresh set of the fixture's systems. */
const turnContext = (): TurnContext => ({ nowMs: 0, todayIso: TODAY, thresholds: { ...DEFAULT_THRESHOLDS }, tools: { sys: new ScreenedSystems(), lookups: { ownerOf: () => null, scopeOf: () => [] }, codes: mockCodeVerifier } });

/** A session of `app` in book_visit, entered, with `values` filled. */
function inBooking(app: App, values: Record<string, [string, string]>): Session {
  const s = newSession('hand', 0, VOICE_RELAY, ANONYMOUS, app.id);
  setForm(s, 'book_visit');
  s.entered = 'book_visit';
  for (const [id, [value, display]] of Object.entries(values)) s.slots[id] = { ...s.slots[id]!, value, display };
  return s;
}

describe('a keypad fill of a check\'s slot', () => {
  // The fixture's ownership slot has no keypad rung: this variant keys it, 1 to own and 2 to rent.
  const spec = screenedApp.slots.ownership!;
  const keyed = variant('screened-keypad', screenedApp.forms.book_visit!.checks!, {
    slots: {
      ...screenedApp.slots,
      ownership: {
        ...spec,
        dtmf: { length: 1, parse: (d) => (d === '1' ? { value: 'own', display: 'you own it' } : d === '2' ? { value: 'rent', display: 'you rent it' } : null) },
      },
    },
  });
  function atOwnership(): Session {
    use(keyed);
    const s = inBooking(keyed, { problem: ['leak', 'a leak'] });
    s.promptedFor = 'ownership';
    s.lastPromptId = 'ask_ownership';
    return s;
  }

  it('runs the check as a spoken fill does: a renter keyed in is told at once', () => {
    const t = resolve(atOwnership(), keyEvents('2')[0]!, null, turnContext());
    expect(t.decision).toMatchObject({ kind: 'complete', form: 'book_visit', promptId: 'decline_renter', completed: [] });
    expect(gates(t)).toEqual(['checkOwner:BLOCK:not-owner']);
    expect(rows(t)).toEqual(['gate', 'form_stopped', 'call_ended']);
  });

  it('an owner keyed in passes the check and is asked the town', () => {
    const t = resolve(atOwnership(), keyEvents('1')[0]!, null, turnContext());
    expect(gates(t)).toEqual(['checkOwner:ALLOW']);
    expect(t.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_town' });
    expect(Object.keys(t.session.checked ?? {})).toEqual(['checkOwner']);
  });
});

describe('a value carried into the form', () => {
  // Ownership carried for the call (App.carrySlots): a renter turned away with anything-else, who
  // then asks for a visit again, is refused as the form is entered, before its first question.
  const carried = variant('screened-carried', [OWNER({ 'not-owner': { say: 'decline_renter', then: 'anything-else' } })], { carrySlots: ['ownership'] });

  it('is checked on the turn the form is entered: refused before any question, with no "Sure, I can help"', async () => {
    use(carried);
    const r = await call("there's water in my basement", 'I rent it', 'can someone come and look at a crack in my wall');
    expect(r.runs[2]!.result.decision).toMatchObject({ kind: 'prompt', promptId: 'anything_else' });
    // Kept past the form: the carried answer is still rent.
    expect(r.runs[2]!.result.session.slots.ownership!.value).toBe('rent');
    const t = last(r);
    expect(t.session.form).toBeNull();
    expect(gates(t)).toEqual(['checkOwner:BLOCK:not-owner']);
    expect(ackIds(t)).toEqual(['decline_renter']);
    expect(t.decision).toMatchObject({ kind: 'prompt', promptId: 'anything_else' });
    expect(t.stopped).toEqual({ form: 'book_visit', action: 'checkOwner', reason: 'not-owner', then: 'anything-else' });
  });

  it('bridged into from the queue: refused without "Now, let\'s ..." before the refusal', () => {
    // A form finished with book_visit queued (here `urgent`, made to say its line and carry on).
    const app: App = {
      ...carried,
      id: 'screened-bridged',
      intents: { ...carried.intents, urgent: { ...carried.intents.urgent!, priority: false } },
      forms: { ...carried.forms, urgent: { ...carried.forms.urgent!, complete: (c) => ({ kind: 'said', acks: c.acks }) } },
    };
    use(app);
    const s = newSession('bridged', 0, VOICE_RELAY, ANONYMOUS, app.id);
    s.slots.ownership = { ...s.slots.ownership!, value: 'rent', display: 'you rent it' };
    setForm(s, 'urgent');
    s.entered = 'urgent';
    s.queued = ['book_visit'];
    s.pendingConfirmation = { target: 'form', form: 'urgent', attempts: 0 };
    s.promptedFor = 'confirm';
    const t = resolve(s, speechEvent('yes', true), { ...PLAIN, confirmsYes: noul(0.95), confirmsNo: noul(0.02) }, turnContext());
    expect(gates(t)).toEqual(['checkOwner:BLOCK:not-owner']);
    expect(ackIds(t)).toEqual(['decline_renter']);
    expect(t.decision).toMatchObject({ kind: 'prompt', promptId: 'anything_else' });
    expect(t.session.completed).toEqual(['urgent']);
  });
});

describe('a detail named at the summary with another value in the same breath', () => {
  // "The town's wrong, and I rent it": by default the new value sets the naming aside and the turn is
  // a no with a correction; where the naming decides (changeSlotWithValue: decides), the town is
  // reopened and the ownership filled. Either way the check runs on this turn.
  const FULL: Record<string, [string, string]> = {
    problem: ['leak', 'a leak'], ownership: ['own', 'you own it'], town: ['cedar_falls', 'Cedar Falls'],
    howUrgent: ['routine', 'whenever suits'], visitDay: ['monday', 'Monday'], timeOfDay: ['morning', 'the morning'],
  };
  function atSummary(app: App): Session {
    use(app);
    const s = inBooking(app, FULL);
    expect(runChecks(s, 'book_visit', turnContext(), newTurnOut())).toMatchObject({ kind: 'passed' });
    s.pendingConfirmation = { target: 'form', form: 'book_visit', attempts: 0 };
    s.promptedFor = 'confirm';
    s.lastPromptId = 'confirm_book_visit';
    return s;
  }
  const answers = { ...PLAIN, confirmsYes: noul(0.05), confirmsNo: noul(0.7), changeSlot: choice({ town: 0.9, none: 0.1 }), ownership: choice({ rent: 0.95, none: 0.05 }) };

  for (const [mode, app] of [['set-aside', screenedApp], ['decides', { ...screenedApp, id: 'screened-decides', changeSlotWithValue: 'decides' } as App]] as const) {
    it(`refuses on that turn (${mode})`, () => {
      const t = resolve(atSummary(app), speechEvent("the town's wrong, and I rent it", true), answers, turnContext());
      expect(gates(t)).toEqual(['checkOwner:BLOCK:not-owner']);
      expect(t.decision).toMatchObject({ kind: 'complete', promptId: 'decline_renter', completed: [] });
      expect(t.stopped?.action).toBe('checkOwner');
    });
  }
});

describe('the session', () => {
  function inForm(): Session {
    const s = newSession('session', 0, VOICE_RELAY, ANONYMOUS, screenedApp.id);
    setForm(s, 'book_visit');
    s.entered = 'book_visit';
    return s;
  }
  const tc = (): TurnContext => ({ nowMs: 0, todayIso: TODAY, thresholds: { ...DEFAULT_THRESHOLDS }, tools: { sys: new ScreenedSystems(), lookups: { ownerOf: () => null, scopeOf: () => [] }, codes: mockCodeVerifier } });

  it('has no checked field until a check passes, and runs a check again only when what it reads changes', () => {
    const s = inForm();
    expect('checked' in s).toBe(false);
    s.slots.ownership = { ...s.slots.ownership!, value: 'own', display: 'you own it' };
    const out = newTurnOut();
    expect(runChecks(s, 'book_visit', tc(), out)).toEqual({ kind: 'passed', passedPromptId: null });
    expect(out.gateEvents.map((e) => e.decision.call.tool)).toEqual(['checkOwner']);
    // The same value again: the gate is not asked.
    const again = newTurnOut();
    runChecks(s, 'book_visit', tc(), again);
    expect(again.gateEvents).toEqual([]);
    // A slot reopened and given the same value does not run its check again either.
    s.slots.ownership = { ...s.slots.ownership!, value: null, display: null };
    runChecks(s, 'book_visit', tc(), again);
    s.slots.ownership = { ...s.slots.ownership!, value: 'own', display: 'you own it' };
    runChecks(s, 'book_visit', tc(), again);
    expect(again.gateEvents).toEqual([]);
    // Every check passed: the line is due on the run that passes the last.
    s.slots.town = { ...s.slots.town!, value: 'ashford', display: 'Ashford' };
    s.slots.howUrgent = { ...s.slots.howUrgent!, value: 'soon', display: 'soon' };
    expect(runChecks(s, 'book_visit', tc(), newTurnOut())).toEqual({ kind: 'passed', passedPromptId: 'visit_qualifies' });
    expect(Object.keys(s.checked!).sort()).toEqual(['checkArea', 'checkOwner', 'checkUrgency']);
    // A copy is its own.
    const copy = cloneSession(s);
    copy.checked!.checkOwner = 'changed';
    expect(s.checked!.checkOwner).not.toBe('changed');
  });

  it('forgets the checks when the form closes or another is entered', () => {
    const s = inForm();
    s.checked = { checkOwner: 'x' };
    closeForm(s);
    expect('checked' in s).toBe(false);
    const t = inForm();
    t.checked = { checkOwner: 'x' };
    setForm(t, 'urgent');
    expect('checked' in t).toBe(false);
  });

  it('keeps what the checks passed with across a restart (SESSION_STORE=file): an unchanged answer asks the gate nothing, a changed one runs the check', async () => {
    const r = await call("there's water in my basement", 'yes, I own it');
    const before = last(r).session;
    expect(Object.keys(before.checked ?? {})).toEqual(['checkOwner']);
    const dir = mkdtempSync(join(tmpdir(), 'dialogwright-checked-'));
    try {
      openFileStores(dir, { tokenTtlMs: 60_000 }).calls.save(contractCall('CA0001', 3, { session: before }));
      const saved = openFileStores(dir, { tokenTtlMs: 60_000 }).calls.load('CA0001')!.session;
      expect(saved.checked).toEqual(before.checked);
      // "Yes, I own it" again, then "I rent it", on the session the next process read back.
      const again = resolve(saved, speechEvent('I own it', true), { ...PLAIN, ownership: choice({ own: 0.95, none: 0.05 }) }, turnContext());
      expect(again.gateEvents).toEqual([]);
      const changed = resolve(saved, speechEvent('I rent it', true), { ...PLAIN, ownership: choice({ rent: 0.95, none: 0.05 }) }, turnContext());
      expect(gates(changed)).toEqual(['checkOwner:BLOCK:not-owner']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('an app without checks', () => {
  it('runs nothing and keeps no checked field on its sessions', () => {
    use(testkitApp);
    const s = newSession('kit', 0, VOICE_RELAY, ANONYMOUS, testkitApp.id);
    setForm(s, Object.keys(testkitApp.forms)[0]!);
    const out = newTurnOut();
    expect(runChecks(s, s.form!, { nowMs: 0, todayIso: TODAY, thresholds: { ...DEFAULT_THRESHOLDS }, tools: { ...testkitApp.systems(), codes: mockCodeVerifier } }, out)).toEqual({ kind: 'passed', passedPromptId: null });
    expect(out.gateEvents).toEqual([]);
    expect('checked' in s).toBe(false);
  });
});
