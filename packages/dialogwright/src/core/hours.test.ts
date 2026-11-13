import { describe, expect, it } from 'vitest';
import { closesAt, daysOf, hoursOpen, hoursProblems, isOpen, localTime, nextOpening, rangeOf, scheduleOf, type HoursConfig } from './hours';

/**
 * Business hours (design 2026-10-09-routes, decision 5): a default schedule and named ones, judged
 * against the turn's clock in the schedule's time zone, with no dependency but the platform's Intl.
 */

/** A moment written with its offset, as a scripted call's clock is. */
const at = (iso: string): number => Date.parse(iso);

const HOURS: HoursConfig = {
  timezone: 'America/New_York',
  weekly: { 'mon-fri': ['08:00-18:00'], sat: ['09:00-13:00'] },
  closed: ['2026-12-25'],
  schedules: {
    billing: { weekly: { 'mon-fri': ['09:00-17:00'] } },
    night: { timezone: 'Europe/London', weekly: { 'fri-sun': ['22:00-06:00'] }, closed: [] },
  },
};

describe('reading the schedule', () => {
  it('days: a name, or a range of two that may go round the week', () => {
    expect(daysOf('mon')).toEqual([1]);
    expect(daysOf('mon-fri')).toEqual([1, 2, 3, 4, 5]);
    expect(daysOf('fri-mon')).toEqual([5, 6, 0, 1]);
    expect(daysOf('Sun')).toEqual([0]);
    expect(daysOf('monday')).toBeNull();
    expect(daysOf('mon-mon')).toBeNull();
    expect(daysOf('mon-wed-fri')).toBeNull();
  });

  it('ranges: HH:MM-HH:MM, 24:00 an end only, a start and an end that differ', () => {
    expect(rangeOf('08:00-18:00')).toEqual({ start: 480, end: 1080 });
    expect(rangeOf('22:00-06:00')).toEqual({ start: 1320, end: 360 });
    expect(rangeOf('00:00-24:00')).toEqual({ start: 0, end: 1440 });
    expect(rangeOf('8:00-18:00')).toBeNull();
    expect(rangeOf('24:00-06:00')).toBeNull();
    expect(rangeOf('09:00-09:00')).toBeNull();
    expect(rangeOf('09:00')).toBeNull();
    expect(rangeOf('09:60-10:00')).toBeNull();
  });

  it('the local time in the schedule\'s zone, daylight saving included', () => {
    expect(localTime(at('2026-10-12T14:30:00Z'), 'America/New_York')).toEqual({ date: '2026-10-12', day: 1, minute: 10 * 60 + 30 });
    expect(localTime(at('2026-12-14T14:30:00Z'), 'America/New_York')).toEqual({ date: '2026-12-14', day: 1, minute: 9 * 60 + 30 });
    expect(localTime(at('2026-10-12T03:00:00Z'), 'America/New_York')).toEqual({ date: '2026-10-11', day: 0, minute: 23 * 60 });
  });

  it('a named schedule takes the default\'s zone and closed dates unless it writes its own', () => {
    expect(scheduleOf(HOURS, 'billing')).toEqual({ timezone: 'America/New_York', weekly: { 'mon-fri': ['09:00-17:00'] }, closed: ['2026-12-25'] });
    expect(scheduleOf(HOURS, 'night')!.closed).toEqual([]);
    expect(scheduleOf(HOURS, 'other')).toBeNull();
    expect(scheduleOf(HOURS)).toBe(HOURS);
  });
});

describe('open or closed', () => {
  it('within a day\'s range, and not at its end', () => {
    expect(isOpen(HOURS, at('2026-10-12T10:00:00-04:00'))).toBe(true);
    expect(isOpen(HOURS, at('2026-10-12T08:00:00-04:00'))).toBe(true);
    expect(isOpen(HOURS, at('2026-10-12T07:59:00-04:00'))).toBe(false);
    expect(isOpen(HOURS, at('2026-10-12T18:00:00-04:00'))).toBe(false);
    expect(isOpen(HOURS, at('2026-10-17T12:00:00-04:00'))).toBe(true);
    expect(isOpen(HOURS, at('2026-10-17T13:30:00-04:00'))).toBe(false);
    expect(isOpen(HOURS, at('2026-10-18T12:00:00-04:00'))).toBe(false);
  });

  it('a closed date is closed all day', () => {
    expect(isOpen(HOURS, at('2026-12-25T10:00:00-05:00'))).toBe(false);
    expect(isOpen(HOURS, at('2026-12-24T10:00:00-05:00'))).toBe(true);
  });

  it('an overnight range runs into the next day, and a closed date closes the hours that start on it', () => {
    const night = scheduleOf(HOURS, 'night')!;
    expect(isOpen(night, at('2026-10-16T23:00:00+01:00'))).toBe(true);
    expect(isOpen(night, at('2026-10-17T05:59:00+01:00'))).toBe(true);
    expect(isOpen(night, at('2026-10-17T06:00:00+01:00'))).toBe(false);
    // Monday early morning: Sunday's range runs on.
    expect(isOpen(night, at('2026-10-19T02:00:00+01:00'))).toBe(true);
    // Thursday night: no range starts then.
    expect(isOpen(night, at('2026-10-15T23:00:00+01:00'))).toBe(false);
    const holiday = { ...night, closed: ['2026-10-16'] };
    expect(isOpen(holiday, at('2026-10-16T23:00:00+01:00'))).toBe(false);
    expect(isOpen(holiday, at('2026-10-17T02:00:00+01:00'))).toBe(false);
    expect(isOpen(holiday, at('2026-10-17T23:00:00+01:00'))).toBe(true);
    const nextDayClosed = { ...night, closed: ['2026-10-17'] };
    expect(isOpen(nextDayClosed, at('2026-10-17T02:00:00+01:00'))).toBe(true);
  });

  it('a named schedule, and none for an app with no hours or no such schedule', () => {
    expect(hoursOpen(HOURS, at('2026-10-12T08:30:00-04:00'), 'billing')).toBe(false);
    expect(hoursOpen(HOURS, at('2026-10-12T09:30:00-04:00'), 'billing')).toBe(true);
    expect(hoursOpen(HOURS, at('2026-10-12T09:30:00-04:00'), 'other')).toBeNull();
    expect(hoursOpen(undefined, at('2026-10-12T09:30:00-04:00'))).toBeNull();
  });
});

