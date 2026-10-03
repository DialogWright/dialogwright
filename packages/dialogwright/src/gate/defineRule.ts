import { isAnonymous, isParty, type GateFacts, type GateVerdict, type Level, type Principal, type RuleContext, type RuleOutcome } from './types';

/**
 * An app's own rule, defined with the examples that say what it does: `defineRule({ id,
 * description, run, examples })`. The result is the rule as the gate runs it (a function of the
 * rule context, PolicyTables.customRules), carrying its id, its description and its examples, so
 * `check` can hold it to having examples and the matrix runner (dialogwright/testing
 * runRuleExamples, policyMatrixText) can run each example through the compiled gate, in every
 * action whose rules name it.
 *
 *   export const knownBranch = defineRule({
 *     id: 'known-branch',
 *     description: 'The hold is at one of the branches',
 *     run: (c) => (known(c.call.params.branch) ? { pass: true, compared: 'branch known' } : { pass: false, compared: 'branch not known', verdict: 'BLOCK', reason: 'branch' }),
 *     examples: [
 *       { name: 'a branch there is', call: { params: { branch: 'north' } }, principal: ANONYMOUS, expect: { verdict: 'ALLOW' } },
 *       { name: 'a branch there is not', call: { params: { branch: 'east' } }, principal: ANONYMOUS, expect: { verdict: 'BLOCK', reason: 'branch' } },
 *     ],
 *   });
 *
 * `run` answers with whether the call passes and the values it compared (masked: the line reaches
 * the console and the audit as it is), and, when it fails, the verdict the gate stops at; the line
 * is recorded under the rule's id with its description. A run that throws, or answers anything else,
 * BLOCKs the call as any rule's would (gate/lines.ts checkOutcome).
 *
 * `check` refuses a custom rule that is a plain function, and one whose examples do not include at
 * least one call the gate allows and one it refuses (ruleDefinitionProblems). An App built by hand
 * may still carry a plain function: the gate runs it as before, and validateApp checks only rules
 * made with defineRule.
 */

/** What a rule's `run` answers: a pass, or a failure with the verdict the gate stops at. */
export type RuleAnswer =
  | { readonly pass: true; readonly compared: string }
  | {
    readonly pass: false;
    readonly compared: string;
    readonly verdict: Exclude<GateVerdict, 'ALLOW'>;
    /** For BLOCK and NEEDS_HUMAN: a short machine reason (e.g. "unchecked"). */
    readonly reason?: string;
    /** For STEP_UP: the level the call needs. */
    readonly needLevel?: Exclude<Level, 0>;
  };

/** The call of an example: its params and, if it serves a form, its purpose. The tool is each action that uses the rule. */
export interface RuleExampleCall {
  readonly params: Readonly<Record<string, string>>;
  readonly purpose?: string;
}

/** One example of a rule: a call, who makes it, and the verdict the gate gives it. */
export interface RuleExample {
  /** What the example shows, in a few words (unique among the rule's examples). */
  readonly name: string;
  readonly call: RuleExampleCall;
  readonly principal: Principal;
  /**
   * The session's gate facts, where the example needs its own. Default: no failed attempts, the
   * call's values confirmed (the hash of its params over the action's confirmed fields, so a
   * confirmed action reaches the rule), and the grid's day (the policy matrix's, else the regression's).
   */
  readonly facts?: Partial<GateFacts>;
  /** Lookups the example sets over the app's own (e.g. a record its rule reads). */
  readonly lookups?: Readonly<Record<string, unknown>>;
  /**
   * The gate's decision on the call, in each action that uses the rule: ALLOW (the rule and every
   * other rule of the action passed), or the refusal, which must come from this rule.
   */
  readonly expect: { readonly verdict: GateVerdict; readonly reason?: string };
}

export interface RuleDefinition {
  /** The id `custom:` names the rule by in policy.yaml, and its lines are recorded under. */
  readonly id: string;
  /** What the rule holds, in plain English: the description of its line in the console and the audit. */
  readonly description: string;
  run(c: RuleContext): RuleAnswer;
  /** At least one call the gate allows and one it refuses. */
  readonly examples: readonly RuleExample[];
}

const DEFINED = Symbol.for('dialogwright.definedRule');

/** A rule made with defineRule: the function the gate runs, with its definition. */
export type DefinedRule = ((c: RuleContext) => RuleOutcome) & {
  readonly id: string;
  readonly description: string;
  readonly examples: readonly RuleExample[];
  readonly [DEFINED]: true;
};

/** An app's own rule with its id, its description and the examples that say what it does. */
export function defineRule(definition: RuleDefinition): DefinedRule {
  const { id, description, run, examples } = definition;
  const rule = (c: RuleContext): RuleOutcome => {
    const a = run(c) as Partial<RuleAnswer & { verdict: GateVerdict; reason: string; needLevel: Level }> | null | undefined;
    // Whatever run answers goes through the gate's outcome check (gate/lines.ts checkOutcome): an
    // answer that does not hold together BLOCKs there, as any rule's would.
    const result = { id, description, compared: a?.compared as string, pass: a?.pass as boolean };
    if (a?.pass !== false) return { result };
    const fail = { verdict: a.verdict as Exclude<GateVerdict, 'ALLOW'>, ...(a.reason === undefined ? {} : { reason: a.reason }), ...(a.needLevel === undefined ? {} : { needLevel: a.needLevel }) };
    return { result, fail };
  };
  return Object.assign(rule, { id, description, examples, [DEFINED]: true as const });
}

