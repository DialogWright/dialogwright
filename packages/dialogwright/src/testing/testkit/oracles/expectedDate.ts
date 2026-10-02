// ORACLE: a frozen copy of the hand-written slot the library `date` type replaced.
// Used only by the grid tests (src/slots/date/date.test.ts) to catch drift in the library.
// Never edit except to delete. Nothing in app runtime may import this file (oracles.test.ts).
import type { SlotOutcome, SlotSpec } from '../../../core/slots/types';
import { isChoice, type AnswerMap, type QuestionMap } from '../../../jev/types';
import { describeDay, MONTHS, WEEKDAYS, type ComponentPick } from '../../../core/extract/date';
import { PAST_MODES, PAST_RELATIVE, resolvePastDate, type PastDateComponents } from '../../../core/extract/pastDate';
import { atLeast } from '../../../core/thresholds';
import { DAYS } from '../domain/slots/shared';

const CONTEXT = 'Read asr.text. The caller is saying which day a parcel was due to arrive.';
const NOT_BIRTHDAY = "The caller's date of birth is not the day the parcel was due.";

const labelsOf = (labels: readonly string[]): Record<string, string | null> => Object.fromEntries(labels.map((l) => [l, null]));

function pick(answers: AnswerMap, id: string): ComponentPick {
  const a = answers[id];
  return isChoice(a) ? { choice: a.choice, p: a.probabilities[a.choice] ?? a.confidence } : { choice: 'none', p: 0 };
}

function componentsOf(answers: AnswerMap): PastDateComponents {
  return {
    mode: pick(answers, 'expectedDateMode'),
    relativeDay: pick(answers, 'expectedDateRelative'),
    weekday: pick(answers, 'expectedDateWeekday'),
    month: pick(answers, 'expectedDateMonth'),
    day: pick(answers, 'expectedDateDay'),
  };
}

/** The day a missing parcel was due: today or earlier, never a day to come. */
export const expectedDateSlot: SlotSpec = {
  id: 'expectedDate',
  spokenConfirm: 'summary',
  valueKind: 'date',

  questions(): QuestionMap {
    return {
      expectedDateMode: {
        type: 'choice',
        instructions: `${CONTEXT} How do they refer to the day? "relative_day" is today, yesterday, or the day before yesterday. "weekday" names a day of the week. "absolute" names a day of the month, with or without its month. "none" if no day is mentioned. ${NOT_BIRTHDAY}`,
        criteria: labelsOf(PAST_MODES),
      },
      expectedDateRelative: {
        type: 'choice',
        instructions: `${CONTEXT} Do they say today, yesterday, or the day before yesterday?`,
        criteria: labelsOf(PAST_RELATIVE),
      },
      expectedDateWeekday: {
        type: 'choice',
        instructions: `${CONTEXT} Which day of the week do they name, if any?`,
        criteria: labelsOf([...WEEKDAYS, 'none']),
      },
      expectedDateMonth: {
        type: 'choice',
        instructions: `${CONTEXT} Which month do they name, if any? ${NOT_BIRTHDAY}`,
        criteria: labelsOf([...MONTHS, 'none']),
      },
      expectedDateDay: {
        type: 'choice',
        instructions: `${CONTEXT} Which day of the month do they name, if any? ${NOT_BIRTHDAY}`,
        criteria: labelsOf([...DAYS, 'none']),
      },
    };
  },

  fill(answers, ctx): SlotOutcome {
    const t = ctx.thresholds;
    const miss: SlotOutcome = ctx.prompted ? { kind: 'invalid', reason: 'unresolvable', raw: '' } : { kind: 'absent' };
    const c = componentsOf(answers);
    if (c.mode.choice === 'none' || !atLeast(c.mode.p, t.SLOT_CHOICE_CONFIRM)) return miss;
    const resolved = resolvePastDate(c, ctx.todayIso);
    if (resolved.kind === 'none' || !atLeast(resolved.confidence, t.SLOT_CHOICE_FILL)) return miss;
    return { kind: 'filled', value: resolved.iso, display: describeDay(resolved.iso), confidence: resolved.confidence, confirm: 'none' };
  },

  dtmf: {
    length: 4,
    parse(digits, ctx) {
      const month = Number(digits.slice(0, 2));
      const day = Number(digits.slice(2, 4));
      if (month < 1 || month > 12 || day < 1 || day > 31) return null;
      const one = (choice: string): ComponentPick => ({ choice, p: 1 });
      const none = one('none');
      const r = resolvePastDate({ mode: one('absolute'), month: one(MONTHS[month - 1]!), day: one(String(day)), relativeDay: none, weekday: none }, ctx.todayIso);
      return r.kind === 'day' ? { value: r.iso, display: describeDay(r.iso) } : null;
    },
  },

  display: describeDay,
};
