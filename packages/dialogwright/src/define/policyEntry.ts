/**
 * The package's policy entry, `dialogwright/policy`: an app's policy and identity, from the files to
 * the gate. What an app that is not a folder builds its App.policy and App.identity with
 * (definePolicy, defineIdentity), the compilers they and defineApp share, and the gate itself with
 * the types its tables and rules are written in, for an app's custom rules and its gate tests, and
 * the converter behind `dialogwright policy:convert` (convertTables, convertFolder). Kept
 * out of the root entry, which stays the engine's everyday API; the gate's types are in both.
 *
 *   import { definePolicy, defineIdentity, evaluateCall, type RuleContext } from 'dialogwright/policy';
 */

// policy.yaml and identity.yaml for an app that is not a folder, and the compilers behind them.
export { definePolicy, defineIdentity } from './definePolicy';
export type { DefinePolicyOptions, DefineIdentityOptions } from './definePolicy';
export {
  compilePolicy, compileIdentity, readRule, ruleIdOf, roleLine, RULE_ID_OF, DEFAULT_ACTION_LEVEL, DEFAULT_MAX_ATTEMPTS, DEFAULT_ROLE_PERSON_REASON, DEFAULT_CODE_LENGTH,
} from './policyFile';
export type { CompilePolicyOptions, CompileIdentityOptions, CompiledIdentity, Rule } from './policyFile';
export { convertFolder, convertTables, writeConversion, toText as conversionText, ConvertError } from './convert/convertPolicy';
export type { Conversion, ConvertOptions, FolderConversion } from './convert/convertPolicy';
export { policySchema, identitySchema, RULE_NAMES } from './schema/index';
export type { PolicyYaml, IdentityYaml, ActionYaml, RuleEntryYaml, RuleName } from './schema/index';

// The gate: its decision on a call, the hash its confirmed rule compares, and its built-in rule ids.
export { evaluateCall, confirmationHash, RULE_IDS, isRuleId } from '../gate/policy';
export type { RuleId } from '../gate/policy';

// The types the gate's tables and an app's own rules are written in.
export type { PolicyTables, PolicyWording, RoleAccess, SubjectParam, ScopeAsker, IdentityConfig, ToolName } from '../core/app/types';
export type {
  Level, Anonymous, Party, Principal, ToolCall, GateVerdict, RuleResult, GateDecision, GateLookups, GateFacts, RuleContext, RuleOutcome,
} from '../gate/types';
