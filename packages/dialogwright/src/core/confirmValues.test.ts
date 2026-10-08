import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { runScenario, type ScenarioRun, type ScenarioStep } from '../harness-text/runner';
import { loadCorpus } from '../jev/corpus';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { spokenText } from '../prompts/render';
import { choice, noul, score } from '../testing/answers';
import { registerApp, resetAppsForTest } from './app/registry';
import type { App } from './app/types';
import { DEFAULT_THRESHOLDS } from './thresholds';
import { newSession, setForm, type Session } from './session';
import { pendingAtSignIn, resolve, type TurnContext, type TurnResult } from './turn';
import { silenceEvent, speechEvent } from '../channel/events';
import { VOICE_RELAY, WEB_CHAT } from '../channel/caps';
import { ANONYMOUS } from '../gate/principal';
import { mockCodeVerifier } from './tools';
import { SCREENED_DIR, ScreenedSystems, screenedApp } from '../testing/screened/app';
import { CONFIRMING, CONFIRMING_LINES, replace, screenedVariants } from '../testing/screened/variant';

/**
 * A read-back the app asks for (design 2026-10-08-confirm-on-values): a slot read back for its
 * values (a choice slot's `confirmValues`), and a check's refusal read back before it acts (a check
 * outcome's `confirm`). On a variant of the engine's fixture for checks (src/testing/screened): the
 * ownership slot reads "rent" back and not "own", and the area check reads its refusal back first.
 * The fixture itself is unchanged: core/checks.test.ts holds it to its own calls.
 */

const TODAY = '2026-09-18';
const FIXTURES = join(SCREENED_DIR, 'fixtures');

const variants = screenedVariants();
afterAll(() => variants.remove());

/** The fixture with "rent" read back at once, and the area check's refusal read back first. */
const confirming = variants.variant(CONFIRMING);

/** Registers `app` as the only (so the default) app: the harness runs against the default. */
function use(app: App): void {
  resetAppsForTest();
  registerApp(app);
}

// The corpus is read against the fixture: its slots and labels are the variant's too.
use(screenedApp);
const corpus = loadCorpus(join(FIXTURES, 'corpus.jsonl'));
const client = new FixtureStubClient(corpus, { sharpness: DEFAULT_THRESHOLDS.STUB_SHARPNESS, fallback: new HeuristicStubClient({ todayIso: TODAY }) });

beforeEach(() => use(confirming));

/** A call: the greeting, then each step in turn (a line said, or a silence). */
async function call(...steps: (string | ScenarioStep)[]): Promise<ScenarioRun> {
  return runScenario(
    { id: 'call', steps: steps.map((step) => (typeof step === 'string' ? { say: step } : step)), expect: { decision: 'any' } },
    { client, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, now: () => 0 },
  );
}

const SILENCE: ScenarioStep = { silence: true };
const last = (r: ScenarioRun): TurnResult => r.runs.at(-1)!.result;
const turn = (r: ScenarioRun, i: number): TurnResult => r.runs[i]!.result;
const heard = (t: TurnResult): string => spokenText(confirming, t.decision);
const gates = (t: TurnResult): string[] => t.gateEvents.map((e) => `${e.decision.call.tool}:${e.decision.verdict}${e.decision.reason ? `:${e.decision.reason}` : ''}`);
const rows = (t: TurnResult): string[] => t.audit.map((d) => d.type);
const ackIds = (t: TurnResult): string[] => ('acks' in t.decision ? t.decision.acks.map((a) => a.promptId) : []);

const RENTER_LINE = "Thank you for calling. Our visits are for homeowners, so I'm sorry we can't help with a rented home, but the owner is welcome to call us. Goodbye.";
const AREA_LINE = "Thank you for calling. We only work in Millbrook, Cedar Falls, Ashford and Riverton, so I'm sorry we can't help with a home outside them. Goodbye.";
const AREA_READ_BACK = 'Just to check, the home is in another town, not one of our four towns?';

