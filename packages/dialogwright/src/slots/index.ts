/**
 * The slot library: built-in slot types an app names in configuration rather than writing a slot
 * by hand. See README.md beside this file. This is what an app uses, re-exported from the package
 * root; what the author of a slot type uses is in ./kit.ts (`dialogwright/slot-kit`), and the
 * conformance kit is in `dialogwright/testing`.
 */
export { defineSlot, buildSlot, SlotConfigError, isSlotConfigError } from './defineSlot';
export type { BuildSlotOptions, BuildSlotResult, DefineSlotOptions, SlotSource } from './defineSlot';
export { defineSlots } from './defineSlots';
export type { DefineSlotsOptions } from './defineSlots';
export { BUILT_IN_SLOT_TYPES, registerSlotType } from './registry';
export type { BirthdateOptions } from './birthdate/index';
export type { ChoiceOptions, ChoiceOption } from './choice/index';
export type { DateOptions } from './date/index';
export type { DigitsOptions } from './digits/index';
export type { NameOptions } from './name/index';
export type { RecordOptions } from './record/index';
export type { TextOptions } from './text/index';
export type { TopicOptions } from './topic/index';
export type { SlotType, LibrarySlotSpec, SlotTypes, SlotBuildEnv } from './types';
