import { describe, expect, it } from 'vitest';
import { SPANISH } from './lexicon';
import { spokenToDigits, yearPairAt } from './spokenNumber';

describe('spokenToDigits', () => {
  it.each([
    ['four four seven one eight two nine three', '44718293'],
    ['forty four seventy one eighty two ninety three', '44718293'],
    ['double four 71 82 93', '44718293'],
    ['my account id is 4471 8293', '44718293'],
    ['eight oh seven', '807'],
    ['twelve fifteen', '1215'],
    ['twenty', '20'],
    ['triple seven', '777'],
    ['four-four-seven', '447'],
    ['hello there', ''],
    ['forty please hold four', '404'],
    ['double please four', '4'],
  ])('%s -> %s', (input, expected) => {
    expect(spokenToDigits(input)).toBe(expected);
  });

  it('is not fooled by a word an object has, such as "constructor": it is no number word, as in Spanish', () => {
    // Before, "constructor" was read as a repeat ("in" found it on the table's prototype) and the
    // next digit repeated "constructor" times: no digits at all.
    expect(spokenToDigits('constructor five')).toBe('5');
    expect(spokenToDigits('double constructor five')).toBe('5');
    expect(spokenToDigits('five toString six')).toBe('56');
    expect(spokenToDigits('valueOf hasOwnProperty seven __proto__ eight')).toBe('78');
    expect(spokenToDigits('constructor five', 'en-US')).toBe('5');
  });
});

describe('chunked groups', () => {
  it.each([
    // a multiplier scales the group built so far
    ['three hundred five', '305'],
    ['two hundred', '200'],
    ['three hundred fifty', '350'],
    ['two thousand five', '2005'],
    // a small number spoken right after a multiplier adds into the group
    ['forty four one eighty seven three hundred fifty five', '44187355'],
    ['four four one eight seven three hundred five', '44187305'],
    // "and" is transparent inside a group
    ['four hundred and twelve', '412'],
    // an unknown word closes the current group
    ['three hundred please fifty five', '30055'],
    // digit and word groups still concatenate group by group
    ['44 187 355', '44187355'],
    ['one eighty seven', '187'],
    // multipliers compose the way English does, including thousands
    ['two thousand five hundred', '2500'],
    ['one thousand two hundred thirty four', '1234'],
    ['two hundred thousand', '200000'],
    ['twenty hundred', '2000'],
    // a spoken zero always starts its own digit, never composing into a group
    ['three hundred oh five', '30005'],
    ['three hundred zero five', '30005'],
    // a repeated digit doesn't open a group for a following multiplier to compose into
    ['double four hundred', '44100'],
  ])('%s -> %s', (input, expected) => {
    expect(spokenToDigits(input)).toBe(expected);
  });
});

describe('a year said in pairs (yearPairAt)', () => {
  const at = (text: string, i = 0, lex?: typeof SPANISH) => yearPairAt(text.split(' '), i, lex);
  it('reads the two pairs as the year: a teen or a tens word, with its unit, or a nought and a unit', () => {
    expect(at('twenty twenty three kia')).toEqual({ value: 2023, next: 3 });
    expect(at('nineteen ninety nine')).toEqual({ value: 1999, next: 3 });
    expect(at('twenty twenty')).toEqual({ value: 2020, next: 2 });
    expect(at('nineteen oh five')).toEqual({ value: 1905, next: 3 });
    expect(at('twenty twelve')).toEqual({ value: 2012, next: 2 });
    expect(at('a twenty twenty three', 1)).toEqual({ value: 2023, next: 4 });
  });
  it('reads no year where the words are a count, a number said whole, or a nought with no unit', () => {
    expect(at('twenty one')).toBeNull();
    expect(at('two thousand twenty three')).toBeNull();
    expect(at('thirty forty')).toBeNull();
    expect(at('nineteen oh')).toBeNull();
    expect(at('twenty')).toBeNull();
  });
  it('reads none in a language that says its years whole', () => {
    expect(at('veinte veinte', 0, SPANISH)).toBeNull();
  });
  it('agrees with the digits spokenToDigits reads', () => {
    for (const said of ['twenty twenty three', 'nineteen ninety nine', 'nineteen oh five', 'twenty twenty']) expect(String(at(said)!.value)).toBe(spokenToDigits(said));
  });
});
