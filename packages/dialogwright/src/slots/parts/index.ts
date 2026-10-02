/**
 * The parts slot types share: text templates with literal overrides and question ids by part
 * (./text.ts), the template renderer (./template.ts), threshold reads by name (./thresholds.ts), and
 * the readers a type parses the model's answers and the caller's words with, re-exported from their
 * homes in the engine (which keep exporting them).
 */
export { textParts, questionParts, questionText } from './text';
export type { TextPartDef, TextParts, QuestionParts } from './text';
export { renderTemplate, checkTemplate, placeholdersOf, TemplateError } from './template';
export { meetsThreshold } from './thresholds';
export { atLeast, THRESHOLD_EPSILON } from '../../core/thresholds';
export { isChoice, isNoul, isScore, noulValue, rankProbabilities, topMargin } from '../../jev/types';
export { candidateSpans, candidateWordSpans, FILLER_WORDS } from '../../core/spans';
export { spokenToDigits, tokenize } from '../../core/extract/spokenNumber';
export { numbersSaid } from '../../core/extract/numbersSaid';
export type { NumbersSaidOptions } from '../../core/extract/numbersSaid';
export { matchesMask } from '../../core/extract/mask';
export { describeDay, describeDob, describeWindow, resolveDate, parseIso, toIso, addDays, normalizeYear, ordinal } from '../../core/extract/date';
export { resolvePastDate, pastDayResult } from '../../core/extract/pastDate';
export { examplesFrom, parseSlotExamples, slotExamplesSchema } from './examples';
