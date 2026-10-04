import { DEFAULT_CODE_LENGTH } from '../core/app/lookup';
import type { IdentityConfig, PolicyTables, PolicyWording, RoleAccess, SubjectParam, ToolName } from '../core/app/types';
import { lookupNameProblem, parseDateBound, parseLookupRef, parseNumberBound, refText, type DateBound, type LookupRef, type NumberBound } from '../gate/bounded';
import { attachSource, BUILT_IN_RULES, isBuiltInRuleId, LEGACY_RULE_ID, TABLE_RULE_ID, type LegacyRuleName, type PolicyAction, type PolicySource, type Rule } from '../gate/compiled';
import { DEFAULT_ROLE_PERSON_REASON } from '../gate/lines';
import type { Level } from '../gate/types';
import { closest, formatPath, type DataPath, type Problem } from './problems';
import type { IdentityYaml, PolicyYaml, RuleEntryYaml } from './schema/index';

/**
 * policy.yaml and identity.yaml in their new shape (./schema/policy.ts, ./schema/identity.ts),
 * compiled to the tables the gate and the lifecycle run (PolicyTables, IdentityConfig), and checked
 * against each other and the app's code.
 *
 * The compilers are the exact inverse of the tables' meaning, so an app converted to the files runs
 * the same decisions, line for line: each action's rules become its rulesFor row in the order
 * written, each built-in rule under its id in the tables (identity R1, scope R2, confirmed R3, role
 * R5, attempts R6, fields R7, which the gate records under the rules' names) and each custom rule
 * under its own id; an action's missing level is the
 * explicit 2 the gate would give it anyway; and nothing is added that the file does not say (a
 * verify tool's action runs only the rules listed for it).
 */

/** The id each built-in rule the legacy evaluator knows has in the tables' rulesFor (the gate records it under its name). */
export const RULE_ID_OF: Readonly<Record<LegacyRuleName, string>> = LEGACY_RULE_ID;

/** The built-in rule each id is (a table id: a legacy id, or a range rule's own name; or a rule's name), for a message. */
const RULE_NAME_OF: Readonly<Record<string, string>> = {
  ...Object.fromEntries(Object.entries(TABLE_RULE_ID).map(([rule, id]) => [id, rule])),
  ...Object.fromEntries(BUILT_IN_RULES.map((rule) => [rule, rule])),
};

/** The level an action needs when it names none: the highest, so it fails closed (as the gate's own default). */
export const DEFAULT_ACTION_LEVEL: Level = 2;

/**
 * The failed tries the attempts rule allows in an app with no identity.yaml. Such an app has no
 * identity check to count tries at, so `check` refuses the attempts rule there; the tables still
 * carry a number, the one every app has used.
 */
export const DEFAULT_MAX_ATTEMPTS = 3;

/** The reason a role rule hands a call to a person for when it names none: the gate's own (gate/lines.ts). */
export { DEFAULT_ROLE_PERSON_REASON };

/** The one-time code's length when identity.yaml gives none (core/lifecycle.ts codeLengthOf). */
export { DEFAULT_CODE_LENGTH };

/** One rule as written, read: its name and its parameters (the gate's own type, gate/compiled.ts). */
export type { Rule };

/** A rule entry of a valid file, read. */
export function readRule(entry: RuleEntryYaml): Rule {
  if (entry === 'identity' || entry === 'attempts') return { rule: entry };
  if ('scope' in entry) {
    const { param, record } = entry.scope;
    return { rule: 'scope', subject: record !== undefined ? { param: record, via: 'record' } : { param: param! } };
  }
  if ('role' in entry) {
    const { reason, ...access } = entry.role;
    return reason === undefined ? { rule: 'role', access: access as Record<string, RoleAccess> } : { rule: 'role', access: access as Record<string, RoleAccess>, reason };
  }
  if ('confirmed' in entry) return { rule: 'confirmed', fields: entry.confirmed };
  if ('fields' in entry) return { rule: 'fields', fields: entry.fields };
  if ('dateInRange' in entry) {
    const { field, unscoped, notBefore, notAfter, within, reasons, verdicts } = entry.dateInRange;
    return {
      rule: 'dateInRange',
      field,
      ...(unscoped === true ? { unscoped } : {}),
      ...(notBefore !== undefined ? { notBefore: dateBoundOf(notBefore) } : {}),
      ...(notAfter !== undefined ? { notAfter: dateBoundOf(notAfter) } : {}),
      ...(within !== undefined ? { within: refOf(within) } : {}),
      ...(reasons !== undefined ? { reasons } : {}),
      ...(verdicts !== undefined ? { verdicts } : {}),
    };
  }
  if ('limit' in entry) {
    const { field, unscoped, min, max, reasons, verdicts } = entry.limit;
    return {
      rule: 'limit',
      field,
      ...(unscoped === true ? { unscoped } : {}),
      ...(min !== undefined ? { min: numberBoundOf(min) } : {}),
      ...(max !== undefined ? { max: numberBoundOf(max) } : {}),
      ...(reasons !== undefined ? { reasons } : {}),
      ...(verdicts !== undefined ? { verdicts } : {}),
    };
  }
  return { rule: 'custom', id: entry.custom };
}

/** A bound or reference of a valid file, read (the schema has checked it parses). */
function readOrThrow<T>(read: { problem: string } | T, text: unknown): T {
  if (typeof read === 'object' && read !== null && 'problem' in read) throw new Error(`policy.yaml was not checked: ${String(text)}: ${(read as { problem: string }).problem}`);
  return read as T;
}
const refOf = (text: string): LookupRef => readOrThrow(parseLookupRef(text), text).ref;
const dateBoundOf = (text: string): DateBound => readOrThrow(parseDateBound(text), text).bound;
const numberBoundOf = (value: number | string): NumberBound => readOrThrow(parseNumberBound(value), value).bound;

