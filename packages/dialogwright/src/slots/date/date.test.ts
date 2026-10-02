import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { MONTHS, WEEKDAYS } from '../../core/extract/date';
import type { SlotPartial, SlotSpec } from '../../core/slots/types';
import { DEFAULT_THRESHOLDS } from '../../core/thresholds';
import type { AnswerMap, ChoiceAnswer } from '../../jev/types';
import { formatProblem } from '../../define/problems';
import { choice } from '../../testing/answers';
import { createShadowReport, shadowSlot } from '../../testing/shadowSlot';
import { testSlotContext } from '../../testing/slots';
import { deliveryDaySlot as testkitDeliveryDay } from '../../testing/testkit/oracles/deliveryDay';
import { deliveryDayDateSlot } from '../../testing/testkit/domain/slots/deliveryDayDate';
import { expectedDateSlot as testkitExpectedDate } from '../../testing/testkit/oracles/expectedDate';
import { expectedDateDateSlot } from '../../testing/testkit/domain/slots/expectedDateDate';
import { runSlotConformance } from '../conformance/run';
import { buildSlot, defineSlot, slotTypeJsonSchema } from '../defineSlot';
import { DATE_DAYS, dateType } from './index';

/** The `date` type: the conformance kit over its examples, then what the kit does not cover. */
runSlotConformance(dateType, { describe, it, locales: ['en-US', 'es'] });

const T = DEFAULT_THRESHOLDS;
/** The model chose `label` with probability `p` (however low), or none. */
const chose = (label: string, p: number): ChoiceAnswer =>
  label === 'none' ? choice({ none: 1 }) : { type: 'choice', choice: label, probabilities: { [label]: p, none: 1 - p }, confidence: p };
const labels = (ls: readonly string[]) => Object.fromEntries(ls.map((l) => [l, null]));
// The tests' today, 2026-09-18, is a Friday.
const ctx = testSlotContext('');
const asked = testSlotContext('', { prompted: true });

const ahead = defineSlot('visit', { type: 'date', range: 'future' });

describe('the threshold a date slot names (SlotSpec.thresholds)', () => {
  it('is the one its fillAt selects', () => {
    expect(ahead.thresholds).toEqual(['SLOT_CHOICE_FILL']);
    expect(defineSlot('visit', { type: 'date', range: 'future', fillAt: 'confirm' }).thresholds).toEqual(['SLOT_CHOICE_CONFIRM']);
  });
});

const back = defineSlot('seen', { type: 'date', range: 'past' });
const booking = defineSlot('booking', {
  type: 'date', range: 'future', windows: true, qualifier: true, fillAt: 'confirm', whenUnsaid: 'absent', whenUnresolved: 'invalid', confirm: 'by-confidence', readBack: 'below-fill', keypad: true,
});

