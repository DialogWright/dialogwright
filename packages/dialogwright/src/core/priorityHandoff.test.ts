import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runScenario, type Scenario, type ScenarioRun } from '../harness-text/runner';
import { loadCorpus } from '../jev/corpus';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import type { JevClient, JevRequest } from '../jev/types';
import { choice, noul, score } from '../testing/answers';
import { registerApp, resetAppsForTest } from './app/registry';
import type { App, HandoffData, IntentPriority } from './app/types';
import { DEFAULT_THRESHOLDS } from './thresholds';
import { closeForm, newSession, setForm, type Session } from './session';
import { resolve, type TurnContext, type TurnResult } from './turn';
import { handoff, unconfirmedSlots } from './decision';
import { speechEvent } from '../channel/events';
import { VOICE_RELAY } from '../channel/caps';
import { ANONYMOUS } from '../gate/principal';
import { mockCodeVerifier } from './tools';
import { actionsToFrames } from '../channel/relay/map';
import { SCREENED_DIR, ScreenedSystems, screenedApp } from '../testing/screened/app';
import { CALLBACK_DIR, callbackApp } from '../testing/callback/app';
import { testkitApp } from '../testing/testkit';
import { openFileStores } from '../server/stores/file';
import { contractCall } from '../testing/storeContract';
import { sessionRoundTrip } from '../testing/sessionRoundTrip';

/**
 * A priority switch's correction (IntentDef.priority `correctsForm`) and the values a handoff names
 * as never confirmed (HandoffData.unconfirmed), on Example Home Visits (src/testing/screened), whose
 * `urgent` intent is a priority intent with `correctsForm` and whose handoff data marks what the
 * caller never confirmed. The trial's call: a caller who said the problem was getting worse, read
 * the whole booking back, then said "wait, water is coming through the wall right now".
 */

const TODAY = '2026-09-18';
// The corpus is read against the default app: the fixture is registered first.
resetAppsForTest();
registerApp(screenedApp);
const CORPUS = loadCorpus(join(SCREENED_DIR, 'fixtures', 'corpus.jsonl'));

/** The fixture stub, each request it was asked kept in `asked`. */
function stub(asked: JevRequest[] = []): JevClient {
  const inner = new FixtureStubClient(CORPUS, { sharpness: DEFAULT_THRESHOLDS.STUB_SHARPNESS, fallback: new HeuristicStubClient({ todayIso: TODAY }) });
  return { ask: (req) => { asked.push(req); return inner.ask(req); } };
}

function use(app: App): void {
  resetAppsForTest();
  registerApp(app);
}

beforeEach(() => use(screenedApp));

/** The fixture with its urgent intent's priority, and its handoff data, as given (undefined: none). */
function variant(id: string, priority: IntentPriority, data: HandoffData | undefined, over: Partial<App> = {}): App {
  return {
    ...screenedApp,
    id,
    intents: { ...screenedApp.intents, urgent: { ...screenedApp.intents.urgent!, priority } },
    handoff: data === undefined ? {} : { data },
    ...over,
  };
}

/** Today's engine: a priority intent with neither option. */
const PLAIN_PRIORITY = variant('screened-plain', true, undefined);

async function call(says: readonly string[], asked: JevRequest[] = []): Promise<ScenarioRun> {
  const scenario: Scenario = { id: 'call', steps: says.map((say) => ({ say })), expect: { decision: 'any' } };
  return runScenario(scenario, { client: stub(asked), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, now: () => 0 });
}

const last = (r: ScenarioRun): TurnResult => r.runs.at(-1)!.result;
const endData = (t: TurnResult): unknown => {
  const end = actionsToFrames(t.actions).at(-1);
  return end?.type === 'end' ? JSON.parse(end.handoffData) : null;
};

/** The trial's call: up to the read-back with the urgency "getting worse", then the emergency. */
const TO_SUMMARY = ["there's water in my basement", 'yes, I own it', 'Cedar Falls', "it's getting worse", 'Monday', 'the morning'] as const;
const EMERGENCY = 'wait, water is coming through the wall right now';
const ALL = ['problem', 'ownership', 'town', 'howUrgent', 'visitDay', 'timeOfDay'];

