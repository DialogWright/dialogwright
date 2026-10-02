import type { SlotSpec } from 'dialogwright';
import { dateSlot } from './date';
import { dobSlot } from './dob';
import { nameSlot } from './name';
import { providerSlot } from './provider';

/** Every slot, in the order the console and the change question list them. */
export const ALL_SLOTS = ['name', 'dob', 'memberId', 'provider', 'date'] as const;
export type ClinicSlot = (typeof ALL_SLOTS)[number];

/**
 * The slots written in code. The member ID is a library `digits` slot, configured in slots.yaml,
 * so it is not here; memberId.ts is the hand-written slot it replaced, kept until the library
 * deletes the hand-written files (the shadow pair in ../../testing/shadowPairs.ts compares the two).
 */
export const SLOTS: Record<Exclude<ClinicSlot, 'memberId'>, SlotSpec> = {
  name: nameSlot,
  dob: dobSlot,
  provider: providerSlot,
  date: dateSlot,
};
