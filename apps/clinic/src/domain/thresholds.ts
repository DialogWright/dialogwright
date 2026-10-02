import { getApp } from 'dialogwright';

/**
 * The clinic's own thresholds (App.thresholds), beside the engine's. Their defaults are in app.yaml
 * (`thresholds:`), and a run overrides one like any other (`--threshold TIME_OF_DAY=0.7`).
 * - PROVIDER_UNSURE: how sure the model must be that the caller hedged about the provider before a
 *   name is read back ("With Dr. Kim.") or two close names are asked about.
 * - TIME_OF_DAY: how sure, that the caller asked for a part of the day, before it is kept.
 * - TIME_PREFERENCE: how sure, that the caller asked for an earlier, later or different time, before
 *   the offer moves.
 */
export type ClinicThreshold = 'PROVIDER_UNSURE' | 'TIME_OF_DAY' | 'TIME_PREFERENCE';

/**
 * One of the clinic's thresholds as a turn has it. The engine puts them on every turn's and slot's
 * thresholds; a slot spec or hook called outside a turn (a unit test) reads the default from the
 * registered clinic, which has it from app.yaml.
 */
export function clinicThreshold(t: Readonly<Record<string, number>>, name: ClinicThreshold): number {
  const value = t[name] ?? getApp('clinic').thresholds?.[name];
  if (value === undefined) throw new Error(`the clinic threshold ${name} is not set: add it under thresholds in app.yaml`);
  return value;
}