/** Whether a custom rule was made with defineRule (by its brand: the rule may come from another copy of this module). */
export function isDefinedRule(rule: unknown): rule is DefinedRule {
  return typeof rule === 'function' && (rule as Partial<DefinedRule>)[DEFINED] === true;
}

const VERDICTS: readonly GateVerdict[] = ['ALLOW', 'BLOCK', 'STEP_UP', 'NEEDS_HUMAN'];

/** A problem with a custom rule, in the words `check` gives it: what is wrong and what to do. */
export interface RuleProblem {
  readonly message: string;
  readonly fix: string;
}

/**
 * What is wrong with the custom rule an app's code registers under `id`, beyond its id and its being
 * a function (which the callers check first): a plain function (no examples), a definition under
 * another id, and examples that do not say what the rule does (none the gate allows, none it
 * refuses, or one that is not an example). `at` names the rule in the app's code.
 */
export function ruleDefinitionProblems(id: string, rule: unknown, at: string): RuleProblem[] {
  const define = `defineRule({ id: '${id}', description, run, examples }) from "dialogwright/policy"`;
  if (!isDefinedRule(rule)) {
    return [{
      message: `custom rule "${id}" is a plain function, with no examples of what it allows and refuses`,
      fix: `define ${at} with ${define}, with an example call the gate allows and one it refuses`,
    }];
  }
  const out: RuleProblem[] = [];
  if (rule.id !== id) out.push({ message: `custom rule "${id}" is defined with the id "${String(rule.id)}"`, fix: `give ${at} the id "${id}", or register it under "${String(rule.id)}" and name that in policy.yaml's custom: rules` });
  if (typeof rule.description !== 'string' || rule.description.trim() === '') out.push({ message: `custom rule "${id}" has no description`, fix: `say in ${at}'s description, in plain English, what the rule holds` });
  const examples: readonly unknown[] = Array.isArray(rule.examples) ? rule.examples : [];
  if (!Array.isArray(rule.examples)) out.push({ message: `custom rule "${id}"'s examples are not a list`, fix: `make ${at}'s examples a list of { name, call, principal, expect }` });
  const names = new Set<string>();
  let allows = false;
  let refuses = false;
  examples.forEach((raw, i) => {
    const ex = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<Record<keyof RuleExample, unknown>>;
    const label = typeof ex.name === 'string' && ex.name !== '' ? `"${ex.name}"` : `${i + 1}`;
    const bad = (what: string, fix: string): void => {
      out.push({ message: `custom rule "${id}"'s example ${label} ${what}`, fix: `${fix}, in ${at}'s examples[${i}]` });
    };
    if (typeof ex.name !== 'string' || ex.name.trim() === '') bad('has no name', 'name it in a few words');
    else if (names.has(ex.name)) bad('has the name of another example', 'give each example its own name');
    else names.add(ex.name);
    const call = ex.call as Partial<RuleExampleCall> | undefined;
    const params = call?.params;
    if (typeof params !== 'object' || params === null || Object.values(params).some((v) => typeof v !== 'string')) bad('has no call params, or a param that is not a string', 'write call: { params: { <param>: \'<value>\' } }');
    if (call?.purpose !== undefined && typeof call.purpose !== 'string') bad('has a purpose that is not a string', 'write the purpose as a form\'s name');
    const p = ex.principal;
    const anonymous = typeof p === 'object' && p !== null && isAnonymous(p as Principal) && (p as Principal).kind === 'anonymous';
    if (!anonymous && !isParty(p)) bad('has no principal', 'give the principal who makes the call (an anonymous caller, or a party the app\'s verifier or sign-in would make)');
    const expect = ex.expect as Partial<RuleExample['expect']> | undefined;
    const verdict = expect?.verdict;
    if (!VERDICTS.includes(verdict as GateVerdict)) {
      bad('expects no verdict', `write expect: { verdict: 'ALLOW' } or a refusal (${VERDICTS.slice(1).join(', ')}) with its reason`);
      return;
    }
    if (expect?.reason !== undefined && (typeof expect.reason !== 'string' || verdict === 'ALLOW')) bad('expects a reason with ALLOW, or a reason that is not a string', 'give a reason only for a refusal');
    if (verdict === 'ALLOW') allows = true;
    else refuses = true;
  });
  if (!allows) out.push({ message: `custom rule "${id}" has no example the gate allows`, fix: `add to ${at}'s examples a call the rule lets through, with expect: { verdict: 'ALLOW' }` });
  if (!refuses) out.push({ message: `custom rule "${id}" has no example the gate refuses`, fix: `add to ${at}'s examples a call the rule stops, with expect: { verdict: 'BLOCK' } (or NEEDS_HUMAN, STEP_UP) and its reason` });
  return out;
}
