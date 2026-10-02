import type { SlotSpec } from '../../../../core/slots/types';
import { accountIdSlot } from './accountId';
import { dobSlot } from './dob';
import { parcelSelectSlot } from './parcelSelect';
import { deliveryDaySlot } from './deliveryDay';
import { deliveryPartSlot } from './deliveryPart';
import { missingNoteSlot } from './missingNote';
import { expectedDateSlot } from './expectedDate';

/** Every slot, identity factors first, then each form's in turn. */
export const ALL_SLOTS = ['accountId', 'dob', 'parcelSelect', 'deliveryDay', 'deliveryPart', 'missingNote', 'expectedDate'] as const;
export type TestkitSlot = (typeof ALL_SLOTS)[number];

export const SLOTS: Record<TestkitSlot, SlotSpec> = {
  accountId: accountIdSlot,
  dob: dobSlot,
  parcelSelect: parcelSelectSlot,
  deliveryDay: deliveryDaySlot,
  deliveryPart: deliveryPartSlot,
  missingNote: missingNoteSlot,
  expectedDate: expectedDateSlot,
};
