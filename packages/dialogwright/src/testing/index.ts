/**
 * The package's test-support entry, `dialogwright/testing`: what an app's regression launchers and
 * tests use to prove a change leaves its calls as they were, kept out of the root entry so the
 * public API stays the engine's. The shadow harness runs a replacement slot beside the slot it
 * replaces and fails on any difference (shadowSlot.ts); `isCassetteMiss` tells a replayed turn the
 * cassette had no answer for; the slot conformance kit runs the checks any slot type must pass over
 * its examples (src/slots/conformance).
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
