import type { PolicyTables } from '../core/app/types';
import { askerOf, checkOutcome, confirmationHash, DEFAULT_RECORD_OWNER, DEFAULT_ROLE_PERSON_REASON, DEFAULT_SCOPE, DEFAULT_SUBJECT, DEFAULT_TOOL_LEVEL, defaultRoleLine, scopeShown, threwLine, unknownRuleLine, unlistedLine } from './lines';
import { maskId } from './principal';
import { isAnonymous, type GateDecision, type GateFacts, type GateLookups, type Level, type Principal, type RuleContext, type RuleOutcome, type RuleResult, type ToolCall } from './types';

/**
 * The legacy evaluator: the gate's rules over the app's flattened tables (App.policy, PolicyTables).
 * The gate a call goes through reads the policy's named rules instead (./compiled.ts, CompiledPolicy);
 * this one stays, unchanged in what it decides and in the ids it records (R1..R7, R0), as the
 * reference the shadow gate compares that one with (dialogwright/testing withShadowGate,
 * legacyGateEvaluator, which maps these ids to the rules' names).
 *
 * What a tool needs, which rules it runs and in what order, what each rule compares against and the
 * words its lines use are the app's tables; the built-in rules are here, each with a test in
 * policy.test.ts, and an app may add its own (PolicyTables.customRules). Rules run in the order
 * listed for a tool and stop at the first failure. Rules fail closed: a missing param, an unknown
 * record, or a tool not in the app's rulesFor all resolve to BLOCK rather than ALLOW.
 */

export { confirmationHash };

/** The gate's built-in rules; an app's rulesFor names these or its own customRules (validateApp checks). */
export const RULE_IDS = ['R1', 'R2', 'R3', 'R5', 'R6', 'R7'] as const;
export type RuleId = (typeof RULE_IDS)[number];

export function isRuleId(id: string): id is RuleId {
  return (RULE_IDS as readonly string[]).includes(id);
}

function needLevel(call: ToolCall, policy: PolicyTables): Level {
  const purpose = call.purpose ? policy.purposeLevel[call.purpose] ?? 0 : 0;
  // Not reached without a level for an app whose every tool in rulesFor has one.
  // Were one missing, it would fail closed, at the highest level.
  return Math.max(policy.toolLevel[call.tool] ?? DEFAULT_TOOL_LEVEL, purpose) as Level;
}

