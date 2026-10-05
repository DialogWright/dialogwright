import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parcelsFact } from '../testing/testkit/domain/facts';
import {
  runTurn, runCorpusEntry, runScenario, loadScenarios, unanswerableSteps, checkExpectation, outcomeOf, spokenText, saidEvent, seedCorpusSession, followEffects, startSession,
  type Outcome, type Scenario, type ScenarioStep,
} from './runner';
import { summarize } from './metrics';
import { refusesUnanswerableSteps } from './regress';
import { CLIENT_KINDS } from '../run/client';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { loadCorpus, parseCorpus, type CorpusEntry } from '../jev/corpus';
import { newSession } from '../core/session';
import type { TurnResult } from '../core/turn';
import { speechEvent, startEvent, textEvent } from '../channel/events';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { demoTools } from '../core/tools';
import type { JevClient } from '../jev/types';
import type { TraceRecord } from '../trace/types';
import { TraceWriter } from '../trace/writer';
import { FORM_INTENTS } from '../testing/testkit/domain/intents';
import { FORMS } from '../testing/testkit/domain/forms';
import { testkitApp } from '../testing/testkit';
import { useTestkit } from '../testing/apps';
import { defaultCorpusFile } from '../run/fixtures';
import { registerApp } from '../core/app/registry';
import { ANONYMOUS } from '../gate/principal';
import { VOICE_RELAY, WEB_CHAT } from '../channel/caps';
import { framesOf } from '../testing/frames';

useTestkit();

/** Every record a run wrote, read back from a throwaway trace file. */
function traceSink(): { trace: TraceWriter; records: () => TraceRecord[] } {
  const path = join(mkdtempSync(join(tmpdir(), 'trace-')), 'run.jsonl');
  return {
    trace: new TraceWriter(path),
    records: () => readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as TraceRecord),
  };
}

const ID_AND_DOB = 'five five five zero one two three four, born april twelfth nineteen eighty five';
const entries: CorpusEntry[] = [
  { id: 'c1', text: 'can you deliver tomorrow morning', intent: 'delivery_window', context: 'no_form', slots: { deliveryDay: { mode: 'relative_day', relativeDay: 'tomorrow' }, deliveryPart: 'morning' } },
  { id: 'm1', text: ID_AND_DOB, intent: 'none', context: 'delivery_window', prompted: 'accountId',
    slots: { accountId: { span: 'five five five zero one two three four', value: '55501234' }, dob: { month: 'april', day: '12', year: 'nineteen eighty five' } } },
  { id: 'd1', text: "no, that's all", intent: 'done', context: 'anything_else' },
];

const opts = {
  client: new FixtureStubClient(entries, { sharpness: 0.9, fallback: new HeuristicStubClient({ todayIso: '2026-09-18' }) }),
  thresholds: { ...DEFAULT_THRESHOLDS },
  todayIso: '2026-09-18',
  now: () => 1_000,
};
/** The fixture corpus itself, for the flows that file a report. */
const corpusOpts = { ...opts, client: new FixtureStubClient(loadCorpus(defaultCorpusFile()), { sharpness: 0.9, fallback: new HeuristicStubClient({ todayIso: '2026-09-18' }) }) };
/** Opener, identity, the keypad code, the description, its date and the yes: a report filed. */
const FILE_REPORT: ScenarioStep[] = [
  { say: 'my parcel never arrived' }, { say: 'five five five zero one two three four' }, { say: 'april twelfth nineteen eighty five' }, { dtmf: '123456' },
  { say: 'it was a small brown box left at the side gate' }, { say: 'last tuesday' }, { say: 'yes' },
];

describe('runTurn', () => {
  it('runs setup without asking the client and returns a trace record', async () => {
    const run = await runTurn(newSession('s', 0, VOICE_RELAY), startEvent(), opts);
    expect(run.response).toBeNull();
    expect(run.record.source).toBe('none');
    expect(run.record.decision.kind).toBe('prompt');
  });

  it('rethrows non-client errors', async () => {
    const badClient: JevClient = {
      ask: () => {
        throw new Error('boom');
      },
    };
    await expect(runTurn(newSession('s', 0, VOICE_RELAY), speechEvent('hello'), { ...opts, client: badClient })).rejects.toThrow(/boom/);
  });
});