describe('what pnpm check refuses of the hours', () => {
  it('nothing in a good one', () => {
    expect(hoursProblems(HOURS)).toEqual([]);
    expect(hoursProblems(undefined)).toEqual([]);
    expect(hoursProblems({ timezone: 'UTC', weekly: {} })).toEqual([]);
  });

  it('a zone the platform does not know, a day or a range that is not one, a date that is not a date, a schedule\'s name', () => {
    const problems = hoursProblems({
      timezone: 'Mars/Olympus',
      weekly: { weekdays: ['08:00-18:00'], sat: ['9-13'], sun: 'all day' as unknown as string[] },
      closed: ['2026-02-30', 'christmas'],
      schedules: { 'late-desk': { timezone: 'Nowhere/Here', weekly: {} } },
    }).map((p) => `${p.path.join('.')}: ${p.message}`);
    expect(problems).toEqual([
      'timezone: "Mars/Olympus" is not a time zone this platform knows',
      'weekly.weekdays: "weekdays" is not a day or a range of days',
      'weekly.sat.0: "9-13" is not a time range',
      'weekly.sun: is not a list of time ranges',
      'closed.0: "2026-02-30" is not a date',
      'closed.1: "christmas" is not a date',
      'schedules.late-desk: "late-desk" is not a plain word',
      'schedules.late-desk.timezone: "Nowhere/Here" is not a time zone this platform knows',
    ]);
  });
});

describe('app.yaml\'s hours, as the schema reads them', () => {
  it('takes a good one, and reports each problem at its path with its fix', async () => {
    const { appSchema } = await import('../define/schema/app');
    expect(appSchema.safeParse({ id: 'x', hours: HOURS }).success).toBe(true);
    const r = appSchema.safeParse({ id: 'x', hours: { timezone: 'Mars/Olympus', weekly: { 'mon-fri': ['8-6'] }, closed: ['2026-13-01'] } });
    expect(r.success).toBe(false);
    expect(r.error!.issues.map((i) => `${i.path.join('.')}: ${i.message}`)).toEqual([
      'hours.timezone: "Mars/Olympus" is not a time zone this platform knows',
      'hours.weekly.mon-fri.0: "8-6" is not a time range',
      'hours.closed.0: "2026-13-01" is not a date',
    ]);
    expect(appSchema.safeParse({ id: 'x', hours: { weekly: {} } }).success).toBe(false);
  });
});

