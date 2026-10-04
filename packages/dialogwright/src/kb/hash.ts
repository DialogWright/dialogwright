import { createHash } from 'node:crypto';
import { orderedJson } from '../core/app/configHash';

/**
 * The two hashes an approval records (kb/passages/<id>.yaml `approval`), and how they are taken.
 *
 * - `sourceHash`: SHA-256 of the source section's text, its words with whitespace collapsed (runs of
 *   spaces, tabs and line breaks become one space, and the ends are trimmed), so a re-wrapped
 *   paragraph or a block scalar's style leaves it as it was, and a changed word does not.
 * - `hash`: SHA-256 of the orderedJson of everything approved, in this order: `topic`, `answer`,
 *   `applies`, `effective`, `sourceText`, `accountLineText`. Texts are whitespace-collapsed;
 *   `applies` has its facts sorted and each fact's values as a sorted list (`card: adult` and
 *   `card: [adult]` are the same); `effective` is `{ from, to }` with `to` left out when open-ended;
 *   `accountLineText` is the topic's account line in the passage's locale, or null when it has none.
 *
 * So the approval covers the answer, who it is for, when, what it was drawn from and the line said
 * after it; an edit to any of them after approval is caught, and so is a change to the source.
 */

/** A SHA-256 hex digest of `text` (UTF-8). */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Text with every run of whitespace made one space, trimmed: what is said, and what is hashed. */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** A passage's applies with its facts sorted and each fact's values a sorted, distinct list. */
export function canonicalApplies(applies: Readonly<Record<string, string | readonly string[]>> | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const key of Object.keys(applies ?? {}).sort()) {
    const value = applies![key]!;
    out[key] = [...new Set(typeof value === 'string' ? [value] : value)].sort();
  }
  return out;
}

/** The hash of a source section's text (an approval's `sourceHash`). */
export function sourceHashOf(text: string): string {
  return sha256(collapseWhitespace(text));
}

/** What an approval covers. */
export interface ApprovedContent {
  topic: string;
  answer: string;
  applies: Readonly<Record<string, string | readonly string[]>> | undefined;
  effective: { from: string; to?: string | undefined };
  sourceText: string;
  accountLineText: string | null;
}

/** The hash of everything an approval covers (an approval's `hash`). */
export function approvalHashOf(content: ApprovedContent): string {
  return sha256(
    orderedJson({
      topic: content.topic,
      answer: collapseWhitespace(content.answer),
      applies: canonicalApplies(content.applies),
      effective: content.effective.to === undefined ? { from: content.effective.from } : { from: content.effective.from, to: content.effective.to },
      sourceText: collapseWhitespace(content.sourceText),
      accountLineText: content.accountLineText === null ? null : collapseWhitespace(content.accountLineText),
    }),
  );
}
