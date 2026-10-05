import { fileURLToPath } from 'node:url';
import {
  addDays, defineApp, describeDay, localeOf,
  type AppCode, type Completion, type CompletionContext, type Principal, type Session, type ToolDef, type VerifyOutcome,
} from 'dialogwright';
import { ACCOUNTS, FIRST_OPENING_IN_DAYS } from './data';

/**
 * {{display}}, built from its folder. The YAML next to this src/ folder (app.yaml, intents.yaml,
 * forms.yaml, prompts.yaml, slots.yaml, policy.yaml, identity.yaml) holds what is data: what a caller
 * can ask for, the forms' slots and summaries, every line the caller hears, the gate's rules, and how
 * a caller proves who they are. This file holds what runs: the tools, and the hooks of each form.
 * Policy is never in a tool: the gate decides, from policy.yaml, whether a tool may run.
 *
 * `dialogwright check` imports this module (it looks for src/app.ts when the folder has no app.ts)
 * and checks the folder against `code`.
 */

/** The app's folder: the one with app.yaml, above this src/. */
export const APP_DIR = fileURLToPath(new URL('..', import.meta.url));

/** A booking made on a call, in the app's systems. */
export interface Booking {
  ref: string;
  accountId: string;
  service: string;
  when: string;
}

/**
 * The app's systems for one call (App.systems builds a fresh one per call). Here they are a stub:
 * the bookings made so far, held in memory. Replace this with a client for the real system, and keep
 * the tests on a stub like this one.
 */
export class Systems {
  readonly bookings: Booking[] = [];
}

/**
 * The account the caller verified as, read from the session: the factor slot's value. The factors
 * are collected by the engine before any tool that needs level 1, so by then it is there.
 */
const accountIdOf = (s: Session): string => s.slots.accountId?.value ?? '';

/**
 * The accounts a principal may see, for the gate's `scope` rule (`scope: { param: accountId }` in
 * policy.yaml): a verified customer their own, an anonymous caller none. Someone who acts for
 * customers (a delegate) sees the accounts they act for: add them here when the app has delegates.
 */
export function scopeOf(p: Principal): readonly string[] {
  return p.kind === 'customer' && p.level > 0 ? [p.id] : [];
}

/** Every tool, by name; each has an action in policy.yaml, and policy.yaml names no other. */
export const TOOLS: Record<string, ToolDef> = {
  // Checks the factors (identity.yaml): the account number and the date of birth, as the factor slots
  // carry them. A match is the principal they prove, at level 1.
  verifyCustomer: {
    // The params its calls carry (each is recorded as policy.yaml says: a slot's redact setting, or `audit`).
    params: ['accountId', 'dob'],
    run(call) {
      const account = ACCOUNTS.find((a) => a.accountId === call.params.accountId && a.dob === call.params.dob);
      const value: VerifyOutcome = account
        ? { ok: true, principal: { kind: 'customer', level: 1, id: account.accountId, first: account.first } }
        : { ok: false };
      return { value, summary: account ? 'verified' : 'no match' };
    },
  },
  // The form's entry call: a read that needs level 1, which is what asks an unverified caller for the factors.
  findAccount: {
    params: ['accountId'],
    run(call) {
      const account = ACCOUNTS.find((a) => a.accountId === call.params.accountId);
      return { value: account ? { first: account.first } : null, summary: account ? 'account found' : 'no account' };
    },
  },
  // A write: books the first opening for the service. The gate has already checked the level and
  // that the caller said yes to exactly this service (the `confirmed` rule in policy.yaml).
  bookService: {
    params: ['accountId', 'service'],
    run(call, sys, { tc }) {
      const systems = sys as Systems;
      const service = call.params.service ?? '';
      const when = addDays(tc.todayIso, FIRST_OPENING_IN_DAYS[service] ?? 7);
      const ref = `B${101 + systems.bookings.length}`;
      systems.bookings.push({ ref, accountId: call.params.accountId ?? '', service, when });
      return { value: { when }, summary: `booked ${ref}`, ref };
    },
  },
};

/** The values the booking writes, read from the session: whose it is, and what the caller heard read back and said yes to. */
const bookParams = (s: Session): Record<string, string> => ({ accountId: accountIdOf(s), service: s.slots.service?.value ?? '' });

