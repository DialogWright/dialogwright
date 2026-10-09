import { slotSpecOf } from './app/lookup';
import type { App, SlotId } from './app/types';
import type { Thresholds } from './thresholds';

/**
 * A slot's retries (design 2026-10-09-per-slot-retries): how many failed answers it takes
 * (SlotSpec.attempts), and what follows when it runs out (SlotSpec.onMaxAttempts).
 */

/** How many failed answers `slot` takes before its outcome: its own `attempts`, else the run's MAX_ATTEMPTS. */
export function attemptsOf(app: App, slot: SlotId, t: Thresholds): number {
  return slotSpecOf(app, slot).attempts ?? t.MAX_ATTEMPTS;
}
