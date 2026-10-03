import { DEFAULT_CODE_LENGTH } from '../core/app/lookup';
import type { IdentityConfig, PolicyTables, PolicyWording, RoleAccess, SubjectParam, ToolName } from '../core/app/types';
import { lookupNameProblem, parseDateBound, parseLookupRef, parseNumberBound, refText, type DateBound, type LookupRef, type NumberBound } from '../gate/bounded';
import { attachSource, LEGACY_RULE_ID, NAMED_RULE_IDS, RULE_ID, type LegacyRuleName, type PolicyAction, type PolicySource, type Rule } from '../gate/compiled';
import { DEFAULT_ROLE_PERSON_REASON } from '../gate/lines';
import { isRuleId } from '../gate/policy';
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
 * written, each built-in rule under its legacy id (identity R1, scope R2, confirmed R3, role R5,
 * attempts R6, fields R7) and each custom rule under its own id; an action's missing level is the
 * explicit 2 the gate would give it anyway; and nothing is added that the file does not say (a
 * verify tool's action runs only the rules listed for it).
 */

/** The legacy id each built-in rule the legacy evaluator knows is recorded under in decisions and audit lines (until rules are named there). */
export const RULE_ID_OF: Readonly<Record<LegacyRuleName, string>> = LEGACY_RULE_ID;

/** The built-in rule each id is (a legacy id, or a range rule's own name), for a message. */
const RULE_NAME_OF: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(RULE_ID).map(([rule, id]) => [id, rule]));

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
    const { field, notBefore, notAfter, within, reasons, verdicts } = entry.dateInRange;
    return {
      rule: 'dateInRange',
      field,
      ...(notBefore !== undefined ? { notBefore: dateBoundOf(notBefore) } : {}),
      ...(notAfter !== undefined ? { notAfter: dateBoundOf(notAfter) } : {}),
      ...(within !== undefined ? { within: refOf(within) } : {}),
      ...(reasons !== undefined ? { reasons } : {}),
      ...(verdicts !== undefined ? { verdicts } : {}),
    };
  }
  if ('limit' in entry) {
    const { field, min, max, reasons, verdicts } = entry.limit;
    return {
      rule: 'limit',
      field,
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

/** Whether an id is a built-in rule's, so no app's own rule may take it: R0, a legacy id, or a range rule's name. */
export function isBuiltInRuleId(id: string): boolean {
  return isRuleId(id) || id === 'R0' || NAMED_RULE_IDS.includes(id);
}

/** The id a rule runs under in the gate's tables and is recorded under: a built-in's legacy id (a range rule's name), a custom rule's own. */
export function ruleIdOf(rule: Rule): string {
  return rule.rule === 'custom' ? rule.id : RULE_ID[rule.rule];
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
 * confirmed and fields rules name params, which are not checked against the slots: a write may send
 * a param that is no slot (a picked time, a record id).
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
            at(P, [...path, 'custom'], `"custom: ${rule.id}" names a built-in rule's id, which would run that rule without its parameters`, builtIn ? `write the built-in rule by its name ("${builtIn}" with its parameters), or give the app's rule an id of its own` : 'give the app\'s rule an id of its own');
          } else if (c.customRules && !c.customRules.includes(rule.id)) {
            at(P, [...path, 'custom'], `custom rule "${rule.id}" is not defined in the code`, `${renameHint(rule.id, c.customRules)}add it to ${c.inCode('customRules', rule.id)}, or delete this rule`);
          }
          break;
        case 'confirmed':
          // The fields are the params the write sends (a form's confirmedParams), which need not be
          // slots (a time the caller picked from a list, say), as the fields rule's need not be (a
          // record id): neither is checked against the slots until actions declare their params.
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
          // The params the action sends, where its rules close them (a fields or confirmed rule): a
          // param outside them can never reach the gate with a value, so the rule could never pass.
          const sent = paramsOf(action.rules.map(readRule));
          const lists = sent ? `its ${sent.from} rule lists ${sent.params.join(', ') || 'none'}` : '';
          if (sent && !sent.params.includes(rule.field)) at(P, [...rulePath, 'field'], `"${rule.field}" is not a param "${tool}" sends (${lists})`, `${renameHint(rule.field, sent.params)}name one of those, or add "${rule.field}" to its ${sent.from} rule`);
          for (const { key, ref } of lookupRefsOf(rule)) {
            if (sent && !sent.params.includes(ref.param)) at(P, [...rulePath, key], `${refText(ref)} reads "${ref.param}", which is not a param "${tool}" sends (${lists})`, `${renameHint(ref.param, sent.params)}call the lookup with one of those, or add "${ref.param}" to its ${sent.from} rule`);
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
