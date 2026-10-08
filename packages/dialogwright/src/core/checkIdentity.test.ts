import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { runScenario, type Scenario, type ScenarioRun } from '../harness-text/runner';
import { loadCorpus } from '../jev/corpus';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { spokenText } from '../prompts/render';
import { registerApp, resetAppsForTest } from './app/registry';
import type { App } from './app/types';
import { DEFAULT_THRESHOLDS } from './thresholds';
import type { TurnResult } from './turn';
import { PROPOSALS_DIR, ProposalSystems, proposalsApp } from '../testing/proposals/app';
import { AGE_CHECK, CHECKING, CODE_CHECK, both, codeCode, proposalsVariants, replace as replacing } from '../testing/proposals/variant';
import { mockCodeVerifier } from './tools';
import { compilePolicy } from '../define/policyFile';
import { loadAppFolder } from '../define/load';
import type { RuleContext, RuleOutcome } from '../gate/types';

/**
 * A check that needs identity (design 2026-10-08-app-decides, item 3): a form's check above the level
 * its entry proves. Its STEP_UP asks for identity as an entry call's does (the factors, their check,
 * the identity ladder's own ending), and once the caller is verified the check runs again from the form
 * loop. On the checking variant of the proposals fixture (src/testing/proposals/variant.ts): a report
 * whose problem is checked by an action of level 1, and whose caller's date of birth, an identity
 * factor, is checked once it is given.
 */

const TODAY = '2026-10-07';
const corpus = loadCorpus(join(PROPOSALS_DIR, 'fixtures', 'corpus.jsonl'), proposalsApp);
const client = new FixtureStubClient(corpus, { sharpness: DEFAULT_THRESHOLDS.STUB_SHARPNESS, fallback: new HeuristicStubClient({ todayIso: TODAY }) });

const variants = proposalsVariants();
afterAll(() => variants.remove());
const checking = variants.variant(CHECKING);
const age = variants.variant(AGE_CHECK);
const code = variants.variant(CODE_CHECK, codeCode);

/**
 * `base` with its checkProblem rule replaced by `rule`, a rule of the test's own (a plain function, as
 * an app's defineRule runs): the gate is compiled again from the variant's policy.yaml.
 */
function withRule(base: App, id: string, level: 0 | 1 | 2, rule: (ctx: RuleContext) => RuleOutcome): App {
  const policy = loadAppFolder(variants.dirOf(base)).config!.policy;
  const tables = compilePolicy(
    { ...policy, actions: { ...policy.actions, checkProblem: { ...policy.actions.checkProblem!, level, rules: ['identity', { custom: 'test-rule' }] } } },
    { maxAttempts: 3, customRules: { 'test-rule': rule } },
  );
  const { gate: _gate, ...rest } = base;
  return { ...rest, id, policy: tables } as App;
}
const PASS = (id: string): RuleOutcome => ({ result: { id, description: 'the test rule', compared: 'pass', pass: true } });
const STEP_UP = (id: string, needLevel: 1 | 2): RuleOutcome => ({ result: { id, description: 'the test rule', compared: 'needs more', pass: false }, fail: { verdict: 'STEP_UP', needLevel } });

function use(app: App): void {
  resetAppsForTest();
  registerApp(app);
}

beforeEach(() => use(checking));

/** A number not on file: nothing is proposed, so the report's questions are asked as always. */
const NOT_ON_FILE = '+15555550199';
const REPORT = "I'd like to report a problem";
const ACCOUNT = 'five five five zero one two three four';
const DOB = 'April twelfth nineteen eighty';
/** Another account's number, keyed: no match for the date of birth said. */
const WRONG_ACCOUNT = { dtmf: '55505678' };

const toolsOf = () => ({ ...checking.systems(), codes: mockCodeVerifier });

/** A call from a number not on file: the greeting, then each step (a line said, or keys) in turn. */
async function call(tools: ReturnType<typeof toolsOf>, ...steps: (string | Scenario['steps'][number])[]): Promise<ScenarioRun> {
  const scenario: Scenario = { id: 'call', steps: steps.map((step) => (typeof step === 'string' ? { say: step } : step)), expect: { decision: 'any' }, callerNumber: NOT_ON_FILE };
  return runScenario(scenario, { client, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, now: () => 0, tools });
}

const last = (r: ScenarioRun): TurnResult => r.runs.at(-1)!.result;
const promptOf = (t: TurnResult): string | undefined => ('promptId' in t.decision ? t.decision.promptId : undefined);
/** The prompts the call said, in order: a key buffered on the way to a whole number says nothing. */
const prompts = (r: ScenarioRun): (string | undefined)[] => r.runs.map((x) => promptOf(x.result)).filter((id) => id !== undefined);
const gates = (t: TurnResult): string[] => t.gateEvents.map((e) => `${e.decision.call.tool}:${e.decision.verdict}`);
const ackIds = (t: TurnResult): string[] => ('acks' in t.decision ? t.decision.acks.map((a) => a.promptId) : []);