const prompted: CorpusEntry = {
  id: 'ed1', text: 'last tuesday', intent: 'none', context: 'report_missing', prompted: 'expectedDate',
  slots: { expectedDate: { mode: 'weekday', weekday: 'tuesday' } },
};
const promptedClient = new FixtureStubClient([prompted], { sharpness: 0.9, fallback: new HeuristicStubClient({ todayIso: '2026-09-18' }) });

/** The second entry is a trailing-off utterance the complete gate should hold on. */
const partialClient = new FixtureStubClient([
  entries[0]!,
  { id: 'p1', text: 'five five five zero one two', intent: 'none', context: 'delivery_window', prompted: 'accountId', answers: { utteranceComplete: { noul: 0.25 } } },
], { sharpness: 0.9, fallback: new HeuristicStubClient({ todayIso: '2026-09-18' }) });

const seedOpts = { thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18', tools: demoTools() };

describe('runCorpusEntry', () => {
  it('runs a first-utterance entry from the greeting', async () => {
    const { outcome } = await runCorpusEntry(entries[0]!, opts);
    expect(outcome).toMatchObject({ id: 'c1', decision: 'prompt', promptId: 'ask_accountId', form: 'delivery_window', decidedGate: 'intent', principalLevel: 0, gate: 'getAccount:STEP_UP' });
    expect(outcome.slots.deliveryPart).toBe('morning');
  });

  it('runs a step-up entry with an anonymous caller at the factor the gate asked for', async () => {
    const { outcome } = await runCorpusEntry(entries[1]!, opts);
    // Both factors in one breath: verified, the entry call passes, and the form asks its own slot.
    expect(outcome).toMatchObject({ decision: 'prompt', promptId: 'ask_deliveryDay', form: 'delivery_window', principalLevel: 1, gate: 'getAccount:ALLOW' });
    expect(outcome.slots.accountId).toBe('55501234');
    expect(outcome.slots.dob).toBe('1985-04-12');
  });

  it('prompts the requested slot for an in-form entry, the caller already verified', async () => {
    const { outcome } = await runCorpusEntry(prompted, { ...opts, client: promptedClient });
    expect(outcome).toMatchObject({ decision: 'prompt', promptId: 'confirm_report', form: 'report_missing', principalLevel: 2 });
    expect(outcome.slots.expectedDate).toBe('2026-09-15');
    expect(outcome.slots.missingNote).toBe('a small brown box left at the side gate');
    // The seed's own gate events are not the entry's: this turn asked the gate nothing.
    expect(outcome.gate).toBeNull();
  });

  it('files the report on a yes at a seeded summary, because the seed took the summary hash', async () => {
    const yes = parseCorpus('{"id":"cf","text":"yes","intent":"none","context":"confirm_report_missing","confirm":"yes"}')[0]!;
    const client = new FixtureStubClient([yes], { sharpness: 0.9, fallback: new HeuristicStubClient({ todayIso: '2026-09-18' }) });
    const { outcome, run } = await runCorpusEntry(yes, { ...opts, client });
    expect(outcome).toMatchObject({ decision: 'prompt', promptId: 'report_filed', gate: 'notifyDepot:ALLOW', principalLevel: 2 });
    expect(run.result.effects).toEqual([{ kind: 'service', service: 'depot', params: expect.objectContaining({ report: '9001', expectedDate: '2026-09-15' }) }]);
  });

  it('credits a seeded entry only with what its own utterance fills', async () => {
    const sink = traceSink();
    const { run } = await runCorpusEntry(prompted, { ...opts, client: promptedClient, trace: sink.trace });
    const m = summarize(sink.records());
    expect(run.record.slots.missingNote!.value).toBe('a small brown box left at the side gate');
    // the greeting already showed the description (and the identity) filled, so only the date counts
    expect(m.promptTurns).toBe(1);
    expect(m.slotsFilledPerUtterance).toBeCloseTo(1, 5);
    // a session that started mid-form is not a whole call to compare against the baseline
    expect(m.completions).toEqual([]);
  });
});

describe('saidEvent', () => {
  it('is a final or partial transcript on a voice session and typed text on a chat session', () => {
    expect(saidEvent(newSession('v', 0, VOICE_RELAY), 'hello', false)).toEqual(speechEvent('hello', false));
    expect(saidEvent(newSession('v', 0, VOICE_RELAY), 'hello')).toEqual(speechEvent('hello', true));
    const chat = newSession('c', 0, WEB_CHAT);
    expect(saidEvent(chat, 'hello')).toEqual(textEvent('hello'));
  });

  it('refuses a partial transcript on a chat session, which has no speech to be partial', () => {
    expect(() => saidEvent(newSession('c', 0, WEB_CHAT), 'hello', false)).toThrow(/partial transcript.*speech/);
  });
});

describe('startSession', () => {
  it('starts a call from an anonymous caller, or with as, a staff chat signed in as that agent', () => {
    expect(startSession('s', 0)).toMatchObject({ channel: 'voice', principal: { kind: 'anonymous', level: 0 } });
    expect(startSession('s', 0, 'morgan')).toMatchObject({ channel: 'chat', principal: { kind: 'agent', level: 2, role: 'clerk', attrs: { depotId: 'D1' } } });
    expect(() => startSession('s', 0, 'mallory')).toThrow(/is not a agent/);
  });

  it('runs a scenario as staff: the chat greeting, then the depot-scoped answer', async () => {
    const r = await runScenario({ id: 'b', as: 'taylor', steps: [{ say: 'status of parcel 7201' }], expect: { decision: 'prompt', gate: 'getParcel:ALLOW' } }, corpusOpts);
    expect(r.mismatches).toEqual([]);
    expect(spokenText(r.runs[0]!.result)).toMatch(/^Hi Taylor,/);
    expect(spokenText(r.runs.at(-1)!.result)).toContain('a coffee grinder, is on its way');
  });
});

describe('summaryPromptId', () => {
  it('has a summary prompt only for the form that writes, and every id is in the manifest', () => {
    for (const f of FORM_INTENTS) {
      expect(FORMS[f].summaryPromptId !== null, f).toBe(f === 'report_missing');
      const id = FORMS[f].summaryPromptId;
      if (id !== null) expect(testkitApp.prompts.manifest, `${f}: ${id}`).toHaveProperty(id);
    }
  });
});

describe('seedCorpusSession', () => {
  it('needs the app\'s seed for an entry spoken mid-call, and none for one at the opener', () => {
    registerApp({ ...testkitApp, id: 'testkit-unseeded', testing: { ...testkitApp.testing, seed: undefined } });
    const bare = (id: string) => newSession(id, 0, VOICE_RELAY, ANONYMOUS, 'testkit-unseeded');
    const opener = parseCorpus('{"id":"o1","text":"where is my parcel","intent":"track_parcel","context":"no_form"}')[0]!;
    expect(seedCorpusSession(bare('o1'), opener, seedOpts).form).toBeNull();
    const midCall = parseCorpus('{"id":"e1","text":"in the morning","intent":"none","context":"delivery_window"}')[0]!;
    expect(() => seedCorpusSession(bare('e1'), midCall, seedOpts)).toThrow(/corpus e1: app "testkit-unseeded" seeds no delivery_window context/);
  });

  it('seeds a confirm context with a verified caller, every slot filled, the summary pending and its hash taken', () => {
    const entry = parseCorpus('{"id":"fc-1","text":"yes","intent":"none","context":"confirm_report_missing","confirm":"yes"}')[0]!;
    const s = seedCorpusSession(newSession('fc-1', 0, VOICE_RELAY), entry, seedOpts);
    expect(s.form).toBe('report_missing');
    expect(s.entered).toBe('report_missing');
    expect(s.principal).toMatchObject({ kind: 'customer', level: 2, id: '55501234' });
    expect(s.facts.account).toMatchObject({ id: '55501234' });
    for (const id of ['missingNote', 'expectedDate'] as const) expect(s.slots[id]!.value, id).not.toBeNull();
    expect(s.pendingConfirmation).toEqual({ target: 'form', form: 'report_missing', attempts: 0 });
    expect(s.pendingHash).toMatch(/^[0-9a-f]{64}$/);
    expect(s.promptedFor).toBe('confirm');
    expect(s.lastPromptId).toBe('confirm_report');
    expect(s.lastPromptOptions).toEqual(['yes', 'no']);
    expect(s.lastPromptText).toContain('due Tuesday, September 15');
  });

  it('seeds a form context verified, entered, with its facts, and placeholders only up to the prompted slot', () => {
    const s = seedCorpusSession(newSession('ed1', 0, VOICE_RELAY), prompted, seedOpts);
    expect(s.principal.level).toBe(2);
    expect(s.entered).toBe('report_missing');
    expect(s.slots.accountId!.value).toBe('55501234');
    expect(s.slots.missingNote!.value).toBe('a small brown box left at the side gate');
    expect(s.slots.expectedDate!.value).toBeNull();
    expect(s.promptedFor).toBe('expectedDate');
    expect(s.lastPromptId).toBe('ask_expectedDate');
    expect(s.pendingConfirmation).toBeNull();
    const ps = seedCorpusSession(newSession('ps', 0, VOICE_RELAY), parseCorpus('{"id":"ps","text":"7101","intent":"none","context":"track_parcel","prompted":"parcelSelect"}')[0]!, seedOpts);
    expect(parcelsFact(ps.facts)?.map((p) => p.number)).toEqual(['7101', '7102', '7103']);
  });

  it('seeds a step-up: an anonymous caller, the entry call waiting on the level the gate asked for', () => {
    const id = parseCorpus('{"id":"i1","text":"55501234","intent":"none","context":"track_parcel","prompted":"accountId"}')[0]!;
    const s = seedCorpusSession(newSession('i1', 0, VOICE_RELAY), id, seedOpts);
    expect(s.principal).toEqual({ kind: 'anonymous', level: 0 });
    expect(s.stepUp).toMatchObject({ call: { tool: 'listParcels' }, need: 2 });
    expect(s.entered).toBeNull();
    expect(s.slots.accountId!.value).toBeNull();
    expect(s.promptedFor).toBe('accountId');
    const dob = parseCorpus('{"id":"i2","text":"april twelfth","intent":"none","context":"delivery_window","prompted":"dob"}')[0]!;
    const d = seedCorpusSession(newSession('i2', 0, VOICE_RELAY), dob, seedOpts);
    expect(d.stepUp).toMatchObject({ call: { tool: 'getAccount' }, need: 1 });
    expect(d.slots.accountId!.value).toBe('55501234');
    expect(d.slots.dob!.value).toBeNull();
    expect(d.lastPromptId).toBe('ask_dob');
    // No business slot is seeded ahead of the identity it waits on.
    expect(d.slots.deliveryDay!.value).toBeNull();
  });

  it('seeds the transfer offer pending, mid-form, with two frustrated turns behind it', () => {
    const entry = parseCorpus('{"id":"tr-1","text":"keep going","intent":"none","context":"offer_transfer","prompted":"parcelSelect","confirm":"no"}')[0]!;
    const s = seedCorpusSession(newSession('tr-1', 0, VOICE_RELAY), entry, seedOpts);
    expect(s.form).toBe('track_parcel');
    // The question the caller was on is still open, so a declined offer has somewhere to go back to.
    expect(s.slots.parcelSelect!.value).toBeNull();
    expect(s.pendingConfirmation).toEqual({ target: 'transfer', attempts: 0 });
    expect(s.promptedFor).toBe('confirm');
    expect(s.lastPromptId).toBe('offer_transfer');
    expect(s.lastPromptOptions).toEqual(['yes', 'no']);
    expect(s.lastPromptText).toContain('connect you with a support specialist');
    expect(s.frustratedTurns).toBe(2);
  });

  it('seeds anything_else: no form, the caller verified, a form just answered', () => {
    const s = seedCorpusSession(newSession('ae', 0, VOICE_RELAY), entries[2]!, seedOpts);
    expect(s.form).toBeNull();
    expect(s.principal.level).toBe(2);
    expect(s.completed).toEqual(['delivery_window']);
    expect(s.promptedFor).toBe('intent');
    expect(s.lastPromptId).toBe('anything_else');
    expect(s.slots.dob!.value).toBe('1985-04-12');
  });

  it('seeds anything_else with no call when the seed names the form alone (a form answered by its own line)', () => {
    const seed = testkitApp.testing!.seed!;
    registerApp({ ...testkitApp, id: 'testkit-form-only', testing: { ...testkitApp.testing, seed: { ...seed, anythingElse: () => ({ form: 'delivery_window' }) } } });
    const s = seedCorpusSession(newSession('ae2', 0, VOICE_RELAY, ANONYMOUS, 'testkit-form-only'), entries[2]!, seedOpts);
    expect(s.form).toBeNull();
    expect(s.completed).toEqual(['delivery_window']);
    expect(s.lastPromptId).toBe('anything_else');
    // No call was made, so the facts a call would have left are not there.
    expect(s.facts).toEqual(newSession('fresh', 0, VOICE_RELAY).facts);
  });

  it('leaves a no_form session untouched', () => {
    const untouched = newSession('c1', 0, VOICE_RELAY);
    expect(seedCorpusSession(untouched, entries[0]!, seedOpts)).toBe(untouched);
  });

  it('seeds a form context with no prompted at the first missing slot, leaving every business slot null', () => {
    const entry: CorpusEntry = { id: 'rc', text: 'i want to report a missing parcel', intent: 'report_missing', context: 'report_missing' };
    const s = seedCorpusSession(newSession('rc', 0, VOICE_RELAY), entry, seedOpts);
    expect(s.slots.missingNote!.value).toBeNull();
    expect(s.slots.expectedDate!.value).toBeNull();
    expect(s.promptedFor).toBe('missingNote');
  });

  it('yields the same state when the seed is applied twice to the same session, as runCorpusEntry does', () => {
    const once = seedCorpusSession(newSession('ed1', 0, VOICE_RELAY), prompted, seedOpts);
    const applied = seedCorpusSession(newSession('ed1', 0, VOICE_RELAY), prompted, seedOpts);
    const twice = seedCorpusSession(applied, prompted, seedOpts);
    expect(twice).toEqual(once);
  });
});

describe('runScenario', () => {
  const scenario: Scenario = {
    id: 'window-happy',
    steps: [{ say: 'can you deliver tomorrow morning' }, { say: ID_AND_DOB }, { say: "no, that's all" }],
    expect: { decision: 'complete', promptId: 'goodbye', form: null, slots: { accountId: '55501234', dob: '1985-04-12' }, principalLevel: 1 },
  };

  it('runs steps and checks the expectation', async () => {
    const r = await runScenario(scenario, opts);
    expect(r.pass).toBe(true);
    expect(r.mismatches).toEqual([]);
    expect(r.runs).toHaveLength(4);
  });

  it('injects a failure on a step marked fail', async () => {
    const r = await runScenario({
      id: 'fail-once',
      steps: [{ say: 'can you deliver tomorrow morning', fail: true }],
      expect: { decision: 'prompt', promptId: 'system_slow_dtmf_hint' },
    }, opts);
    expect(r.pass).toBe(true);
  });

  it('sends a partial step as a non-final prompt frame', async () => {
    const r = await runScenario({
      id: 'partial',
      steps: [{ say: 'can you deliver tomorrow morning' }, { say: 'five five five zero one two', partial: true }],
      expect: { decision: 'hold', form: 'delivery_window' },
    }, { ...opts, client: partialClient });
    expect(r.mismatches).toEqual([]);
    expect(r.runs.at(-1)!.record.event).toMatchObject({ type: 'user.speech', final: false });
  });

  it('checks the spoken text of the last turn', async () => {
    const steps = [{ say: 'can you deliver tomorrow morning' }];
    const ok = await runScenario({ id: 'text-ok', steps, expect: { decision: 'prompt', text: "What's your account ID?" } }, opts);
    expect(ok.mismatches).toEqual([]);
    const bad = await runScenario({ id: 'text-bad', steps, expect: { decision: 'prompt', text: 'not spoken' } }, opts);
    expect(bad.mismatches[0]).toMatch(/text: expected to contain/);
  });

  it('records the ack prompt ids of the final decision', async () => {
    const steps = [{ say: 'can you deliver tomorrow morning' }];
    // Every form entry is acknowledged, a confident route included.
    const confident = await runScenario({ id: 'acks-confident', steps, expect: { decision: 'prompt' } }, opts);
    expect(confident.outcome.acks).toEqual(['ack_intent']);
    expect(confident.outcome.verdict).toBe('route');
    // An intent in the implicit band is acknowledged the same way.
    const implicitClient = new FixtureStubClient(
      [{ ...entries[0]!, answers: { intent: { probabilities: { delivery_window: 0.65, track_parcel: 0.2 } } } }],
      { sharpness: 0.9, fallback: new HeuristicStubClient({ todayIso: '2026-09-18' }) },
    );
    const acked = await runScenario({ id: 'acks-implicit', steps, expect: { decision: 'prompt' } }, { ...opts, client: implicitClient });
    expect(acked.outcome.acks).toEqual(['ack_intent']);
    expect(acked.runs.at(-1)!.result.rows.find((r) => r.gate === 'intent')?.outcome).toBe('route_implicit:delivery_window');
  });

  it('reports mismatches', async () => {
    const r = await runScenario({ ...scenario, expect: { decision: 'handoff' } }, opts);
    expect(r.pass).toBe(false);
    expect(r.mismatches[0]).toMatch(/decision/);
  });

  it('stops a scenario after the session ends', async () => {
    const r = await runScenario({
      ...scenario,
      id: 'window-happy-trailing',
      steps: [...scenario.steps, { say: 'can you deliver tomorrow morning' }],
      expect: { decision: 'complete' },
    }, opts);
    expect(r.pass).toBe(true);
    expect(r.outcome.decision).toBe('complete');
    expect(r.runs).toHaveLength(4);
  });

  it('answers a filed report with the depot agent\'s answer as the very next turn', async () => {
    const r = await runScenario({ id: 'file', steps: FILE_REPORT, expect: { decision: 'prompt', promptId: 'anything_else', text: 'call you within 2 days' } }, corpusOpts);
    expect(r.mismatches).toEqual([]);
    expect(r.runs.map((run) => run.record.event.type).slice(-2)).toEqual(['user.speech', 'service.result']);
    // The answer's own turn asks the gate nothing, so the outcome still reports the decision that led to it.
    expect(r.runs.at(-1)!.result.gateEvents).toEqual([]);
    expect(r.outcome).toMatchObject({ gate: 'notifyDepot:ALLOW', principalLevel: 2 });
  });

  it('answers the next filed report with no search time after a serviceDown step', async () => {
    const steps: ScenarioStep[] = [...FILE_REPORT.slice(0, -1), { serviceDown: true }, FILE_REPORT.at(-1)!];
    const r = await runScenario({ id: 'file-down', steps, expect: { decision: 'prompt', promptId: 'anything_else', text: 'The depot will be in touch with next steps.' } }, corpusOpts);
    expect(r.mismatches).toEqual([]);
    expect(r.runs.at(-1)!.record.event).toMatchObject({ type: 'service.result', result: null });
  });

  it('gives every scenario a book of business of its own', async () => {
    for (const id of ['first', 'second']) {
      const r = await runScenario({ id, steps: FILE_REPORT, expect: { decision: 'prompt' } }, corpusOpts);
      expect(r.runs.map((run) => spokenText(run.result)).join(' '), id).toContain('Your report number is 9001.');
    }
  });
});

describe('followEffects', () => {
  it('runs nothing for a turn that left no effect', async () => {
    const run = await runTurn(newSession('s', 0, VOICE_RELAY), startEvent(), opts);
    expect(await followEffects(run, opts)).toEqual([]);
  });
});

const outcome: Outcome = {
  id: 'x', decision: 'prompt', promptId: 'ask_accountId', acks: [], reason: null,
  decidedGate: 'intent', verdict: 'route', form: 'delivery_window',
  slots: { accountId: null, dob: null, parcelSelect: null, deliveryDay: null, deliveryPart: 'morning', missingNote: null, expectedDate: null },
  queued: [], principalLevel: 0, gate: 'getAccount:STEP_UP',
};

describe('checkExpectation', () => {
  it('passes a fully matching expectation', () => {
    expect(checkExpectation(outcome, {
      decision: 'prompt', promptId: 'ask_accountId', form: 'delivery_window', slots: { deliveryPart: 'morning' }, text: 'account',
      principalLevel: 0, gate: 'getAccount:STEP_UP',
    }, 'What is your account ID?')).toEqual([]);
  });

  it('names the field for each kind of mismatch', () => {
    expect(checkExpectation(outcome, { decision: 'complete' }, '')[0]).toMatch(/^decision: expected complete, got prompt/);
    expect(checkExpectation(outcome, { decision: 'prompt', promptId: 'ask_dob' }, '')[0]).toMatch(/^promptId: expected ask_dob, got ask_accountId/);
    expect(checkExpectation({ ...outcome, decision: 'handoff' }, { decision: 'handoff', reason: 'identity' }, '')[0])
      .toMatch(/^reason: expected identity, got null/);
    expect(checkExpectation(outcome, { decision: 'prompt', form: 'track_parcel' }, '')[0]).toMatch(/^form: expected track_parcel, got delivery_window/);
    expect(checkExpectation(outcome, { decision: 'prompt', slots: { accountId: '55501234' } }, '')[0])
      .toMatch(/^slot accountId: expected 55501234, got null/);
    expect(checkExpectation(outcome, { decision: 'prompt', principalLevel: 2 }, '')[0]).toMatch(/^principalLevel: expected 2, got 0/);
    expect(checkExpectation(outcome, { decision: 'prompt', gate: 'getParcel:BLOCK' }, '')[0]).toMatch(/^gate: expected getParcel:BLOCK, got getAccount:STEP_UP/);
    expect(checkExpectation({ ...outcome, gate: null }, { decision: 'prompt', gate: null }, '')).toEqual([]);
  });

  it('quotes both sides when the spoken text does not contain the expectation', () => {
    expect(checkExpectation(outcome, { decision: 'prompt', text: 'account ID' }, 'Which parcel?'))
      .toEqual(['text: expected to contain "account ID", got "Which parcel?"']);
  });

  it('collects every mismatch, not just the first', () => {
    expect(checkExpectation(outcome, { decision: 'complete', promptId: 'ask_dob', form: null }, '')).toHaveLength(3);
  });
});

const NO_SLOTS = { accountId: null, dob: null, parcelSelect: null, deliveryDay: null, deliveryPart: null, missingNote: null, expectedDate: null };

describe('outcomeOf', () => {
  it('reads a completed turn', async () => {
    const r = await runScenario({ ...scenario(), expect: { decision: 'complete' } }, opts);
    const o = outcomeOf('done', r.runs.at(-1)!.result);
    expect(o).toMatchObject({ id: 'done', decision: 'complete', promptId: 'goodbye', reason: null, form: null, principalLevel: 1, gate: null });
    expect(o.slots).toEqual({ ...NO_SLOTS, accountId: '55501234', dob: '1985-04-12' });
  });

  it('reads the gate from the events it is handed, else from the turn', async () => {
    const r = await runScenario({ ...scenario(), expect: { decision: 'complete' } }, opts);
    const all = r.runs.flatMap((run) => run.result.gateEvents);
    expect(outcomeOf('done', r.runs.at(-1)!.result, all).gate).toBe('getWindows:ALLOW');
  });

  it('reads an ignored turn as having no prompt, gate or verdict', () => {
    const ignored = {
      decision: { kind: 'ignore' } as const,
      rows: [], verdict: null, session: newSession('i', 0, VOICE_RELAY), turnState: null, fillEvents: [], actions: [], gateEvents: [], kb: null, effects: [], screen: null, quarantined: false, audit: [],
    } satisfies TurnResult;
    expect(outcomeOf('i', ignored)).toEqual({
      id: 'i', decision: 'ignore', promptId: null, acks: [], reason: null, decidedGate: null, verdict: null,
      form: null, slots: NO_SLOTS, queued: [], principalLevel: 0, gate: null,
    });
  });
});

function scenario(): Scenario {
  return { id: 'window-happy', steps: [{ say: 'can you deliver tomorrow morning' }, { say: ID_AND_DOB }, { say: "no, that's all" }], expect: { decision: 'complete' } };
}

describe('spokenText', () => {
  it('joins the text frames of a turn and ignores the end frame', async () => {
    const r = await runScenario({ id: 'spoken', steps: [{ say: 'can you deliver tomorrow morning' }], expect: { decision: 'prompt' } }, opts);
    const result = r.runs.at(-1)!.result;
    expect(spokenText(result)).toBe(framesOf(result).filter((f) => f.type === 'text').map((f) => f.token).join(' '));
    expect(spokenText(result)).toContain("What's your account ID?");
  });
});

describe('loadScenarios', () => {
  it('rejects a non-array file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scenarios-'));
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({ id: 'not-an-array' }));
    expect(() => loadScenarios(dir)).toThrow(/expected an array/);
  });
});

