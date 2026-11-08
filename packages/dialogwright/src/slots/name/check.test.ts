import { describe, expect, it } from 'vitest';
import { defineSlot } from '../defineSlot';

const ctx = { today: '2026-09-18' };
const name = defineSlot('name', { type: 'name' }).check!;

describe('name check', () => {
  it('accepts a name among the spans of the words, as the fill stores it, shown title-cased', () => {
    expect(name('Morgan  Ellis', 'my name is Morgan Ellis', 'my name is morgan ellis', ctx)).toEqual({ ok: true, value: 'morgan ellis', shown: 'Morgan Ellis' });
    expect(name('Cher', 'Cher', 'it\'s Cher', ctx).ok).toBe(true);
  });
  it('shows a Spanish name in the call\'s locale', () => {
    expect(name('muñoz de la cruz', 'soy muñoz de la cruz', 'soy muñoz de la cruz', { ...ctx, locale: 'es' })).toEqual({ ok: true, value: 'muñoz de la cruz', shown: 'Muñoz de la Cruz' });
  });
  it('refuses an empty name and one over 60 characters', () => {
    expect(name('  ', 'x', 'x', ctx)).toEqual({ ok: false, reason: 'shape' });
    expect(name('a'.repeat(61), 'a', 'a', ctx)).toEqual({ ok: false, reason: 'shape' });
  });
  it('refuses digits, markup, more words than a name may have, and a name the words do not hold', () => {
    expect(name('agent 007', 'agent 007', 'agent 007', ctx)).toEqual({ ok: false, reason: 'shape' });
    expect(name('<b>Sam</b>', '<b>Sam</b>', '<b>Sam</b>', ctx)).toEqual({ ok: false, reason: 'shape' });
    expect(name('one two three four five six', 'one two three four five six', 'one two three four five six', ctx)).toEqual({ ok: false, reason: 'shape' });
    expect(name('Sam Lee', 'Sam', 'Sam', ctx)).toEqual({ ok: false, reason: 'shape' });
  });
  it('refuses a name holding an excluded word', () => {
    const slot = defineSlot('name', { type: 'name', exclude: ['Chen'] }).check!;
    expect(slot('Sam Chen', 'Sam Chen', 'Sam Chen', ctx)).toEqual({ ok: false, reason: 'shape' });
    expect(slot('Sam', 'Sam Chen', 'Sam Chen', ctx).ok).toBe(true);
  });
  it('refuses words the caller never said', () => {
    expect(name('Morgan Ellis', 'Morgan Ellis', 'my name is Sam', ctx)).toEqual({ ok: false, reason: 'words' });
  });
});
