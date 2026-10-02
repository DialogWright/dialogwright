// ORACLE: a frozen copy of the hand-written slot the library `birthdate` type replaced.
// Used only by the grid tests (src/shadow.test.ts and the slot tests beside it) to catch drift in
// the library. Never edit except to delete. Nothing in app runtime may import this file (src/oracles.test.ts).
import {
  describeDob, isChoice, MONTHS, normalizeYear, noulValue, type AnswerMap, type SlotOutcome, type SlotPartial,
  type SlotSpec,
} from 'dialogwright';

/** The day-of-month choice labels: "1" .. "31", exactly as dobDay offers them. */
const DOB_DAYS = Array.from({ length: 31 }, (_, i) => String(i + 1));
const MIN_YEAR = 1900;

/** A month and day heard without the year (SlotPartial kind 'dob'), which ask_dob_year asks for. */
interface DobPartial extends SlotPartial {
  kind: 'dob';
  month: number;
  day: number;
}

function dobPartialOf(w: SlotPartial | null): DobPartial | null {
  return w?.kind === 'dob' && typeof w.month === 'number' && typeof w.day === 'number' ? (w as DobPartial) : null;
}

function isoOf(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

function pickLabel(answers: AnswerMap, id: string): { label: string; p: number } {
  const a = answers[id];
  if (!isChoice(a)) return { label: 'none', p: 0 };
  return { label: a.choice, p: a.probabilities[a.choice] ?? a.confidence };
}

function criteriaOf(labels: readonly string[]): Record<string, string | null> {
  return Object.fromEntries([...labels, 'none'].map((l) => [l, null]));
}

/**
 * The caller's date of birth: month, day and year read separately, so a month and day alone narrow
 * to the year (ask_dob_year). Masked wherever it leaves the turn (trace, console, audit); the
 * keypad takes MMDDYYYY. A birthday is a date, so one said at the birthday question is never also
 * taken as the appointment day.
 */
export const dobSlot: SlotSpec = {
  id: 'dob',
  spokenConfirm: 'summary',
  redact: 'mask',
  valueKind: 'date',
  detect: true,
  partialPromptId: 'ask_dob_year',
  questions(ctx) {
    const years: Record<string, string | null> = {};
    for (const span of ctx.candidateSpans) years[span] = null;
    years.none = "No span of asr.text is a year of the caller's birth";
    // With a month and day pending, the caller was just asked for the year alone, but may restate
    // the whole date: all four questions stay asked, only the year's instructions say what was asked.
    const pending = dobPartialOf(ctx.window);
    const dobYearInstructions = pending
      ? 'Read asr.text. The caller was asked for the year of their birth. Which of these spans is that year, as in "nineteen seventy four", "seventy four", or "two thousand one"? Choose none when no year is said.'
      : 'Read asr.text. Which of these spans is the year of the caller\'s birth, if they say one, as in "nineteen seventy four", "seventy four", or "two thousand one"? Choose none when no year is said.';
    return {
      dobGiven: {
        type: 'noul',
        instructions: 'Read asr.text. Does the caller state their date of birth or birthday, in whole or in part (a month and day, or a year alone when asked for it)?',
        criteria: {
          true: 'The caller gives their own birth date or part of it: a full date, a month and day, or a year on its own in answer to a question about their birth year',
          false: "No birth date. An appointment date, a date they want to be seen on, or someone else's birth date is not the caller's date of birth",
        },
      },
      dobMonth: {
        type: 'choice',
        instructions: "Read asr.text. Which month is the caller's date of birth in, if they say one? This is the birth date, not an appointment date. A month may be said as a number rather than a name; answer with the month that number means, as in seven two sixty five, which is July 2nd, 1965.",
        criteria: criteriaOf(MONTHS),
      },
      dobDay: {
        type: 'choice',
        instructions: "Read asr.text. Which day of the month is the caller's date of birth, if they say one? This is the birth date, not an appointment date.",
        criteria: criteriaOf(DOB_DAYS),
      },
      dobYear: {
        type: 'choice',
        instructions: dobYearInstructions,
        criteria: years,
      },
    };
  },
  fill(answers, ctx): SlotOutcome {
    const t = ctx.thresholds;
    if (noulValue(answers, 'dobGiven') < t.SLOT_DETECT) return { kind: 'absent' };
    const month = pickLabel(answers, 'dobMonth');
    const day = pickLabel(answers, 'dobDay');
    const year = pickLabel(answers, 'dobYear');
    const pending = dobPartialOf(ctx.window);
    const m = month.label !== 'none' && month.p >= t.SLOT_CHOICE_CONFIRM
      ? MONTHS.indexOf(month.label as (typeof MONTHS)[number]) + 1
      : pending?.month ?? null;
    const d = day.label !== 'none' && day.p >= t.SLOT_CHOICE_CONFIRM ? Number(day.label) : pending?.day ?? null;
    const y = year.label !== 'none' && year.p >= t.SLOT_CHOICE_CONFIRM ? normalizeYear(year.label, ctx.todayIso) : null;
    // Only the parts this turn read count. An answer none of them can read ("uh, let me think") is
    // absent, not the pending partial rebuilt as fresh progress, which would hold the ladder at zero.
    const used = [month, day, year].filter((c) => c.label !== 'none' && c.p >= t.SLOT_CHOICE_CONFIRM);
    if (used.length === 0) return { kind: 'absent' };
    const confidence = Math.min(...used.map((c) => c.p));
    if (m === null || d === null) return { kind: 'invalid', reason: 'no_year', raw: '' };
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
      const m = Number(digits.slice(0, 2));
      const d = Number(digits.slice(2, 4));
      const y = Number(digits.slice(4, 8));
      if (y < MIN_YEAR) return null;
      const iso = isoOf(y, m, d);
      if (!iso || iso >= ctx.todayIso) return null;
      return { value: iso, display: describeDob(iso) };
    },
  },
  display: describeDob,
};