/** The references a range rule makes to the app's lookups, with where each is written. */
export function lookupRefsOf(rule: Rule): { key: string; ref: LookupRef }[] {
  const out: { key: string; ref: LookupRef }[] = [];
  const add = (key: string, b: DateBound | NumberBound | LookupRef | undefined): void => {
    if (b === undefined) return;
    if ('lookup' in b) out.push({ key, ref: b });
    else if (b.kind === 'lookup') out.push({ key, ref: b.ref });
  };
  if (rule.rule === 'dateInRange') {
    add('notBefore', rule.notBefore);
    add('notAfter', rule.notAfter);
    add('within', rule.within);
  } else if (rule.rule === 'limit') {
    add('min', rule.min);
    add('max', rule.max);
  }
  return out;
}

export { isBuiltInRuleId };

/**
 * The id a rule has in the tables' rulesFor: a built-in's legacy id (a range rule's name), a custom
 * rule's own. The gate records a built-in under its name (RULE_ID), not this id.
 */
export function ruleIdOf(rule: Rule): string {
  return rule.rule === 'custom' ? rule.id : TABLE_RULE_ID[rule.rule];
}

/** The engine's words for the role rule's compared line (gate/policy.ts), where the file's wording.role leaves an access out. */
export const DEFAULT_ROLE_TEMPLATES: Readonly<Record<RoleAccess, string>> = {
  allow: 'role {role} may {tool}: yes',
  refuse: 'role {role} may {tool}: no',
  person: 'role {role} may {tool}: with a person',
};

/** The role rule's compared line from the file's templates: {role} and {tool} filled in, nothing else read. */
export function roleLine(templates: Partial<Record<RoleAccess, string>>): NonNullable<PolicyWording['role']> {
  return (role, tool, access) =>
    (templates[access] ?? DEFAULT_ROLE_TEMPLATES[access]).replace(/\{(role|tool)\}/g, (_, name: string) => (name === 'role' ? role : tool));
}

/** The wording as the gate reads it: the file's words, and its role templates as a function. */
export function wordingOf(wording: NonNullable<PolicyYaml['wording']>): PolicyWording {
  const { role, ...words } = wording;
  const out: PolicyWording = { ...words };
  if (role) out.role = roleLine(role);
  return out;
}

export interface CompilePolicyOptions {
  /** The attempts the attempts rule allows: identity.yaml's (compileIdentity). Default DEFAULT_MAX_ATTEMPTS, for an app without identity.yaml. */
  maxAttempts?: number;
  /** The app's own rules, by the id `custom:` names them by (PolicyTables.customRules). */
  customRules?: PolicyTables['customRules'];
}

/**
 * policy.yaml (the new shape, already checked) as the gate's tables, and the gate's named rules
 * (gate/compiled.ts) attached to them: the gate for these tables (compiledPolicyOf, App.gate) reads
 * each action's rules with their own parameters, and the tables are what an app's own rule reads
 * (RuleContext.policy) and what the summary hash is taken over (confirmedFields). Where the file's
 * rules say what the tables hold once per app (the confirmed fields, the role rule's reason), the
 * first rule that says it gives it: `check` requires every confirmed list to be the same (Decision
 * 5), and a role rule's own reason is the one the gate gives (Decision 4). The tables are frozen, so
 * they cannot drift from the rules attached to them.
 */
export function compilePolicy(file: PolicyYaml, options: CompilePolicyOptions = {}): PolicyTables {
  const toolLevel: Record<ToolName, Level> = {};
  const rulesFor: Record<ToolName, readonly string[]> = {};
  const serviceFields: Record<ToolName, readonly string[]> = {};
  const subjects: Record<ToolName, SubjectParam> = {};
  const roles: Record<ToolName, Readonly<Record<string, RoleAccess>>> = {};
  const actions: Record<ToolName, PolicyAction> = {};
  let confirmedFields: readonly string[] | undefined;
  let reason: string | undefined;
  for (const [tool, action] of Object.entries(file.actions)) {
    const level = action.level ?? DEFAULT_ACTION_LEVEL;
    const rules = Object.freeze(action.rules.map((entry) => Object.freeze(readRule(entry))));
    toolLevel[tool] = level;
    rulesFor[tool] = Object.freeze(rules.map(ruleIdOf));
    actions[tool] = Object.freeze(action.say === undefined ? { level, rules } : { say: action.say, level, rules });
    for (const rule of rules) {
      if (rule.rule === 'scope' && rule.subject !== null) subjects[tool] = rule.subject;
      else if (rule.rule === 'fields') serviceFields[tool] = rule.fields;
      else if (rule.rule === 'confirmed') confirmedFields ??= rule.fields;
      else if (rule.rule === 'role') {
        roles[tool] = rule.access;
        reason ??= rule.reason;
      }
    }
  }
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const purposeLevel = Object.fromEntries(Object.entries(file.purposes).map(([purpose, { level }]) => [purpose, level]));
  const tables: Partial<PolicyTables> = {
    toolLevel,
    purposeLevel,
    rulesFor,
    serviceFields,
    confirmedFields: confirmedFields ?? [],
    maxAttempts,
  };
  if (Object.keys(roles).length > 0) tables.roles = roles;
  if (reason !== undefined) tables.rolePersonReason = reason;
  tables.subjects = subjects;
  if (options.customRules !== undefined) tables.customRules = options.customRules;
  const wording = file.wording ? wordingOf(file.wording) : undefined;
  if (wording) tables.wording = wording;
  const redact = redactOf(file.redact);
  if (redact) tables.redact = redact;
  // How each param that is no redacted slot is recorded: the engine's, not the gate's (core/recording.ts).
  if (file.audit !== undefined && Object.keys(file.audit).length > 0) tables.audit = Object.freeze({ ...file.audit });
  const source: PolicySource = {
    actions: Object.freeze(actions),
    purposes: purposeLevel,
    maxAttempts,
    ...(wording ? { wording } : {}),
    ...(options.customRules !== undefined ? { customRules: options.customRules } : {}),
  };
  for (const table of [toolLevel, purposeLevel, rulesFor, serviceFields, subjects, roles]) Object.freeze(table);
  const compiled = Object.freeze(tables) as PolicyTables;
  attachSource(compiled, Object.freeze(source));
  return compiled;
}

