/**
 * Text helpers for the review page: where an excerpt is in its section (matched as kb:approve matches
 * it, whitespace aside), and a word diff between a section as it was approved and as it is now.
 */

/** Where `excerpt` is in `text`, matched with every run of whitespace as one space: the start and end in `text`, or null. */
export function excerptRange(text: string, excerpt: string): { start: number; end: number } | null {
  const want = excerpt.replace(/\s+/g, ' ').trim();
  if (want === '') return null;
  // The text with whitespace collapsed, and where each of its characters is in the original.
  let flat = '';
  const at: number[] = [];
  let space = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      space = flat !== '';
      continue;
    }
    if (space) {
      flat += ' ';
      at.push(i);
      space = false;
    }
    flat += ch;
    at.push(i);
  }
  const found = flat.indexOf(want);
  if (found < 0) return null;
  return { start: at[found]!, end: at[found + want.length - 1]! + 1 };
}

/** One run of a diff: words kept, removed or added. */
export interface DiffPart {
  kind: 'same' | 'removed' | 'added';
  text: string;
}

/** The longest diff computed word by word; longer texts are compared line by line. */
const MAX_WORDS = 2000;

/** Words and the whitespace after each, so the parts join back into the text. */
function tokens(text: string, byLine: boolean): string[] {
  return byLine ? text.split(/(?<=\n)/) : (text.match(/\S+\s*/g) ?? []);
}

/** A diff of `before` and `after`, by words (the longest common subsequence), whitespace aside. */
export function wordDiff(before: string, after: string): DiffPart[] {
  const byLine = before.length + after.length > MAX_WORDS * 8;
  const a = tokens(before, byLine);
  const b = tokens(after, byLine);
  const key = (t: string): string => t.trim();
  const n = a.length;
  const m = b.length;
  // lcs[i][j]: the longest common subsequence of a[i..] and b[j..].
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) lcs[i]![j] = key(a[i]!) === key(b[j]!) ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  }
  const parts: DiffPart[] = [];
  const push = (kind: DiffPart['kind'], text: string): void => {
    const last = parts[parts.length - 1];
    if (last && last.kind === kind) last.text += text;
    else parts.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (key(a[i]!) === key(b[j]!)) {
      push('same', b[j]!);
      i += 1;
      j += 1;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) push('removed', a[i++]!);
    else push('added', b[j++]!);
  }
  while (i < n) push('removed', a[i++]!);
  while (j < m) push('added', b[j++]!);
  return parts;
}
