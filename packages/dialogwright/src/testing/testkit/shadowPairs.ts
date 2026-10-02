import type { SlotSpec } from '../../core/slots/types';
import { missingNoteSlot } from './domain/slots/missingNote';

/**
 * The testkit's shadow pairs: for each slot that now runs as a library type, the hand-written slot
 * it replaced, run beside it in every regression run when DIALOGWRIGHT_SHADOW is set
 * (testing/shadowSlot.ts). The app's own (library) slot is what the engine sees; the pair is
 * compared on every call, so the two cannot drift apart before the hand-written one is deleted.
 */
export const TESTKIT_SHADOW_PAIRS: readonly SlotSpec[] = [missingNoteSlot];
