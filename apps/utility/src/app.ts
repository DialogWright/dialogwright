import { fileURLToPath } from 'node:url';
import {
  addDays, defineApp, describeDay, handoff, localeOf,
  type AppCode, type Completion, type CompletionContext, type Party, type Principal, type Session, type ToolDef, type VerifyOutcome,
} from 'dialogwright';
import { defineRule } from 'dialogwright/policy';
import { ACCOUNTS, MANAGERS, accountOf, amountDue } from './data';

/**
 * Example Power & Light, built from its folder. The YAML next to this src/ folder holds what is data:
 * what a caller can ask for, the forms' slots and summaries, every line the caller hears, the gate's
 * rules, and how a caller proves who they are. This file holds what runs: the tools, the hooks of
 * each form, the one custom rule, and the gate's lookups. Policy is never in a tool: the gate
 * decides, from policy.yaml, whether a tool may run.
 */

/** The app's folder: the one with app.yaml, above this src/. */
export const APP_DIR = fileURLToPath(new URL('..', import.meta.url));

/** An outage report filed on a call. */
export interface OutageReport {
  ref: string;
  place: string;
  symptom: string;
}

/** A payment arrangement set up on a call. */
export interface Arrangement {
  ref: string;
  accountId: string;
  installments: readonly string[];
  firstDate: string;
}

/**
 * The app's systems for one call (App.systems builds a fresh one per call): a stub holding the
 * reports and arrangements made so far, in memory. A real client replaces it; keep the tests on it.
 */
export class Systems {
  readonly outages: OutageReport[] = [];
  readonly arrangements: Arrangement[] = [];
}

/** The number of installments each `count` option means. */
const COUNTS: Readonly<Record<string, number>> = { two: 2, three: 3, four: 4, six: 6 };

/** A plain decimal ("240.00") as it is said: "$240.00". */
export const money = (amount: string): string => `$${amount}`;

/** A plain decimal split into `n` installments, in cents, the last taking any remainder. */
export function splitInto(total: string, n: number): string[] {
  const cents = Math.round(Number(total) * 100);
  const each = Math.floor(cents / n);
  return Array.from({ length: n }, (_, i) => ((i === n - 1 ? cents - each * (n - 1) : each) / 100).toFixed(2));
}

/**
 * The account a call is about. A customer's is the one they verified as (the principal's id, never a
 * value they said later); anyone else's is the account they named in the form's `account` slot. The
 * gate's scope rule decides whether they may see it.
 */
export const accountIdOf = (s: Session): string => (s.principal.kind === 'customer' ? s.principal.id : s.slots.account?.value ?? '');

/** A customer, as the verify tool and a portal sign-in prove them. */
export function customerPrincipal(id: string, level: 1 | 2): Party | null {
  const a = accountOf(id);
  return a ? { kind: 'customer', level, id: a.accountId, first: a.first, contact: { phoneLast4: a.phoneLast4 } } : null;
}

/** A property manager, as the chat's portal signs them in. */
export function managerPrincipal(id: string): Party | null {
  const m = MANAGERS.find((x) => x.id === id);
  return m ? { kind: 'property_manager', level: 2, id: m.id, first: m.first, name: m.name, role: 'manager' } : null;
}

/** The accounts a principal may see: a customer their own, a property manager their buildings', an anonymous caller none. */
export function scopeOf(p: Principal): readonly string[] {
  if (p.level === 0) return [];
  if (p.kind === 'customer') return [p.id];
  if (p.kind === 'property_manager') return MANAGERS.find((m) => m.id === p.id)?.accounts ?? [];
  return [];
}