const TO_CHECK = [REPORT, "It's 14 Birch Lane", 'nothing is working at all'] as const;

describe('a check above the level the form\'s entry proves', () => {
  it('asks for identity as an entry call\'s STEP_UP does, and nothing is stopped', async () => {
    const r = await call(toolsOf(), ...TO_CHECK);
    const t = last(r);
    expect(gates(t)).toEqual(['checkProblem:STEP_UP']);
    expect(promptOf(t)).toBe('ask_accountId');
    expect(t.session.stepUp).toEqual({ call: { tool: 'checkProblem', params: {} }, need: 1 });
    expect(t.session.form).toBe('report_problem');
    expect(t.stopped).toBeUndefined();
    expect(t.audit.map((d) => d.type)).not.toContain('form_stopped');
    // The slots the form had are kept for when the check runs again.
    expect(t.session.slots.problem!.value).toBe('out');
    expect(t.session.slots.place!.value).toBe('14 Birch Lane');
  });

  it('once the caller is verified, the checks run again from the form loop and the form goes on to its summary', async () => {
    const tools = toolsOf();
    const r = await call(tools, ...TO_CHECK, ACCOUNT, DOB);
    const t = last(r);
    expect(prompts(r).slice(-3)).toEqual(['ask_accountId', 'ask_dob', 'confirm_report_problem']);
    expect(gates(t)).toEqual(['verifyCustomer:ALLOW', 'checkProblem:ALLOW']);
    expect(ackIds(t)).toEqual(['identity_verified']);
    expect(t.session.principal).toMatchObject({ kind: 'customer', level: 1, id: '55501234' });
    expect(t.session.stepUp).toBeNull();
    const done = await call(tools, ...TO_CHECK, ACCOUNT, DOB, 'yes, file it');
    expect(promptOf(last(done))).toBe('anything_else');
    expect((tools.sys as ProposalSystems).reports).toHaveLength(1);
  });

  it('a failed verification follows the identity ladder: the factors again, then a person', async () => {
    const once = last(await call(toolsOf(), ...TO_CHECK, WRONG_ACCOUNT, DOB));
    expect(promptOf(once)).toBe('ask_accountId');
    expect(ackIds(once)).toEqual(['identity_failed']);
    expect(once.session.stepUp).not.toBeNull();
    const out = last(await call(toolsOf(), ...TO_CHECK, WRONG_ACCOUNT, DOB, WRONG_ACCOUNT, DOB, WRONG_ACCOUNT, DOB));
    expect(out.decision).toMatchObject({ kind: 'handoff', reason: 'identity' });
  });

  it('a caller already verified is not asked again: the check passes on its first run', async () => {
    const r = await call(toolsOf(), 'can you check on my request', ACCOUNT, DOB, REPORT, "It's 14 Birch Lane", 'nothing is working at all');
    expect(gates(last(r))).toEqual(['checkProblem:ALLOW']);
    expect(promptOf(last(r))).toBe('confirm_report_problem');
  });

  it('a step-up left unanswered walks the factor\'s ladder to a person, and the form never completes', async () => {
    const r = await call(toolsOf(), ...TO_CHECK, { silence: true }, { silence: true }, { silence: true });
    expect(prompts(r).slice(-4)).toEqual(['ask_accountId', 'ask_accountId', 'ask_accountId_dtmf', 'handoff_max_attempts']);
    expect(last(r).session.completed).toEqual([]);
  });

  it('at the summary: a yes that changes what the check reads asks for identity, then the summary is read again', async () => {
    // Passes for a problem that is out, asks for a verified caller for one that works in part.
    use(withRule(checking, 'proposals-summary-stepup', 0, (ctx) => (ctx.call.params.problem === 'partial' && ctx.p.level < 1 ? STEP_UP('test-rule', 1) : PASS('test-rule'))));
    const r = await call(toolsOf(), ...TO_CHECK, 'yes, but only part of it works');
    const t = last(r);
    expect(prompts(r).slice(-2)).toEqual(['confirm_report_problem', 'ask_accountId']);
    expect(gates(t)).toEqual(['checkProblem:STEP_UP']);
    expect(t.session.slots.problem!.value).toBe('partial');
    expect(t.session.pendingConfirmation).toBeNull();
    const after = await call(toolsOf(), ...TO_CHECK, 'yes, but only part of it works', ACCOUNT, DOB);
    expect(promptOf(last(after))).toBe('confirm_report_problem');
    expect(gates(last(after))).toEqual(['verifyCustomer:ALLOW', 'checkProblem:ALLOW']);
  });

  it('a STEP_UP to a level the caller already has goes to a person, not round the ladder again', async () => {
    use(withRule(code, 'proposals-code-loop', 2, () => STEP_UP('test-rule', 2)));
    const r = await call(toolsOf(), ...TO_CHECK, ACCOUNT, DOB, { dtmf: '123456' });
    expect(prompts(r).slice(-4)).toEqual(['ask_accountId', 'ask_dob', 'ask_otp', 'handoff_needs_human']);
    expect(last(r).session.principal.level).toBe(2);
    expect(last(r).stopped).toMatchObject({ form: 'report_problem', action: 'checkProblem', reason: null, then: 'handoff' });
  });
});

