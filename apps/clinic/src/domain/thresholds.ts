/**
 * The clinic's own thresholds (App.thresholds), beside the engine's. A run overrides one like any
 * other (`--threshold TIME_OF_DAY=0.7`).
 * - PROVIDER_UNSURE: how sure the model must be that the caller hedged about the provider before a
 *   name is read back ("With Dr. Kim.") or two close names are asked about.
 * - TIME_OF_DAY: how sure, that the caller asked for a part of the day, before it is kept.
 * - TIME_PREFERENCE: how sure, that the caller asked for an earlier, later or different time, before
 *   the offer moves.
 */
export const CLINIC_THRESHOLDS = { PROVIDER_UNSURE: 0.45, TIME_OF_DAY: 0.6, TIME_PREFERENCE: 0.6 } as const;
export type ClinicThreshold = keyof typeof CLINIC_THRESHOLDS;

/**
 * One of the clinic's thresholds as a turn has it. The engine puts them on every turn's and slot's
 * thresholds; a slot spec called outside a turn (a unit test) gets the clinic's default.
 */
export function clinicThreshold(t: Readonly<Record<string, number>>, name: ClinicThreshold): number {
  return t[name] ?? CLINIC_THRESHOLDS[name];
}