/** Every tool, by name; each has an action in policy.yaml, and policy.yaml names no other. */
export const TOOLS: Record<string, ToolDef> = {
  // Checks the factors: the account number and the date of birth. A match is the customer at level 1.
  verifyCustomer: {
    run(call) {
      const account = ACCOUNTS.find((a) => a.accountId === call.params.accountId && a.dob === call.params.dob);
      const principal = account ? customerPrincipal(account.accountId, 1) : null;
      const value: VerifyOutcome = principal ? { ok: true, principal } : { ok: false };
      return { value, summary: principal ? 'verified' : 'no match' };
    },
  },
  // Texts a one-time code to the phone on the account.
  sendCode: {
    run(call) {
      const account = accountOf(call.params.accountId ?? '');
      return { value: account ? { phoneLast4: account.phoneLast4 } : null, summary: account ? `texted ...${account.phoneLast4}` : 'no phone' };
    },
  },
  // Checks the one-time code with the engine's verifier (a mock in tests: an even last digit passes).
  verifyCode: {
    run(_call, _sys, { tc, code }) {
      const ok = code !== undefined && tc.tools.codes.check(code);
      return { value: ok, summary: ok ? 'code accepted' : 'code rejected' };
    },
  },
  // Files an outage report for the address as the caller said it.
  reportOutage: {
    run(call, sys) {
      const systems = sys as Systems;
      const ref = `OT${401 + systems.outages.length}`;
      systems.outages.push({ ref, place: call.params.place ?? '', symptom: call.params.symptom ?? '' });
      return { value: { ref }, summary: `filed ${ref}`, ref };
    },
  },
  // The account, for the entry call of the balance and the arrangement forms.
  findAccount: {
    run(call) {
      const account = accountOf(call.params.accountId ?? '');
      return { value: account ? { first: account.first } : null, summary: account ? 'account found' : 'no account' };
    },
  },
  // The balance and the due date.
  readBalance: {
    run(call) {
      const account = accountOf(call.params.accountId ?? '');
      return { value: account ? { balance: account.balance, due: account.due } : null, summary: account ? 'balance read' : 'no account' };
    },
  },
  // Sets up the arrangement: the total split into the installments, the first on the day given.
  setUpPlan: {
    run(call, sys) {
      const systems = sys as Systems;
      const installments = splitInto(call.params.total ?? '0', COUNTS[call.params.count ?? ''] ?? 1);
      const ref = `PA${701 + systems.arrangements.length}`;
      systems.arrangements.push({ ref, accountId: call.params.accountId ?? '', installments, firstDate: call.params.firstDate ?? '' });
      return { value: { ref, each: installments[0] }, summary: `arranged ${ref}`, ref };
    },
  },
};

// The confirmed writes. The app has one list of confirmed fields (policy.yaml), so each write sends
// every field on it, '' for the ones it does not have.

/** What an outage report writes: the address as said and what the caller sees. */
const outageParams = (s: Session): Record<string, string> => ({
  accountId: '', place: s.slots.place?.value ?? '', symptom: s.slots.symptom?.value ?? '', count: '', firstDate: '', total: '',
});

/** What an arrangement writes: whose account, how many payments, the first day, and the total (the balance). */
const planParams = (s: Session): Record<string, string> => {
  const accountId = accountIdOf(s);
  return {
    accountId, place: '', symptom: '', count: s.slots.count?.value ?? '', firstDate: s.slots.firstDate?.value ?? '', total: amountDue(accountId) ?? '',
  };
};

/** The outage form is full and confirmed: file the report through the gate. */
function completeOutage(c: CompletionContext): Completion {
  const { s, acks } = c;
  s.confirmedHash = s.pendingHash;
  const { decision, value } = c.callTool({ tool: 'reportOutage', params: outageParams(s) });
  s.confirmedHash = null;
  if (decision.verdict === 'BLOCK' && decision.reason === 'confirmation') return { kind: 'reconfirm', acks };
  if (decision.verdict !== 'ALLOW') return c.refusal(decision);
  s.pendingHash = null;
  const { ref } = value as { ref: string };
  return { kind: 'said', acks: [...acks, { promptId: 'outage_reported', vars: { ref } }] };
}

