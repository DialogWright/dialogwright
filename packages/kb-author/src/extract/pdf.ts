import { getDocumentProxy, getResolvedPDFJS } from 'unpdf';
import { cleanText, sectionsOf, type Block, type ExtractedDocument } from '../sections';
import { readTables, type PlacedRun, type RowLine } from './pdfTables';
import { WEAK } from './tables/check';
import { rulesOf, type Rule } from './tables/rules';
import { layoutKey, type TablesCache } from './tables/cache';
import type { TableGrid } from './tables/grid';
import { gridOfModel, pageLayout, type ModelTableReader } from './tables/model';

/**
 * PDF to sections, with unpdf (pdf.js built for servers: pure JavaScript, no canvas, no native code).
 *
 * pdf.js gives each page's text as positioned runs with their font and size. The runs are joined into
 * lines (a run on the same baseline continues the line, unless a gap over 1.5 times its size is before
 * it: a table's next cell), a page's tables are read as their rows (./pdfTables.ts), and the lines are
 * joined into blocks:
 *
 * - A footnote marker is dropped: a run of one to three digits or a footnote sign (or a few, with commas),
 *   set smaller than its line and raised above its baseline ("Benefits⁶" is "Benefits").
 * - What a page carries on its margins is dropped, so it never becomes a section's text: a line in a
 *   page's top or bottom strip (FURNITURE_BAND of its height) whose words (digits aside) come back on at
 *   least a fifth of the pages (three at least) or that start as such a line does (a footer wrapped
 *   otherwise on one page), a short line at a place in the strip that carries text
 *   on that many pages and whose words come back at least once (a chapter's name over its pages), and
 *   a page number there.
 * - A contents page's lines, a title then dot leaders then a page number, are dropped, and so is a section
 *   headed "Contents" or "Table of contents".
 * - A cover is read apart: on a document of more than one page, the first page's lines set in a style
 *   (size and weight) no later page uses and larger than every later heading. Its largest line is the
 *   document's title, and the rest is the first section's text (a plan's name, a number, a date).
 * - The body size is the size most of the document's characters are set in. A line of at most 120
 *   characters set at least 15% larger is a heading; so is a line of at most 80 set in bold at the body
 *   size or larger that does not end in a colon or a stop (a run-in "Benefits include:" is not). On a page
 *   set smaller than the document's body (a summary of benefits before a booklet), such a line at that
 *   page's own body size is a heading too where it starts at the page's left margin, no other line is
 *   within a line's height of it, and text of its own follows it (not a heading at its level or above). The
 *   distinct heading styles, largest first and bold before regular at one size, are levels 1, 2 and 3
 *   (smaller ones are level 3). Consecutive heading lines of one style on one page are one heading,
 *   and one that ends up as a sentence (a stop at its end, or longer than 120) is a paragraph.
 * - A heading that says again the heading its section is under, at the same level with none above it
 *   between (a heading repeated at the top of each page, or "..., continued"), continues that section.
 * - Body lines make paragraphs; a vertical gap over 1.6 times the line's size starts a new one. A line
 *   ending in a hyphen joins the next with no space (the hyphen kept), others with one space.
 *
 * `sectionsOf` then cuts the blocks at the headings (`late-fees`, with `page: 2` recorded), or by page
 * (`p1`, `p2`) when the document has no headings. A scanned PDF has no text layer and yields no sections:
 * it needs OCR before it can be read.
 *
 * It is opened with pdf.js's evaluation of code off (`isEvalSupported: false`: nothing in the file
 * becomes a function). The pdf.js unpdf bundles (6.x) evaluates nothing at all and no longer reads
 * the option, which is passed anyway so an older pdf.js never does; the tests hold the bundle to it.
 * A document of more than 500 pages is refused before any page is read.
 */

/** The most pages a PDF may have to be read. */
export const MAX_PDF_PAGES = 500;

/** How pdf.js opens a PDF here: nothing evaluated as code. */
export const PDF_OPEN_OPTIONS: Readonly<{ isEvalSupported: false }> = { isEvalSupported: false };

/** A PDF refused before it is read: too many pages. */
export class PdfLimitError extends Error {}

export interface Run {
  str: string;
  transform: number[];
  width: number;
  fontName?: string;
  hasEOL?: boolean;
}

