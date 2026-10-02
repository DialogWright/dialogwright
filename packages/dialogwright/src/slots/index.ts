/**
 * The slot library: built-in slot types an app names in configuration rather than writing a slot
 * by hand. See README.md beside this file.
 */
export { defineSlot, buildSlot, SlotConfigError, isSlotConfigError, slotTypeJsonSchema } from './defineSlot';
export type { BuildSlotOptions, BuildSlotResult, SlotSource } from './defineSlot';
export { defineSlots } from './defineSlots';
export { resolveSlots, mergeSlotTypes } from './resolveSlots';
export type { ResolveSlotsInput, ResolvedSlots, SlotsFileSource, SlotTypeProblem } from './resolveSlots';
export { BUILT_IN_SLOT_TYPES, registerSlotType } from './registry';
export { defineSlotType, refusesUnknownKeys, SLOT_TYPE_NAME } from './slotType';
export { digitsType } from './digits/index';
export type { DigitsOptions } from './digits/index';
export { textType } from './text/index';
export type { TextOptions } from './text/index';
export type {
  BuiltSlotSpec, SlotType, SlotTypeDocs, LibrarySlotSpec, SlotExample, SlotUtterance, ExampleAnswer, ExampleContext,
  ExpectedOutcome, SlotKeypadExample, SlotTypes,
} from './types';
export * from './parts/index';
