import type { SlotPartial } from '../../core/slots/types';

/**
 * A date of birth heard in part: the month and day, the year still owed. The slot's pending partial
 * (SlotOutcome 'window'), of kind "dob", with numeric `month` and `day`, which the engine reads to
 * tell one calendar day heard by two date-valued slots on one turn, and zeroes where the slot is
 * redacted.
 */
export interface BirthdatePartial extends SlotPartial {
  kind: 'dob';
  month: number;
  day: number;
}

/** The slot's own pending partial, or null when none (or another kind) is pending. */
export function birthdatePartialOf(w: SlotPartial | null | undefined): BirthdatePartial | null {
  return w != null && w.kind === 'dob' && typeof w.month === 'number' && typeof w.day === 'number' ? { kind: 'dob', month: w.month, day: w.day } : null;
}
