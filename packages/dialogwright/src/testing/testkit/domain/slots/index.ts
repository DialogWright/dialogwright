import type { SlotSpec } from '../../../../core/slots/types';
import { accountIdDigitsSlot } from './accountIdDigits';
import { dobBirthdateSlot } from './dobBirthdate';
import { parcelSelectRecordSlot } from './parcelSelectRecord';
import { deliveryDayDateSlot } from './deliveryDayDate';
import { deliveryPartChoiceSlot } from './deliveryPartChoice';
import { missingNoteTextSlot } from './missingNoteText';
import { expectedDateDateSlot } from './expectedDateDate';

/** Every slot, identity factors first, then each form's in turn. */
export const ALL_SLOTS = ['accountId', 'dob', 'parcelSelect', 'deliveryDay', 'deliveryPart', 'missingNote', 'expectedDate'] as const;
export type TestkitSlot = (typeof ALL_SLOTS)[number];

export const SLOTS: Record<TestkitSlot, SlotSpec> = {
  // A library `digits` slot; accountId.ts (hand-written) is what the shadow pair compares it with.
  accountId: accountIdDigitsSlot,
  // A library `birthdate` slot; dob.ts (hand-written) is what the shadow pair compares it with.
  dob: dobBirthdateSlot,
  // A library `record` slot; parcelSelect.ts (hand-written) is what the shadow pair compares it with.
  parcelSelect: parcelSelectRecordSlot,
  // A library `date` slot; deliveryDay.ts (hand-written) is what the shadow pair compares it with.
  deliveryDay: deliveryDayDateSlot,
  // A library `choice` slot; deliveryPart.ts (hand-written) is what the shadow pair compares it with.
  deliveryPart: deliveryPartChoiceSlot,
  // A library `text` slot; missingNote.ts (hand-written) is what the shadow pair compares it with.
  missingNote: missingNoteTextSlot,
  // A library `date` slot; expectedDate.ts (hand-written) is what the shadow pair compares it with.
  expectedDate: expectedDateDateSlot,
};
