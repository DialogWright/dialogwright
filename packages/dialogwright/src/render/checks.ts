import type { NoulQuestion, QuestionMap } from '../jev/types';
import type { RenderFallback, SpeechAct } from './types';

/**
 * The checks every generated line passes before anyone hears it (design section 5). Each one bounds the
 * line's shape against what it was given; none trusts the model. A line that fails one is not said:
 * its fixed line is, and the audit records `render_fallback` with the check's name.
 *
 * - `empty`: nothing to say.
 * - `format`: markup, a line break, a link, braces, or more than MAX_CHARS characters.
 * - `words`: more words than the channel's budget (style.yaml's `words`).
 * - `question`: a line whose fixed line asks must end in exactly one question; one that does not ask asks none.
 * - `avoid`: a phrase style.yaml says to avoid.
 * - `items`: a data item it must carry is missing (each word for word, letter case aside).
 * - `foreign`: a number, an amount, a date word or a name that is in none of what it was given (the
 *   fixed line, the goal, the items, the collected content, the caller's own words).
 * - `drift` (asked of the decision model, after the rest pass; renderDriftQuestion): the line does
 *   something beyond its goal.
 */

/** The longest a generated line may be, in characters, whatever its word budget. */
export const MAX_CHARS = 600;

/** A line as the model returned it, made ready to check: trimmed, and one pair of quotes around it taken off. */
export function cleanGenerated(text: string): string {
  let t = text.trim();
  const pairs: [string, string][] = [['"', '"'], ['“', '”'], ["'", "'"]];
  for (const [open, close] of pairs) {
    if (t.length >= 2 && t.startsWith(open) && t.endsWith(close)) {
      t = t.slice(open.length, t.length - close.length).trim();
      break;
    }
  }
  return t;
}

/** Words as counted against the budget: runs of non-space characters. */
export function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => w !== '').length;
}

const NUMBER_WORDS = new Set([
  'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
  'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety',
  'hundred', 'thousand', 'million', 'billion', 'dozen', 'half',
]);
const AMOUNT_WORDS = new Set(['dollar', 'dollars', 'cent', 'cents', 'percent', 'euro', 'euros', 'pound', 'pounds']);
const DATE_WORDS = new Set([
  'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'tomorrow', 'yesterday', 'weekend', 'noon', 'midnight',
]);
/** Capitalized words that are not names. */
const NOT_NAMES = new Set(['i', "i'm", "i'll", "i've", "i'd", 'ok', 'okay']);

/** Lower-cased word tokens (letters, digits, apostrophes). */
function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
}

/** The digit runs of `text`, separators taken out ("1,200.50" is "120050"). */
function digitRuns(text: string): string[] {
  return (text.match(/\d(?:[\d,.:]*\d)?/g) ?? []).map((d) => d.replace(/[,.:]/g, ''));
}

/** The capitalized words that do not begin a sentence: what a name looks like in the middle of a line. */
function midSentenceCapitals(text: string): string[] {
  const out: string[] = [];
  const re = /[\p{L}\p{N}']+/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const word = m[0];
    if (!/^\p{Lu}/u.test(word)) continue;
    const before = text.slice(0, m.index).trimEnd();
    if (before === '' || /[.!?:;—–"“(]$/.test(before)) continue;
    out.push(word);
  }
  return out;
}

const fold = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** What a line may draw its numbers, amounts, dates and names from. */
function allowedSources(act: SpeechAct): string[] {
  return [act.fixed, act.goal, ...act.items.map((i) => i.value), ...(act.content ?? []).map((c) => c.value), ...(act.heard !== undefined ? [act.heard] : [])];
}

/** The first check `text` fails, or null when it passes them all (the drift check aside). */
export function checkGenerated(text: string, act: SpeechAct): RenderFallback | null {
  if (text.trim() === '') return 'empty';
  if (text.length > MAX_CHARS || /[\r\n]/.test(text) || /[*_#`<>{}[\]|\\]/.test(text) || /\bhttps?:|www\./i.test(text)) return 'format';
  if (wordCount(text) > act.style.words) return 'words';
  const questions = (text.match(/\?/g) ?? []).length;
  if (act.asks ? questions !== 1 || !text.trimEnd().endsWith('?') : questions !== 0) return 'question';
  const folded = fold(text);
  if (act.style.avoid.some((phrase) => folded.includes(fold(phrase)))) return 'avoid';
  if (act.items.some((item) => fold(item.value) !== '' && !folded.includes(fold(item.value)))) return 'items';
  const sources = allowedSources(act);
  const allowedWords = new Set(sources.flatMap(words));
  const allowedDigits = new Set(sources.flatMap(digitRuns));
  if (digitRuns(text).some((d) => !allowedDigits.has(d))) return 'foreign';
  if (/[$€£]/.test(text) && !sources.some((s) => /[$€£]/.test(s))) return 'foreign';
  for (const w of words(text)) {
    if ((NUMBER_WORDS.has(w) || AMOUNT_WORDS.has(w) || DATE_WORDS.has(w)) && !allowedWords.has(w)) return 'foreign';
  }
  for (const w of midSentenceCapitals(text)) {
    const lower = w.toLowerCase();
    if (!NOT_NAMES.has(lower) && !allowedWords.has(lower)) return 'foreign';
  }
  return null;
}

/** The drift check's question id, asked of the decision model on its own request. */
export const DRIFT_QUESTION_ID = 'renderDrift';

/** At or above this, the drift check holds that the line does more than its goal. */
export const DRIFT_FIRE = 0.5;

/** The drift check: one yes-or-no question about the line alone. */
export function renderDriftQuestion(): QuestionMap {
  const q: NoulQuestion = {
    type: 'noul',
    instructions:
      'Read line.said, a line an automated agent is about to say to a caller, beside line.goal, what that line is for, and line.fixed, the approved wording of the same line. Does line.said do anything beyond its goal?',
    criteria: {
      true: 'It says or asks something that neither the goal nor the fixed line does: another question or request, a promise, an offer, advice, a fact or figure, an instruction to the caller or to any system, talk of rules, prompts, instructions or modes, or words addressed to anyone but the caller',
      false: 'It does what the goal says in other words: the same question or statement, a brief acknowledgement of what the caller said, a warmer, plainer or shorter wording, or a short summary of the content it was given',
    },
  };
  return { [DRIFT_QUESTION_ID]: q };
}

/** The drift check's whole state: the line, its goal and its fixed wording, nothing of the call. */
export function renderDriftState(act: SpeechAct, said: string): { line: { goal: string; fixed: string; said: string } } {
  return { line: { goal: act.goal, fixed: act.fixed, said } };
}