/** policy.yaml's redact section as the engine reads it (PolicyTables.redact), frozen; none when it withholds nothing from anyone. */
function redactOf(redact: PolicyYaml['redact']): PolicyTables['redact'] {
  const rows = Object.entries(redact ?? {});
  if (rows.length === 0) return undefined;
  return Object.freeze(Object.fromEntries(rows.map(([who, byTool]) => [who, Object.freeze(Object.fromEntries(Object.entries(byTool).map(([tool, fields]) => [tool, Object.freeze([...fields])])))])));
}

/** Who a redact row is for: the delegate kind, and the role after the first dot (`agent.clerk`), if any. */
export function redactWho(key: string): { kind: string; role?: string } {
  const dot = key.indexOf('.');
  return dot < 0 ? { kind: key } : { kind: key.slice(0, dot), role: key.slice(dot + 1) };
}

/** The params a tool lists (ToolDef.params), read from code that may be wrong: null unless it is a list (its strings). */
export function declaredParams(tool: unknown): readonly string[] | null {
  const params = typeof tool === 'object' && tool !== null ? (tool as { params?: unknown }).params : undefined;
  return Array.isArray(params) ? params.filter((p): p is string => typeof p === 'string') : null;
}

/** The problems with a tool's params (ToolDef.params): a list of distinct plain words. */
export function toolParamProblems(tool: unknown): string[] {
  if (typeof tool !== 'object' || tool === null || !Object.hasOwn(tool, 'params')) return [];
  const params = (tool as { params?: unknown }).params;
  if (params === undefined) return [];
  if (!Array.isArray(params)) return ['params is not a list of the params its calls carry'];
  const out: string[] = [];
  const seen = new Set<string>();
  params.forEach((p: unknown, i) => {
    if (typeof p !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(p)) out.push(`params[${i}] (${JSON.stringify(p)}) is not a param name: it must start with a letter and use only letters, digits and underscores`);
    else if (seen.has(p)) out.push(`param "${p}" is listed twice`);
    else seen.add(p);
  });
  return out;
}

/** Each slot's redact setting (SlotSpec.redact), null for none, read from code that may be wrong. */
export function slotRedactOf(slots: Readonly<Record<string, unknown>>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [id, spec] of Object.entries(slots)) {
    const redact = typeof spec === 'object' && spec !== null ? (spec as { redact?: unknown }).redact : undefined;
    out[id] = typeof redact === 'string' ? redact : null;
  }
  return out;
}

/** The fields a tool declares (ToolDef.fields), read from code that may be wrong: none unless it is a list of strings. */
export function declaredFields(tool: unknown): readonly string[] {
  const fields = typeof tool === 'object' && tool !== null ? (tool as { fields?: unknown }).fields : undefined;
  return Array.isArray(fields) ? fields.filter((f): f is string => typeof f === 'string') : [];
}

/** The problems with a tool's declared fields (ToolDef.fields): a list of distinct plain words, each a field of its result. */
export function toolFieldProblems(tool: unknown): string[] {
  if (typeof tool !== 'object' || tool === null || !Object.hasOwn(tool, 'fields')) return [];
  const fields = (tool as { fields?: unknown }).fields;
  if (fields === undefined) return [];
  if (!Array.isArray(fields)) return ['fields is not a list of the fields of its result'];
  const out: string[] = [];
  const seen = new Set<string>();
  fields.forEach((f: unknown, i) => {
    if (typeof f !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(f)) out.push(`fields[${i}] (${JSON.stringify(f)}) is not a field name: it must start with a letter and use only letters, digits and underscores`);
    else if (seen.has(f)) out.push(`field "${f}" is listed twice`);
    else seen.add(f);
  });
  return out;
}

export interface CompileIdentityOptions {
  /** The one-time code call's params, read from the session (IdentityConfig.sendCodeParams): code, not configuration. */
  sendCodeParams?: IdentityConfig['sendCodeParams'];
}

/** What identity.yaml compiles to: the lifecycle's identity configuration, and the attempts the gate's attempts rule allows. */
export interface CompiledIdentity {
  identity: IdentityConfig;
  maxAttempts: number;
}

/**
 * identity.yaml (the new shape, already checked) as the lifecycle's identity configuration, and its
 * attempts for the policy (compilePolicy's maxAttempts). Level 1 is the factors and their check;
 * level 2, where the ladder has it, is the one-time code (its tools and its length, default 6). The
 * levels' names, the sign-in's level, the delegates' roles and the attempts go on the configuration
 * too, for the console, the turn and validateApp: the engine decides on the level numbers alone.
 */