describe('a date slot built from the defaults', () => {
  it('ahead: asks the mode, the relative day, the weekday, the month and the day, in the default words', () => {
    expect(ahead.questionIds).toEqual(['visitMode', 'visitRelative', 'visitWeekday', 'visitMonth', 'visitDay']);
    const q = ahead.questions(ctx);
    expect(Object.keys(q)).toEqual(['visitMode', 'visitRelative', 'visitWeekday', 'visitMonth', 'visitDay']);
    const c = 'Read asr.text. The caller is saying the day they want.';
    expect(q.visitMode).toEqual({
      type: 'choice',
      instructions: `${c} How do they refer to the day? "relative_day" is today, tomorrow, or the day after tomorrow. "weekday" names a day of the week. "absolute" names a month and a day of the month. "none" if no day is mentioned.`,
      criteria: labels(['relative_day', 'weekday', 'absolute', 'none']),
    });
    expect(q.visitRelative).toEqual({ type: 'choice', instructions: `${c} Do they say today, tomorrow, or the day after tomorrow?`, criteria: labels(['today', 'tomorrow', 'day_after_tomorrow', 'none']) });
    expect(q.visitWeekday).toEqual({ type: 'choice', instructions: `${c} Which day of the week do they name, if any?`, criteria: labels([...WEEKDAYS, 'none']) });
    expect(q.visitMonth).toEqual({ type: 'choice', instructions: `${c} Which month do they name, if any?`, criteria: labels([...MONTHS, 'none']) });
    expect(q.visitDay).toEqual({ type: 'choice', instructions: `${c} Which day of the month do they name, if any?`, criteria: labels([...DATE_DAYS, 'none']) });
    expect(Object.keys((q.visitDay as { criteria: object }).criteria)).toHaveLength(32);
  });

  it('back: the same questions, with the past\'s relative days and the past\'s words for the modes', () => {
    const q = back.questions(ctx);
    const c = 'Read asr.text. The caller is saying the day something happened.';
    expect(Object.keys(q)).toEqual(['seenMode', 'seenRelative', 'seenWeekday', 'seenMonth', 'seenDay']);
    expect(q.seenMode).toMatchObject({
      instructions: `${c} How do they refer to the day? "relative_day" is today, yesterday, or the day before yesterday. "weekday" names a day of the week. "absolute" names a day of the month, with or without its month. "none" if no day is mentioned.`,
    });
    expect(q.seenRelative).toEqual({ type: 'choice', instructions: `${c} Do they say today, yesterday, or the day before yesterday?`, criteria: labels(['today', 'yesterday', 'day_before_yesterday', 'none']) });
  });

  it('with windows and qualifier: seven questions, the span and the qualifier among them, a span among the modes', () => {
    expect(booking.questionIds).toEqual(['bookingMode', 'bookingMonth', 'bookingDay', 'bookingWeekday', 'bookingQualifier', 'bookingRelative', 'bookingWindow']);
    const q = booking.questions(ctx);
    expect(Object.keys(q)).toEqual(booking.questionIds);
    const c = 'Read asr.text. The caller is saying the day they want.';
    expect(q.bookingMode).toEqual({
      type: 'choice',
      instructions: `${c} How do they refer to the day? "relative_day" is today, tomorrow, or the day after tomorrow. "weekday" names a day of the week. "absolute" names a month, or a month and a day of the month. "window" is a span of days such as this week or next month. "none" if no day is mentioned.`,
      criteria: labels(['absolute', 'relative_day', 'weekday', 'window', 'none']),
    });
    expect(q.bookingQualifier).toEqual({ type: 'choice', instructions: `${c} If they name a day of the week, do they say "this" or "next" before it?`, criteria: labels(['this', 'next', 'none']) });
    expect(q.bookingWindow).toEqual({ type: 'choice', instructions: `${c} Do they name a span of days such as this week, next week, this month, or next month?`, criteria: labels(['this_week', 'next_week', 'this_month', 'next_month', 'none']) });
    // the same on every turn, a span pending or not
    expect(booking.questions(testSlotContext('', { window: { kind: 'window', start: '2026-09-21', end: '2026-09-27', label: 'next_week' } }))).toEqual(q);
  });

  it('is a date, summarized, with no keypad, no partial and no lines beyond its ask and retry', () => {
    expect(ahead).toMatchObject({ spokenConfirm: 'summary', valueKind: 'date' });
    for (const field of ['redact', 'handoff', 'detect', 'partialPromptId', 'partialVars', 'dtmf'] as const) expect(ahead[field], field).toBeUndefined();
    expect(ahead.prompts).toEqual([]);
  });

  it('carries its type and its parsed options, defaults applied', () => {
    expect(ahead.type).toBe('date');
    expect(ahead.config).toEqual({
      range: 'future', windows: false, qualifier: false, preferMonthDay: true, fillAt: 'fill', whenUnsaid: 'invalid-if-prompted', whenUnresolved: 'invalid-if-prompted',
      keypad: false, confirm: 'summary', readBack: 'implicit',
    });
    expect(Object.isFrozen(ahead.config)).toBe(true);
  });

  it('declares the narrow line with {window}, the ack with the day, and the keypad line', () => {
    expect(booking).toMatchObject({ spokenConfirm: 'by-confidence', partialPromptId: 'ask_booking_narrow' });
    expect(booking.prompts).toEqual([
      { id: 'ask_booking_narrow', why: 'the caller named a span of days without the day (the partialPromptId), said as {window}', vars: ['window'] },
      { id: 'ack_booking', why: 'it acknowledges a day it is less sure of', vars: ['booking'] },
      { id: 'ask_booking_dtmf', why: 'it asks for the day on the keypad, as four digits (month then day; in Spanish day then month), after spoken answers missed' },
    ]);
    expect(booking.dtmf?.length).toBe(4);
    expect(defineSlot('booking', { ...booking.config, type: 'date', narrowPrompt: 'which_day' }).partialPromptId).toBe('which_day');
  });

  it('says a pending span as the narrow line\'s {window}: a week by its words, a month by its name', () => {
    expect(booking.partialVars!({ kind: 'window', start: '2026-09-21', end: '2026-09-27', label: 'next_week' })).toEqual({ window: 'next week' });
    expect(booking.partialVars!({ kind: 'window', start: '2026-12-01', end: '2026-12-31', label: 'december' })).toEqual({ window: 'in December' });
    expect(booking.partialVars!({ kind: 'dob', month: 6, day: 14 })).toEqual({ window: '' });
  });
});

