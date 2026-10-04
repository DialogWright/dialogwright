import { collapseWhitespace } from './hash';

/**
 * What a draft's excerpt (kb/pending/<id>.yaml `drafted.excerpt`) must be for kb:approve to take
 * the draft (./approval.ts), as kb:draft and kb:review (@dialogwright/kb-author) hold it too: the
 * words of its source section that support the answer, quoted.
 *
 * - There is one: a draft quotes the words of its source section that support it.
 * - It is in the section word for word, whitespace aside (./approval.ts excerptInSource).
 * - It is long enough to hold the answer to: at least MIN_EXCERPT_WORDS words and MIN_EXCERPT_CHARS
 *   characters.
 * - Every number the answer says in figures (an amount, a time, a date, a count) is in it, compared
 *   as numbers: `$5.00` and `5`, `9:00` and `9`, `1,000` and `1000` are alike, and the excerpt's
 *   numbers written as words (`sixty`, `twenty-five`) count.
 *
 * A passage already in kb/passages has no excerpt (kb:approve drops `drafted` when it moves a draft),
 * and is approved again without one.
 */

/** The least an excerpt quotes: enough words to hold an answer to. */
export const MIN_EXCERPT_WORDS = 4;
export const MIN_EXCERPT_CHARS = 20;

const UNITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** A number in figures as it is written: digits, with separators between them (`1,000`, `5.00`, `9:30`, `2026-01-05`). */
const NUMBER = /\d(?:[\d,.:/-]*\d)?/g;

/** A number written in figures, as it is compared: `5.00` is `5`, `1,000` is `1000`, `9:00` is `9`, `07` is `7`. */
function normalNumber(token: string): string[] {
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(token)) token = token.replace(/,/g, '');
  if (token.includes(',')) return token.split(',').flatMap(normalNumber);
  const time = /^(\d{1,2}):(\d{2})$/.exec(token);
  if (time) return time[2] === '00' ? [String(Number(time[1]))] : [`${Number(time[1])}:${time[2]}`];
  if (token.includes(':')) return token.split(':').flatMap(normalNumber);
  if (/[-/]/.test(token)) return token.split(/[-/]/).flatMap(normalNumber);
  if (/^\d+(\.\d+)?$/.test(token)) return [String(Number(token))];
  return token.split('.').filter((t) => t !== '').map((t) => String(Number(t)));
}

/** The numbers a text says: in figures, and the whole numbers up to ninety-nine written as words. */
export function numbersIn(text: string): Set<string> {
  const out = new Set([...text.matchAll(NUMBER)].flatMap((m) => normalNumber(m[0])));
  const lower = text.toLowerCase();
  for (const w of lower.match(/[a-z]+/g) ?? []) {
    const unit = UNITS.indexOf(w);
    if (unit >= 0) out.add(String(unit));
    const ten = TENS.indexOf(w);
    if (ten >= 2) out.add(String(ten * 10));
  }
  for (const m of lower.matchAll(/\b([a-z]+)(?=[-\s]+([a-z]+)\b)/g)) {
    const ten = TENS.indexOf(m[1]!);
    const unit = UNITS.indexOf(m[2]!);
    if (ten >= 2 && unit >= 1 && unit <= 9) out.add(String(ten * 10 + unit));
  }
  return out;
}

/** The numbers an answer says in figures that its excerpt does not say, as the answer writes them. */
export function numbersNotInExcerpt(answer: string, excerpt: string): string[] {
  const quoted = numbersIn(excerpt);
  const missing: string[] = [];
  for (const m of answer.matchAll(NUMBER)) {
    if (normalNumber(m[0]).some((n) => !quoted.has(n)) && !missing.includes(m[0])) missing.push(m[0]);
  }
  return missing;
}

/** Why a draft with no excerpt is refused. */
export const NO_EXCERPT = 'a draft quotes the words of its source section that support it: add drafted.excerpt';

/** A list said in words: "a", "a and b", "a, b and c". */
const listed = (items: readonly string[]): string => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/**
 * Why a draft's excerpt cannot stand for its answer, apart from being in its section (which the
 * caller checks with the section's text): none, too short, or missing a number the answer says.
 * Empty when it can.
 */
export function excerptProblems(excerpt: string | undefined, answer: string): string[] {
  const quoted = collapseWhitespace(excerpt ?? '');
  if (quoted === '') return [NO_EXCERPT];
  const problems: string[] = [];
  if (quoted.split(' ').length < MIN_EXCERPT_WORDS || quoted.length < MIN_EXCERPT_CHARS) {
    problems.push(`its excerpt "${quoted}" is too short to hold the answer to: quote at least ${MIN_EXCERPT_WORDS} words and ${MIN_EXCERPT_CHARS} characters of the section`);
  }
  const missing = numbersNotInExcerpt(collapseWhitespace(answer), quoted);
  if (missing.length > 0) problems.push(`its excerpt does not say ${listed(missing)}, which its answer does: every number, amount and date in the answer must be in the excerpt it quotes`);
  return problems;
}
