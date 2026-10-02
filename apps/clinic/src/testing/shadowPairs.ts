import type { SlotSpec } from 'dialogwright';

/**
 * The clinic's shadow pairs: each a library slot paired with the clinic's slot of the same id, run
 * beside it in every regression run (stub and recorded) when DIALOGWRIGHT_SHADOW is set
 * (dialogwright/testing). Empty until a clinic slot moves to a library type.
 */
export const CLINIC_SHADOW_PAIRS: readonly SlotSpec[] = [];
