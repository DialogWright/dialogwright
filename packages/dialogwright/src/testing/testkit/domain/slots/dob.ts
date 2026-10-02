import type { SlotOutcome, SlotPartial, SlotSpec } from '../../../../core/slots/types';
import { isChoice, noulValue, type AnswerMap } from '../../../../jev/types';
import { describeDob, MONTHS, normalizeYear } from '../../../../core/extract/date';
import { atLeast } from '../../../../core/thresholds';

/** The day-of-month labels, "1" .. "31". */
export const DAYS = Array.from({ length: 31 }, (_, i) => String(i + 1));
const MIN_YEAR = 1900;

/** A date of birth heard in part: the month and day, the year still to come. */
type DobPartial = { kind: 'dob'; month: number; day: number };

function dobPartial(w: SlotPartial | null): DobPartial | null {
  return w !== null && w.kind === 'dob' && typeof w.month === 'number' && typeof w.day === 'number' ? { kind: 'dob', month: w.month, day: w.day } : null;
}

function isoOf(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

function pick(answers: AnswerMap, id: string): { label: string; p: number } {
  const a = answers[id];
  return isChoice(a) ? { label: a.choice, p: a.probabilities[a.choice] ?? a.confidence } : { label: 'none', p: 0 };
}

const labelsOf = (labels: readonly string[]): Record<string, string | null> => Object.fromEntries([...labels, 'none'].map((l) => [l, null]));

/**
 * The second identity factor: a date of birth, heard whole or in part. A month and day with no year
 * is a partial, and the year is asked for on its own (ask_dob_year); a month or a day missing asks
 * for the whole date again (ask_dob_whole).
 */
export const dobSlot: SlotSpec = {
  id: 'dob',
  spokenConfirm: 'summary',
  redact: 'mask',
  handoff: 'verified',
  valueKind: 'date',
  detect: true,
  partialPromptId: 'ask_dob_year',

  questions(ctx) {
    const years: Record<string, string | null> = {};
    for (const span of ctx.candidateSpans) years[span] = null;
    years.none = "No span of asr.text is the year of the caller's birth";
    const pending = dobPartial(ctx.window);
    return {
      dobGiven: {
        type: 'noul',
        instructions: 'Read asr.text. Does the caller state their date of birth, in whole or in part (a month and day, or a year alone when asked for it)?',
        criteria: {
          true: 'The caller gives their own birth date or part of it: a full date, a month and day, or a year on its own in answer to a question about their birth year',
          false: "No birth date. A delivery date, or someone else's birth date, is not the caller's date of birth",
        },
      },
      dobMonth: {
        type: 'choice',
        instructions: "Read asr.text. Which month is the caller's date of birth in, if they say one? A date said as numbers is month first, then day, then year.",
        criteria: labelsOf(MONTHS),
      },
      dobDay: {
        type: 'choice',
        instructions: "Read asr.text. Which day of the month is the caller's date of birth, if they say one? A date said as numbers is month first, then day, then year.",
        criteria: labelsOf(DAYS),
      },
      dobYear: {
        type: 'choice',
        instructions: pending
          ? 'Read asr.text. The caller was asked for the year of their birth. Which of these spans is that year? Choose none when no year is said.'
          : "Read asr.text. Which of these spans is the year of the caller's birth, if they say one? Choose none when no year is said.",
        criteria: years,
      },
    };
  },

  fill(answers, ctx): SlotOutcome {
    const t = ctx.thresholds;
    if (!atLeast(noulValue(answers, 'dobGiven'), t.SLOT_DETECT)) return { kind: 'absent' };
    const month = pick(answers, 'dobMonth');
    const day = pick(answers, 'dobDay');
    const year = pick(answers, 'dobYear');
    const pending = dobPartial(ctx.window);
    const read = (c: { label: string; p: number }): boolean => c.label !== 'none' && atLeast(c.p, t.SLOT_CHOICE_CONFIRM);
    const m = read(month) ? MONTHS.indexOf(month.label as (typeof MONTHS)[number]) + 1 : pending?.month ?? null;
    const d = read(day) ? Number(day.label) : pending?.day ?? null;
    const y = read(year) ? normalizeYear(year.label, ctx.todayIso) : null;
    const used = [month, day, year].filter(read);
    if (used.length === 0) return { kind: 'absent' };
    const confidence = Math.min(...used.map((c) => c.p));
    if (m === null || d === null) {
      return { kind: 'invalid', reason: m === null && d === null ? 'no_month_day' : m === null ? 'no_month' : 'no_day', raw: '', retryPromptId: 'ask_dob_whole' };
    }
    if (y === null) return { kind: 'window', window: { kind: 'dob', month: m, day: d } satisfies DobPartial, confidence };
    if (y < MIN_YEAR) return { kind: 'invalid', reason: 'impossible', raw: `${y}` };
    const iso = isoOf(y, m, d);
    if (!iso) return { kind: 'invalid', reason: 'impossible', raw: `${y}-${m}-${d}` };
    if (iso >= ctx.todayIso) return { kind: 'invalid', reason: 'future', raw: iso };
    return { kind: 'filled', value: iso, display: describeDob(iso), confidence, confirm: 'none' };
  },

  dtmf: {
    length: 8,
    parse(digits, ctx) {
      const y = Number(digits.slice(4, 8));
      if (y < MIN_YEAR) return null;
      const iso = isoOf(y, Number(digits.slice(0, 2)), Number(digits.slice(2, 4)));
      return iso && iso < ctx.todayIso ? { value: iso, display: describeDob(iso) } : null;
    },
  },

  display: describeDob,
};
