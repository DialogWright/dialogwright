import { describe, expect, it } from 'vitest';
import { candidateSpans, candidateWordSpans, MAX_SPANS, MAX_WORD_SPANS } from './spans';

describe('candidateSpans', () => {
  it('includes n-grams containing a number word', () => {
    const spans = candidateSpans('my account id is four four seven');
    expect(spans).toContain('four four seven');
    expect(spans).toContain('is four four seven');
    expect(spans).toContain('my account id is four four seven');
  });

  it('excludes spans with no digits or number words', () => {
    expect(candidateSpans('my account id is four four seven')).not.toContain('my account id');
  });

  it('includes digit tokens', () => {
    expect(candidateSpans('it is 4471 8293')).toContain('4471 8293');
  });

  it('returns nothing for text without numbers', () => {
    expect(candidateSpans('I want to cancel')).toEqual([]);
  });

  it('does not let a lone multiplier word qualify a span', () => {
    expect(candidateSpans('I am a hundred percent sure')).toEqual([]);
  });

  it('still includes a multiplier word alongside a real number word', () => {
    expect(candidateSpans('three hundred fifty five')).toContain('three hundred fifty five');
  });

  it('caps the list', () => {
    const words = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'zero'];
    const long = Array.from({ length: 40 }, (_, i) => words[i % 10] + (i >= 10 ? String(i) : '')).join(' ');
    const spans = candidateSpans(long);
    expect(spans).toHaveLength(MAX_SPANS);
    expect(spans[0]!.split(' ')).toHaveLength(1);
  });
});

describe('candidateWordSpans', () => {
  it('keeps 1-4 word spans that carry no number word and do not start or end with a filler', () => {
    const spans = candidateWordSpans('my name is Alex Rivera and I need to reschedule');
    expect(spans).toContain('alex rivera');
    expect(spans).toContain('alex');
    expect(spans).toContain('reschedule');
    expect(spans).not.toContain('name is alex'); // starts with a filler
    expect(spans).not.toContain('rivera and'); // ends with a filler
    expect(spans).not.toContain('my');
    expect(spans.every((s) => !/\d/.test(s))).toBe(true);
  });

  it('drops number words and caps the list at its own, larger cap', () => {
    expect(candidateWordSpans('four four seven one')).toEqual([]);
    // Distinct digit-free words, or the digit test would reject them as number-ish and the cap
    // would never be reached. Word spans have their own cap: a name arrives at the end of a long
    // sentence, where number spans are dense and local.
    const words = Array.from({ length: 200 }, (_, i) => `${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))}x`);
    expect(MAX_WORD_SPANS).toBeGreaterThan(MAX_SPANS);
    expect(candidateWordSpans(words.join(' ')).length).toBe(MAX_WORD_SPANS);
  });

  it('treats a hyphenated, apostrophed name as a plain word span up to four tokens, with o/oh as ordinary words', () => {
    const spans = candidateWordSpans("this is Mary-Kate O'Neil calling");
    expect(spans).toContain('mary kate o neil');
  });

  it('drops apostrophe-contraction fragments rather than offering them as spans', () => {
    const spans = candidateWordSpans("I'd like to cancel");
    expect(spans).not.toContain('d');
    expect(spans).not.toContain('d like');
    expect(spans).toEqual(['like', 'like to cancel', 'cancel']);
  });

  it('still surfaces a name said late in an opener long enough to exhaust the cap', () => {
    const opener = [
      'um', 'so', 'i', 'was', 'wondering', 'if', 'you', 'could', 'help', 'me', 'with', 'something', 'because', 'my',
      'appointment', 'got', 'moved', 'and', 'i', 'need', 'to', 'talk', 'to', 'someone', 'about', 'it', 'please', 'this',
      'is', 'regarding', 'a', 'scheduling', 'issue', 'that', 'came', 'up', 'last', 'week', 'when', 'i', 'called', 'the',
      'office', 'and', 'they', 'said', 'to', 'call', 'back', 'today', 'so', 'here', 'i', 'am', 'calling', 'again', 'and',
      'i', 'also', 'wanted', 'to', 'mention', 'that', 'the', 'front', 'desk', 'never', 'sent', 'the', 'paperwork',
      'over', 'to', 'my', 'delivery', 'people', 'which', 'is', 'why', 'everything', 'has', 'been', 'such', 'a', 'mess',
      'lately', 'anyway', 'i', 'figured', 'i', 'would', 'just', 'call', 'in', 'directly', 'rather', 'than', 'keep',
      'waiting', 'around', 'for', 'somebody', 'else', 'to', 'sort', 'it', 'out', 'on', 'their', 'own', 'schedule',
      'okay', 'my', 'name', 'is',
    ];
    expect(opener).toHaveLength(114);
    const spans = candidateWordSpans(`${opener.join(' ')} alex rivera`);
    // Past what the number-span cap would have allowed, so this pins the reach of the generator
    // rather than a text that happens to fit under either cap.
    expect(spans.length).toBeGreaterThan(MAX_SPANS);
    expect(spans).toContain('alex rivera');

    // And with the caller still talking afterwards the cap really does bite, name included: no
    // cap survives an unbounded opener, the point is that it reaches a hundred-odd words in.
    const rambling = candidateWordSpans(`${opener.join(' ')} alex rivera ${[
      'and', 'i', 'hope', 'that', 'makes', 'sense', 'because', 'nobody', 'seems', 'able', 'to', 'explain', 'any',
      'part', 'of', 'this', 'whole', 'business', 'without', 'putting', 'me', 'through', 'another', 'round', 'of',
      'holding', 'music', 'every', 'single', 'afternoon', 'since', 'roughly', 'halfway', 'through', 'spring',
      'honestly', 'quite', 'tiring', 'now', 'frankly', 'somewhat', 'upsetting', 'really', 'rather', 'exhausting',
    ].join(' ')}`);
    expect(rambling).toHaveLength(MAX_WORD_SPANS);
    expect(rambling).toContain('alex rivera');
  });
});

