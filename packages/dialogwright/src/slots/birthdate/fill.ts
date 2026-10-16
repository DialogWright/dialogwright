import { MONTHS, normalizeYear } from '../../core/extract/date';
import type { SlotCandidate, SlotContext, SlotOutcome } from '../../core/slots/types';
import type { AnswerMap } from '../../jev/types';
import { isChoice, noulValue } from '../../jev/types';
import { dayFirst } from '../parts/locale';
import { meetsThreshold } from '../parts/thresholds';
import { isDateInNumbers, isoOf, numberPiecesOf, readNumbers } from './numbers';
import type { BirthdateOptions } from './options';
import { birthdatePartialOf, type BirthdatePartial } from './partial';
import type { BirthdateIds } from './questions';

export { isoOf } from './numbers';

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
 *
 * A date said only in numbers at the slot's own question (numbers.ts: not a year alone, three digits
 * or more): with `readNumbers`, the digits decide, not the model's month and day. Read one way only,
 * and the model judges a birth date stated (SLOT_DETECT): filled with that day (or the partial, for a
 * month and a day), its confidence the yes-or-no's (the model's outcome, its confidence the least of
 * its parts, where it heard the same). Otherwise, and with `readNumbers: false` where
 * the model hears no date in it: invalid, "numbers_unclear", re-asked with `ask_<slot>_example`
 * (`numbersExample`) or the generic retry; with neither option, the model's outcome as before.
 */
export function birthdateFill(
  o: BirthdateOptions,
  ids: BirthdateIds,
  display: (value: string, locale?: string) => string,
  examplePrompt: string,
): (answers: AnswerMap, ctx: SlotContext) => SlotOutcome {
  const example = o.numbersExample ? examplePrompt : null;
  const unclear: SlotOutcome = { kind: 'invalid', reason: 'numbers_unclear', raw: '', ...(example !== null ? { retryPromptId: example } : {}) };
  const byModel = modelFill(o, ids, display);
  return (answers, ctx) => {
    const turn = ctx.prompted && (o.readNumbers || o.numbersExample) ? numberPiecesOf(ctx.text, ctx.locale) : null;
    if (turn === null || !isDateInNumbers(turn, { minYear: o.minYear, todayIso: ctx.todayIso })) return byModel(answers, ctx);
    if (!o.readNumbers) {
      const heard = byModel(answers, ctx);
      return heard.kind === 'filled' || heard.kind === 'window' ? heard : unclear;
    }
    const given = noulValue(answers, ids.given);
    const reading = readNumbers(turn, { minYear: o.minYear, todayIso: ctx.todayIso, ...(ctx.locale !== undefined ? { locale: ctx.locale } : {}) });
    if (reading === null || !meetsThreshold(ctx.thresholds, 'SLOT_DETECT', given)) return unclear;
    // Where the model heard the same day (or month and day), its outcome stands as it always has, its
    // confidence the least of the parts it heard; the digits decide only where the two differ.
    const heard = byModel(answers, ctx);
    if (reading.kind === 'monthDay') {
      const same = heard.kind === 'window' && birthdatePartialOf(heard.window)?.month === reading.month && birthdatePartialOf(heard.window)?.day === reading.day;
      return same ? heard : { kind: 'window', window: { kind: 'dob', month: reading.month, day: reading.day } satisfies BirthdatePartial, confidence: given };
    }
    if (heard.kind === 'filled' && heard.value === reading.iso) return heard;
    return { kind: 'filled', value: reading.iso, display: display(reading.iso, ctx.locale), confidence: given, confirm: 'none' };
  };
}

/** The fill from the model's four answers alone: every turn but a date said in numbers (above). */
function modelFill(
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
