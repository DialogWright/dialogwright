import { getDocumentProxy } from 'unpdf';
import { cleanText, sectionsOf, type Block, type ExtractedDocument } from '../sections';

/**
 * PDF to sections, with unpdf (pdf.js built for servers: pure JavaScript, no canvas, no native code).
 *
 * pdf.js gives each page's text as positioned runs with their font size. The runs are joined into
 * lines (a run on the same baseline continues the line), and the lines into blocks:
 *
 * - The body size is the size most of the document's characters are set in. A short line set at
 *   least 15% larger is a heading; the distinct heading sizes, largest first, are levels 1, 2 and 3
 *   (smaller ones are level 3). Consecutive heading lines of one size are one heading.
 * - Body lines make paragraphs; a vertical gap over 1.6 times the line's size starts a new one. A line
 *   ending in a hyphen joins the next with no space (the hyphen kept), others with one space.
 *
 * `sectionsOf` then cuts the blocks at the headings with page ids (`p2-late-fees`), or by page (`p1`,
 * `p2`) when the document has no headings. A scanned PDF has no text layer and yields no sections:
 * it needs OCR before it can be read.
 */

interface Run {
  str: string;
  transform: number[];
  width: number;
  hasEOL?: boolean;
}

interface Line {
  page: number;
  text: string;
  size: number;
  y: number;
}

/** How much larger than the body a line must be to be a heading. */
const HEADING_RATIO = 1.15;
/** The longest a heading line is. */
const MAX_HEADING_CHARS = 120;
/** A gap between lines over this many times the line's size starts a new paragraph. */
const PARAGRAPH_GAP = 1.6;

/** The runs of one page as lines, in the order pdf.js gives them. */
function linesOf(runs: readonly Run[], page: number): Line[] {
  const lines: Line[] = [];
  let current: (Line & { end: number }) | null = null;
  for (const run of runs) {
    if (typeof run.str !== 'string' || run.str === '') continue;
    const [a = 0, b = 0, c = 0, d = 0, x = 0, y = 0] = run.transform;
    const size = Math.max(Math.hypot(a, b), Math.hypot(c, d));
    if (current && Math.abs(current.y - y) <= Math.max(current.size, size) * 0.5) {
      const gap = x - current.end;
      const space = gap > size * 0.15 && !current.text.endsWith(' ') && !run.str.startsWith(' ');
      current.text += (space ? ' ' : '') + run.str;
      current.size = Math.max(current.size, size);
      current.end = x + run.width;
    } else {
      if (current) lines.push(current);
      current = { page, text: run.str, size, y, end: x + run.width };
    }
  }
  if (current) lines.push(current);
  return lines.map(({ page: p, text, size, y }) => ({ page: p, text: cleanText(text), size: Math.round(size * 10) / 10, y })).filter((l) => l.text !== '');
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

/** Lines to blocks: headings by size, paragraphs by vertical gaps. */
export function blocksOfLines(lines: readonly Line[]): Block[] {
  const body = bodySize(lines);
  const isHeading = (l: Line): boolean => l.size >= body * HEADING_RATIO && l.text.length <= MAX_HEADING_CHARS;
  const sizes = [...new Set(lines.filter(isHeading).map((l) => l.size))].sort((x, y) => y - x);
  const levelOf = (size: number): 1 | 2 | 3 => Math.min(sizes.indexOf(size) + 1, 3) as 1 | 2 | 3;
  const blocks: Block[] = [];
  let prev: Line | null = null;
  for (const line of lines) {
    const last = blocks[blocks.length - 1];
    if (isHeading(line)) {
      if (last?.kind === 'heading' && prev && isHeading(prev) && prev.size === line.size && prev.page === line.page) {
        blocks[blocks.length - 1] = { ...last, text: `${last.text} ${line.text}` };
      } else blocks.push({ kind: 'heading', level: levelOf(line.size), text: line.text, page: line.page });
    } else {
      const continues = last?.kind === 'para' && prev !== null && !isHeading(prev) && prev.page === line.page && prev.y - line.y <= line.size * PARAGRAPH_GAP;
      if (continues) blocks[blocks.length - 1] = { ...last, text: joinLine(last.text, line.text) };
      else blocks.push({ kind: 'para', text: line.text, page: line.page });
    }
    prev = line;
  }
  return blocks;
}

/** A PDF's bytes to sections, with its metadata title when it has one. */
export async function extractPdf(bytes: Uint8Array): Promise<ExtractedDocument & { pages: number }> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  try {
    const lines: Line[] = [];
    for (let n = 1; n <= pdf.numPages; n += 1) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      lines.push(...linesOf(content.items as unknown as Run[], n));
      page.cleanup();
    }
    const read = sectionsOf(blocksOfLines(lines), { paged: true });
    let metaTitle: string | undefined;
    try {
      const info = (await pdf.getMetadata()).info as { Title?: unknown } | undefined;
      metaTitle = typeof info?.Title === 'string' && cleanText(info.Title) !== '' ? cleanText(info.Title) : undefined;
    } catch {
      metaTitle = undefined;
    }
    const title = read.title ?? metaTitle;
    return { ...(title === undefined ? {} : { title }), sections: read.sections, pages: pdf.numPages };
  } finally {
    await pdf.loadingTask.destroy();
  }
}
