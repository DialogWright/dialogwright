import { z } from 'zod';
import { checkAlways, identifier, level, name, text, unique } from './common';
import { closest } from '../problems';
import { literalOrder, parseDateBound, parseLookupRef, parseNumberBound } from '../../gate/bounded';

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
 *     refundOrder:
 *       level: 2
 *       rules:
 *         - identity
 *         - scope: { record: orderId }
 *         - limit: { field: amount, min: 0.01, max: orderTotal(orderId) }
 *         - dateInRange: { field: returnDate, notAfter: today, within: returnWindow(orderId) }
 *   purposes:
 *     file_request: { level: 2 }
 *
 * A rule with no parameters is its bare name (`identity`, `attempts`); a rule with parameters is a
 * map of its name to them, one rule per list entry, so each rule is one line to read and to diff.
 * The range rules' bounds (dateInRange, limit) are literals or references to the app's lookups,
 * `<lookup>(<param>)` or `<lookup>(<param>).<field>` (../../gate/bounded.ts), read here, never run.
 *
 * An app written before this shape (toolLevel, rulesFor, ... : the gate's tables as they are) is
 * converted with `dialogwright policy:convert`; nothing reads that shape any more.
 */

const roleAccess = z.enum(['allow', 'refuse', 'person']);

const wordingFor = z.strictObject({
  record: text().optional().describe('The scope rule\'s description when the action names its subject by a record id the gate resolves to its owner.'),
  param: text().optional().describe('The scope rule\'s description when the action names its subject by the subject\'s own id.'),
});

/** The words the built-in rules' lines use. */
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
export const PARAM_RULES = ['scope', 'role', 'confirmed', 'fields', 'dateInRange', 'limit', 'custom'] as const;
/** Every rule name, in the order the docs list them. */
export const RULE_NAMES = ['identity', 'scope', 'role', 'confirmed', 'attempts', 'fields', 'dateInRange', 'limit', 'custom'] as const;
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

// The range rules (../../gate/bounded.ts): a param's value held to bounds written as literals or as
// references to the app's lookups, `<lookup>(<param>)` or `<lookup>(<param>).<field>`.

const REF_FIX = 'write <lookup>(<param>) or <lookup>(<param>).<field>: a lookup the app\'s code declares (code.lookups), called with one of the action\'s params';

/** A string read by `parse`, its problem reported where it is. */
const parsedString = (parse: (v: string) => { problem: string } | object, fix: string) =>
  z.string().check(checkAlways((value, ctx) => {
    if (typeof value !== 'string') return;
    const read = parse(value);
    if ('problem' in read) ctx.addIssue({ code: 'custom', path: [], message: read.problem, params: { fix } });
  }));

const lookupRef = () => parsedString(parseLookupRef, REF_FIX);
const dateBound = () => parsedString(parseDateBound, `write "today", a date such as 2026-01-31, or ${REF_FIX.slice('write '.length)}`);
const numberBound = () =>
  z.union([z.number(), z.string()]).check(checkAlways((value, ctx) => {
    if (typeof value !== 'number' && typeof value !== 'string') return;
    const read = parseNumberBound(value);
    if ('problem' in read) ctx.addIssue({ code: 'custom', path: [], message: read.problem, params: { fix: `write a number such as 100 or 0.01, or ${REF_FIX.slice('write '.length)}` } });
  }));
const rangeVerdict = () => z.enum(['BLOCK', 'NEEDS_HUMAN']);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The problems of a range rule that no one field shows: no bound, literal bounds the wrong way round, a window's reason or verdict with no window. */
function rangeProblems(bounds: readonly string[], low: string, high: string, parse: (v: unknown) => { bound: unknown } | { problem: string }, windowKey?: string) {
  return checkAlways((value, ctx) => {
    if (!isRecord(value)) return;
    const issue = (path: (string | number)[], message: string, fix: string): void => ctx.addIssue({ code: 'custom', path, message, params: { fix } });
    if (!bounds.some((k) => value[k] !== undefined)) issue([], `the rule names no bound: write ${bounds.map((b) => `"${b}"`).join(', ').replace(/, ([^,]*)$/, ' or $1')}`, `add ${bounds[0] === 'min' ? '"max: <a number or a reference>"' : '"notAfter: today", or another bound'}`);
    const [a, b] = [parse(value[low]), parse(value[high])];
    if ('bound' in a && 'bound' in b && literalOrder(a.bound as never, b.bound as never) === false) {
      issue([low], `${low} (${String(value[low])}) is after ${high} (${String(value[high])}), so no value is within both`, `swap them, or correct the one that is wrong`);
    }
    if (windowKey !== undefined && value[windowKey] === undefined) {
      for (const part of ['reasons', 'verdicts']) {
        if (isRecord(value[part]) && value[part].outsideWindow !== undefined) issue([part, 'outsideWindow'], `the rule has no "${windowKey}", so it is never outside a window`, `delete it, or add "${windowKey}: <lookup>(<param>)"`);
      }
    }
  });
}

const dateInRangeRule = z
  .strictObject({
    field: identifier().describe('The action\'s param that holds the date (yyyy-mm-dd). A value that is not a date BLOCKs.'),
    notBefore: dateBound().optional().describe('The earliest date the value may be, inclusive: "today", a date, or a reference to a lookup that gives one.'),
    notAfter: dateBound().optional().describe('The latest date the value may be, inclusive: "today", a date, or a reference to a lookup that gives one.'),
    within: lookupRef().optional().describe('A reference to a lookup that gives a window, { start, end } (end null: open-ended), the value must be inside, ends inclusive. A lookup that gives null has no window: the value is outside it.'),
    reasons: z
      .strictObject({
        invalid: name().optional().describe('The reason a value that is not a date is refused for. Default "not-a-date".'),
        outOfRange: name().optional().describe('The reason a date before notBefore or after notAfter fails for. Default "date-range".'),
        outsideWindow: name().optional().describe('The reason a date outside the window fails for. Default "date-window".'),
      })
      .optional()
      .describe('The reason the gate gives for each way the rule fails, for the app\'s refusal lines and handoffs.'),
    verdicts: z
      .strictObject({
        outOfRange: rangeVerdict().optional().describe('BLOCK (default) or NEEDS_HUMAN, for a date out of its bounds.'),
        outsideWindow: rangeVerdict().optional().describe('BLOCK (default) or NEEDS_HUMAN, for a date outside the window.'),
      })
      .optional()
      .describe('The verdict for a date out of its bounds or outside its window. A value that is not a date, and a bound that cannot be found, always BLOCK.'),
  })
  .check(rangeProblems(['notBefore', 'notAfter', 'within'], 'notBefore', 'notAfter', parseDateBound, 'within'))
  .describe('dateInRange: the action\'s date param is a date within its bounds, each inclusive. At least one of notBefore, notAfter, within.');

const limitRule = z
  .strictObject({
    field: identifier().describe('The action\'s param that holds the number: digits, an optional leading minus and an optional point with digits; no units, separators or spaces. Anything else BLOCKs.'),
    min: numberBound().optional().describe('The smallest the number may be, inclusive: a number, or a reference to a lookup that gives one.'),
    max: numberBound().optional().describe('The largest the number may be, inclusive: a number, or a reference to a lookup that gives one (for example orderTotal(orderId), or order(orderId).total).'),
    reasons: z
      .strictObject({
        invalid: name().optional().describe('The reason a value that is not a number is refused for. Default "not-a-number".'),
        outOfRange: name().optional().describe('The reason a number below min or above max fails for. Default "limit".'),
      })
      .optional()
      .describe('The reason the gate gives for each way the rule fails.'),
    verdicts: z
      .strictObject({ outOfRange: rangeVerdict().optional().describe('BLOCK (default) or NEEDS_HUMAN, for a number outside its limits.') })
      .optional()
      .describe('The verdict for a number outside its limits. A value that is not a number, and a bound that cannot be found, always BLOCK.'),
  })
  .check(rangeProblems(['min', 'max'], 'min', 'max', parseNumberBound))
  .describe('limit: the action\'s number param is within its limits, each inclusive. At least one of min, max.');

const RULE_PARAMS: Record<ParamRule, z.ZodType> = { scope: scopeRule, role: roleRule, confirmed: confirmedRule, fields: fieldsRule, dateInRange: dateInRangeRule, limit: limitRule, custom: customRule };

/** An example of each rule with parameters, for a fix. */
const RULE_EXAMPLES: Record<ParamRule, string> = {
  scope: 'scope: { param: accountId }',
  role: 'role: { viewer: refuse, clerk: person }',
  confirmed: 'confirmed: [accountId, note]',
  fields: 'fields: [note, date]',
  dateInRange: 'dateInRange: { field: returnDate, notAfter: today }',
  limit: 'limit: { field: amount, max: orderTotal(orderId) }',
  custom: 'custom: <the rule\'s id in code.customRules>',
};

/** The parameters of a dateInRange rule, as written. */
export interface DateInRangeYaml {
  field: string;
  notBefore?: string;
  notAfter?: string;
  within?: string;
  reasons?: { invalid?: string; outOfRange?: string; outsideWindow?: string };
  verdicts?: { outOfRange?: 'BLOCK' | 'NEEDS_HUMAN'; outsideWindow?: 'BLOCK' | 'NEEDS_HUMAN' };
}

/** The parameters of a limit rule, as written. */
export interface LimitYaml {
  field: string;
  min?: number | string;
  max?: number | string;
  reasons?: { invalid?: string; outOfRange?: string };
  verdicts?: { outOfRange?: 'BLOCK' | 'NEEDS_HUMAN' };
}

/** One entry of an action's rules, as written: a bare rule's name, or a map of one rule's name to its parameters. */
export type RuleEntryYaml =
  | BareRule
  | { scope: { param?: string; record?: string } }
  | { role: { reason?: string } & Record<string, string> }
  | { confirmed: string[] }
  | { fields: string[] }
  | { dateInRange: DateInRangeYaml }
  | { limit: LimitYaml }
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
  .meta({ ...ruleEntryJson, description: 'One rule: a bare name (identity, attempts) or a map of one rule to its parameters (scope, role, confirmed, fields, dateInRange, limit, custom).' }) as unknown as z.ZodType<RuleEntryYaml>;

/** What makes two rules of an action the same rule: its name, and for a custom rule its id, for a range rule its field. Null for an entry that is no rule (its own problem says why). */
export function ruleKey(entry: unknown): string | null {
  if (typeof entry === 'string') return (BARE_RULES as readonly string[]).includes(entry) ? entry : null;
  if (!isMap(entry)) return null;
  const keys = Object.keys(entry);
  if (keys.length !== 1 || !(PARAM_RULES as readonly string[]).includes(keys[0]!)) return null;
  const rule = keys[0]!;
  if (rule === 'custom') return `custom: ${String(entry.custom)}`;
  // A range rule holds one param to its bounds: an action may hold two params (a start and an end date) with one each.
  if (rule === 'dateInRange' || rule === 'limit') {
    const params = entry[rule];
    return isMap(params) && typeof params.field === 'string' ? `${rule}: ${params.field}` : null;
  }
  return rule;
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