describe('fill', () => {
  const visit = (picks: Record<string, [string, number]>): AnswerMap => Object.fromEntries(Object.entries(picks).map(([part, [label, p]]) => [`visit${part}`, chose(label, p)]));

  it('fills a day ahead with the ISO day, said as a weekday and a date, never acknowledged under summary', () => {
    expect(ahead.fill(visit({ Mode: ['relative_day', 0.9], Relative: ['tomorrow', 0.92] }), ctx)).toEqual({
      kind: 'filled', value: '2026-09-19', display: 'Saturday, September 19', confidence: 0.9, confirm: 'none',
    });
    expect(ahead.fill(visit({ Mode: ['weekday', 0.9], Weekday: ['friday', 0.9] }), ctx)).toMatchObject({ value: '2026-09-25' });
    expect(ahead.fill(visit({ Mode: ['absolute', 0.9], Month: ['august', 0.9], Day: ['1', 0.9] }), ctx)).toMatchObject({ value: '2027-08-01' });
  });

  it('fills a day back: yesterday, the last such weekday (a week back for today\'s own), the last such day of the month', () => {
    const seen = (picks: Record<string, [string, number]>): AnswerMap => Object.fromEntries(Object.entries(picks).map(([part, [label, p]]) => [`seen${part}`, chose(label, p)]));
    expect(back.fill(seen({ Mode: ['relative_day', 0.9], Relative: ['yesterday', 0.9] }), ctx)).toMatchObject({ kind: 'filled', value: '2026-09-17' });
    expect(back.fill(seen({ Mode: ['weekday', 0.9], Weekday: ['friday', 0.9] }), ctx)).toMatchObject({ value: '2026-09-11' });
    expect(back.fill(seen({ Mode: ['absolute', 0.9], Day: ['25', 0.9] }), ctx)).toMatchObject({ value: '2026-08-25' });
    expect(back.fill(seen({ Mode: ['absolute', 0.9], Month: ['october', 0.9], Day: ['3', 0.9] }), ctx)).toMatchObject({ value: '2025-10-03' });
  });

  it('takes a confident month and day over a weekday reading of the mode, unless preferMonthDay is off', () => {
    const answers = visit({ Mode: ['weekday', 0.6], Weekday: ['monday', 0.9], Month: ['september', 0.9], Day: ['28', 0.9] });
    expect(ahead.fill(answers, ctx)).toMatchObject({ value: '2026-09-28' });
    expect(ahead.fill({ ...answers, visitDay: chose('28', T.SLOT_CHOICE_CONFIRM - 0.01) }, ctx)).toMatchObject({ value: '2026-09-21' });
    const plain = defineSlot('visit', { type: 'date', range: 'future', preferMonthDay: false });
    expect(plain.fill(answers, ctx)).toMatchObject({ value: '2026-09-21' });
  });

  it('whenUnsaid: no day named is invalid when asked and absent otherwise, or always absent', () => {
    const none = visit({ Mode: ['none', 1] });
    expect(ahead.fill(none, ctx)).toEqual({ kind: 'absent' });
    expect(ahead.fill(none, asked)).toEqual({ kind: 'invalid', reason: 'unresolvable', raw: '' });
    expect(ahead.fill(visit({ Mode: ['weekday', T.SLOT_CHOICE_CONFIRM - 0.01], Weekday: ['friday', 0.9] }), asked)).toEqual({ kind: 'invalid', reason: 'unresolvable', raw: '' });
    expect(defineSlot('visit', { type: 'date', range: 'future', whenUnsaid: 'absent' }).fill(none, asked)).toEqual({ kind: 'absent' });
  });

  it('reads the mode question not answered at all as a turn that named no day (whenUnsaid)', () => {
    expect(ahead.fill({}, ctx)).toEqual({ kind: 'absent' });
    expect(ahead.fill({}, asked)).toEqual({ kind: 'invalid', reason: 'unresolvable', raw: '' });
    expect(booking.fill({}, asked)).toEqual({ kind: 'absent' });
  });

  it('whenUnresolved: a day that does not resolve is invalid when asked and absent otherwise, or always invalid with the mode as raw', () => {
    const feb30 = visit({ Mode: ['absolute', 0.9], Month: ['february', 0.9], Day: ['30', 0.9] });
    expect(ahead.fill(feb30, ctx)).toEqual({ kind: 'absent' });
    expect(ahead.fill(feb30, asked)).toEqual({ kind: 'invalid', reason: 'unresolvable', raw: '' });
    const always = defineSlot('visit', { type: 'date', range: 'future', whenUnresolved: 'invalid' });
    expect(always.fill(feb30, ctx)).toEqual({ kind: 'invalid', reason: 'unresolvable', raw: 'absolute' });
    // a month without a day is a span, which a slot without windows does not resolve
    expect(always.fill(visit({ Mode: ['absolute', 0.9], Month: ['october', 0.9] }), ctx)).toEqual({ kind: 'invalid', reason: 'unresolvable', raw: 'absolute' });
    // the raw is the mode as read, after a month and day win over a weekday
    expect(always.fill(visit({ Mode: ['weekday', 0.9], Month: ['february', 0.9], Day: ['30', 0.9] }), ctx)).toEqual({ kind: 'invalid', reason: 'unresolvable', raw: 'absolute' });
  });

  it('fillAt fill: a day below SLOT_CHOICE_FILL is not resolved', () => {
    const weak = visit({ Mode: ['relative_day', 0.9], Relative: ['tomorrow', T.SLOT_CHOICE_FILL - 0.01] });
    expect(ahead.fill(weak, ctx)).toEqual({ kind: 'absent' });
    expect(ahead.fill(weak, asked)).toEqual({ kind: 'invalid', reason: 'unresolvable', raw: '' });
    expect(ahead.fill({ ...weak, visitRelative: chose('tomorrow', T.SLOT_CHOICE_FILL) }, ctx)).toMatchObject({ kind: 'filled' });
  });

  it('fillAt confirm: a day from SLOT_CHOICE_CONFIRM is taken, acknowledged below SLOT_CHOICE_FILL (readBack below-fill); below it, low_confidence', () => {
    const b = (day: number) => ({ bookingMode: chose('absolute', 0.9), bookingMonth: chose('october', 0.9), bookingDay: chose('5', day) });
    expect(booking.fill(b(0.9), ctx)).toMatchObject({ kind: 'filled', value: '2026-10-05', confirm: 'none' });
    expect(booking.fill(b(T.SLOT_CHOICE_FILL), ctx)).toMatchObject({ kind: 'filled', confirm: 'none' });
    expect(booking.fill(b(0.5), ctx)).toMatchObject({ kind: 'filled', confidence: 0.5, confirm: 'implicit' });
    expect(booking.fill(b(T.SLOT_CHOICE_CONFIRM), ctx)).toMatchObject({ kind: 'filled', confirm: 'implicit' });
    expect(booking.fill(b(0.3), ctx)).toEqual({ kind: 'invalid', reason: 'low_confidence', raw: '2026-10-05' });
  });

  it('readBack implicit acknowledges every day, none never does', () => {
    const answers = { bookingMode: chose('relative_day', 0.9), bookingRelative: chose('tomorrow', 0.9) };
    expect(defineSlot('booking', { ...booking.config, type: 'date', readBack: 'implicit' }).fill(answers, ctx)).toMatchObject({ confirm: 'implicit' });
    expect(defineSlot('booking', { ...booking.config, type: 'date', readBack: 'none' }).fill({ ...answers, bookingRelative: chose('tomorrow', 0.5) }, ctx)).toMatchObject({ confirm: 'none' });
  });

  it('windows: holds a span of days as the partial, picks a weekday out of a span named with it', () => {
    expect(booking.fill({ bookingMode: chose('window', 0.9), bookingWindow: chose('next_week', 0.88) }, ctx)).toEqual({
      kind: 'window', window: { kind: 'window', start: '2026-09-21', end: '2026-09-27', label: 'next_week' }, confidence: 0.88,
    });
    expect(booking.fill({ bookingMode: chose('absolute', 0.9), bookingMonth: chose('december', 0.9) }, ctx)).toMatchObject({
      kind: 'window', window: { kind: 'window', start: '2026-12-01', end: '2026-12-31', label: 'december' },
    });
    expect(booking.fill({ bookingMode: chose('window', 0.9), bookingWindow: chose('next_week', 0.9), bookingWeekday: chose('tuesday', 0.9) }, ctx)).toMatchObject({ kind: 'filled', value: '2026-09-22' });
  });

  it('windows: a weekday said while a span is pending is looked for inside it; none left is outside_window; a day named outright stands', () => {
    const within = (start: string, end: string, label: string) => testSlotContext('', { window: { kind: 'window', start, end, label } });
    const weekday = (d: string) => ({ bookingMode: chose('weekday', 0.9), bookingWeekday: chose(d, 0.9) });
    expect(booking.fill(weekday('wednesday'), within('2026-12-01', '2026-12-31', 'december'))).toMatchObject({ kind: 'filled', value: '2026-12-02' });
    expect(booking.fill(weekday('friday'), within('2026-09-21', '2026-09-27', 'next_week'))).toMatchObject({ kind: 'filled', value: '2026-09-25' });
    expect(booking.fill(weekday('friday'), within('2026-12-01', '2026-12-02', 'december'))).toEqual({ kind: 'invalid', reason: 'outside_window', raw: '2026-09-25' });
    expect(booking.fill(weekday('monday'), within('2026-09-14', '2026-09-20', 'this_week'))).toEqual({ kind: 'invalid', reason: 'outside_window', raw: '2026-09-21' });
    expect(booking.fill({ bookingMode: chose('absolute', 0.9), bookingMonth: chose('october', 0.9), bookingDay: chose('5', 0.9) }, within('2026-12-01', '2026-12-31', 'december')))
      .toMatchObject({ kind: 'filled', value: '2026-10-05' });
  });

  it('qualifier: "next" Tuesday is in the next week, "this" Tuesday in this one', () => {
    const tue = (q: string) => ({ bookingMode: chose('weekday', 0.9), bookingWeekday: chose('tuesday', 0.9), bookingQualifier: chose(q, 0.9) });
    const monday = testSlotContext('', { todayIso: '2026-09-14' });
    expect(booking.fill(tue('this'), monday)).toMatchObject({ value: '2026-09-15' });
    expect(booking.fill(tue('next'), monday)).toMatchObject({ value: '2026-09-22' });
    expect(booking.fill(tue('none'), monday)).toMatchObject({ value: '2026-09-15' });
  });

  it('reads SLOT_CHOICE_CONFIRM and SLOT_CHOICE_FILL from the context', () => {
    const answers = visit({ Mode: ['relative_day', 0.9], Relative: ['tomorrow', 0.9] });
    expect(ahead.fill(answers, testSlotContext('', { thresholds: { ...T, SLOT_CHOICE_CONFIRM: 0.95 } })).kind).toBe('absent');
    expect(ahead.fill(answers, testSlotContext('', { thresholds: { ...T, SLOT_CHOICE_FILL: 0.95 } })).kind).toBe('absent');
  });
});

