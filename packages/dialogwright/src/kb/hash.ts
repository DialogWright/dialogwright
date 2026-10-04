import { createHash } from 'node:crypto';
import { orderedJson } from '../core/app/configHash';

/**
 * The two hashes an approval records (kb/passages/<id>.yaml `approval`), and how they are taken.
 *
 * - `sourceHash`: SHA-256 of the source section's text, its words with whitespace collapsed (runs of
 *   spaces, tabs and line breaks become one space, and the ends are trimmed), so a re-wrapped
 *   paragraph or a block scalar's style leaves it as it was, and a changed word does not.
 * - `hash`: SHA-256 of the orderedJson of everything approved, in this order: `id`, `locale`,
 *   `version`, `topic`, `title`, `localeTitle`, `answer`, `applies`, `effective`, `sourceText`,
 *   `accountLineText`. `id` and `version` are the passage's own; `locale` is the tag of the locale
 *   folder it is in (kb/locale/<tag>/passages), or null for kb/passages, the app's default locale
 *   whatever its tag (the folder does not name it, and a tool that reads a kb folder on its own
 *   reads it as en-US); `title` is its topic's title (null when there is no such topic) and
 *   `localeTitle` the topic's title in the passage's locale (null in the default locale, or where
 *   the locale gives none and the default title is said): a topic's title is spoken (the topic
 *   question offers it, and a caller choosing between two hears it). Texts are
 *   whitespace-collapsed; `applies` has its facts sorted and each fact's values as a sorted list
 *   (`card: adult` and `card: [adult]` are the same); `effective` is `{ from, to }` with `to` left
 *   out when open-ended; `accountLineText` is the topic's account line in the passage's locale, or
 *   null when it has none.
 *
 * So the approval covers which passage it is and in which language, the answer, the title it is
 * offered under, who it is for, when, what it was drawn from and the line said after it; an edit to
 * any of them after approval is caught (a passage copied to another id or locale with its approval
 * is not fresh there), and so is a change to the source. (Before the knowledge base's first release
 * the hash covered the topic, answer, applies, dates, source text and account line only.)
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
  /** The passage's id (its file's name). */
  id: string;
  /** The tag of the locale folder it is in; null for kb/passages, the app's default locale. */
  locale: string | null;
  /** The passage's own version. */
  version: string;
  topic: string;
  /** The topic's title; null when the knowledge base has no such topic. */
  title: string | null;
  /** The topic's title in the passage's locale; null in the default locale, or where the locale gives none. */
  localeTitle: string | null;
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
      id: content.id,
      locale: content.locale,
      version: content.version,
      topic: content.topic,
      title: content.title === null ? null : collapseWhitespace(content.title),
      localeTitle: content.localeTitle === null ? null : collapseWhitespace(content.localeTitle),
      answer: collapseWhitespace(content.answer),
      applies: canonicalApplies(content.applies),
      effective: content.effective.to === undefined ? { from: content.effective.from } : { from: content.effective.from, to: content.effective.to },
      sourceText: collapseWhitespace(content.sourceText),
      accountLineText: content.accountLineText === null ? null : collapseWhitespace(content.accountLineText),
    }),
  );
}
