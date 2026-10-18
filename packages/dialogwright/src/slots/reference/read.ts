/**
 * Reading a reference (letters and digits) out of the caller's words: typed ("KEVHUD", "k7m4qx"),
 * spelled one character at a time ("K E V H U D"), by letter names ("kay ee vee"), by the spelling
 * alphabet ("kilo echo victor", "K as in kilo"), with digit words ("seven") and "double" or "triple"
 * before a character. English, and Spanish for es and es-*. Code reads; the model only chooses which
 * span the caller meant.
 */

const EN_LETTERS: Readonly<Record<string, string>> = {
  ay: 'A', bee: 'B', be: 'B', cee: 'C', see: 'C', sea: 'C', dee: 'D', ee: 'E', ef: 'F', eff: 'F', gee: 'G', aitch: 'H', haitch: 'H',
  eye: 'I', jay: 'J', kay: 'K', el: 'L', ell: 'L', em: 'M', en: 'N', pee: 'P', pea: 'P', cue: 'Q', queue: 'Q', ar: 'R', are: 'R',
  es: 'S', ess: 'S', tee: 'T', tea: 'T', you: 'U', vee: 'V', ex: 'X', why: 'Y', wye: 'Y', zee: 'Z', zed: 'Z',
};
const ES_LETTERS: Readonly<Record<string, string>> = {
  be: 'B', ce: 'C', de: 'D', efe: 'F', ge: 'G', hache: 'H', jota: 'J', ka: 'K', ele: 'L', eme: 'M', ene: 'N', pe: 'P', cu: 'Q',
  erre: 'R', ere: 'R', ese: 'S', te: 'T', uve: 'V', ve: 'V', equis: 'X', ye: 'Y', zeta: 'Z',
};
const SPELLING: Readonly<Record<string, string>> = {
  alpha: 'A', alfa: 'A', bravo: 'B', charlie: 'C', delta: 'D', echo: 'E', foxtrot: 'F', golf: 'G', hotel: 'H', india: 'I',
  juliet: 'J', juliett: 'J', kilo: 'K', lima: 'L', mike: 'M', november: 'N', oscar: 'O', papa: 'P', quebec: 'Q', romeo: 'R',
  sierra: 'S', tango: 'T', uniform: 'U', victor: 'V', whiskey: 'W', whisky: 'W', xray: 'X', yankee: 'Y', zulu: 'Z',
};
const EN_DIGITS: Readonly<Record<string, string>> = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
};
const ES_DIGITS: Readonly<Record<string, string>> = {
  cero: '0', uno: '1', una: '1', dos: '2', tres: '3', cuatro: '4', cinco: '5', seis: '6', siete: '7', ocho: '8', nueve: '9',
};

const spanish = (locale?: string): boolean => locale !== undefined && /^es(?:-|$)/i.test(locale);

/** The caller's words as the reader takes them: lower case, letters and digits, accents taken off. */
export function tokensOf(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t !== '');
}

/**
 * The characters `tokens` say, in order, read for `alphabet`; null when a word in them is none.
 * "oh" and "o" are O, or 0 where the alphabet has no O; "i" is I, or 1 where it has no I; "l" is L, or 1
 * where it has no L. "as in <word>" after a character, and "x ray", say no more than the character.
 */
export function readReference(tokens: readonly string[], alphabet: string, locale?: string): string | null {
  const es = spanish(locale);
  const letters = es ? ES_LETTERS : EN_LETTERS;
  const digits = es ? ES_DIGITS : EN_DIGITS;
  const has = (c: string): boolean => alphabet.includes(c);
  const alike = (c: string): string => (has(c) ? c : c === 'O' && has('0') ? '0' : (c === 'I' || c === 'L') && has('1') ? '1' : c);
  let out = '';
  let repeat = 1;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    // "K as in kilo": the example word says nothing more ("como en" in Spanish).
    if (out !== '' && ((t === 'as' && tokens[i + 1] === 'in') || (es && t === 'como' && tokens[i + 1] === 'en'))) {
      i += 2;
      continue;
    }
    if (!es && t === 'x' && tokens[i + 1] === 'ray') {
      out += 'X'.repeat(repeat);
      repeat = 1;
      i += 1;
      continue;
    }
    if ((t === 'double' || t === 'doble') && !(es && tokens[i + 1] === 'uve')) {
      if (!es && (tokens[i + 1] === 'you' || tokens[i + 1] === 'u')) {
        out += 'W'.repeat(repeat);
        repeat = 1;
        i += 1;
        continue;
      }
      repeat = 2;
      continue;
    }
    if (es && t === 'uve' && tokens[i + 1] === 'doble') {
      out += 'W'.repeat(repeat);
      repeat = 1;
      i += 1;
      continue;
    }
    if (es && t === 'i' && tokens[i + 1] === 'griega') {
      out += 'Y'.repeat(repeat);
      repeat = 1;
      i += 1;
      continue;
    }
    if (t === 'triple') {
      repeat = 3;
      continue;
    }
    let chars: string | null = null;
    if (t === 'oh' && !es) chars = alike('O');
    else if (Object.hasOwn(digits, t)) chars = digits[t]!;
    else if (Object.hasOwn(letters, t)) chars = letters[t]!;
    else if (Object.hasOwn(SPELLING, t)) chars = SPELLING[t]!;
    else if (/^[a-z0-9]+$/.test(t)) chars = t.toUpperCase().split('').map(alike).join('');
    if (chars === null) return null;
    out += repeat > 1 && chars.length === 1 ? chars.repeat(repeat) : chars;
    repeat = 1;
  }
  return repeat === 1 ? out : null;
}

/** The most spans offered to the model. */
export const MAX_REFERENCE_SPANS = 40;

/**
 * The spans of `text` (its words, joined by a space, as said) that read as a reference of `length`
 * characters from `alphabet`, shortest first, each once, at most MAX_REFERENCE_SPANS.
 */
export function referenceSpans(text: string, length: number, alphabet: string, locale?: string): string[] {
  const tokens = tokensOf(text);
  const out: string[] = [];
  const seen = new Set<string>();
  const fits = (s: string | null): boolean => s !== null && s.length === length && [...s].every((c) => alphabet.includes(c));
  // A span has at most a few words for each character ("K as in kilo"), and at least one.
  const most = Math.min(tokens.length, length * 4);
  for (let n = 1; n <= most && out.length < MAX_REFERENCE_SPANS; n++) {
    for (let i = 0; i + n <= tokens.length && out.length < MAX_REFERENCE_SPANS; i++) {
      const slice = tokens.slice(i, i + n);
      const span = slice.join(' ');
      if (seen.has(span)) continue;
      seen.add(span);
      if (fits(readReference(slice, alphabet, locale))) out.push(span);
    }
  }
  return out;
}

/** Whether `value` is a reference of `length` characters from `alphabet`. */
export function referenceFits(value: string, length: number, alphabet: string): boolean {
  return value.length === length && [...value].every((c) => alphabet.includes(c));
}
