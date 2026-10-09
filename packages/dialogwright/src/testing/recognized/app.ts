import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineApp, isAnonymous, type AppCode, type Completion, type CompletionContext, type Principal, type Session, type SessionFacts, type ToolDef, type VerifyOutcome } from '../../index';

/**
 * Example Account Line: a small, fictional line that takes a report of a problem and reads the status
 * of a request to a verified caller, written as an app folder. It is the engine's fixture for a
 * caller-ID match as the identifier (identity.yaml's level 1 `callerId`):
 *
 * - At call start the engine looks the number calling up once (`findAccountByPhone`, through the
 *   gate, before the greeting). The tool returns the accounts on file for the number, and
 *   fromCallerLookup keeps them in the facts.
 * - facts.callerMatch reads the match: the account, where the number is on file for exactly one. A
 *   number two accounts share is no match (the app's call), and the caller is asked as on any call.
 * - When the status (`check_status`) needs level 1, a caller on a matched number is asked only for the
 *   date of birth ("I see an account associated with the number you're calling from. To access it,
 *   please tell me your date of birth, or say different account."). verifyCustomer checks the account
 *   the match found and the date said, and its audit row says the caller was verified by caller ID.
 * - "Different account", a no or a date that does not match: the account number and the date of birth,
 *   as on any call, and the match is not used again on the call.
 *
 * All names and numbers are made up (the 555 range).
 */

/** The folder this app's YAML is in. */
export const RECOGNIZED_DIR = dirname(fileURLToPath(import.meta.url));

/** An account on file. */
export interface Account {
  accountId: string;
  /** The date of birth, as an ISO date. */
  dob: string;
  first: string;
  /** The phone on the account, as a session keeps a number (E.164). */
  phone: string;
  /** The latest request on the account, if any. */
  latest: { ref: string; status: string } | null;
}

export const ACCOUNTS: readonly Account[] = [
  { accountId: '55501234', dob: '1980-04-12', first: 'Avery', phone: '+15555550142', latest: { ref: 'P100', status: 'open' } },
  { accountId: '55505678', dob: '1975-06-14', first: 'Morgan', phone: '+15555550143', latest: null },
  // Two accounts on one number: a shared phone, so no single match.
  { accountId: '55509012', dob: '1990-02-03', first: 'Jordan', phone: '+15555550144', latest: { ref: 'P300', status: 'closed' } },
  { accountId: '55503456', dob: '1992-11-30', first: 'Riley', phone: '+15555550144', latest: null },
];

/** A report filed on a call. */
export interface Report {
  ref: string;
  problem: string;
}

/** The app's systems for one call: the reports filed so far, in memory, and how often each lookup ran. */
export class RecognizedSystems {
  readonly reports: Report[] = [];
  /** How many times each lookup ran, by tool. */
  readonly lookedUp: Record<string, number> = {};
}

/** The session facts: the accounts on file for the number calling, once the call-start lookup found any. */
export interface RecognizedFacts extends SessionFacts {
  phoneAccounts?: string[];
}

/** The slots the report carries, in the order the confirmation hash is taken over. */
const WRITTEN = ['problem'] as const;

const accountOf = (id: string): Account | undefined => ACCOUNTS.find((a) => a.accountId === id);

/** The account the caller verified as: the principal's. */
const accountIdOf = (s: Session): string => (s.principal.kind === 'customer' ? s.principal.id : '');

/** The accounts a principal may see, for the `scope` rule: a verified customer their own. */
export function scopeOf(p: Principal): readonly string[] {
  return p.kind === 'customer' && p.level > 0 ? [p.id] : [];
}

export const TOOLS: Record<string, ToolDef> = {
  // The call-start lookup: the accounts on file for the number calling, by number only. Nothing of
  // them is said: the match is the identifier the date of birth verifies.
  findAccountByPhone: {
    params: ['callerNumber'],
    run(call, sys) {
      const systems = sys as RecognizedSystems;
      systems.lookedUp.findAccountByPhone = (systems.lookedUp.findAccountByPhone ?? 0) + 1;
      const found = ACCOUNTS.filter((a) => a.phone === call.params.callerNumber).map((a) => a.accountId);
      return found.length === 0 ? { value: null, summary: 'no account for the number' } : { value: { accountIds: found }, summary: `${found.length} account${found.length === 1 ? '' : 's'} on file` };
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
    // The identity row: passed or failed, the level reached, and how (by caller ID, where the match
    // stood in for the account number). Never the values.
    audit({ summary, after }) {
      const p = after.principal;
      const detail: Record<string, string | number | boolean> = { factor: 'account_id_dob', pass: summary === 'verified', level: p.level };
      if (!isAnonymous(p) && p.via !== undefined) detail.via = p.via;
      return [{ type: 'identity', detail }];
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
      const systems = sys as RecognizedSystems;
      const ref = `P${201 + systems.reports.length}`;
      systems.reports.push({ ref, problem: call.params.problem ?? '' });
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
export const recognizedCode: AppCode = {
  slots: {},
  tools: TOOLS,
  systems: () => ({ sys: new RecognizedSystems(), lookups: { ownerOf: () => null, scopeOf } }),
  forms: {
    report_problem: { confirmedParams: reportParams, complete: completeReport },
    check_status: {
      // Needs level 1: a caller not yet verified is asked for identity first.
      entry: (s) => ({ tool: 'findAccount', params: { accountId: accountIdOf(s) } }),
      complete: completeStatus,
    },
  },
  facts: {
    initial: (): RecognizedFacts => ({}),
    clone: (f) => ({ ...f, ...((f as RecognizedFacts).phoneAccounts ? { phoneAccounts: [...(f as RecognizedFacts).phoneAccounts!] } : {}) }),
    // The call-start lookup's result: the accounts on file for the number.
    fromCallerLookup(f, value) {
      const ids = (value as { accountIds?: unknown } | null)?.accountIds;
      if (Array.isArray(ids) && ids.every((id) => typeof id === 'string')) (f as RecognizedFacts).phoneAccounts = [...ids as string[]];
    },
    // The caller-ID match: the account, where the number is on file for exactly one. A shared number
    // matches no single account, and the caller is asked for both factors.
    callerMatch(f) {
      const ids = (f as RecognizedFacts).phoneAccounts;
      return ids?.length === 1 ? { accountId: ids[0]! } : null;
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
        problem: { value: 'out', display: 'nothing working at all' },
        accountId: { value: ACCOUNTS[0]!.accountId, display: '5550 1234' },
        dob: { value: ACCOUNTS[0]!.dob, display: 'April 12th, 1980' },
      },
      anythingElse: () => ({ form: 'report_problem' }),
      // A corpus line at the caller-ID question is seeded on a call from Avery's number, on file for her account alone.
      callerNumber: '+15555550142',
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
        outOfScope: { subject: '55509999' },
        unknown: { subject: '55500000' },
      },
      // The grid's caller calls from this number (and, on the other half of the grid, from none).
      callerNumber: '+15555550142',
      calls: {
        findAccountByPhone: { own: { callerNumber: '+15555550142' }, other: { callerNumber: '+15555550199' } },
      },
      values: { problem: 'out', dob: ACCOUNTS[0]!.dob },
    }),
  },
};

/** The app: the folder joined with the code above. */
export const recognizedApp = defineApp(RECOGNIZED_DIR, recognizedCode);

/** The code parts under the name `dialogwright check` imports them by. */
export const code = recognizedCode;
