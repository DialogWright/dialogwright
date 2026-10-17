import { describe, expect, it } from 'vitest';
import { NEAR_FUTURE_DAYS, pastDayResult, resolvePastDate, type PastDateComponents } from './pastDate';

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

  it('with nearFuture, a month and day up to NEAR_FUTURE_DAYS ahead is this year\'s, a day to come; further ahead, last year\'s', () => {
    const on = (month: string, day: string, today = TODAY) =>
      resolvePastDate(components({ mode: { choice: 'absolute', p: 0.9 }, month: { choice: month, p: 0.9 }, day: { choice: day, p: 0.8 } }), today, { nearFuture: true });
    expect(NEAR_FUTURE_DAYS).toBe(31);
    expect(on('september', '19')).toEqual({ kind: 'future', iso: '2026-09-19', confidence: 0.8 });
    expect(on('october', '3')).toEqual({ kind: 'future', iso: '2026-10-03', confidence: 0.8 });
    expect(on('october', '19')).toMatchObject({ kind: 'future', iso: '2026-10-19' });
    expect(on('october', '20')).toEqual({ kind: 'day', iso: '2025-10-20', confidence: 0.8 });
    expect(on('september', '18')).toMatchObject({ kind: 'day', iso: '2026-09-18' });
    expect(on('october', '22', '2026-10-17')).toMatchObject({ kind: 'future', iso: '2026-10-22' });
    // February 29th ahead in a year that has none is last year's as always (none when last year has none either).
    expect(on('february', '29', '2028-02-10')).toMatchObject({ kind: 'future', iso: '2028-02-29' });
    expect(on('february', '29', '2027-02-10')).toEqual({ kind: 'none' });
    // Without the rule, as before.
    expect(resolvePastDate(components({ mode: { choice: 'absolute', p: 0.9 }, month: { choice: 'october', p: 0.9 }, day: { choice: '3', p: 0.9 } }), TODAY, {})).toMatchObject({ kind: 'day', iso: '2025-10-03' });
  });

  it('with a qualifier: "next" is next week\'s, a day to come; "this" is this week\'s, gone or to come', () => {
    const wd = (weekday: string, qualifier: string, today = TODAY) =>
      resolvePastDate(components({ mode: { choice: 'weekday', p: 0.9 }, weekday: { choice: weekday, p: 0.95 }, weekdayQualifier: { choice: qualifier, p: 0.85 } }), today);
    // Friday, September 18th.
    expect(wd('thursday', 'next')).toEqual({ kind: 'future', iso: '2026-09-24', confidence: 0.85 });
    expect(wd('monday', 'next')).toMatchObject({ kind: 'future', iso: '2026-09-21' });
    expect(wd('thursday', 'this')).toEqual({ kind: 'day', iso: '2026-09-17', confidence: 0.85 });
    expect(wd('friday', 'this')).toMatchObject({ kind: 'day', iso: '2026-09-18' });
    expect(wd('saturday', 'this')).toMatchObject({ kind: 'future', iso: '2026-09-19' });
    expect(wd('sunday', 'this', '2026-09-20')).toMatchObject({ kind: 'day', iso: '2026-09-20' });
    expect(wd('thursday', 'none')).toEqual({ kind: 'day', iso: '2026-09-17', confidence: 0.9 });
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
