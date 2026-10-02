import type { SlotSpec } from '../../core/slots/types';

/**
 * The testkit's shadow pairs: each a library slot paired with the testkit's slot of the same id,
 * run beside it in every regression run when DIALOGWRIGHT_SHADOW is set (testing/shadowSlot.ts).
 * Empty until a testkit slot moves to a library type.
 */
export const TESTKIT_SHADOW_PAIRS: readonly SlotSpec[] = [];
