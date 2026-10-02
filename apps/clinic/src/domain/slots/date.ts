import {
  DATE_MODES, describeDay, describeWindow, isChoice, MONTHS, QUALIFIERS, RELATIVE_DAYS, resolveDate,
  snapWeekdayOnOrAfter, WEEKDAYS, WINDOWS, type AnswerMap, type ComponentPick, type DateComponents,
  type DateWindow, type QuestionMap, type SlotOutcome, type SlotPartial, type SlotSpec,
} from 'dialogwright';

const DAYS = Array.from({ length: 31 }, (_, i) => String(i + 1));

/**
 * A span of days heard without the day itself ("next week"), as the date slot's partial (SlotPartial
 * kind 'window'), which date_narrow_window asks to narrow. Its parts are strings, so the engine never
 * reads it as a day heard (only numeric month and day parts are).
 */
export interface WindowPartial extends SlotPartial {
  kind: 'window';
  start: string;
  end: string;
  label: string;
}

export function windowPartialOf(w: SlotPartial | null): DateWindow | null {
  return w?.kind === 'window' && typeof w.start === 'string' && typeof w.end === 'string' && typeof w.label === 'string'
    ? { start: w.start, end: w.end, label: w.label }
    : null;
}

/**
 * A bare weekday answered while a window is pending narrows that window: "Wednesday" after
 * "sometime in December" is the first Wednesday in December, not this week's. Absolute and relative
 * days are taken as spoken, since they name a day outright. The search starts at today when the
 * window already began, so it never yields a past day. Null when the weekday has no occurrence left
 * inside the window.
 */
export function constrainToWindow(iso: string, mode: string, window: DateWindow | null, todayIso: string): string | null {
  if (!window || mode !== 'weekday') return iso;
  if (iso >= window.start && iso <= window.end) return iso;
  const snapped = snapWeekdayOnOrAfter(iso, window.start > todayIso ? window.start : todayIso);
  return snapped <= window.end ? snapped : null;
}

function criteriaOf(labels: readonly string[]): Record<string, string | null> {
  return Object.fromEntries(labels.map((l) => [l, null]));
}

function pick(answers: AnswerMap, id: string): ComponentPick {
  const a = answers[id];
  if (!isChoice(a)) return { choice: 'none', p: 0 };
  return { choice: a.choice, p: a.probabilities[a.choice] ?? a.confidence };
}

export function dateComponentsFrom(answers: AnswerMap): DateComponents {
  return {
    mode: pick(answers, 'dateMode'),
    month: pick(answers, 'dateMonth'),
    day: pick(answers, 'dateDay'),
    weekday: pick(answers, 'dateWeekday'),
    weekdayQualifier: pick(answers, 'dateWeekdayQualifier'),
    relativeDay: pick(answers, 'dateRelativeDay'),
    window: pick(answers, 'dateWindow'),
  };
}

/**
 * The appointment day: read as parts (a mode, then a month and day, a weekday and its this or next,
 * a relative day, or a span of days), resolved against today. A span asks which day in it
 * (date_narrow_window, "{window}. Which day works for you?"); a weekday then narrows inside it. The
 * keypad takes MMDD.
 */
