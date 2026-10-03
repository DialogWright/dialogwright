import { fileURLToPath } from 'node:url';
import { checkApp, formatProblem, type GateFacts, type Principal, type ToolCall } from 'dialogwright';
import { confirmationHash } from 'dialogwright/policy';
import { expectPolicyMatrix, gateEvaluator, policyInvariants, runRuleExamples } from 'dialogwright/testing';
import { describe, expect, it } from 'vitest';
import { APP_DIR, PLAN_CALL, Systems, TOOLS, app, code, customerPrincipal, managerPrincipal, splitInto } from './app';

describe('the app folder', () => {
  it('passes dialogwright check: the folder, the code and the corpus agree', async () => {
    expect((await checkApp(APP_DIR, { code })).map(formatProblem)).toEqual([]);
  });

  it('is Example Power & Light, in en-US', () => {
    expect(app.id).toBe('utility');
    expect(app.brand?.name).toBe('Example Power & Light');
    expect(app.locales).toMatchObject({ default: 'en-US' });
  });

  it('has the three forms, the two answers and the engine\'s control intents', () => {
    expect(Object.keys(app.intents)).toEqual([
      'report_outage', 'check_balance', 'set_up_plan', 'outage_map', 'office_hours', 'agent', 'repeat_prompt', 'other', 'none',
    ]);
    expect(app.intents.outage_map!.kind).toBe('informational');
    expect(app.intents.office_hours!.kind).toBe('informational');
  });

  it('has an action in policy.yaml for every tool, and no other', () => {
    expect(Object.keys(app.policy.toolLevel).sort()).toEqual(Object.keys(code.tools).sort());
  });
});

describe('identity', () => {
  it('verifies a customer with an account number and a date of birth, and a code for level 2', () => {
    expect(app.identity).toMatchObject({ subjectKind: 'customer', factorSlots: ['accountId', 'dob'], verifyTool: 'verifyCustomer' });
    expect(app.policy.toolLevel).toMatchObject({ reportOutage: 0, readBalance: 1, findAccount: 1, setUpPlan: 2 });
  });

  it('verifies only when both factors match one account', async () => {
    const verify = (params: Record<string, string>) => TOOLS.verifyCustomer!.run({ tool: 'verifyCustomer', params }, new Systems(), {} as never);
    expect(await verify({ accountId: '55501234', dob: '1980-04-12' })).toMatchObject({ value: { ok: true, principal: { kind: 'customer', level: 1, first: 'Avery' } } });
    expect(await verify({ accountId: '55501234', dob: '1975-06-14' })).toMatchObject({ value: { ok: false } });
    expect(await verify({ accountId: '55509999', dob: '1980-04-12' })).toMatchObject({ value: { ok: false } });
  });
});

describe('the arrangement', () => {
  it('splits a balance into installments that add up to it', () => {
    expect(splitInto('240.00', 3)).toEqual(['80.00', '80.00', '80.00']);
    expect(splitInto('100.00', 3)).toEqual(['33.33', '33.33', '33.34']);
  });
});

describe('the policy against its file', () => {
  it('holds to the policy invariants on the gate grid', () => expect(policyInvariants(app).violations).toEqual([]));

  it('runs every custom rule example as written', () => {
    expect(runRuleExamples(app).map((r) => `${r.tool} ${r.example}: ${r.expected}`)).toEqual([
      'setUpPlan thirty days on: ALLOW',
      'setUpPlan thirty-one days on: BLOCK date-range',
    ]);
  });

  it('policy.matrix is what the gate decides', () => {
    expectPolicyMatrix(app, fileURLToPath(new URL('../policy.matrix', import.meta.url)), 'pnpm policy:matrix apps/utility');
  });
});

describe('the bounds, at their edges', () => {
  const gate = gateEvaluator(app);
  const customer = (level: 1 | 2) => customerPrincipal('55501234', level)!;
  const manager = managerPrincipal('riley')!;
  const anonymous: Principal = { kind: 'anonymous', level: 0 };

  /** The verdict (and reason) for one call by one principal, on the regression's day, the caller having said yes to exactly the params. */
  function decide(tool: string, params: Record<string, string>, p: Principal, confirmed = true): string {
    const facts: GateFacts = { attempts: 0, todayIso: '2026-09-18', confirmedHash: confirmed ? confirmationHash(params, app.policy.confirmedFields) : null };
    const d = gate({ tool, params } as ToolCall, p, facts, app.systems().lookups);
    return d.reason ? `${d.verdict} ${d.reason}` : d.verdict;
  }
  const plan = (over: Record<string, string> = {}) => ({ ...PLAN_CALL, ...over });

  it('holds the total to what is owed', () => {
    expect(decide('setUpPlan', plan({ total: '240.00' }), customer(2))).toBe('ALLOW');
    expect(decide('setUpPlan', plan({ total: '240.01' }), customer(2))).toBe('BLOCK limit');
    expect(decide('setUpPlan', plan({ total: '0.01' }), customer(2))).toBe('ALLOW');
    expect(decide('setUpPlan', plan({ total: '0.00' }), customer(2))).toBe('BLOCK limit');
  });

  it('holds the first payment to today through thirty days on', () => {
    expect(decide('setUpPlan', plan({ firstDate: '2026-09-17' }), customer(2))).toBe('BLOCK date-range');
    expect(decide('setUpPlan', plan({ firstDate: '2026-09-18' }), customer(2))).toBe('ALLOW');
    expect(decide('setUpPlan', plan({ firstDate: '2026-10-18' }), customer(2))).toBe('ALLOW');
    expect(decide('setUpPlan', plan({ firstDate: '2026-10-19' }), customer(2))).toBe('BLOCK date-range');
  });

  it('needs the code, the caller\'s own account and their yes', () => {
    expect(decide('setUpPlan', plan(), customer(1))).toBe('STEP_UP');
    expect(decide('setUpPlan', plan({ accountId: '55505678', total: '312.00' }), customer(2))).toBe('BLOCK scope');
    expect(decide('setUpPlan', plan(), customer(2), false)).toBe('BLOCK confirmation');
  });

  it('sends a property manager\'s arrangement to a person, and lets them read their buildings\' balances only', () => {
    expect(decide('setUpPlan', plan({ accountId: '55505678', total: '312.00' }), manager)).toBe('NEEDS_HUMAN role-person');
    expect(decide('readBalance', { accountId: '55505678' }, manager)).toBe('ALLOW');
    expect(decide('readBalance', { accountId: '55501234' }, manager)).toBe('BLOCK scope');
    expect(decide('sendCode', { accountId: '55505678' }, manager)).toBe('BLOCK role');
  });

  it('files an outage report for anyone who confirmed it', () => {
    const outage = { accountId: '', place: '14 Birch Lane', symptom: 'no_power', count: '', firstDate: '', total: '' };
    expect(decide('reportOutage', outage, anonymous)).toBe('ALLOW');
    expect(decide('reportOutage', outage, manager)).toBe('ALLOW');
    expect(decide('reportOutage', outage, anonymous, false)).toBe('BLOCK confirmation');
  });
});
