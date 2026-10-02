import type { SlotSpec } from 'dialogwright';
import { dateSlot } from './date';
import { dobSlot } from './dob';
import { memberIdSlot } from './memberId';
import { nameSlot } from './name';
import { providerSlot } from './provider';

/** Every slot, in the order the console and the change question list them. */
export const ALL_SLOTS = ['name', 'dob', 'memberId', 'provider', 'date'] as const;
export type ClinicSlot = (typeof ALL_SLOTS)[number];

export const SLOTS: Record<ClinicSlot, SlotSpec> = {
  name: nameSlot,
  dob: dobSlot,
  memberId: memberIdSlot,
  provider: providerSlot,
  date: dateSlot,
};
