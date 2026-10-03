/**
 * The package's policy entry, `dialogwright/policy`: an app's policy and identity, from the files to
 * the gate. What an app that is not a folder builds its App.policy and App.identity with
 * (definePolicy, defineIdentity), the compilers they and defineApp share, the gate itself (the
 * compiled policy an app's calls go through, and the legacy evaluator the shadow gate compares it
 * with) with the types its tables and rules are written in, for an app's custom rules and its gate
 * tests, `defineRule` for an app's own rules and the examples that say what they do, and the
 * converter behind `dialogwright policy:convert` (convertTables, convertFolder). Kept out of the
 * root entry, which stays the engine's everyday API; the gate's types are in both.
 *
 *   import { definePolicy, defineIdentity, defineRule, compiledPolicyOf, type RuleContext } from 'dialogwright/policy';
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
export type { PolicyYaml, IdentityYaml, ActionYaml, RuleEntryYaml, RuleName, DateInRangeYaml, LimitYaml } from './schema/index';

// The gate: the policy's named rules compiled (the gate an app's calls go through), and the legacy
// evaluator over the tables (the shadow gate's reference, which an app's direct gate tests may call);
// the hash the confirmed rule compares, and the built-in rules' ids (RULE_ID: the names decisions and
// audit lines record; LEGACY_RULE_ID and TABLE_RULE_ID: the ids tables' rulesFor still use).
export { compiledPolicyOf, compileGate, programFromTables, sourceOf, LEGACY_RULE_ID, TABLE_RULE_ID, RULE_ID, UNLISTED_RULE_ID, BUILT_IN_RULES, NAMED_RULE_IDS, isBuiltInRuleId } from '../gate/compiled';
export type { CompiledPolicy, PolicySource, PolicyAction, LegacyRuleName } from '../gate/compiled';
// The range rules (dateInRange, limit) and the reference grammar their bounds are written in.
export { parseLookupRef, parseDateBound, parseNumberBound, isIsoDate, DATE_IN_RANGE_REASONS, LIMIT_REASONS, BOUND_UNKNOWN } from '../gate/bounded';
export type { LookupRef, DateBound, NumberBound, RangeVerdict, DateInRangeParams, LimitParams } from '../gate/bounded';
export { evaluateCall, confirmationHash, RULE_IDS, isRuleId } from '../gate/policy';
export type { RuleId } from '../gate/policy';

// An app's own rule, with the examples that say what it does (check refuses one without them).
export { defineRule, isDefinedRule, ruleDefinitionProblems } from '../gate/defineRule';
export type { DefinedRule, RuleDefinition, RuleExample, RuleExampleCall, RuleAnswer, RuleProblem } from '../gate/defineRule';

// The types the gate's tables and an app's own rules are written in.
export type { PolicyTables, PolicyWording, RoleAccess, SubjectParam, ScopeAsker, IdentityConfig, ToolName } from '../core/app/types';
export type {
  Level, Anonymous, Party, Principal, ToolCall, GateVerdict, RuleResult, GateDecision, GateLookups, GateFacts, RuleContext, RuleOutcome,
} from '../gate/types';
// Whether a decision ran a rule, by name, and it passed (what an app's code asks of the gate's answer).
export { passed } from '../gate/types';
