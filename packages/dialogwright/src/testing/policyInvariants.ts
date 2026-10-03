import { isDeepStrictEqual } from 'node:util';
import type { App } from '../core/app/types';
import { gateOf } from '../core/app/lookup';
import { RULE_ID, type PolicyAction, type PolicySource, type Rule } from '../gate/compiled';
import { confirmationHash } from '../gate/lines';
import { maskId } from '../gate/principal';
import { isAnonymous, type GateDecision, type GateFacts, type Principal, type RuleResult } from '../gate/types';
import { gateGridCases, gateGridInput, type GateEvaluate, type GateGridCase, type GateGridInput } from './gateGrid';

/**
 * Test support: the policy's invariants, read from the file. `policyInvariants(app)` puts the app's
 * gate through the gate grid (gateGrid.ts) and holds every decision to what the policy's named rules
 * say, whatever order they are written in: an action not listed is blocked for everyone; a caller
 * below an action's level is never allowed; scope, confirmed, role, fields and attempts each refuse
 * what they exist to refuse; an allowed call ran every rule its action lists, and each passed;
 * raising a caller's level never turns an allow into a refusal; and the scope rule's answer does not
 * move with conversation state. Each failure names the invariant, the grid case and the rule.
 *
 * The invariants are derived from the policy as written (the compiled policy's source) and the
 * grid's lookups, not from the gate's own lines, so a gate that is wrong in a way its lines agree
 * with is still caught: the test of this module puts a gate with one bug per invariant through it.
 */

export const INVARIANTS = [
  'unlisted', 'level', 'scope', 'confirmed', 'role', 'fields', 'attempts', 'all-rules-passed', 'monotonic', 'scope-stable',
] as const;
export type InvariantName = (typeof INVARIANTS)[number];

/** What each invariant holds, in plain words. */
export const INVARIANT_ABOUT: Readonly<Record<InvariantName, string>> = {
  unlisted: 'an action the policy does not list is blocked for everyone',
  level: 'a caller below the action\'s level (raised by the call\'s purpose where the action checks identity) is never allowed',
  scope: 'with scope, a call naming a subject outside the caller\'s scope, an empty one or an unknown one is never allowed',
  confirmed: 'with confirmed, a call is never allowed unless it sends exactly the confirmed fields and the caller confirmed exactly their values',
  role: 'with role, a role the rule refuses or sends to a person, and a party acting for subjects with no role, is never allowed',
  fields: 'with fields, a call that sends a field beyond the list is never allowed',
  attempts: 'with attempts, a call is never allowed at the maximum of failed attempts',
  'all-rules-passed': 'an allowed call ran every rule its action lists, and each passed',
  monotonic: 'raising the caller\'s level never turns an allow into a refusal',
  'scope-stable': 'the scope rule\'s answer does not move with conversation state: the other params, the purpose, the facts, or anything the gate is not given',
};

export interface PolicyInvariantViolation {
  readonly invariant: InvariantName;
  /** The grid case (GateGridCase.key). */
  readonly key: string;
  /** The rule as the file writes it, e.g. "scope" or "custom R8"; for an action not listed, "(not in the policy)". */
  readonly rule: string;
  /** What the gate did and why that breaks the invariant. */
  readonly detail: string;
}

export interface PolicyInvariantReport {
  /** Grid cases evaluated. */
  readonly cases: number;
  /** Per invariant, the cases (or pairs) it applied to: where the gate had to refuse, or had to agree. */
  readonly applied: Readonly<Record<InvariantName, number>>;
  readonly violations: readonly PolicyInvariantViolation[];
}

export interface PolicyInvariantOptions {
  /** The gate to hold to the policy. Default: the app's own (gateOf). */
  readonly evaluate?: GateEvaluate;
  /** The grid. Default: gateGridInput(app). */
  readonly input?: GateGridInput;
}