describe('unanswerableSteps', () => {
  it('names each spoken step no corpus line has the words of, after normalization; keys, silences and sign-ins need none', () => {
    const corpus = [
      { id: 'a', text: "What's my balance?", intent: 'none', context: 'no_form' },
      { id: 'b', text: 'yes', intent: 'none', context: 'no_form' },
    ] as unknown as CorpusEntry[];
    const scenarios: Scenario[] = [
      { id: 'ok', steps: [{ say: 'what\'s my balance' }, { dtmf: '1234' }, { silence: true }, { say: 'Yes.' }], expect: { decision: 'prompt' } },
      { id: 'off', steps: [{ say: 'what is my balance' }, { say: 'yes' }, { say: 'five five five' }], expect: { decision: 'prompt' } },
    ];
    expect(unanswerableSteps(corpus, scenarios)).toEqual(['off: what is my balance', 'off: five five five']);
  });

  it('are refused only on the stubs: a model, live, recording or replayed, answers any words', () => {
    expect(CLIENT_KINDS.filter(refusesUnanswerableSteps)).toEqual(['stub', 'heuristic']);
  });
});

describe('summarize', () => {
  it('computes completion turns against the baseline and slots per utterance', async () => {
    const r = await runScenario({ ...scenario(), expect: { decision: 'complete' } }, opts);
    const records = r.runs.map((x) => x.record);
    const m = summarize(records);
    // The delivery window is answered on the second caller turn, the one that verified the caller.
    expect(m.completions).toEqual([{ sessionId: 'window-happy', form: 'delivery_window', turns: 2, baseline: 5 }]);
    // The count is net of what a turn empties: the opener fills the day and the part of the
    // day, the second turn fills the account ID and birthday but closes the answered form (the day
    // and the part go), and the closing "no, that's all" fills nothing. Two slots over three utterances.
    expect(m.slotsFilledPerUtterance).toBeCloseTo(2 / 3, 5);
    expect(m.bySource['stub:fixture']).toBe(3);
    // turn 1 routed at the intent gate; turn 2 proceeded to slot filling with no gate
    // deciding; turn 3 routed "that's all" at the intent gate
    expect(m.byDecidingGate).toEqual({ intent: 2, none: 1 });

    const promptRecord = records.find((rec) => rec.event.type === 'user.speech')!;
    const ignored = { ...promptRecord, decision: { kind: 'ignore' } as const, actions: [] };
    const withIgnore = summarize([...records, ignored]);
    expect(withIgnore.promptTurns).toBe(m.promptTurns);
    expect(withIgnore.completions).toEqual(m.completions);
  });

  it('compares against the baseline it is given, and 0 for a form with none', async () => {
    const r = await runScenario({ ...scenario(), expect: { decision: 'complete' } }, opts);
    const records = r.runs.map((x) => x.record);
    expect(summarize(records, { delivery_window: 3 }).completions[0]?.baseline).toBe(3);
    expect(summarize(records, {}).completions[0]?.baseline).toBe(0);
  });

  it('counts a new report complete when the depot agent answers, and its keypad turns as caller turns', async () => {
    const r = await runScenario({ id: 'file', steps: FILE_REPORT, expect: { decision: 'prompt' } }, corpusOpts);
    const m = summarize(r.runs.map((x) => x.record));
    // opener, account ID, birthday, the code (one turn: only its sixth digit is answered), the
    // description, its date, the yes; the depot agent's answer is not the caller's.
    expect(m.completions).toEqual([{ sessionId: 'file', form: 'report_missing', turns: 7, baseline: 6 }]);
  });
});