describe('an emergency said at the read-back, contradicting the urgency given earlier', () => {
  it('with correctsForm: the handoff carries what the caller just said', async () => {
    const r = await call([...TO_SUMMARY, EMERGENCY]);
    expect(r.runs.at(-2)!.result.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_book_visit' });
    expect(r.runs.at(-2)!.result.session.slots.howUrgent).toMatchObject({ value: 'soon', display: 'soon' });
    const t = last(r);
    expect(t.decision).toMatchObject({ kind: 'handoff', reason: 'urgent', promptId: 'handoff_urgent' });
    if (t.decision.kind !== 'handoff') throw new Error('not a handoff');
    expect(t.decision.slots).toEqual({ problem: 'a leak', ownership: 'you own it', town: 'Cedar Falls', howUrgent: 'right away', visitDay: 'Monday', timeOfDay: 'the morning' });
    expect(t.session.slots.howUrgent).toMatchObject({ value: 'urgent', display: 'right away', confirmed: false });
    // The correction says nothing: only the priority form's acknowledgement before the handoff line.
    expect(t.decision.acks.map((a) => a.promptId)).toEqual(['ack_intent']);
    // Its fill shows on the debug table's slot rows.
    expect(t.fillEvents.map((e) => e.slot)).toContain('howUrgent');
    // The form left is neither completed nor confirmed, and the summary is not pending any more.
    expect(t.session.form).toBe('urgent');
    expect(t.session.completed).toEqual([]);
    expect(t.session.pendingConfirmation).toBeNull();
  });

  it('without it (priority: true): today\'s value, the one the caller gave ten turns earlier', async () => {
    use(PLAIN_PRIORITY);
    const t = last(await call([...TO_SUMMARY, EMERGENCY]));
    expect(t.decision).toMatchObject({ kind: 'handoff', reason: 'urgent' });
    if (t.decision.kind !== 'handoff') throw new Error('not a handoff');
    expect(t.decision.slots.howUrgent).toBe('soon');
    expect(t.session.slots.howUrgent!.value).toBe('soon');
    expect(t.fillEvents.map((e) => e.slot)).not.toContain('howUrgent');
  });

  it('the same for a priority intent that is not one any more: a replacing switch corrects nothing', async () => {
    use(variant('screened-switch', false, { unconfirmed: 'mark' }));
    const t = last(await call([...TO_SUMMARY, EMERGENCY]));
    expect(t.decision).toMatchObject({ kind: 'handoff', reason: 'urgent', slots: { howUrgent: 'soon' } });
  });

  it('asks the model exactly what it asks without the option, on every turn', async () => {
    const withIt: JevRequest[] = [];
    const without: JevRequest[] = [];
    await call([...TO_SUMMARY, EMERGENCY], withIt);
    use(PLAIN_PRIORITY);
    await call([...TO_SUMMARY, EMERGENCY], without);
    expect(withIt.length).toBe(without.length);
    expect(JSON.stringify(withIt)).toBe(JSON.stringify(without));
  });

  it('runs no check on the way out: the switch wins over what a corrected value would make a check say', async () => {
    const t = last(await call([...TO_SUMMARY, EMERGENCY]));
    // checkUrgency hands "right away" to the office, and checkOwner ends the call for a renter: neither runs.
    expect(t.gateEvents).toEqual([]);
    expect(t.stopped).toBeUndefined();
    expect(t.session.checked).toBeUndefined();
  });
});

describe('the values the handoff names as never confirmed (handoff.data.unconfirmed)', () => {
  it('mark: every value is sent, and the end frame, the decision and the audit row name the unconfirmed ones', async () => {
    const t = last(await call([...TO_SUMMARY, EMERGENCY]));
    expect(t.decision).toMatchObject({ kind: 'handoff', unconfirmed: ALL });
    expect(endData(t)).toEqual({
      reasonCode: 'urgent',
      slots: { problem: 'a leak', ownership: 'you own it', town: 'Cedar Falls', howUrgent: 'right away', visitDay: 'Monday', timeOfDay: 'the morning' },
      unconfirmed: ALL,
    });
    expect(t.audit.find((d) => d.type === 'handoff')!.detail).toEqual({ reason: 'urgent', completed: [], queued: [], unconfirmed: ALL });
    // Ids only: no value the caller gave is in the row.
    expect(JSON.stringify(t.audit)).not.toContain('Cedar Falls');
    expect(t.session).not.toHaveProperty('agreed');
  });

  it('omit: the unconfirmed values are left out of the data; the decision and the audit still name them', async () => {
    use(variant('screened-omit', { correctsForm: true }, { unconfirmed: 'omit' }));
    const t = last(await call([...TO_SUMMARY, EMERGENCY]));
    expect(endData(t)).toEqual({ reasonCode: 'urgent' });
    expect(t.decision).toMatchObject({ kind: 'handoff', unconfirmed: ALL, slots: { howUrgent: 'right away' } });
    expect(t.audit.find((d) => d.type === 'handoff')!.detail).toEqual({ reason: 'urgent', completed: [], queued: [], unconfirmed: ALL });
  });

  it('send, and no option at all: the decision, the end frame, the audit row and the session are as they were', async () => {
    const runs = [];
    for (const app of [PLAIN_PRIORITY, variant('screened-send', { correctsForm: false }, { unconfirmed: 'send' })]) {
      use(app);
      runs.push(await call([...TO_SUMMARY, EMERGENCY, ]));
    }
    const t = last(runs[0]!);
    expect(t.decision).not.toHaveProperty('unconfirmed');
    expect(endData(t)).toEqual({ reasonCode: 'urgent', slots: { problem: 'a leak', ownership: 'you own it', town: 'Cedar Falls', howUrgent: 'soon', visitDay: 'Monday', timeOfDay: 'the morning' } });
    expect(t.audit.find((d) => d.type === 'handoff')!.detail).toEqual({ reason: 'urgent', completed: [], queued: [] });
    expect(t.session).not.toHaveProperty('agreed');
    // Both options written out as their defaults: byte for byte the call without them, every turn.
    const strip = (r: ScenarioRun) => JSON.stringify(r.runs.map((run) => ({ ...run.result, session: { ...run.result.session, appId: '' } })));
    expect(strip(runs[1]!)).toBe(strip(runs[0]!));
  });

  it('a value the caller confirmed is not named: by its own flag, a keyed value, or a yes at a summary still held', () => {
    const app = variant('screened-flags', { correctsForm: true }, { unconfirmed: 'mark' });
    use(app);
    const s = newSession('flags', 0, VOICE_RELAY, ANONYMOUS, app.id);
    const fill = (id: string, value: string, confirmed = false) => { s.slots[id] = { ...s.slots[id]!, value, display: value, confirmed }; };
    fill('problem', 'leak', true);
    fill('town', 'ashford');
    fill('howUrgent', 'soon');
    fill('visitDay', 'monday');
    s.agreed = { town: 'ashford', howUrgent: 'routine' };
    // The town is the value agreed; the urgency moved since the yes; the day was never read back.
    expect(unconfirmedSlots(s)).toEqual(['howUrgent', 'visitDay']);
    expect(handoff(s, 'urgent').unconfirmed).toEqual(['howUrgent', 'visitDay']);
  });

  it('never names an identity factor, nor a slot handed over only as verified', () => {
    const app: App = { ...testkitApp, id: 'testkit-unconfirmed', handoff: { ...testkitApp.handoff, data: { unconfirmed: 'mark' } } };
    use(app);
    const s = newSession('ids', 0, VOICE_RELAY, ANONYMOUS, app.id);
    s.slots.accountId = { ...s.slots.accountId!, value: '55501234', display: '5550 1234' };
    s.slots.dob = { ...s.slots.dob!, value: '1980-04-12', display: 'April 12th, 1980' };
    s.slots.missingNote = { ...s.slots.missingNote!, value: 'a blue box', display: 'your description' };
    expect(handoff(s, 'live-agent')).toMatchObject({ slots: { missingNote: 'your description' }, unconfirmed: ['missingNote'] });
    expect(handoff(s, 'live-agent').unconfirmed).not.toContain('accountId');
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
/** "Oh no, water is pouring in right now", read as the trial read its emergency: the intent at 0.91, intentChange as an answer. */
const URGENT = { ...PLAIN, intent: choice({ urgent: 0.91, none: 0.08, book_visit: 0.01 }), intentChange: choice({ answering: 0.77, replacing: 0.19, adding: 0.04 }) };

const turnContext = (): TurnContext => ({ nowMs: 0, todayIso: TODAY, thresholds: { ...DEFAULT_THRESHOLDS }, tools: { sys: new ScreenedSystems(), lookups: { ownerOf: () => null, scopeOf: () => [] }, codes: mockCodeVerifier } });

/** A session of `app` in book_visit, entered, with `values` filled. */
function inBooking(app: App, values: Record<string, [string, string]>): Session {
  const s = newSession('hand', 0, VOICE_RELAY, ANONYMOUS, app.id);
  setForm(s, 'book_visit');
  s.entered = 'book_visit';
  for (const [id, [value, display]] of Object.entries(values)) s.slots[id] = { ...s.slots[id]!, value, display };
  return s;
}

describe('a priority switch mid-form, before the read-back', () => {
  it('fills the open form\'s slots the words answer, and only those', () => {
    const s = inBooking(screenedApp, { problem: ['leak', 'a leak'], ownership: ['own', 'you own it'] });
    s.promptedFor = 'town';
    s.lastPromptId = 'ask_town';
    const t = resolve(s, speechEvent('oh no, water is pouring in right now', true), { ...URGENT, howUrgent: choice({ urgent: 0.92, soon: 0.05, none: 0.03 }) }, turnContext());
    expect(t.rows.find((g) => g.decided)).toMatchObject({ gate: 'priorityIntent', outcome: 'act:urgent:over:intent' });
    expect(t.decision).toMatchObject({ kind: 'handoff', reason: 'urgent', slots: { problem: 'a leak', ownership: 'you own it', howUrgent: 'right away' }, unconfirmed: ['problem', 'ownership', 'howUrgent'] });
    expect(t.session.slots.town!.value).toBeNull();
    expect(t.gateEvents).toEqual([]);
  });

  it('a corrected value a check would refuse ("and I rent it") still goes to the office: the switch wins, no check runs', () => {
    const s = inBooking(screenedApp, { problem: ['leak', 'a leak'], ownership: ['own', 'you own it'], town: ['ashford', 'Ashford'] });
    s.promptedFor = 'howUrgent';
    s.lastPromptId = 'ask_howUrgent';
    const t = resolve(s, speechEvent('water is pouring in right now, and actually I rent it', true), { ...URGENT, ownership: choice({ rent: 0.93, own: 0.04, none: 0.03 }) }, turnContext());
    expect(t.decision).toMatchObject({ kind: 'handoff', reason: 'urgent', slots: { ownership: 'you rent it' } });
    expect(t.gateEvents).toEqual([]);
    expect(t.stopped).toBeUndefined();
  });

  it('a value said again unchanged is no change, and a disambiguation asks nothing on the way out', () => {
    const s = inBooking(screenedApp, { problem: ['leak', 'a leak'], ownership: ['own', 'you own it'] });
    s.promptedFor = 'town';
    const t = resolve(s, speechEvent('the leak is pouring in right now', true), { ...URGENT, problem: choice({ leak: 0.95, none: 0.05 }), town: choice({ ashford: 0.48, riverton: 0.47, none: 0.05 }) }, turnContext());
    expect(t.decision).toMatchObject({ kind: 'handoff', reason: 'urgent', acks: [{ promptId: 'ack_intent' }] });
    expect(t.session.slots.problem).toMatchObject({ value: 'leak', display: 'a leak' });
    expect(t.session.slots.town!.value).toBeNull();
  });
});

describe('a priority switch with no form open ("anything else?")', () => {
  // A two-form call: the booking says its line and the call goes on, and the qualifying answers are
  // carried for the call, so a later emergency's handoff still has them.
  const carried = (priority: IntentPriority): App => variant(`screened-carried-${JSON.stringify(priority).replace(/\W/g, '')}`, priority, { unconfirmed: 'mark' }, {
    carrySlots: ['town', 'howUrgent'],
    forms: { ...screenedApp.forms, book_visit: { ...screenedApp.forms.book_visit!, complete: (c) => ({ kind: 'said', acks: c.acks }) } },
  });

  async function atAnythingElse(app: App): Promise<Session> {
    use(app);
    const r = await call([...TO_SUMMARY, 'yes, book it']);
    const t = last(r);
    expect(t.decision).toMatchObject({ kind: 'prompt', promptId: 'anything_else' });
    return t.session;
  }

  it('the yes to the summary agrees what the call keeps, and only that', async () => {
    const s = await atAnythingElse(carried({ correctsForm: true }));
    expect(s.agreed).toEqual({ town: 'cedar_falls', howUrgent: 'soon' });
    expect(s.slots.visitDay!.value).toBeNull();
  });

  it('corrects a carried slot from the words: the changed value is not confirmed, the one agreed and kept is', async () => {
    const s = await atAnythingElse(carried({ correctsForm: true }));
    const t = resolve(s, speechEvent('and now water is coming in right now', true), { ...URGENT, howUrgent: choice({ urgent: 0.92, none: 0.08 }) }, turnContext());
    expect(t.decision).toMatchObject({ kind: 'handoff', reason: 'urgent', slots: { town: 'Cedar Falls', howUrgent: 'right away' }, unconfirmed: ['howUrgent'] });
  });

  it('without correctsForm the carried value stands, agreed, so nothing is named', async () => {
    const s = await atAnythingElse(carried(true));
    const t = resolve(s, speechEvent('and now water is coming in right now', true), { ...URGENT, howUrgent: choice({ urgent: 0.92, none: 0.08 }) }, turnContext());
    expect(t.decision).toMatchObject({ kind: 'handoff', reason: 'urgent', slots: { town: 'Cedar Falls', howUrgent: 'soon' }, unconfirmed: [] });
    expect(endData(t)).not.toHaveProperty('unconfirmed');
  });

  it('no agreed is written for an app that sends every value', async () => {
    const app = { ...carried(true), id: 'screened-carried-send', handoff: {} };
    const s = await atAnythingElse(app);
    expect(s).not.toHaveProperty('agreed');
  });

  it('a slot the close empties takes its agreed value with it', () => {
    const app = carried(true);
    use(app);
    const s = inBooking(app, { problem: ['leak', 'a leak'], town: ['ashford', 'Ashford'] });
    s.agreed = { problem: 'leak', town: 'ashford' };
    closeForm(s);
    expect(s.agreed).toEqual({ town: 'ashford' });
  });

  it('is kept by the file store, so a call resumed after a restart counts the same values confirmed', async () => {
    const s = await atAnythingElse(carried({ correctsForm: true }));
    const dir = mkdtempSync(join(tmpdir(), 'dw-agreed-'));
    try {
      openFileStores(dir, { tokenTtlMs: 60_000 }).calls.save(contractCall('CA0002', 9, { session: s }));
      const saved = openFileStores(dir, { tokenTtlMs: 60_000 }).calls.load('CA0002')!.session;
      expect(saved.agreed).toEqual({ town: 'cedar_falls', howUrgent: 'soon' });
      const words = speechEvent('and now water is coming in right now', true);
      const answers = { ...URGENT, howUrgent: choice({ urgent: 0.92, none: 0.08 }) };
      expect(resolve(saved, words, answers, turnContext()).decision).toEqual(resolve(s, words, answers, turnContext()).decision);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a saved session resumes exactly, on the fixture with both options', () => {
  it('runs every corpus entry and scripted call as the live session does, at every turn', async () => {
    const report = await sessionRoundTrip('stub');
    expect(report.mismatches).toEqual([]);
    expect(report.turns).toBeGreaterThan(50);
  }, 60_000);
});

describe('an emergency at the offer of the caller\'s number (callerNumber)', () => {
  // Example Callbacks with an emergency of its own that hands the call over.
  const urgentCallbacks: App = {
    ...callbackApp,
    id: 'callback-urgent',
    intents: { ...callbackApp.intents, urgent: { criteria: 'Says something is wrong right now and needs help at once', label: 'get help right away', kind: 'form', priority: { correctsForm: true } } },
    forms: { ...callbackApp.forms, urgent: { slots: [], summaryPromptId: null, complete: (c) => ({ kind: 'decision', decision: handoff(c.s, 'live-agent', c.acks) }) } },
    handoff: { data: { unconfirmed: 'mark' } },
  };

  it('leaves the number offered unfilled: only a yes fills it, and the switch is no yes', async () => {
    use(urgentCallbacks);
    const corpus = loadCorpus(join(CALLBACK_DIR, 'fixtures', 'corpus.jsonl'));
    const client = new FixtureStubClient(corpus, { sharpness: DEFAULT_THRESHOLDS.STUB_SHARPNESS, fallback: new HeuristicStubClient({ todayIso: TODAY }) });
    const r = await runScenario({ id: 'offer', callerNumber: '+15555550142', steps: [{ say: 'can someone call me back' }, { say: 'Jordan Avery' }], expect: { decision: 'any' } }, { client, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, now: () => 0 });
    const atOffer = last(r).session;
    expect(atOffer.pendingConfirmation).toMatchObject({ target: 'slot', slot: 'phone', offered: true });
    const tc: TurnContext = { nowMs: 0, todayIso: TODAY, thresholds: { ...DEFAULT_THRESHOLDS }, tools: { ...urgentCallbacks.systems(), codes: mockCodeVerifier } };
    const t = resolve(atOffer, speechEvent('actually something is wrong right now, I need help', true), { ...PLAIN, intent: choice({ urgent: 0.93, none: 0.07 }), intentChange: choice({ replacing: 0.8, answering: 0.2 }) }, tc);
    expect(t.decision).toMatchObject({ kind: 'handoff', reason: 'live-agent' });
    if (t.decision.kind !== 'handoff') throw new Error('not a handoff');
    expect(t.decision.slots).not.toHaveProperty('phone');
    expect(JSON.stringify(t.decision)).not.toContain('0142');
    expect(t.decision.unconfirmed).not.toContain('phone');
    expect(t.session.slots.phone!.value).toBeNull();
    expect(t.session).not.toHaveProperty('callerOffered');
  });
});
