import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callDataOf, callerOf, defineApp, replyShape, type AppCode, type AppContext, type Completion, type CompletionContext, type Principal, type Session, type SessionFacts, type ToolDef, type VerifyOutcome } from '../../index';

/**
 * Example Service Line: a small, fictional line that takes a report of a problem and reads the status
 * of a request to a verified caller, written as an app folder. It is the engine's fixture for routes
 * (routes.yaml), business hours (app.yaml's hours), the start hook (onStart) and a call that fails soft:
 *
 * - The start hook asks for the notices in the region the call came from (a custom parameter), through
 *   the gate, with `failSoft`: a notices service that fails is no notice, and the call goes on.
 * - At start: outside the hours (or on a holiday) a line and goodbye; a caller on the vip list (the
 *   `vip` predicate below) to a person; an outage the hook found, its notice before the greeting; a
 *   call to the Spanish line's number, in Spanish.
 * - After identity: an account past due (what the status form's entry kept) sets up a payment plan
 *   first, and the caller's own request follows.
 * - After a report: a danger to someone goes to a person.
 * - A handoff once the billing desk's own hours are over goes to the after-hours desk (a transfer
 *   target on a named schedule).
 *
 * All names and numbers are made up (the 555 range).
 */

/** The folder this app's YAML is in. */
export const ROUTED_DIR = dirname(fileURLToPath(import.meta.url));

/** An account on file. */
export interface Account {
  accountId: string;
  /** The date of birth, as an ISO date. */
  dob: string;
  first: string;
  /** The phone on the account, as a session keeps a number (E.164). */
  phone: string;
  /** A balance is past due. */
  pastDue: boolean;
  /** The account is on the vip list: its calls go straight to a person. */
  vip: boolean;
  /** The latest request on the account, if any. */
  latest: { ref: string; status: string } | null;
}

export const ACCOUNTS: readonly Account[] = [
  { accountId: '55501234', dob: '1980-04-12', first: 'Avery', phone: '+15555550142', pastDue: true, vip: false, latest: { ref: 'P100', status: 'open' } },
  { accountId: '55505678', dob: '1975-06-14', first: 'Morgan', phone: '+15555550143', pastDue: false, vip: true, latest: null },
];

/** The regions with a notice, and the one whose notices service is down (its lookup throws). */
export const OUTAGE_REGION = 'north';
export const NOTICES_DOWN_REGION = 'down';

/** The app's systems for one call: the reports filed and the plans set up so far, in memory. */
export class RoutedSystems {
  readonly reports: { ref: string; problem: string; severity: string }[] = [];
  readonly plans: { ref: string; accountId: string }[] = [];
}

/** The session facts: an outage in the caller's region (the start hook's), and the account's standing (the status form's entry). */
export interface RoutedFacts extends SessionFacts {
  outage: boolean;
  account: { pastDue: boolean } | null;
}

/** The slots the report carries, in the order the confirmation hash is taken over. */
const WRITTEN = ['problem', 'severity'] as const;

const accountOf = (id: string): Account | undefined => ACCOUNTS.find((a) => a.accountId === id);

/** The account the caller verified as: the principal's, once verified. */
const accountIdOf = (s: Session): string => (s.principal.kind === 'customer' ? s.principal.id : s.slots.accountId?.value ?? '');

/** The accounts a principal may see, for the `scope` rule: a verified customer their own. */
export function scopeOf(p: Principal): readonly string[] {
  return p.kind === 'customer' && p.level > 0 ? [p.id] : [];
}