export function compileIdentity(file: IdentityYaml, options: CompileIdentityOptions = {}): CompiledIdentity {
  const one = file.levels[1];
  const two = file.levels[2];
  const identity = { subjectKind: file.principals.subject } as IdentityConfig;
  const delegates = Object.entries(file.principals.delegates ?? {});
  if (delegates.length > 1) throw new Error(`identity.yaml names ${delegates.length} delegate kinds; one is supported for now`);
  if (delegates.length === 1) identity.delegateKind = delegates[0]![0];
  identity.factorSlots = one.factors;
  identity.verifyTool = one.verify;
  if (two) {
    identity.codeTool = two.verify;
    identity.sendCodeTool = two.send;
  }
  if (options.sendCodeParams !== undefined) identity.sendCodeParams = options.sendCodeParams;
  if (one.failedPrompt !== undefined) identity.failedPromptId = one.failedPrompt;
  if (two) identity.codeLength = two.factors[0]?.otp.length ?? DEFAULT_CODE_LENGTH;
  identity.levelNames = Object.freeze(two ? { 1: one.name, 2: two.name } : { 1: one.name });
  if (file.signIn) identity.signInLevel = file.signIn.level;
  if (file.signIn?.claim !== undefined) identity.signInClaim = file.signIn.claim;
  const roles = delegates[0]?.[1].roles;
  if (delegates.length === 1) identity.delegateRoles = Object.freeze([...(roles ?? [])]);
  identity.maxAttempts = file.attempts;
  return { identity, maxAttempts: file.attempts };
}

// ---------------------------------------------------------------------------------------------
// Reading the file
// ---------------------------------------------------------------------------------------------

/** The custom rule ids the policy names: a code rule no action names never runs. */
export function customRulesNamed(policy: PolicyYaml): Set<string> {
  return new Set(Object.values(policy.actions).flatMap((a) => a.rules.map(readRule)).flatMap((r) => (r.rule === 'custom' ? [r.id] : [])));
}

/** The reasons a role hands a call to a person for: one per role rule that has a `person`. */
export function personReasons(policy: PolicyYaml): string[] {
  return Object.values(policy.actions)
    .flatMap((a) => a.rules.map(readRule))
    .flatMap((r) => (r.rule === 'role' && Object.values(r.access).includes('person') ? [r.reason ?? DEFAULT_ROLE_PERSON_REASON] : []));
}

/** The highest level identity.yaml's ladder has: 2 with a level 2, else 1. */
export function topLevel(identity: IdentityYaml): 1 | 2 {
  return identity.levels[2] ? 2 : 1;
}

// ---------------------------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------------------------

/** What the checks read: the two files, where their problems go, and what the app's code has (each left out is not checked). */
export interface PolicyCheckInput {
  policy: PolicyYaml | null;
  identity: IdentityYaml | null;
  /** The files' names, as problems carry them ("policy.yaml", or the path given to definePolicy). */
  files: { policy: string; identity: string };
  /** Where a data path is in a file; null when it is not there (or the content had no lines). */
  locate(file: string, path: DataPath): { line: number; column: number } | null;
  /** Where the key that holds the value at a path is; locate otherwise. */
  locateKey?(file: string, path: DataPath): { line: number; column: number } | null;
  /** The tools the code defines. */
  tools?: readonly string[];
  /** The fields each tool declares its result may lose (ToolDef.fields); a tool left out declares none. Left out: not checked. */
  toolFields?: Readonly<Record<string, readonly string[]>>;
  /**
   * The params each tool lists for its calls (ToolDef.params), null for a tool that lists none. Left
   * out: not checked (the params `audit:` must cover are then only the confirmed and fields rules').
   */
  toolParams?: Readonly<Record<string, readonly string[] | null>>;
  /**
   * Each slot the code gives and its redact setting (SlotSpec.redact), null for none: a param of a
   * slot's name is recorded as it says. A slot the files name that the code does not give is left
   * out (its own problem says so), and a param of its name is not checked.
   */
  slotRedact?: Readonly<Record<string, string | null>>;
  /** Every slot id the app has: the identity factors must be slots. */
  slots?: ReadonlySet<string>;
  /** The fix for a slot that does not exist: where it would be added. */
  addSlot?(slot: string): string;
  /** The custom rule ids the code registers. */
  customRules?: readonly string[];
  /** The lookups the code declares for the range rules' references (AppCode.lookups). */
  lookups?: readonly string[];
  /** The prompt ids of the default locale. */
  prompts?: readonly string[];
  /** Whether a form has a confirmedParams hook (so something is ever confirmed). */
  confirms?: boolean;
  /** Where an author writes a part of the code, as a fix names it: `app.ts (code.tools.x)`. */
  inCode(...segs: string[]): string;
  /** A part of the code as a path: `code.tools.x`. */
  codePath(...segs: string[]): string;
}

const has = (obj: object | null | undefined, key: string): boolean => obj != null && Object.hasOwn(obj, key);
const quoteList = (items: readonly string[]): string => items.map((i) => `"${i}"`).join(', ');
const renameHint = (word: string, known: readonly string[]): string => {
  const guess = closest(word, known);
  return guess ? `rename it to "${guess}", or ` : '';
};

function reporter(c: PolicyCheckInput, out: Problem[]) {
  return (file: string, path: DataPath, message: string, fix: string, atKey = false): void => {
    const at = (atKey ? (c.locateKey ?? c.locate)(file, path) : c.locate(file, path)) ?? { line: 0, column: 0 };
    out.push({ file, line: at.line, column: at.column, path: formatPath(path), message, fix });
  };
}

/**
 * The params an action's calls may carry, where one of its rules closes them (a fields rule, else a
 * confirmed rule: either BLOCKs a call with any other param), or null where none does.
 */