/** The balance form: read the balance of the account through the gate (the scope rule decides whose). */
function completeBalance(c: CompletionContext): Completion {
  const { s, acks } = c;
  const accountId = accountIdOf(s);
  const { decision, value } = c.callTool({ tool: 'readBalance', params: { accountId } });
  if (decision.verdict !== 'ALLOW') return c.refusal(decision);
  if (value === null) return { kind: 'said', acks: [...acks, { promptId: 'account_not_found', vars: {} }] };
  const { balance, due } = value as { balance: string; due: string };
  const vars = { last4: accountId.slice(-4), balance: money(balance), due: describeDay(due, localeOf(s)) };
  return { kind: 'said', acks: [...acks, { promptId: 'balance_is', vars }] };
}

/** The arrangement form is full and confirmed: set it up through the gate (the bounds are its rules). */
function completePlan(c: CompletionContext): Completion {
  const { s, acks } = c;
  s.confirmedHash = s.pendingHash;
  const { decision, value } = c.callTool({ tool: 'setUpPlan', params: planParams(s) });
  s.confirmedHash = null;
  if (decision.verdict === 'BLOCK' && decision.reason === 'confirmation') return { kind: 'reconfirm', acks };
  if (decision.verdict !== 'ALLOW') return c.refusal(decision);
  s.pendingHash = null;
  const { ref, each } = value as { ref: string; each: string };
  const vars = { count: s.slots.count?.display ?? '', each: money(each), firstDate: s.slots.firstDate?.display ?? '', ref };
  return { kind: 'said', acks: [...acks, { promptId: 'plan_set_up', vars }] };
}

/** A sample arrangement call, inside every bound on the regression's day (2026-09-18). */
export const PLAN_CALL: Readonly<Record<string, string>> = {
  accountId: '55501234', place: '', symptom: '', count: 'three', firstDate: '2026-09-25', total: '240.00',
};

/**
 * The first installment is no more than thirty days after the call's day. There is no "today plus N
 * days" bound in dateInRange, so the far end is this rule (the near end is dateInRange's
 * `notBefore: today`). It reads the call's day from the gate's facts, never the clock.
 */
export const within30Days = defineRule({
  id: 'first-date-within-30-days',
  description: 'The first payment of an arrangement is no more than thirty days after today',
  run(c) {
    const latest = addDays(c.facts.todayIso, 30);
    const day = c.call.params.firstDate ?? '';
    return day !== '' && day <= latest
      ? { pass: true, compared: `firstDate on or before ${latest}: yes` }
      : { pass: false, compared: `firstDate on or before ${latest}: no`, verdict: 'BLOCK', reason: 'date-range' };
  },
  examples: [
    { name: 'thirty days on', call: { params: { ...PLAN_CALL, firstDate: '2026-10-18' } }, principal: customerPrincipal('55501234', 2)!, expect: { verdict: 'ALLOW' } },
    { name: 'thirty-one days on', call: { params: { ...PLAN_CALL, firstDate: '2026-10-19' } }, principal: customerPrincipal('55501234', 2)!, expect: { verdict: 'BLOCK', reason: 'date-range' } },
  ],
});

/** The refusal line for each reason the gate blocks with; null sends the caller to a person. */
export function blockPromptId(reason: string): string | null {
  switch (reason) {
    case 'scope': return 'account_not_yours';
    case 'limit': return 'plan_amount_outside';
    case 'date-range': return 'plan_date_outside';
    default: return null;
  }
}

