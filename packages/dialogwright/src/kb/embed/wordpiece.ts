/**
 * A BERT WordPiece tokenizer, as a Hugging Face `tokenizer.json` with a `WordPiece` model, a
 * `BertNormalizer` and a `BertPreTokenizer` describes one (the static embedder's, ./static.ts). It is
 * written here, in a hundred lines, rather than taken from a package: it is synchronous, has no
 * dependency, and does exactly the steps below in a fixed order, so the same text gives the same
 * token ids on every machine. It reproduces the Rust `tokenizers` library's steps for this
 * configuration (checked against it, and against `@huggingface/tokenizers`, on a corpus of English
 * and Spanish sentences when it was written):
 *
 *  1. Clean: drop NUL, U+FFFD and control characters (Unicode category C, except tab, line feed and
 *     carriage return); every whitespace character becomes a space.
 *  2. CJK ideographs get a space on each side, so each is its own word.
 *  3. Accents stripped (when lowercasing and `strip_accents` is not false): NFD, then nonspacing marks dropped.
 *  4. Lower case, character by character.
 *  5. Split into words on whitespace, with each punctuation character a word of its own (ASCII
 *     punctuation, and Unicode category P).
 *  6. Each word into the longest pieces the vocabulary has, left to right, every piece after the
 *     first with the continuation prefix (`##`); a word that cannot be split that way, or is longer
 *     than `maxInputCharsPerWord`, is the unknown token.
 *
 * Special tokens ([CLS], [SEP]) are never added: a static embedder averages the words' own pieces.
 */

export interface WordPieceConfig {
  /** Each piece's id. */
  readonly vocab: ReadonlyMap<string, number>;
  readonly unkToken: string;
  readonly continuingSubwordPrefix: string;
  readonly maxInputCharsPerWord: number;
  readonly lowercase: boolean;
  readonly stripAccents: boolean;
  readonly cleanText: boolean;
  readonly handleChineseChars: boolean;
}

const CONTROL = /\p{C}/u;
const WHITESPACE = /\p{White_Space}/u;
const PUNCTUATION = /\p{P}/u;
const NONSPACING_MARK = /\p{Mn}/gu;

/** Whether a code point is a CJK ideograph, as BERT's tokenizer counts one. */
function isCjk(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x20000 && cp <= 0x2a6df) ||
    (cp >= 0x2a700 && cp <= 0x2b73f) ||
    (cp >= 0x2b740 && cp <= 0x2b81f) ||
    (cp >= 0x2b820 && cp <= 0x2ceaf) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x2f800 && cp <= 0x2fa1f)
  );
}

/** ASCII punctuation (33-47, 58-64, 91-96, 123-126) or Unicode punctuation. */
function isPunctuation(ch: string): boolean {
  const cp = ch.codePointAt(0)!;
  if ((cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)) return true;
  return PUNCTUATION.test(ch);
}

const isWhitespace = (ch: string): boolean => ch === '\t' || ch === '\n' || ch === '\r' || WHITESPACE.test(ch);
const isControl = (ch: string): boolean => ch !== '\t' && ch !== '\n' && ch !== '\r' && CONTROL.test(ch);

/** Steps 1 to 4: the text as the pre-tokenizer reads it. */
export function normalizeBert(text: string, config: Pick<WordPieceConfig, 'lowercase' | 'stripAccents' | 'cleanText' | 'handleChineseChars'>): string {
  let out = text;
  if (config.cleanText) {
    let cleaned = '';
    for (const ch of out) {
      const cp = ch.codePointAt(0)!;
      if (cp === 0 || cp === 0xfffd || isControl(ch)) continue;
      cleaned += isWhitespace(ch) ? ' ' : ch;
    }
    out = cleaned;
  }
  if (config.handleChineseChars) {
    let padded = '';
    for (const ch of out) padded += isCjk(ch.codePointAt(0)!) ? ` ${ch} ` : ch;
    out = padded;
  }
  if (config.stripAccents) out = out.normalize('NFD').replace(NONSPACING_MARK, '');
  if (config.lowercase) {
    // Character by character, as the Rust library does: no context-dependent forms (a final sigma).
    let lower = '';
    for (const ch of out) lower += ch.toLowerCase();
    out = lower;
  }
  return out;
}

