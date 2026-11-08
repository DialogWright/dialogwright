/**
 * Whether words were said: what an agent's cited words are held to (they must be in what the caller
 * said), and how a text value's label is read. Case, punctuation and apostrophes are ignored and spaces
 * collapsed, and words match whole: "ser" is not in "series", nor "3" in "2023". Data, compared exactly:
 * nothing of grammar. A slot type's check of a value the agent understood uses the same matcher.
 */

/** A text's words: lower case, letters and digits, apostrophes dropped ("it's" is "its"). */
export function wordsOf(text: string): string[] {
  return text.toLowerCase().replace(/['‘’ʼ]/g, '').match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Whether `needle`'s words come, whole and in order, in `haystack`'s words. An empty needle is in nothing. */
export function hasWords(haystack: string, needle: string): boolean {
  const n = wordsOf(needle);
  if (n.length === 0) return false;
  return ` ${wordsOf(haystack).join(' ')} `.includes(` ${n.join(' ')} `);
}

/** Whether two texts are the same words (an option, a name). */
export function sameWords(a: string, b: string): boolean {
  return wordsOf(a).join(' ') === wordsOf(b).join(' ');
}
