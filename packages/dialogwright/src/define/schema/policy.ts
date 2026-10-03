import { z } from 'zod';
import { checkAlways, identifier, level, name, text, unique } from './common';
import { closest } from '../problems';

/**
 * policy.yaml: the whole of what the app's agent may do, one entry per action (a tool), each with
 * the identity level it needs and the rules the gate runs before it, in order. It compiles to
 * App.policy (PolicyTables; ../policyFile.ts). A tool with no entry cannot be called. Policy never
 * lives in tool code: an app's own rule is a function in code, named here by `custom: <id>`.
 *
 *   actions:
 *     getRecord:
 *       say: look up a record
 *       level: 1
 *       rules:
 *         - identity
 *         - scope: { record: recordId }
 *     fileRequest:
 *       level: 2
 *       rules:
 *         - identity
 *         - role: { viewer: refuse, clerk: person, reason: staff-filing }
 *         - scope: { param: accountId }
 *         - confirmed: [accountId, note, date]
 *         - custom: not-twice
 *   purposes:
 *     file_request: { level: 2 }
 *
 * A rule with no parameters is its bare name (`identity`, `attempts`); a rule with parameters is a
 * map of its name to them, one rule per list entry, so each rule is one line to read and to diff.
 *
 * Until every app is converted, the loader also reads the old shape (toolLevel, rulesFor, ...;
 * legacyPolicySchema below) and `check` warns about it.
 */

const roleAccess = z.enum(['allow', 'refuse', 'person']);

const wordingFor = z.strictObject({
  record: text().optional().describe('The scope rule\'s description when the action names its subject by a record id the gate resolves to its owner.'),
  param: text().optional().describe('The scope rule\'s description when the action names its subject by the subject\'s own id.'),
});

/** The words the built-in rules' lines use: the same in both shapes. */
export const policyWording = z
  .strictObject({
    scope: z
      .strictObject({
        subject: wordingFor.optional().describe('The scope rule\'s description when one of the app\'s subjects asks.'),
        delegate: wordingFor.optional().describe('The scope rule\'s description when a party acting for subjects asks.'),
      })
      .optional()
      .describe("The scope rule's (R2) description, by who asks and how the action names its subject. Default: \"The record belongs to someone this caller may see\"."),
    recordOwner: text().optional().describe('What the scope rule\'s compared line calls the owner of a record. Default "record owner".'),
    subject: text().optional().describe('What the scope rule\'s compared line calls a subject named by id. Default "subject".'),
    role: z
      .strictObject({
        allow: text().optional().describe('The role rule\'s compared line when the role may take the action. Write {role} and {tool} where they go. Default "role {role} may {tool}: yes".'),
        refuse: text().optional().describe('The role rule\'s compared line when the role is refused the action. Default "role {role} may {tool}: no".'),
        person: text().optional().describe('The role rule\'s compared line when a person takes the call. Default "role {role} may {tool}: with a person".'),
      })
      .optional()
      .describe("The role rule's (R5) compared line, by what the rule gives the role, as a template with {role} and {tool}."),
  })
  .describe("The words the gate's built-in rules use in their description and compared lines, so the console and the audit read in the app's terms. Without it, neutral words.");

// ---------------------------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------------------------

/** The rules written by their bare name: they take no parameters. */
export const BARE_RULES = ['identity', 'attempts'] as const;
/** The rules written as a map of the name to their parameters. */
export const PARAM_RULES = ['scope', 'role', 'confirmed', 'fields', 'custom'] as const;
/** Every rule name, in the order the docs list them. */
export const RULE_NAMES = ['identity', 'scope', 'role', 'confirmed', 'attempts', 'fields', 'custom'] as const;
export type BareRule = (typeof BARE_RULES)[number];
export type ParamRule = (typeof PARAM_RULES)[number];
export type RuleName = (typeof RULE_NAMES)[number];

/** A word that names a role (a role key of a role rule, a delegate's role in identity.yaml). */
const ROLE_NAME = /^[A-Za-z][A-Za-z0-9_.-]*$/;