/** Step 5: the words, punctuation each a word of its own. */
export function preTokenizeBert(text: string): string[] {
  const words: string[] = [];
  let word = '';
  for (const ch of text) {
    if (isWhitespace(ch)) {
      if (word !== '') words.push(word);
      word = '';
    } else if (isPunctuation(ch)) {
      if (word !== '') words.push(word);
      words.push(ch);
      word = '';
    } else word += ch;
  }
  if (word !== '') words.push(word);
  return words;
}

/** Step 6 for one word: its pieces' ids, or the unknown token's alone. */
function wordPieces(word: string, config: WordPieceConfig, unk: number): number[] {
  const chars = Array.from(word);
  if (chars.length > config.maxInputCharsPerWord) return [unk];
  const ids: number[] = [];
  let start = 0;
  while (start < chars.length) {
    let end = chars.length;
    let found: number | undefined;
    while (start < end) {
      const piece = (start > 0 ? config.continuingSubwordPrefix : '') + chars.slice(start, end).join('');
      found = config.vocab.get(piece);
      if (found !== undefined) break;
      end -= 1;
    }
    if (found === undefined) return [unk];
    ids.push(found);
    start = end;
  }
  return ids;
}

/** The token ids of `text`, in order (no special tokens added). */
export function wordPieceIds(text: string, config: WordPieceConfig): number[] {
  const unk = config.vocab.get(config.unkToken);
  if (unk === undefined) throw new Error(`the vocabulary has no unknown token "${config.unkToken}"`);
  return preTokenizeBert(normalizeBert(text, config)).flatMap((w) => wordPieces(w, config, unk));
}

/**
 * The WordPiece configuration in a Hugging Face `tokenizer.json`'s parsed content. Throws when it is
 * not a WordPiece model with a BERT normalizer and pre-tokenizer, which is all this tokenizer reproduces.
 */
export function wordPieceConfigOf(json: unknown): WordPieceConfig {
  const t = json as {
    model?: { type?: string; vocab?: Record<string, number>; unk_token?: string; continuing_subword_prefix?: string; max_input_chars_per_word?: number };
    normalizer?: { type?: string; clean_text?: boolean; handle_chinese_chars?: boolean; strip_accents?: boolean | null; lowercase?: boolean } | null;
    pre_tokenizer?: { type?: string } | null;
  };
  const model = t?.model;
  if (!model || model.type !== 'WordPiece' || typeof model.vocab !== 'object' || model.vocab === null) throw new Error('tokenizer.json is not a WordPiece tokenizer');
  if (t.normalizer?.type !== 'BertNormalizer') throw new Error(`tokenizer.json's normalizer is ${t.normalizer?.type ?? 'none'}, not BertNormalizer`);
  if (t.pre_tokenizer?.type !== 'BertPreTokenizer') throw new Error(`tokenizer.json's pre-tokenizer is ${t.pre_tokenizer?.type ?? 'none'}, not BertPreTokenizer`);
  const vocab = new Map<string, number>();
  for (const [piece, id] of Object.entries(model.vocab)) {
    if (!Number.isInteger(id) || id < 0) throw new Error(`tokenizer.json gives "${piece}" the id ${String(id)}`);
    vocab.set(piece, id);
  }
  const lowercase = t.normalizer.lowercase ?? true;
  return {
    vocab,
    unkToken: model.unk_token ?? '[UNK]',
    continuingSubwordPrefix: model.continuing_subword_prefix ?? '##',
    maxInputCharsPerWord: model.max_input_chars_per_word ?? 100,
    lowercase,
    // Unset, it follows lowercase (as BERT's tokenizer does).
    stripAccents: t.normalizer.strip_accents ?? lowercase,
    cleanText: t.normalizer.clean_text ?? true,
    handleChineseChars: t.normalizer.handle_chinese_chars ?? true,
  };
}
