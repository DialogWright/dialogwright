/**
 * How a word is said (App.voice.pronounce): a list the app sets of words the text-to-speech voice says
 * wrong, each with a respelling it says right ("Alder: All-der"). A listed word is matched whole and
 * whatever its case, and replaced by its respelling as written; nothing else in the line changes.
 *
 * It applies only to the text sent to the voice: the server rewrites each outbound text frame
 * (server/adapter.ts sendFrames), as it spells identifiers out (spokenDigits), so every line the agent
 * speaks is respelled, a value the caller gave and the agent reads back included (a street name, said
 * back). The session, the trace, the console's readable text and the chat wire keep the words as
 * written. What a caller's interruption heard of a line (the carrier's echo of the text it was sent)
 * has each whole respelling mapped back to its word (unpronounce), so that it too reads, and is
 * redacted, as the line was written; a respelling cut off part way is left as heard.
 *
 * Respelling only, not a phonetic alphabet: Twilio documents SSML passed through in a text frame's
 * token (a `<phoneme>` among it), but Telnyx documents nothing of the kind for its relay's text
 * frames, and one app speaks on both. A respelling works on every carrier and every voice; markup a
 * carrier does not read would be spoken aloud. So a respelling may hold no `<` or `>`.
 *
 * A locale may have a list of its own (voice.locales.<tag>.pronounce), which replaces the app's for
 * the lines said in that locale, as a locale's hints replace the app's: a respelling is written for
 * one language's voice. `{}` there says nothing another way in that locale.
 */

/** A list of words and their respellings, as the app writes it. */
export type PronounceList = Readonly<Record<string, string>>;

/** The longest word (or few words) a list may respell. */
export const PRONOUNCE_MAX_WORD = 60;
/** The longest respelling. */
export const PRONOUNCE_MAX_SAY = 120;

/**
 * A word, or a few: letters (any script, with their marks) and digits, and inside them spaces,
 * apostrophes, hyphens and periods; a period may also end it ("St.").
 */