describe('a check that needs the one-time code (level 2)', () => {
  beforeEach(() => use(code));

  it('asks the factors, then the code, and runs the check again at level 2', async () => {
    const r = await call(toolsOf(), ...TO_CHECK, ACCOUNT, DOB, { dtmf: '123456' });
    expect(prompts(r).slice(-4)).toEqual(['ask_accountId', 'ask_dob', 'ask_otp', 'confirm_report_problem']);
    expect(r.runs[3]!.result.session.stepUp).toEqual({ call: { tool: 'checkProblem', params: {} }, need: 2 });
    expect(gates(last(r))).toEqual(['verifyCode:ALLOW', 'checkProblem:ALLOW']);
    expect(last(r).session.principal.level).toBe(2);
  });
});

describe('a check on an identity factor', () => {
  beforeEach(() => use(age));

  it('never lets the form complete unrun: identity is asked as soon as the check waits on nothing else', async () => {
    const r = await call(toolsOf(), REPORT);
    expect(promptOf(last(r))).toBe('ask_accountId');
    expect(last(r).session.stepUp).toEqual({ call: { tool: 'checkAge', params: {} }, need: 1 });
    const out = await call(toolsOf(), REPORT, ACCOUNT, DOB);
    // Verified: the date of birth is in, the check runs, and it refuses.
    expect(gates(last(out))).toEqual(['verifyCustomer:ALLOW', 'checkAge:BLOCK']);
    expect(last(out).decision).toMatchObject({ kind: 'handoff', reason: 'needs-human' });
    expect(last(out).session.completed).toEqual([]);
  });

  it('a second report on the call runs the check again on the factor kept, without asking for identity again', async () => {
    const passing = variants.variant({ ...AGE_CHECK, 'app.yaml': replacing('id: proposals', 'id: proposals-age-pass'), 'policy.yaml': both(AGE_CHECK['policy.yaml']!, replacing("- oneOf: { field: dob, values: ['1900-01-01'], reason: too-young }", "- noneOf: { field: dob, values: ['1900-01-01'], reason: too-young }")) });
    use(passing);
    const r = await call(toolsOf(), REPORT, ACCOUNT, DOB, "It's 14 Birch Lane", 'nothing is working at all', 'yes, file it', REPORT);
    expect(prompts(r).slice(1)).toEqual(['ask_accountId', 'ask_dob', 'ask_place', 'ask_problem', 'confirm_report_problem', 'anything_else', 'ask_place']);
    expect(gates(last(r))).toEqual(['checkAge:ALLOW']);
    expect(last(r).session.slots.dob!.value).toBe('1980-04-12');
  });

  it('on a web chat, where no factor is ever taken, the form goes to a person rather than complete unchecked', async () => {
    const scenario: Scenario = { id: 'chat', as: 'web', steps: [{ say: REPORT }], expect: { decision: 'any' } };
    const r = await runScenario(scenario, { client, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, now: () => 0, tools: toolsOf() });
    const t = last(r);
    expect(t.decision).toMatchObject({ kind: 'handoff', reason: 'needs-human' });
    expect(t.stopped).toMatchObject({ action: 'checkAge', reason: null, then: 'handoff' });
    expect(r.runs.flatMap((x) => gates(x.result))).not.toContain('reportProblem:ALLOW');
  });
});

describe('an app that checks nothing above its entry is unchanged', () => {
  it('the fixture itself runs no check and asks no identity for a report', async () => {
    use(proposalsApp);
    const r = await call({ ...proposalsApp.systems(), codes: mockCodeVerifier }, ...TO_CHECK);
    expect(promptOf(last(r))).toBe('confirm_report_problem');
    expect(r.runs.flatMap((x) => gates(x.result))).toEqual(['findAccountByPhone:ALLOW']);
    expect(spokenText(proposalsApp, last(r).decision)).toContain('14 Birch Lane');
  });
});