export const TOOLS: Record<string, ToolDef> = {
  // The notices for a region: no one's record. The region the notices service cannot answer for throws.
  lookupNotices: {
    params: ['region'],
    run(call) {
      if (call.params.region === NOTICES_DOWN_REGION) throw new Error('the notices service did not answer');
      const outage = call.params.region === OUTAGE_REGION;
      return { value: { outage }, summary: outage ? 'an outage in the region' : 'no notice for the region' };
    },
  },
  verifyCustomer: {
    params: ['accountId', 'dob'],
    run(call) {
      const account = ACCOUNTS.find((a) => a.accountId === call.params.accountId && a.dob === call.params.dob);
      const value: VerifyOutcome = account
        ? { ok: true, principal: { kind: 'customer', level: 1, id: account.accountId, first: account.first } }
        : { ok: false };
      return { value, summary: account ? 'verified' : 'no match' };
    },
    // A match names the account every later call is made for: its id has the account number's form.
    check: replyShape.any(replyShape.object({ ok: replyShape.oneOf([false]) }), replyShape.object({ ok: replyShape.oneOf([true]), principal: replyShape.object({ id: replyShape.digits(8) }) })),
  },
  findAccount: {
    params: ['accountId'],
    run(call) {
      const account = accountOf(call.params.accountId ?? '');
      return { value: account ? { first: account.first, pastDue: account.pastDue } : null, summary: account ? 'account found' : 'no account' };
    },
  },
  readStatus: {
    params: ['accountId'],
    run(call) {
      const latest = accountOf(call.params.accountId ?? '')?.latest ?? null;
      return { value: latest, summary: latest ? 'status read' : 'no request open' };
    },
    // Said to the caller: the reference and a status of the request system's own words.
    check: replyShape.nullable(replyShape.object({ ref: replyShape.code(), status: replyShape.oneOf(['open', 'closed']) })),
  },
  reportProblem: {
    params: [...WRITTEN],
    idempotent: true,
    run(call, sys) {
      const systems = sys as RoutedSystems;
      const ref = `P${201 + systems.reports.length}`;
      systems.reports.push({ ref, problem: call.params.problem ?? '', severity: call.params.severity ?? '' });
      return { value: { ref }, summary: `report ${ref}`, ref };
    },
    // The report number is said to the caller.
    check: replyShape.object({ ref: replyShape.code() }),
  },
  setUpPlan: {
    params: ['accountId'],
    idempotent: true,
    run(call, sys) {
      const systems = sys as RoutedSystems;
      const ref = `L${301 + systems.plans.length}`;
      systems.plans.push({ ref, accountId: call.params.accountId ?? '' });
      return { value: { ref }, summary: `plan ${ref}`, ref };
    },
    check: replyShape.object({ ref: replyShape.code() }),
  },
};

/** The values the report writes, read from the session: what the caller heard read back and said yes to. */
const reportParams = (s: Session): Record<string, string> => Object.fromEntries(WRITTEN.map((id) => [id, s.slots[id]?.value ?? '']));

/** The report is full and confirmed: file it through the gate. */
function completeReport(c: CompletionContext): Completion {
  const { s, acks } = c;
  s.confirmedHash = s.pendingHash;
  const { decision, value } = c.callTool({ tool: 'reportProblem', params: reportParams(s) });
  s.confirmedHash = null;
  if (decision.verdict === 'BLOCK' && decision.reason === 'confirmation') return { kind: 'reconfirm', acks };
  if (decision.verdict !== 'ALLOW') return c.refusal(decision);
  s.pendingHash = null;
  const { ref } = value as { ref: string };
  return { kind: 'said', acks: [...acks, { promptId: 'problem_reported', vars: { ref } }] };
}

/** The status of the latest request on the caller's own account, read through the gate. */
function completeStatus(c: CompletionContext): Completion {
  const { s, acks } = c;
  const { decision, value } = c.callTool({ tool: 'readStatus', params: { accountId: accountIdOf(s) } });
  if (decision.verdict !== 'ALLOW') return c.refusal(decision);
  if (value === null) return { kind: 'said', acks: [...acks, { promptId: 'status_none', vars: {} }] };
  const { ref, status } = value as { ref: string; status: string };
  return { kind: 'said', acks: [...acks, { promptId: 'status_is', vars: { ref, status } }] };
}

/** The plan, agreed: set up through the gate on the caller's own account, and the balance no longer past due. */
function completePlan(c: CompletionContext): Completion {
  const { s, acks } = c;
  const { decision } = c.callTool({ tool: 'setUpPlan', params: { accountId: accountIdOf(s) } });
  if (decision.verdict !== 'ALLOW') return c.refusal(decision);
  const facts = s.facts as RoutedFacts;
  if (facts.account !== null) facts.account = { pastDue: false };
  return { kind: 'said', acks: [...acks, { promptId: 'payment_plan_set', vars: {} }] };
}