function paramsOf(rules: readonly Rule[]): { params: readonly string[]; from: string } | null {
  for (const name of ['fields', 'confirmed'] as const) {
    const closing = rules.find((r) => r.rule === name);
    if (closing && (closing.rule === 'fields' || closing.rule === 'confirmed')) return { params: closing.fields, from: name };
  }
  return null;
}

/** The problems with the lookups the code declares: each a plain word the references may call. */
export function lookupDeclarationProblems(lookups: readonly unknown[]): { index: number; message: string }[] {
  const out: { index: number; message: string }[] = [];
  lookups.forEach((name, index) => {
    if (typeof name !== 'string') out.push({ index, message: 'a lookup is named by a string' });
    else {
      const problem = lookupNameProblem(name);
      if (problem) out.push({ index, message: problem });
    }
  });
  return out;
}

/**
 * policy.yaml against identity.yaml and the code: every action is a tool and every tool an action;
 * its level is one the ladder has; each rule's parameters name what exists (custom rules, declared
 * roles); and the confirmed list, which the summary hash is taken over once per form, is the same
 * for every action (Decision 5). Each role rule's person reason is its own (Decision 4). The
 * confirmed and fields rules name params, which need not be slots (a picked time, a record id): what
 * is recorded of each is checked with the tools' params (auditProblems).
 */
