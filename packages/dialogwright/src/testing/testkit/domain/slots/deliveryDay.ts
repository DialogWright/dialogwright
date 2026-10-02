import type { SlotOutcome, SlotSpec } from '../../../../core/slots/types';
import { isChoice, type AnswerMap, type QuestionMap } from '../../../../jev/types';
import { describeDay, MONTHS, resolveDate, WEEKDAYS, type ComponentPick } from '../../../../core/extract/date';
import { atLeast } from '../../../../core/thresholds';
import { DAYS } from './dob';

/** How the caller names a day ahead: today, tomorrow or the day after; a weekday; a month and day. */
export const AHEAD_MODES = ['relative_day', 'weekday', 'absolute', 'none'] as const;
export const AHEAD_RELATIVE = ['today', 'tomorrow', 'day_after_tomorrow', 'none'] as const;

const CONTEXT = 'Read asr.text. The caller is saying which day they want a delivery on.';

const labelsOf = (labels: readonly string[]): Record<string, string | null> => Object.fromEntries(labels.map((l) => [l, null]));
const NONE: ComponentPick = { choice: 'none', p: 1 };

function pick(answers: AnswerMap, id: string): ComponentPick {
  const a = answers[id];
  return isChoice(a) ? { choice: a.choice, p: a.probabilities[a.choice] ?? a.confidence } : { choice: 'none', p: 0 };
}

/** A day today or later, for booking a delivery window. */
export const deliveryDaySlot: SlotSpec = {
  id: 'deliveryDay',
  spokenConfirm: 'summary',
  valueKind: 'date',

  questions(): QuestionMap {
    return {
      deliveryDayMode: {
        type: 'choice',
        instructions: `${CONTEXT} How do they refer to the day? "relative_day" is today, tomorrow, or the day after tomorrow. "weekday" names a day of the week. "absolute" names a month and a day of the month. "none" if no day is mentioned.`,
        criteria: labelsOf(AHEAD_MODES),
      },
      deliveryDayRelative: {
        type: 'choice',
        instructions: `${CONTEXT} Do they say today, tomorrow, or the day after tomorrow?`,
        criteria: labelsOf(AHEAD_RELATIVE),
      },
      deliveryDayWeekday: {
        type: 'choice',
        instructions: `${CONTEXT} Which day of the week do they name, if any?`,
        criteria: labelsOf([...WEEKDAYS, 'none']),
      },
      deliveryDayMonth: {
        type: 'choice',
        instructions: `${CONTEXT} Which month do they name, if any?`,
        criteria: labelsOf([...MONTHS, 'none']),
      },
      deliveryDayDay: {
        type: 'choice',
        instructions: `${CONTEXT} Which day of the month do they name, if any?`,
        criteria: labelsOf([...DAYS, 'none']),
      },
    };
  },

  fill(answers, ctx): SlotOutcome {
    const t = ctx.thresholds;
    const miss: SlotOutcome = ctx.prompted ? { kind: 'invalid', reason: 'unresolvable', raw: '' } : { kind: 'absent' };
    const mode = pick(answers, 'deliveryDayMode');
    if (mode.choice === 'none' || !atLeast(mode.p, t.SLOT_CHOICE_CONFIRM)) return miss;
    const resolved = resolveDate({
      mode, relativeDay: pick(answers, 'deliveryDayRelative'), weekday: pick(answers, 'deliveryDayWeekday'),
      month: pick(answers, 'deliveryDayMonth'), day: pick(answers, 'deliveryDayDay'), weekdayQualifier: NONE, window: NONE,
    }, ctx.todayIso);
    if (resolved.kind !== 'day' || !atLeast(resolved.confidence, t.SLOT_CHOICE_FILL)) return miss;
    return { kind: 'filled', value: resolved.iso, display: describeDay(resolved.iso), confidence: resolved.confidence, confirm: 'none' };
  },

  dtmf: {
    length: 4,
    parse(digits, ctx) {
      const month = Number(digits.slice(0, 2));
      const day = Number(digits.slice(2, 4));
      if (month < 1 || month > 12) return null;
      const one = (choice: string): ComponentPick => ({ choice, p: 1 });
      const r = resolveDate({ mode: one('absolute'), month: one(MONTHS[month - 1]!), day: one(String(day)), relativeDay: NONE, weekday: NONE, weekdayQualifier: NONE, window: NONE }, ctx.todayIso);
      return r.kind === 'day' ? { value: r.iso, display: describeDay(r.iso) } : null;
    },
  },

  display: describeDay,
};
