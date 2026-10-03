import type { PolicyTables, PolicyWording, RoleAccess, SubjectParam, ToolName } from '../core/app/types';
import { DATE_IN_RANGE_ID, dateInRangeRule, LIMIT_ID, limitRule, type DateInRangeParams, type LimitParams } from './bounded';
import {
  askerOf, checkOutcome, confirmationHash, DEFAULT_RECORD_OWNER, DEFAULT_ROLE_PERSON_REASON, DEFAULT_SCOPE, DEFAULT_SUBJECT, DEFAULT_TOOL_LEVEL, defaultRoleLine,
  scopeShown, threwLine, unknownRuleLine, unlistedLine,
} from './lines';
import { maskId } from './principal';
import { isAnonymous, type GateDecision, type GateFacts, type GateLookups, type Level, type Principal, type RuleContext, type RuleOutcome, type RuleResult, type ToolCall } from './types';

/**
 * The gate as it reads the policy: each action's named rules with their own parameters, in the
 * order written (policy.yaml's `rules:`), compiled once into a CompiledPolicy whose `evaluate` is
 * the decision on a call. The lifecycle asks it for every call (core/app/lookup.ts gateOf).
 *
 * Each built-in rule takes its parameters from the rule as the action lists it, not from tables
 * shared across actions: `identity` the action's level and the purposes, `scope` its param or
 * record, `role` its roles and its own reason (Decision 4), `confirmed` its own fields (Decision 5;
 * the summary hash is still taken over one list, PolicyTables.confirmedFields, which `check` keeps
 * equal to every action's), `attempts` the identity file's maximum, `fields` its params, `custom`
 * the app's rule of that id. Each records itself under its name (`identity`, `scope`, `confirmed`,
 * `role`, `attempts`, `fields`; a custom rule under its own id) with the words it has always used,
 * so a decision, its lines and its audit row are what the legacy evaluator (./policy.ts
 * evaluateCall) gives over the compiled tables, except that the legacy evaluator still records the
 * ids it always did (R1..R7, R0); the shadow gate (dialogwright/testing withShadowGate) holds the
 * two together through one id map (testing/gateGrid.ts nameOfLegacyId).
 *
 * Two built-in rules are the file's alone (./bounded.ts): `dateInRange` and `limit`, which hold a
 * param's value to bounds (literals, today, the app's lookups). The legacy evaluator does not know
 * them, so an app that uses one has no shadow reference for it.
 *
 * It fails closed as the legacy one does: an action not listed is `unlisted`, a custom rule the app does not
 * define BLOCKs (unknown-rule), a rule that throws BLOCKs (rule-error), and a rule's answer that does
 * not hold together BLOCKs (rule-invalid, ./lines.ts checkOutcome).
 */

/**
 * One rule as an action lists it: its name and its parameters. A file's rules always name what they
 * read; the scope rule's subject is null only for tables an app wrote by hand that run the scope rule for a tool
 * with no subjects row (programFromTables), which fails closed.
 */
export type Rule =
  | { readonly rule: 'identity' }
  | { readonly rule: 'attempts' }
  | { readonly rule: 'scope'; readonly subject: SubjectParam | null }
  | { readonly rule: 'role'; readonly access: Readonly<Record<string, RoleAccess>>; readonly reason?: string }
  | { readonly rule: 'confirmed'; readonly fields: readonly string[] }
  | { readonly rule: 'fields'; readonly fields: readonly string[] }
  | ({ readonly rule: 'dateInRange' } & DateInRangeParams)
  | ({ readonly rule: 'limit' } & LimitParams)
  | { readonly rule: 'custom'; readonly id: string };

/** The rules the legacy evaluator knows. */
export type LegacyRuleName = 'identity' | 'scope' | 'confirmed' | 'role' | 'attempts' | 'fields';

/**
 * The id each of those rules has in a table's `rulesFor` (and in the legacy evaluator's decisions and
 * lines): the ids tables written by hand, the converter and the legacy evaluator still use. The gate
 * records each under its name (RULE_ID).
 */
export const LEGACY_RULE_ID: Readonly<Record<LegacyRuleName, string>> = { identity: 'R1', scope: 'R2', confirmed: 'R3', role: 'R5', attempts: 'R6', fields: 'R7' };

/** The id the legacy evaluator records for an action that is not listed; the gate records it as UNLISTED_RULE_ID. */
export const LEGACY_UNLISTED_ID = 'R0';

