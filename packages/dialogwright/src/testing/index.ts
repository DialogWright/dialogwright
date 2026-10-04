/**
 * The package's test-support entry, `dialogwright/testing`: what an app's regression launchers and
 * tests use to prove a change leaves its calls as they were, kept out of the root entry so the
 * public API stays the engine's. The shadow harness runs a replacement slot beside the slot it
 * replaces and fails on any difference (shadowSlot.ts); `isCassetteMiss` tells a replayed turn the
 * cassette had no answer for; the slot conformance kit runs the checks any slot type must pass over
 * its examples (src/slots/conformance). Goldens are written from one run of an app's corpus and
 * scenarios as `regress` runs them, each turn kept whole (goldenRuns.ts), so an app can write its
 * own (the knowledge its answers were read from, say) from the same turns. The policy's safety net:
 * gate-event goldens write every gate decision of a regression run (gateEvents.ts), and the gate grid crosses every tool with every
 * kind of principal, subject and fact, the legacy evaluator (evaluateCall, exported here as test
 * support) as its reference (gateGrid.ts); the
 * shadow gate runs an app's gate beside that reference on every call of a grid or a whole run and
 * fails on any difference (shadowGate.ts). The policy's invariants hold an app's gate to what its
 * policy file says on the whole grid (policyInvariants.ts), and the policy matrix is the reviewed
 * golden of what it decides, with every custom rule's examples run through it (policyMatrix.ts). Two
 * more pages are written from the compiled app and kept as goldens: the policy card, the policy in
 * plain English with its diagrams (policyCard.ts), and the app map, its intents, forms, slots,
 * actions and rules as diagrams (appMap.ts).
 */
export {
  shadowSlot, withShadowSlots, shadowFromEnv, shadowModeOf, createShadowReport, formatShadowReport, formatShadowMismatch,
  ShadowMismatchError, SHADOW_ENV,
} from './shadowSlot';
export type { ShadowMethod, ShadowMismatch, ShadowMode, ShadowOptions, ShadowReport } from './shadowSlot';
export { isCassetteMiss } from '../jev/cassette';
// Retrievers for a test of a topic slot or a knowledge app: one that nominates exactly what it is
// given, and one that nominates by plain keywords (retrievers.ts).
export { fixedRetriever, keywordRetriever } from './retrievers';
export type { FixedNominations, KeywordRetrieverOptions, KeywordTopic } from './retrievers';
export {
  runSlotConformance, slotConformanceChecks, ConformanceError, CHECK_IDS, CHECK_ABOUT, kitContext, answersOf, quietAnswers, KIT_TODAY,
} from '../slots/conformance/index';
export type { CheckId, ConformanceCheck, SlotConformanceOptions, TestRegistrar } from '../slots/conformance/index';
export { goldenRuns } from './goldenRuns';
export type { GoldenClient, GoldenRunOptions, GoldenRuns, GoldenSection } from './goldenRuns';
export { gateEventGolden, gateEventLines } from './gateEvents';
export type { GateEventGolden, GateEventGoldenOptions, GateGoldenClient } from './gateEvents';
export {
  gateGridInput, gateGridCases, runGateGrid, compareGateGrid, legacyGateEvaluator, nameOfLegacyId, namedDecision, matrixProblems, gridPrincipals, gridTools,
  gridDecisionLine, formatGateGridMismatches, gridRuleCounts, gridUnexercised, gridVerdicts, UNLISTED_TOOL, GRID_PROBES, EXTRA_FIELD,
} from './gateGrid';
export type { GateGridInput, GateGridCase, GateGridPoint, GateGrid, GateGridMismatch, GateEvaluate } from './gateGrid';
// The legacy evaluator over the tables: the shadow gate's and the grid's reference, which an app's
// direct gate tests may hold its compiled gate to (through namedDecision, and with the identity tools'
// subject check in front of it, as legacyGateEvaluator has).
export { evaluateCall } from '../gate/policy';
export {
  withShadowGate, shadowGate, gateEvaluator, legacyGateOf, createGateShadowReport, gateShadowUnexercised, formatGateShadowReport,
  formatGateShadowMismatch, GateShadowMismatchError,
} from './shadowGate';
export type { GateShadowReport, GateShadowMismatch, GateShadowOptions, GateShadowCounts } from './shadowGate';
export {
  policyInvariants, checkPolicyInvariants, formatPolicyInvariantViolations, ruleLabel, PolicyInvariantError, INVARIANTS, INVARIANT_ABOUT,
  CONVERSATION_STATE_DAY,
} from './policyInvariants';
export type { InvariantName, PolicyInvariantViolation, PolicyInvariantReport, PolicyInvariantOptions } from './policyInvariants';
export {
  policyMatrixText, expectPolicyMatrix, writePolicyMatrix, lineDiff, verdictText, ruleExampleResults, runRuleExamples, RuleExampleError,
} from './policyMatrix';
export type { RuleExampleResult, RuleExampleRun } from './policyMatrix';
export { policyCardText, expectPolicyCard, writePolicyCard, ruleName, POLICY_CARD_FILE } from './policyCard';
export { appMapText, expectAppMap, writeAppMap, danglingReferences, APP_MAP_FILE } from './appMap';
export type { DanglingReference } from './appMap';