/** One line of a page: its text, its size, its baseline (from the page's bottom), and whether it is set in bold. */
export interface Line {
  page: number;
  text: string;
  size: number;
  y: number;
  bold?: boolean;
  /** Its runs where they are on the page (a table's cells are found from them). */
  runs?: readonly PlacedRun[];
  /** A table's row (./pdfTables.ts): said as a paragraph of its own, or a heading over the rows under it. */
  kind?: RowLine['kind'];
}

/** A page's lines, with its height (where its top and bottom strips are) and the lines it draws (a table's borders). */
export interface PageLines {
  page: number;
  height: number;
  lines: readonly Line[];
  rules?: readonly Rule[];
}

/** How much larger than the body a line must be to be a heading. */
const HEADING_RATIO = 1.15;
/** The longest a heading line is. */
const MAX_HEADING_CHARS = 120;
/** The longest a bold line at the body size is, to be a heading. */
const MAX_BOLD_HEADING_CHARS = 80;
/** A gap between lines over this many times the line's size starts a new paragraph. */
const PARAGRAPH_GAP = 1.6;
/** A gap on one baseline over this many times the text's size ends a line: what follows is another cell. */
const CELL_GAP = 1.5;
/** A footnote marker's size is at most this much of its line's. */
const MARKER_RATIO = 0.8;
/** The share of a page's height at its top and at its bottom where headers, footers and page numbers are. */
export const FURNITURE_BAND = 0.07;
/** The share of the pages a margin line comes back on to be the page's furniture (and three pages at least). */
const FURNITURE_SHARE = 0.2;
/** The longest a margin line is to be dropped for its place alone. */
const MAX_PLACED_CHARS = 80;

/** A font's name says it is bold. */
export const isBoldFontName = (name: string): boolean => /bold|black|heavy|semibold|demi/i.test(name);

const MARKER = /^[\p{N}*†‡§]{1,3}(,\s?[\p{N}*†‡§]{1,3}){0,3}$/u;

/** The runs of one page as lines, in the order pdf.js gives them; `bold` says which fonts are bold. */
export function linesOf(runs: readonly Run[], page: number, bold: (fontName: string) => boolean = () => false): Line[] {
  type Open = Line & { end: number; regular: number; placed: PlacedRun[] };
  const lines: Open[] = [];
  let current: Open | null = null;
  for (const run of runs) {
    if (typeof run.str !== 'string' || run.str === '') continue;
    const [a = 0, b = 0, c = 0, d = 0, x = 0, y = 0] = run.transform;
    const size = Math.max(Math.hypot(a, b), Math.hypot(c, d));
    const blank = run.str.trim() === '';
    const regular = !blank && !bold(run.fontName ?? '') ? 1 : 0;
    // A wide gap on one baseline is a table's gutter: the text after it is a cell of its own (./pdfTables.ts).
    const apart = current !== null && !blank && x - current.end > Math.max(current.size, size) * CELL_GAP;
    if (current && !apart && Math.abs(current.y - y) <= Math.max(current.size, size) * 0.5) {
      // A footnote marker: smaller than its line and raised above it.
      if (size <= current.size * MARKER_RATIO && y - current.y >= current.size * 0.15 && MARKER.test(run.str.trim())) continue;
      const gap = x - current.end;
      const space = gap > size * 0.15 && !current.text.endsWith(' ') && !run.str.startsWith(' ');
      current.text += (space ? ' ' : '') + run.str;
      current.size = Math.max(current.size, size);
      // A space as wide as a gutter says nothing of where the text ends.
      if (!blank) current.end = x + run.width;
      current.regular += regular;
      current.placed.push({ x, end: x + run.width, text: run.str, bold: !blank && regular === 0 });
    } else {
      if (current) lines.push(current);
      current = { page, text: run.str, size, y, end: x + run.width, regular: blank ? 0 : regular, placed: [{ x, end: x + run.width, text: run.str, bold: !blank && regular === 0 }] };
    }
  }
  if (current) lines.push(current);
  return lines
    .map(({ page: p, text, size, y, regular, placed }) => ({ page: p, text: cleanText(text), size: Math.round(size * 10) / 10, y, ...(regular === 0 ? { bold: true } : {}), runs: placed }))
    .filter((l) => l.text !== '');
}

