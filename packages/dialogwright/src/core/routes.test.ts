import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { runScenario, type Scenario, type ScenarioRun } from '../harness-text/runner';
import { loadCorpus } from '../jev/corpus';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import type { JevClient } from '../jev/types';
import { spokenText } from '../prompts/render';
import { registerApp, resetAppsForTest } from './app/registry';
import type { App } from './app/types';
import { DEFAULT_THRESHOLDS } from './thresholds';
import type { TurnResult } from './turn';
import { ROUTED_DIR, routedApp, routedCode, type RoutedFacts } from '../testing/routed/app';
import { line, replace, routedVariants } from '../testing/routed/variant';
import { callbackApp } from '../testing/callback/app';
import { sessionConditionFacts } from './routes';
import { newSession } from './session';
import { VOICE_RELAY } from '../channel/caps';
import { conditionHolds } from './conditions';

/**
 * Routes (design 2026-10-09-routes): ordered rules at call start, after identity and after a form, on
 * the engine's fixture for them, Example Service Line (src/testing/routed). Each point's outcomes act
 * as the plan says, a route taken is recorded (the trace, the audit's `route` row: the subjects it read,
 * never their values), and an app without routes is as it was.
 */

const TODAY = '2026-10-12';
/** A Monday morning, the line open; and the moments the scripted calls use. */
const OPEN = '2026-10-12T10:00:00-04:00';
const EVENING = '2026-10-12T19:00:00-04:00';
const corpus = loadCorpus(join(ROUTED_DIR, 'fixtures', 'corpus.jsonl'), routedApp);

function stub(): JevClient {
  return new FixtureStubClient(corpus, { sharpness: DEFAULT_THRESHOLDS.STUB_SHARPNESS, fallback: new HeuristicStubClient({ todayIso: TODAY }) });
}

let current: App = routedApp;
function use(app: App): void {
  resetAppsForTest();
  registerApp(app);
  current = app;
}
beforeEach(() => use(routedApp));

const variants = routedVariants();
afterAll(() => variants.remove());