export class PolicyInvariantError extends Error {
  constructor(readonly report: PolicyInvariantReport, appId: string) {
    super(`app "${appId}": ${formatPolicyInvariantViolations(report.violations)}`);
    this.name = 'PolicyInvariantError';
  }
}

/** Conversation state the gate is never given: what the scope-stable invariant adds to the facts. */
export const CONVERSATION_STATE_DAY = '2031-01-15';

const has = (obj: object | undefined, key: string): boolean => obj !== undefined && Object.hasOwn(obj, key);

/** A rule as the file writes it: a built-in by its name (which is the id its line is recorded under), a custom rule with its id. */
export function ruleLabel(rule: Rule): string {
  return rule.rule === 'custom' ? `custom ${rule.id}` : rule.rule;
}

/** The id a rule's line is recorded under. */
function idOf(rule: Rule): string {
  return rule.rule === 'custom' ? rule.id : RULE_ID[rule.rule];
}

function decisionText(d: GateDecision): string {
  const reason = d.reason === undefined ? '' : ` ${d.reason}`;
  const need = d.needLevel === undefined ? '' : ` to ${d.needLevel}`;
  return `${d.verdict}${reason}${need}`;
}

/** The rule a decision stopped at, as a label: the file's rule when its id is one the action lists. */
function stoppedAt(d: GateDecision, action: PolicyAction | undefined): string {
  const last = d.rules.at(-1);
  if (!last || last.pass) return '(none)';
  const rule = action?.rules.find((r) => idOf(r) === last.id);
  return rule ? ruleLabel(rule) : last.id;
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x) => b.includes(x));

/**
 * The scope rule's own subject for a call, from the call and the lookups alone: the param's value,
 * or the owner of the record it names; null for none (a missing param, an empty one, a record with
 * no owner).
 */
function subjectOf(rule: Extract<Rule, { rule: 'scope' }>, c: GateGridCase, input: GateGridInput): string | null {
  if (rule.subject === null) return null;
  const named = c.call.params[rule.subject.param] ?? '';
  const who = rule.subject.via === 'record' ? (named ? input.lookups.ownerOf(named) : null) : named;
  return who || null;
}

/** The scope lines of a decision, as compared across cases. */
function scopeLines(d: GateDecision): RuleResult[] {
  return d.rules.filter((r) => r.id === RULE_ID.scope);
}