describe('the keypad', () => {
  it('ahead: MMDD as a spoken month and day are, this year\'s or, once more than a month gone, next year\'s', () => {
    expect(booking.dtmf!.parse('1005', ctx)).toEqual({ value: '2026-10-05', display: 'Monday, October 5' });
    expect(booking.dtmf!.parse('0918', ctx)).toMatchObject({ value: '2026-09-18' });
    expect(booking.dtmf!.parse('0101', ctx)).toMatchObject({ value: '2027-01-01' });
    for (const keys of ['1305', '0005', '1000', '0230', '1032', '0917', '100', '10055', '10*5', '']) expect(booking.dtmf!.parse(keys, ctx), keys).toBeNull();
  });

  it('back: MMDD as the last such day, up to today', () => {
    const seen = defineSlot('seen', { type: 'date', range: 'past', keypad: true });
    expect(seen.dtmf!.parse('0912', ctx)).toEqual({ value: '2026-09-12', display: 'Saturday, September 12' });
    expect(seen.dtmf!.parse('0918', ctx)).toMatchObject({ value: '2026-09-18' });
    expect(seen.dtmf!.parse('1003', ctx)).toMatchObject({ value: '2025-10-03' });
    for (const keys of ['1332', '0231', '0229', '0000']) expect(seen.dtmf!.parse(keys, ctx), keys).toBeNull();
  });
});

