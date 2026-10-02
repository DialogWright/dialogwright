import type { SlotSpec } from 'dialogwright';

/** Every slot, in the order the console and the change question list them. */
export const ALL_SLOTS = ['name', 'dob', 'memberId', 'provider', 'date'] as const;
export type ClinicSlot = (typeof ALL_SLOTS)[number];

/**
 * The slots written in code: none. The caller's name is a library `name` slot, the birth date a
 * library `birthdate` slot, the member ID a library `digits` slot, the provider a library `choice`
 * slot and the appointment day a library `date` slot, configured in slots.yaml. The hand-written
 * slots they replaced are frozen in ../../testing/oracles/, used only by the grid tests.
 */
export const SLOTS: Record<never, SlotSpec> = {};
