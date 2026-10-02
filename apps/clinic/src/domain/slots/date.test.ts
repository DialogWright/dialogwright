import { describe, expect, it } from 'vitest';
import { choice, testSlotContext, type AnswerMap } from 'dialogwright';
import { dateSlot } from './date';
import { SLOTS } from './index';

const ctx = testSlotContext('');
const within = (start: string, end: string, label: string) => testSlotContext('', { window: { kind: 'window', start, end, label } });

function dateAnswers(picks: Record<string, [string, number]>): AnswerMap {
  const ids = ['dateMode', 'dateMonth', 'dateDay', 'dateWeekday', 'dateWeekdayQualifier', 'dateRelativeDay', 'dateWindow'];
  const out: AnswerMap = {};
  for (const id of ids) {
    const [label, p] = picks[id] ?? ['none', 0.95];
    out[id] = choice({ [label]: p, ...(label === 'none' ? {} : { none: 1 - p }) });
  }
  return out;
}

describe('dateSlot', () => {
  it('asks the seven part questions', () => {
    expect(Object.keys(dateSlot.questions(ctx))).toEqual(['dateMode', 'dateMonth', 'dateDay', 'dateWeekday', 'dateWeekdayQualifier', 'dateRelativeDay', 'dateWindow']);
  });

  it('fills a day silently when sure', () => {
    const out = dateSlot.fill(dateAnswers({ dateMode: ['relative_day', 0.9], dateRelativeDay: ['tomorrow', 0.9] }), ctx);
    expect(out).toEqual({ kind: 'filled', value: '2026-09-19', display: 'Saturday, September 19', confidence: 0.9, confirm: 'none' });
  });

  it('reads a day back when its weakest part is in the confirm band', () => {
    const answers = dateAnswers({ dateMode: ['absolute', 0.9], dateMonth: ['october', 0.9] });
    answers.dateDay = choice({ '5': 0.47, none: 0.33, '6': 0.2 });
    expect(dateSlot.fill(answers, ctx)).toMatchObject({ kind: 'filled', value: '2026-10-05', confirm: 'implicit' });
  });

  it('holds a span of days as its partial, which the window question words', () => {
    const out = dateSlot.fill(dateAnswers({ dateMode: ['window', 0.9], dateWindow: ['next_week', 0.88] }), ctx);
    expect(out).toEqual({ kind: 'window', window: { kind: 'window', start: '2026-09-21', end: '2026-09-27', label: 'next_week' }, confidence: 0.88 });
    expect(dateSlot.partialPromptId).toBe('date_narrow_window');
    expect(dateSlot.partialVars!({ kind: 'window', start: '2026-09-21', end: '2026-09-27', label: 'next_week' })).toEqual({ window: 'next week' });
    expect(dateSlot.partialVars!({ kind: 'window', start: '2026-12-01', end: '2026-12-31', label: 'december' })).toEqual({ window: 'in December' });
  });

  it('is absent when no day is said, or the mode is below the confirm band', () => {
    expect(dateSlot.fill(dateAnswers({}), ctx)).toEqual({ kind: 'absent' });
    expect(dateSlot.fill(dateAnswers({ dateMode: ['relative_day', 0.3], dateRelativeDay: ['tomorrow', 0.9] }), ctx)).toEqual({ kind: 'absent' });
  });

  it('is invalid for a day that does not exist, or one read with little confidence', () => {
    expect(dateSlot.fill(dateAnswers({ dateMode: ['absolute', 0.9], dateMonth: ['february', 0.9], dateDay: ['30', 0.9] }), ctx)).toEqual({ kind: 'invalid', reason: 'unresolvable', raw: 'absolute' });
    const answers = { ...dateAnswers({ dateMode: ['absolute', 0.9], dateMonth: ['october', 0.9] }), dateDay: choice({ '5': 0.3, '15': 0.25, '25': 0.25, none: 0.2 }) };
    expect(dateSlot.fill(answers, ctx)).toMatchObject({ kind: 'invalid', reason: 'low_confidence', raw: '2026-10-05' });
  });

  it('narrows a weekday into a pending window, keeping one already inside it', () => {
    expect(dateSlot.fill(dateAnswers({ dateMode: ['weekday', 0.9], dateWeekday: ['wednesday', 0.9] }), within('2026-12-01', '2026-12-31', 'december')))
      .toMatchObject({ kind: 'filled', value: '2026-12-02', display: 'Wednesday, December 2' });
    expect(dateSlot.fill(dateAnswers({ dateMode: ['weekday', 0.9], dateWeekday: ['friday', 0.9] }), within('2026-09-21', '2026-09-27', 'next_week')))
      .toMatchObject({ kind: 'filled', value: '2026-09-25' });
  });

  it('refuses a weekday with no day left inside the window, never snapping into its past', () => {
    expect(dateSlot.fill(dateAnswers({ dateMode: ['weekday', 0.9], dateWeekday: ['friday', 0.9] }), within('2026-12-01', '2026-12-02', 'december')))
      .toEqual({ kind: 'invalid', reason: 'outside_window', raw: '2026-09-25' });
    expect(dateSlot.fill(dateAnswers({ dateMode: ['weekday', 0.9], dateWeekday: ['monday', 0.9] }), within('2026-09-14', '2026-09-20', 'this_week')))
      .toEqual({ kind: 'invalid', reason: 'outside_window', raw: '2026-09-21' });
  });

  it('takes an absolute day outside the window as said', () => {
    expect(dateSlot.fill(dateAnswers({ dateMode: ['absolute', 0.9], dateMonth: ['october', 0.9], dateDay: ['5', 0.9] }), within('2026-12-01', '2026-12-31', 'december')))
      .toMatchObject({ kind: 'filled', value: '2026-10-05' });
  });

  it('parses MMDD on the keypad', () => {
    expect(dateSlot.dtmf!.parse('1005', ctx)).toEqual({ value: '2026-10-05', display: 'Monday, October 5' });
    expect(dateSlot.dtmf!.parse('1305', ctx)).toBeNull();
  });

  it('is a date: one said at the birthday question is not also the appointment day', () => {
    expect(dateSlot.valueKind).toBe('date');
  });
});

describe('a full date beats a weekday', () => {
  it('takes the month and day when the model splits the mode between weekday and absolute', () => {
    const answers = {
      dateMode: choice({ weekday: 0.5, absolute: 0.48, none: 0.02 }),
      dateMonth: choice({ september: 0.99, none: 0.01 }),
      dateDay: choice({ '28': 1 }),
      dateWeekday: choice({ monday: 1 }),
      dateWeekdayQualifier: choice({ none: 1 }),
    };
    // From Friday 2026-09-18 a bare Monday is the 21st; the date said is the 28th.
    expect(dateSlot.fill(answers, ctx)).toMatchObject({ kind: 'filled', value: '2026-09-28' });
  });

  it('still reads a bare weekday as the next one', () => {
    const answers = { dateMode: choice({ weekday: 0.9, none: 0.1 }), dateWeekday: choice({ monday: 1 }), dateMonth: choice({ none: 1 }), dateDay: choice({ none: 1 }), dateWeekdayQualifier: choice({ none: 1 }) };
    expect(dateSlot.fill(answers, ctx)).toMatchObject({ kind: 'filled', value: '2026-09-21' });
  });
});

describe('the slot registry', () => {
  it('has all five slots', () => {
    expect(Object.keys(SLOTS)).toEqual(['name', 'dob', 'memberId', 'provider', 'date']);
  });
});