/** The built-in rules, by name: what an action's `rules:` writes. */
export const BUILT_IN_RULES = ['identity', 'scope', 'confirmed', 'role', 'attempts', 'fields', 'dateInRange', 'limit'] as const;

/**
 * The id each built-in rule is recorded under in decisions, audit lines, the trace and the console:
 * its own name. A custom rule is recorded under the id the app gave it, which may be none of these.
 */
export const RULE_ID: Readonly<Record<Exclude<Rule['rule'], 'custom'>, string>> = {
  identity: 'identity', scope: 'scope', confirmed: 'confirmed', role: 'role', attempts: 'attempts', fields: 'fields', dateInRange: DATE_IN_RANGE_ID, limit: LIMIT_ID,
};

/**
 * The id the gate records for an action no policy lists, which no action writes as a rule: the line
 * that says the tool is not on the approved list. Reserved like a built-in's name.
 */
export const UNLISTED_RULE_ID = 'unlisted';

/**
 * The id each built-in rule has in a table's `rulesFor`: the legacy id of the rules the legacy
 * evaluator knows, and its own name for a rule it does not (dateInRange, limit).
 */
export const TABLE_RULE_ID: Readonly<Record<Exclude<Rule['rule'], 'custom'>, string>> = { ...LEGACY_RULE_ID, dateInRange: DATE_IN_RANGE_ID, limit: LIMIT_ID };

/**
 * Whether an id is a built-in's, so no app's own rule may take it: a rule's name, the unlisted
 * line's, or a legacy id (R0, R1..R7), which tables, the converter and every audit file written
 * before rules were named still use for the built-ins.
 */
export function isBuiltInRuleId(id: string): boolean {
  return (BUILT_IN_RULES as readonly string[]).includes(id) || id === UNLISTED_RULE_ID || id === LEGACY_UNLISTED_ID || Object.values(LEGACY_RULE_ID).includes(id);
}

/** The ids no app's own rule may take, in words for a message. */
export const BUILT_IN_IDS_NOTE = `the built-in ids are the rules' names (${[...BUILT_IN_RULES, UNLISTED_RULE_ID].join(', ')}) and their old ids (${[LEGACY_UNLISTED_ID, ...Object.values(LEGACY_RULE_ID)].join(', ')})`;

/**
 * The ids of the built-in rules only a policy file can give parameters to (gate/bounded.ts): the
 * legacy evaluator over the tables does not know them (it BLOCKs a call that reaches one, as an
 * unknown rule), and an app's own rule may not take one as its id.
 */
export const NAMED_RULE_IDS: readonly string[] = [DATE_IN_RANGE_ID, LIMIT_ID];

/** An action as the policy lists it: the level it needs and its rules, in order. */
export interface PolicyAction {
  /** What the action does, in plain words (policy.yaml's `say`): the policy card's label. The gate never reads it. */
  readonly say?: string;
  readonly level: Level;
  readonly rules: readonly Rule[];
}

/** The policy as written, read: what a CompiledPolicy is built from. */
export interface PolicySource {
  /** Per tool, its action. A tool not here is not on the approved list (unlisted). */
  readonly actions: Readonly<Record<ToolName, PolicyAction>>;
  /** The level a form's purpose raises a call to. */
  readonly purposes: Readonly<Record<string, Level>>;
  /** The failed tries the attempts rule allows (identity.yaml's). */
  readonly maxAttempts: number;
  /** The words the built-in rules' lines use. */
  readonly wording?: PolicyWording;
  /** The app's own rules, by the id `custom:` names them by. */
  readonly customRules?: PolicyTables['customRules'];
}

/** The gate an app's calls go through (App.gate): the policy's named rules, compiled. */
export interface CompiledPolicy {
  /** What it was compiled from. */
  readonly source: PolicySource;
  /** The tables the same policy compiles to: what an app's own rule reads as RuleContext.policy. */
  readonly tables: PolicyTables;
  /** The app's subject kind (App.identity.subjectKind; '' for an app that verifies no one). */
  readonly subjectKind: string;
  /** The gate's decision on a call: the action's rules, in order, stopping at the first failure. */
  evaluate(call: ToolCall, p: Principal, facts: GateFacts, lk: GateLookups): GateDecision;
}

/** A rule compiled: the id it records itself under, and what it runs (null: a custom rule the app does not define). */
interface Step {
  readonly id: string;
  readonly run: ((c: RuleContext) => RuleOutcome) | null;
}

