import { describe, expect, it } from 'vitest';
import { WRITTEN_RULES, writtenForm, writtenRulesFor } from './written';

const digits = (text: string, locale?: string): string => writtenForm(text, { numbers: 'digits', case: 'as-said' }, locale);
const title = (text: string, locale?: string): string => writtenForm(text, { numbers: 'words', case: 'title' }, locale);
const both = (text: string, locale?: string): string => writtenForm(text, { numbers: 'digits', case: 'title' }, locale);

describe('numbers: digits in English', () => {
  it.each([
    // Digit words in sequence concatenate.
    ['one zero two four six aspen glade lane', '10246 aspen glade lane'],
    ['one two three', '123'],
    // "oh" or "o" between digit words is a zero.
    ['one oh two', '102'],
    ['one o two', '102'],
    ['two oh oh one', '2001'],
    ['nineteen oh five', '1905'],
    // House-number pairs, and the ways a number is said whole.
    ['seventy six twenty five oak hollow lane', '7625 oak hollow lane'],
    ['eighty six', '86'],
    ['twelve', '12'],
    ['twenty five hundred', '2500'],
    ['two thousand four', '2004'],
    ['one hundred twenty three', '123'],
    ['five fifty five', '555'],
    ['twelve thirty four', '1234'],
    ['ten ten', '1010'],
    ['ten thousand', '10000'],
    ['one hundred thousand', '100000'],
    ['twelve thousand three hundred', '12300'],
    // Groups said differently concatenate.
    ['seven six twenty five', '7625'],
    // "a" and "and" inside a number.
    ['one hundred and five', '105'],
    ['a hundred elm road', '100 elm road'],
    ['a thousand oaks drive', '1000 oaks drive'],
    ['eleven hundred and five', '1105'],
    // A hyphenated number is one number.
    ['seventy-six twenty-five oak hollow lane', '7625 oak hollow lane'],
    // Case aside.
    ['Seventy Six Twenty Five Oak Hollow Lane', '7625 Oak Hollow Lane'],
    // Runs parted by other words stay apart.
    ['unit four at twenty two alder street', 'unit 4 at 22 alder street'],
    ['five and six', '5 and 6'],
    // Punctuation the caller's words carry parts two runs.
    ['seventy six, twenty five', '76, 25'],
  ])('%j -> %j', (said, written) => expect(digits(said)).toBe(written));

  it.each([
    // Digits already there stay as they are.
    ['22 alder street', '22 alder street'],
    ['22-24 alder street', '22-24 alder street'],
    ['the 3rd house', 'the 3rd house'],
    // Ordinals in a street's name stay words, and so does the tens word that goes with one.
    ['twenty third street', 'twenty third street'],
    ['twenty-third street', 'twenty-third street'],
    ['fifth avenue', 'fifth avenue'],
    ['first street', 'first street'],
    // A house number before an ordinal street is still written.
    ['seventy six twenty third street', '76 twenty third street'],
    ['one oh two fifth avenue', '102 fifth avenue'],
    ['one twenty first street', '1 twenty first street'],
    // An ordinal that goes with a hundred keeps the whole number as words: which part is the house is not clear.
    ['one hundred first street', 'one hundred first street'],
    ['one hundred and first street', 'one hundred and first street'],
    ['one hundred twenty first street', 'one hundred twenty first street'],
    // "oh" that is not between two digit words is a word.
    ['oh I see', 'oh I see'],
    ['oh it is twenty two alder street', 'oh it is 22 alder street'],
    ['twenty two oh', '22 oh'],
    ['O\'Neil Road', 'O\'Neil Road'],
    // "and" and "a" outside a number are words.
    ['the corner of Elm and Third', 'the corner of Elm and Third'],
    ['a house on elm and a shed', 'a house on elm and a shed'],
    // A scale word alone is not a number.
    ['hundred acre wood', 'hundred acre wood'],
    // No number words at all.
    ['Maple Avenue', 'Maple Avenue'],
    ['', ''],
  ])('%j stays %j', (said, written) => expect(digits(said)).toBe(written));

  it('converts "one" in prose too: it runs only on a slot\'s value, which pick has cut to the part that is the value', () => {
    expect(digits('one main street')).toBe('1 main street');
    expect(digits('one moment please')).toBe('1 moment please');
  });

  it('keeps every other character of the words as said', () => {
    expect(digits('  it is  seventy six   twenty five, by the school.  ')).toBe('  it is  7625, by the school.  ');
  });
});

describe('case: title in English', () => {
  it('capitalizes each word of words written in lower case, minor words after the first aside', () => {
    expect(title('seventy six twenty five oak hollow lane')).toBe('Seventy Six Twenty Five Oak Hollow Lane');
    expect(title('the corner of elm and third')).toBe('The Corner of Elm and Third');
    expect(title('22 alder street')).toBe('22 Alder Street');
  });

  it('leaves words with any capital as they were written: the recognizer or the caller cased them', () => {
    expect(title('the corner of Elm and Third')).toBe('the corner of Elm and Third');
    expect(title('22 Alder Street')).toBe('22 Alder Street');
  });

  it('writes the numbers first, then the case', () => {
    expect(both('seventy six twenty five oak hollow lane')).toBe('7625 Oak Hollow Lane');
    expect(both('one zero two four six aspen glade lane')).toBe('10246 Aspen Glade Lane');
    expect(both('twenty third street')).toBe('Twenty Third Street');
    expect(both('twelve oak hollow road')).toBe('12 Oak Hollow Road');
  });
});

describe('the language of the words', () => {
  it('reads English with no locale and in any en-* tag', () => {
    expect(digits('twenty two alder street')).toBe('22 alder street');
    expect(digits('twenty two alder street', 'en-US')).toBe('22 alder street');
    expect(digits('twenty two alder street', 'en_GB')).toBe('22 alder street');
    expect(writtenRulesFor('EN-us')).toBe(WRITTEN_RULES.en);
  });

  it('leaves the words alone in a language with no rules', () => {
    expect(writtenRulesFor('es')).toBeUndefined();
    expect(digits('veinte dos calle Alder', 'es')).toBe('veinte dos calle Alder');
    expect(digits('twenty two alder street', 'fr-CA')).toBe('twenty two alder street');
    expect(title('calle alder', 'es')).toBe('calle alder');
  });

  it('with neither option, changes nothing in any language', () => {
    expect(writtenForm('seventy six oak lane', { numbers: 'words', case: 'as-said' })).toBe('seventy six oak lane');
  });
});