describe('a value read back (confirmValues)', () => {
  it('builds: the ownership slot reads "rent" back, and only "rent"', () => {
    expect(confirming.slots.ownership).toMatchObject({ spokenConfirm: 'summary', confirmValues: ['rent'], readBackNo: 'ask' });
    expect(screenedApp.slots.ownership).not.toHaveProperty('confirmValues');
    expect(screenedApp.slots.ownership).not.toHaveProperty('readBackNo');
  });

  it('a renter is read back before the check runs, and a yes ends the call', async () => {
    const r = await call("there's water in my basement", 'I rent it', 'yes');
    const readBack = turn(r, 2);
    expect(readBack.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_ownership', target: 'ownership', vars: { ownership: 'you rent it' } });
    expect(heard(readBack)).toBe('Just to check, you rent it?');
    // The value is not settled, so no check reads it yet.
    expect(readBack.gateEvents).toEqual([]);
    expect(readBack.session.pendingConfirmation).toMatchObject({ target: 'slot', slot: 'ownership', value: 'rent' });
    const t = last(r);
    expect(t.session.slots.ownership).toMatchObject({ value: 'rent', confirmed: true });
    expect(gates(t)).toEqual(['checkOwner:BLOCK:not-owner']);
    expect(heard(t)).toBe(RENTER_LINE);
    // The check itself reads nothing back: the slot's read-back already confirmed what it reads.
    expect(t.audit.find((d) => d.type === 'form_stopped')!.detail).toEqual({ form: 'book_visit', action: 'checkOwner', reason: 'not-owner', then: 'end' });
  });

  it('a misheard renter says no: the slot is emptied and asked again, and the caller qualifies', async () => {
    const r = await call("there's water in my basement", 'I rent it', 'no', 'yes, I own it');
    const no = turn(r, 3);
    expect(no.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_ownership', target: 'ownership' });
    expect(ackIds(no)).toEqual(['ack_declined']);
    expect(heard(no)).toBe("Okay, let's keep going. Do you own the home, or rent it?");
    expect(no.session.slots.ownership).toMatchObject({ value: null, confirmed: false });
    expect(no.session.pendingConfirmation).toBeNull();
    expect(no.gateEvents).toEqual([]);
    const t = last(r);
    expect(gates(t)).toEqual(['checkOwner:ALLOW']);
    expect(heard(t)).toBe('Which town is the home in?');
  });

  it('a second no follows the ladder to a person', async () => {
    const t = last(await call("there's water in my basement", 'I rent it', 'no', 'I rent it', 'no'));
    expect(t.decision).toMatchObject({ kind: 'handoff', reason: 'max-attempts' });
    expect(t.gateEvents).toEqual([]);
  });

  it('"own" is not read back: the check runs on the turn it is said', async () => {
    const t = last(await call("there's water in my basement", 'yes, I own it'));
    expect(gates(t)).toEqual(['checkOwner:ALLOW']);
    expect(heard(t)).toBe('Which town is the home in?');
    expect(t.session.slots.ownership).toMatchObject({ value: 'own', confirmed: false });
  });

  it('a read-back nobody answers: asked again, then the slot asked again on its retry (it takes no keys), then a person', async () => {
    const r = await call("there's water in my basement", 'I rent it', SILENCE, SILENCE, SILENCE);
    expect(turn(r, 3).decision).toMatchObject({ promptId: 'confirm_ownership' });
    expect(ackIds(turn(r, 3))).toEqual(['no_input']);
    expect(turn(r, 4).decision).toMatchObject({ promptId: 'ask_ownership_retry', target: 'ownership' });
    expect(turn(r, 4).session.slots.ownership!.value).toBeNull();
    expect(last(r).decision).toMatchObject({ kind: 'handoff', reason: 'max-attempts' });
  });
});

describe('a check\'s refusal read back (on.<reason>.confirm)', () => {
  it('builds: the outcome carries its read-back line', () => {
    expect(confirming.forms.book_visit!.checks!.find((c) => c.action === 'checkArea')!.on).toEqual({ 'out-of-area': { confirm: 'check_area', say: 'decline_out_of_area', then: 'end' } });
  });

  it('pauses on the read-back: the refusal does not act, nothing is recorded as stopped', async () => {
    const r = await call('can someone come and look at a crack in my wall', 'yes, I own it', 'Lakeview');
    const t = last(r);
    expect(gates(t)).toEqual(['checkArea:BLOCK:out-of-area']);
    expect(t.decision).toMatchObject({ kind: 'prompt', promptId: 'check_area', target: 'confirm', options: ['yes', 'no'] });
    expect(heard(t)).toBe(AREA_READ_BACK);
    expect(t.session.pendingConfirmation).toEqual({ target: 'check', form: 'book_visit', action: 'checkArea', verdict: 'BLOCK', reason: 'out-of-area', hash: expect.any(String), attempts: 0 });
    expect(t.stopped).toBeUndefined();
    expect(rows(t)).toEqual(['gate']);
    expect(t.session.form).toBe('book_visit');
    // The model is told what is read back: the slot's value, as for a slot's read-back.
    const next = await call('can someone come and look at a crack in my wall', 'yes, I own it', 'Lakeview', 'hmm');
    expect(next.runs.at(-1)!.result.turnState?.pendingConfirmation).toEqual({ target: 'town', value: 'another town' });
  });

  it('a yes: the slots it reads are confirmed and the refusal acts as written, recorded as confirmed', async () => {
    const t = last(await call('can someone come and look at a crack in my wall', 'yes, I own it', 'Lakeview', 'yes'));
    expect(t.decision).toMatchObject({ kind: 'complete', form: 'book_visit', promptId: 'decline_out_of_area', completed: [] });
    expect(heard(t)).toBe(AREA_LINE);
    // The gate is not asked again: its refusal stood on the read-back.
    expect(t.gateEvents).toEqual([]);
    expect(rows(t)).toEqual(['form_stopped', 'call_ended']);
    expect(t.audit[0]).toEqual({ type: 'form_stopped', detail: { form: 'book_visit', action: 'checkArea', reason: 'out-of-area', then: 'end', confirmed: true } });
    expect(t.stopped).toEqual({ form: 'book_visit', action: 'checkArea', reason: 'out-of-area', then: 'end', confirmed: true });
    expect(t.session.slots.town).toMatchObject({ value: 'elsewhere', confirmed: true });
    expect(t.session.pendingConfirmation).toBeNull();
  });

  it('a no: the slots it reads are emptied and asked again, the audit says so, and the check runs again when they fill', async () => {
    const r = await call('can someone come and look at a crack in my wall', 'yes, I own it', 'Lakeview', 'no', 'Cedar Falls');
    const no = turn(r, 4);
    expect(no.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_town', target: 'town' });
    expect(ackIds(no)).toEqual(['ack_declined']);
    expect(heard(no)).toBe("Okay, let's keep going. Which town is the home in?");
    expect(no.session.slots.town).toMatchObject({ value: null, confirmed: false });
    expect(no.session.checked).toEqual({ checkOwner: expect.any(String) });
    expect(no.session.pendingConfirmation).toBeNull();
    expect(no.stopped).toBeUndefined();
    expect(no.audit).toEqual([{ type: 'check_reconfirmed', detail: { form: 'book_visit', action: 'checkArea', reason: 'out-of-area' } }]);
    const t = last(r);
    expect(gates(t)).toEqual(['checkArea:ALLOW']);
    expect(heard(t)).toBe('How soon does it need looking at?');
  });

  it('a second no follows the ladder to a person', async () => {
    const t = last(await call('can someone come and look at a crack in my wall', 'yes, I own it', 'Lakeview', 'no', 'Lakeview', 'no'));
    expect(t.decision).toMatchObject({ kind: 'handoff', reason: 'max-attempts' });
  });

  it('silence at the read-back: asked again, then a person, and the refusal never acts on it', async () => {
    const r = await call('can someone come and look at a crack in my wall', 'yes, I own it', 'Lakeview', SILENCE, SILENCE, SILENCE);
    expect(turn(r, 4).decision).toMatchObject({ promptId: 'check_area', target: 'confirm' });
    expect(ackIds(turn(r, 4))).toEqual(['no_input']);
    expect(turn(r, 5).decision).toMatchObject({ promptId: 'check_area' });
    const t = last(r);
    expect(t.decision).toMatchObject({ kind: 'handoff', reason: 'max-attempts' });
    expect(r.runs.some((run) => run.result.stopped !== undefined)).toBe(false);
    expect(r.runs.some((run) => run.result.decision.kind === 'complete')).toBe(false);
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

/** A turn context on a fresh set of the fixture's systems. */
const turnContext = (): TurnContext => ({ nowMs: 0, todayIso: TODAY, thresholds: { ...DEFAULT_THRESHOLDS }, tools: { sys: new ScreenedSystems(), lookups: { ownerOf: () => null, scopeOf: () => [] }, codes: mockCodeVerifier } });

/** A session of the variant at book_visit's summary, every slot filled (the town outside the area), no check run yet. */
function atSummary(): Session {
  const s = newSession('hand', 0, VOICE_RELAY, ANONYMOUS, confirming.id);
  setForm(s, 'book_visit');
  s.entered = 'book_visit';
  const values: Record<string, [string, string]> = {
    problem: ['leak', 'a leak'], ownership: ['own', 'you own it'], town: ['elsewhere', 'another town'],
    howUrgent: ['routine', 'whenever suits'], visitDay: ['monday', 'Monday'], timeOfDay: ['morning', 'the morning'],
  };
  for (const [id, [value, display]] of Object.entries(values)) s.slots[id] = { ...s.slots[id]!, value, display };
  s.pendingConfirmation = { target: 'form', form: 'book_visit', attempts: 0 };
  s.promptedFor = 'confirm';
  s.lastPromptId = 'confirm_book_visit';
  return s;
}

describe('a refusal at the summary\'s yes', () => {
  it('is not read back: the summary read every value, and the yes confirmed them', () => {
    const t = resolve(atSummary(), speechEvent('yes, book it', true), { ...PLAIN, confirmsYes: noul(0.95), confirmsNo: noul(0.02) }, turnContext());
    expect(gates(t).at(-1)).toBe('checkArea:BLOCK:out-of-area');
    expect(t.decision).toMatchObject({ kind: 'complete', promptId: 'decline_out_of_area' });
    expect(t.stopped).toEqual({ form: 'book_visit', action: 'checkArea', reason: 'out-of-area', then: 'end' });
  });

  it('is read back when the yes changed the value it reads ("yes, but it is in Lakeview"): the summary never said it', () => {
    const s = atSummary();
    s.slots.town = { ...s.slots.town!, value: 'ashford', display: 'Ashford' };
    const t = resolve(s, speechEvent("yes, but it's in Lakeview", true), { ...PLAIN, confirmsYes: noul(0.95), confirmsNo: noul(0.02), town: choice({ elsewhere: 0.95, none: 0.05 }) }, turnContext());
    expect(gates(t).at(-1)).toBe('checkArea:BLOCK:out-of-area');
    expect(t.decision).toMatchObject({ kind: 'prompt', promptId: 'check_area', target: 'confirm' });
    expect(t.session.pendingConfirmation).toMatchObject({ target: 'check', action: 'checkArea' });
  });
});

describe('a value read back at the summary\'s yes', () => {
  it('"yes, but I rent it": "rent" is read back before any check or the write', async () => {
    const r = await call("there's water in my basement", 'yes, I own it', 'Cedar Falls', 'it can wait, whenever suits', 'Monday', 'the morning', 'yes, but I rent it');
    const t = last(r);
    expect(t.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_ownership', target: 'ownership' });
    expect(t.gateEvents).toEqual([]);
    expect(t.session.pendingConfirmation).toMatchObject({ target: 'slot', slot: 'ownership', value: 'rent' });
  });
});

describe('a value read back with a detail named at the summary', () => {
  it('"the town is wrong, and I rent it" (where the naming decides): "rent" is read back before the check runs', () => {
    const app: App = { ...confirming, changeSlotWithValue: 'decides' };
    use(app);
    const s = atSummary();
    s.appId = app.id;
    s.slots.town = { ...s.slots.town!, value: 'ashford', display: 'Ashford' };
    s.checked = {};
    const answers = { ...PLAIN, confirmsYes: noul(0.02), confirmsNo: noul(0.95), changeSlot: choice({ town: 0.95, none: 0.05 }), ownership: choice({ rent: 0.95, none: 0.05 }) };
    const t = resolve(s, speechEvent('the town is wrong, and I rent it', true), answers, turnContext());
    expect(t.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_ownership' });
    expect(t.gateEvents).toEqual([]);
    expect(t.session.slots.town!.value).toBeNull();
  });
});

describe('a no to a slot that takes keys', () => {
  /** The variant with the ownership slot keyed too (1 to own, 2 to rent), and its keypad line. */
  const keyed = variants.variant({
    'app.yaml': replace('id: screened', 'id: screened-keyed'),
    'slots.yaml': replace('ownership:\n  type: choice\n', 'ownership:\n  type: choice\n  keypad: true\n  confirmValues: [rent]\n'),
    'prompts.yaml': (t) => `${t}${CONFIRMING_LINES}  ask_ownership_dtmf:\n    text: Press 1 if you own the home, or 2 if you rent it.\n    interruptible: true\n`,
  });

  /** A session of `keyed` on `channel`, "rent" heard and read back, after `misses` missed answers to the slot. */
  function readingBack(channel: typeof VOICE_RELAY, misses = 0): Session {
    const s = newSession('keyed', 0, channel, ANONYMOUS, keyed.id);
    setForm(s, 'book_visit');
    s.entered = 'book_visit';
    s.slots.problem = { ...s.slots.problem!, value: 'leak', display: 'a leak' };
    s.slots.ownership = { ...s.slots.ownership!, value: 'rent', display: 'you rent it', attempts: misses };
    s.pendingConfirmation = { target: 'slot', slot: 'ownership', value: 'rent', display: 'you rent it' };
    s.promptedFor = 'ownership';
    s.lastPromptId = 'confirm_ownership';
    return s;
  }
  const no = { ...PLAIN, confirmsYes: noul(0.02), confirmsNo: noul(0.95) };

  it('the no is one step on the slot\'s ladder: asked in words first, on the keypad once the ladder reaches it', () => {
    use(keyed);
    const first = resolve(readingBack(VOICE_RELAY), speechEvent('no', true), no, turnContext());
    expect(first.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_ownership', target: 'ownership' });
    expect(ackIds(first)).toEqual(['ack_declined']);
    expect(first.session.slots.ownership).toMatchObject({ value: null, attempts: 1, readBackNos: 1 });
    const missed = resolve(readingBack(VOICE_RELAY, 1), speechEvent('no', true), no, turnContext());
    expect(missed.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_ownership_dtmf', target: 'ownership' });
  });

  it('on a chat, which has no keypad: asked again in words', () => {
    use(keyed);
    const t = resolve(readingBack(WEB_CHAT, 1), speechEvent('no', true), no, turnContext());
    expect(t.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_ownership', target: 'ownership' });
  });
});

describe('after a no, the question asked again walks its own ladder', () => {
  it('a slot: a silence after the no is asked again, not a person', async () => {
    const r = await call("there's water in my basement", 'I rent it', 'no', SILENCE);
    expect(last(r).decision).toMatchObject({ kind: 'prompt', target: 'ownership' });
    expect(ackIds(last(r))).toEqual(['no_input']);
  });

  it('a slot: an answer that misses after the no is retried, not a person', async () => {
    const r = await call("there's water in my basement", 'I rent it', 'no', 'hello');
    expect(last(r).decision).toMatchObject({ kind: 'prompt', promptId: 'ask_ownership_retry', target: 'ownership' });
  });

  it('a check: a silence after the no is asked again, not a person', async () => {
    const r = await call('can someone come and look at a crack in my wall', 'yes, I own it', 'Lakeview', 'no', SILENCE);
    expect(last(r).decision).toMatchObject({ kind: 'prompt', target: 'town' });
    expect(ackIds(last(r))).toEqual(['no_input']);
  });

  it('a check: an answer that misses after the no is retried, not a person', async () => {
    const r = await call('can someone come and look at a crack in my wall', 'yes, I own it', 'Lakeview', 'no', 'hello');
    expect(last(r).decision).toMatchObject({ kind: 'prompt', promptId: 'ask_town_retry', target: 'town' });
  });

  it('a check: no, the slot filled again, and no again: a person', async () => {
    const r = await call('can someone come and look at a crack in my wall', 'yes, I own it', 'Lakeview', 'no', 'Lakeview', 'no');
    expect(turn(r, 5).decision).toMatchObject({ promptId: 'check_area' });
    expect(last(r).decision).toMatchObject({ kind: 'handoff', reason: 'max-attempts' });
    expect(last(r).session.checkReadBackNos).toEqual({ checkArea: 2 });
  });
});

describe('a check\'s read-back whose slots changed while it was out', () => {
  /** The read-back of the area check out, then the town changed by a fill the turn made (an informational answer's breath, say). */
  async function changedUnderIt(): Promise<Session> {
    const r = await call('can someone come and look at a crack in my wall', 'yes, I own it', 'Lakeview');
    const s = last(r).session;
    expect(s.pendingConfirmation).toMatchObject({ target: 'check', action: 'checkArea' });
    s.slots.town = { ...s.slots.town!, value: 'cedar_falls', display: 'Cedar Falls' };
    return s;
  }

  it('a yes does not act on the old refusal: the check runs again on what the slots hold now', async () => {
    const s = await changedUnderIt();
    const t = resolve(s, speechEvent('yes', true), { ...PLAIN, confirmsYes: noul(0.95), confirmsNo: noul(0.02) }, turnContext());
    expect(gates(t)).toEqual(['checkArea:ALLOW']);
    expect(t.stopped).toBeUndefined();
    expect(t.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_howUrgent' });
  });

  it('asked again (a silence) it is not: the check runs again', async () => {
    const s = await changedUnderIt();
    const t = resolve(s, silenceEvent(), null, turnContext());
    expect(gates(t)).toEqual(['checkArea:ALLOW']);
    expect(t.session.pendingConfirmation).toBeNull();
  });
});

describe('a check no empties only what was not confirmed', () => {
  it('a slot confirmed at its own read-back is kept; the unconfirmed one is asked again', () => {
    const both: App = {
      ...confirming,
      forms: {
        ...confirming.forms,
        book_visit: { ...confirming.forms.book_visit!, checks: confirming.forms.book_visit!.checks!.map((c) => (c.action === 'checkArea' ? { ...c, with: ['ownership', 'town'] } : c)) },
      },
    };
    use(both);
    const s = newSession('both', 0, VOICE_RELAY, ANONYMOUS, both.id);
    setForm(s, 'book_visit');
    s.entered = 'book_visit';
    s.slots.problem = { ...s.slots.problem!, value: 'leak', display: 'a leak' };
    s.slots.ownership = { ...s.slots.ownership!, value: 'own', display: 'you own it', confirmed: true };
    s.promptedFor = 'town';
    const heardTown = resolve(s, speechEvent('Lakeview', true), { ...PLAIN, town: choice({ elsewhere: 0.95, none: 0.05 }) }, turnContext());
    expect(heardTown.decision).toMatchObject({ promptId: 'check_area' });
    const t = resolve(heardTown.session, speechEvent('no', true), { ...PLAIN, confirmsYes: noul(0.02), confirmsNo: noul(0.95) }, turnContext());
    expect(t.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_town' });
    expect(t.session.slots.ownership).toMatchObject({ value: 'own', confirmed: true });
    expect(t.session.slots.town!.value).toBeNull();
  });
});

describe('a no with the right answer in the same breath', () => {
  /** The read-back of "rent" out, as the call left it. */
  async function rentReadBack(): Promise<Session> {
    const r = await call("there's water in my basement", 'I rent it');
    expect(last(r).decision).toMatchObject({ promptId: 'confirm_ownership' });
    return last(r).session;
  }
  const no = { ...PLAIN, confirmsYes: noul(0.02), confirmsNo: noul(0.95) };

  it('"no, I own it": the slot takes it, and the form goes on (the check runs on it)', async () => {
    const t = resolve(await rentReadBack(), speechEvent('no, I own it', true), { ...no, ownership: choice({ own: 0.95, none: 0.05 }) }, turnContext());
    expect(t.session.slots.ownership).toMatchObject({ value: 'own', confirmed: false });
    expect(gates(t)).toEqual(['checkOwner:ALLOW']);
    expect(t.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_town' });
    expect(ackIds(t)).toEqual(['ack_declined']);
  });

  it('a value it gives that is itself read back is read back', async () => {
    const both: App = { ...confirming, slots: { ...confirming.slots, ownership: { ...confirming.slots.ownership!, confirmValues: ['own', 'rent'] } } };
    use(both);
    const t = resolve(await rentReadBack(), speechEvent('no, I own it', true), { ...no, ownership: choice({ own: 0.95, none: 0.05 }) }, turnContext());
    expect(t.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_ownership', vars: { ownership: 'you own it' } });
    expect(t.gateEvents).toEqual([]);
  });

  it('the value just declined, heard again, is not taken: the slot is asked again', async () => {
    const t = resolve(await rentReadBack(), speechEvent('no', true), { ...no, ownership: choice({ rent: 0.95, none: 0.05 }) }, turnContext());
    expect(t.session.slots.ownership!.value).toBeNull();
    expect(t.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_ownership' });
  });

  it('a bare no fills nothing', async () => {
    const t = resolve(await rentReadBack(), speechEvent('no', true), { ...no, ownership: choice({ none: 0.95, own: 0.05 }) }, turnContext());
    expect(t.session.slots.ownership!.value).toBeNull();
    expect(t.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_ownership' });
  });

  it('a check: "no, it\'s in Ashford" fills the town, and the check runs again and passes', async () => {
    const r = await call('can someone come and look at a crack in my wall', 'yes, I own it', 'Lakeview', "no, it's in Ashford");
    const t = last(r);
    expect(t.session.slots.town).toMatchObject({ value: 'ashford' });
    expect(gates(t)).toEqual(['checkArea:ALLOW']);
    expect(rows(t)).toEqual(['check_reconfirmed', 'gate']);
    expect(heard(t)).toBe("Okay, let's keep going. How soon does it need looking at?");
  });
});

describe('a portal sign-in while a check\'s read-back is out', () => {
  const check = { target: 'check', form: 'book_visit', action: 'checkArea', verdict: 'BLOCK', reason: 'out-of-area', hash: 'h', attempts: 0 } as const;
  it('drops it, whether it is pending or a transfer offer displaced it: the check runs again on the parked form', () => {
    expect(pendingAtSignIn(check)).toBeNull();
    expect(pendingAtSignIn({ target: 'transfer', attempts: 0, resume: check })).toBeNull();
    // What it always kept, it keeps: a slot read-back, kept or restored.
    const slot = { target: 'slot', slot: 'ownership', value: 'rent', display: 'you rent it' } as const;
    expect(pendingAtSignIn(slot)).toBe(slot);
    expect(pendingAtSignIn({ target: 'transfer', attempts: 0, resume: slot })).toBe(slot);
    expect(pendingAtSignIn({ target: 'intent', intent: 'book_visit', answers: {}, text: 'x' })).toBeNull();
  });
});

describe('the fixture without the options', () => {
  it('reads nothing back: a renter ends on the turn they say so, and a town outside the area at once', async () => {
    use(screenedApp);
    const renter = last(await call("there's water in my basement", 'I rent it'));
    expect(renter.decision).toMatchObject({ kind: 'complete', promptId: 'decline_renter' });
    const area = last(await call('can someone come and look at a crack in my wall', 'yes, I own it', 'Lakeview'));
    expect(area.decision).toMatchObject({ kind: 'complete', promptId: 'decline_out_of_area' });
    expect(area.stopped).toEqual({ form: 'book_visit', action: 'checkArea', reason: 'out-of-area', then: 'end' });
  });
});
