import { describe, expect, it } from 'vitest';
import { defineSlot } from '../defineSlot';

const today = '2026-09-18';
const slot = defineSlot('count', { type: 'choice', options: { one: { say: 'one wheel' }, two: { say: 'two wheels' }, three: 'three wheels', four: 'four wheels' } });
const check = slot.check!;

describe('choice check', () => {
  it('accepts an option key, shown as the display says it', () => {
    expect(check('two', 'two wheels', 'I need two wheels done', { today })).toEqual({ ok: true, value: 'two', shown: 'two wheels' });
  });
  it('accepts an option\'s say text without regard to case, and gives the key', () => {
    expect(check('Four Wheels', 'four', 'all four', { today })).toEqual({ ok: true, value: 'four', shown: 'four wheels' });
  });
  it('refuses words the caller never said', () => {
    expect(check('two', 'two wheels', 'I need new tires', { today })).toEqual({ ok: false, reason: 'words' });
  });
  it('refuses a value that is no option (five against one to four)', () => {
    expect(check('five', 'five', 'five of them', { today })).toEqual({ ok: false, reason: 'shape' });
  });
  it('says an option in the call\'s locale when a locale gives its own words', () => {
    const es = defineSlot('count', { type: 'choice', options: { one: { say: 'one wheel' } } }, undefined, {});
    expect(es.check!('one', 'one', 'one', { today, locale: 'es' }).ok).toBe(true);
  });
});
