import { describe, expect, it } from 'vitest';
import { buildSlot, defineSlot } from '../defineSlot';

const today = '2026-09-18';
const slot = defineSlot('count', { type: 'choice', options: { one: { say: 'one copy' }, two: { say: 'two copies' }, three: 'three copies', four: 'four copies' } });
const check = slot.check!;

describe('choice check', () => {
  it('accepts an option key, shown as the display says it', () => {
    expect(check('two', 'two copies', 'I need two copies', { today })).toEqual({ ok: true, value: 'two', shown: 'two copies' });
  });
  it('accepts an option\'s say text without regard to case or punctuation, and gives the key', () => {
    expect(check('Four Copies!', 'four', 'all four', { today })).toEqual({ ok: true, value: 'four', shown: 'four copies' });
  });
  it('is not tied to the words cited: they may be a synonym', () => {
    expect(check('two', 'a couple', 'a couple of them', { today }).ok).toBe(true);
  });
  it('refuses words the caller never said', () => {
    expect(check('two', 'two copies', 'I need a refund', { today })).toEqual({ ok: false, reason: 'words' });
  });
  it('refuses a value that is no option (five against one to four)', () => {
    expect(check('five', 'five', 'five of them', { today })).toEqual({ ok: false, reason: 'shape' });
  });
  it('refuses a value that matches more than one option', () => {
    const twice = defineSlot('seat', { type: 'choice', options: { aisle: { say: 'window' }, window: { say: 'aisle' } } }).check!;
    expect(twice('window', 'window', 'window', { today })).toEqual({ ok: false, reason: 'shape' });
    const same = defineSlot('seat', { type: 'choice', options: { aisle: { say: 'the seat' }, window: { say: 'The seat.' } } }).check!;
    expect(same('the seat', 'seat', 'seat', { today })).toEqual({ ok: false, reason: 'shape' });
  });
  it('says an option in the call\'s locale when a locale gives its own words', () => {
    const built = buildSlot('branch', { type: 'choice', options: { north: { say: 'the north branch' } } }, { wording: { es: { options: { north: 'Norte' } } } });
    if (!built.ok) throw new Error('does not build');
    const es = built.spec.check!;
    expect(es('norte', 'norte', 'norte', { today, locale: 'es' })).toEqual({ ok: true, value: 'north', shown: 'Norte' });
    expect(es('norte', 'norte', 'norte', { today })).toEqual({ ok: false, reason: 'shape' });
    expect(es('north', 'north', 'north', { today })).toEqual({ ok: true, value: 'north', shown: 'the north branch' });
  });
});