/** A line's words with its digits as one sign: a header that numbers its pages is one line on every page. */
const wordsOf = (text: string): string => text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ');
/** How many of a margin line's first characters (its words) say it is the same footer. */
const FURNITURE_PREFIX = 24;
const prefixOf = (text: string): string | null => {
  const words = wordsOf(text);
  return words.length >= FURNITURE_PREFIX ? words.slice(0, FURNITURE_PREFIX) : null;
};
const PAGE_NUMBER = /^(page\s*)?\d{1,4}(\s*(of|\/)\s*\d{1,4})?$/i;
const DOT_LEADERS = /\S.*(\.\s?){4,}\s*\d{1,4}$/;

/** The lines of every page but its furniture (headers, footers, page numbers) and a contents page's lines. */
export function bodyLines(pages: readonly PageLines[]): Line[] {
  const strip = (l: Line, height: number): 'top' | 'bottom' | null => (l.y >= height * (1 - FURNITURE_BAND) ? 'top' : l.y <= height * FURNITURE_BAND ? 'bottom' : null);
  const byWords = new Map<string, Set<number>>();
  const byPlace = new Map<string, Set<number>>();
  const byPrefix = new Map<string, Set<number>>();
  const note = (map: Map<string, Set<number>>, key: string, page: number) => map.set(key, (map.get(key) ?? new Set()).add(page));
  for (const p of pages) {
    for (const l of p.lines) {
      const band = strip(l, p.height);
      if (band === null) continue;
      note(byWords, `${band}:${wordsOf(l.text)}`, p.page);
      const prefix = prefixOf(l.text);
      if (prefix !== null) note(byPrefix, `${band}:${prefix}`, p.page);
      note(byPlace, `${band}:${Math.round(l.y / 2)}`, p.page);
    }
  }
  const enough = Math.max(3, Math.ceil(pages.length * FURNITURE_SHARE));
  const out: Line[] = [];
  for (const p of pages) {
    for (const l of p.lines) {
      if (DOT_LEADERS.test(l.text)) continue;
      const band = strip(l, p.height);
      if (band !== null) {
        if (PAGE_NUMBER.test(l.text)) continue;
        const words = byWords.get(`${band}:${wordsOf(l.text)}`)?.size ?? 0;
        if (words >= enough) continue;
        const prefix = prefixOf(l.text);
        if (prefix !== null && (byPrefix.get(`${band}:${prefix}`)?.size ?? 0) >= enough) continue;
        if ((byPlace.get(`${band}:${Math.round(l.y / 2)}`)?.size ?? 0) >= enough && words >= 2 && l.text.length <= MAX_PLACED_CHARS) continue;
      }
      out.push(l);
    }
  }
  return out;
}

/** The size most characters are set in. */
function bodySize(lines: readonly Line[]): number {
  const chars = new Map<number, number>();
  for (const l of lines) chars.set(l.size, (chars.get(l.size) ?? 0) + l.text.length);
  let best = 0;
  let most = -1;
  for (const [size, count] of [...chars.entries()].sort((x, y) => x[0] - y[0])) {
    if (count > most) {
      best = size;
      most = count;
    }
  }
  return best;
}

/** Two lines joined as one paragraph's text. */
function joinLine(text: string, next: string): string {
  return /\p{L}-$/u.test(text) && /^\p{Ll}/u.test(next) ? text + next : `${text} ${next}`;
}

const styleOf = (l: Line): string => `${l.size}${l.bold ? 'b' : ''}`;

/** Whether a line is a heading, by its size and weight against the body's (see the file's comment). */
function headingTest(body: number): (l: Line) => boolean {
  return (l) => l.text.length <= MAX_HEADING_CHARS && (l.size >= body * HEADING_RATIO || boldHeading(l, body));
}

/** A bold line at `body` size or larger, short, that does not end in a colon or a stop. */
const boldHeading = (l: Line, body: number): boolean => l.bold === true && l.size >= body && l.text.length <= MAX_BOLD_HEADING_CHARS && !/[:.;,]$/.test(l.text);

/** Where a line starts on its page, where its runs say. */
const leftOf = (l: Line): number | undefined => l.runs?.[0]?.x;

/**
 * Whether a line is a heading of a page set smaller than the document's body (see the file's comment): bold
 * at its page's body size, at the page's left margin, and no other line within a line's height of its
 * baseline (not a label's value, a table's cell, or a box's caption beside another column's text).
 */