describe('the words and the ids', () => {
  it('context replaces the opening sentence of every default question, and exclude ends the mode, month and day questions', () => {
    const slot = defineSlot('due', { type: 'date', range: 'past', context: 'The caller is saying which day a book was due.', exclude: 'A date of birth is not the day the book was due.' });
    const q = slot.questions(ctx);
    for (const [id, question] of Object.entries(q)) expect(question.instructions.startsWith('Read asr.text. The caller is saying which day a book was due. '), id).toBe(true);
    for (const id of ['dueMode', 'dueMonth', 'dueDay']) expect(q[id]!.instructions.endsWith(' A date of birth is not the day the book was due.'), id).toBe(true);
    for (const id of ['dueRelative', 'dueWeekday']) expect(q[id]!.instructions, id).not.toContain('date of birth');
  });

  it('text replaces any part word for word, modeNone gives the mode\'s none a criterion, and ids renames a question', () => {
    const slot = defineSlot('visit', {
      type: 'date', range: 'future', windows: true, qualifier: true,
      text: { mode: 'How?', modeNone: 'No day', relative: 'Relative?', weekday: 'Weekday?', qualifier: 'This or next?', month: 'Month?', day: 'Day?', window: 'Span?' },
      ids: { relative: 'visitRelativeDay', qualifier: 'visitWeekdayQualifier' },
    });
    expect(slot.questionIds).toEqual(['visitMode', 'visitMonth', 'visitDay', 'visitWeekday', 'visitWeekdayQualifier', 'visitRelativeDay', 'visitWindow']);
    const q = slot.questions(ctx);
    expect(q.visitMode).toEqual({ type: 'choice', instructions: 'How?', criteria: { ...labels(['absolute', 'relative_day', 'weekday', 'window']), none: 'No day' } });
    expect(Object.fromEntries(Object.entries(q).map(([id, question]) => [id, question.instructions]))).toEqual({
      visitMode: 'How?', visitMonth: 'Month?', visitDay: 'Day?', visitWeekday: 'Weekday?', visitWeekdayQualifier: 'This or next?', visitRelativeDay: 'Relative?', visitWindow: 'Span?',
    });
    expect(slot.fill({ visitMode: chose('relative_day', 0.9), visitRelativeDay: chose('tomorrow', 0.9) }, ctx)).toMatchObject({ value: '2026-09-19' });
  });

  it('refuses a span or a qualifier for a past date, and options the configuration leaves unused', () => {
    const paths = (config: Record<string, unknown>) => {
      const r = buildSlot('due', { type: 'date', ...config });
      return r.ok ? [] : r.problems.map((p) => `${p.path}: ${p.message}`);
    };
    expect(paths({ range: 'past', windows: true, qualifier: true })).toEqual([
      'due.windows: windows needs range "future": a day that already happened is one day, never a span',
      'due.qualifier: qualifier needs range "future": "this" or "next" names a weekday to come',
    ]);
    expect(paths({ range: 'future', narrowPrompt: 'which_day', text: { window: 'Span?', qualifier: 'This?' } })).toEqual([
      'due.narrowPrompt: "narrowPrompt" is not used, since windows is off and no span of days is held',
      'due.text.window: "text.window" is not used, since windows is off and the window question is not asked',
      'due.text.qualifier: "text.qualifier" is not used, since qualifier is off and the qualifier question is not asked',
    ]);
    expect(paths({ range: 'past', context: 'x.', exclude: 'y.', text: { mode: 'a', relative: 'b', weekday: 'c', month: 'd', day: 'e' } })).toEqual([
      'due.context: "context" is not used, since text gives every question in its own words',
      'due.exclude: "exclude" is not used, since text gives the mode, month and day questions in their own words',
    ]);
    // with windows, the window question still says the context
    expect(paths({ range: 'future', windows: true, context: 'x.', text: { mode: 'a', relative: 'b', weekday: 'c', month: 'd', day: 'e' } })).toEqual([]);
    expect(paths({ range: 'future', readBack: 'below-fill' })).toEqual([
      'due.readBack: readBack "below-fill" has no effect with confirm "summary", which neither acknowledges nor reads back a spoken day',
    ]);
  });

  it('needs a range, and refuses an unknown part, an id the engine asks, and a prompt that is not an id', () => {
    const r = buildSlot('due', { type: 'date' });
    expect(!r.ok && r.problems.map(formatProblem)[0]).toMatch(/^\(code\) {2}due\.range {2}/);
    const at = (config: Record<string, unknown>) => (buildSlot('due', { type: 'date', range: 'future', ...config }) as { problems: { path: string }[] }).problems.map((p) => p.path);
    expect(at({ text: { hint: 'x' } })).toEqual(['due.text.hint']);
    expect(at({ ids: { mode: 'intent' } })).toEqual(['due.ids.mode']);
    expect(at({ windows: true, narrowPrompt: 'which day' })).toEqual(['due.narrowPrompt']);
  });
});

