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

/** Whether the app has the line `id` (its prompts.yaml; a locale without it says the default's). */
function hasLine(app: App, id: string): boolean {
  return Object.hasOwn(app.prompts.manifest, id);
}

/**
 * The line a missed answer re-asks `slot` with at its `k`th failure: `ask_<slot>_retry<k>` where the
 * app has it, else `ask_<slot>_retry`, the line every asked slot has.
 */
export function retryLineOf(app: App, slot: SlotId, k: number): string {
  const numbered = `ask_${slot}_retry${k}`;
  return hasLine(app, numbered) ? numbered : `ask_${slot}_retry`;
}

/**
 * The line a silence re-asks `slot` with at its `k`th failure, said as the whole turn:
 * `ask_<slot>_noinput<k>` where the app has it, else `ask_<slot>_noinput`; null where it has neither,
 * and the engine says the no-input line and the question as it always has.
 */
export function noInputLineOf(app: App, slot: SlotId, k: number): string | null {
  const numbered = `ask_${slot}_noinput${k}`;
  if (hasLine(app, numbered)) return numbered;
  const plain = `ask_${slot}_noinput`;
  return hasLine(app, plain) ? plain : null;
}
