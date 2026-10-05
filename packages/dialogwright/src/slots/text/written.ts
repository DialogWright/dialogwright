/**
 * A text slot's written form (the `numbers` and `case` options): the value a tool, the gate, the
 * audit and the console get, written by code from the words the caller said, while a line reads the
 * words back as said. A recognizer gives "seventy six twenty five oak hollow lane"; the value is
 * "7625 Oak Hollow Lane", and the read-back keeps the words, since text-to-speech reads "7625" as a
 * quantity ("seven thousand six hundred twenty five"). Code writes it, never the model: the words
 * are the caller's, and each rule below only rewrites a run of number words or a letter's case.
 *
 * The rules are a language's (WRITTEN_RULES: English, also read with no locale). A language with
 * none leaves the words as said, so another language's number words never change a caller's words.
 *
 * English numbers (`numbers: digits`): each run of number words, side by side with only spaces or a
 * hyphen between them, is written as one string of digits; the parts of a run concatenate.
 * - Digit words in sequence: "one zero two four six" is 10246. "oh" and "o" between two number
 *   words are a zero ("one oh two" is 102, "nineteen oh five" 1905); anywhere else ("oh I see", a
 *   trailing "oh") they are words.
 * - A number said whole is its value, and the numbers of a run concatenate: "seventy six twenty
 *   five" is 7625, "twelve" 12, "twenty five hundred" 2500, "two thousand four" 2004, "one hundred
 *   twenty three" 123, "seven six twenty five" 7625. "a" before "hundred" or "thousand" is one, and
 *   "and" after one of them and before a number is part of it ("one hundred and five" is 105);
 *   elsewhere both are words ("five and six" is "5 and 6"). A scale word with no number before it is
 *   a word ("hundred acre wood").
 * - Ordinals stay words ("fifth avenue"), and so does a tens word before a unit ordinal, which is
 *   part of it ("twenty third street"; "seventy six twenty third street" is "76 twenty third street").
 *   An ordinal after "hundred" or "thousand" ("one hundred first street") leaves the whole run as
 *   words: which part is a house number is not clear.
 * - Digits already in the words, and every other character, stay as they are. A run the rules
 *   cannot read whole stays words.
 * - It runs on the slot's value only (with `pick`, the part picked), so "one" in prose is written
 *   too ("one main street" is "1 main street"): the value is the part that names the address.
 *
 * English case (`case: title`): words written with no capital at all, as a recognizer that writes
 * none gives them, have each word's first letter capitalized but for the minor words after the
 * first ("the corner of elm and third" is "The Corner of Elm and Third"). Words with a capital
 * anywhere were cased by the recognizer or the caller and stay as they are.
 */

/** How a text slot writes numbers in its value: as said (`words`), or each run of number words as digits. */
export type WrittenNumbers = 'words' | 'digits';
/** How a text slot writes the case of its value: as said, or each word capitalized (`title`). */
export type WrittenCase = 'as-said' | 'title';

/** A language's rules for writing the caller's words. */
export interface WrittenRules {
  /** The words with each run of number words written as digits, every other character as said. */
  digits(text: string): string;
  /** The words with each word capitalized, when they have no capital at all. */
  title(text: string): string;
}

