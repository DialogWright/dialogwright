import type { SlotSpec } from '../../../../core/slots/types';
import { accountIdDigitsSlot } from './accountIdDigits';
import { dobSlot } from './dob';
import { parcelSelectSlot } from './parcelSelect';
import { deliveryDaySlot } from './deliveryDay';
import { deliveryPartSlot } from './deliveryPart';
import { missingNoteTextSlot } from './missingNoteText';
import { expectedDateSlot } from './expectedDate';

/** Every slot, identity factors first, then each form's in turn. */
export const ALL_SLOTS = ['accountId', 'dob', 'parcelSelect', 'deliveryDay', 'deliveryPart', 'missingNote', 'expectedDate'] as const;
export type TestkitSlot = (typeof ALL_SLOTS)[number];

export const SLOTS: Record<TestkitSlot, SlotSpec> = {
  // A library `digits` slot; accountId.ts (hand-written) is what the shadow pair compares it with.
  accountId: accountIdDigitsSlot,
  dob: dobSlot,
  parcelSelect: parcelSelectSlot,
  deliveryDay: deliveryDaySlot,
  deliveryPart: deliveryPartSlot,
  // A library `text` slot; missingNote.ts (hand-written) is what the shadow pair compares it with.
  missingNote: missingNoteTextSlot,
  expectedDate: expectedDateSlot,
};
