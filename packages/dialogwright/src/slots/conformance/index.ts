/**
 * The slot conformance kit, exported from `dialogwright/testing`: the checks any slot type must
 * pass, run over its examples. See ../README.md, "The conformance kit".
 */
export { slotConformanceChecks, ConformanceError, CHECK_IDS, CHECK_ABOUT } from './checks';
export type { CheckId, ConformanceCheck, SlotConformanceOptions } from './checks';
export { runSlotConformance } from './run';
export type { TestRegistrar } from './run';
export { kitContext, answersOf, quietAnswers, KIT_TODAY } from './turns';
