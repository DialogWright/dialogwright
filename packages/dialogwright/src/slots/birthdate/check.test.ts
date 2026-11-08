import { describe, expect, it } from 'vitest';
import { defineSlot } from '../defineSlot';

const ctx = { today: '2026-09-18' };
const dob = defineSlot('dob', { type: 'birthdate' }).check!;

describe('birthdate check', () => {
  it('accepts a real day in the past, shown as the display says it', () => {
    expect(dob('1975-06-14', 'June fourteenth nineteen seventy five', 'June fourteenth nineteen seventy five', ctx)).toEqual({ ok: true, value: '1975-06-14', shown: 'June 14th, 1975' });
  });
  it('shows a date in Spanish in the call\'s locale', () => {
    expect(dob('1975-06-14', '14 de junio de 1975', '14 de junio de 1975', { ...ctx, locale: 'es' })).toEqual({ ok: true, value: '1975-06-14', shown: '14 de junio de 1975' });
  });
  it('refuses a day that is not real', () => {
    expect(dob('1975-02-30', 'February thirtieth', 'February thirtieth', ctx)).toEqual({ ok: false, reason: 'shape' });
  });
  it('refuses today or a later day, and a year before minYear', () => {
    expect(dob('2026-09-18', 'today', 'today', ctx)).toEqual({ ok: false, reason: 'range' });
    expect(dob('1899-12-31', 'then', 'then', ctx)).toEqual({ ok: false, reason: 'range' });
    expect(defineSlot('dob', { type: 'birthdate', minYear: 1950 }).check!('1949-01-01', 'then', 'then', ctx)).toEqual({ ok: false, reason: 'range' });
  });
  it('refuses words the caller never said', () => {
    expect(dob('1975-06-14', 'June fourteenth', 'my birthday is in July', ctx)).toEqual({ ok: false, reason: 'words' });
  });
});
