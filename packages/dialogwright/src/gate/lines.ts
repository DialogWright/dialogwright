import { createHash } from 'node:crypto';
import type { RoleAccess, ScopeAsker, ToolName } from '../core/app/types';
import { maskId } from './principal';
import { isAnonymous, type GateVerdict, type Level, type Principal, type RuleOutcome, type RuleResult } from './types';

/**
 * What the gate's built-in rules say and how the gate takes a rule's answer, shared by the gate that
 * reads named rules (./compiled.ts) and the legacy evaluator over the tables (./policy.ts
 * evaluateCall), which stays as the shadow gate's reference. Each rule's logic is written in each of
 * the two on its own, so the shadow compares two implementations; only the words and the outcome
 * check are one.
 */

/** A tool the app gave no level: the highest, so it fails closed. */
export const DEFAULT_TOOL_LEVEL: Level = 2;

/** The engine's own words for the built-in rules' lines, where the app gives none (PolicyTables.wording). */
export const DEFAULT_SCOPE = 'The record belongs to someone this caller may see';
export const DEFAULT_RECORD_OWNER = 'record owner';
export const DEFAULT_SUBJECT = 'subject';
export const DEFAULT_ROLE_PERSON_REASON = 'role-person';

export function defaultRoleLine(role: string, tool: ToolName, access: RoleAccess): string {
  return `role ${role} may ${tool}: ${access === 'allow' ? 'yes' : access === 'person' ? 'with a person' : 'no'}`;
}

/**
 * The hash the confirmed rule (R3) compares: the exact values a write will send, over the confirmed
 * fields in their fixed order.
 */
export function confirmationHash(params: Readonly<Record<string, string>>, fields: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(fields.map((k) => [k, params[k] ?? ''])), 'utf8').digest('hex');
}

/** Who asks, as the scope rule (R2) words it; null for an anonymous caller (R1 steps one up before R2 runs). */
export function askerOf(p: Principal, subjectKind: string): ScopeAsker | null {
  if (isAnonymous(p)) return null;
  return p.kind === subjectKind ? 'subject' : 'delegate';
}

/** Who the caller may see, masked: "...1234 only" for one, a list for several, "no one" for none. */
export function scopeShown(scope: readonly string[]): string {
  if (scope.length === 0) return 'no one';
  if (scope.length === 1) return `${maskId(scope[0]!)} only`;
  return scope.map(maskId).join(', ');
}

/** The line for a tool no action lists (R0). */
export function unlistedLine(tool: ToolName): RuleResult {
  return { id: 'R0', description: 'The action is on the approved list', compared: `tool ${tool} not in policy`, pass: false };
}

/** The line for a rule id that is neither a built-in nor one of the app's rules. */
export function unknownRuleLine(id: string): RuleResult {
  return { id, description: 'A rule the gate knows', compared: `rule ${id} unknown`, pass: false };
}

/** The line for a rule that threw. */
export function threwLine(id: string): RuleResult {
  return { id, description: 'A rule the gate could run', compared: `rule ${id} threw`, pass: false };
}

const FAIL_VERDICTS: ReadonlySet<GateVerdict> = new Set(['BLOCK', 'STEP_UP', 'NEEDS_HUMAN']);

/**
 * A rule's outcome as the gate takes it. The line is stamped with the rule's own id, so no rule can
 * speak as another. An outcome that does not hold together (a failed line with nothing to stop at, a
 * stop that is not a failing verdict, or a malformed line) BLOCKs: an app's rule cannot ALLOW a call
 * past the rules after it, or leave the gate without a verdict.
 */
export function checkOutcome(id: string, o: RuleOutcome): RuleOutcome {
  const r = (o as Partial<RuleOutcome> | null | undefined)?.result;
  const fail = (o as Partial<RuleOutcome> | null | undefined)?.fail;
  const lineOk = typeof r === 'object' && r !== null && typeof r.pass === 'boolean'
    && typeof r.description === 'string' && typeof r.compared === 'string';
  const failOk = fail === undefined || (typeof fail === 'object' && fail !== null && FAIL_VERDICTS.has(fail.verdict)
    && (fail.reason === undefined || typeof fail.reason === 'string')
    && (fail.needLevel === undefined || fail.needLevel === 1 || fail.needLevel === 2));
  // A passing line goes on; a failing one stops, at a failing verdict.
  if (!lineOk || !failOk || r.pass !== (fail === undefined)) {
    return { result: { id, description: 'A rule that answers as the gate needs', compared: `rule ${id} answered invalidly`, pass: false }, fail: { verdict: 'BLOCK', reason: 'rule-invalid' } };
  }
  const result: RuleResult = { id, description: r.description, compared: r.compared, pass: r.pass };
  if (fail === undefined) return { result };
  // Only the decision's own fields are taken: a rule cannot replace the call or the lines before it.
  return {
    result,
    fail: { verdict: fail.verdict, ...(fail.reason === undefined ? {} : { reason: fail.reason }), ...(fail.needLevel === undefined ? {} : { needLevel: fail.needLevel }) },
  };
}