const scopeRule = z
  .strictObject({
    param: identifier().optional().describe('The action\'s param that is the subject\'s own id (for example accountId).'),
    record: identifier().optional().describe('The action\'s param that is a record id the gate resolves to its owner (for example recordId).'),
  })
  .check(checkAlways((value, ctx) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
    const given = ['param', 'record'].filter((k) => Object.hasOwn(value, k));
    if (given.length === 1) return;
    ctx.addIssue({
      code: 'custom',
      path: [],
      message: given.length === 0 ? 'the scope rule names no param: write "param" or "record"' : 'the scope rule names both "param" and "record"; it compares one subject',
      params: { fix: given.length === 0 ? 'write "scope: { param: <the subject\'s id param> }", or "scope: { record: <the record id param> }"' : 'keep the one that names the subject this action acts on' },
    });
  }))
  .describe('scope (R2): the subject the action acts on must be one the caller may see. Exactly one of "param" (the param is the subject\'s own id) or "record" (the param is a record id, resolved to its owner).');

const roleRule = z
  .object({
    reason: name().optional().describe('The reason a "person" role hands the call over for (its handoff line is handoff_<reason>). Default "role-person".'),
  })
  .catchall(roleAccess)
  .describe('role (R5): what each role may do with the action: allow, refuse, or person (a person takes the call). A role not listed is refused, and so is a party who acts for subjects with no role; one of the app\'s subjects passes. The roles are those identity.yaml declares under principals.');

const confirmedRule = unique(identifier(), 'confirmed field')
  .min(1, { error: 'must name at least one field' })
  .describe('confirmed (R3): the action sends exactly these fields, and the caller confirmed exactly these values at the read-back, in the order the hash is taken over.');

const fieldsRule = unique(identifier(), 'field').describe('fields (R7): the only fields the action may send on (to a downstream service). An empty list sends none.');

const customRule = name().describe('custom: one of the app\'s own rules, by the id its code registers it under (code.customRules).');

const RULE_PARAMS: Record<ParamRule, z.ZodType> = { scope: scopeRule, role: roleRule, confirmed: confirmedRule, fields: fieldsRule, custom: customRule };

/** An example of each rule with parameters, for a fix. */
const RULE_EXAMPLES: Record<ParamRule, string> = {
  scope: 'scope: { param: accountId }',
  role: 'role: { viewer: refuse, clerk: person }',
  confirmed: 'confirmed: [accountId, note]',
  fields: 'fields: [note, date]',
  custom: 'custom: <the rule\'s id in code.customRules>',
};

/** One entry of an action's rules, as written: a bare rule's name, or a map of one rule's name to its parameters. */
export type RuleEntryYaml =
  | BareRule
  | { scope: { param?: string; record?: string } }
  | { role: { reason?: string } & Record<string, string> }
  | { confirmed: string[] }
  | { fields: string[] }
  | { custom: string };

/** The JSON Schema of one rule entry, for an editor: the bare names, and each rule with its parameters. */
const ruleEntryJson = (() => {
  const branches = [
    z.enum(BARE_RULES).describe('A rule with no parameters: identity (R1, the caller\'s identity level is at least the action\'s) or attempts (R6, the identity check has failed fewer times than identity.yaml\'s attempts).'),
    ...PARAM_RULES.map((rule) => z.strictObject({ [rule]: RULE_PARAMS[rule] }).describe(`The ${rule} rule with its parameters, for example "${RULE_EXAMPLES[rule]}".`)),
  ];
  const { $schema: _schema, ...json } = z.toJSONSchema(z.union(branches as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]]), { io: 'input', target: 'draft-7' }) as Record<string, unknown>;
  return json;
})();

const isMap = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The fix for a word that is not a rule: the rule it is closest to, or the rules there are. */
function unknownRule(word: string): { message: string; fix: string } {
  const guess = closest(word, RULE_NAMES);
  return {
    message: `"${word}" is not a rule; the rules are ${RULE_NAMES.join(', ')} (custom names one of the app's own)`,
    fix: guess ? `rename it to "${guess}"` : `use one of those, or write "custom: ${word}" for a rule the app's code registers`,
  };
}

/** Whether a role rule's key is a misspelt `reason` rather than a role: its value is no access, and the key is close to "reason". */
const misspeltReason = (key: string, value: unknown): boolean => key !== 'reason' && !roleAccess.safeParse(value).success && closest(key, ['reason']) !== undefined;

/**
 * One rule entry, checked by the rule it names, so a mistake inside a rule is reported where it is
 * (a union would only say the entry matches none of its shapes).
 */
