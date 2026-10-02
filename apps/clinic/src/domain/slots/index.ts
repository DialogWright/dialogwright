import type { SlotSpec } from 'dialogwright';
import { providerSlot } from './provider';

/** Every slot, in the order the console and the change question list them. */
export const ALL_SLOTS = ['name', 'dob', 'memberId', 'provider', 'date'] as const;
export type ClinicSlot = (typeof ALL_SLOTS)[number];

/**
 * The slots written in code. The caller's name is a library `name` slot, the birth date a library
 * `birthdate` slot, the member ID a library `digits` slot and the appointment day a library `date`
 * slot, configured in slots.yaml, so they are not here; name.ts, dob.ts, memberId.ts and date.ts are
 * the hand-written slots they replaced, kept until the library deletes the hand-written files (the
 * shadow pairs in ../../testing/shadowPairs.ts compare each with its library slot).
 */
export const SLOTS: Record<Exclude<ClinicSlot, 'name' | 'dob' | 'memberId' | 'date'>, SlotSpec> = {
  provider: providerSlot,
};
