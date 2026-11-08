/**
 * Whether words were said: what an agent's cited words are held to (they must be in what the caller
 * said), and how a text value's label is read. Case, punctuation and apostrophes are ignored, text is
 * compared in Unicode NFC, and spaces collapse; words match whole: "ser" is not in "series", nor "3"
 * in "2023". A run of digits said in parts ("555-555-0142", "555 555 0142") matches the same digits
 * written whole ("5555550142"). Data, compared exactly: nothing of grammar. Number words are not
 * digits here: that reading belongs to the `digits` type's check (spokenToDigits).
 */

/** A text's words: NFC, lower case, letters and digits, apostrophes dropped ("it's" is "its"). */
export function wordsOf(text: string): string[] {
  return text.normalize('NFC').toLowerCase().replace(/['‘’ʼ]/g, '').match(/[\p{L}\p{N}]+/gu) ?? [];
}

const isDigits = (word: string): boolean => /^\p{N}+$/u.test(word);

/** The words with each run of adjacent digit-only words joined into one. */
function joinedDigits(words: readonly string[]): string[] {
  const out: string[] = [];
  for (const w of words) {
    const last = out.length - 1;
    if (last >= 0 && isDigits(w) && isDigits(out[last]!)) out[last] += w;
    else out.push(w);
  }
  return out;
}

const found = (haystack: readonly string[], needle: readonly string[]): boolean => ` ${haystack.join(' ')} `.includes(` ${needle.join(' ')} `);

/** Whether `needle`'s words come, whole and in order, in `haystack`'s words. An empty needle is in nothing. */
export function hasWords(haystack: string, needle: string): boolean {
  const n = wordsOf(needle);
  if (n.length === 0) return false;
  const h = wordsOf(haystack);
  return found(h, n) || found(joinedDigits(h), joinedDigits(n));
}

/** Whether two texts are the same words (an option, a name). */
export function sameWords(a: string, b: string): boolean {
  return wordsOf(a).join(' ') === wordsOf(b).join(' ');
}
