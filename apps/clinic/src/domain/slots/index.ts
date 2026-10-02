import type { SlotSpec } from 'dialogwright';
import { dateSlot } from './date';
import { nameSlot } from './name';
import { providerSlot } from './provider';

/** Every slot, in the order the console and the change question list them. */
export const ALL_SLOTS = ['name', 'dob', 'memberId', 'provider', 'date'] as const;
export type ClinicSlot = (typeof ALL_SLOTS)[number];

/**
 * The slots written in code. The birth date is a library `birthdate` slot and the member ID a library
 * `digits` slot, configured in slots.yaml, so they are not here; dob.ts and memberId.ts are the
 * hand-written slots they replaced, kept until the library deletes the hand-written files (the shadow
 * pairs in ../../testing/shadowPairs.ts compare each with its library slot).
 */
export const SLOTS: Record<Exclude<ClinicSlot, 'dob' | 'memberId'>, SlotSpec> = {
  name: nameSlot,
  provider: providerSlot,
  date: dateSlot,
};