const has = (obj: object | undefined, key: string): boolean => obj !== undefined && Object.hasOwn(obj, key);

// ---------------------------------------------------------------------------------------------
// The built-in rules, each taking its own parameters
// ---------------------------------------------------------------------------------------------

/** identity: the principal's level against the action's, raised by the call's purpose. */
function identityRule(level: Level, purposes: Readonly<Record<string, Level>>): (c: RuleContext) => RuleOutcome {
  return (c) => {
    const purpose = c.call.purpose && has(purposes, c.call.purpose) ? purposes[c.call.purpose]! : 0;
    const need = Math.max(level, purpose) as Level;
    const pass = c.p.level >= need;
    const result = { id: 'identity', description: 'Identity strong enough for this action', compared: `identity.level ${c.p.level} >= ${need}`, pass };
    // A party who is not one of the app's subjects has no factors to give, so cannot step up: BLOCK.
    const cannotStepUp = !isAnonymous(c.p) && c.p.kind !== c.subjectKind;
    return pass ? { result } : { result, fail: cannotStepUp ? { verdict: 'BLOCK', reason: 'identity' } : { verdict: 'STEP_UP', needLevel: need } };
  };
}

/** scope: the subject the call names (by its param, or a record's owner) is one the caller may see. */
function scopeRule(subject: SubjectParam | null, wording: PolicyWording | undefined): (c: RuleContext) => RuleOutcome {
  const asRecord = subject?.via === 'record';
  return (c) => {
    const asker = askerOf(c.p, c.subjectKind);
    const description = (asker && wording?.scope?.[asker]?.[asRecord ? 'record' : 'param']) ?? DEFAULT_SCOPE;
    const scope = c.lk.scopeOf(c.p);
    if (subject === null) {
      // Nothing to compare: it fails closed.
      const result = { id: 'scope', description, compared: `tool ${c.call.tool} names no subject · caller may see ${scopeShown(scope)}`, pass: false };
      return { result, fail: { verdict: 'BLOCK', reason: 'scope' } };
    }
    const named = c.call.params[subject.param] ?? '';
    // An empty owner is no owner: '' never names a subject, so it fails closed like a missing one.
    const who = (asRecord ? (named ? c.lk.ownerOf(named) : null) : named) || null;
    // No subject (a missing param or a record that does not exist) fails closed, the same BLOCK
    // either way, so the line cannot be used to learn which records or subjects exist.
    const pass = who !== null && scope.includes(who);
    const owner = asRecord
      ? `${wording?.recordOwner ?? DEFAULT_RECORD_OWNER} ${who !== null ? maskId(who) : 'unknown'}`
      : `${wording?.subject ?? DEFAULT_SUBJECT} ${who !== null ? maskId(who) : 'missing'}`;
    const result = { id: 'scope', description, compared: `${owner} · caller may see ${scopeShown(scope)}`, pass };
    return pass ? { result } : { result, fail: { verdict: 'BLOCK', reason: 'scope' } };
  };
}

/** confirmed: the call sends exactly these fields, and the caller confirmed exactly their values. */
function confirmedRule(fields: readonly string[]): (c: RuleContext) => RuleOutcome {
  const description = 'The caller confirmed exactly these values';
  return (c) => {
    const sent = Object.keys(c.call.params);
    const extra = sent.filter((k) => !fields.includes(k));
    const missing = fields.filter((k) => !sent.includes(k));
    if (extra.length > 0 || missing.length > 0) {
      const compared = extra.length > 0 ? `extra fields: ${extra.join(', ')}` : `missing fields: ${missing.join(', ')}`;
      return { result: { id: 'confirmed', description, compared, pass: false }, fail: { verdict: 'BLOCK', reason: 'confirmation' } };
    }
    const held = c.facts.confirmedHash;
    const pass = held !== null && held === confirmationHash(c.call.params, fields);
    const result = { id: 'confirmed', description, compared: pass ? 'confirmed hash = call hash' : held ? 'confirmed hash != call hash' : 'no confirmation', pass };
    return pass ? { result } : { result, fail: { verdict: 'BLOCK', reason: 'confirmation' } };
  };
}

