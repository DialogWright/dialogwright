import type { PolicyTables, SubjectParam, ToolName } from '../core/app/types';
import type { Problem } from '../define/problems';
import { readRule } from '../define/ruleEntry';
import type { RuleEntryYaml } from '../define/schema/policy';
import { compileGate, TABLE_RULE_ID, type CompiledPolicy, type PolicyAction, type PolicySource, type Rule } from '../gate/compiled';
import type { Anonymous, GateLookups } from '../gate/types';
import { AGENT_FILE, AgentBusinessError } from './business/load';
import type { ActionSpec, AgentBusiness } from './business/schema';

/**
 * The gate of a converse app, from agent.yaml's actions (docs/designs/2026-11-11-agent-runtime.md,
 * "Tools, the gate and confirmation"): each action with its own rules, in the order written, read as
 * policy.yaml's are, and every change with a `confirmed` rule over all its params run last, so a change
 * runs only once the caller has said yes to a read-back of exactly its values. A lookup needs no
 * confirmation. Every action is open to a caller with no proven identity (level 0): agent.yaml has no
 * identity yet, so the runtime asks for every call as CALLER, with NO_LOOKUPS.
 */

/** Who asks, for every converse call: a caller nobody has proven. */
export const CALLER: Anonymous = Object.freeze({ kind: 'anonymous', level: 0 });

/** The gate's lookups for a converse call: no records, and a caller who may see no one's. */
export const NO_LOOKUPS: GateLookups = Object.freeze({ ownerOf: () => null, scopeOf: () => [] });

/** The failed tries the attempts rule allows; agent.yaml has no identity check to count them at. */
const MAX_ATTEMPTS = 3;

/** The fields a change's confirmation covers, and its hash is taken over: all its params, in the order written. */
export function confirmedFields(spec: ActionSpec): string[] {
  return Object.keys(spec.params);
}

/** The params a rule names, with the path under the rule where each is written. */
function namedParams(rule: Rule): { param: string; at: string }[] {
  switch (rule.rule) {
    case 'scope': return rule.subject === null ? [] : [{ param: rule.subject.param, at: rule.subject.via === 'record' ? 'scope.record' : 'scope.param' }];
    case 'fields':
    case 'confirmed': return rule.fields.map((param, i) => ({ param, at: `${rule.rule}[${i}]` }));
    case 'dateInRange':
    case 'limit':
    case 'oneOf':
    case 'noneOf':
    case 'callerNumber': return [{ param: rule.field, at: `${rule.rule}.field` }];
    default: return [];
  }
}

/** What agent.yaml's schema leaves to the gate's reading: rules and params that would not hold together. */
function problemsOf(b: AgentBusiness): Problem[] {
  const out: Problem[] = [];
  const add = (path: string, message: string, fix: string): void => void out.push({ file: AGENT_FILE, line: 1, column: 1, path, message, fix });
  for (const [name, spec] of Object.entries(b.actions)) {
    const params = Object.keys(spec.params);
    const list = params.join(', ') || 'it has none';
    for (const [pname, p] of Object.entries(spec.params)) {
      if (p.type === 'choice' && !(p.options && p.options.length > 0)) add(`actions.${name}.params.${pname}`, `the choice param "${pname}" has no options`, 'add options: [..], the values it may take');
      if (p.type !== 'choice' && p.options !== undefined) add(`actions.${name}.params.${pname}.options`, `"options" belong to a choice param, and "${pname}" is a ${p.type}`, 'delete "options", or make the param a choice');
    }
    (spec.rules ?? []).forEach((entry, i) => {
      const at = `actions.${name}.rules[${i}]`;
      const rule = readRule(entry as RuleEntryYaml);
      if (rule.rule === 'confirmed') {
        add(at, `"${name}" lists a confirmed rule`, `delete it: the runtime confirms ${spec.kind === 'change' ? `every change over all its params (${list})` : 'only a change, and a lookup is never confirmed'}`);
        return;
      }
      if (rule.rule === 'custom') {
        add(at, `the custom rule "${rule.id}" has no code to run in a converse app`, 'delete it, or write the rule with the built-in rules (oneOf, noneOf, dateInRange, limit, callerNumber, fields)');
        return;
      }
      for (const { param, at: where } of namedParams(rule)) {
        if (!params.includes(param)) add(`${at}.${where}`, `"${param}" is no param of "${name}"`, `name one of its params (${list}), or add "${param}" under its params`);
      }
    });
  }
  return out;
}

/**
 * The gate for the business's actions: each its rules, then, for a change, `confirmed` over every
 * param. Refuses (AgentBusinessError, with a path and a fix per problem) a rule that names a param the
 * action does not have, a confirmed or custom rule written in the file, a choice param with no options
 * and options on a param that is no choice.
 */
export function policyOf(b: AgentBusiness): CompiledPolicy {
  const problems = problemsOf(b);
  if (problems.length > 0) throw new AgentBusinessError(problems);
  const actions: Record<ToolName, PolicyAction> = {};
  const rulesFor: Record<ToolName, readonly string[]> = {};
  const toolLevel: Record<ToolName, 0> = {};
  const serviceFields: Record<ToolName, readonly string[]> = {};
  const subjects: Record<ToolName, SubjectParam> = {};
  const confirmedBy: Record<ToolName, readonly string[]> = {};
  for (const [name, spec] of Object.entries(b.actions)) {
    const written = (spec.rules ?? []).map((entry) => readRule(entry as RuleEntryYaml));
    const rules: Rule[] = spec.kind === 'change' ? [...written, { rule: 'confirmed', fields: Object.freeze(confirmedFields(spec)) }] : written;
    actions[name] = Object.freeze({ say: spec.about, level: 0, rules: Object.freeze(rules.map((r) => Object.freeze(r))) });
    rulesFor[name] = Object.freeze(rules.map((r) => (r.rule === 'custom' ? r.id : TABLE_RULE_ID[r.rule])));
    toolLevel[name] = 0;
    for (const r of rules) {
      if (r.rule === 'fields') serviceFields[name] = r.fields;
      else if (r.rule === 'scope' && r.subject !== null) subjects[name] = r.subject;
      else if (r.rule === 'confirmed') confirmedBy[name] = r.fields;
    }
  }
  const tables: PolicyTables = Object.freeze({
    toolLevel: Object.freeze(toolLevel),
    purposeLevel: Object.freeze({}),
    rulesFor: Object.freeze(rulesFor),
    serviceFields: Object.freeze(serviceFields),
    confirmedFields: Object.values(confirmedBy)[0] ?? [],
    confirmedBy: Object.freeze(confirmedBy),
    maxAttempts: MAX_ATTEMPTS,
    subjects: Object.freeze(subjects),
  });
  const source: PolicySource = Object.freeze({ actions: Object.freeze(actions), purposes: Object.freeze({}), maxAttempts: MAX_ATTEMPTS });
  return compileGate(source, tables, '', []);
}
