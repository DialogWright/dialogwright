import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineApp, type AppCode, type Completion, type CompletionContext, type Principal, type Session, type SessionFacts, type ToolDef, type VerifyOutcome } from '../../index';

/**
 * Example Service Desk: a small, fictional line that takes a report of a problem at an address and
 * reads the status of a request to a verified caller, written as an app folder. It is the engine's
 * fixture for a slot that proposes a value from the facts (a slot's `offer: facts`):
 *
 * - At call start the engine looks the number calling up once (`findAccountByPhone`, through the
 *   gate, before the greeting). The tool returns the street on file and nothing else of the account,
 *   and fromCallerLookup keeps it in the facts.
 * - The report's `place` slot proposes it ("I see an account for the number you're calling from. Is
 *   this about 22 Alder Street?"), through facts.offers. A yes fills the slot and nothing else, a no
 *   asks the slot's question, and an address said instead fills as said.
 * - The status (`check_status`) needs level 1: whatever was proposed, the caller is asked for the
 *   account number and the date of birth.
 *
 * All names and numbers are made up (the 555 range).
 */

/** The folder this app's YAML is in. */
export const PROPOSALS_DIR = dirname(fileURLToPath(import.meta.url));

/** An account on file. */
export interface Account {
  accountId: string;
  /** The date of birth, as an ISO date. */
  dob: string;
  first: string;
  /** The phone on the account, as a session keeps a number (E.164). */
  phone: string;
  serviceAddress: string;
  /** The latest request on the account, if any. */
  latest: { ref: string; status: string } | null;
}

export const ACCOUNTS: readonly Account[] = [
  { accountId: '55501234', dob: '1980-04-12', first: 'Avery', phone: '+15555550142', serviceAddress: '22 Alder Street', latest: { ref: 'P100', status: 'open' } },
  { accountId: '55505678', dob: '1975-06-14', first: 'Morgan', phone: '+15555550143', serviceAddress: '9 Heron Row', latest: null },
];

/** A report filed on a call. */
export interface Report {
  ref: string;
  place: string;
  problem: string;
}

/** The app's systems for one call: the reports filed so far, in memory, and how often each lookup ran. */
export class ProposalSystems {
  readonly reports: Report[] = [];
  /** How many times each lookup ran, by tool. */
  readonly lookedUp: Record<string, number> = {};
}

/** The session facts: the street on file for the number calling, once the call-start lookup found it. */
export interface ProposalFacts extends SessionFacts {
  serviceAddress?: string;
}

/** The slots the report carries, in the order the confirmation hash is taken over. */
const WRITTEN = ['place', 'problem'] as const;

const accountOf = (id: string): Account | undefined => ACCOUNTS.find((a) => a.accountId === id);

/** The account the caller verified as: the principal's, once verified. */
const accountIdOf = (s: Session): string => (s.principal.kind === 'customer' ? s.principal.id : s.slots.accountId?.value ?? '');

/** The accounts a principal may see, for the `scope` rule: a verified customer their own. */
export function scopeOf(p: Principal): readonly string[] {
  return p.kind === 'customer' && p.level > 0 ? [p.id] : [];
}

export const TOOLS: Record<string, ToolDef> = {
  // The call-start lookup: the street on file for the number calling, and nothing else of the account
  // (no account number, no name, no status), since it may be said to someone who has proven nothing.
  findAccountByPhone: {
    params: ['callerNumber'],
    run(call, sys) {
      const systems = sys as ProposalSystems;
      systems.lookedUp.findAccountByPhone = (systems.lookedUp.findAccountByPhone ?? 0) + 1;
      const found = ACCOUNTS.find((a) => a.phone === call.params.callerNumber);
      return found === undefined ? { value: null, summary: 'no account for the number' } : { value: { serviceAddress: found.serviceAddress }, summary: 'a street on file' };
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
  },
  findAccount: {
    params: ['accountId'],
    run(call) {
      const account = accountOf(call.params.accountId ?? '');
      return { value: account ? { first: account.first } : null, summary: account ? 'account found' : 'no account' };
    },
  },
  readStatus: {
    params: ['accountId'],
    run(call) {
      const latest = accountOf(call.params.accountId ?? '')?.latest ?? null;
      return { value: latest, summary: latest ? 'status read' : 'no request open' };
    },
  },
  reportProblem: {
    params: [...WRITTEN],
    idempotent: true,
    run(call, sys) {
      const systems = sys as ProposalSystems;
      const ref = `P${201 + systems.reports.length}`;
      systems.reports.push({ ref, place: call.params.place ?? '', problem: call.params.problem ?? '' });
      return { value: { ref }, summary: `report ${ref}`, ref };
    },
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

/** The app's TypeScript parts. */
export const proposalsCode: AppCode = {
  slots: {},
  tools: TOOLS,
  systems: () => ({ sys: new ProposalSystems(), lookups: { ownerOf: () => null, scopeOf } }),
  forms: {
    report_problem: { confirmedParams: reportParams, complete: completeReport },
    check_status: {
      // Needs level 1: a caller not yet verified is asked for the factors first.
      entry: (s) => ({ tool: 'findAccount', params: { accountId: accountIdOf(s) } }),
      complete: completeStatus,
    },
  },
  facts: {
    initial: (): ProposalFacts => ({}),
    clone: (f) => ({ ...f }),
    // The call-start lookup's result: the street on file, and only that.
    fromCallerLookup(f, value) {
      const street = (value as { serviceAddress?: unknown } | null)?.serviceAddress;
      if (typeof street === 'string' && street !== '') (f as ProposalFacts).serviceAddress = street;
    },
    // The street proposed for the report's address, said as it is on file.
    offers(f) {
      const street = (f as ProposalFacts).serviceAddress;
      return street === undefined ? {} : { place: { value: street, display: street } };
    },
  },
  testing: {
    heuristics: {
      intents: [
        ['check_status', /\b(status|check on)\b/],
        ['report_problem', /\b(report|problem|not working|out)\b/],
      ],
    },
    seed: {
      // A seeded form is one a verified caller is in the middle of.
      caller: () => ({ kind: 'customer', level: 1, id: ACCOUNTS[0]!.accountId, first: ACCOUNTS[0]!.first }),
      placeholders: {
        place: { value: '22 Alder Street', display: '22 Alder Street' },
        problem: { value: 'out', display: 'nothing working at all' },
        accountId: { value: ACCOUNTS[0]!.accountId, display: '5550 1234' },
        dob: { value: ACCOUNTS[0]!.dob, display: 'April 12th, 1980' },
      },
      anythingElse: () => ({ form: 'report_problem' }),
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
      // The grid's caller calls from this number (and, on the other half of the grid, from none).
      callerNumber: '+15555550142',
      calls: {
        findAccountByPhone: { own: { callerNumber: '+15555550142' }, other: { callerNumber: '+15555550199' } },
      },
      values: { place: '22 Alder Street', problem: 'out', dob: ACCOUNTS[0]!.dob },
    }),
  },
};

/** The app: the folder joined with the code above. */
export const proposalsApp = defineApp(PROPOSALS_DIR, proposalsCode);

/** The code parts under the name `dialogwright check` imports them by. */
export const code = proposalsCode;
