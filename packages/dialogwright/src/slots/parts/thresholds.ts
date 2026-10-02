import { atLeast } from '../../core/thresholds';
import type { Thresholds } from '../../core/thresholds';

/**
 * Whether the model's probability `p` reaches the threshold named `name` in `thresholds` (a slot
 * reads `ctx.thresholds`), allowing for floating-point rounding (atLeast). A library type compares
 * only this way, by name, never against a number written in the type: a run's overrides and the
 * sweep then move every slot together, and the conformance kit checks it. False when the name is
 * not there (an app's own threshold a unit test's context lacks), so a missing threshold never fills.
 */
export function meetsThreshold(thresholds: Thresholds, name: string, p: number): boolean {
  const threshold = (thresholds as Readonly<Record<string, number>>)[name];
  return typeof threshold === 'number' && atLeast(p, threshold);
}
