import { describe, expect, it } from 'vitest';
import { ENGLISH, isSpanish, lexiconOf, SPANISH } from './lexicon';
import { numbersSaid } from './numbersSaid';
import { MULTIPLIER_WORDS, NUMBER_WORDS, spokenToDigits, tokenize } from './spokenNumber';

describe('the lexicon a locale reads words with', () => {
  it('is Spanish for es and every es-* tag, English for any other locale and for none', () => {
    for (const tag of ['es', 'es-US', 'es-MX', 'ES', 'es_mx']) {
      expect(isSpanish(tag)).toBe(true);
      expect(lexiconOf(tag)).toBe(SPANISH);
    }
    for (const tag of [undefined, 'en-US', 'en', 'fr', 'pt-BR', 'eso', 'est']) {
      expect(isSpanish(tag)).toBe(false);
      expect(lexiconOf(tag)).toBe(ENGLISH);
    }
  });

  it('keeps the English tables the engine has always read numbers with', () => {
    expect([...NUMBER_WORDS]).toEqual([
      'zero', 'oh', 'o', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
      'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen',
      'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety', 'double', 'triple', 'hundred', 'thousand',
    ]);
    expect([...MULTIPLIER_WORDS]).toEqual(['hundred', 'thousand']);
  });
});

describe('tokenize', () => {
  it('in English (no locale, en-US) keeps ASCII letters and digits only, as always', () => {
    expect(tokenize('María José, 5552-0417!')).toEqual(['mar', 'a', 'jos', '5552', '0417']);
    expect(tokenize('María José', 'en-US')).toEqual(['mar', 'a', 'jos']);
  });

  it('in Spanish keeps every letter with its accents, in lower case, composed', () => {
    expect(tokenize('María José Muñoz, ¿sí? 5552-0417', 'es')).toEqual(['maría', 'josé', 'muñoz', 'sí', '5552', '0417']);
    // a decomposed accent (e and a combining acute) is one letter, composed
    expect(tokenize('José', 'es-US')).toEqual(['josé']);
  });
});

describe('spokenToDigits in Spanish', () => {
  it.each([
    // digit by digit
    ['cinco cinco cinco dos cero cuatro uno siete', '55520417'],
    ['mi tarjeta es el cinco cinco cinco uno dos tres cuatro cinco', '55512345'],
    // tens joined to their unit by "y", and without it
    ['cincuenta y cinco', '55'],
    ['cincuenta cinco', '55'],
    ['cincuenta y cinco cincuenta y dos cero cuatro diecisiete', '55520417'],
    ['treinta y', '30'],
    ['veinte', '20'],
    // one word for 10 to 29
    ['diez once doce trece catorce quince', '101112131415'],
    ['dieciséis diecisiete dieciocho diecinueve', '16171819'],
    ['veintiuno veintidós veintitrés veinticuatro veinticinco veintiséis veintisiete veintiocho veintinueve', '212223242526272829'],
    // accents are optional
    ['dieciseis veintidos', '1622'],
    // un, una and uno are one
    ['un', '1'],
    ['una', '1'],
    // hundreds
    ['cien', '100'],
    ['ciento cinco', '105'],
    ['ciento cincuenta y cinco', '155'],
    ['doscientos', '200'],
    ['trescientos cinco', '305'],
    ['quinientos', '500'],
    ['setecientos setenta y siete', '777'],
    ['novecientos noventa y nueve', '999'],
    ['cuatrocientas doce', '412'],
    // thousands
    ['mil', '1000'],
    ['dos mil', '2000'],
    ['dos mil uno', '2001'],
    ['dos mil veinticinco', '2025'],
    ['mil novecientos noventa y uno', '1991'],
    ['mil novecientos setenta y cinco', '1975'],
    ['dos mil trescientos cuarenta y cinco', '2345'],
    ['cien mil', '100000'],
    ['doscientos mil', '200000'],
    // zero is always its own digit
    ['cero cinco', '05'],
    ['trescientos cero cinco', '30005'],
    // digits as written, and an unknown word closing a group
    ['5552 0417', '55520417'],
    ['cincuenta por favor cinco', '505'],
    ['hola', ''],
    // "y" between two units is a break
    ['cinco y seis', '56'],
  ])('%s -> %s', (input, expected) => {
    expect(spokenToDigits(input, 'es')).toBe(expected);
    expect(spokenToDigits(input, 'es-MX')).toBe(expected);
  });

  it('does not read Spanish words without a Spanish locale, and English stays English in Spanish', () => {
    expect(spokenToDigits('cinco cinco cinco')).toBe('');
    expect(spokenToDigits('cinco cinco cinco', 'en-US')).toBe('');
    expect(spokenToDigits('five five five', 'es')).toBe('');
    // the English "o" for zero is the Spanish "or"
    expect(spokenToDigits('cinco o seis', 'es')).toBe('56');
  });

  it('is not fooled by a word an object has, such as "constructor"', () => {
    expect(spokenToDigits('constructor cinco', 'es')).toBe('5');
  });
});

describe('numbersSaid in Spanish', () => {
  it('reads runs of Spanish number words, the "y" inside one', () => {
    expect(numbersSaid('es el cuarenta y siete once', { digits: 4, locale: 'es' })).toEqual(['4711']);
    expect(numbersSaid('el cuatro siete uno uno o el cinco cinco cinco dos', { digits: 4, locale: 'es' })).toEqual(['4711', '5552']);
    // English words are not numbers in Spanish, nor Spanish in English
    expect(numbersSaid('four seven one one', { digits: 4, locale: 'es' })).toEqual([]);
    expect(numbersSaid('cuatro siete uno uno', { digits: 4 })).toEqual([]);
  });

  it('drops a year said after a month, with or without "de"', () => {
    expect(numbersSaid('el paquete de marzo de dos mil veinticinco', { digits: 4, skipYearAfterMonth: true, locale: 'es' })).toEqual([]);
    expect(numbersSaid('el paquete de marzo dos mil veinticinco', { digits: 4, skipYearAfterMonth: true, locale: 'es' })).toEqual([]);
    expect(numbersSaid('el paquete de marzo de dos mil veinticinco', { digits: 4, locale: 'es' })).toEqual(['2025']);
  });
});
