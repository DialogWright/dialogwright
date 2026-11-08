import { describe, expect, it } from 'vitest';
import { defineSlot } from '../defineSlot';

const today = '2026-09-18';
const phone = defineSlot('phone', { type: 'digits', noun: 'phone', length: 10, group: [3, 3, 4] }).check!;
const card = defineSlot('card', { type: 'digits', noun: 'card', mask: '5\\d{7}' }).check!;

describe('digits check', () => {
  it('accepts digits of the slot\'s length, shown grouped as the display says', () => {
    expect(phone('5555550142', 'five five five five five five zero one four two', 'it is five five five five five five zero one four two', { today })).toEqual({ ok: true, value: '5555550142', shown: '555 555 0142' });
  });
  it('accepts digits matching the slot\'s pattern', () => {
    expect(card('51234567', '51234567', 'card 51234567', { today })).toEqual({ ok: true, value: '51234567', shown: '51234567' });
    expect(card('61234567', '61234567', 'card 61234567', { today })).toEqual({ ok: false, reason: 'shape' });
  });
  it('refuses nine digits for a length of ten', () => {
    expect(phone('555555014', '555555014', '555555014', { today })).toEqual({ ok: false, reason: 'shape' });
  });
  it('refuses a value that is not digits', () => {
    expect(phone('555-555-0142', '555 555 0142', '555 555 0142', { today })).toEqual({ ok: false, reason: 'shape' });
  });
  it('ties the value to the words cited: number words, or digits said in parts', () => {
    expect(phone('5555550142', '555-555-0142', 'it is 555-555-0142', { today }).ok).toBe(true);
    expect(phone('5555550142', 'five five five five five five zero one four two', 'five five five five five five zero one four two', { today }).ok).toBe(true);
    expect(phone('5555550199', 'five five five five five five zero one four two', 'five five five five five five zero one four two', { today })).toEqual({ ok: false, reason: 'words' });
  });
  it('reads number words in the call\'s language', () => {
    expect(phone('5555550142', 'cinco cinco cinco cinco cinco cinco cero uno cuatro dos', 'cinco cinco cinco cinco cinco cinco cero uno cuatro dos', { today, locale: 'es' }).ok).toBe(true);
  });
  it('refuses words the caller never said', () => {
    expect(phone('5555550142', '5555550142', 'my number is 5555550199', { today })).toEqual({ ok: false, reason: 'words' });
  });
});
