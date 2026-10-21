import { afterAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { runScenario, type Scenario, type ScenarioRun } from '../harness-text/runner';
import { loadCorpus, parseCorpus } from '../jev/corpus';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import type { JevClient } from '../jev/types';
import { spokenText } from '../prompts/render';
import { registerApp, resetAppsForTest } from './app/registry';
import type { App, ToolDef, VerifyOutcome } from './app/types';
import { DEFAULT_THRESHOLDS } from './thresholds';
import type { TurnResult } from './turn';
import { mockCodeVerifier } from './tools';
import { callerMatchAsks, callerMatchWay, nextWayAfter } from './identityWays';
import { RECOGNIZED_DIR, recognizedCode } from '../testing/recognized/app';
import { recognizedVariants, replace } from '../testing/recognized/variant';
import { policyCardText } from '../testing/policyCard';

/**
 * A caller-ID match on a level with more than one way to prove it (identity.yaml's level 1 `ways` and
 * `callerId` together): the match stands in for a factor of one way, which is then asked first, with the
 * caller-ID question in place of its first factor left to ask. On a variant of the engine's fixture for
 * caller ID (src/testing/recognized): a request number as the first way, checked by a test tool, and the
 * account number and date of birth as the second, the account number identified by the match.
 */

const TODAY = '2026-10-08';
const AVERY = '+15555550142';
const NOT_ON_FILE = '+15555550199';
const STATUS = 'I want to check on my request';
const AVERY_DOB = 'April twelfth nineteen eighty';
const WRONG_DOB = 'June first nineteen ninety';
const REQUEST = 'one two three four five six';
const MATCH = "I see an account associated with the number you're calling from. To access it, please tell me your date of birth, or say different account.";

/** The first way's check: request 123456 proves Avery's account. */
const findByRequest: ToolDef = {
  params: ['requestNumber'],
  run: (call) => {
    const value: VerifyOutcome = call.params.requestNumber === '123456' ? { ok: true, principal: { kind: 'customer', level: 1, id: '55501234', first: 'Avery' } } : { ok: false };
    return { value, summary: value.ok ? 'verified' : 'no match' };
  },
};

const IDENTITY = `    factors: [accountId, dob]
    verify: verifyCustomer
`;
const WAYS = `    ways:
      - { factors: [requestNumber], verify: findByRequest }
      - { factors: [accountId, dob], verify: verifyCustomer, say: way_by_account }
`;
const SLOT = `
requestNumber:
  type: digits
  noun: request
  length: 6
`;
const ACTION = `  findByRequest:
    say: find an account by a request number
    level: 0
    rules: [attempts]
  verifyCustomer:`;
const LINES = `  ask_requestNumber:
    text: What's the request number?
    interruptible: true
  ask_requestNumber_retry:
    text: Sorry, what's the six-digit request number?
    interruptible: true
  way_by_account:
    text: No problem, I can find it by your account number and date of birth.
    interruptible: false
  identity_caller_match:`;

const variants = recognizedVariants();
afterAll(() => variants.remove());

function withWays(identity: (text: string) => string = (t) => t): App {
  return variants.variant(
    {
      'identity.yaml': (t) => identity(replace(IDENTITY, WAYS)(t)),
      'slots.yaml': (t) => `${t.trimEnd()}\n${SLOT}`,
      'policy.yaml': replace('  verifyCustomer:', ACTION),
      'prompts.yaml': replace('  identity_caller_match:', LINES),
    },
    { ...recognizedCode, tools: { ...recognizedCode.tools, findByRequest } },
  );
}

/** The fixture's corpus, and a request number said at the caller-ID question in place of the date of birth. */
const corpus = [
  ...loadCorpus(join(RECOGNIZED_DIR, 'fixtures', 'corpus.jsonl'), withWays()),
  ...parseCorpus(
    '{"id":"rw-01","text":"the request number is one two three four five six","intent":"none","context":"check_status","prompted":"dob","confirm":"unanswered","labels":{"requestNumberGiven":true,"requestNumberSpan":"one two three four five six","requestNumberComplete":true}}',
    withWays(),
  ),
];

function stub(): JevClient {
  return new FixtureStubClient(corpus, { sharpness: DEFAULT_THRESHOLDS.STUB_SHARPNESS, fallback: new HeuristicStubClient({ todayIso: TODAY }) });
}

async function call(app: App, callerNumber: string | undefined, ...lines: string[]): Promise<ScenarioRun> {
  resetAppsForTest();
  registerApp(app);
  const scenario: Scenario = { id: 'call', steps: lines.map((say) => ({ say })), expect: { decision: 'any' }, ...(callerNumber !== undefined ? { callerNumber } : {}) };
  return runScenario(scenario, { client: stub(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, now: () => 0, tools: { ...app.systems(), codes: mockCodeVerifier } });
}

const last = (r: ScenarioRun): TurnResult => r.runs.at(-1)!.result;
const promptOf = (t: TurnResult): string | undefined => ('promptId' in t.decision ? t.decision.promptId : undefined);
const heard = (app: App, t: TurnResult): string => spokenText(app, t.decision);
const rows = (r: ScenarioRun, type: string) => r.runs.flatMap((x) => x.result.audit.filter((d) => d.type === type).map((d) => d.detail));

describe('a caller-ID match on a level with ways', () => {
  const app = withWays();

  it('compiles: the match stands in for a factor of the second way, which leaves the date of birth to ask', () => {
    expect(app.identity!.ways!.map((w) => w.verifyTool)).toEqual(['findByRequest', 'verifyCustomer']);
    expect(app.identity!.callerId).toEqual({ identifies: ['accountId'], ask: 'on-need' });
    expect(callerMatchWay(app)).toBe(1);
    expect(callerMatchAsks(app)).toEqual(['dob']);
  });

  it('on a call from a number on file, asks the matched way first, with the caller-ID question for the date of birth', async () => {
    const t = last(await call(app, AVERY, STATUS));
    expect(t.decision).toMatchObject({ kind: 'prompt', promptId: 'identity_caller_match', target: 'dob' });
    expect(heard(app, t)).toContain(MATCH);
    expect(t.session.identityWay).toBe(1);
    expect(t.session.callerMatch).toBe('offered');
  });

  it('the date of birth verifies, with the account the match found, by the matched way\'s check', async () => {
    const r = await call(app, AVERY, STATUS, AVERY_DOB);
    const t = last(r);
    expect(t.session.principal).toEqual({ kind: 'customer', level: 1, id: '55501234', first: 'Avery', via: 'caller-id' });
    expect(t.session.slots.accountId).toMatchObject({ value: '55501234', display: null, by: 'caller-id' });
    expect(rows(r, 'identity_caller_match').map((x) => x.outcome)).toEqual(['offered', 'verified']);
    expect(r.runs.flatMap((x) => x.result.gateEvents.map((e) => e.decision.call.tool))).toContain('verifyCustomer');
  });

  it('on a call with no match, the first way is asked as always', async () => {
    const t = last(await call(app, NOT_ON_FILE, STATUS));
    expect(promptOf(t)).toBe('ask_requestNumber');
    expect(t.session.callerMatch).toBeUndefined();
  });

  it('a request number said at the caller-ID question is checked by its own way', async () => {
    const r = await call(app, AVERY, STATUS, `the request number is ${REQUEST}`);
    const t = last(r);
    expect(t.session.principal).toMatchObject({ kind: 'customer', level: 1, id: '55501234' });
    expect(t.session.principal).not.toHaveProperty('via');
    expect(r.runs.flatMap((x) => x.result.gateEvents.map((e) => e.decision.call.tool))).toContain('findByRequest');
  });

  it('a missed answer at the caller-ID question sets the match aside and moves to the other way, with no attempt counted', async () => {
    const r = await call(app, AVERY, STATUS, "I don't know");
    const t = last(r);
    expect(promptOf(t)).toBe('ask_requestNumber');
    expect(t.decision).toMatchObject({ acks: expect.arrayContaining([expect.objectContaining({ promptId: 'identity_caller_declined' })]) });
    expect(t.session.callerMatch).toBe('declined');
    expect(t.session.identityWay).toBe(0);
    expect(t.session.slots.dob!.attempts).toBe(0);
    expect(rows(r, 'identity_caller_match').map((x) => x.outcome)).toEqual(['offered', 'declined']);
  });

  it('"different account" sets the match aside, and the matched way is asked from its first factor', async () => {
    const t = last(await call(app, AVERY, STATUS, 'different account'));
    expect(promptOf(t)).toBe('ask_accountId');
    expect(t.session.callerMatch).toBe('declined');
  });

  it('a failed check counts one attempt, sets the match aside and asks the matched way again from its first factor', async () => {
    const t = last(await call(app, AVERY, STATUS, WRONG_DOB));
    expect(promptOf(t)).toBe('ask_accountId');
    expect(t.session.callerMatch).toBe('failed');
    expect(t.session.identityAttempts.factors).toBe(1);
    expect(t.session.slots.accountId!.value).toBeNull();
  });

  it('a miss at a way asked without the match moves on as ways always do', () => {
    expect(nextWayAfter(app, 'requestNumber')).toBe(1);
    expect(nextWayAfter(app, 'dob')).toBeNull();
    expect(nextWayAfter(app, 'dob', true)).toBe(0);
  });

  it('the policy card names the matched way\'s factors and check', () => {
    const card = policyCardText(app, variants.dirOf(app));
    expect(card).toContain('only for their dob, checked by the same check (`verifyCustomer`)');
    expect(card).toContain('the caller is asked the ways as above (a miss at its question moves them to another way)');
    expect(card).toContain('caller ID matched, gives dob');
  });
});

describe('what identity.yaml may say', () => {
  it('refuses a match that identifies factors of two ways, or every factor of its way', () => {
    expect(() => withWays(replace('identifies: [accountId]', 'identifies: [accountId, requestNumber]'))).toThrow(/another way|more than one way/);
    expect(() => withWays(replace('identifies: [accountId]', 'identifies: [accountId, dob]'))).toThrow(/every factor/);
  });
});
