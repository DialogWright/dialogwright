import type { IdentityConfig, PolicyTables, SlotId, ToolName } from '../core/app/types';
import { isRuleId, RULE_IDS } from '../gate/policy';
import { AppDefinitionError, codePath } from './defineApp';
import { loadConfigFile, type ConfigFile } from './load';
import { compileIdentity, compilePolicy, customRulesNamed, identityProblems, policyProblems, type PolicyCheckInput } from './policyFile';
import { keyPositionOf, positionOf, type Problem } from './problems';
import type { IdentityYaml, PolicyYaml } from './schema/index';

/**
 * The policy and identity of an app that is not a folder (so there is no `defineApp` to read its
 * policy.yaml and identity.yaml): the same files, the same checks, the same messages, compiled to
 * the tables the gate and the lifecycle run. Each source is a file's path (its problems point at
 * its lines) or its content already parsed (its problems name paths but have no line). Both throw
 * an AppDefinitionError listing every problem.
 *
 *   const policy = definePolicy('src/policy.yaml', { identity: 'src/identity.yaml', tools, slots, customRules });
 *   const identity = defineIdentity('src/identity.yaml', { policy: 'src/policy.yaml', tools, slots, sendCodeParams });
 *   const app: App = { ..., identity, policy };
 *
 * What the code is given is checked against the files: every tool has an action and every action is
 * a tool, every `custom:` rule is one of `customRules` and each of those runs somewhere, the
 * identity factors are slots, the identity tools are tools with an action. A part of the code that is
 * left out is not checked.
 */

export interface DefinePolicyOptions {
  /**
   * identity.yaml, its path or content: the roles the role rules may name, the levels the actions
   * may need, and the attempts the attempts rule allows. Without it the app verifies no one: every
   * action must be level 0.
   */
  identity?: string | Record<string, unknown>;
  /** The app's tools (App.tools): every tool needs an action, and every action must be a tool. */
  tools?: Readonly<Record<ToolName, unknown>>;
  /** The app's slots (App.slots). Not checked yet: the confirmed and fields rules name params, which need not be slots. */
  slots?: Readonly<Record<SlotId, unknown>>;
  /** The app's own rules, by the id `custom:` names them by (PolicyTables.customRules). */
  customRules?: PolicyTables['customRules'];
}

export interface DefineIdentityOptions {
  /** policy.yaml, its path or content: each identity tool needs an action there. */
  policy?: string | Record<string, unknown>;
  /** The app's tools (App.tools): the identity tools must be tools. */
  tools?: Readonly<Record<ToolName, unknown>>;
  /** The app's slots (App.slots): the factors must be slots. */
  slots?: Readonly<Record<SlotId, unknown>>;
  /** The app's prompt ids (or its prompt manifest): the line said after a failed match must be one. */
  prompts?: readonly string[] | Readonly<Record<string, unknown>>;
  /** The one-time code call's params, read from the session (IdentityConfig.sendCodeParams). */
  sendCodeParams?: IdentityConfig['sendCodeParams'];
}

const describeSource = (source: string | Record<string, unknown>): string => (typeof source === 'string' ? source : 'the given object');

/** Where a path is in a loaded file: its line when the file was read from disk, none for content given as an object. */
function locator(files: readonly (ConfigFile<unknown> | null)[], key = false): PolicyCheckInput['locate'] {
  return (file, path) => {
    const f = files.find((x) => x?.file === file);
    if (!f || !f.located) return null;
    return key ? keyPositionOf(f.doc, f.lines, path) : positionOf(f.doc, f.lines, path);
  };
}

function checkInput(policy: ConfigFile<PolicyYaml> | null, identity: ConfigFile<IdentityYaml> | null, code: { tools?: object; slots?: object; customRules?: object; prompts?: readonly string[] | object }): PolicyCheckInput {
  const files = [policy, identity];
  const input: PolicyCheckInput = {
    policy: policy?.value ?? null,
    identity: identity?.value ?? null,
    files: { policy: policy?.file ?? 'policy.yaml', identity: identity?.file ?? 'identity.yaml' },
    locate: locator(files),
    locateKey: locator(files, true),
    customRules: Object.keys(code.customRules ?? {}),
    inCode: (...segs) => codePath(...segs),
    codePath: (...segs) => codePath(...segs),
  };
  if (code.tools) input.tools = Object.keys(code.tools);
  if (code.slots) input.slots = new Set(Object.keys(code.slots));
  if (code.prompts) input.prompts = Array.isArray(code.prompts) ? code.prompts : Object.keys(code.prompts);
  return input;
}

/** The problems with the code's own rules: a built-in's id, not a function, or named by no action. */
function customRuleProblems(file: string, policy: PolicyYaml, customRules: PolicyTables['customRules']): Problem[] {
  const named = customRulesNamed(policy);
  const out: Problem[] = [];
  const at = (id: string, message: string, fix: string): void => {
    out.push({ file, line: 0, column: 0, path: codePath('customRules', id), message, fix });
  };
  for (const [id, rule] of Object.entries(customRules ?? {})) {
    if (isRuleId(id) || id === 'R0') at(id, `custom rule "${id}" has a built-in rule's id`, `rename it in ${codePath('customRules', id)} and in the "custom:" rules that name it; the built-in ids are R0, ${RULE_IDS.join(', ')}`);
    else if (typeof rule !== 'function') at(id, `custom rule "${id}" is not a function`, `make ${codePath('customRules', id)} a function of the rule context`);
    else if (!named.has(id)) at(id, `custom rule "${id}" (${codePath('customRules', id)}) is not named by any action's rules, so it never runs`, `add "- custom: ${id}" to the rules of the action it guards, or delete the rule from ${codePath('customRules', id)}`);
  }
  return out;
}

/** The gate's tables (App.policy) from policy.yaml, checked against identity.yaml and the code. */
export function definePolicy(source: string | Record<string, unknown>, options: DefinePolicyOptions = {}): PolicyTables {
  const policy = loadConfigFile(source, 'policy');
  const identity = options.identity === undefined ? null : loadConfigFile(options.identity, 'identity');
  const problems: Problem[] = [...policy.problems, ...(identity?.problems ?? [])];
  if (policy.value && (identity === null || identity.value)) {
    problems.push(...policyProblems(checkInput(policy, identity, options)), ...customRuleProblems(policy.file, policy.value, options.customRules));
  }
  if (problems.length > 0 || !policy.value) throw new AppDefinitionError(policy.file, problems, `the policy in ${describeSource(source)}`);
  const attempts = identity?.value?.attempts;
  return compilePolicy(policy.value, { ...(attempts !== undefined ? { maxAttempts: attempts } : {}), ...(options.customRules !== undefined ? { customRules: options.customRules } : {}) });
}

/** The lifecycle's identity configuration (App.identity) from identity.yaml, checked against policy.yaml and the code. */
export function defineIdentity(source: string | Record<string, unknown>, options: DefineIdentityOptions = {}): IdentityConfig {
  const identity = loadConfigFile(source, 'identity');
  const policy = options.policy === undefined ? null : loadConfigFile(options.policy, 'policy');
  const problems: Problem[] = [...identity.problems, ...(policy?.problems ?? [])];
  if (identity.value && (policy === null || policy.value)) problems.push(...identityProblems(checkInput(policy, identity, options)));
  if (problems.length > 0 || !identity.value) throw new AppDefinitionError(identity.file, problems, `the identity in ${describeSource(source)}`);
  return compileIdentity(identity.value, options.sendCodeParams !== undefined ? { sendCodeParams: options.sendCodeParams } : {}).identity;
}
