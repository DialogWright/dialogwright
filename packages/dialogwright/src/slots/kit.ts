/**
 * `dialogwright/slot-kit`: what the author of a slot type uses to write one (see README.md beside
 * this file, and CONTRIBUTING's "Adding a slot type"). An app that only names types in slots.yaml
 * needs none of it; it imports from 'dialogwright'. The conformance kit a type must pass is in
 * `dialogwright/testing`.
 *
 *   import { defineSlotType, textParts, questionParts, meetsThreshold, examplesFrom } from 'dialogwright/slot-kit';
 *   import { noulValue, type SlotType } from 'dialogwright';
 */
export { defineSlotType } from './slotType';
export { textParts, questionParts, questionText } from './parts/text';
export type { TextPartDef, TextParts, QuestionParts } from './parts/text';
export { renderTemplate, TemplateError } from './parts/template';
export { meetsThreshold } from './parts/thresholds';
export { examplesFrom, parseSlotExamples } from './parts/examples';
export { wordingFor } from './parts/locale';
export type {
  BuiltSlotSpec, SlotBuildEnv, SlotTypeDocs, SlotWording, SlotExample, SlotUtterance, ExampleAnswer, ExampleContext, ExpectedOutcome, SlotKeypadExample,
} from './types';
export type { ChoiceWording } from './choice/index';
export type { TextWording } from './text/index';
