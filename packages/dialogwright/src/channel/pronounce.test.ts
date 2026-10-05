import { describe, expect, it } from 'vitest';
import { pronounce, pronounceFor, pronounceProblems, unpronounce } from './pronounce';
import type { VoiceConfig } from '../core/app/types';

describe('pronounce: the words the voice says another way (voice.pronounce)', () => {
  const list = { Alder: 'All-der', 'St. Ives': 'Saint Ives' };

  it('respells a listed word, whole and whatever its case, and changes nothing else', () => {
    expect(pronounce('A problem at 22 Alder Street. Is that right?', list)).toBe('A problem at 22 All-der Street. Is that right?');
    expect(pronounce('ALDER street, alder road', list)).toBe('All-der street, All-der road');
    expect(pronounce('Near St. Ives, by the Alder.', list)).toBe('Near Saint Ives, by the All-der.');
    expect(pronounce("Alder's corner", list)).toBe("All-der's corner");
    expect(pronounce('Saint-Aubin Road', { 'Saint-Aubin': 'San Toe-ban' })).toBe('San Toe-ban Road');
  });

  it('matches whole words only', () => {
    expect(pronounce('Alderman Street and Lower Alders', list)).toBe('Alderman Street and Lower Alders');
    expect(pronounce('Heron Row and Heronsgate', { Heron: 'Hair-un' })).toBe('Hair-un Row and Heronsgate');
    expect(pronounce('Alder2 and 2Alder', list)).toBe('Alder2 and 2Alder');
    expect(pronounce('Ålder', list)).toBe('Ålder');
  });

  it('matches a word however its accents are encoded (composed or decomposed)', () => {
    const composed = { 'Caf\u00e9': 'Ka-fay' };
    const decomposed = { 'Cafe\u0301': 'Ka-fay' };
    expect(pronounce('Caf\u00e9 Row', composed)).toBe('Ka-fay Row');
    expect(pronounce('Cafe\u0301 Row', composed)).toBe('Ka-fay Row');
    expect(pronounce('Caf\u00e9 Row', decomposed)).toBe('Ka-fay Row');
    expect(pronounce('CAFE\u0301 row', composed)).toBe('Ka-fay row');
    // Still whole: a mark after the word is part of it.
    expect(pronounce('Cafe\u0301s', composed)).toBe('Cafe\u0301s');
    expect(pronounce('Cafe Row', composed)).toBe('Cafe Row');
  });

  it('respells each word once: a respelling is never respelled again', () => {
    expect(pronounce('Alder', { Alder: 'Alder Grove', Grove: 'Grohv' })).toBe('Alder Grove');
    expect(pronounce('Alder Grove', { 'Alder Grove': 'All-der Grohv', Alder: 'All-der' })).toBe('All-der Grohv');
  });

  it('maps a respelling back to its word (what an interruption heard of a line), whole and whatever its case', () => {
    expect(unpronounce('A problem at 22 All-der Street', list)).toBe('A problem at 22 Alder Street');
    expect(unpronounce('near saint ives, by the ALL-DER', list)).toBe('near St. Ives, by the Alder');
    // Cut off part way through a respelling: left as heard.
    expect(unpronounce('A problem at 22 All-', list)).toBe('A problem at 22 All-');
    expect(unpronounce('All-derman', list)).toBe('All-derman');
    expect(unpronounce('22 All-der Street', undefined)).toBe('22 All-der Street');
    expect(unpronounce('22 All-der Street', {})).toBe('22 All-der Street');
    // Round trip: what the voice was sent, mapped back, is the line as written.
    const line = 'A problem at 22 Alder Street, near St. Ives.';
    expect(unpronounce(pronounce(line, list), list)).toBe(line);
  });

  it('leaves the text as it is without a list', () => {
    expect(pronounce('22 Alder Street', undefined)).toBe('22 Alder Street');
    expect(pronounce('22 Alder Street', {})).toBe('22 Alder Street');
  });

  it("takes a locale's own list in place of the app's, for that locale only", () => {
    const voice: VoiceConfig = { pronounce: { Alder: 'All-der' }, locales: { es: { pronounce: { Alder: 'Al-dair' } }, fr: { tts: 'fr-FR' }, de: { pronounce: {} } } };
    expect(pronounceFor(voice, 'en-US')).toEqual({ Alder: 'All-der' });
    expect(pronounceFor(voice, 'es')).toEqual({ Alder: 'Al-dair' });
    expect(pronounceFor(voice, 'fr')).toEqual({ Alder: 'All-der' });
    expect(pronounceFor(voice, 'de')).toEqual({});
    expect(pronounceFor(undefined, 'en-US')).toBeUndefined();
  });

  it('finds the problems pnpm check and validateApp refuse', () => {
    expect(pronounceProblems(list)).toEqual([]);
    expect(pronounceProblems({ Alder: 'All-der', ALDER: 'All-dur' })).toEqual([{ word: 'ALDER', at: 'word', message: '"ALDER" is listed twice, but for case ("Alder")', fix: 'delete one of the two: a word is matched whatever its case' }]);
    expect(pronounceProblems({ 'Alder?': 'x' }).map((p) => p.at)).toEqual(['word']);
    expect(pronounceProblems({ ' Alder': 'x' }).map((p) => p.at)).toEqual(['word']);
    expect(pronounceProblems({ ['A'.repeat(61)]: 'x' }).map((p) => p.at)).toEqual(['word']);
    expect(pronounceProblems({ Alder: '' }).map((p) => p.at)).toEqual(['say']);
    expect(pronounceProblems({ Alder: '   ' }).map((p) => p.at)).toEqual(['say']);
    expect(pronounceProblems({ Alder: 'x'.repeat(121) }).map((p) => p.at)).toEqual(['say']);
    expect(pronounceProblems({ Alder: '<sub alias="x">Alder</sub>' }).map((p) => p.at)).toEqual(['say']);
    expect(pronounceProblems({ Alder: 'All\nder' }).map((p) => p.at)).toEqual(['say']);
    // The same word, its accent composed once and decomposed once, is listed twice.
    expect(pronounceProblems({ 'Caf\u00e9': 'Ka-fay', 'Cafe\u0301': 'Ka-fay' }).map((p) => p.at)).toEqual(['word']);
  });
});
