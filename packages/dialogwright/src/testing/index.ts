/**
 * The package's test-support entry, `dialogwright/testing`: what an app's regression launchers and
 * tests use to prove a change leaves its calls as they were, kept out of the root entry so the
 * public API stays the engine's. The shadow harness runs a replacement slot beside the slot it
 * replaces and fails on any difference (shadowSlot.ts); `isCassetteMiss` tells a replayed turn the
 * cassette had no answer for; the slot conformance kit runs the checks any slot type must pass over
 * its examples (src/slots/conformance). The policy's safety net: gate-event goldens write every
 * gate decision of a regression run (gateEvents.ts), and the gate grid crosses every tool with every
 * kind of principal, subject and fact, the legacy evaluator as its reference (gateGrid.ts); the
 * shadow gate runs an app's gate beside that reference on every call of a grid or a whole run and
 * fails on any difference (shadowGate.ts). The policy's invariants hold an app's gate to what its
 * policy file says on the whole grid (policyInvariants.ts), and the policy matrix is the reviewed
 * golden of what it decides, with every custom rule's examples run through it (policyMatrix.ts).
 */
export {
  shadowSlot, withShadowSlots, shadowFromEnv, shadowModeOf, createShadowReport, formatShadowReport, formatShadowMismatch,
  ShadowMismatchError, SHADOW_ENV,
} from './shadowSlot';
export type { ShadowMethod, ShadowMismatch, ShadowMode, ShadowOptions, ShadowReport } from './shadowSlot';
export { isCassetteMiss } from '../jev/cassette';
export {
  runSlotConformance, slotConformanceChecks, ConformanceError, CHECK_IDS, CHECK_ABOUT, kitContext, answersOf, quietAnswers, KIT_TODAY,
} from '../slots/conformance/index';
export type { CheckId, ConformanceCheck, SlotConformanceOptions, TestRegistrar } from '../slots/conformance/index';
export { gateEventGolden, gateEventLines } from './gateEvents';
export type { GateEventGolden, GateEventGoldenOptions, GateGoldenClient } from './gateEvents';
export {
  gateGridInput, gateGridCases, runGateGrid, compareGateGrid, legacyGateEvaluator, matrixProblems, gridPrincipals, gridTools,
  gridDecisionLine, formatGateGridMismatches, gridRuleCounts, gridUnexercised, gridVerdicts, UNLISTED_TOOL, GRID_PROBES, EXTRA_FIELD,
} from './gateGrid';
export type { GateGridInput, GateGridCase, GateGridPoint, GateGrid, GateGridMismatch, GateEvaluate } from './gateGrid';
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