describe('candidate spans in Spanish (es, es-*)', () => {
  it('offers spans of Spanish number words, accents kept as said, and none of English ones', () => {
    const spans = candidateSpans('mi tarjeta es cincuenta y cinco veintidós', 'es');
    expect(spans).toContain('cincuenta');
    expect(spans).toContain('veintidós');
    expect(spans).toContain('cincuenta y cinco veintidós');
    expect(spans).not.toContain('mi');
    expect(candidateSpans('five five five', 'es')).toEqual([]);
    expect(candidateSpans('cinco cinco cinco')).toEqual([]);
    expect(candidateSpans('cinco cinco cinco', 'en-US')).toEqual([]);
  });

  it('does not let "mil", "cien" or an article qualify a span on its own', () => {
    expect(candidateSpans('estoy cien por ciento seguro', 'es')).toEqual([]);
    expect(candidateSpans('un momento por favor', 'es')).toEqual([]);
    expect(candidateSpans('mil gracias', 'es')).toEqual([]);
    expect(candidateSpans('un cinco', 'es')).toEqual(['cinco', 'un cinco']);
  });

  it('is the English reading, unchanged, for no locale and en-US', () => {
    const text = 'my account is forty four, a hundred percent';
    expect(candidateSpans(text, 'en-US')).toEqual(candidateSpans(text));
    expect(candidateWordSpans("hi it's mary kate o'neil", 'en-US')).toEqual(candidateWordSpans("hi it's mary kate o'neil"));
  });
});

describe('candidate word spans in Spanish (es, es-*)', () => {
  it('keeps accents, drops Spanish fillers at either end, and drops number words', () => {
    const spans = candidateWordSpans('hola, me llamo María José, sí', 'es');
    expect(spans).toContain('maría');
    expect(spans).toContain('maría josé');
    for (const filler of ['hola', 'me', 'llamo', 'sí', 'me llamo', 'llamo maría']) expect(spans).not.toContain(filler);
    expect(candidateWordSpans('soy Ana cinco', 'es')).toEqual(['ana']);
  });

  it('allows particles inside a name, never at its ends, beyond the four words', () => {
    const spans = candidateWordSpans('me llamo María José Muñoz de la Cruz', 'es');
    expect(spans).toContain('maría josé muñoz de la cruz');
    expect(spans).toContain('muñoz de la cruz');
    expect(spans).not.toContain('muñoz de la');
    expect(spans).not.toContain('de la cruz');
    // four words and three particles at most
    expect(candidateWordSpans('ana de la y cruz', 'es')).toContain('ana de la y cruz');
    expect(candidateWordSpans('ana de la de y cruz', 'es')).not.toContain('ana de la de y cruz');
  });

  it('reads English words in English only: Spanish fillers are names in English, and the reverse', () => {
    expect(candidateWordSpans('soy ana', 'en-US')).toContain('soy ana');
    expect(candidateWordSpans('my name is ana', 'es')).toContain('my name is ana');
  });
});