const ruleEntry = z
  .unknown()
  .check(checkAlways((value, ctx) => {
    const issue = (message: string, fix: string, path: (string | number)[] = []): void => ctx.addIssue({ code: 'custom', path, message, params: { fix } });
    if (typeof value === 'string') {
      if ((BARE_RULES as readonly string[]).includes(value)) return;
      if ((PARAM_RULES as readonly string[]).includes(value)) {
        issue(`the ${value} rule takes parameters, so it is written as a map`, `write "${RULE_EXAMPLES[value as ParamRule]}"`);
        return;
      }
      const unknown = unknownRule(value);
      issue(unknown.message, unknown.fix);
      return;
    }
    if (!isMap(value)) {
      issue('a rule is a rule\'s name (identity, attempts) or a map of one rule to its parameters', `write, for example, "identity" or "${RULE_EXAMPLES.scope}"`);
      return;
    }
    const keys = Object.keys(value);
    if (keys.length !== 1) {
      issue(
        keys.length === 0 ? 'this rule is an empty map' : `this entry names ${keys.length} rules (${keys.join(', ')}); a list entry is one rule`,
        keys.length === 0 ? 'delete it, or name the rule' : 'write each rule as its own "- " entry, in the order the gate runs them',
      );
      return;
    }
    const rule = keys[0]!;
    if ((BARE_RULES as readonly string[]).includes(rule)) {
      issue(`the ${rule} rule takes no parameters`, `write it as a plain "- ${rule}"`, [rule]);
      return;
    }
    if (!(PARAM_RULES as readonly string[]).includes(rule)) {
      const unknown = unknownRule(rule);
      issue(unknown.message, unknown.fix, [rule]);
      return;
    }
    const params = value[rule];
    if (rule === 'role' && isMap(params)) {
      const roles = Object.keys(params).filter((k) => k !== 'reason');
      for (const role of roles) {
        if (misspeltReason(role, params[role])) issue(`unknown key "${role}" in the role rule`, 'rename it to "reason"', [rule, role]);
        else if (!ROLE_NAME.test(role)) issue(`the role "${role}" is not a valid name: it must start with a letter and use only letters, digits, underscores, hyphens and dots`, 'rename the role, here and under principals in identity.yaml', [rule, role]);
      }
      if (roles.length === 0) issue('the role rule names no role', `write each role and what it may do, for example "${RULE_EXAMPLES.role}"`, [rule]);
    }
    const parsed = RULE_PARAMS[rule as ParamRule].safeParse(params);
    if (parsed.success) return;
    for (const inner of parsed.error.issues) {
      // A misspelt reason is reported above, as a rename.
      if (rule === 'role' && isMap(params) && inner.path.length === 1 && misspeltReason(String(inner.path[0]), params[String(inner.path[0])])) continue;
      ctx.addIssue({ ...(inner as unknown as z.core.$ZodRawIssue), path: [rule, ...inner.path] } as z.core.$ZodRawIssue);
    }
  }))
  .meta({ ...ruleEntryJson, description: 'One rule: a bare name (identity, attempts) or a map of one rule to its parameters (scope, role, confirmed, fields, custom).' }) as unknown as z.ZodType<RuleEntryYaml>;

/** What makes two rules of an action the same rule: its name, and for a custom rule its id. Null for an entry that is no rule (its own problem says why). */
export function ruleKey(entry: unknown): string | null {
  if (typeof entry === 'string') return (BARE_RULES as readonly string[]).includes(entry) ? entry : null;
  if (!isMap(entry)) return null;
  const keys = Object.keys(entry);
  if (keys.length !== 1 || !(PARAM_RULES as readonly string[]).includes(keys[0]!)) return null;
  return keys[0] === 'custom' ? `custom: ${String(entry.custom)}` : keys[0]!;
}

const rules = z
  .array(ruleEntry)
  .check(checkAlways((entries, ctx) => {
    if (!Array.isArray(entries)) return;
    const seen = new Set<string>();
    entries.forEach((entry, i) => {
      const key = ruleKey(entry);
      if (key === null) return;
      if (seen.has(key)) ctx.addIssue({ code: 'custom', path: [i], message: `the rule "${key}" is listed twice`, params: { fix: 'delete one of the two: a rule runs once per action' } });
      seen.add(key);
    });
  }))
  .describe('The rules the gate runs before the action, in this order; the first that fails decides. An empty list runs none.');

const action = z
  .strictObject({
    say: text().optional().describe('What the action does, in plain words, as the policy card says it (for example "file a request").'),
    level: level()
      .optional()
      .describe('The identity level the action needs: 0 anonymous, 1 the factors matched, 2 the factors and the one-time code (identity.yaml names them). Default 2, the highest, so an action left without one fails closed.'),
    rules,
  })
  .describe('One action: what it is, the identity level it needs and the rules the gate runs before it.');

