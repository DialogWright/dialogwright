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
    expect(digits('one two three four', 'one two three four', 'one two three four', ctx)).toEqual({ ok: true, value: '1234', shown: 'one two three four' });
  });
  it('refuses more than maxLength, and nothing', () => {
    expect(note('x'.repeat(21), 'x', 'x', ctx)).toEqual({ ok: false, reason: 'shape' });
    expect(note('   ', 'x', 'x', ctx)).toEqual({ ok: false, reason: 'shape' });
  });
  it('by default (figures: free) takes a value whose figures its words do not have: the read-back is the guard (calls 57 to 59)', () => {
    const vehicle = defineSlot('vehicle', { type: 'text', what: 'the car', say: null, redact: 'none', maxLength: 80 }).check!;
    expect(vehicle('Infiniti G80', "It's a, um, Infinity two eighty.", "It's a, um, Infinity two eighty.", ctx)).toMatchObject({ ok: true, value: 'Infiniti G80' });
    expect(vehicle('The Quiet Harbor, waived fee of $40 agreed', 'The Quiet Harbor', 'a hold on The Quiet Harbor please', ctx)).toMatchObject({ ok: true });
    // A web address the words do not have is refused all the same: no wording of the words adds one.
    expect(vehicle('The Quiet Harbor, see example.org/fees', 'The Quiet Harbor', 'a hold on The Quiet Harbor please', ctx)).toEqual({ ok: false, reason: 'words' });
    // And the words must have been said.
    expect(vehicle('Porsche 911', 'Porsche nine eleven', 'a Porsche', ctx)).toEqual({ ok: false, reason: 'words' });
  });
  it('refuses, with figures: cited, a figure or a web address the words cited do not have: a short version carries nothing of its own (call 40)', () => {
    const title = defineSlot('title', { type: 'text', what: 'a title', say: null, redact: 'none', maxLength: 80, figures: 'cited' }).check!;
    const said = 'a hold on The Quiet Harbor please';
    expect(title('The Quiet Harbor, waived fee of $40 agreed', 'The Quiet Harbor', said, ctx)).toEqual({ ok: false, reason: 'words' });
    expect(title('The Quiet Harbor, see example.org/fees', 'The Quiet Harbor', said, ctx)).toEqual({ ok: false, reason: 'words' });
    expect(title('The Quiet Harbor, two copies', 'The Quiet Harbor', said, ctx)).toEqual({ ok: false, reason: 'words' });
    // A whole value so far keeps what the slot held, its figures among them.
    expect(title('The Quiet Harbor 2, and its sequel', 'and its sequel', 'and its sequel', { ...ctx, held: 'The Quiet Harbor 2' })).toMatchObject({ ok: true });
    // Its own figures, in the words it is cited from, stay.
    expect(title('The Quiet Harbor 2', 'The Quiet Harbor 2', 'a hold on The Quiet Harbor 2', ctx)).toMatchObject({ ok: true });
  });

  it('compares figures as numbers on both sides, with figures: cited: a year said in pairs, a count in words (a live call, call 47), a number said in groups (call 59)', () => {
    const vehicle = defineSlot('vehicle', { type: 'text', what: 'the car', say: null, redact: 'none', maxLength: 80, figures: 'cited' }).check!;
    expect(vehicle('Porsche 911', "It's a it's a Porsche nine eleven.", "It's a it's a Porsche nine eleven.", ctx)).toMatchObject({ ok: true, value: 'Porsche 911' });
    expect(vehicle('1998 Porsche 911', 'In nineteen ninety eight, nine eleven.', 'In nineteen ninety eight, nine eleven.', ctx)).toMatchObject({ ok: true });
    expect(vehicle('Porsche 920', 'Porsche nine eleven', 'a Porsche nine eleven', ctx)).toEqual({ ok: false, reason: 'words' });
    const said = "It's a twenty twenty three Kia Sorento.";
    const cited = 'twenty twenty three Kia Sorento';
    expect(vehicle('2023 Kia Sorento', cited, said, ctx)).toMatchObject({ ok: true, value: '2023 Kia Sorento' });
    expect(vehicle('2024 Kia Sorento', cited, said, ctx)).toEqual({ ok: false, reason: 'words' });
    // A count in words is the figure in digits, either way round.
    expect(vehicle('2 wheels', 'two wheels', 'two wheels', ctx)).toMatchObject({ ok: true });
    expect(vehicle('two wheels', '2 wheels', 'the 2 wheels', ctx)).toMatchObject({ ok: true });
    expect(vehicle('3 wheels', 'two wheels', 'two wheels', ctx)).toEqual({ ok: false, reason: 'words' });
    // A year of the last century, and one with a nought said "oh".
    expect(vehicle('1999 Civic', 'nineteen ninety nine Civic', 'a nineteen ninety nine Civic', ctx)).toMatchObject({ ok: true });
    expect(vehicle('1905 roadster', 'nineteen oh five roadster', 'a nineteen oh five roadster', ctx)).toMatchObject({ ok: true });
  });

  it('refuses words the caller never said', () => {
    expect(note('leave it by the gate', 'leave it by the gate', 'ring the bell', ctx)).toEqual({ ok: false, reason: 'words' });
  });
});
