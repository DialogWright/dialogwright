import { describe, expect, it } from 'vitest';
import { keyEvents, speechEvent } from '../channel/events';
import { CODE_MASK, maskCodeEvent, maskSpokenCode, saidCode, spokenCodeMinDigits } from './spokenCode';

describe('maskSpokenCode', () => {
  it.each([
    ['one two three four five six', CODE_MASK],
    ['the code is 482916', `the code is ${CODE_MASK}`],
    ['4 8 2 9 1 6', CODE_MASK],
    ['482 916', CODE_MASK],
    ['4-8-2-9-1-6 i think', `${CODE_MASK} i think`],
    ['it says double four eight two nine one', `it says ${CODE_MASK}`],
    ['oh four eight two, nine one', CODE_MASK],
    ['four eighty two nine sixteen', CODE_MASK],
    ['four hundred and eighty two', CODE_MASK],
    ['for eight too won', CODE_MASK],
    ['the code is for eight two nine one six', `the code is ${CODE_MASK}`],
    ['ate to for one', CODE_MASK],
    ['it is one two three four and then five six', `it is ${CODE_MASK} and then five six`],
  ])('masks %j', (said, masked) => {
    expect(maskSpokenCode(said)).toEqual({ text: masked, masked: true });
  });

  it.each([
    'i did not get a text',
    'i want to talk to someone',
    'i need to go to my phone for it',
    'can i talk to a person',
    'one moment',
    'hang on two seconds',
    'i have one two three',
    'it ends in 12',
    '',
  ])('leaves %j alone', (said) => {
    expect(maskSpokenCode(said)).toEqual({ text: said, masked: false });
  });

  it('never leaves a digit of a masked code behind', () => {
    const { text } = maskSpokenCode('um it is four eight two nine one six thanks');
    expect(text).toBe(`um it is ${CODE_MASK} thanks`);
    expect(text).not.toMatch(/\d|four|eight|two|nine|one|six/);
  });

  it('is a no-op on text it already masked', () => {
    const once = maskSpokenCode('one two three four five six').text;
    expect(maskSpokenCode(once)).toEqual({ text: once, masked: false });
    expect(saidCode(once)).toBe(true);
  });
});

describe('maskCodeEvent', () => {
  it('masks a spoken turn only while the code prompt is open', () => {
    const frame = speechEvent('one two three four five six');
    expect(maskCodeEvent('otp', frame)).toMatchObject({ type: 'user.speech', text: CODE_MASK });
    expect(maskCodeEvent('accountId', frame)).toBe(frame);
    expect(maskCodeEvent(null, frame)).toBe(frame);
  });

  it('masks by the app\'s code length: three digits of a four-digit code, four of a longer one', () => {
    expect([4, 5, 6, 8].map((n) => spokenCodeMinDigits(n))).toEqual([3, 4, 4, 4]);
    expect(spokenCodeMinDigits()).toBe(4);
    const three = speechEvent('it is two four six');
    expect(maskCodeEvent('otp', three, 4)).toMatchObject({ text: `it is ${CODE_MASK}` });
    expect(maskCodeEvent('otp', three)).toBe(three);
    expect(maskCodeEvent('otp', three, 8)).toBe(three);
    expect(maskCodeEvent('otp', speechEvent('one three five seven two four six eight'), 8)).toMatchObject({ text: CODE_MASK });
    expect(maskSpokenCode('two four six', 3)).toEqual({ text: CODE_MASK, masked: true });
  });

  it('a short code: ordinary speech with a sound-alike is not a code, and a real one still is', () => {
    for (const said of ['I got it for twenty', 'two to three minutes', 'ten to one', 'yes, for two', 'too late for one']) {
      expect(maskSpokenCode(said, 3), said).toEqual({ text: said, masked: false });
      expect(maskCodeEvent('otp', speechEvent(said), 4), said).toMatchObject({ text: said });
    }
    expect(maskSpokenCode('one two three', 3)).toEqual({ text: CODE_MASK, masked: true });
    expect(maskCodeEvent('otp', speechEvent('it is four two nine one'), 4)).toMatchObject({ text: `it is ${CODE_MASK}` });
    expect(maskCodeEvent('otp', speechEvent('the code is 4291'), 4)).toMatchObject({ text: `the code is ${CODE_MASK}` });
    // A code of six (runs of four): the sound-alikes still count, the safe side.
    expect(maskSpokenCode('for eight to won')).toEqual({ text: CODE_MASK, masked: true });
  });

  it('leaves a keyed digit alone: the keypad has its own masking', () => {
    const [digit] = keyEvents('4');
    expect(maskCodeEvent('otp', digit!)).toBe(digit);
  });
});