/** A word as said: letters, digits and marks, with an apostrophe inside it ("O'Neil"); a hyphen parts two words. */
const WORD = /[\p{L}\p{N}\p{M}]+(?:['’][\p{L}\p{N}\p{M}]+)*/gu;
/** What may sit between two words of one run: spaces, or a single hyphen ("seventy-six"). */
const IN_RUN = /^(?:\s+|[-‐‑])$/u;

type Kind = 'unit' | 'zero' | 'oh' | 'teen' | 'tens' | 'hundred' | 'thousand' | 'and' | 'a' | 'ordinal' | 'unitOrdinal' | 'other';

interface Word {
  kind: Kind;
  value: number;
  start: number;
  end: number;
}

const EN_UNITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const EN_TEENS = ['ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const EN_TENS = ['twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const EN_UNIT_ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth'];
const EN_OTHER_ORDINALS = [
  'tenth', 'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth',
  'twentieth', 'thirtieth', 'fortieth', 'fiftieth', 'sixtieth', 'seventieth', 'eightieth', 'ninetieth', 'hundredth', 'thousandth',
];
const EN_MINOR = new Set(['a', 'an', 'the', 'and', 'or', 'nor', 'but', 'of', 'at', 'on', 'in', 'by', 'for', 'to', 'with', 'near']);

/** What an English word is, for the number rules: its kind and its value. */
function englishWord(folded: string): Pick<Word, 'kind' | 'value'> {
  let at = EN_UNITS.indexOf(folded);
  if (at === 0) return { kind: 'zero', value: 0 };
  if (at > 0) return { kind: 'unit', value: at };
  at = EN_TEENS.indexOf(folded);
  if (at >= 0) return { kind: 'teen', value: 10 + at };
  at = EN_TENS.indexOf(folded);
  if (at >= 0) return { kind: 'tens', value: 20 + 10 * at };
  if (folded === 'oh' || folded === 'o') return { kind: 'oh', value: 0 };
  if (folded === 'hundred') return { kind: 'hundred', value: 100 };
  if (folded === 'thousand') return { kind: 'thousand', value: 1000 };
  if (folded === 'and') return { kind: 'and', value: 0 };
  if (folded === 'a') return { kind: 'a', value: 1 };
  if (EN_UNIT_ORDINALS.includes(folded)) return { kind: 'unitOrdinal', value: 0 };
  if (EN_OTHER_ORDINALS.includes(folded)) return { kind: 'ordinal', value: 0 };
  return { kind: 'other', value: 0 };
}

const fold = (word: string): string => word.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** A word that says a number of its own: one to nine, ten to nineteen, a tens word. */
const isNumber = (w: Word | undefined): boolean => w !== undefined && (w.kind === 'unit' || w.kind === 'teen' || w.kind === 'tens');
/** A word a zero ("oh") may come before: a number, or another zero. */
const takesZeroBefore = (w: Word | undefined): boolean => isNumber(w) || w?.kind === 'zero' || w?.kind === 'oh';
const isScale = (w: Word | undefined): boolean => w?.kind === 'hundred' || w?.kind === 'thousand';
const isOrdinal = (w: Word | undefined): boolean => w?.kind === 'ordinal' || w?.kind === 'unitOrdinal';

/** Whether `w`, after `prev` in a run and before `next`, belongs to the run. */
function joinsRun(prev: Word, w: Word, next: Word | undefined): boolean {
  switch (w.kind) {
    case 'unit':
    case 'teen':
    case 'tens':
    case 'zero':
      return true;
    case 'oh':
      return takesZeroBefore(prev) || isScale(prev) ? takesZeroBefore(next) : false;
    case 'hundred':
      return isNumber(prev) || prev.kind === 'a';
    case 'thousand':
      return isNumber(prev) || prev.kind === 'a' || prev.kind === 'hundred';
    case 'and':
      return isScale(prev) && isNumber(next);
    case 'a':
      return isScale(next);
    default:
      return false;
  }
}

/** Whether `w` may start a run (before `next`): a number or a zero, or "a" before a scale word. */
const startsRun = (w: Word, next: Word | undefined): boolean =>
  isNumber(w) || w.kind === 'zero' || (w.kind === 'a' && isScale(next));

/** A number below a hundred at `k` (one to ninety nine): its value and the index after it, or null. */
function below100(run: readonly Word[], k: number): { value: number; next: number } | null {
  const w = run[k];
  if (w === undefined || !isNumber(w)) return null;
  if (w.kind === 'tens' && run[k + 1]?.kind === 'unit') return { value: w.value + run[k + 1]!.value, next: k + 2 };
  return { value: w.value, next: k + 1 };
}

/** A number below a thousand at `k`, with its hundreds ("twenty five hundred", "a hundred and five"), or null. */
function below1000(run: readonly Word[], k: number): { value: number; next: number } | null {
  let value: number;
  let next: number;
  if (run[k]?.kind === 'a' && run[k + 1]?.kind === 'hundred') {
    value = 100;
    next = k + 2;
  } else {
    const head = below100(run, k);
    if (head === null) return null;
    if (run[head.next]?.kind !== 'hundred') return head;
    value = head.value * 100;
    next = head.next + 1;
  }
  const and = run[next]?.kind === 'and' ? 1 : 0;
  const tail = below100(run, next + and);
  return tail === null ? { value, next } : { value: value + tail.value, next: tail.next };
}

/** One number said whole at `i` (or a zero): its digits and the index after it, or null. */
function cardinal(run: readonly Word[], i: number): { digits: string; next: number } | null {
  if (run[i]?.kind === 'zero' || run[i]?.kind === 'oh') return { digits: '0', next: i + 1 };
  const head = run[i]?.kind === 'a' && run[i + 1]?.kind === 'thousand' ? { value: 1, next: i + 1 } : below1000(run, i);
  if (head === null) return null;
  if (run[head.next]?.kind !== 'thousand') return { digits: String(head.value), next: head.next };
  let next = head.next + 1;
  if (run[next]?.kind === 'and' && isNumber(run[next + 1])) next++;
  const tail = below1000(run, next);
  return tail === null ? { digits: String(head.value * 1000), next } : { digits: String(head.value * 1000 + tail.value), next: tail.next };
}

/** A run's digits: each number in it, concatenated; null when a word of it is not read. */
function digitsOf(run: readonly Word[]): string | null {
  let out = '';
  for (let i = 0; i < run.length; ) {
    const c = cardinal(run, i);
    if (c === null) return null;
    out += c.digits;
    i = c.next;
  }
  return out;
}

/**
 * The run without the words an ordinal after it (`after`, or `afterThat` after "and") takes: a tens
 * word before a unit ordinal ("twenty third") is the ordinal's; an ordinal after a scale word, or
 * after one and "and", takes the whole run, since which part is a house number is not clear. The run
 * as it is when no ordinal follows.
 */
function beforeOrdinal(run: Word[], after: Word | undefined, afterThat: Word | undefined): Word[] {
  if (isScale(run.at(-1)) && after?.kind === 'and' && isOrdinal(afterThat)) return [];
  if (!isOrdinal(after)) return run;
  const kept = run.at(-1)?.kind === 'tens' && after!.kind === 'unitOrdinal' ? run.slice(0, -1) : run;
  const last = kept.at(-1);
  return isScale(last) || last?.kind === 'and' ? [] : kept;
}

/** English: each run of number words written as digits. */
function englishDigits(text: string): string {
  const words: Word[] = [...text.matchAll(WORD)].map((m) => ({ ...englishWord(fold(m[0])), start: m.index, end: m.index + m[0].length }));
  /** The word after `i`, when only spaces or a hyphen part them. */
  const adjacent = (i: number): Word | undefined => {
    const w = words[i];
    const n = words[i + 1];
    return w !== undefined && n !== undefined && IN_RUN.test(text.slice(w.end, n.start)) ? n : undefined;
  };
  const edits: { start: number; end: number; digits: string }[] = [];
  for (let i = 0; i < words.length; ) {
    if (!startsRun(words[i]!, adjacent(i))) {
      i++;
      continue;
    }
    let j = i;
    while (adjacent(j) !== undefined && joinsRun(words[j]!, adjacent(j)!, adjacent(j + 1))) j++;
    const after = adjacent(j);
    const run = beforeOrdinal(words.slice(i, j + 1), after, after === undefined ? undefined : adjacent(j + 1));
    const digits = run.length > 0 ? digitsOf(run) : null;
    if (digits !== null) edits.push({ start: run[0]!.start, end: run.at(-1)!.end, digits });
    i = j + 1;
  }
  let out = text;
  for (const e of edits.reverse()) out = out.slice(0, e.start) + e.digits + out.slice(e.end);
  return out;
}

/** English: each word capitalized but for the minor words after the first, when the words have no capital at all. */
function englishTitle(text: string): string {
  if (/\p{Lu}/u.test(text)) return text;
  let first = true;
  return text.replace(WORD, (word) => {
    const keep = !first && EN_MINOR.has(word);
    first = false;
    return keep ? word : word.charAt(0).toLocaleUpperCase('en') + word.slice(1);
  });
}

/** The rules by language subtag: English only. A language not here leaves the words as said. */
export const WRITTEN_RULES: Readonly<Record<string, WrittenRules>> = Object.freeze({
  en: Object.freeze({ digits: englishDigits, title: englishTitle }),
});

/** The rules for `locale`'s language (no locale reads as English), or undefined for a language with none. */
export function writtenRulesFor(locale: string | undefined): WrittenRules | undefined {
  const language = locale === undefined ? 'en' : locale.trim().split(/[-_]/)[0]!.toLowerCase();
  return Object.hasOwn(WRITTEN_RULES, language) ? WRITTEN_RULES[language] : undefined;
}

/**
 * The value written from the words as said, in `locale`'s language: numbers as digits with
 * `numbers: digits`, then each word capitalized with `case: title`. Words in a language with no
 * rules, and words with neither option, are the value as said.
 */
export function writtenForm(said: string, o: { numbers: WrittenNumbers; case: WrittenCase }, locale?: string): string {
  if (o.numbers === 'words' && o.case === 'as-said') return said;
  const rules = writtenRulesFor(locale);
  if (rules === undefined) return said;
  const numbered = o.numbers === 'digits' ? rules.digits(said) : said;
  return o.case === 'title' ? rules.title(numbered) : numbered;
}
