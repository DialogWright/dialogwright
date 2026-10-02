import { describe, expect, it } from 'vitest';
import { numbersSaid } from './numbersSaid';

describe('numbersSaid', () => {
  const four = (text: string, skipYearAfterMonth = false) => numbersSaid(text, { digits: 4, skipYearAfterMonth });

  it('reads each run of number words or digits as one number, keeping those of the length asked', () => {
    expect(four('four seven one one')).toEqual(['4711']);
    expect(four('parcel 4711 please')).toEqual(['4711']);
    expect(four('forty seven eleven')).toEqual(['4711']);
    expect(four('one two three')).toEqual([]);
    expect(numbersSaid('one two three', { digits: 3 })).toEqual(['123']);
  });

  it('a run that reads as more digits gives none, but a shorter run split off by a word still does', () => {
    expect(four('three one eight seven four zero two six')).toEqual([]);
    expect(four('three one eight seven four zero two six and four seven one one')).toEqual(['4711']);
  });

  it('runs first in the order said, then numbers written as digits on their own, each once', () => {
    expect(four('5550, or four seven one one, or 4711 again')).toEqual(['5550', '4711']);
    expect(four('two two two two then 1234 then 2222')).toEqual(['2222', '1234']);
  });

  it('punctuation breaks nothing on its own; a run is its words, however written', () => {
    expect(four('four, seven, one, one')).toEqual(['4711']);
    expect(four('47 11')).toEqual(['4711']);
  });

  it('with skipYearAfterMonth, drops a spoken year right after a month name; a year written as digits is still a number on its own', () => {
    expect(four('march twenty twenty five')).toEqual(['2025']);
    expect(four('march twenty twenty five', true)).toEqual([]);
    expect(four('march twenty twenty five, order four four one two', true)).toEqual(['4412']);
    expect(four('march 2025', true)).toEqual(['2025']);
    expect(four('the twentieth of march, number twenty twenty five', true)).toEqual(['2025']);
    expect(four('march one two three four', true)).toEqual(['1234']);
  });

  it('refuses a length that is no length', () => {
    expect(() => numbersSaid('x', { digits: 0 })).toThrow('numbersSaid: digits must be a whole number, at least 1 (got 0)');
  });
});