/** A call at `now`: the greeting, then each step in turn. */
async function call(o: Partial<Scenario>, ...steps: Scenario['steps']): Promise<ScenarioRun> {
  const scenario: Scenario = { id: 'call', now: OPEN, ...o, steps, expect: { decision: 'any' } };
  return runScenario(scenario, { client: stub(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY });
}
const says = (...lines: string[]): Scenario['steps'] => lines.map((say) => ({ say }));
const last = (r: ScenarioRun): TurnResult => r.runs.at(-1)!.result;
const heard = (t: TurnResult): string => spokenText(current, t.decision, t.session.locale);
const promptOf = (t: TurnResult): string | undefined => ('promptId' in t.decision ? t.decision.promptId : undefined);
const routeRows = (r: ScenarioRun) => r.runs.flatMap((x) => x.result.audit.filter((d) => d.type === 'route').map((d) => d.detail));
const REPORT = "I'd like to report a problem";
const STATUS = 'I want to check on my request';
const ACCOUNT = 'five five five zero one two three four';
const DOB = 'April twelfth nineteen eighty';

describe('an app without routes is as it was', () => {
  it('no route is taken, recorded or audited', async () => {
    use(callbackApp);
    const r = await runScenario({ id: 'plain', steps: says('can someone call me back'), expect: { decision: 'any' } }, { client: new HeuristicStubClient({ todayIso: TODAY }), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, now: () => 0 });
    for (const run of r.runs) {
      expect(run.result.routes).toBeUndefined();
      expect(run.record.routes).toBeUndefined();
      expect(run.result.audit.some((d) => d.type === 'route')).toBe(false);
      expect(run.result.session.identityRouted).toBeUndefined();
    }
  });
});

describe('start', () => {
  it('closed: its line and the end, with no greeting', async () => {
    const t = last(await call({ now: EVENING }));
    expect(t.decision).toMatchObject({ kind: 'complete', form: null, promptId: 'closed_now', acks: [] });
    expect(heard(t)).toMatch(/^Thanks for calling Example Service Line. We're closed right now/);
    expect(t.routes).toEqual([{ point: 'start', rule: 0, outcome: 'end', subjects: ['hours'], at: 0 }]);
  });

  it('a holiday is closed all day; a Saturday morning open', async () => {
    expect(promptOf(last(await call({ now: '2027-01-01T11:00:00-05:00' })))).toBe('closed_now');
    expect(promptOf(last(await call({ now: '2026-10-17T12:59:00-04:00' })))).toBe('greeting');
    expect(promptOf(last(await call({ now: '2026-10-17T13:00:00-04:00' })))).toBe('closed_now');
  });

  it('continue with a line: the line, then the greeting as always; the rule read a fact the start hook wrote', async () => {
    const r = await call({ callData: { region: 'north' } });
    const t = last(r);
    expect(t.decision).toMatchObject({ kind: 'prompt', promptId: 'greeting', acks: [{ promptId: 'outage_notice', vars: {} }] });
    expect((t.session.facts as RoutedFacts).outage).toBe(true);
    // The hook's call is first among the turn's rows, then the route, as it was taken after it.
    expect(t.audit.map((d) => d.type)).toEqual(['call_started', 'gate', 'tool_result', 'route']);
    expect(routeRows(r)).toEqual([{ point: 'start', rule: 2, outcome: 'continue', subjects: ['fact.outage'] }]);
  });

  it('locale: the call goes on in the language named, the greeting in it', async () => {
    const t = last(await call({ calledNumber: '+15555550188', env: { SPANISH_LINE: '+15555550188' } }));
    expect(t.session.locale).toBe('es');
    expect(t.actions[0]).toMatchObject({ type: 'set_language' });
    expect(heard(t)).toMatch(/^Gracias por llamar/);
    // The number called is not the variable's: no switch. An unset variable: none either.
    expect(last(await call({ calledNumber: '+15555550100', env: { SPANISH_LINE: '+15555550188' } })).session.locale).toBe('en-US');
    expect(last(await call({ calledNumber: '+15555550188', env: {} })).session.locale).toBe('en-US');
  });

  it('a named predicate: handed off for its reason, to the target that reason picks', async () => {
    const t = last(await call({ callerNumber: '+15555550143' }));
    expect(t.decision).toMatchObject({ kind: 'handoff', reason: 'vip', transfer: { target: 'VIP_DESK', rule: 1 } });
    expect(t.routes).toEqual([{ point: 'start', rule: 1, outcome: 'handoff', subjects: ['named.vip'], at: 0 }]);
    // Another caller is not on the list.
    expect(promptOf(last(await call({ callerNumber: '+15555550142' })))).toBe('greeting');
  });

  it('form: the welcome, then the form entered in place of the greeting\'s open question', async () => {
    const app = variants.variant({
      'routes.yaml': replace('    then: end\n', '    then: end\n  - when: { callData: region, is: north }\n    say: outage_notice\n    then: form\n    form: report_problem\n'),
      'prompts.yaml': line('greeting_offer', 'Thanks for calling Example Service Line.'),
    });
    use(app);
    const t = last(await call({ callData: { region: 'north' } }));
    expect(t.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_problem' });
    expect(heard(t)).toBe("We know about a problem with the service in your area, and we're working on it. Thanks for calling Example Service Line. Now, let's report a problem. What are you seeing, nothing working at all, or working only in part?");
    expect(t.session.form).toBe('report_problem');
  });

  it('the else alone: the greeting as always, the else recorded', async () => {
    const r = await call({});
    expect(promptOf(last(r))).toBe('greeting');
    expect(routeRows(r)).toEqual([{ point: 'start', rule: 'else', outcome: 'continue', subjects: [] }]);
  });
});

describe('the start hook and failSoft', () => {
  it('a dip that fails is no data: the call recorded as failed, with nothing of the error, and the greeting said', async () => {
    const t = last(await call({ callData: { region: 'down' } }));
    expect(promptOf(t)).toBe('greeting');
    expect((t.session.facts as RoutedFacts).outage).toBe(false);
    expect(t.gateEvents).toEqual([expect.objectContaining({ summary: 'the tool failed: nothing was returned' })]);
    expect(JSON.stringify(t.audit)).not.toContain('did not answer');
  });

  it('a hook that throws leaves the facts as they were and the call goes on', async () => {
    const app = variants.variant({}, {
      ...routedCode,
      onStart: (ctx) => {
        (ctx.s.facts as RoutedFacts).outage = true;
        throw new Error('the hook broke');
      },
    });
    use(app);
    const t = last(await call({}));
    expect(promptOf(t)).toBe('greeting');
    expect((t.session.facts as RoutedFacts).outage).toBe(false);
  });

  it('runs on a chat too, before the routes', async () => {
    const seen: string[] = [];
    const app = variants.variant({}, { ...routedCode, onStart: (ctx) => void seen.push(ctx.s.channel) });
    use(app);
    await call({ as: 'web' });
    await call({});
    expect(seen).toEqual(['chat', 'voice']);
  });
});

/** The plan still reached by a route (its form is internal), for a variant whose rule no longer enters it: the else does, for an account not past due. */
const keepPlan = replace('  - else: continue\n\nafterForm:', '  - else: { then: form, form: payment_plan }\n\nafterForm:');

describe('after identity', () => {
  it('once, the first time the caller is verified: past due goes to the plan first, the request bridged back into after', async () => {
    const r = await call({}, ...says(STATUS, ACCOUNT, DOB));
    const t = last(r);
    expect(t.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_payment_plan', acks: [{ promptId: 'identity_verified' }, { promptId: 'past_due_first' }, { promptId: 'bridge_next' }] });
    expect(t.session.form).toBe('payment_plan');
    expect(t.session.queued).toEqual(['check_status']);
    expect(t.session.identityRouted).toBe(true);
    const done = last(await call({}, ...says(STATUS, ACCOUNT, DOB, 'yes, set that up')));
    expect(heard(done)).toBe('Done. Your plan is set up, and the first part is due next month. Now, let\'s check on a request. Your latest request, P100, is open. Is there anything else I can help with?');
    expect(routeRows(r)).toEqual([
      { point: 'start', rule: 'else', outcome: 'continue', subjects: [] },
      { point: 'afterIdentity', rule: 0, outcome: 'form', subjects: ['fact.account.pastDue'] },
    ]);
  });

  it('not again later in the call, and never for a caller not verified', async () => {
    const r = await call({}, ...says(STATUS, ACCOUNT, DOB, 'yes, set that up', 'and can you check on my request'));
    expect(routeRows(r).filter((d) => d.point === 'afterIdentity')).toHaveLength(1);
    const anon = await call({}, ...says(REPORT, 'nothing is working at all'));
    expect(routeRows(anon).some((d) => d.point === 'afterIdentity')).toBe(false);
    expect(last(anon).session.identityRouted).toBeUndefined();
  });

  it('continue with a line: said after the identity step\'s, and the form that asked goes on', async () => {
    const app = variants.variant({ 'routes.yaml': (t) => keepPlan(replace('    say: past_due_first\n    then: form\n    form: payment_plan\n', '    say: past_due_first\n    then: continue\n')(t)) });
    use(app);
    const t = last(await call({}, ...says(STATUS, ACCOUNT, DOB)));
    expect(heard(t)).toBe("Thank you, Avery. You're verified. Before that, your account has a balance past due. Your latest request, P100, is open. Is there anything else I can help with?");
  });

  it('end: the line, and the call ends', async () => {
    const app = variants.variant({ 'routes.yaml': (t) => keepPlan(replace('    say: past_due_first\n    then: form\n    form: payment_plan\n', '    say: past_due_first\n    then: end\n')(t)) });
    use(app);
    const t = last(await call({}, ...says(STATUS, ACCOUNT, DOB)));
    expect(t.decision).toMatchObject({ kind: 'complete', promptId: 'past_due_first', acks: [{ promptId: 'identity_verified' }] });
  });
});

describe('after a form', () => {
  it('a slot\'s value hands off once the form completes, counted, its line said first', async () => {
    const r = await call({}, ...says(REPORT, 'nothing is working at all', 'yes, someone could get hurt', 'yes, file it'));
    const t = last(r);
    expect(t.decision).toMatchObject({ kind: 'handoff', reason: 'emergency', completed: ['report_problem'] });
    expect(heard(t)).toBe('Done. Your report number is P201. Since someone may be at risk, let me connect you to a person right away.');
    expect(routeRows(r).at(-1)).toEqual({ point: 'afterForm', form: 'report_problem', rule: 0, outcome: 'handoff', subjects: ['slot.severity'] });
    // Never the slot's value in the record.
    expect(JSON.stringify(routeRows(r))).not.toContain('danger');
  });

  it('continue: what the form does without a route', async () => {
    const t = last(await call({}, ...says(REPORT, 'nothing is working at all', 'no, no one is at risk', 'yes, file it')));
    expect(promptOf(t)).toBe('anything_else');
    expect(t.session.completed).toEqual(['report_problem']);
  });

  it('form: goes on to the form named, as a next does; end: its line and the end', async () => {
    const toStatus = variants.variant({ 'routes.yaml': replace('    - else: continue\n', '    - else: { then: form, form: check_status }\n') });
    use(toStatus);
    const t = last(await call({}, ...says(REPORT, 'nothing is working at all', 'no, no one is at risk', 'yes, file it')));
    expect(t.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_accountId' });
    expect(t.session.form).toBe('check_status');
    expect(t.movedOn).toEqual([expect.objectContaining({ form: 'report_problem', next: 'check_status' })]);
    const ending = variants.variant({ 'routes.yaml': replace('    - else: continue\n', '    - else: { say: past_due_first, then: end }\n') });
    use(ending);
    const e = last(await call({}, ...says(REPORT, 'nothing is working at all', 'no, no one is at risk', 'yes, file it')));
    expect(e.decision).toMatchObject({ kind: 'complete', form: 'report_problem', promptId: 'past_due_first', completed: ['report_problem'] });
  });
});

describe('what the conditions read', () => {
  it('a predicate gets a copy of the session: what it writes is lost; one that throws is false', () => {
    const s = newSession('p', 0, VOICE_RELAY, undefined, routedApp.id);
    const writes = { ...routedApp, predicates: { meddle: ({ s: copy }: { s: { facts: unknown } }) => { (copy.facts as RoutedFacts).outage = true; return true; }, broken: () => { throw new Error('x'); } } } as App;
    const facts = sessionConditionFacts(writes, s, { nowMs: Date.parse(OPEN), todayIso: TODAY });
    expect(conditionHolds({ kind: 'named', predicate: 'meddle' }, facts)).toBe(true);
    expect((s.facts as RoutedFacts).outage).toBe(false);
    expect(conditionHolds({ kind: 'named', predicate: 'broken' }, facts)).toBe(false);
  });
});

describe('a transfer target on the hours', () => {
  it('is judged at the turn\'s moment: a named schedule closed goes to its target, open to the default', async () => {
    const late = last(await call({ now: '2026-10-12T17:30:00-04:00' }, ...says('can I talk to a person')));
    expect(late.decision).toMatchObject({ kind: 'handoff', reason: 'live-agent', transfer: { target: 'AFTER_HOURS_DESK', rule: 0 } });
    expect(late.audit.find((d) => d.type === 'handoff')?.detail).toMatchObject({ target: 'AFTER_HOURS_DESK' });
    const early = last(await call({ now: '2026-10-12T16:30:00-04:00' }, ...says('can I talk to a person')));
    expect(early.decision).toMatchObject({ transfer: { target: 'MAIN_LINE', rule: null } });
  });
});