function pageHeadingTest(lines: readonly Line[], body: number): (l: Line) => boolean {
  const byPage = new Map<number, Line[]>();
  for (const l of lines) byPage.set(l.page, [...(byPage.get(l.page) ?? []), l]);
  const bodies = new Map([...byPage].map(([page, ls]) => [page, bodySize(ls)]));
  const margins = new Map([...byPage].map(([page, ls]) => [page, Math.min(...ls.map((l) => leftOf(l) ?? Infinity))]));
  return (l) => {
    const pageBody = bodies.get(l.page) ?? body;
    if (pageBody >= body || l.text.length > MAX_HEADING_CHARS || !boldHeading(l, pageBody)) return false;
    const x = leftOf(l);
    if (x !== undefined && x > (margins.get(l.page) ?? x) + l.size * 0.5) return false;
    return !(byPage.get(l.page) ?? []).some((o) => o !== l && Math.abs(o.y - l.y) < Math.max(o.size, l.size));
  };
}



/**
 * A document's cover, read apart from its body (see the file's comment): its title and the rest of its
 * text, and the lines left. None on a document of one page, or whose first page sets nothing apart.
 */
export function coverOf(lines: readonly Line[]): { title?: string; text: string[]; rest: Line[] } {
  const pages = new Set(lines.map((l) => l.page));
  if (pages.size < 2) return { text: [], rest: [...lines] };
  const first = Math.min(...pages);
  const later = lines.filter((l) => l.page !== first);
  const isHeading = headingTest(bodySize(lines));
  const laterStyles = new Set(later.map(styleOf));
  const top = Math.max(0, ...later.filter(isHeading).map((l) => l.size));
  const cover = lines.filter((l) => l.page === first && !laterStyles.has(styleOf(l)) && l.size > top);
  if (cover.length === 0) return { text: [], rest: [...lines] };
  const largest = Math.max(...cover.map((l) => l.size));
  const title = cover.filter((l) => l.size === largest).map((l) => l.text).join(' ');
  const text: string[] = [];
  for (const l of cover) {
    if (l.size === largest) continue;
    const prev = cover[cover.indexOf(l) - 1];
    if (prev && styleOf(prev) === styleOf(l) && text.length > 0) text[text.length - 1] = `${text[text.length - 1]} ${l.text}`;
    else text.push(l.text);
  }
  return { title, text, rest: lines.filter((l) => !cover.includes(l)) };
}