/**
 * The start hook: the notices for the region the call came from, if it came with one, through the gate
 * and failing soft: a notices service that fails is no notice (the call is recorded as failed, with
 * nothing of the error), and the greeting is said as on any call.
 */
function onStart(ctx: AppContext): void {
  const region = callDataOf(ctx.s).region;
  if (region === undefined) return;
  const { decision, value, failed } = ctx.callTool({ tool: 'lookupNotices', params: { region } }, { failSoft: true });
  if (decision.verdict !== 'ALLOW' || failed === true) return;
  (ctx.s.facts as RoutedFacts).outage = (value as { outage?: unknown } | null)?.outage === true;
}

/** The app's TypeScript parts. */
export const routedCode: AppCode = {
  slots: {},
  tools: TOOLS,
  systems: () => ({ sys: new RoutedSystems(), lookups: { ownerOf: () => null, scopeOf } }),
  forms: {
    report_problem: { confirmedParams: reportParams, complete: completeReport },
    check_status: {
      // Needs level 1: a caller not yet verified is asked for the factors first.
      entry: (s) => ({ tool: 'findAccount', params: { accountId: accountIdOf(s) } }),
      // Whether the account is past due, which the route after identity reads (routes.yaml).
      onEntry: (s, value) => {
        const pastDue = (value as { pastDue?: unknown } | null)?.pastDue === true;
        (s.facts as RoutedFacts).account = { pastDue };
      },
      complete: completeStatus,
    },
    payment_plan: { complete: completePlan },
  },
  facts: {
    initial: (): RoutedFacts => ({ outage: false, account: null }),
    clone: (f) => {
      const r = f as RoutedFacts;
      return { outage: r.outage, account: r.account === null ? null : { ...r.account } };
    },
  },
  onStart,
  predicates: {
    // A caller on the vip list, by the number they call from: read from the session, which is a copy.
    vip: ({ s }) => ACCOUNTS.some((a) => a.vip && a.phone === callerOf(s as Session)?.number),
  },
  testing: {
    heuristics: {
      intents: [
        ['check_status', /\b(status|check on)\b/],
        ['report_problem', /\b(report|problem|not working)\b/],
      ],
    },
    seed: {
      // A seeded form is one a verified caller is in the middle of.
      caller: () => ({ kind: 'customer', level: 1, id: ACCOUNTS[1]!.accountId, first: ACCOUNTS[1]!.first }),
      placeholders: {
        problem: { value: 'out', display: 'nothing working at all' },
        severity: { value: 'minor', display: 'no danger' },
        accountId: { value: ACCOUNTS[1]!.accountId, display: '5550 5678' },
        dob: { value: ACCOUNTS[1]!.dob, display: 'June 14th, 1975' },
      },
      anythingElse: () => ({ form: 'report_problem' }),
      // A seeded call happens on a Monday morning, while the line is open.
      now: '2026-10-12T10:00:00-04:00',
    },
    policyMatrix: () => ({
      principals: {
        subject1: { kind: 'customer', level: 1, id: ACCOUNTS[0]!.accountId, first: ACCOUNTS[0]!.first },
        subject2: { kind: 'customer', level: 2, id: ACCOUNTS[0]!.accountId, first: ACCOUNTS[0]!.first },
        delegates: {},
        unlistedRole: { kind: 'staff', level: 2, id: 'S-1', first: 'Quinn', role: 'assistant' },
        roleless: { kind: 'staff', level: 2, id: 'S-2', first: 'Rowan' },
        otherParty: { kind: 'visitor', level: 2, id: 'V-1', first: 'Robin' },
      },
      records: {
        own: { subject: ACCOUNTS[0]!.accountId },
        inScope: { subject: ACCOUNTS[1]!.accountId },
        outOfScope: { subject: '55509012' },
        unknown: { subject: '55500000' },
      },
      values: { problem: 'out', severity: 'minor', dob: ACCOUNTS[0]!.dob, region: OUTAGE_REGION },
    }),
  },
};

/** The app: the folder joined with the code above. */
export const routedApp = defineApp(ROUTED_DIR, routedCode);

/** The code parts under the name `dialogwright check` imports them by. */
export const code = routedCode;
