import { describe, expect, it } from 'vitest';
import { defineSlot } from '../defineSlot';

// The tests' today, 2026-09-18, is a Friday.
const ctx = { today: '2026-09-18' };
const ahead = defineSlot('visit', { type: 'date', range: 'future' }).check!;
const back = defineSlot('seen', { type: 'date', range: 'past' }).check!;

describe('date check (ahead)', () => {
  it('accepts a real day to come, shown as the display says it', () => {
    expect(ahead('2026-09-24', 'Thursday', 'Thursday works', ctx)).toEqual({ ok: true, value: '2026-09-24', shown: 'Thursday, September 24' });
  });
  it('accepts today, and says a day in another year with its year', () => {
    expect(ahead('2026-09-18', 'today', 'today', ctx).ok).toBe(true);
    expect(ahead('2027-01-05', 'January fifth', 'January fifth', ctx)).toEqual({ ok: true, value: '2027-01-05', shown: 'Tuesday, January 5, 2027' });
  });
  it('shows a day in Spanish in the call\'s locale', () => {
    expect(ahead('2026-09-24', 'jueves', 'jueves', { ...ctx, locale: 'es' })).toEqual({ ok: true, value: '2026-09-24', shown: 'jueves, 24 de septiembre' });
  });
  it('refuses a day that is not real (2026-02-30)', () => {
    expect(ahead('2026-02-30', 'the thirtieth', 'the thirtieth', ctx)).toEqual({ ok: false, reason: 'shape' });
    expect(ahead('Thursday', 'Thursday', 'Thursday', ctx)).toEqual({ ok: false, reason: 'shape' });
  });
  it('refuses a day beyond the fill\'s horizon: October 2nd said now is this year\'s', () => {
    expect(ahead('2026-10-02', 'October 2nd', 'October 2nd', ctx).ok).toBe(true);
    expect(ahead('2027-10-02', 'October 2nd', 'October 2nd', ctx)).toEqual({ ok: false, reason: 'range' });
    expect(ahead('2027-02-10', 'February 10th', 'February 10th', ctx).ok).toBe(true);
  });
  it('is not tied to the words cited: Thursday names a day it does not spell', () => {
    expect(ahead('2026-09-24', 'Thursday', 'Thursday', ctx).ok).toBe(true);
  });
  it('refuses a day gone by', () => {
    expect(ahead('2026-09-17', 'yesterday', 'yesterday', ctx)).toEqual({ ok: false, reason: 'range' });
  });
  it('refuses words the caller never said', () => {
    expect(ahead('2026-09-24', 'Thursday', 'any day next week', ctx)).toEqual({ ok: false, reason: 'words' });
  });
});

describe('date check (back)', () => {
  it('accepts today and a day gone, up to two years back', () => {
    expect(back('2026-09-18', 'today', 'today', ctx).ok).toBe(true);
    expect(back('2026-09-10', 'the tenth', 'the tenth', ctx).ok).toBe(true);
    expect(back('2024-09-19', 'then', 'then', ctx).ok).toBe(true);
  });
  it('refuses a day to come, and one too far back', () => {
    expect(back('2026-09-19', 'tomorrow', 'tomorrow', ctx)).toEqual({ ok: false, reason: 'range' });
    expect(back('2024-09-17', 'then', 'then', ctx)).toEqual({ ok: false, reason: 'range' });
  });
});
