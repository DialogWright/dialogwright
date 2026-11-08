import { describe, expect, it } from 'vitest';
import { defineSlot } from '../defineSlot';

const ctx = { today: '2026-09-18' };
const name = defineSlot('name', { type: 'name' }).check!;

describe('name check', () => {
  it('accepts a name, stored as a fill stores it and shown title-cased', () => {
    expect(name('Morgan  Ellis', 'Morgan Ellis', 'my name is morgan ellis', ctx)).toEqual({ ok: true, value: 'morgan ellis', shown: 'Morgan Ellis' });
  });
  it('shows a Spanish name in the call\'s locale', () => {
    expect(name('muñoz de la cruz', 'muñoz de la cruz', 'soy muñoz de la cruz', { ...ctx, locale: 'es' })).toEqual({ ok: true, value: 'muñoz de la cruz', shown: 'Muñoz de la Cruz' });
  });
  it('refuses an empty name and one over 60 characters', () => {
    expect(name('  ', 'x', 'x', ctx)).toEqual({ ok: false, reason: 'shape' });
    expect(name('a'.repeat(61), 'a', 'a', ctx)).toEqual({ ok: false, reason: 'shape' });
    expect(name('a'.repeat(60), 'a', 'a', ctx).ok).toBe(true);
  });
  it('refuses words the caller never said', () => {
    expect(name('Morgan Ellis', 'Morgan Ellis', 'my name is Sam', ctx)).toEqual({ ok: false, reason: 'words' });
  });
});