export function policyProblems(c: PolicyCheckInput): Problem[] {
  const out: Problem[] = [];
  const policy = c.policy;
  if (!policy) return out;
  const at = reporter(c, out);
  const P = c.files.policy;
  const I = c.files.identity;
  const identity = c.identity;
  const top = identity ? topLevel(identity) : 0;
  const roles = new Set(Object.values(identity?.principals.delegates ?? {}).flatMap((d) => d.roles ?? []));
  const confirmed: { tool: string; fields: readonly string[]; path: DataPath }[] = [];

  /** An action's or a purpose's level against the ladder. */
  const levelProblem = (what: string, level: number, path: DataPath, given: boolean): void => {
    if (level === 0 || level <= top) return;
    if (!identity) {
      at(P, path, given ? `${what} needs identity level ${level}, but the app has no identity.yaml, so no caller can reach it` : `${what} has no level, so it needs the highest (${level}), but the app has no identity.yaml, so no caller can reach it`, given ? 'set it to 0, or add identity.yaml so callers can verify' : 'add "level: 0", or add identity.yaml so callers can verify', !given);
    } else {
      at(P, path, `${what} needs identity level ${level}, but the ladder in ${I} has no level ${level}`, `${given ? `set it to ${top}` : `add "level: ${top}"`}, or add level ${level} under levels in ${I}`, !given);
    }
  };

  for (const [tool, action] of Object.entries(policy.actions)) {
    if (c.tools && !c.tools.includes(tool)) at(P, ['actions', tool], `tool "${tool}" is not defined in the code`, `${renameHint(tool, c.tools)}add it to the app's tools in ${c.inCode('tools', tool)}, or delete this action`, true);
    const given = action.level !== undefined;
    levelProblem(`action "${tool}"`, action.level ?? DEFAULT_ACTION_LEVEL, given ? ['actions', tool, 'level'] : ['actions', tool], given);
    action.rules.forEach((entry, i) => {
      const rule = readRule(entry);
      const path: DataPath = ['actions', tool, 'rules', i];
      switch (rule.rule) {
        case 'custom':
          if (isBuiltInRuleId(rule.id)) {
            const builtIn = RULE_NAME_OF[rule.id];
            if (builtIn) {
              const what = builtIn === rule.id ? 'a built-in rule\'s name' : `the old id of the built-in "${builtIn}" rule`;
              at(P, [...path, 'custom'], `"custom: ${rule.id}" is ${what}, which would run that rule without its parameters`, `write the built-in rule by its name ("${builtIn}" with its parameters), or give the app's rule an id of its own`);
            } else {
              at(P, [...path, 'custom'], `"custom: ${rule.id}" is an id the gate keeps for itself (the line for an action that is not listed)`, 'give the app\'s rule an id of its own');
            }
          } else if (c.customRules && !c.customRules.includes(rule.id)) {
            at(P, [...path, 'custom'], `custom rule "${rule.id}" is not defined in the code`, `${renameHint(rule.id, c.customRules)}add it to ${c.inCode('customRules', rule.id)}, or delete this rule`);
          }
          break;
        case 'confirmed':
          // The fields are the params the write sends (a form's confirmedParams), which need not be
          // slots (a time the caller picked from a list, say), as the fields rule's need not be (a
          // record id): each is a param the tool lists, or a slot or a param declared under audit
          // (auditProblems).
          confirmed.push({ tool, fields: rule.fields, path: [...path, 'confirmed'] });
          break;
        case 'role':
          for (const role of Object.keys(rule.access)) {
            if (roles.has(role)) continue;
            if (identity) at(P, [...path, 'role', role], `role "${role}" is not declared under principals in ${I}`, `${renameHint(role, [...roles])}add it to the roles of a delegate kind under principals.delegates in ${I}`, true);
            else at(P, [...path, 'role', role], `role "${role}" is named, but the app has no identity.yaml, so no caller has a role`, 'delete the role rule, or add identity.yaml with the parties who act for subjects and their roles', true);
          }
          // Decision 4: each role rule gives its own reason (the gate reads it from the rule).
          if (!Object.values(rule.access).includes('person') && rule.reason !== undefined) {
            at(P, [...path, 'role', 'reason'], `the role rule of "${tool}" gives a reason, but no role in it goes to a person, so the reason is never used`, 'delete the reason, or give a role "person"');
          }
          break;
        case 'attempts':
          if (!identity) at(P, path, 'the attempts rule counts failed tries at the identity checks, but the app has no identity.yaml, so there are none', 'delete the rule, or add identity.yaml');
          break;
        case 'dateInRange':
        case 'limit': {
          const rulePath: DataPath = [...path, rule.rule];
          // The params the action sends, where its rules close them (a fields or confirmed rule), else
          // the params its tool lists (ToolDef.params): a param outside them can never reach the gate
          // with a value, so the rule could never pass.
          const listed = c.toolParams && has(c.toolParams, tool) ? c.toolParams[tool] : null;
          const sent = paramsOf(action.rules.map(readRule)) ?? (listed ? { params: listed, from: 'params' } : null);
          const lists = sent ? (sent.from === 'params' ? `its tool lists ${sent.params.join(', ') || 'none'}` : `its ${sent.from} rule lists ${sent.params.join(', ') || 'none'}`) : '';
          const addTo = (param: string): string => (sent?.from === 'params' ? `add "${param}" to ${c.inCode('tools', tool, 'params')}` : `add "${param}" to its ${sent?.from} rule`);
          if (sent && !sent.params.includes(rule.field)) at(P, [...rulePath, 'field'], `"${rule.field}" is not a param "${tool}" sends (${lists})`, `${renameHint(rule.field, sent.params)}name one of those, or ${addTo(rule.field)}`);
          // A bound read through a lookup is about the record its param names: that param is held to
          // the caller's own records by a scope rule before this one, or the rule says its lookups are
          // about no one's (unscoped), so a caller cannot read a limit off someone else's record.
          const scopedBefore = new Set(action.rules.slice(0, i).map(readRule).flatMap((r) => (r.rule === 'scope' && r.subject !== null ? [r.subject.param] : [])));
          const refs = lookupRefsOf(rule);
          if (rule.unscoped === true && refs.length === 0) at(P, [...rulePath, 'unscoped'], `the ${rule.rule} rule of "${tool}" is unscoped, but none of its bounds is a reference, so there is no lookup to leave unscoped`, 'delete "unscoped: true"', true);
          for (const { key, ref } of refs) {
            if (rule.unscoped !== true && !scopedBefore.has(ref.param)) {
              at(P, [...rulePath, key], `${refText(ref)} reads "${ref.param}", which no scope rule before this one holds to the caller's own records, so the bound could be read off anyone's`, `add "- scope: { param: ${ref.param} }" (or "{ record: ${ref.param} }" for a record id) before this rule, or write "unscoped: true" in it if the lookup is not about the caller's own record (a price list, a calendar)`);
            }
            if (sent && !sent.params.includes(ref.param)) at(P, [...rulePath, key], `${refText(ref)} reads "${ref.param}", which is not a param "${tool}" sends (${lists})`, `${renameHint(ref.param, sent.params)}call the lookup with one of those, or ${addTo(ref.param)}`);
            if (c.lookups && !c.lookups.includes(ref.lookup)) at(P, [...rulePath, key], `${refText(ref)} calls the lookup "${ref.lookup}", which the code does not declare`, `${renameHint(ref.lookup, c.lookups)}add "${ref.lookup}" to ${c.inCode('lookups')} and a function of that name to the gate's lookups (code.systems), or correct the reference`);
          }
          break;
        }
        default:
          break;
      }
    });
  }
  if (c.tools) {
    for (const tool of c.tools) {
      if (!has(policy.actions, tool)) at(P, ['actions'], `tool "${tool}" (${c.codePath('tools', tool)}) has no entry under actions, so it can never be called`, `add "${tool}:" under actions with its level and rules, or delete the tool from ${c.inCode('tools', tool)}`);
    }
  }
  for (const [purpose, { level }] of Object.entries(policy.purposes)) levelProblem(`purpose "${purpose}"`, level, ['purposes', purpose, 'level'], true);
  redactProblems(c, at);
  auditProblems(c, at);

  // Decision 5: the summary hash is taken once per form, over one list, until forms name the action they write.
  const first = confirmed[0];
  if (first) {
    for (const other of confirmed.slice(1)) {
      if (other.fields.length === first.fields.length && other.fields.every((f, i) => f === first.fields[i])) continue;
      at(
        P,
        other.path,
        `the confirmed fields of "${other.tool}" (${other.fields.join(', ')}) differ from those of "${first.tool}" (${first.fields.join(', ')}); until a form names the action it writes, every confirmed rule of an app names the same fields in the same order (a read-back's hash is taken once, over one list)`,
        `write [${first.fields.join(', ')}] here, as "${first.tool}" has it`,
      );
    }
    if (c.confirms === false) {
      const tools = [...new Set(confirmed.map((x) => x.tool))];
      at(P, first.path.slice(0, -1), `${quoteList(tools)} run${tools.length === 1 ? 's' : ''} the confirmed rule, but no form has a confirmedParams hook, so nothing is ever confirmed and the rule blocks every call`, 'add "confirmedParams" to the hooks of the form that makes the write, and write it in the code');
    }
  }
  return out;
}

/**
 * policy.yaml's redact section against identity.yaml and the code: each row is for a kind of party
 * who acts for subjects (never the subject kind: a subject acting for themselves is never
 * redacted), and a role of that kind; each of its tools is an action; each field one the tool
 * declares (ToolDef.fields).
 */