/** The ids of the questions a grid answers; `qualifier` and `window` only for slots that ask them. */
interface GridIds {
  mode: string;
  relative: string;
  weekday: string;
  month: string;
  day: string;
  qualifier?: string;
  window?: string;
}

/**
 * Every mix of answers a date slot reads, for a shadowed pair (shadowSlot throws on the first
 * difference), in slices so the mixes that interact are crossed with each other: on three todays
 * (a Friday, the Sunday after February 28th, New Year's Eve), asked and not, with no partial, another
 * kind's, and (with windows) a week, a month and a span too short for most weekdays pending, no
 * answer at all (asked, a miss when the slot reads an unsaid day as one), the mode
 * chosen below, at and above SLOT_CHOICE_CONFIRM (each mode, and labels the question may not offer),
 * then: the month and day with the weekday (a month and day over a weekday); the weekday with its
 * qualifier; the span with the weekday; the relative day. Each part is chosen below
 * SLOT_CHOICE_CONFIRM, between the thresholds, at SLOT_CHOICE_FILL and above it, and again with the
 * weekday sure while the rest are not. Then every four keys a keypad can send.
 */
function dateGrid(shadow: SlotSpec, ids: GridIds): void {
  const windows: (SlotPartial | null)[] = [null, { kind: 'dob', month: 6, day: 14 }];
  if (ids.window) {
    windows.push(
      { kind: 'window', start: '2026-09-21', end: '2026-09-27', label: 'next_week' },
      { kind: 'window', start: '2026-12-01', end: '2026-12-31', label: 'december' },
      { kind: 'window', start: '2026-12-01', end: '2026-12-02', label: 'december' },
    );
  }
  for (const window of windows) {
    for (const text of ['', 'next tuesday', 'september twelfth', 'oh nine one two']) {
      for (const prompted of [false, true]) shadow.questions(testSlotContext(text, { window, prompted }));
    }
  }
  const quiet: AnswerMap = Object.fromEntries(Object.values(ids).map((id) => [id, choice({ none: 1 })]));
  const ps = [0.3, 0.5, T.SLOT_CHOICE_FILL, 0.9];
  for (const todayIso of ['2026-09-18', '2026-03-01', '2026-12-31']) {
    for (const window of windows) {
      for (const prompted of [false, true]) {
        const c = testSlotContext('', { window, todayIso, prompted });
        shadow.fill({}, c);
        for (const mode of ['absolute', 'relative_day', 'weekday', 'window', 'none']) {
          for (const mp of [0.3, T.SLOT_CHOICE_CONFIRM, 0.6]) {
            const base: AnswerMap = { ...quiet, [ids.mode]: chose(mode, mp) };
            for (const p of ps) {
              for (const month of ['september', 'february', 'december', 'none']) {
                for (const day of ['12', '19', '29', '31', 'none']) {
                  for (const weekday of ['saturday', 'tuesday', 'none']) {
                    shadow.fill({ ...base, [ids.month]: chose(month, p), [ids.day]: chose(day, p), [ids.weekday]: chose(weekday, p) }, c);
                    shadow.fill({ ...base, [ids.month]: chose(month, p), [ids.day]: chose(day, p), [ids.weekday]: chose(weekday, 0.9) }, c);
                  }
                }
              }
              for (const weekday of ['friday', 'tuesday', 'wednesday', 'none']) {
                for (const q of ids.qualifier ? ['this', 'next', 'none'] : ['none']) {
                  const qualifier = ids.qualifier ? { [ids.qualifier]: chose(q, p) } : {};
                  shadow.fill({ ...base, [ids.weekday]: chose(weekday, p), ...qualifier }, c);
                  shadow.fill({ ...base, [ids.weekday]: chose(weekday, 0.9), ...qualifier }, c);
                }
              }
              for (const span of ['this_week', 'next_week', 'this_month', 'next_month', 'none']) {
                for (const weekday of ['friday', 'sunday', 'none']) {
                  const spanAnswer = ids.window ? { [ids.window]: chose(span, p) } : {};
                  shadow.fill({ ...base, ...spanAnswer, [ids.weekday]: chose(weekday, p) }, c);
                  shadow.fill({ ...base, ...spanAnswer, [ids.weekday]: chose(weekday, 0.9) }, c);
                }
              }
              for (const relative of ['today', 'tomorrow', 'day_after_tomorrow', 'yesterday', 'day_before_yesterday', 'none']) {
                shadow.fill({ ...base, [ids.relative]: chose(relative, p) }, c);
              }
            }
          }
        }
      }
    }
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  for (const todayIso of ['2026-09-18', '2026-03-01', '2026-12-31']) {
    const c = testSlotContext('', { todayIso });
    for (let m = 0; m <= 13; m++) for (let d = 0; d <= 32; d++) shadow.dtmf?.parse(`${pad(m)}${pad(d)}`, c);
    for (const keys of ['091*', '#912', '09*2', '0000', '9999']) shadow.dtmf?.parse(keys, c);
  }
  for (const iso of ['2026-09-12', '2025-10-03', '2024-02-29', '2027-01-01']) shadow.display(iso);
}

const idsOf = (slot: string): GridIds => ({ mode: `${slot}Mode`, relative: `${slot}Relative`, weekday: `${slot}Weekday`, month: `${slot}Month`, day: `${slot}Day` });

describe('the testkit\'s dates, written as configuration', () => {
  // The testkit's hand-written days and the library slots that replace them (its own context sentence,
  // the date-of-birth sentence for the day a parcel was due, the keypad, and no month-and-day-over-a-
  // weekday rule, which neither hand-written slot had), through the same shadow harness the migration uses.
  it('declares what the hand-written slots did', () => {
    expect(deliveryDayDateSlot.config).toEqual({
      range: 'future', keypad: true, preferMonthDay: false, context: 'The caller is saying which day they want a delivery on.',
      windows: false, qualifier: false, fillAt: 'fill', whenUnsaid: 'invalid-if-prompted', whenUnresolved: 'invalid-if-prompted', confirm: 'summary', readBack: 'implicit',
    });
    expect(expectedDateDateSlot.config).toEqual({
      range: 'past', keypad: true, preferMonthDay: false, context: 'The caller is saying which day a parcel was due to arrive.',
      exclude: "The caller's date of birth is not the day the parcel was due.",
      windows: false, qualifier: false, fillAt: 'fill', whenUnsaid: 'invalid-if-prompted', whenUnresolved: 'invalid-if-prompted', confirm: 'summary', readBack: 'implicit',
    });
    for (const slot of [deliveryDayDateSlot, expectedDateDateSlot]) expect(slot.prompts!.map((p) => p.id)).toEqual([`ask_${slot.id}_dtmf`]);
  });

  it('the delivery day asks the same questions, fills the same way and keys the same days on every branch', () => {
    const report = createShadowReport();
    dateGrid(shadowSlot(testkitDeliveryDay, deliveryDayDateSlot, { report }), idsOf('deliveryDay'));
    expect(report.mismatches).toEqual([]);
    expect(report.calls['deliveryDay.fill']).toBeGreaterThan(30_000);
    expect(report.calls['deliveryDay.dtmf.parse']).toBeGreaterThan(1_000);
  });

  it('the expected date asks the same questions, fills the same way and keys the same days on every branch', () => {
    const report = createShadowReport();
    dateGrid(shadowSlot(testkitExpectedDate, expectedDateDateSlot, { report }), idsOf('expectedDate'));
    expect(report.mismatches).toEqual([]);
    expect(report.calls['expectedDate.fill']).toBeGreaterThan(30_000);
    expect(report.calls['expectedDate.dtmf.parse']).toBeGreaterThan(1_000);
  });

  it('would find a slot that differs by one option', () => {
    const on = defineSlot('expectedDate', { ...expectedDateDateSlot.config, type: 'date', preferMonthDay: true });
    expect(() => dateGrid(shadowSlot(testkitExpectedDate, on), idsOf('expectedDate'))).toThrow(/fill/);
    const fillAt = defineSlot('deliveryDay', { ...deliveryDayDateSlot.config, type: 'date', fillAt: 'confirm' });
    expect(() => dateGrid(shadowSlot(testkitDeliveryDay, fillAt), idsOf('deliveryDay'))).toThrow(/fill/);
  });

  it('agree with the hand-written slots with no answer at all: a turn that named no day, invalid when the day was asked for', () => {
    // The engine asks a listening slot's questions on every turn it fills it, so no stub or recorded
    // turn gives no answer at all; the grids above include it, asked and not, and find no mismatch.
    for (const [legacy, lib] of [[testkitDeliveryDay, deliveryDayDateSlot], [testkitExpectedDate, expectedDateDateSlot]] as const) {
      const report = createShadowReport();
      const shadow = shadowSlot(legacy, lib, { report });
      expect(shadow.fill({}, asked)).toEqual({ kind: 'invalid', reason: 'unresolvable', raw: '' });
      expect(shadow.fill({}, ctx)).toEqual({ kind: 'absent' });
      expect(report.mismatches).toEqual([]);
    }
    expect(defineSlot('due', { type: 'date', range: 'future', whenUnsaid: 'absent' }).fill({}, asked)).toEqual({ kind: 'absent' });
  });
});

describe('the docs', () => {
  it('the README names every option and every text part', () => {
    const readme = readFileSync(new URL('./README.md', import.meta.url), 'utf8');
    const options = Object.keys((slotTypeJsonSchema(dateType).properties ?? {}) as object).filter((k) => k !== 'type');
    expect(options.sort()).toEqual([
      'confirm', 'context', 'exclude', 'fillAt', 'ids', 'keypad', 'narrowPrompt', 'preferMonthDay', 'qualifier', 'range', 'readBack', 'text', 'whenUnresolved', 'whenUnsaid', 'windows',
    ]);
    for (const option of options) expect(readme, option).toContain(`\`${option}\``);
    for (const part of ['mode', 'modeNone', 'relative', 'weekday', 'qualifier', 'month', 'day', 'window']) expect(readme, part).toContain(`\`${part}\``);
  });
});

describe('a date slot in Spanish (es, es-*)', () => {
  const booking = defineSlot('booking', { type: 'date', range: 'future', windows: true, keypad: true });

  it('says the day as "martes, 22 de septiembre" and a span as "la próxima semana"', () => {
    const es = testSlotContext('el martes', { locale: 'es' });
    expect(booking.fill({ bookingMode: choice({ weekday: 0.92, none: 0.08 }), bookingWeekday: choice({ tuesday: 0.93, none: 0.07 }) }, es)).toMatchObject({ value: '2026-09-22', display: 'martes, 22 de septiembre' });
    const span = booking.fill({ bookingMode: choice({ window: 0.92, none: 0.08 }), bookingWindow: choice({ next_week: 0.9, none: 0.1 }) }, testSlotContext('la próxima semana', { locale: 'es' }));
    expect(span.kind).toBe('window');
    if (span.kind !== 'window') return;
    expect(booking.partialVars!(span.window, 'es')).toEqual({ window: 'la próxima semana' });
    expect(booking.partialVars!(span.window, 'en-US')).toEqual({ window: 'next week' });
    expect(booking.partialVars!({ kind: 'window', start: '2026-12-01', end: '2026-12-31', label: 'december' }, 'es-MX')).toEqual({ window: 'en diciembre' });
  });

  it('takes the keypad day first in Spanish (DDMM), month first otherwise', () => {
    expect(booking.dtmf!.parse('0510', testSlotContext('', { locale: 'es' }))).toEqual({ value: '2026-10-05', display: 'lunes, 5 de octubre' });
    expect(booking.dtmf!.parse('1005', testSlotContext(''))).toEqual({ value: '2026-10-05', display: 'Monday, October 5' });
    expect(booking.dtmf!.parse('1305', testSlotContext('', { locale: 'es' }))).toEqual({ value: '2027-05-13', display: 'jueves, 13 de mayo' });
    expect(booking.dtmf!.parse('0513', testSlotContext('', { locale: 'es' }))).toBeNull();
  });

  it('ends the default month and day questions with the day-first sentence in Spanish only', () => {
    const es = booking.questions(testSlotContext('el 5 del 10', { locale: 'es' }));
    const en = booking.questions(testSlotContext('el 5 del 10'));
    expect(es.bookingMonth!.instructions).toBe(`${en.bookingMonth!.instructions} A date said as numbers gives the day before the month, as Spanish does: "22/11" and "el 22 del 11" are November 22.`);
    expect(es.bookingDay!.instructions.endsWith('are November 22.')).toBe(true);
    expect(es.bookingMode).toEqual(en.bookingMode);
    expect(booking.questions(testSlotContext('x', { locale: 'en-US' }))).toEqual(en);
  });
});