/** A heading's words to compare with another's: a "continued" at its end dropped. */
const sameHeading = (text: string): string => cleanText(text.toLowerCase().replace(/[,;:\s]*\(?(continued|cont'?d\.?)\)?\s*$/, ''));

/** Lines to blocks: headings by size and weight, paragraphs by vertical gaps. */
export function blocksOfLines(lines: readonly Line[]): Block[] {
  const body = bodySize(lines);
  const plain = headingTest(body);
  const onPage = pageHeadingTest(lines, body);
  const isHeading = (l: Line): boolean => l.kind === undefined && (plain(l) || onPage(l));
  // The headings found by their page's body alone: each must have text of its own under it (below).
  const byPage = new WeakSet<Block>();
  const styles = [...new Map(lines.filter(isHeading).map((l) => [styleOf(l), l])).values()]
    .sort((x, y) => y.size - x.size || Number(y.bold === true) - Number(x.bold === true))
    .map(styleOf);
  const levelOf = (l: Line): 1 | 2 | 3 => Math.min(styles.indexOf(styleOf(l)) + 1, 3) as 1 | 2 | 3;
  const blocks: Block[] = [];
  let prev: Line | null = null;
  for (const line of lines) {
    const last = blocks[blocks.length - 1];
    if (line.kind === 'row') {
      blocks.push({ kind: 'para', text: line.text, page: line.page });
      prev = null;
      continue;
    }
    if (line.kind === 'group') {
      blocks.push({ kind: 'heading', level: 3, text: line.text, page: line.page });
      prev = null;
      continue;
    }
    if (isHeading(line)) {
      if (last?.kind === 'heading' && prev && isHeading(prev) && styleOf(prev) === styleOf(line) && prev.page === line.page) {
        const joined: Block = { ...last, text: `${last.text} ${line.text}` };
        if (byPage.has(last)) byPage.add(joined);
        blocks[blocks.length - 1] = joined;
      } else {
        const heading: Block = { kind: 'heading', level: levelOf(line), text: line.text, page: line.page };
        if (!plain(line)) byPage.add(heading);
        blocks.push(heading);
      }
    } else {
      const continues = last?.kind === 'para' && prev !== null && !isHeading(prev) && prev.page === line.page && prev.y - line.y <= line.size * PARAGRAPH_GAP;
      if (continues) blocks[blocks.length - 1] = { ...last, text: joinLine(last.text, line.text) };
      else blocks.push({ kind: 'para', text: line.text, page: line.page });
    }
    prev = line;
  }
  // A heading that ended up as a sentence is a paragraph; one that says again the heading its section
  // is under continues that section.
  const out: Block[] = [];
  const open: (string | undefined)[] = [];
  blocks.forEach((b, i) => {
    if (b.kind !== 'heading') {
      out.push(b);
      return;
    }
    // A heading found by its page's body with nothing under it (the next block a heading at its level or
    // above, or none) is a line of its page's text: a plan's name or a date set in bold over a summary.
    const next = blocks[i + 1];
    const empty = next === undefined || (next.kind === 'heading' && next.level <= b.level);
    if (b.text.length > MAX_HEADING_CHARS || /[.;]$/.test(b.text) || (byPage.has(b) && empty)) {
      out.push({ kind: 'para', text: b.text, ...(b.page === undefined ? {} : { page: b.page }) });
      return;
    }
    if (open[b.level] !== undefined && open[b.level] === sameHeading(b.text)) return;
    open[b.level] = sameHeading(b.text);
    open.length = b.level + 1;
    out.push(b);
  });
  return out;
}

/**
 * A document's pages read to sections: its furniture dropped, its cover read apart, its body cut at its
 * headings; and a note for each table its check found weak (./tables/check.ts), for the author to read
 * against the page.
 */
export function readPages(pages: readonly PageLines[], proposed: ReadonlyMap<number, readonly TableGrid[]> = new Map(), modelNotes: readonly string[] = []): ExtractedDocument {
  const body = bodyLines(pages);
  const tabled: Line[] = [];
  const notes: string[] = [...modelNotes];
  for (const p of pages) {
    const read = readTables(body.filter((l) => l.page === p.page), p.rules, proposed.get(p.page) ?? []);
    tabled.push(...(read.lines as Line[]));
    for (const t of read.tables.filter((t) => t.check.score < WEAK)) {
      const { grid } = t.table;
      notes.push(`page ${p.page}: a table of ${grid.columns.length} columns and ${grid.rows.length - grid.headRows} rows read weakly (${t.check.score.toFixed(2)}): ${t.check.problems.join('; ')}`);
    }
  }
  const cover = coverOf(tabled);
  const blocks: Block[] = [
    ...cover.text.map((text): Block => ({ kind: 'para', text, page: Math.min(...pages.map((p) => p.page)) })),
    ...blocksOfLines(cover.rest),
  ];
  // A contents page's heading, and what is under it until the next heading.
  const CONTENTS = /^(table of )?contents$/i;
  const kept: Block[] = [];
  let contents = false;
  for (const b of blocks) {
    if (b.kind === 'heading') contents = CONTENTS.test(b.text);
    if (!contents) kept.push(b);
  }
  const read = sectionsOf(kept, { paged: true, ...(cover.title === undefined ? {} : { titled: true }) });
  const title = cover.title ?? read.title;
  return { ...(title === undefined ? {} : { title }), sections: read.sections, ...(notes.length === 0 ? {} : { notes }) };
}

/** A PDF's pages as lines, and its metadata title (refused over `maxPages`, default 500). */
export async function pdfPages(bytes: Uint8Array, options: { maxPages?: number } = {}): Promise<{ pages: PageLines[]; count: number; metaTitle?: string }> {
  const maxPages = options.maxPages ?? MAX_PDF_PAGES;
  const pdf = await getDocumentProxy(new Uint8Array(bytes), { ...PDF_OPEN_OPTIONS } as Parameters<typeof getDocumentProxy>[1]);
  const { OPS } = (await getResolvedPDFJS()) as unknown as { OPS: Record<string, number> };
  try {
    if (pdf.numPages > maxPages) throw new PdfLimitError(`it has ${pdf.numPages} pages, over the ${maxPages} read`);
    const pages: PageLines[] = [];
    for (let n = 1; n <= pdf.numPages; n += 1) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      // The fonts' names (which say which are bold) are known once the page's operators are read; the
      // operators also draw the page's lines (a table's borders).
      const bold = new Map<string, boolean>();
      let rules: Rule[] = [];
      try {
        const ops = await page.getOperatorList();
        rules = rulesOf(ops.fnArray, ops.argsArray, OPS);
      } catch {
        // No weights or lines for this page: its lines are read by their size alone, its tables by where their text is.
      }
      const isBold = (fontName: string): boolean => {
        if (!bold.has(fontName)) {
          let name = '';
          try {
            name = String((page.commonObjs.get(fontName) as { name?: unknown } | undefined)?.name ?? '');
          } catch {
            name = '';
          }
          bold.set(fontName, isBoldFontName(name));
        }
        return bold.get(fontName)!;
      };
      pages.push({ page: n, height: page.getViewport({ scale: 1 }).height, lines: linesOf(content.items as unknown as Run[], n, isBold), ...(rules.length === 0 ? {} : { rules }) });
      page.cleanup();
    }
    let metaTitle: string | undefined;
    try {
      const info = (await pdf.getMetadata()).info as { Title?: unknown } | undefined;
      metaTitle = typeof info?.Title === 'string' && cleanText(info.Title) !== '' ? cleanText(info.Title) : undefined;
    } catch {
      metaTitle = undefined;
    }
    return { pages, count: pdf.numPages, ...(metaTitle === undefined ? {} : { metaTitle }) };
  } finally {
    await pdf.loadingTask.destroy();
  }
}

/**
 * A model's tables for a PDF (./tables/model.ts): the cache of grids a model gave for pages before (by
 * their layout), and the model to ask for a page with a table the cache does not have; without a model,
 * the cache alone.
 */
export interface PdfTablesOptions {
  readonly cache: TablesCache;
  readonly reader?: ModelTableReader;
  /** Counted as pages are asked or found in the cache, for the report. */
  readonly counts?: { asked: number; cached: number };
}

/**
 * Each page's grids from a model, where a reader finds a table on it: from the cache by the page's layout,
 * else asked of the model and kept; and what could not be had, as notes.
 */
async function modelGridsOf(pages: readonly PageLines[], tables: PdfTablesOptions): Promise<{ grids: Map<number, TableGrid[]>; notes: string[] }> {
  const body = bodyLines(pages);
  const grids = new Map<number, TableGrid[]>();
  const notes: string[] = [];
  for (const p of pages) {
    const lines = body.filter((l) => l.page === p.page);
    // Only a page where a reader finds a table: the model reads it better, it does not look for tables in prose.
    if (readTables(lines, p.rules).tables.length === 0) continue;
    const layout = pageLayout(lines, p.rules ?? []);
    const key = layoutKey(layout);
    let answer = tables.cache.get(key)?.tables;
    if (answer !== undefined) {
      if (tables.counts) tables.counts.cached += 1;
    } else if (tables.reader !== undefined) {
      try {
        answer = await tables.reader.propose(p.page, layout);
        tables.cache.set(key, tables.reader.id, answer);
        if (tables.counts) tables.counts.asked += 1;
      } catch (error) {
        notes.push(`page ${p.page}: the model could not read its tables (${error instanceof Error ? error.message : String(error)})`);
      }
    }
    const ok: TableGrid[] = [];
    for (const t of answer ?? []) {
      const g = gridOfModel(p.page, t);
      if (typeof g === 'string') notes.push(`page ${p.page}: a table the model gave was not used: ${g}`);
      else ok.push(g);
    }
    if (ok.length > 0) grids.set(p.page, ok);
  }
  return { grids, notes };
}

/** A PDF's bytes to sections, with its metadata title when it has one (refused over `maxPages`, default 500); with `tables`, a model's tables read beside the others'. */
export async function extractPdf(bytes: Uint8Array, options: { maxPages?: number; tables?: PdfTablesOptions } = {}): Promise<ExtractedDocument & { pages: number }> {
  const { pages, count, metaTitle } = await pdfPages(bytes, options);
  const model = options.tables !== undefined ? await modelGridsOf(pages, options.tables) : { grids: new Map<number, TableGrid[]>(), notes: [] };
  const read = readPages(pages, model.grids, model.notes);
  const title = read.title ?? metaTitle;
  return { ...(title === undefined ? {} : { title }), sections: read.sections, ...(read.notes === undefined ? {} : { notes: read.notes }), pages: count };
}