function redactProblems(c: PolicyCheckInput, at: ReturnType<typeof reporter>): void {
  const policy = c.policy;
  if (!policy?.redact) return;
  const P = c.files.policy;
  const I = c.files.identity;
  const delegates = c.identity?.principals.delegates ?? {};
  const kinds = Object.keys(delegates);
  const actions = Object.keys(policy.actions);
  for (const [who, byTool] of Object.entries(policy.redact)) {
    const path: DataPath = ['redact', who];
    const { kind, role } = redactWho(who);
    if (!c.identity) {
      at(P, path, `"${who}" names a party who acts for subjects, but the app has no identity.yaml, so no caller does`, 'delete the redact section, or add identity.yaml with the parties who act for subjects and their roles', true);
      continue;
    }
    if (kind === c.identity.principals.subject) {
      at(P, path, `"${kind}" is the subject kind in ${I}: a subject acting for themselves is never redacted`, kinds.length > 0 ? `name a kind who acts for subjects (${quoteList(kinds)}), or delete it` : 'delete it', true);
      continue;
    }
    if (!has(delegates, kind)) {
      at(P, path, `"${kind}" is not a kind of party who acts for subjects in ${I}${kinds.length > 0 ? ` (${quoteList(kinds)})` : ', which declares none'}`, `${renameHint(kind, kinds)}add "${kind}" under principals.delegates in ${I}, or delete it`, true);
      continue;
    }
    if (role !== undefined) {
      const roles = delegates[kind]?.roles ?? [];
      if (!roles.includes(role)) {
        const guess = closest(role, roles);
        at(P, path, `role "${role}" is not a role of "${kind}" in ${I}${roles.length > 0 ? ` (${quoteList(roles)})` : ', which gives it none'}`, `${guess ? `rename it to "${kind}.${guess}", or ` : ''}add "${role}" to the roles of "${kind}" under principals.delegates in ${I}, or delete it`, true);
      }
    }
    for (const [tool, fields] of Object.entries(byTool)) {
      const toolPath: DataPath = [...path, tool];
      if (!has(policy.actions, tool)) {
        at(P, toolPath, `"${tool}" is not an action in ${P}, so nothing it returns reaches anyone`, `${renameHint(tool, actions)}delete it`, true);
        continue;
      }
      if (!c.toolFields) continue;
      const declared = c.toolFields[tool] ?? [];
      if (declared.length === 0) {
        if (fields.length > 0) at(P, toolPath, `"${tool}" declares no fields, so none of its result can be withheld`, `add "fields: [${fields.join(', ')}]" to ${c.inCode('tools', tool)} (the fields of its result the policy may withhold), or delete this entry`, true);
        continue;
      }
      fields.forEach((field, i) => {
        if (!declared.includes(field)) at(P, [...toolPath, i], `"${field}" is not a field "${tool}" declares (${declared.join(', ')})`, `${renameHint(field, declared)}add "${field}" to the fields of ${c.inCode('tools', tool)}, or delete it from this list`);
      });
    }
  }
}

/** What `audit:` may say of a param, in words for a fix. */
const AUDIT_CHOICES = 'or last4, mask, length or secret';

/** The params a scope, confirmed or fields rule names, with where each is written: what the tool's calls must carry. */
function ruleParams(rule: Rule, path: DataPath): { param: string; path: DataPath; rule: string }[] {
  switch (rule.rule) {
    case 'scope': return rule.subject === null ? [] : [{ param: rule.subject.param, path: [...path, 'scope', rule.subject.via === 'record' ? 'record' : 'param'], rule: 'scope' }];
    case 'confirmed':
    case 'fields': return rule.fields.map((param, i) => ({ param, path: [...path, rule.rule, i], rule: rule.rule }));
    // A range rule's params are checked where it is (policyProblems), against the params the action sends.
    default: return [];
  }
}

/**
 * What is recorded of each param (policy.yaml `audit:`) against the code: every tool lists the
 * params its calls carry (ToolDef.params), and each is a slot with a redact setting or declared
 * under `audit:`, so nothing is recorded as it is without the file saying so; the params its rules
 * name are ones it lists; a confirmed or fields rule's entry is a slot or declared (where the tool
 * lists no params); and each declaration is of a param a tool sends that no slot's redact covers.
 */
