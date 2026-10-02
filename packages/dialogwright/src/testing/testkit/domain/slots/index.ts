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
  // A library `digits` slot; oracles/accountId.ts is its test oracle.
  accountId: accountIdDigitsSlot,
  // A library `birthdate` slot; oracles/dob.ts is its test oracle.
  dob: dobBirthdateSlot,
  // A library `record` slot; oracles/parcelSelect.ts is its test oracle.
  parcelSelect: parcelSelectRecordSlot,
  // A library `date` slot; oracles/deliveryDay.ts is its test oracle.
  deliveryDay: deliveryDayDateSlot,
  // A library `choice` slot; oracles/deliveryPart.ts is its test oracle.
  deliveryPart: deliveryPartChoiceSlot,
  // A library `text` slot; oracles/missingNote.ts is its test oracle.
  missingNote: missingNoteTextSlot,
  // A library `date` slot; oracles/expectedDate.ts is its test oracle.
  expectedDate: expectedDateDateSlot,
};
