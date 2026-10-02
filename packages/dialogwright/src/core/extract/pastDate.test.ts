import { describe, expect, it } from 'vitest';
import { pastDayResult, resolvePastDate, type PastDateComponents } from './pastDate';

// 2026-09-18 is a Friday.
const TODAY = '2026-09-18';
const none = { choice: 'none', p: 0.9 };

function components(over: Partial<PastDateComponents>): PastDateComponents {
  return { mode: none, relativeDay: none, weekday: none, month: none, day: none, ...over };
}

describe('resolvePastDate', () => {
  it('yesterday is the day before today', () => {
    const r = resolvePastDate(components({ mode: { choice: 'relative_day', p: 0.9 }, relativeDay: { choice: 'yesterday', p: 0.8 } }), TODAY);
    expect(r).toEqual({ kind: 'day', iso: '2026-09-17', confidence: 0.8 });
  });

  it('today and the day before yesterday count back from today', () => {
    const rel = (choice: string) => resolvePastDate(components({ mode: { choice: 'relative_day', p: 0.9 }, relativeDay: { choice, p: 0.9 } }), TODAY);
    expect(rel('today')).toMatchObject({ iso: '2026-09-18' });
    expect(rel('day_before_yesterday')).toMatchObject({ iso: '2026-09-16' });
    expect(rel('none')).toEqual({ kind: 'none' });
  });

  it('a bare weekday is the most recent one', () => {
    const r = resolvePastDate(components({ mode: { choice: 'weekday', p: 0.92 }, weekday: { choice: 'saturday', p: 0.93 } }), TODAY);
    expect(r).toEqual({ kind: 'day', iso: '2026-09-12', confidence: 0.92 });
  });

  it("today's own weekday means a week back, not today itself", () => {
    const r = resolvePastDate(components({ mode: { choice: 'weekday', p: 0.9 }, weekday: { choice: 'friday', p: 0.9 } }), TODAY);
    expect(r).toMatchObject({ kind: 'day', iso: '2026-09-11' });
    // 2026-09-19 is a Saturday: naming Saturday on a Saturday is the same rule, seven days back.
    const sat = resolvePastDate(components({ mode: { choice: 'weekday', p: 0.9 }, weekday: { choice: 'saturday', p: 0.9 } }), '2026-09-19');
    expect(sat).toMatchObject({ kind: 'day', iso: '2026-09-12' });
  });

  it('a month and day not after today is this year', () => {
    const r = resolvePastDate(components({ mode: { choice: 'absolute', p: 0.9 }, month: { choice: 'september', p: 0.9 }, day: { choice: '12', p: 0.85 } }), TODAY);
    expect(r).toEqual({ kind: 'day', iso: '2026-09-12', confidence: 0.85 });
  });

  it('a month and day after today is last year', () => {
    const r = resolvePastDate(components({ mode: { choice: 'absolute', p: 0.9 }, month: { choice: 'october', p: 0.9 }, day: { choice: '3', p: 0.9 } }), TODAY);
    expect(r).toMatchObject({ kind: 'day', iso: '2025-10-03' });
  });

  it('a month without a day, or a day the month lacks, is none', () => {
    expect(resolvePastDate(components({ mode: { choice: 'absolute', p: 0.9 }, month: { choice: 'august', p: 0.9 } }), TODAY)).toEqual({ kind: 'none' });
    expect(resolvePastDate(components({ mode: { choice: 'absolute', p: 0.9 }, month: { choice: 'february', p: 0.9 }, day: { choice: '30', p: 0.9 } }), TODAY)).toEqual({ kind: 'none' });
  });

  it('a bare day of the month is the most recent one: this month if not after today, else last month', () => {
    const day = (d: string, today = TODAY) => resolvePastDate(components({ mode: { choice: 'absolute', p: 0.9 }, day: { choice: d, p: 0.85 } }), today);
    expect(day('12')).toEqual({ kind: 'day', iso: '2026-09-12', confidence: 0.85 });
    expect(day('18')).toMatchObject({ iso: '2026-09-18' });
    expect(day('20')).toMatchObject({ iso: '2026-08-20' });
    // Last month lacks the day: the latest month before it that has one.
    expect(day('31', '2026-03-05')).toMatchObject({ iso: '2026-01-31' });
    expect(day('15', '2026-01-10')).toMatchObject({ iso: '2025-12-15' });
    expect(day('0')).toEqual({ kind: 'none' });
    expect(day('32')).toEqual({ kind: 'none' });
    expect(day('none')).toEqual({ kind: 'none' });
  });

  it('mode none is none', () => {
    expect(resolvePastDate(components({ weekday: { choice: 'saturday', p: 0.9 } }), TODAY)).toEqual({ kind: 'none' });
  });

  it('a date three years back is none, and so is a date after today', () => {
    expect(pastDayResult('2023-09-18', 0.9, TODAY)).toEqual({ kind: 'none' });
    expect(pastDayResult('2026-09-19', 0.9, TODAY)).toEqual({ kind: 'none' });
    expect(pastDayResult('2024-09-19', 0.9, TODAY)).toEqual({ kind: 'day', iso: '2024-09-19', confidence: 0.9 });
  });
});
