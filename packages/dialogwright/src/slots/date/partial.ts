import { snapWeekdayOnOrAfter, type DateWindow } from '../../core/extract/date';
import type { SlotPartial } from '../../core/slots/types';

/**
 * A span of days heard without the day itself ("next week", "in December"): a `date` slot's pending
 * partial (SlotOutcome 'window') when it has `windows`, of kind "window", which its narrowPrompt asks
 * to narrow. Its parts are strings (ISO days and the span's label), so the engine never reads it as a
 * day heard (only numeric month and day parts are).
 */
export interface DateWindowPartial extends SlotPartial {
  kind: 'window';
  start: string;
  end: string;
  label: string;
}

/** The slot's own pending span of days, or null when none (or another kind) is pending. */
export function dateWindowOf(w: SlotPartial | null | undefined): DateWindow | null {
  return w?.kind === 'window' && typeof w.start === 'string' && typeof w.end === 'string' && typeof w.label === 'string'
    ? { start: w.start, end: w.end, label: w.label }
    : null;
}

/**
 * A day resolved while a span is pending, narrowed into it. A bare weekday narrows the span: "Wednesday"
 * after "sometime in December" is the first Wednesday in December, not this week's. A day named
 * outright (a month and day, a relative day) is taken as said. The search starts at today when the
 * span already began, so it never yields a past day. Null when the weekday has no day left inside
 * the span.
 */
export function constrainToWindow(iso: string, mode: string, window: DateWindow | null, todayIso: string): string | null {
  if (!window || mode !== 'weekday') return iso;
  if (iso >= window.start && iso <= window.end) return iso;
  const snapped = snapWeekdayOnOrAfter(iso, window.start > todayIso ? window.start : todayIso);
  return snapped <= window.end ? snapped : null;
}
