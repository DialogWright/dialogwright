import { ENGLISH, lexiconOf, type Lexicon } from './extract/lexicon';
import { NUMBER_WORDS } from './extract/spokenNumber';

export const MAX_SPANS = 120;
/**
 * Word spans get a larger cap than number spans. A number is said in one dense burst, so 120
 * candidates always reach it; a name can come after a hundred words of preamble, and the word
 * generator emits several spans per content position, so the number cap would truncate the text
 * long before the name. No cap survives an unbounded opener: this one reaches roughly a hundred
 * content positions, which covers the openers a caller actually speaks.
 */
export const MAX_WORD_SPANS = 320;
export const MAX_NGRAM = 10;

// A multiplier word alone ("hundred", "thousand") must not qualify a span on
// its own, or ordinary phrases like "a hundred percent sure" spawn dozens of
// junk number-ish spans. It still counts within a span that has another
// number word. (The lexicon's weak words: in Spanish "mil", "cien", "un" too.)
function isNumberish(tok: string, lex: Lexicon): boolean {
  if (/\d/.test(tok)) return true;
  const folded = lex.fold(tok);
  return lex.numberWords.has(folded) && !lex.weakWords.has(folded);
}

/**
 * All n-grams (1..MAX_NGRAM tokens) that contain at least one digit or
 * number word, deduplicated in document order, capped at MAX_SPANS.
 * Shorter spans come first so the cap keeps the tight candidates.
 *
 * `locale` picks the words (core/extract/lexicon.ts): Spanish number words, accents kept in the
 * span as said, for es and es-*; English for any other locale and for none, as always.
 */
export function candidateSpans(text: string, locale?: string): string[] {
  const lex = lexiconOf(locale);
  const tokens = lex.tokenize(text);
  const seen = new Set<string>();
  const out: string[] = [];
  for (let n = 1; n <= MAX_NGRAM && out.length < MAX_SPANS; n++) {
    for (let i = 0; i + n <= tokens.length && out.length < MAX_SPANS; i++) {
      const slice = tokens.slice(i, i + n);
      if (!slice.some((tok) => isNumberish(tok, lex))) continue;
      const span = slice.join(' ');
      if (seen.has(span)) continue;
      seen.add(span);
      out.push(span);
    }
  }
  return out;
}

/**
 * Words that never begin or end a name span (English); kept small and general, like NUMBER_WORDS.
 * The English lexicon's fillers (core/extract/lexicon.ts), which lists the contraction fragments
 * tokenize() leaves ("it s", "i m"); Spanish has its own.
 */
export const FILLER_WORDS: ReadonlySet<string> = ENGLISH.fillers;
export const MAX_WORD_NGRAM = 4;
/**
 * The most particles a name span may hold between its words ("María José Muñoz de la Cruz": four
 * words and two particles), beyond its MAX_WORD_NGRAM words. Only a lexicon with particles (Spanish)
 * has any.
 */
export const MAX_NAME_PARTICLES = 3;

/**
 * 1..4-token n-grams with no digit or number word, not starting or ending with a filler;
 * within a name span "o"/"oh" is an ordinary word (so "O'Neil" tokenizes to "o neil" and
 * survives), not the digit zero the number-span reader takes it for. Emitted a position at a
 * time, shortest n first, so a long opener cannot exhaust the cap on 1-grams alone and push a
 * later multi-word name out from under it; document order within that; capped at MAX_WORD_SPANS.
 *
 * In Spanish (`locale` es or es-*) the words are Unicode, kept with their accents ("maría josé"),
 * the fillers are Spanish ("me llamo", "soy", "sí"; compared without accents), and a span may hold
 * up to MAX_NAME_PARTICLES particles between its words beyond its four ("muñoz de la cruz"), never
 * at either end. English is as it always was.
 */
export function candidateWordSpans(text: string, locale?: string): string[] {
  const lex = lexiconOf(locale);
  if (lex === ENGLISH) return englishWordSpans(text);
  const tokens = lex.tokenize(text);
  const seen = new Set<string>();
  const out: string[] = [];
  const isWord = (tok: string) => !/\d/.test(tok) && !lex.numberWords.has(lex.fold(tok));
  const isFiller = (tok: string) => lex.fillers.has(lex.fold(tok));
  const isParticle = (tok: string) => lex.nameParticles.has(lex.fold(tok));
  const longest = MAX_WORD_NGRAM + (lex.nameParticles.size > 0 ? MAX_NAME_PARTICLES : 0);
  for (let i = 0; i < tokens.length && out.length < MAX_WORD_SPANS; i++) {
    for (let n = 1; n <= longest && i + n <= tokens.length && out.length < MAX_WORD_SPANS; n++) {
      const slice = tokens.slice(i, i + n);
      if (!slice.every(isWord)) continue;
      if (isFiller(slice[0]!) || isFiller(slice[n - 1]!)) continue;
      const particles = slice.filter(isParticle).length;
      if (n - particles > MAX_WORD_NGRAM || particles > MAX_NAME_PARTICLES) continue;
      const span = slice.join(' ');
      if (seen.has(span)) continue;
      seen.add(span);
      out.push(span);
    }
  }
  return out;
}

/** candidateWordSpans for English: the engine's own reading, unchanged. */
function englishWordSpans(text: string): string[] {
  const tokens = ENGLISH.tokenize(text);
  const seen = new Set<string>();
  const out: string[] = [];
  const isWord = (tok: string) => !/\d/.test(tok) && (tok === 'o' || tok === 'oh' || !NUMBER_WORDS.has(tok));
  for (let i = 0; i < tokens.length && out.length < MAX_WORD_SPANS; i++) {
    for (let n = 1; n <= MAX_WORD_NGRAM && i + n <= tokens.length && out.length < MAX_WORD_SPANS; n++) {
      const slice = tokens.slice(i, i + n);
      if (!slice.every(isWord)) continue;
      if (FILLER_WORDS.has(slice[0]!) || FILLER_WORDS.has(slice[n - 1]!)) continue;
      const span = slice.join(' ');
      if (seen.has(span)) continue;
      seen.add(span);
      out.push(span);
    }
  }
  return out;
}
