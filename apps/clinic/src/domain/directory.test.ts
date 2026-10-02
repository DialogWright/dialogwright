import { describe, expect, it } from 'vitest';
import { addDays, parseIso } from 'dialogwright';
import { DAYPART_ORDER, DEMO_TIMES, DemoDirectory, daypartBounds, daypartOf, hashOf, isDaypart, minutesOf } from './directory';
import { PROVIDERS } from './roster';

const TODAY = '2026-09-24';
const dir = new DemoDirectory(TODAY);
const KEYS = PROVIDERS.map((p) => p.key);

/** True when a caller's booking lands on a weekday, after `today`, within the fortnight. */
function isValidBooking(booking: { date: string }, today: string): boolean {
  const day = new Date(parseIso(booking.date)).getUTCDay();
  return day >= 1 && day <= 5 && booking.date > today && booking.date <= addDays(today, 14);
}

describe('dayparts', () => {
  it('splits the day at 11 and 2', () => {
    expect(daypartOf('10:59 AM')).toBe('morning');
    expect(daypartOf('11:00 AM')).toBe('midday');
    expect(daypartOf('1:59 PM')).toBe('midday');
    expect(daypartOf('2:00 PM')).toBe('afternoon');
    expect(DAYPART_ORDER).toEqual(['morning', 'midday', 'afternoon']);
    expect(daypartBounds('midday')).toEqual({ start: 660, end: 840 });
    expect(isDaypart('midday')).toBe(true);
    expect(isDaypart('evening')).toBe(false);
  });

  it('reads clock times and rejects anything else', () => {
    expect(minutesOf('12:30 PM')).toBe(750);
    expect(minutesOf('12:05 AM')).toBe(5);
    expect(() => minutesOf('noon')).toThrow(/not a clock time/);
  });

  it('has three demo times in each part of the day, in clock order', () => {
    expect(DEMO_TIMES.map(daypartOf)).toEqual(['morning', 'morning', 'morning', 'midday', 'midday', 'midday', 'afternoon', 'afternoon', 'afternoon']);
    const mins = DEMO_TIMES.map(minutesOf);
    expect([...mins].sort((a, b) => a - b)).toEqual(mins);
  });
});

describe('DemoDirectory', () => {
  it('finds the same booking for the same caller every time, on a weekday within a fortnight', () => {
    const a = dir.find('morgan ellis', '1975-06-14', 'chen');
    expect(dir.find('morgan ellis', '1975-06-14', 'chen')).toEqual(a);
    expect(new DemoDirectory(TODAY).find('Morgan Ellis', '1975-06-14', 'chen')).toEqual(a);
    expect(isValidBooking(a, TODAY)).toBe(true);
    expect(DEMO_TIMES).toContain(a.time);
  });

  it('gives different callers different bookings', () => {
    expect(dir.find('morgan ellis', '1975-06-14', 'chen')).not.toEqual(dir.find('robin shaw', '2000-01-01', 'chen'));
  });

  it('stays inside the fortnight when today sits right at the weekday boundary', () => {
    // A Friday and a Saturday today push the weekend-skipping walk against both edges of the
    // fortnight from a different starting weekday than TODAY does.
    for (const today of ['2026-09-25', '2026-09-26']) {
      const d = new DemoDirectory(today);
      for (const [name, dob] of [['morgan ellis', '1975-06-14'], ['robin shaw', '2000-01-01'], ['dana whitfield', '1992-11-30']] as const) {
        expect(isValidBooking(d.find(name, dob, 'chen'), today)).toBe(true);
      }
    }
  });

  it('offers three openings in clock order, the same on every call', () => {
    const times = dir.openings('chen', '2026-10-06');
    expect(times).toHaveLength(3);
    expect(new Set(times).size).toBe(3);
    expect(times.map(minutesOf)).toEqual([...times.map(minutesOf)].sort((a, b) => a - b));
    expect(dir.openings('chen', '2026-10-06')).toEqual(times);
    expect(dir.openings('kim', '2026-10-06')).not.toEqual(times);
  });

  it('terminates and stays in the table for every provider and day in a month', () => {
    for (const p of KEYS) {
      for (let d = 0; d < 31; d += 1) {
        const times = dir.openings(p, addDays(TODAY, d));
        expect(times).toHaveLength(3);
        for (const t of times) expect(DEMO_TIMES).toContain(t);
      }
    }
  });

  it('spreads openings across the day: some days cover all three parts, some miss one', () => {
    let oneEach = 0;
    let missingOne = 0;
    for (const p of KEYS) {
      for (let d = 0; d < 31; d += 1) {
        const parts = new Set(dir.openings(p, addDays(TODAY, d)).map(daypartOf));
        if (parts.size === 3) oneEach += 1;
        else missingOne += 1;
      }
    }
    // Both the ordinary case and the one the nearest-opening rule needs (a day that skips a part)
    // must turn up. A fair draw covers every part in 27 of the 84 possible sets, about 80 of these
    // 248 days; 40 leaves room.
    expect(oneEach).toBeGreaterThan(40);
    expect(missingOne).toBeGreaterThan(0);
  });

  it('draws three distinct times for a seed that once stalled a shift-based draw', () => {
    expect(dir.openings('okafor', '2026-10-19')).toHaveLength(3);
  });

  it('hashes stably and case-insensitively', () => {
    expect(hashOf('Chen')).toBe(hashOf('chen'));
    expect(hashOf('a')).not.toBe(hashOf('b'));
  });
});
