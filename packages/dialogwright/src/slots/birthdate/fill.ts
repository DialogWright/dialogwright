import { MONTHS, normalizeYear } from '../../core/extract/date';
import type { SlotCandidate, SlotContext, SlotOutcome } from '../../core/slots/types';
import type { AnswerMap } from '../../jev/types';
import { isChoice, noulValue } from '../../jev/types';
import { dayFirst } from '../parts/locale';
import { meetsThreshold } from '../parts/thresholds';
import type { BirthdateOptions } from './options';
import { birthdatePartialOf, type BirthdatePartial } from './partial';
import type { BirthdateIds } from './questions';

/** The calendar day as an ISO date, or null when there is no such day (February 30th). */
export function isoOf(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/** The label the model chose and its probability; "none" at 0 for an answer that is not a choice. */
function pick(answers: AnswerMap, id: string): { label: string; p: number } {
  const a = answers[id];
  if (!isChoice(a) || typeof a.choice !== 'string') return { label: 'none', p: 0 };
  return { label: a.choice, p: a.probabilities?.[a.choice] ?? a.confidence };
}

/**
 * A birthdate slot's fill. Not stated (SLOT_DETECT): absent. Then each of the month, the day and
 * the year counts when the model chose it at SLOT_CHOICE_CONFIRM or above; a month or a day not
 * heard this turn is taken from the pending partial. None of the three heard this turn: absent (an
 * answer none of them can read is not the partial rebuilt as progress). A month or a day still
 * missing: invalid, "no_year" (no `wholePrompt`), or "no_month_day", "no_month" or "no_day" with
 * `wholePrompt` as its re-ask. A month and day without a year: the partial (window), and the year is
 * asked for (`yearPrompt`). A year before `minYear`, or no such day: invalid, "impossible". Today or
 * later: invalid, "future" (raw is the ISO date, so the engine can tell the day was heard). Otherwise
 * filled with the ISO date, its confidence the least of the parts heard, never read back on its own.
 */
export function birthdateFill(
  o: BirthdateOptions,
  ids: BirthdateIds,
  display: (value: string, locale?: string) => string,
): (answers: AnswerMap, ctx: SlotContext) => SlotOutcome {
  const whole = o.wholePrompt;
  return (answers, ctx) => {
    const t = ctx.thresholds;
    if (!meetsThreshold(t, 'SLOT_DETECT', noulValue(answers, ids.given))) return { kind: 'absent' };
    const month = pick(answers, ids.month);
    const day = pick(answers, ids.day);
    const year = pick(answers, ids.year);
    const read = (c: { label: string; p: number }): boolean => c.label !== 'none' && meetsThreshold(t, 'SLOT_CHOICE_CONFIRM', c.p);
    const pending = birthdatePartialOf(ctx.window);
    const m = read(month) ? MONTHS.indexOf(month.label as (typeof MONTHS)[number]) + 1 : pending?.month ?? null;
    const d = read(day) ? Number(day.label) : pending?.day ?? null;
    const y = read(year) ? normalizeYear(year.label, ctx.todayIso, ctx.locale) : null;
    const used = [month, day, year].filter(read);
    if (used.length === 0) return { kind: 'absent' };
    const confidence = Math.min(...used.map((c) => c.p));
    if (m === null || d === null) {
      if (whole === undefined) return { kind: 'invalid', reason: 'no_year', raw: '' };
      const reason = m === null && d === null ? 'no_month_day' : m === null ? 'no_month' : 'no_day';
      return { kind: 'invalid', reason, raw: '', retryPromptId: whole };
    }
    if (y === null) return { kind: 'window', window: { kind: 'dob', month: m, day: d } satisfies BirthdatePartial, confidence };
    if (y < o.minYear) return { kind: 'invalid', reason: 'impossible', raw: `${y}` };
    const iso = isoOf(y, m, d);
    if (!iso) return { kind: 'invalid', reason: 'impossible', raw: `${y}-${m}-${d}` };
    if (iso >= ctx.todayIso) return { kind: 'invalid', reason: 'future', raw: iso };
    return { kind: 'filled', value: iso, display: display(iso, ctx.locale), confidence, confirm: 'none' };
  };
}

/**
 * The keypad: eight digits, month, day and year (MMDDYYYY), that make a real day in or after
 * `minYear` and before today; in a day-first locale (Spanish), day, month and year (DDMMYYYY).
 * Anything else is no value. (The engine collects exactly eight keys.)
 */
export function birthdateKeys(
  o: Pick<BirthdateOptions, 'minYear'>,
  display: (value: string, locale?: string) => string,
): (digits: string, ctx: Pick<SlotContext, 'todayIso' | 'locale'>) => SlotCandidate | null {
  return (digits, ctx) => {
    if (!/^\d{8}$/.test(digits)) return null;
    const y = Number(digits.slice(4, 8));
    if (y < o.minYear) return null;
    const [m, d] = dayFirst(ctx.locale) ? [digits.slice(2, 4), digits.slice(0, 2)] : [digits.slice(0, 2), digits.slice(2, 4)];
    const iso = isoOf(y, Number(m), Number(d));
    if (!iso || iso >= ctx.todayIso) return null;
    return { value: iso, display: display(iso, ctx.locale) };
  };
}
