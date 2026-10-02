import type { SlotId } from './app/types';
import { DEFAULT_THRESHOLDS } from './thresholds';
import type { SlotSpec } from './slots/types';

/**
 * The check that keeps a slot's named thresholds (SlotSpec.thresholds) to names that exist: one of
 * the engine's, or one the app names (App.thresholds). A leaf module, so app validation
 * (core/app/validate.ts) and `dialogwright check` read the same rule.
 */

/** A threshold a slot names that nothing defines. */
export interface UnknownThreshold {
  slot: SlotId;
  name: string;
}

/** Every threshold name there is for an app: the engine's, then the app's own. */
export function thresholdNamesOf(own: Readonly<Record<string, number>> | undefined): string[] {
  return [...Object.keys(DEFAULT_THRESHOLDS), ...Object.keys(own ?? {})];
}

/** Each name a slot declares (SlotSpec.thresholds) that is neither an engine threshold nor one of `own`, in the slots' order. */
export function unknownSlotThresholds(slots: Readonly<Record<SlotId, SlotSpec>>, own: Readonly<Record<string, number>> | undefined): UnknownThreshold[] {
  const unknown: UnknownThreshold[] = [];
  for (const [slot, spec] of Object.entries(slots)) {
    for (const name of spec?.thresholds ?? []) {
      if (!Object.hasOwn(DEFAULT_THRESHOLDS, name) && !Object.hasOwn(own ?? {}, name)) unknown.push({ slot, name });
    }
  }
  return unknown;
}

/** An unknown threshold in words: `slot "provider" names the threshold "PROVIDER_UNSUR", which is neither ...`. */
export function unknownThresholdMessage(u: UnknownThreshold): string {
  return `slot "${u.slot}" names the threshold "${u.name}", which is neither one of the engine's thresholds nor one the app names`;
}
