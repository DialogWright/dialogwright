import type { SlotSpec } from 'dialogwright';
import { dateSlot } from '../domain/slots/date';
import { dobSlot } from '../domain/slots/dob';
import { memberIdSlot } from '../domain/slots/memberId';
import { nameSlot } from '../domain/slots/name';
import { providerSlot } from '../domain/slots/provider';

/**
 * The clinic's shadow pairs: for each slot that now runs as a library type, the hand-written slot it
 * replaced, run beside it in every regression run (stub and recorded) when DIALOGWRIGHT_SHADOW is set
 * (dialogwright/testing). The app's own (library) slot is what the engine sees; the pair is compared
 * on every call, so the two cannot drift apart before the hand-written one is deleted.
 */
export const CLINIC_SHADOW_PAIRS: readonly SlotSpec[] = [nameSlot, dobSlot, memberIdSlot, providerSlot, dateSlot];