/** role: what this rule lets the caller's role do with the action; a role it does not name is refused. */
function roleRule(access: Readonly<Record<string, RoleAccess>>, reason: string, wording: PolicyWording | undefined): (c: RuleContext) => RuleOutcome {
  const description = 'The caller\'s role allows this action';
  const line = wording?.role ?? defaultRoleLine;
  return (c) => {
    const role = isAnonymous(c.p) ? undefined : c.p.role;
    if (role === undefined) {
      // No role: an anonymous caller (identity stops one first) or one of the app's subjects passes. A party
      // of any other kind acts for subjects, and one built without a role may do nothing a role governs.
      const compared = `role ${c.p.kind}`;
      if (isAnonymous(c.p) || c.p.kind === c.subjectKind) return { result: { id: 'role', description, compared, pass: true } };
      return { result: { id: 'role', description, compared: `${compared}: none`, pass: false }, fail: { verdict: 'BLOCK', reason: 'role' } };
    }
    const may: RoleAccess = has(access, role) ? access[role]! : 'refuse';
    const compared = line(role, c.call.tool, may);
    if (may === 'allow') return { result: { id: 'role', description, compared, pass: true } };
    const fail = may === 'person' ? { verdict: 'NEEDS_HUMAN' as const, reason } : { verdict: 'BLOCK' as const, reason: 'role' };
    return { result: { id: 'role', description, compared, pass: false }, fail };
  };
}

/** attempts: the call's identity check has failed fewer times than the identity file allows. */
function attemptsRule(max: number): (c: RuleContext) => RuleOutcome {
  return (c) => {
    const n = c.facts.attempts;
    const pass = n < max;
    const result = { id: 'attempts', description: 'Identity attempts under the limit', compared: `attempts ${n} < ${max}`, pass };
    return pass ? { result } : { result, fail: { verdict: 'NEEDS_HUMAN', reason: 'attempts' } };
  };
}

/** fields: the call sends on no field but these. */
function fieldsRule(fields: readonly string[]): (c: RuleContext) => RuleOutcome {
  return (c) => {
    const extra = Object.keys(c.call.params).filter((k) => !fields.includes(k));
    const pass = extra.length === 0;
    const result = { id: 'fields', description: 'Only the fields this agent may receive', compared: pass ? `fields within [${fields.join(', ')}]` : `extra fields: ${extra.join(', ')}`, pass };
    return pass ? { result } : { result, fail: { verdict: 'BLOCK', reason: 'minimization' } };
  };
}

function stepOf(rule: Rule, action: PolicyAction, source: PolicySource): Step {
  switch (rule.rule) {
    case 'identity': return { id: RULE_ID.identity, run: identityRule(action.level, source.purposes) };
    case 'scope': return { id: RULE_ID.scope, run: scopeRule(rule.subject, source.wording) };
    case 'confirmed': return { id: RULE_ID.confirmed, run: confirmedRule(rule.fields) };
    case 'role': return { id: RULE_ID.role, run: roleRule(rule.access, rule.reason ?? DEFAULT_ROLE_PERSON_REASON, source.wording) };
    case 'attempts': return { id: RULE_ID.attempts, run: attemptsRule(source.maxAttempts) };
    case 'fields': return { id: RULE_ID.fields, run: fieldsRule(rule.fields) };
    case 'dateInRange': return { id: RULE_ID.dateInRange, run: dateInRangeRule(rule) };
    case 'limit': return { id: RULE_ID.limit, run: limitRule(rule) };
    case 'custom': return { id: rule.id, run: has(source.customRules, rule.id) ? source.customRules![rule.id]! : null };
  }
}

// ---------------------------------------------------------------------------------------------
// Compiling
// ---------------------------------------------------------------------------------------------

/**
 * The policy's named rules compiled into the gate. `tables` is what the same policy compiles to (an
 * app's own rule reads it as RuleContext.policy); `subjectKind` is the app's.
 */
export function compileGate(source: PolicySource, tables: PolicyTables, subjectKind: string): CompiledPolicy {
  const steps = new Map<ToolName, readonly Step[]>();
  for (const [tool, action] of Object.entries(source.actions)) steps.set(tool, action.rules.map((rule) => stepOf(rule, action, source)));
  return {
    source,
    tables,
    subjectKind,
    evaluate(call, p, facts, lk) {
      const listed = steps.get(call.tool);
      if (!listed) return { call, rules: [unlistedLine(call.tool, UNLISTED_RULE_ID)], verdict: 'BLOCK', reason: 'unknown-tool' };
      const ctx: RuleContext = { call, p, facts, lk, policy: tables, subjectKind };
      const rules: RuleResult[] = [];
      for (const step of listed) {
        if (!step.run) {
          rules.push(unknownRuleLine(step.id));
          return { call, rules, verdict: 'BLOCK', reason: 'unknown-rule' };
        }
        // A rule that throws (an app's own, or the app's lookups under a built-in) BLOCKs: the error
        // never leaves the gate, and the call fails closed.
        let o: RuleOutcome;
        try {
          o = step.run(ctx);
        } catch {
          rules.push(threwLine(step.id));
          return { call, rules, verdict: 'BLOCK', reason: 'rule-error' };
        }
        const checked = checkOutcome(step.id, o);
        rules.push(checked.result);
        if (checked.fail) return { call, rules, ...checked.fail };
      }
      return { call, rules, verdict: 'ALLOW' };
    },
  };
}