/** The form is full and confirmed: make the booking through the gate, and say the result. */
function completeBooking(c: CompletionContext): Completion {
  const { s, acks } = c;
  // Arm the confirmed rule with the hash of what the summary read back.
  s.confirmedHash = s.pendingHash;
  const { decision, value } = c.callTool({ tool: 'bookService', params: bookParams(s) });
  s.confirmedHash = null;
  // The caller changed something with their yes: the gate refused the write, so read the summary again.
  if (decision.verdict === 'BLOCK' && decision.reason === 'confirmation') return { kind: 'reconfirm', acks };
  if (decision.verdict !== 'ALLOW') return c.refusal(decision);
  s.pendingHash = null;
  const { when } = value as { when: string };
  const vars = { service: s.slots.service?.display ?? '', when: describeDay(when, localeOf(s)) };
  // The call ends on the line (the form and its slots are left as they were).
  return { kind: 'end', promptId: 'service_booked', vars, acks };
}

/** The app's TypeScript parts: everything the YAML names that runs. */
export const code: AppCode = {
  // Every slot is a library type in slots.yaml; list one here only when `type: code` names it.
  slots: {},
  tools: TOOLS,
  systems: () => ({ sys: new Systems(), lookups: { ownerOf: () => null, scopeOf } }),
  forms: {
    book_service: {
      // Made before the form's own slots: it needs level 1, so the gate steps an unverified caller up.
      entry: (s) => ({ tool: 'findAccount', params: { accountId: accountIdOf(s) } }),
      confirmedParams: bookParams,
      complete: completeBooking,
    },
  },
  // What the regression harness and the stub clients need (never used on a live call): the state a
  // corpus line spoken mid-call is seeded with. A seeded form is one a verified caller is in the
  // middle of, so the caller is a verified one, and each slot already collected has a stand-in value.
  // The caller is at the top of identity.yaml's ladder: level 1 here. When you add level 2 (a
  // one-time code), make this caller level 2, or every corpus line inside a level 2 form hears ask_otp.
  testing: {
    // What `pnpm cli --client heuristic` listens for, in the order the first match wins: your own intents' keywords.
    heuristics: { intents: [['book_service', /\b(book|schedule|repair|inspection|installation|service)\b/]] },
    seed: {
      caller: () => ({ kind: 'customer', level: 1, id: ACCOUNTS[0]!.accountId, first: ACCOUNTS[0]!.first }),
      placeholders: {
        accountId: { value: ACCOUNTS[0]!.accountId, display: '5550 1234' },
        dob: { value: ACCOUNTS[0]!.dob, display: 'April 12th, 1980' },
        service: { value: 'repair', display: 'a repair' },
      },
      // A corpus line at "anything else?" (context anything_else) follows a booking: the form just
      // answered. The booking is a write already made, so there is no call to make again.
      anythingElse: () => ({ form: 'book_service' }),
    },
    // The callers and accounts the gate grid crosses with every action, for the policy read back:
    // `pnpm policy:matrix` writes policy.matrix from them, `pnpm policy:card` POLICY.md and
    // `pnpm app:diagram` APP-MAP.md, and src/app.test.ts fails when one differs from what the app
    // generates. A verified customer at each level; no one acts for others yet (`delegates` is empty,
    // one principal per role when identity.yaml has delegates), but the grid still tries a delegate
    // whose role no rule names, one with no role, and a party of another kind.
    policyMatrix: () => ({
      principals: {
        subject1: { kind: 'customer', level: 1, id: ACCOUNTS[0]!.accountId, first: ACCOUNTS[0]!.first },
        subject2: { kind: 'customer', level: 2, id: ACCOUNTS[0]!.accountId, first: ACCOUNTS[0]!.first },
        delegates: {},
        unlistedRole: { kind: 'staff', level: 2, id: 'S-1', first: 'Quinn', role: 'assistant' },
        roleless: { kind: 'staff', level: 2, id: 'S-2', first: 'Rowan' },
        otherParty: { kind: 'visitor', level: 2, id: 'V-1', first: 'Robin' },
      },
      // The accounts a call names (the `scope` rule's accountId): the caller's own, another
      // customer's, one no one here may see, and one that does not exist. A record id is needed
      // only for a `scope: { record }` rule.
      records: {
        own: { subject: ACCOUNTS[0]!.accountId },
        inScope: { subject: ACCOUNTS[1]!.accountId },
        outOfScope: { subject: '55509012' },
        unknown: { subject: '55500000' },
      },
      values: { service: 'repair', dob: ACCOUNTS[0]!.dob },
    }),
  },
};

/** The app: the folder joined with the code above. */
export const app = defineApp(APP_DIR, code, { codeFile: 'src/app.ts' });
