import type { SlotSpec } from 'dialogwright';
import { nameSlot } from './name';
import { providerSlot } from './provider';

/** Every slot, in the order the console and the change question list them. */
export const ALL_SLOTS = ['name', 'dob', 'memberId', 'provider', 'date'] as const;
export type ClinicSlot = (typeof ALL_SLOTS)[number];

/**
 * The slots written in code. The birth date is a library `birthdate` slot, the member ID a library
 * `digits` slot and the appointment day a library `date` slot, configured in slots.yaml, so they are
 * not here; dob.ts, memberId.ts and date.ts are the hand-written slots they replaced, kept until the
 * library deletes the hand-written files (the shadow pairs in ../../testing/shadowPairs.ts compare each
 * with its library slot).
 */
export const SLOTS: Record<Exclude<ClinicSlot, 'dob' | 'memberId' | 'date'>, SlotSpec> = {
  name: nameSlot,
  provider: providerSlot,
};
