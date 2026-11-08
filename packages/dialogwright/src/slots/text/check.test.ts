import { describe, expect, it } from 'vitest';
import { defineSlot } from '../defineSlot';

const ctx = { today: '2026-09-18' };
const note = defineSlot('note', { type: 'text', what: 'a note', maxLength: 20 }).check!;

describe('text check', () => {
  it('accepts words, shown as the stand-in the display says', () => {
    expect(note('leave it by the gate', 'leave it by the gate', 'please leave it by the gate', ctx)).toEqual({ ok: true, value: 'leave it by the gate', shown: 'your description' });
  });
  it('accepts a short version of the words cited', () => {
    expect(note('gate', 'leave it by the gate', 'please leave it by the gate', ctx)).toEqual({ ok: true, value: 'gate', shown: 'your description' });
  });
  it('shows the words themselves for a slot with no stand-in', () => {
    const plain = defineSlot('note', { type: 'text', what: 'a note', say: null, redact: 'none' }).check!;
    expect(plain('by the gate', 'by the gate', 'by the gate', ctx)).toEqual({ ok: true, value: 'by the gate', shown: 'by the gate' });
  });
  it('writes numbers as the slot writes them', () => {
    const address = defineSlot('where', { type: 'text', what: 'an address', say: null, redact: 'none', numbers: 'digits' }).check!;
    expect(address('seventy six twenty five oak hollow lane', 'seventy six twenty five oak hollow lane', 'seventy six twenty five oak hollow lane', ctx)).toEqual({ ok: true, value: '7625 oak hollow lane', shown: 'seventy six twenty five oak hollow lane' });
  });
  it('measures maxLength on the value as given, before writing', () => {
    const digits = defineSlot('where', { type: 'text', what: 'an address', say: null, redact: 'none', numbers: 'digits', maxLength: 22 }).check!;
    // 29 characters as given, 20 once written: refused. 21 as given: accepted, written shorter.
    expect(digits('seventy six twenty five oak', 'x', 'x', ctx)).toEqual({ ok: false, reason: 'shape' });
    expect(digits('one hundred twenty three', 'x', 'x', ctx)).toEqual({ ok: false, reason: 'shape' });
    expect(digits('one two three four', 'x', 'x', ctx)).toEqual({ ok: true, value: '1234', shown: 'one two three four' });
  });
  it('refuses more than maxLength, and nothing', () => {
    expect(note('x'.repeat(21), 'x', 'x', ctx)).toEqual({ ok: false, reason: 'shape' });
    expect(note('   ', 'x', 'x', ctx)).toEqual({ ok: false, reason: 'shape' });
  });
  it('refuses words the caller never said', () => {
    expect(note('leave it by the gate', 'leave it by the gate', 'ring the bell', ctx)).toEqual({ ok: false, reason: 'words' });
  });
});
