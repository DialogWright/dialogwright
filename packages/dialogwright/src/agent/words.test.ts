import { describe, expect, it } from 'vitest';
import { hasWords, sameWords, wordsOf } from './words';

describe('hasWords', () => {
  it('matches whole words in order, case and punctuation ignored', () => {
    expect(hasWords('It\'s a 2020 Example 3 Series, front left.', 'example 3 series')).toBe(true);
    expect(hasWords('Thursday morning, please!', 'thursday morning')).toBe(true);
    expect(hasWords("it's the blue one", 'its')).toBe(true);
  });

  it('never matches part of a word', () => {
    expect(hasWords('the 3 Series', 'ser')).toBe(false);
    expect(hasWords('a 2023 edition', '3')).toBe(false);
    expect(hasWords('someone said so', 'one')).toBe(false);
    expect(hasWords('morning please', 'please morning')).toBe(false);
  });

  it('an empty needle is in nothing', () => {
    expect(hasWords('anything', ' ,. ')).toBe(false);
  });

  it('sameWords and wordsOf', () => {
    expect(sameWords('Not sure.', 'not  sure')).toBe(true);
    expect(sameWords('one', 'none')).toBe(false);
    expect(wordsOf('Don’t, 555-0144!')).toEqual(['dont', '555', '0144']);
  });
});
