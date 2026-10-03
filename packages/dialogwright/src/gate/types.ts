import type { PolicyTables, ToolName } from '../core/app/types';

export type Level = 0 | 1 | 2;

/**
 * Who the caller is proven to be. Constructed only by an app's verifier or sign-in (and raised by
 * src/gate/principal.ts); nothing derived from perception can make one.
 */
export interface Anonymous {
  readonly kind: 'anonymous';
  readonly level: 0;
}

/**
 * Someone proven by a verifier or a sign-in. `kind` is the app's word for them; the engine compares
 * it only with the app's subject kind (App.identity.subjectKind): a party of that kind is one of the
 * app's subjects, any other acts for subjects. `id` is their record key. `role` (if any) is what the role rule
 * reads; `contact` is where a one-time code may be sent; `attrs` is the app's own, never read by the
 * engine.
 */
export interface Party {
  readonly kind: string;
  readonly level: 1 | 2;
  readonly id: string;
  readonly first: string;
  readonly name?: string;
  readonly role?: string;
  readonly contact?: { readonly phoneLast4?: string };
  readonly attrs?: Readonly<Record<string, string>>;
}

export type Principal = Anonymous | Party;

/** True for a caller nobody has proven: level 0. */
export function isAnonymous(p: Principal): p is Anonymous {
  return p.level === 0;
}

/**
 * A runtime check on a principal an app hands the engine (a verify tool's, a portal sign-in's): a
 * proven party, with a kind that is not the anonymous one, a level of 1 or 2, and a non-empty id.
 * Anything else is not believed.
 */
export function isParty(p: unknown): p is Party {
  if (typeof p !== 'object' || p === null) return false;
  const { kind, level, id } = p as Record<string, unknown>;
  return typeof kind === 'string' && kind !== 'anonymous' && (level === 1 || level === 2) && typeof id === 'string' && id !== '';
}

/** A tool's name: a plain string. The app defines which tools exist; the gate blocks any other (unlisted). */
export type { ToolName };

export interface ToolCall {
  readonly tool: ToolName;
  readonly params: Readonly<Record<string, string>>;
  /** The form the call serves, when a form raises the bar above the tool's own level. */
  readonly purpose?: string;
}

export type GateVerdict = 'ALLOW' | 'BLOCK' | 'STEP_UP' | 'NEEDS_HUMAN';

export interface RuleResult {
  /** The rule's name (`identity`, `scope`, `confirmed`, `role`, `attempts`, `fields`, `dateInRange`, `limit`), an app's own rule's id, or `unlisted` (the tool itself is not on the approved list). */
  readonly id: string;
  readonly description: string; // plain English, for the console and the audit log
  /**
   * The values compared, e.g. "record owner ...5520 · caller may see ...1234 only". A rule writes
   * masked ids and words. On its way to the gate event, the console and the audit, the lifecycle
   * masks in it every raw value of a param of the call that is recorded masked or never (a slot's
   * redact, policy.yaml's `audit:`; core/recording.ts), so a rule (an app's custom rule included)
   * that repeats one does not leak it; a value it reshapes (reformatted, split, partly quoted) is
   * not recognised, so a rule still writes only what may be recorded.
   */
  readonly compared: string;
  readonly pass: boolean;
}

export interface GateDecision {
  readonly call: ToolCall;
  readonly verdict: GateVerdict;
  readonly rules: readonly RuleResult[];
  /** For STEP_UP: the level the call needs. */
  readonly needLevel?: Level;
  /** For BLOCK and NEEDS_HUMAN: a short machine reason, e.g. "scope", "role", "attempts", or an app rule's own. */
  readonly reason?: string;
}

/**
 * Privileged lookups the gate's built-in rules use. Supplied by the app's tool layer, never by the
 * dialog; an app's lookups object may carry more for its own rules (PolicyTables.customRules).
 */
export interface GateLookups {
  /** The subject id a record belongs to, or null if there is no such record. */
  ownerOf(recordId: string): string | null;
  /** The subject ids this principal may see (a subject: themself; someone acting for subjects: those they act for). */
  scopeOf(p: Principal): readonly string[];
}

/** Session facts the gate reads. Written by tool results and the confirmation step only. */
export interface GateFacts {
  /**
   * Failed attempts at the identity check this call makes, which the attempts rule caps: the one-time code's for the
   * app's code tool, the identity factors' for its verify tool.
   */
  readonly attempts: number;
  /** Hash of the values the caller confirmed aloud at the summary, or null. */
  readonly confirmedHash: string | null;
  /** Today's date, ISO yyyy-mm-dd, as the call session knows it. A rule that checks a date compares it against this, never the wall clock. */
  readonly todayIso: string;
}

/**
 * Whether a decision ran the rule of that name and it passed: `passed(decision, 'role')`. A rule the
 * action does not list, or that was not reached (an earlier rule stopped the call), has not passed.
 */
export function passed(decision: GateDecision, rule: string): boolean {
  return decision.rules.some((r) => r.id === rule && r.pass);
}

/** What a rule reads: the call, who asks, the session's gate facts, the lookups and the app's tables. */
export interface RuleContext {
  readonly call: ToolCall;
  readonly p: Principal;
  readonly facts: GateFacts;
  /** The app's lookups (App.systems); an app's own rule may read lookups of its own beside the gate's. */
  readonly lk: GateLookups;
  readonly policy: PolicyTables;
  /** The app's subject kind (App.identity.subjectKind): a party of any other kind acts for subjects. */
  readonly subjectKind: string;
}

/** A rule's line, and, when it fails, the verdict the gate stops at. */
export interface RuleOutcome {
  readonly result: RuleResult;
  readonly fail?: Omit<GateDecision, 'call' | 'rules'>;
}