/** The app's TypeScript parts: everything the YAML names that runs. */
export const code: AppCode = {
  // Every slot is a library type in slots.yaml.
  slots: {},
  tools: TOOLS,
  lookups: ['amountDue'],
  systems: () => ({ sys: new Systems(), lookups: { ownerOf: () => null, scopeOf, amountDue: (id: string) => amountDue(id) } }),
  customRules: { 'first-date-within-30-days': within30Days },
  blockPromptId,
  identity: { sendCodeParams: (s) => ({ accountId: accountIdOf(s) }) },
  principals: { subjectPrincipal: customerPrincipal, delegatePrincipal: managerPrincipal },
  portal: {
    subjects: () => ACCOUNTS.map((a) => ({ id: a.accountId, first: a.first, last: a.last })),
    delegates: () => MANAGERS.map((m) => ({ id: m.id, name: m.name, role: 'manager' })),
    roleLabel: () => 'property manager',
  },
  forms: {
    report_outage: {
      confirmedParams: outageParams,
      complete: completeOutage,
    },
    check_balance: {
      // Needs level 1: an anonymous caller verifies first. The customer's account is the one verified.
      entry: (s) => ({ tool: 'findAccount', params: { accountId: accountIdOf(s) } }),
      onEntry: (s) => {
        if (s.principal.kind === 'customer' && s.slots.account && s.slots.account.value === null) {
          Object.assign(s.slots.account, { value: s.principal.id, display: `${s.principal.id.slice(0, 4)} ${s.principal.id.slice(4)}`, confirmed: true, window: null });
        }
      },
      // A property manager names the account: the form asks for it, and the scope rule decides.
      principalEntry: () => null,
      complete: completeBalance,
    },
    set_up_plan: {
      // Needs level 2 (the purpose in policy.yaml): the code is keyed before the form's own questions.
      entry: (s) => ({ tool: 'findAccount', params: { accountId: accountIdOf(s) }, purpose: 'set_up_plan' }),
      // A property manager's request goes to a person (the role rule), before any question is asked.
      principalEntry: (c) => {
        const { decision } = c.callTool({ tool: 'setUpPlan', params: {}, purpose: 'entry-check' });
        return decision.verdict === 'NEEDS_HUMAN' ? handoff(c.s, decision.reason ?? 'needs-human', c.acks) : null;
      },
      onSummaryRead: ({ s }) => ({ vars: { total: money(amountDue(accountIdOf(s)) ?? '0.00') } }),
      confirmedParams: planParams,
      complete: completePlan,
    },
  },
  // What the regression harness and the stub clients need (never used on a live call).
  testing: {
    // What `pnpm cli --client heuristic` listens for, in the order the first match wins.
    heuristics: {
      intents: [
        ['outage_map', /\b(map|website|online)\b/],
        ['office_hours', /\b(hours|open|close)\b/],
        ['set_up_plan', /\b(arrangement|installments?|plan|split)\b/],
        ['check_balance', /\b(balance|owe|bill|due)\b/],
        ['report_outage', /\b(outage|power|lights?|flicker\w*|wire)\b/],
      ],
    },
    seed: {
      // A seeded form is one a verified caller is in the middle of, at the top level (the arrangement needs the code).
      caller: () => customerPrincipal(ACCOUNTS[0]!.accountId, 2)!,
      placeholders: {
        accountId: { value: ACCOUNTS[0]!.accountId, display: '5550 1234' },
        dob: { value: ACCOUNTS[0]!.dob, display: 'April 12th, 1980' },
        place: { value: '14 Birch Lane', display: '14 Birch Lane' },
        symptom: { value: 'no_power', display: 'no power at all' },
        account: { value: ACCOUNTS[0]!.accountId, display: '5550 1234' },
        count: { value: 'three', display: 'three payments' },
        firstDate: { value: '2026-09-25', display: 'Friday, September 25th' },
      },
    },
    policyMatrix: () => ({
      principals: {
        subject1: customerPrincipal('55501234', 1)!,
        subject2: customerPrincipal('55501234', 2)!,
        delegates: { manager: managerPrincipal('riley')! },
        unlistedRole: { kind: 'property_manager', level: 2, id: 'quinn', first: 'Quinn', role: 'assistant' },
        roleless: { kind: 'property_manager', level: 2, id: 'rowan', first: 'Rowan' },
        otherParty: { kind: 'visitor', level: 2, id: 'V-1', first: 'Robin' },
      },
      records: {
        own: { subject: '55501234', record: 'R-1' },
        inScope: { subject: '55505678', record: 'R-2' },
        outOfScope: { subject: '55509012', record: 'R-3' },
        unknown: { subject: '55500000', record: 'R-9' },
      },
      values: { ...PLAN_CALL, place: '14 Birch Lane', symptom: 'no_power' },
    }),
  },
};

/** The app: the folder joined with the code above. */
export const app = defineApp(APP_DIR, code, { codeFile: 'src/app.ts' });
