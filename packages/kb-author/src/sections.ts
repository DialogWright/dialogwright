/**
 * The model every extractor produces, and how it becomes a source document's sections.
 *
 * An extractor reads a document into blocks in reading order: headings (levels 1 to 3; a deeper
 * heading is read as a paragraph), paragraphs and list items (a table row is an item too), each with
 * the page it is on when the format has pages. `sectionsOf` cuts the blocks into sections at the
 * headings:
 *
 * - The title heading (the first heading, when no other heading is at its level or above) names the
 *   document and starts no section of its own: what follows it, up to the next heading, is `intro`.
 *   A document that names its title elsewhere (`titled`: a DOCX Title paragraph, Markdown front
 *   matter) has none.
 * - A section's id is the slug of its heading path (`late-fees`, `shifts/training`), so it reads as
 *   the document's outline and does not move when a section is added elsewhere. Content before any
 *   heading is `intro`; a document with no headings at all is one section, `text`.
 * - With pages (a PDF), every id says the page its section starts on: `p2-late-fees`, and `p3` for
 *   a page's text before its first heading. A PDF with no headings is cut by page: `p1`, `p2`, ...
 * - Two sections with the same id are told apart in document order: `training`, `training-2`.
 *
 * A section's text keeps its paragraphs (a blank line between them; list items one to a line), with
 * whitespace inside each collapsed. Hashing (dialogwright's sourceHashOf) collapses all of it, so a
 * re-wrapped paragraph keeps its hash and a changed word does not.
 */

export type Block =
  | { readonly kind: 'heading'; readonly level: 1 | 2 | 3; readonly text: string; readonly page?: number }
  | { readonly kind: 'para' | 'item'; readonly text: string; readonly page?: number };

/** One section of an extracted document. */
export interface ExtractedSection {
  /** Its id: the slug of its heading path, with its first page for a paged document. */
  readonly id: string;
  /** Its heading as the document has it (none for `intro`, `text` and a page's text). */
  readonly heading?: string;
  /** Its text, paragraphs kept. Never empty. */
  readonly text: string;
  /** The page it starts on, for a paged document. */
  readonly page?: number;
}

/** A document read into sections. */
export interface ExtractedDocument {
  /** Its title, when the document gives one (its title heading, or its metadata). */
  readonly title?: string;
  readonly sections: readonly ExtractedSection[];
}

/** Characters that are never text: soft hyphens, zero-width spaces and joiners, byte-order marks. */
const INVISIBLE = /[­​‌‍⁠﻿]/g;

/** A run of text as one line: Unicode-normalized, invisible characters dropped, whitespace collapsed. */
export function cleanText(text: string): string {
  return text.normalize('NFC').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
}

/** Text whose line breaks matter (a `<br>`, a `<pre>`): each line cleaned, empty lines dropped. */
export function cleanLines(text: string): string {
  return text
    .split('\n')
    .map(cleanText)
    .filter((line) => line !== '')
    .join('\n');
}

/** The longest a slug is: long headings are cut at a word. */
const MAX_SLUG = 48;

/** A readable id from text: lowercase ASCII letters and digits joined by hyphens, accents dropped. */
export function slugOf(text: string, fallback = 'section'): string {
  const slug = text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug === '') return fallback;
  if (slug.length <= MAX_SLUG) return slug;
  const cut = slug.slice(0, MAX_SLUG + 1);
  const at = cut.lastIndexOf('-');
  return (at > 0 ? cut.slice(0, at) : slug.slice(0, MAX_SLUG)).replace(/-+$/, '');
}

/** `id`, or `id-2`, `id-3`, ... : the first that `taken` does not have (which it then has). */
export function distinct(id: string, taken: Set<string>): string {
  let out = id;
  for (let n = 2; taken.has(out); n += 1) out = `${id}-${n}`;
  taken.add(out);
  return out;
}

/** The index of the title heading in `blocks`, or -1: the first heading, when no other is at its level or above. */
function titleHeadingAt(blocks: readonly Block[]): number {
  const first = blocks.findIndex((b) => b.kind === 'heading');
  if (first < 0) return -1;
  const level = (blocks[first] as Extract<Block, { kind: 'heading' }>).level;
  const rival = blocks.some((b, i) => i !== first && b.kind === 'heading' && b.level <= level);
  return rival ? -1 : first;
}

/** Paragraphs joined as a section's text: a blank line between paragraphs, one line break between list items. */
function joinBlocks(blocks: readonly Block[]): string {
  let out = '';
  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i]!;
    if (i > 0) out += b.kind === 'item' && blocks[i - 1]!.kind === 'item' ? '\n' : '\n\n';
    out += b.text;
  }
  return out;
}

/** The blocks of a document cut into sections at its headings (see the file's comment). */
export function sectionsOf(blocks: readonly Block[], options: { paged?: boolean; titled?: boolean } = {}): ExtractedDocument {
  const paged = options.paged ?? false;
  const titleAt = options.titled ? -1 : titleHeadingAt(blocks);
  const title = titleAt >= 0 ? blocks[titleAt]!.text : undefined;
  const headed = blocks.some((b, i) => b.kind === 'heading' && i !== titleAt);
  const taken = new Set<string>();
  const sections: ExtractedSection[] = [];

  const push = (base: string, heading: string | undefined, body: Block[], page: number | undefined): void => {
    const content = body.filter((b) => b.text !== '');
    if (content.length === 0) return;
    sections.push({ id: distinct(base, taken), ...(heading === undefined ? {} : { heading }), text: joinBlocks(content), ...(page === undefined ? {} : { page }) });
  };

  if (paged && !headed) {
    // No headings: one section a page.
    const pages = new Map<number, Block[]>();
    for (const b of blocks) {
      if (b.kind === 'heading') continue;
      const page = b.page ?? 1;
      pages.set(page, [...(pages.get(page) ?? []), b]);
    }
    for (const [page, body] of [...pages.entries()].sort((a, b) => a[0] - b[0])) push(`p${page}`, undefined, body, page);
    return { ...(title === undefined ? {} : { title }), sections };
  }

  const stack: { level: number; slug: string }[] = [];
  let current: { base: string; heading: string | undefined; body: Block[]; page: number | undefined } | null = null;
  const flush = (): void => {
    if (current) push(current.base, current.heading, current.body, current.page);
    current = null;
  };
  const preamble = (page: number | undefined): string => (paged ? `p${page ?? 1}` : headed ? 'intro' : 'text');

  blocks.forEach((b, i) => {
    if (i === titleAt) return;
    if (b.kind === 'heading') {
      flush();
      while (stack.length > 0 && stack[stack.length - 1]!.level >= b.level) stack.pop();
      stack.push({ level: b.level, slug: slugOf(b.text) });
      const path = stack.map((s) => s.slug).join('/');
      current = { base: paged ? `p${b.page ?? 1}-${path}` : path, heading: b.text, body: [], page: b.page };
      return;
    }
    if (current === null) current = { base: preamble(b.page), heading: undefined, body: [], page: b.page };
    current.body.push(b);
  });
  flush();
  return { ...(title === undefined ? {} : { title }), sections };
}