/** Every violation of the policy's invariants by `options.evaluate` (default: the app's own gate) on the app's gate grid. */
export function checkPolicyInvariants(app: App, options: PolicyInvariantOptions = {}): PolicyInvariantReport {
  const input = options.input ?? gateGridInput(app);
  const gate = gateOf(app);
  const source: PolicySource = gate.source;
  const evaluate: GateEvaluate = options.evaluate ?? ((call, p, facts, lk) => gate.evaluate(call, p, facts, lk));
  const lk = input.lookups;
  const applied = Object.fromEntries(INVARIANTS.map((n) => [n, 0])) as Record<InvariantName, number>;
  const violations: PolicyInvariantViolation[] = [];
  const cases = gateGridCases(input);
  // The scope lines seen per (tool, caller, subject param values): the first case's, to compare the rest with.
  const scopeSeen = new Map<string, { key: string; lines: RuleResult[] }>();

  for (const c of cases) {
    const d = evaluate(c.call, c.p, c.facts, lk);
    const allowed = d.verdict === 'ALLOW';
    const action = has(source.actions, c.tool) ? source.actions[c.tool]! : undefined;
    const broke = (invariant: InvariantName, rule: string, detail: string): void => {
      violations.push({ invariant, key: c.key, rule, detail });
    };

    if (!action) {
      applied.unlisted += 1;
      if (d.verdict !== 'BLOCK') broke('unlisted', '(not in the policy)', `${decisionText(d)}, but ${c.tool} is an action the policy does not list`);
      continue;
    }

    const identityRule = action.rules.find((r) => r.rule === 'identity');
    const purposeLevel = identityRule && c.call.purpose !== undefined && has(source.purposes, c.call.purpose) ? source.purposes[c.call.purpose]! : 0;
    const need = Math.max(action.level, purposeLevel);
    if (c.p.level < need) {
      applied.level += 1;
      if (allowed) broke('level', identityRule ? ruleLabel(identityRule) : `level ${action.level}`, `ALLOW at level ${c.p.level}, but the action needs level ${need}${purposeLevel > action.level ? ` for the purpose ${c.call.purpose}` : ''}`);
    }

    const sent = Object.keys(c.call.params);
    for (const rule of action.rules) {
      switch (rule.rule) {
        case 'scope': {
          const who = subjectOf(rule, c, input);
          const scope = lk.scopeOf(c.p);
          if (who !== null && scope.includes(who)) break;
          applied.scope += 1;
          if (allowed) {
            const named = rule.subject === null ? 'no subject (the rule names no param)' : who === null ? `no subject (${rule.subject.param} is ${c.call.params[rule.subject.param] ? 'a record with no owner' : 'empty or missing'})` : `the subject ${maskId(who)}`;
            broke('scope', ruleLabel(rule), `ALLOW, but the call names ${named}, and the caller may see ${scope.length === 0 ? 'no one' : scope.map(maskId).join(', ')}`);
          }
          break;
        }
        case 'confirmed': {
          const exact = sameSet(sent, rule.fields);
          const matches = c.facts.confirmedHash !== null && c.facts.confirmedHash === confirmationHash(c.call.params, rule.fields);
          if (exact && matches) break;
          applied.confirmed += 1;
          if (allowed) broke('confirmed', ruleLabel(rule), `ALLOW, but ${!exact ? `the call sends [${sent.join(', ')}], not exactly [${rule.fields.join(', ')}]` : c.facts.confirmedHash === null ? 'the caller confirmed nothing' : 'the confirmed hash is not the hash of the call\'s values'}`);
          break;
        }
        case 'role': {
          if (isAnonymous(c.p)) break;
          const role = c.p.role;
          if (role === undefined) {
            if (c.p.kind === gate.subjectKind) break;
            applied.role += 1;
            if (allowed) broke('role', ruleLabel(rule), `ALLOW for a ${c.p.kind} with no role, who acts for subjects`);
            break;
          }
          const access = has(rule.access, role) ? rule.access[role]! : 'refuse';
          if (access === 'allow') break;
          applied.role += 1;
          if (allowed) broke('role', ruleLabel(rule), `ALLOW for the role ${role}, which the rule ${has(rule.access, role) ? `gives "${access}"` : 'does not name (refused)'}`);
          break;
        }
        case 'fields': {
          const extra = sent.filter((k) => !rule.fields.includes(k));
          if (extra.length === 0) break;
          applied.fields += 1;
          if (allowed) broke('fields', ruleLabel(rule), `ALLOW with ${extra.join(', ')}, beyond [${rule.fields.join(', ')}]`);
          break;
        }
        case 'attempts': {
          if (c.facts.attempts < source.maxAttempts) break;
          applied.attempts += 1;
          if (allowed) broke('attempts', ruleLabel(rule), `ALLOW at ${c.facts.attempts} failed attempts, the maximum being ${source.maxAttempts}`);
          break;
        }
        default:
          break;
      }
    }

    if (allowed) {
      applied['all-rules-passed'] += 1;
      const ran = d.rules.map((r) => r.id);
      const missing = action.rules.find((r) => {
        const id = idOf(r);
        return action.rules.filter((x) => idOf(x) === id).length > ran.filter((x) => x === id).length;
      });
      const failed = d.rules.find((r) => !r.pass);
      const extra = ran.find((id) => !action.rules.some((r) => idOf(r) === id));
      if (missing) broke('all-rules-passed', ruleLabel(missing), `ALLOW, but the rule never ran (ran: ${ran.join(', ') || 'none'})`);
      else if (failed) broke('all-rules-passed', failed.id, `ALLOW, but the rule's line failed (${failed.compared})`);
      else if (extra !== undefined) broke('all-rules-passed', extra, `ALLOW, after a rule the action does not list (ran: ${ran.join(', ')})`);
    }

    if (allowed && !isAnonymous(c.p) && c.p.level < 2) {
      for (let level = c.p.level + 1; level <= 2; level += 1) {
        const raised: Principal = { ...c.p, level: level as 1 | 2 };
        const higher = evaluate(c.call, raised, c.facts, lk);
        applied.monotonic += 1;
        if (higher.verdict !== 'ALLOW') broke('monotonic', stoppedAt(higher, action), `ALLOW at level ${c.p.level}, but ${decisionText(higher)} for the same caller at level ${level}`);
      }
    }

    const scopeRules = action.rules.filter((r): r is Extract<Rule, { rule: 'scope' }> => r.rule === 'scope');
    const lines = scopeLines(d);
    if (scopeRules.length > 0 && lines.length > 0) {
      const named = scopeRules.map((r) => (r.subject === null ? '-' : c.call.params[r.subject.param] ?? '(absent)'));
      const group = JSON.stringify([c.tool, c.principal, named]);
      const seen = scopeSeen.get(group);
      if (!seen) scopeSeen.set(group, { key: c.key, lines });
      else {
        applied['scope-stable'] += 1;
        if (!isDeepStrictEqual(seen.lines, lines)) broke('scope-stable', ruleLabel(scopeRules[0]!), `the scope line is ${JSON.stringify(lines[0])}, but for ${seen.key}, which names the same subject, it was ${JSON.stringify(seen.lines[0])}`);
      }
      // The same call with conversation state beside the facts (the session's slots naming a subject
      // the caller may see, what the caller said, another day): none of it is the gate's to read.
      const ownSubject = lk.scopeOf(c.p)[0] ?? input.matrix.records.own.subject;
      const slots = Object.fromEntries(scopeRules.flatMap((r) => (r.subject === null ? [] : [[r.subject.param, r.subject.via === 'record' ? input.matrix.records.own.record : ownSubject]])));
      const state = { ...c.facts, todayIso: CONVERSATION_STATE_DAY, slots, subject: ownSubject, said: 'it is my own record' } as GateFacts;
      const moved = scopeLines(evaluate(c.call, c.p, state, lk));
      if (moved.length > 0) {
        applied['scope-stable'] += 1;
        if (!isDeepStrictEqual(moved, lines)) broke('scope-stable', ruleLabel(scopeRules[0]!), `the scope line is ${JSON.stringify(lines[0])}, but ${JSON.stringify(moved[0])} with conversation state beside the facts`);
      }
    }
  }
  return { cases: cases.length, applied, violations };
}

