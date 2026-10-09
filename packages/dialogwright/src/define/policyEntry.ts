/**
 * The package's policy entry, `dialogwright/policy`: an app's policy and identity, from the files to
 * the gate. First the gate itself: the compiled policy an app's calls go through (compiledPolicyOf,
 * the named rules the lifecycle runs) and what a decision is asked (passed). Then what an app that
 * is not a folder builds its App.policy and App.identity with (definePolicy, defineIdentity), the
 * compilers they and defineApp share, `defineRule` for an app's own rules and the examples that say
 * what they do, the converter behind `dialogwright policy:convert` (convertTables, convertFolder),
 * and the types the gate's tables and rules are written in. Kept out of the root entry, which stays
 * the engine's everyday API; the gate's types are in both. The legacy evaluator over the tables, the
 * shadow gate's reference, is test support: `evaluateCall` in `dialogwright/testing`.
 *
 *   import { compiledPolicyOf, definePolicy, defineIdentity, defineRule, passed, type RuleContext } from 'dialogwright/policy';
 */

// The gate: the policy's named rules compiled (the gate an app's calls go through), whether a decision
// ran a rule by name and it passed, the hash the confirmed rule compares, and the built-in rules' ids
// (RULE_ID: the names decisions and audit lines record; LEGACY_RULE_ID, TABLE_RULE_ID and RULE_IDS:
// the ids tables' rulesFor still use).
export { compiledPolicyOf, compileGate, programFromTables, sourceOf, identityToolsOf, subjectOnlyDecision, LEGACY_RULE_ID, TABLE_RULE_ID, RULE_ID, UNLISTED_RULE_ID, SUBJECT_RULE_ID, SUBJECT_ONLY_REASON, BUILT_IN_RULES, NAMED_RULE_IDS, isBuiltInRuleId } from '../gate/compiled';
export type { CompiledPolicy, PolicySource, PolicyAction, LegacyRuleName } from '../gate/compiled';
export { passed } from '../gate/types';
export { confirmationHash, RULE_IDS, isRuleId } from '../gate/policy';
export type { RuleId } from '../gate/policy';
// The range rules (dateInRange, limit) and the reference grammar their bounds are written in.
export { parseLookupRef, parseDateBound, parseNumberBound, isIsoDate, DATE_IN_RANGE_REASONS, LIMIT_REASONS, BOUND_UNKNOWN } from '../gate/bounded';
export type { LookupRef, DateBound, NumberBound, RangeVerdict, DateInRangeParams, LimitParams } from '../gate/bounded';
// The list rules (oneOf, noneOf): a param's value held to a list, matched exactly.
export { ONE_OF_REASON, NONE_OF_REASON, VALUE_MISSING } from '../gate/listed';
export type { ListParams } from '../gate/listed';

// policy.yaml and identity.yaml for an app that is not a folder, and the compilers behind them.
export { definePolicy, defineIdentity } from './definePolicy';
export type { DefinePolicyOptions, DefineIdentityOptions } from './definePolicy';
export { compilePolicy, compileIdentity, roleLine, DEFAULT_ACTION_LEVEL, DEFAULT_MAX_ATTEMPTS, DEFAULT_ROLE_PERSON_REASON, DEFAULT_CODE_LENGTH } from './policyFile';
export type { CompilePolicyOptions, CompileIdentityOptions, CompiledIdentity, Rule } from './policyFile';
export { convertFolder, convertTables, writeConversion, toText as conversionText, ConvertError } from './convert/convertPolicy';
export type { Conversion, ConvertOptions, FolderConversion } from './convert/convertPolicy';
export { policySchema, identitySchema, RULE_NAMES } from './schema/index';
export type { PolicyYaml, IdentityYaml, ActionYaml, RuleEntryYaml, RuleName, DateInRangeYaml, LimitYaml, ListYaml } from './schema/index';

// An app's own rule, with the examples that say what it does (check refuses one without them).
export { defineRule, isDefinedRule, ruleDefinitionProblems } from '../gate/defineRule';
export type { DefinedRule, RuleDefinition, RuleExample, RuleExampleCall, RuleAnswer, RuleProblem } from '../gate/defineRule';

// The types the gate's tables and an app's own rules are written in.
export type { PolicyTables, PolicyWording, RoleAccess, SubjectParam, ScopeAsker, IdentityConfig, ToolName } from '../core/app/types';
export type {
  Level, Anonymous, Party, Principal, ToolCall, GateVerdict, RuleResult, GateDecision, GateLookups, GateFacts, RuleContext, RuleOutcome,
} from '../gate/types';
