/**
 * A reply leaves in sentences: the model's text deltas are buffered and each sentence goes on as soon
 * as it ends, so a text-to-speech engine always gets whole sentences (which sound right, and are what a
 * streaming engine waits for anyway). A sentence ends at ".", "?" or "!" (with any closing quotes or
 * brackets) followed by white space; a decimal ("$1.50") has none after its point, and a short
 * abbreviation ("Dr.", "e.g.", "a.m.") or an initial does not end one. What is left at the end of the
 * stream is said as it is. A sentence goes on only once the next one has begun, so the last of a reply
 * is always in what is left, said as the reply's final piece: a final piece is never empty.
 */

/** Words that end in a period without ending a sentence, compared in lower case without the period. */
const ABBREVIATIONS = new Set(['dr', 'mr', 'mrs', 'ms', 'mx', 'st', 'jr', 'sr', 'vs', 'etc', 'e.g', 'i.e', 'a.m', 'p.m', 'approx', 'inc', 'ltd', 'co', 'ave', 'rd', 'mt', 'ft', 'apt', 'dept', 'est']);

const END = /[.?!]+["'”’)\]]*\s+(?=\S)/g;

/** Whether the period ending `before` (the text up to and including it) closes an abbreviation or an initial. */
function abbreviated(before: string): boolean {
  const word = /(?:^|[\s(“"'])([\p{L}.]+)\.$/u.exec(before)?.[1];
  if (word === undefined) return false;
  if (/^\p{Lu}$/u.test(word)) return true;
  return ABBREVIATIONS.has(word.toLowerCase());
}

/** Splits streamed text into sentences: `push` returns the sentences a delta completed, `rest` what is left. */
export class SentenceBuffer {
  private buf = '';

  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    let from = 0;
    END.lastIndex = 0;
    for (let m = END.exec(this.buf); m !== null; m = END.exec(this.buf)) {
      const punct = /^[.?!]+/.exec(m[0])![0];
      if (punct === '.' && abbreviated(this.buf.slice(from, m.index + 1))) continue;
      const end = m.index + m[0].length;
      out.push(this.buf.slice(from, end));
      from = end;
    }
    this.buf = this.buf.slice(from);
    return out;
  }

  /** What is left, and the buffer emptied. */
  rest(): string {
    const r = this.buf;
    this.buf = '';
    return r;
  }
}
