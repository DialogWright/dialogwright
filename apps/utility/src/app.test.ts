import { fileURLToPath } from 'node:url';
import { checkApp, formatProblem, newSession, VOICE_RELAY, type GateFacts, type Principal, type ToolCall } from 'dialogwright';
import { confirmationHash } from 'dialogwright/policy';
import { danglingReferences, expectAppMap, expectPolicyCard, expectPolicyMatrix, gateEvaluator, policyInvariants, runRuleExamples } from 'dialogwright/testing';
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

  it('has the three tasks, the question form, the two answers and the engine\'s control intents', () => {
    expect(Object.keys(app.intents)).toEqual([
      'report_outage', 'check_balance', 'set_up_plan', 'ask_question', 'outage_map', 'office_hours', 'agent', 'repeat_prompt', 'other', 'none',
    ]);
    // The two answers are passages of the knowledge base, approved like any other.
    expect(app.intents.outage_map).toMatchObject({ kind: 'informational', passage: 'outage-map' });
    expect(app.intents.office_hours).toMatchObject({ kind: 'informational', passage: 'office-hours' });
  });

  it('has an action in policy.yaml for every tool, and no other', () => {
    expect(Object.keys(app.policy.toolLevel).sort()).toEqual(Object.keys(code.tools).sort());
  });
});

describe('identity', () => {
  it('verifies a customer with an account number and a date of birth, and a code for level 2', () => {
    expect(app.identity).toMatchObject({ subjectKind: 'customer', factorSlots: ['accountId', 'dob'], verifyTool: 'verifyCustomer' });
    expect(app.policy.toolLevel).toMatchObject({ reportOutage: 0, readBalance: 1, findAccount: 1, setUpPlan: 2, answerQuestion: 0, getOutageHistory: 1 });
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

  it('has no custom rule: the thirty days are dateInRange\'s today+30', () => {
    expect(code.customRules ?? {}).toEqual({});
    expect(runRuleExamples(app)).toEqual([]);
  });

  it('policy.matrix is what the gate decides', () => {
    expectPolicyMatrix(app, fileURLToPath(new URL('../policy.matrix', import.meta.url)), 'pnpm policy:matrix apps/utility');
  });

  it('POLICY.md is the policy card the app generates', () => {
    expectPolicyCard(app, fileURLToPath(new URL('../POLICY.md', import.meta.url)), 'pnpm policy:card apps/utility');
  });
});

describe('the app map', () => {
  it('APP-MAP.md is the app map the app generates', () => {
    expectAppMap(app, fileURLToPath(new URL('../APP-MAP.md', import.meta.url)), 'pnpm app:diagram apps/utility');
  });

  it('has no dangling reference: every form is started by an intent and every action is reached', () => {
    expect(danglingReferences(app)).toEqual([]);
  });
});

describe('the balance form\'s account', () => {
  const onEntry = code.forms!.check_balance!.onEntry!;
  /** A call at the balance form whose `account` slot holds `said`, heard before the caller was verified as `principal`. */
  function entered(principal: Principal, said: string | null) {
    const s = newSession('t', 0, VOICE_RELAY, principal, app.id);
    if (said !== null) Object.assign(s.slots.account!, { value: said, display: `${said.slice(0, 4)} ${said.slice(4)}`, confirmed: false });
    onEntry(s, null);
    return s.slots.account!;
  }

  it('is the verified customer\'s, whatever number was said before they verified', () => {
    // The number said first fills the slot beside the factor (the two are asked in the same words);
    // the customer then verifies as another account. The console shows the slot: it must be theirs.
    expect(entered(customerPrincipal('55501234', 1)!, '55505678')).toMatchObject({ value: '55501234', display: '5550 1234', confirmed: true });
    expect(entered(customerPrincipal('55501234', 1)!, null)).toMatchObject({ value: '55501234', display: '5550 1234', confirmed: true });
  });

  it('is the one a property manager named', () => {
    expect(entered(managerPrincipal('riley')!, '55505678')).toMatchObject({ value: '55505678', confirmed: false });
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
    expect(decide('sendCode', { accountId: '55505678' }, manager)).toBe('BLOCK not-subject');
  });

  it('files an outage report for anyone who confirmed it', () => {
    const outage = { accountId: '', place: '14 Birch Lane', symptom: 'no_power', count: '', firstDate: '', total: '' };
    expect(decide('reportOutage', outage, anonymous)).toBe('ALLOW');
    expect(decide('reportOutage', outage, manager)).toBe('ALLOW');
    expect(decide('reportOutage', outage, anonymous, false)).toBe('BLOCK confirmation');
  });
});

describe('the knowledge answers\' gated reads', () => {
  const gate = gateEvaluator(app);
  const facts: GateFacts = { attempts: 0, todayIso: '2026-09-18', confirmedHash: null };
  const decide = (tool: string, params: Record<string, string>, p: Principal): string => {
    const d = gate({ tool, params } as ToolCall, p, facts, app.systems().lookups);
    return d.reason ? `${d.verdict} ${d.reason}` : d.verdict;
  };

  it('lets anyone ask a question, and only a verified customer read the last outage on their own account', () => {
    expect(decide('answerQuestion', { topic: 'outage_credit' }, { kind: 'anonymous', level: 0 })).toBe('ALLOW');
    expect(decide('getOutageHistory', { accountId: '', topic: 'outage_credit' }, { kind: 'anonymous', level: 0 })).toBe('STEP_UP');
    expect(decide('getOutageHistory', { accountId: '55501234', topic: 'outage_credit' }, customerPrincipal('55501234', 1)!)).toBe('ALLOW');
    expect(decide('getOutageHistory', { accountId: '55505678', topic: 'outage_credit' }, customerPrincipal('55501234', 1)!)).toBe('BLOCK scope');
    // A property manager's knowledge read names no subject (kbCallParams sends '' for anyone not a customer): refused.
    expect(decide('getOutageHistory', { accountId: '', topic: 'outage_credit' }, managerPrincipal('riley')!)).toBe('BLOCK scope');
  });

  it('reads the last outage on record as the account line says it, and nothing when there is none', async () => {
    const read = (accountId: string) => TOOLS.getOutageHistory!.run({ tool: 'getOutageHistory', params: { accountId, topic: 'outage_credit' } }, new Systems(), { s: { locale: 'en-US' } } as never);
    expect(await read('55501234')).toMatchObject({ value: { lastOutageDay: 'Wednesday, September 2', lastOutageHours: 26 }, summary: 'last outage read' });
    expect(await read('55509012')).toMatchObject({ value: { lastOutageDay: null, lastOutageHours: null }, summary: 'no outage on record' });
  });
});