export const policySchema = z
  .strictObject({
    actions: z
      .record(identifier(), action, { error: 'must be a map from tool name to its level and rules' })
      .describe('Every action the agent may take, by tool name, with the level it needs and the rules the gate runs before it. Every tool of the app needs an entry; anything not listed is refused.'),
    purposes: z
      .record(name(), z.strictObject({ level: level().describe('The identity level the purpose needs.') }).describe('One purpose and the level it needs.'))
      .default({})
      .describe('The identity level each purpose needs (what a caller wants done, a form id, before any tool is called), when it is more than its first action\'s. Default: none.'),
    wording: policyWording.optional(),
  })
  .describe('policy.yaml: what the agent may do, action by action. Custom rule functions stay in code; this file names them.');

export type PolicyYaml = z.infer<typeof policySchema>;
export type ActionYaml = PolicyYaml['actions'][string];

// ---------------------------------------------------------------------------------------------
// The old shape, read until every app is converted
// ---------------------------------------------------------------------------------------------

const subjectParam = z
  .strictObject({
    param: identifier().describe('The tool param that names the subject the call acts on.'),
    via: z.literal('record').optional().describe('"record" when the param is a record id the gate resolves to its owner; leave out when it is the subject\'s own id.'),
  })
  .describe("R2's subject for one tool.");

/** The keys only the old shape has: a file with any of them and no `actions:` is read as the old shape. */
export const LEGACY_POLICY_KEYS = ['toolLevel', 'purposeLevel', 'rulesFor', 'subjects', 'confirmedFields', 'serviceFields', 'maxAttempts', 'roles', 'rolePersonReason'] as const;

/**
 * The old policy.yaml: the gate's tables as they are (PolicyTables), rules by id (R1, R2, R3, R5,
 * R6, R7 and the app's own). Read until every app is converted to policySchema.
 */
export const legacyPolicySchema = z
  .strictObject({
    toolLevel: z
      .record(identifier(), level(), { error: 'must be a map from tool name to identity level (0, 1 or 2)' })
      .describe('The identity level each tool needs: 0 anonymous, 1 the factors matched, 2 the factors and the one-time code. A tool without one needs the highest (fails closed). Every tool in rulesFor needs a row.'),
    purposeLevel: z
      .record(name(), level())
      .default({})
      .describe('The identity level each purpose needs (what a caller wants done before any tool is called). Default: none.'),
    rulesFor: z
      .record(identifier(), unique(name(), 'rule'))
      .describe('Per tool, the rules the gate runs before it, by id: the built-ins (R1 level, R2 scope, R3 confirmation, R5 role, R6 attempts, R7 service fields) or a custom rule the app\'s code registers. Every tool of the app needs a row; a tool without one cannot be called.'),
    subjects: z
      .record(identifier(), subjectParam)
      .default({})
      .describe('R2: per tool, the param that names the subject. A tool that runs R2 needs a row. Default: none.'),
    confirmedFields: unique(identifier(), 'confirmed field').describe('R3: the fields a confirmed write carries, in the order the hash is taken over (for example name, dob, provider, date, time).'),
    serviceFields: z
      .record(identifier(), unique(identifier(), 'field'))
      .default({})
      .describe('R7: per tool, the fields it may send on to a downstream service. A tool with no row sends none. Default: none.'),
    maxAttempts: z.number({ error: 'must be a number' }).int({ error: 'must be a whole number' }).min(1, { error: 'must be at least 1' }).describe('R6: failed attempts allowed at each identity check (the factors, the one-time code).'),
    roles: z
      .record(identifier(), z.record(name(), roleAccess))
      .optional()
      .describe('R5: per tool, what each role of a principal that has one (for example depot staff) may do with it: allow, refuse, or person (a person takes the call). A tool or a role with no row is refused. Without the table, every role is refused.'),
    rolePersonReason: name().optional().describe('R5\'s NEEDS_HUMAN reason when a role\'s access is "person" (for example "staff-filing"). Default "role-person".'),
    wording: policyWording.optional(),
  })
  .describe('policy.yaml in its old shape: the gate\'s tables. Custom rule functions stay in code; this file only names them.');

export type LegacyPolicyYaml = z.infer<typeof legacyPolicySchema>;

/** Whether parsed policy.yaml content is the old shape: a map with an old key and no `actions:`. */
export function isLegacyPolicyContent(value: unknown): boolean {
  return isMap(value) && !Object.hasOwn(value, 'actions') && LEGACY_POLICY_KEYS.some((k) => Object.hasOwn(value, k));
}
