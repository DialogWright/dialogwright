import { fileURLToPath } from 'node:url';
import {
  ANONYMOUS, addDays, defineApp, describeDay, localeOf,
  type AppCode, type Completion, type CompletionContext, type Session, type ToolDef,
} from 'dialogwright';
import { FIRST_OPENING_IN_DAYS } from './data';

/**
 * {{display}}, built from its folder. The YAML next to this src/ folder (app.yaml, intents.yaml,
 * forms.yaml, prompts.yaml, slots.yaml, policy.yaml) holds what is data: what a caller can ask for,
 * the forms' slots and summaries, every line the caller hears, the gate's rules. This file holds what
 * runs: the tools, and the hooks of each form. Policy is never in a tool: the gate decides, from
 * policy.yaml, whether a tool may run.
 *
 * `dialogwright check` imports this module (it looks for src/app.ts when the folder has no app.ts)
 * and checks the folder against `code`.
 */

/** The app's folder: the one with app.yaml, above this src/. */
export const APP_DIR = fileURLToPath(new URL('..', import.meta.url));

/** A booking made on a call, in the app's systems. */
export interface Booking {
  ref: string;
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

/** Every tool, by name; each has an action in policy.yaml, and policy.yaml names no other. */
export const TOOLS: Record<string, ToolDef> = {
  // A write: books the first opening for the service. The gate has already checked the level and
  // that the caller said yes to exactly this service (the `confirmed` rule in policy.yaml).
  bookService: {
    // The params its calls carry: the policy's `audit` says how each is recorded (policy.yaml).
    params: ['service'],
    run(call, sys, { tc }) {
      const systems = sys as Systems;
      const service = call.params.service ?? '';
      const when = addDays(tc.todayIso, FIRST_OPENING_IN_DAYS[service] ?? 7);
      const ref = `B${101 + systems.bookings.length}`;
      systems.bookings.push({ ref, service, when });
      return { value: { when }, summary: `booked ${ref}`, ref };
    },
  },
};

/** The values the booking writes, read from the session: what the caller heard read back and said yes to. */
const bookParams = (s: Session): Record<string, string> => ({ service: s.slots.service?.value ?? '' });

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
  systems: () => ({ sys: new Systems(), lookups: { ownerOf: () => null, scopeOf: () => [] } }),
  forms: {
    book_service: { confirmedParams: bookParams, complete: completeBooking },
  },
  // What the regression harness and the stub clients need (never used on a live call): the state a
  // corpus line spoken mid-call is seeded with. The app verifies no one, so a seeded caller is the
  // anonymous one; each slot a seeded form has already collected has a stand-in value.
  testing: {
    // What `pnpm cli --client heuristic` listens for, in the order the first match wins: your own intents' keywords.
    heuristics: { intents: [['book_service', /\b(book|schedule|repair|inspection|installation|service)\b/]] },
    seed: {
      caller: () => ANONYMOUS,
      placeholders: { service: { value: 'repair', display: 'a repair' } },
    },
  },
};

/** The app: the folder joined with the code above. */
export const app = defineApp(APP_DIR, code, { codeFile: 'src/app.ts' });