function auditProblems(c: PolicyCheckInput, at: ReturnType<typeof reporter>): void {
  const policy = c.policy;
  if (!policy) return;
  const P = c.files.policy;
  const audit = policy.audit ?? {};
  const redacted = c.slotRedact;
  // A slot with a redact setting says how its param is recorded; one the code does not give is its own problem.
  const declared = (param: string): boolean => has(audit, param) || (redacted !== undefined && (has(redacted, param) ? redacted[param] !== null : c.slots?.has(param) === true));
  const slotFix = (param: string): string => (c.slots?.has(param) ? `give the slot "${param}" a redact setting` : `make "${param}" a slot with a redact setting`);
  for (const [tool, action] of Object.entries(policy.actions)) {
    const listed = c.toolParams && has(c.toolParams, tool) ? c.toolParams[tool]! : undefined;
    if (listed === null) {
      at(P, ['actions', tool], `tool "${tool}" does not list the params its calls carry (${c.codePath('tools', tool, 'params')}), so what is recorded of them cannot be checked`, `add "params: [<each param its calls carry>]" to ${c.inCode('tools', tool)} ("params: []" for none)`, true);
    }
    if (listed && redacted) {
      for (const param of listed) {
        if (declared(param)) continue;
        at(P, ['actions', tool], `the param "${param}" of "${tool}" (${c.codePath('tools', tool, 'params')}) is neither a slot with a redact setting nor declared under audit, so how it is recorded is not said`, `declare it under audit in ${P} ("${param}: keep" to record it as it is, ${AUDIT_CHOICES}), or ${slotFix(param)}`, true);
      }
    }
    action.rules.forEach((entry, i) => {
      for (const { param, path, rule } of ruleParams(readRule(entry), ['actions', tool, 'rules', i])) {
        if (listed) {
          if (!listed.includes(param)) at(P, path, `the ${rule} rule of "${tool}" names "${param}", which the tool does not list in its params (${listed.join(', ') || 'none'})`, `${renameHint(param, listed)}add "${param}" to ${c.inCode('tools', tool, 'params')}, or correct the rule`);
        } else if ((rule === 'confirmed' || rule === 'fields') && c.slots && !c.slots.has(param) && !has(audit, param)) {
          // The tool lists no params to check: each field still says how it is recorded.
          at(P, path, `"${param}" is neither a slot nor a param declared under audit, so how it is recorded is not said`, `declare it under audit ("${param}: keep" to record it as it is, ${AUDIT_CHOICES}), or name a slot`);
        }
      }
    });
  }
  const sent = c.toolParams && Object.values(c.toolParams).every((p) => p !== null) ? new Set(Object.values(c.toolParams).flatMap((p) => p ?? [])) : null;
  for (const param of Object.keys(audit)) {
    if (redacted && has(redacted, param) && redacted[param] !== null) {
      at(P, ['audit', param], `"${param}" is a slot recorded by its redact setting (${redacted[param]}), so audit does not declare it`, 'delete it here: the slot\'s redact setting says how it is recorded', true);
    } else if (sent && !sent.has(param)) {
      at(P, ['audit', param], `no tool lists "${param}" in its params, so the declaration is never used`, `${renameHint(param, [...sent])}delete it, or add "${param}" to the params of the tool whose calls carry it`, true);
    }
  }
}

/**
 * identity.yaml against policy.yaml and the code: the factors are slots, the identity tools are
 * tools with an action each, the failed line is a prompt, each level has a name of its own, a
 * sign-in proves the top level, and one delegate kind. A ladder of one rung (no level 2, so no
 * code) is allowed: policyProblems then refuses any action or purpose that needs level 2.
 */
export function identityProblems(c: PolicyCheckInput): Problem[] {
  const out: Problem[] = [];
  const identity = c.identity;
  if (!identity) return out;
  const at = reporter(c, out);
  const I = c.files.identity;
  const one = identity.levels[1];
  const two = identity.levels[2];
  one.factors.forEach((slot, i) => {
    if (c.slots && !c.slots.has(slot)) at(I, ['levels', '1', 'factors', i], `slot "${slot}" is not defined`, `${renameHint(slot, [...c.slots])}${c.addSlot ? c.addSlot(slot) : 'add it to the app\'s slots'}`);
  });
  const tools: [DataPath, string | undefined, string][] = [
    [['levels', '1', 'verify'], one.verify, '{ level: 0, rules: [attempts] }'],
    [['levels', '2', 'send'], two?.send, '{ level: 1, rules: [identity] }'],
    [['levels', '2', 'verify'], two?.verify, '{ level: 1, rules: [identity, attempts] }'],
  ];
  for (const [path, tool, example] of tools) {
    if (tool === undefined) continue;
    if (c.tools && !c.tools.includes(tool)) at(I, path, `tool "${tool}" is not defined in the code`, `${renameHint(tool, c.tools)}add it to the app's tools in ${c.inCode('tools', tool)}`);
    else if (c.policy && !has(c.policy.actions, tool)) at(I, path, `tool "${tool}" has no entry under actions in ${c.files.policy}`, `add "${tool}: ${example}" under actions in ${c.files.policy}`);
  }
  if (one.failedPrompt !== undefined && c.prompts && !c.prompts.includes(one.failedPrompt)) {
    at(I, ['levels', '1', 'failedPrompt'], `prompt "${one.failedPrompt}" is not in prompts.yaml`, `${renameHint(one.failedPrompt, c.prompts)}add "${one.failedPrompt}:" to prompts.yaml with its text and interruptible`);
  }
  // A level's name is a label (the console, the policy card): it must say something, and not what another level says.
  const names: [string, string | undefined][] = [['1', one.name], ['2', two?.name]];
  for (const [level, name] of names) {
    if (name !== undefined && name.trim() === '') at(I, ['levels', level, 'name'], `level ${level}'s name is blank`, `name the level, as the console and the policy card will show it (for example "${level === '1' ? 'verified' : 'confirmed by code'}")`);
  }
  if (two && one.name.trim() !== '' && one.name.trim().toLowerCase() === two.name.trim().toLowerCase()) {
    at(I, ['levels', '2', 'name'], `levels 1 and 2 are both called "${two.name.trim()}"`, 'give each level a name of its own, so the console and the policy card can tell them apart');
  }
  const top = topLevel(identity);
  if (identity.signIn && identity.signIn.level !== top) {
    at(I, ['signIn', 'level'], `a sign-in proves level ${identity.signIn.level}, but the top of the ladder is level ${top}; a sign-in proves the top level`, `write "level: ${top}"`);
  }
  const delegates = Object.keys(identity.principals.delegates ?? {});
  for (const kind of delegates) {
    if (kind === identity.principals.subject) at(I, ['principals', 'delegates', kind], `delegate kind "${kind}" is the subject kind`, 'give the parties who act for subjects a word of their own', true);
  }
  if (delegates.length > 1) {
    at(I, ['principals', 'delegates'], `${delegates.length} delegate kinds (${delegates.join(', ')}); one is supported for now (the engine names a party who acts for subjects by one word)`, 'keep one kind, with every role under it');
  }
  return out;
}