/**
 * The policy's invariants, asserted: the report when the gate holds to every one on the app's grid,
 * a PolicyInvariantError naming each violation (its invariant, case and rule) when it does not.
 */
export function policyInvariants(app: App, options: PolicyInvariantOptions = {}): PolicyInvariantReport {
  const report = checkPolicyInvariants(app, options);
  if (report.violations.length > 0) throw new PolicyInvariantError(report, app.id);
  return report;
}

/** Violations as lines for a person: "[invariant] case: rule: what happened", the first `limit`, then a count. */
export function formatPolicyInvariantViolations(violations: readonly PolicyInvariantViolation[], limit = 20): string {
  const lines = [`${violations.length} policy invariant violation${violations.length === 1 ? '' : 's'}`];
  for (const v of violations.slice(0, limit)) lines.push(`  [${v.invariant}] ${v.key}: ${v.rule}: ${v.detail}`);
  if (violations.length > limit) lines.push(`  ... and ${violations.length - limit} more`);
  const by = new Map<InvariantName, number>();
  for (const v of violations) by.set(v.invariant, (by.get(v.invariant) ?? 0) + 1);
  if (by.size > 0) lines.push(`  by invariant: ${[...by].map(([n, k]) => `${n} ${k}`).join(', ')}`);
  return lines.join('\n');
}