/** The built-in rule each legacy id names, in the tables an app wrote by hand (rulesFor). */
const BUILT_IN_OF: Readonly<Record<string, LegacyRuleName>> = Object.fromEntries(Object.entries(LEGACY_RULE_ID).map(([rule, id]) => [id, rule as LegacyRuleName]));

/**
 * The adapter for an app built by hand with tables only: its tables read as the policy they say.
 * Each rulesFor id becomes the rule it names, with the parameters the tables hold for it (the
 * tool's level, subjects row, roles row and service fields; the one confirmed list, the one person
 * reason, the attempts), so the gate decides over it as over a file compiled to the same tables.
 */
export function programFromTables(tables: PolicyTables): PolicySource {
  const actions: Record<ToolName, PolicyAction> = {};
  for (const [tool, ids] of Object.entries(tables.rulesFor)) {
    const level = has(tables.toolLevel, tool) ? tables.toolLevel[tool]! : DEFAULT_TOOL_LEVEL;
    const rules = ids.map((id): Rule => {
      switch (has(BUILT_IN_OF, id) ? BUILT_IN_OF[id] : undefined) {
        case 'identity': return { rule: 'identity' };
        case 'scope': return { rule: 'scope', subject: has(tables.subjects, tool) ? tables.subjects[tool]! : null };
        case 'confirmed': return { rule: 'confirmed', fields: tables.confirmedFields };
        case 'role': {
          const access = has(tables.roles, tool) ? tables.roles![tool]! : {};
          return tables.rolePersonReason === undefined ? { rule: 'role', access } : { rule: 'role', access, reason: tables.rolePersonReason };
        }
        case 'attempts': return { rule: 'attempts' };
        case 'fields': return { rule: 'fields', fields: has(tables.serviceFields, tool) ? tables.serviceFields[tool] ?? [] : [] };
        default: return { rule: 'custom', id };
      }
    });
    actions[tool] = { level, rules };
  }
  const source: { -readonly [K in keyof PolicySource]: PolicySource[K] } = { actions, purposes: tables.purposeLevel, maxAttempts: tables.maxAttempts };
  if (tables.wording !== undefined) source.wording = tables.wording;
  if (tables.customRules !== undefined) source.customRules = tables.customRules;
  return source;
}

/** The policy each set of compiled tables was compiled from (attachSource): the tables and the gate stay one policy. */
const SOURCES = new WeakMap<PolicyTables, PolicySource>();
const COMPILED = new WeakMap<PolicyTables, Map<string, CompiledPolicy>>();

/**
 * Marks `tables` as compiled from `source` (compilePolicy does, for definePolicy and defineApp), so
 * the gate for those tables reads the named rules rather than the tables. The tables are frozen: a
 * change to them in place would change what custom rules read and not what the gate decides.
 */
export function attachSource(tables: PolicyTables, source: PolicySource): void {
  SOURCES.set(tables, source);
}

/** The policy `tables` were compiled from, or null for tables an app wrote by hand. */
export function sourceOf(tables: PolicyTables): PolicySource | null {
  return SOURCES.get(tables) ?? null;
}

/**
 * The gate for an app's tables and subject kind: compiled from the policy file the tables were
 * compiled from, or, for tables written by hand (or copied and changed), from the tables themselves
 * (programFromTables). Compiled once per tables object and subject kind.
 */
export function compiledPolicyOf(tables: PolicyTables, subjectKind: string): CompiledPolicy {
  let bySubject = COMPILED.get(tables);
  if (!bySubject) COMPILED.set(tables, (bySubject = new Map()));
  let gate = bySubject.get(subjectKind);
  if (!gate) bySubject.set(subjectKind, (gate = compileGate(SOURCES.get(tables) ?? programFromTables(tables), tables, subjectKind)));
  return gate;
}
