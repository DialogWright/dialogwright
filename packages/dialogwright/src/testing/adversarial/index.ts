/**
 * The adversarial suite every app inherits (design section 7; the guide's "The adversarial suite"):
 * cases generated from the app (adversarialSuite), run against it with properties checked over each
 * run, not lines (runAdversarialSuite), and the report a regression prints (formatAdversarialReport).
 */
export { adversarialSuite } from './generate';
export type { AdversarialSuiteOptions } from './generate';
export { runAdversarialSuite, outcomeClassOf, PERCEIVED } from './run';
export type { AdversarialReport, AdversarialRunOptions, CaseCall, CaseResult, CaseStatus } from './run';
export { formatAdversarialReport, adversarialTranscript } from './print';
export { HOSTILE_TEXT, HOSTILE_MARKERS, saysHostile } from './hostile';
export type { HostileMode } from './hostile';
export { FAMILIES, OUTCOME_CLASSES } from './types';
export type { AdversarialCase, AdversarialFamily, AdversarialSuite, OutcomeClass, Perception, PropertyName, HostileTarget, CodePrompt } from './types';
export { TEMPLATES } from './templates';