const WORD = /^[\p{L}\p{N}](?:[\p{L}\p{M}\p{N}' ’.-]*[\p{L}\p{M}\p{N}.])?$/u;
/** What a word must not touch on either side to be matched whole. */
const WORD_CHAR = String.raw`[\p{L}\p{M}\p{N}]`;

/** One problem with a list, on a word (`at: 'word'`, the key) or its respelling (`at: 'say'`). */
export interface PronounceProblem {
  word: string;
  at: 'word' | 'say';
  message: string;
  fix: string;
}

/** What pnpm check and validateApp refuse in a list: a word that is not one, a word listed twice but for case, a respelling that is empty, long or marked up. */
export function pronounceProblems(list: PronounceList): PronounceProblem[] {
  const problems: PronounceProblem[] = [];
  const seen = new Map<string, string>();
  for (const [word, say] of Object.entries(list)) {
    if (!WORD.test(word) || word.length > PRONOUNCE_MAX_WORD) {
      problems.push({
        word, at: 'word',
        message: `"${word}" is not a word or a few words of at most ${PRONOUNCE_MAX_WORD} characters (letters and digits, with spaces, apostrophes, hyphens or periods between them)`,
        fix: 'write the word as the lines spell it, for example Alder or St. Ives',
      });
    } else {
      const before = seen.get(keyOf(word));
      if (before !== undefined) problems.push({ word, at: 'word', message: `"${word}" is listed twice, but for case ("${before}")`, fix: 'delete one of the two: a word is matched whatever its case' });
      else seen.set(keyOf(word), word);
    }
    if (typeof say !== 'string' || say.trim() === '') {
      problems.push({ word, at: 'say', message: 'the respelling is empty', fix: 'write the word as it should sound, for example All-der' });
    } else if (/[<>]/.test(say)) {
      problems.push({ word, at: 'say', message: 'the respelling has markup (< or >), which a carrier that does not read SSML says aloud', fix: 'write the word as it should sound, in plain letters, for example All-der' });
    } else if (/[\r\n]/.test(say) || say.length > PRONOUNCE_MAX_SAY) {
      problems.push({ word, at: 'say', message: `the respelling is not one line of at most ${PRONOUNCE_MAX_SAY} characters`, fix: 'write the word as it should sound, short, on one line' });
    }
  }
  return problems;
}

/** The list for lines said in `locale`: the locale's own (voice.locales.<tag>.pronounce), else the app's. */
export function pronounceFor(
  voice: { readonly pronounce?: PronounceList; readonly locales?: Readonly<Record<string, { readonly pronounce?: PronounceList }>> } | undefined,
  locale: string,
): PronounceList | undefined {
  const own = voice?.locales && Object.hasOwn(voice.locales, locale) ? voice.locales[locale]!.pronounce : undefined;
  return own ?? voice?.pronounce;
}

/** How two spellings of a word compare: whatever their case, and however their accents are encoded (composed or not). */
function keyOf(word: string): string {
  return word.normalize('NFC').toLowerCase();
}

interface Compiled {
  pattern: RegExp;
  says: Map<string, string>;
  entries: [RegExp, string][];
}

/** Each list compiled once, each way: the lists are the app's, fixed for its life. */
const compiled = { to: new WeakMap<PronounceList, Compiled | null>(), back: new WeakMap<PronounceList, Compiled | null>() };

/**
 * A replacer from `from` to `to`, matched whole and whatever its case or accent encoding, longest
 * first (so "Alder Grove" is matched before "Alder"), in one pass (so a replacement is never replaced
 * again). Where two entries match the same text, the first listed wins.
 */
function compileReplacer(pairs: readonly (readonly [from: string, to: string])[]): Compiled | null {
  const usable = pairs.filter(([from]) => from.length > 0);
  if (usable.length === 0) return null;
  const escape = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Each written both composed and decomposed, so an accent matches however the line encodes it.
  const forms = [...new Set(usable.flatMap(([from]) => [from.normalize('NFC'), from.normalize('NFD')]))];
  const alternatives = forms.sort((a, b) => b.length - a.length).map(escape);
  const says = new Map<string, string>();
  for (const [from, to] of usable) if (!says.has(keyOf(from))) says.set(keyOf(from), to);
  return {
    pattern: new RegExp(`(?<!${WORD_CHAR})(?:${alternatives.join('|')})(?!${WORD_CHAR})`, 'giu'),
    says,
    entries: usable.map(([from, to]) => [new RegExp(`^${escape(from.normalize('NFC'))}$`, 'iu'), to]),
  };
}

function replaceWith(c: Compiled, text: string): string {
  return text.replace(c.pattern, (found) => {
    const key = keyOf(found);
    return c.says.get(key) ?? c.entries.find(([re]) => re.test(found.normalize('NFC')))?.[1] ?? found;
  });
}

function compiledFor(cache: WeakMap<PronounceList, Compiled | null>, list: PronounceList, pairs: () => (readonly [string, string])[]): Compiled | null {
  let c = cache.get(list);
  if (c === undefined) {
    c = compileReplacer(pairs());
    cache.set(list, c);
  }
  return c;
}

/** `text` with each listed word, whole and whatever its case, replaced by its respelling. */
export function pronounce(text: string, list: PronounceList | undefined): string {
  if (!list) return text;
  const c = compiledFor(compiled.to, list, () => Object.entries(list));
  return c === null ? text : replaceWith(c, text);
}

/**
 * `text` with each respelling in `list`, whole and whatever its case, replaced by its word as listed:
 * pronounce undone, for what a caller's interruption heard of a line. A respelling cut off part way
 * ("All-") is left as heard; two words with one respelling map back to the first listed.
 */
export function unpronounce(text: string, list: PronounceList | undefined): string {
  if (!list) return text;
  const c = compiledFor(compiled.back, list, () => Object.entries(list).filter(([, say]) => typeof say === 'string' && say.trim() !== '').map(([word, say]) => [say.trim(), word] as const));
  return c === null ? text : replaceWith(c, text);
}