describe('the next opening and today\'s closing', () => {
  const week = scheduleOf(HOURS)!;
  it('nextOpening: later today, the next day, across a weekend', () => {
    // Wednesday 2026-11-11, 6:30 am in New York (11:30Z): opens at 8:00 today.
    expect(nextOpening(week, at('2026-11-11T11:30:00Z'))).toEqual({ date: '2026-11-11', minute: 8 * 60 });
    // Wednesday 7 pm: tomorrow at 8:00.
    expect(nextOpening(week, at('2026-11-12T00:00:00Z'))).toEqual({ date: '2026-11-12', minute: 8 * 60 });
    // Saturday 2026-11-14 at 3 pm (after the 13:00 close): Sunday is closed, so Monday 8:00.
    expect(nextOpening(week, at('2026-11-14T20:00:00Z'))).toEqual({ date: '2026-11-16', minute: 8 * 60 });
    // Friday 7 pm: Saturday opens at 9:00.
    expect(nextOpening(week, at('2026-11-14T00:00:00Z'))).toEqual({ date: '2026-11-14', minute: 9 * 60 });
  });
  it('nextOpening: a running range is not next, a closed date is skipped, the horizon bounds it', () => {
    // Wednesday 10 am is inside 08:00-18:00: the next start is Thursday.
    expect(nextOpening(week, at('2026-11-11T15:00:00Z'))).toEqual({ date: '2026-11-12', minute: 8 * 60 });
    // Thursday 2026-12-24 evening: Friday the 25th is closed, Saturday 9:00 is next.
    expect(nextOpening(week, at('2026-12-25T01:00:00Z'))).toEqual({ date: '2026-12-26', minute: 9 * 60 });
    expect(nextOpening({ timezone: 'UTC', weekly: {} }, at('2026-11-11T00:00:00Z'))).toBeNull();
    expect(nextOpening({ timezone: 'UTC', weekly: { sun: ['09:00-10:00'] } }, at('2026-11-11T00:00:00Z'), 3)).toBeNull();
    expect(nextOpening({ timezone: 'UTC', weekly: { sun: ['09:00-10:00'] } }, at('2026-11-11T00:00:00Z'), 5)).toEqual({ date: '2026-11-15', minute: 540 });
  });
  it('nextOpening: an overnight range starts on its own day', () => {
    const night = scheduleOf(HOURS, 'night')!;
    // Thursday 2026-11-12 noon in London: fri-sun 22:00-06:00, so Friday 22:00.
    expect(nextOpening(night, at('2026-11-12T12:00:00Z'))).toEqual({ date: '2026-11-13', minute: 22 * 60 });
    // Saturday 03:00 London is inside Friday's range; the next start is Saturday 22:00.
    expect(nextOpening(night, at('2026-11-14T03:00:00Z'))).toEqual({ date: '2026-11-14', minute: 22 * 60 });
  });
  it('closesAt: the end of the range open now; null when closed', () => {
    expect(closesAt(week, at('2026-11-11T15:00:00Z'))).toEqual({ date: '2026-11-11', minute: 18 * 60 });
    expect(closesAt(week, at('2026-11-12T00:00:00Z'))).toBeNull();
    const night = scheduleOf(HOURS, 'night')!;
    expect(closesAt(night, at('2026-11-13T23:00:00Z'))).toEqual({ date: '2026-11-14', minute: 6 * 60 });
    expect(closesAt(night, at('2026-11-14T03:00:00Z'))).toEqual({ date: '2026-11-14', minute: 6 * 60 });
    expect(closesAt({ timezone: 'UTC', weekly: { mon: ['09:00-24:00'] } }, at('2026-11-16T12:00:00Z'))).toEqual({ date: '2026-11-17', minute: 0 });
    expect(closesAt(week, at('2026-12-25T15:00:00Z'))).toBeNull();
  });
});

describe('closesAt across contiguous ranges, and through DST', () => {
  it('a 24/7 schedule is open with no closing; contiguous ranges close at the last end', () => {
    const always: HoursConfig = { timezone: 'America/New_York', weekly: { 'mon-sun': ['00:00-24:00'] } };
    expect(isOpen(always, at('2026-11-11T15:00:00Z'))).toBe(true);
    expect(closesAt(always, at('2026-11-11T15:00:00Z'))).toBeNull();
    const split: HoursConfig = { timezone: 'America/New_York', weekly: { 'mon-fri': ['08:00-12:00', '12:00-18:00'] } };
    expect(closesAt(split, at('2026-11-11T15:00:00Z'))).toEqual({ date: '2026-11-11', minute: 18 * 60 });
  });
  it('a range ending 24:00 carries into the next day\'s 00:00 range, and stops at a closed date', () => {
    const late: HoursConfig = { timezone: 'UTC', weekly: { mon: ['18:00-24:00'], tue: ['00:00-03:00'] } };
    expect(closesAt(late, at('2026-11-16T20:00:00Z'))).toEqual({ date: '2026-11-17', minute: 3 * 60 });
    expect(closesAt({ ...late, closed: ['2026-11-17'] }, at('2026-11-16T20:00:00Z'))).toEqual({ date: '2026-11-17', minute: 0 });
  });
});

describe('nextOpening through daylight saving changes', () => {
  const ny: HoursConfig = { timezone: 'America/New_York', weekly: { 'mon-sun': ['09:00-17:00'] } };
  it('across the fall-back Sunday (2026-11-01) the opening is still 9:00 local', () => {
    expect(nextOpening(ny, at('2026-11-01T06:00:00Z'))).toEqual({ date: '2026-11-01', minute: 9 * 60 });
    expect(nextOpening(ny, at('2026-11-01T23:00:00Z'))).toEqual({ date: '2026-11-02', minute: 9 * 60 });
  });
  it('across the spring-forward Sunday (2027-03-14) the opening is still 9:00 local', () => {
    expect(nextOpening(ny, at('2027-03-14T05:30:00Z'))).toEqual({ date: '2027-03-14', minute: 9 * 60 });
    expect(nextOpening(ny, at('2027-03-14T22:00:00Z'))).toEqual({ date: '2027-03-15', minute: 9 * 60 });
  });
});