export const dateSlot: SlotSpec = {
  id: 'date',
  spokenConfirm: 'by-confidence',
  valueKind: 'date',
  partialPromptId: 'date_narrow_window',
  partialVars: (w) => {
    const window = windowPartialOf(w);
    return { window: window ? describeWindow(window) : '' };
  },

  questions(): QuestionMap {
    return {
      dateMode: {
        type: 'choice',
        instructions: 'Read asr.text. How does the caller refer to a day for the appointment? "absolute" names a month or a month and day. "relative_day" is today, tomorrow, or the day after tomorrow. "weekday" names a day of the week. "window" is a span like this week or next month. "none" if no day is mentioned. The caller\'s date of birth or birthday, or a date answering a question about it, is not an appointment date. One utterance can carry both: a birthday and, separately, the day they want to come in. The appointment day is the one not introduced by born or birthday, so a weekday or a relative day said alongside a birthday is still the appointment day and still names the mode.',
        criteria: {
          ...criteriaOf(DATE_MODES),
          none: "No day for the appointment. The caller's date of birth or birthday, or a date answering a question about it, is not one",
        },
      },
      dateMonth: {
        type: 'choice',
        instructions: 'Read asr.text. Which month does the caller name, if any? The caller\'s date of birth or birthday, or a date answering a question about it, is not an appointment date. If the only month and day in asr.text belong to the caller\'s birthday, answer none. When they correct a month, the word not marks the month they are rejecting; choose the other one, as in "not March, April" or "October, not September". A hedge such as "I\'m not sure" or "either" is not a correction; name the month they mention.',
        criteria: criteriaOf([...MONTHS, 'none']),
      },
      dateDay: {
        type: 'choice',
        instructions: 'Read asr.text. Which day of the month does the caller name, if any? The caller\'s date of birth or birthday, or a date answering a question about it, is not an appointment date. If the only month and day in asr.text belong to the caller\'s birthday, answer none. When they correct a day of the month, the word not marks the one they are rejecting; choose the other one, as in "not the 5th, the 6th" or "the 20th, not the 12th". A hedge such as "I\'m not sure" or "either" is not a correction; name the day of the month they mention.',
        criteria: criteriaOf([...DAYS, 'none']),
      },
      dateWeekday: {
        type: 'choice',
        instructions: 'Read asr.text. Which day of the week does the caller name, if any? When they correct a day, the word not marks the day they are rejecting; choose the other one, as in "not Monday, Friday" or "Saturday, not Sunday". A hedge such as "I\'m not sure" or "either" is not a correction; name the day they mention.',
        criteria: criteriaOf([...WEEKDAYS, 'none']),
      },
      dateWeekdayQualifier: {
        type: 'choice',
        instructions: 'Read asr.text. If the caller names a day of the week, do they say "this" or "next" before it? When they correct this qualifier, the word not marks the one they are rejecting; choose the other one, as in "not this Thursday, next Thursday". A hedge such as "I\'m not sure" or "either" is not a correction; name the qualifier they mention.',
        criteria: criteriaOf(QUALIFIERS),
      },
      dateRelativeDay: {
        type: 'choice',
        instructions: 'Read asr.text. Does the caller say today, tomorrow, or the day after tomorrow? When they correct a relative day, the word not marks the one they are rejecting; choose the other one, as in "not today, the day after tomorrow". A hedge such as "I\'m not sure" or "either" is not a correction; name the relative day they mention.',
        criteria: criteriaOf(RELATIVE_DAYS),
      },
      dateWindow: {
        type: 'choice',
        instructions: 'Read asr.text. Does the caller name a span of days such as this week, next week, this month, or next month? When they correct the span, the word not marks the one they are rejecting; choose the other one, as in "not next week, this week". A hedge such as "I\'m not sure" or "either" is not a correction; name the span they mention.',
        criteria: criteriaOf(WINDOWS),
      },
    };
  },

  fill(answers, ctx): SlotOutcome {
    const t = ctx.thresholds;
    const components = dateComponentsFrom(answers);
    if (components.mode.choice === 'none' || components.mode.p < t.SLOT_CHOICE_CONFIRM) return { kind: 'absent' };
    // "Monday, September 28" names one day twice. The model splits its mode between the weekday and
    // the absolute reading, and a coin-flip win for the weekday would land on the next Monday rather
    // than the date the caller said, so a confident month and day take the mode.
    const named = (c: ComponentPick): boolean => c.choice !== 'none' && c.p >= t.SLOT_CHOICE_CONFIRM;
    if (components.mode.choice === 'weekday' && named(components.month) && named(components.day)) {
      components.mode = { choice: 'absolute', p: components.mode.p };
    }
    const resolved = resolveDate(components, ctx.todayIso);
    switch (resolved.kind) {
      case 'none':
        return { kind: 'invalid', reason: 'unresolvable', raw: components.mode.choice };
      case 'window':
        return {
          kind: 'window',
          window: { kind: 'window', start: resolved.start, end: resolved.end, label: resolved.label } satisfies WindowPartial,
          confidence: resolved.confidence,
        };
      case 'day': {
        if (resolved.confidence < t.SLOT_CHOICE_CONFIRM) return { kind: 'invalid', reason: 'low_confidence', raw: resolved.iso };
        const iso = constrainToWindow(resolved.iso, components.mode.choice, windowPartialOf(ctx.window), ctx.todayIso);
        if (iso === null) return { kind: 'invalid', reason: 'outside_window', raw: resolved.iso };
        return {
          kind: 'filled',
          value: iso,
          display: describeDay(iso),
          confidence: resolved.confidence,
          confirm: resolved.confidence >= t.SLOT_CHOICE_FILL ? 'none' : 'implicit',
        };
      }
    }
  },

  dtmf: {
    length: 4,
    parse(digits, ctx) {
      const month = Number(digits.slice(0, 2));
      const day = Number(digits.slice(2, 4));
      if (month < 1 || month > 12 || day < 1 || day > 31) return null;
      const one: ComponentPick = { choice: '', p: 1 };
      const resolved = resolveDate(
        {
          mode: { choice: 'absolute', p: 1 },
          month: { choice: MONTHS[month - 1]!, p: 1 },
          day: { choice: String(day), p: 1 },
          weekday: one, weekdayQualifier: one, relativeDay: one, window: one,
        },
        ctx.todayIso,
      );
      if (resolved.kind !== 'day') return null;
      return { value: resolved.iso, display: describeDay(resolved.iso) };
    },
  },

  display: describeDay,
};
