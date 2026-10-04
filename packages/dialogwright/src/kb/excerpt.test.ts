import { describe, expect, it } from 'vitest';
import { excerptProblems, MIN_EXCERPT_CHARS, MIN_EXCERPT_WORDS, NO_EXCERPT, numbersIn, numbersNotInExcerpt } from './excerpt';

/**
 * A draft's excerpt, as kb:approve holds it (and kb:draft and kb:review, through the root's exports):
 * there is one, it is long enough to hold the answer to, and it says every number the answer says.
 */

describe('an excerpt', () => {
  it('reads numbers in figures and in words', () => {
    expect([...numbersIn('twenty-five cents, sixty days, 1,000 books, $5.00, 9:00, 07 and twenty one')].sort()).toEqual(['1', '1000', '20', '21', '25', '5', '60', '7', '9'].sort());
    expect(numbersNotInExcerpt('It is 1,000 books and $5.', 'one thousand books, 5 dollars, 1000 in all')).toEqual([]);
    expect(numbersNotInExcerpt('Call 555-0100.', 'Call the desk.')).toEqual(['555-0100']);
  });

  it('is refused when there is none, when it is too short, or when it misses a number its answer says', () => {
    expect(excerptProblems(undefined, 'Any answer.')).toEqual([NO_EXCERPT]);
    expect(excerptProblems('  \n ', 'Any answer.')).toEqual([NO_EXCERPT]);
    expect(excerptProblems('late fees.', 'Late fees are 25 cents a day.')).toEqual([
      `its excerpt "late fees." is too short to hold the answer to: quote at least ${MIN_EXCERPT_WORDS} words and ${MIN_EXCERPT_CHARS} characters of the section`,
      'its excerpt does not say 25, which its answer does: every number, amount and date in the answer must be in the excerpt it quotes',
    ]);
    expect(excerptProblems('An adult card is valid for three years.', 'An adult card lasts 4 years, or 5.')).toEqual([
      'its excerpt does not say 4 and 5, which its answer does: every number, amount and date in the answer must be in the excerpt it quotes',
    ]);
    // Whitespace aside, and numbers in words count.
    expect(excerptProblems('An adult card   is valid\nfor three years.', 'An adult card lasts 3 years.')).toEqual([]);
  });
});
