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
import { CHECKING, proposalsVariants } from '../testing/proposals/variant';
import { mockCodeVerifier } from './tools';

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
const prompts = (r: ScenarioRun): (string | undefined)[] => r.runs.map((x) => promptOf(x.result));
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
    expect(gates(t)).toEqual(['verifyCustomer:ALLOW', 'checkProblem:ALLOW', 'checkAge:ALLOW']);
    expect(ackIds(t)).toEqual(['identity_verified']);
    expect(t.session.principal).toMatchObject({ kind: 'customer', level: 1, id: '55501234' });
    expect(t.session.stepUp).toBeNull();
    // The check on the date of birth, an identity factor, ran only once it was given.
    expect(r.runs.slice(0, -1).flatMap((x) => gates(x.result))).not.toContain('checkAge:ALLOW');
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
    // The date of birth is held from the verification: its check runs as the report opens.
    expect(r.runs.slice(-3).map((x) => gates(x.result))).toEqual([['checkAge:ALLOW'], [], ['checkProblem:ALLOW']]);
    expect(promptOf(last(r))).toBe('confirm_report_problem');
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