const RULE: Record<RuleId, (c: RuleContext) => RuleOutcome> = {
  R1: (c) => {
    const need = needLevel(c.call, c.policy);
    const pass = c.p.level >= need;
    const result = { id: 'R1', description: 'Identity strong enough for this action', compared: `identity.level ${c.p.level} >= ${need}`, pass };
    // A party who is not one of the app's subjects has no factors to give, so cannot step up: BLOCK.
    const cannotStepUp = !isAnonymous(c.p) && c.p.kind !== c.subjectKind;
    return pass ? { result } : { result, fail: cannotStepUp ? { verdict: 'BLOCK', reason: 'identity' } : { verdict: 'STEP_UP', needLevel: need } };
  },
  R2: (c) => {
    const words = c.policy.wording;
    const row = Object.hasOwn(c.policy.subjects, c.call.tool) ? c.policy.subjects[c.call.tool] : undefined;
    const asker = askerOf(c.p, c.subjectKind);
    const description = (asker && words?.scope?.[asker]?.[row?.via === 'record' ? 'record' : 'param']) ?? DEFAULT_SCOPE;
    const scope = c.lk.scopeOf(c.p);
    if (!row) {
      // A tool that runs R2 but names no subject: nothing to compare, so it fails closed.
      const result = { id: 'R2', description, compared: `tool ${c.call.tool} names no subject · caller may see ${scopeShown(scope)}`, pass: false };
      return { result, fail: { verdict: 'BLOCK', reason: 'scope' } };
    }
    const named = c.call.params[row.param] ?? '';
    // An empty owner is no owner: '' never names a subject, so it fails closed like a missing one.
    const subject = (row.via === 'record' ? (named ? c.lk.ownerOf(named) : null) : named) || null;
    // No subject to protect (a missing param or a record that doesn't exist) fails closed: the same
    // BLOCK either way, so the line can't be used to learn which records or subjects exist.
    const pass = subject !== null && scope.includes(subject);
    // Plain language for the console and the audit line; ids by their last four only.
    const owner = row.via === 'record'
      ? `${words?.recordOwner ?? DEFAULT_RECORD_OWNER} ${subject !== null ? maskId(subject) : 'unknown'}`
      : `${words?.subject ?? DEFAULT_SUBJECT} ${subject !== null ? maskId(subject) : 'missing'}`;
    const result = { id: 'R2', description, compared: `${owner} · caller may see ${scopeShown(scope)}`, pass };
    return pass ? { result } : { result, fail: { verdict: 'BLOCK', reason: 'scope' } };
  },
  R3: (c) => {
    const keys = c.policy.confirmedFields;
    const paramKeys = Object.keys(c.call.params);
    const extra = paramKeys.filter((k) => !keys.includes(k));
    const missing = keys.filter((k) => !paramKeys.includes(k));
    if (extra.length > 0 || missing.length > 0) {
      const compared = extra.length > 0 ? `extra fields: ${extra.join(', ')}` : `missing fields: ${missing.join(', ')}`;
      const result = { id: 'R3', description: 'The caller confirmed exactly these values', compared, pass: false };
      return { result, fail: { verdict: 'BLOCK', reason: 'confirmation' } };
    }
    const pass = c.facts.confirmedHash !== null && c.facts.confirmedHash === confirmationHash(c.call.params, keys);
    const result = { id: 'R3', description: 'The caller confirmed exactly these values', compared: pass ? 'confirmed hash = call hash' : c.facts.confirmedHash ? 'confirmed hash != call hash' : 'no confirmation', pass };
    return pass ? { result } : { result, fail: { verdict: 'BLOCK', reason: 'confirmation' } };
  },
  R5: (c) => {
    const description = 'The caller\'s role allows this action';
    const role = isAnonymous(c.p) ? undefined : c.p.role;
    if (role === undefined) {
      // No role: an anonymous caller (R1 stops one first) or one of the app's subjects passes. A party
      // of any other kind acts for subjects, and one built without a role may do nothing a role governs.
      const compared = `role ${c.p.kind}`;
      if (isAnonymous(c.p) || c.p.kind === c.subjectKind) return { result: { id: 'R5', description, compared, pass: true } };
      return { result: { id: 'R5', description, compared: `${compared}: none`, pass: false }, fail: { verdict: 'BLOCK', reason: 'role' } };
    }
    // What the app's roles table says this role may do with the tool. A role or a tool with no row
    // may not: it fails closed. The compared line says which, as the console shows it.
    const access = c.policy.roles?.[c.call.tool]?.[role] ?? 'refuse';
    const compared = (c.policy.wording?.role ?? defaultRoleLine)(role, c.call.tool, access);
    if (access === 'allow') return { result: { id: 'R5', description, compared, pass: true } };
    const result = { id: 'R5', description, compared, pass: false };
    const fail = access === 'person'
      ? { verdict: 'NEEDS_HUMAN' as const, reason: c.policy.rolePersonReason ?? DEFAULT_ROLE_PERSON_REASON }
      : { verdict: 'BLOCK' as const, reason: 'role' };
    return { result, fail };
  },
  R6: (c) => {
    const n = c.facts.attempts;
    const max = c.policy.maxAttempts;
    const pass = n < max;
    const result = { id: 'R6', description: 'Identity attempts under the limit', compared: `attempts ${n} < ${max}`, pass };
    return pass ? { result } : { result, fail: { verdict: 'NEEDS_HUMAN', reason: 'attempts' } };
  },
  R7: (c) => {
    const allowed = c.policy.serviceFields[c.call.tool] ?? [];
    const extra = Object.keys(c.call.params).filter((k) => !allowed.includes(k));
    const pass = extra.length === 0;
    const result = { id: 'R7', description: 'Only the fields this agent may receive', compared: pass ? `fields within [${allowed.join(', ')}]` : `extra fields: ${extra.join(', ')}`, pass };
    return pass ? { result } : { result, fail: { verdict: 'BLOCK', reason: 'minimization' } };
  },
};

/**
 * The gate's decision on a call, by the app's policy tables (App.policy): the rules its rulesFor
 * lists for the tool, in order, stopping at the first failure. A tool with no row is not on the
 * approved list (R0). A rule id is a built-in's or one of the app's customRules; one that is neither
 * fails closed, though validateApp refuses an app that names one. `subjectKind` is the app's
 * (App.identity.subjectKind).
 */
export function evaluateCall(call: ToolCall, p: Principal, facts: GateFacts, lk: GateLookups, policy: PolicyTables, subjectKind: string): GateDecision {
  const ids = Object.hasOwn(policy.rulesFor, call.tool) ? policy.rulesFor[call.tool] : undefined;
  if (!ids) {
    return { call, rules: [unlistedLine(call.tool, 'R0')], verdict: 'BLOCK', reason: 'unknown-tool' };
  }
  const ctx: RuleContext = { call, p, facts, lk, policy, subjectKind };
  const rules: RuleResult[] = [];
  for (const id of ids) {
    const custom = policy.customRules && Object.hasOwn(policy.customRules, id) ? policy.customRules[id] : undefined;
    const rule = isRuleId(id) ? RULE[id] : custom;
    if (!rule) {
      rules.push(unknownRuleLine(id));
      return { call, rules, verdict: 'BLOCK', reason: 'unknown-rule' };
    }
    // A rule that throws (an app's own, or the app's lookups under a built-in) BLOCKs: the error never
    // leaves the gate, and the call fails closed.
    let o: RuleOutcome;
    try {
      o = rule(ctx);
    } catch {
      rules.push(threwLine(id));
      return { call, rules, verdict: 'BLOCK', reason: 'rule-error' };
    }
    const checked = checkOutcome(id, o);
    rules.push(checked.result);
    if (checked.fail) return { call, rules, ...checked.fail };
  }
  return { call, rules, verdict: 'ALLOW' };
}
