import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtractedDocument, ExtractedSection } from '../sections';
import { isBoldFontName, linesOf, MAX_PDF_PAGES, pdfFacts, readPages, type PageLines, type Run } from './pdf';
import type { PlacedLine, Span, TableGrid } from './tables/grid';
import type { Rule } from './tables/rules';

/**
 * A PDF read by LiteParse (`@llamaindex/liteparse`: PDFium with a layout pass, Rust with Node bindings,
 * prebuilt for each platform), kb:ingest's reader of PDFs by default (decided 2026-11-27, on two measured
 * trials: docs/designs/eval/2026-11-tables.md). Ours (./pdf.ts) is still there, by `--reader ours`, and
 * runs beside it on every page as a second opinion of its tables.
 *
 * - Its text items (each with its box, font name, size and weight, and the box of each word) become the
 *   runs our own page and heading logic reads (./pdf.ts `linesOf` and `readPages`: headings, the cover,
 *   the margins and contents pages, the page furniture, continued headings), so a document's sections,
 *   their ids and their pages come out as our reader gives them. LiteParse's own headings are not read.
 *   An item's size is its font's (`fontHeight`), its baseline where its font's ascent puts it; a word set
 *   smaller than the rest of its item is its own run, sized by its box.
 * - A footnote mark LiteParse fused into a figure ("1275" for 275 with mark 1, read from two words of one
 *   item, or a mark of its own item against the figure's) is kept apart from it: a word or an item of one
 *   to three digits or a footnote sign, set smaller (MARK_RATIO of its neighbour's height or less) and
 *   raised (its foot above the neighbour's by RAISED of its height), before a figure or after any word,
 *   is dropped, as ./pdf.ts drops a footnote marker after a word.
 * - Its table blocks (`extractBlocks`: a header and rows of cells, each with its box) become grids
 *   (./tables/grid.ts): each column's edges from the cells of the rows with the most cells, each row's
 *   from its cells' boxes, a cell over several columns a span. The page's own runs fill them, and their
 *   rows are said as our tables' are (./tables/assemble.ts), so a figure sits where its box is even where
 *   LiteParse dropped an empty cell before it. Our readers run on the same lines; where both found a table
 *   and a figure one reading has is not in the other's, or our checker scores LiteParse's weak, the
 *   author is told (./pdf.ts `secondOpinion`): neither reading is chosen silently.
 * - A page with no text layer (no item with text) that LiteParse's own complexity check calls a scan
 *   (`scanned` among its reasons: one image over 90% of the page) is read again with LiteParse's OCR, Tesseract always
 *   named (LiteParse's own OCR model, OCRia-nano, has a restrictive licence and no Intel macOS build, and
 *   pulling it would change how LiteParse reads tables), in English unless the author names another
 *   language. Each section with text from such a page is marked `ocr: true`, and the page is noted, so the
 *   person approving reads it against the page. The first OCR on a machine downloads Tesseract's language
 *   data (about 15 MB): `onOcr` is told before it. A page with no text layer that is no scan (a drawing in
 *   vector lines, pictures, a blank page) is not read, and noted: OCR would make garbled text of it.
 * - The page count is read first by pdf.js (./pdf.ts `pdfFacts`, with its metadata title): a document of
 *   more than 500 pages is refused before LiteParse reads a page.
 *
 * - No learned model is ever used: Tesseract is named, no table model is given, and while LiteParse reads,
 *   the environment names no table model and its model folder is one with nothing in it (`liteParseWith`).
 *
 * LiteParse is loaded only when a PDF is read with it, so ours reads on a machine it does not install on.
 */

/** A word's box within a LiteParse text item: from the page's top, in points. */
export interface LpWord {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A LiteParse text item, as far as it is read here. */
export interface LpTextItem {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly fontName?: string;
  readonly fontSize?: number;
  readonly fontHeight?: number;
  readonly fontAscent?: number;
  readonly fontDescent?: number;
  readonly fontWeight?: number;
  /** Set on an item OCR read. */
  readonly confidence?: number;
  readonly words?: readonly LpWord[];
}

export interface LpRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface LpCell {
  readonly text: string;
  readonly bbox?: LpRect;
  readonly textItemIndices: readonly number[];
}

export interface LpBlock {
  readonly kind: string;
  readonly header?: readonly LpCell[];
  readonly rows?: readonly (readonly LpCell[])[];
  readonly bbox?: LpRect;
  readonly textItemIndices: readonly number[];
}

/** A page as LiteParse parses it, as far as it is read here. */
export interface LpPage {
  readonly pageNum: number;
  readonly width: number;
  readonly height: number;
  readonly textItems: readonly LpTextItem[];
  readonly blocks?: readonly LpBlock[];
  /** LiteParse's own reading of the page (`includeComplexity`): `scanned` among its reasons, or one image over the page, is a scan. */
  readonly complexity?: { readonly reasons: readonly string[]; readonly fullPageImage: boolean };
  readonly vectorGraphics?: {
    readonly shapes: readonly { readonly bbox: LpRect; readonly stroke: boolean; readonly fill: boolean; readonly hasCurve: boolean }[];
    readonly lines: readonly { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number; readonly stroke: boolean }[];
  };
}

export interface LpResult {
  readonly totalPages: number;
  readonly pages: readonly LpPage[];
}

/** What changes from one parse to another: OCR on or off, its language, which pages, and how many are read. */
export interface LiteParseConfig {
  readonly ocrEnabled: boolean;
  readonly ocrLanguage: string;
  readonly maxPages: number;
  readonly targetPages?: string;
}

/** A parser opened with a config (the real one by `openLiteParse`; a test gives a fake). */
export type LiteParseOpen = (config: LiteParseConfig) => { parse(bytes: Uint8Array): Promise<LpResult> };

/** The OCR language when none is named: Tesseract's English. */
export const DEFAULT_OCR_LANGUAGE = 'eng';

/** The version of LiteParse installed, which a source's provenance records (`reader: liteparse@<version>`). */
export function liteParseVersion(): string {
  const require = createRequire(import.meta.url);
  return (require('@llamaindex/liteparse/package.json') as { version: string }).version;
}

/** The reader as a source's provenance records it. */
export const liteParseReader = (): string => `liteparse@${liteParseVersion()}`;

/**
 * A folder that holds no model: LiteParse is told its models are here while it reads, so a model pulled
 * on the machine (OCRia-nano, whose table model would read born-digital pages' tables) is never found.
 */
export const NO_MODELS_DIR = join(tmpdir(), 'dialogwright-kb-author-no-liteparse-models');

/** What LiteParse's own module gives that is used here. */
interface LiteParseModule {
  readonly LiteParse: new (options: Record<string, unknown>) => { parse(input: Buffer): Promise<unknown> };
}

/**
 * LiteParse opened from `load` (its own module, or a test's fake). Every parse names Tesseract, asks for
 * what is read here and gives no table model; and while LiteParse is loaded, made and parses, the environment
 * names no table model (LITEPARSE_TABLE_MODEL, which LiteParse reads) and points its model folder
 * (LITEPARSE_MODEL_DIR) at NO_MODELS_DIR, so the reading is its own layout pass whatever the machine has
 * installed or set. The environment is put back as it was afterwards.
 */
export function liteParseWith(load: () => Promise<LiteParseModule>): LiteParseOpen {
  return (config) => ({
    async parse(bytes) {
      const was = { table: process.env.LITEPARSE_TABLE_MODEL, dir: process.env.LITEPARSE_MODEL_DIR };
      delete process.env.LITEPARSE_TABLE_MODEL;
      process.env.LITEPARSE_MODEL_DIR = NO_MODELS_DIR;
      try {
        let mod: LiteParseModule;
        try {
          mod = await load();
        } catch (error) {
          throw new Error(`LiteParse could not be loaded on this machine (${error instanceof Error ? error.message : String(error)}): read with --reader ours`);
        }
        const parser = new mod.LiteParse({
          ...config,
          ocrBackend: 'tesseract',
          extractBlocks: true,
          emitWordBoxes: true,
          extractTextMetadata: true,
          extractVectorGraphics: true,
          includeComplexity: true,
          outputFormat: 'json',
          quiet: true,
        });
        return (await parser.parse(Buffer.from(bytes))) as LpResult;
      } finally {
        if (was.table === undefined) delete process.env.LITEPARSE_TABLE_MODEL;
        else process.env.LITEPARSE_TABLE_MODEL = was.table;
        if (was.dir === undefined) delete process.env.LITEPARSE_MODEL_DIR;
        else process.env.LITEPARSE_MODEL_DIR = was.dir;
      }
    },
  });
}

/** LiteParse itself, loaded when first used (see liteParseWith). */
export const openLiteParse: LiteParseOpen = liteParseWith(async () => (await import('@llamaindex/liteparse')) as unknown as LiteParseModule);

/** A footnote mark is this much of its neighbour's height or less, and its foot this much of that height above the neighbour's. */
const MARK_RATIO = 0.8;
const RAISED = 0.15;
/** A mark is against its neighbour when the gap between them is at most this much of the neighbour's height. */
const TOUCHING = 0.3;
const MARK = /^[\p{N}*†‡§]{1,3}$/u;
/** A word that starts a figure: a digit, or a sign or currency before one. */
const FIGURE_START = /^[-−–+±$€£(]?[\d.,]/u;

const foot = (b: { y: number; height: number }): number => b.y + b.height;

/** Whether `mark` is a footnote mark against `next` (see the file's comment). */
function isMarkOf(mark: LpWord | LpTextItem, next: LpWord | LpTextItem): boolean {
  return MARK.test(mark.text.trim()) && mark.height <= next.height * MARK_RATIO && foot(mark) <= foot(next) - next.height * RAISED;
}

/** The marks among a page's items that stand alone against a figure (an item of their own): their indexes. */
function standingMarks(items: readonly LpTextItem[]): Set<number> {
  const out = new Set<number>();
  items.forEach((m, i) => {
    if (!MARK.test(m.text.trim())) return;
    const against = items.some((n, j) => {
      if (j === i || n.text.trim() === '' || n.height <= 0) return false;
      const before = n.x - (m.x + m.width);
      const after = m.x - (n.x + n.width);
      const near = (before >= -1 && before <= n.height * TOUCHING && FIGURE_START.test(n.text.trim())) || (after >= -1 && after <= n.height * TOUCHING);
      return near && m.y >= n.y - n.height * 0.5 && m.y <= foot(n) && isMarkOf(m, n);
    });
    if (against) out.add(i);
  });
  return out;
}

/** An item's words with where each starts in its text, or null where the words are not its text in order. */
function wordsAt(item: LpTextItem): { word: LpWord; at: number }[] | null {
  if (item.words === undefined || item.words.length === 0) return null;
  const out: { word: LpWord; at: number }[] = [];
  let from = 0;
  for (const word of item.words) {
    const at = item.text.indexOf(word.text, from);
    if (at < 0 || word.height <= 0) return null;
    out.push({ word, at });
    from = at + word.text.length;
  }
  return out;
}

/**
 * An item as runs (./pdf.ts `Run`: a baseline from the page's bottom and a size), its fused marks dropped:
 * one run, or, where its words are not all of one height (a mark, or a word set apart), a run for each
 * stretch of words of one height.
 */
function runsOfItem(item: LpTextItem, pageHeight: number, font: string): Run[] {
  // How tall the item's box is for its size, and where its baseline is in it, from its font where known.
  const fontSize = item.fontSize !== undefined && item.fontSize > 0 ? item.fontSize : undefined;
  const span = fontSize !== undefined && item.fontAscent !== undefined && item.fontDescent !== undefined ? (item.fontAscent - item.fontDescent) / fontSize : undefined;
  const extent = span !== undefined && span > 0.5 && span < 2 ? span : item.fontHeight !== undefined && item.fontHeight > 0 ? item.height / item.fontHeight : 1.2;
  const ascent = span !== undefined && item.fontAscent !== undefined ? item.fontAscent / (item.fontAscent - item.fontDescent!) : 0.8;
  const run = (str: string, x: number, width: number, top: number, height: number, size?: number): Run => {
    const s = size ?? height / extent;
    return { str, transform: [s, 0, 0, s, x, pageHeight - (top + height * ascent)], width, fontName: font };
  };
  const words = wordsAt(item);
  const uniform = words === null || words.every((w) => Math.abs(w.word.height - words[0]!.word.height) <= words[0]!.word.height * 0.1);
  if (uniform) return [run(item.text, item.x, item.width, item.y, item.height, item.fontHeight !== undefined && item.fontHeight > 0 ? item.fontHeight : undefined)];
  // Each word a mark of its neighbour's (before a figure, or after any word) is dropped; the rest in
  // stretches of one height, each a run, with a space after it where the item has one.
  const all = words!;
  const dropped = all.map((w, k) => {
    const next = all[k + 1]?.word;
    const prev = all[k - 1]?.word;
    return (next !== undefined && FIGURE_START.test(next.text) && isMarkOf(w.word, next)) || (prev !== undefined && isMarkOf(w.word, prev));
  });
  const runs: Run[] = [];
  for (let i = 0; i < all.length; ) {
    if (dropped[i]) {
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < all.length && !dropped[j] && Math.abs(all[j]!.word.height - all[i]!.word.height) <= all[i]!.word.height * 0.1) j += 1;
    const stretch = all.slice(i, j);
    const last = stretch[stretch.length - 1]!;
    const end = last.at + last.word.text.length;
    const spaced = /^\s/.test(item.text.slice(end));
    const top = Math.min(...stretch.map((w) => w.word.y));
    const height = Math.max(...stretch.map((w) => w.word.height));
    runs.push(run(item.text.slice(stretch[0]!.at, end) + (spaced ? ' ' : ''), stretch[0]!.word.x, last.word.x + last.word.width - stretch[0]!.word.x, top, height));
    i = j;
  }
  return runs;
}

/** The lines a page draws, from LiteParse's vector graphics (as ./tables/rules.ts reads them from pdf.js): y from the page's bottom. */
function rulesOfPage(page: LpPage): Rule[] {
  const out: Rule[] = [];
  const H = page.height;
  const h = (y: number, x0: number, x1: number) => {
    if (Math.abs(x1 - x0) >= 2) out.push({ dir: 'h', at: H - y, from: Math.min(x0, x1), to: Math.max(x0, x1) });
  };
  const v = (x: number, y0: number, y1: number) => {
    if (Math.abs(y1 - y0) >= 2) out.push({ dir: 'v', at: x, from: H - Math.max(y0, y1), to: H - Math.min(y0, y1) });
  };
  for (const s of page.vectorGraphics?.shapes ?? []) {
    if (s.hasCurve) continue;
    const { x, y, width, height } = s.bbox;
    if (s.fill && height <= 3) h(y + height / 2, x, x + width);
    else if (s.fill && width <= 3) v(x + width / 2, y, y + height);
    else if (s.stroke) {
      h(y, x, x + width);
      h(y + height, x, x + width);
      v(x, y, y + height);
      v(x + width, y, y + height);
    }
  }
  for (const l of page.vectorGraphics?.lines ?? []) {
    if (!l.stroke) continue;
    if (Math.abs(l.y1 - l.y2) <= 1) h((l.y1 + l.y2) / 2, l.x1, l.x2);
    else if (Math.abs(l.x1 - l.x2) <= 1) v((l.x1 + l.x2) / 2, l.y1, l.y2);
  }
  return out;
}

/** Edges between ranges in order: each one's start, the midpoints of the gaps between them, the last one's end. */
function edgesOf(ranges: readonly (readonly [number, number])[]): number[] {
  const edges = [ranges[0]![0]];
  for (let k = 1; k < ranges.length; k += 1) edges.push((ranges[k - 1]![1] + ranges[k]![0]) / 2);
  edges.push(ranges[ranges.length - 1]![1]);
  return edges;
}

/** A LiteParse table block as a grid (see the file's comment), or null where its cells do not make one. */
export function gridOfBlock(page: LpPage, block: LpBlock): TableGrid | null {
  const header = block.header !== undefined && block.header.some((c) => c.bbox !== undefined) ? [block.header] : [];
  const rows = [...header, ...(block.rows ?? [])].map((r) => r.filter((c): c is LpCell & { bbox: LpRect } => c.bbox !== undefined)).filter((r) => r.length > 0);
  if (rows.length < 2) return null;
  const width = Math.max(...rows.map((r) => r.length));
  if (width < 2) return null;
  // Each column's extent, from the rows with every column's cell, left to right.
  const full = rows.filter((r) => r.length === width).map((r) => [...r].sort((a, b) => a.bbox.x - b.bbox.x));
  const cols = Array.from({ length: width }, (_, k) => [Math.min(...full.map((r) => r[k]!.bbox.x)), Math.max(...full.map((r) => r[k]!.bbox.x + r[k]!.bbox.width))] as [number, number]);
  if (cols.some((c, k) => k > 0 && c[0] < cols[k - 1]![0])) return null;
  const xs = edgesOf(cols);
  const left = Math.min(xs[0]!, ...rows.flat().map((c) => c.bbox.x)) - 1;
  const right = Math.max(xs[xs.length - 1]!, ...rows.flat().map((c) => c.bbox.x + c.bbox.width)) + 1;
  xs[0] = left;
  xs[xs.length - 1] = right;
  // Each row's extent, top to bottom, from the page's top.
  const ys = rows.map((r) => [Math.min(...r.map((c) => c.bbox.y)), Math.max(...r.map((c) => c.bbox.y + c.bbox.height))] as [number, number]);
  if (ys.some((y, k) => k > 0 && y[0] < ys[k - 1]![0])) return null;
  const tops = edgesOf(ys);
  tops[0] = tops[0]! - 1;
  tops[tops.length - 1] = tops[tops.length - 1]! + 1;
  const H = page.height;
  const centre = (k: number) => (xs[k]! + xs[k + 1]!) / 2;
  // A cell over several columns' centres, in a row with fewer cells than the table has columns, is a span.
  const spans: Span[] = [];
  rows.forEach((r, row) => {
    if (r.length === width) return;
    for (const c of r) {
      const over = Array.from({ length: width }, (_, k) => k).filter((k) => centre(k) >= c.bbox.x && centre(k) <= c.bbox.x + c.bbox.width);
      if (over.length > 1 && !spans.some((s) => s.row === row && s.col + s.cols > over[0]! && over[0]! + over.length > s.col)) spans.push({ row, col: over[0]!, rows: 1, cols: over.length });
    }
  });
  return {
    page: page.pageNum,
    reader: 'liteparse',
    columns: Array.from({ length: width }, (_, k) => [xs[k]!, xs[k + 1]!] as const),
    rows: rows.map((_, k) => [H - tops[k]!, H - tops[k + 1]!] as const),
    headRows: header.length,
    spans,
  };
}

/**
 * A grid with its caption left out: LiteParse can read the line over a table (its title, centred over it)
 * into the table's first row, where it would be a column's heading and no longer the heading it is. The
 * top line of the first row, where the row has lines below it, that runs across a column's edge and is
 * centred over the table (its middle within CENTRED of the table's width from the table's) is above the
 * table: the row starts below it.
 */
function withoutCaption(grid: TableGrid, lines: readonly PlacedLine[]): TableGrid {
  const [top, bottom] = grid.rows[0]!;
  const x0 = grid.columns[0]![0];
  const x1 = grid.columns[grid.columns.length - 1]![1];
  const anchor = (l: PlacedLine) => l.y + l.size * 0.3;
  const inRow = lines.filter((l) => anchor(l) <= top && anchor(l) >= bottom && (l.runs ?? []).some((r) => (r.x + r.end) / 2 >= x0 && (r.x + r.end) / 2 <= x1)).sort((a, b) => b.y - a.y);
  const caption = inRow[0];
  const next = inRow.find((l) => caption !== undefined && caption.y - l.y > Math.min(caption.size, l.size) * 0.5);
  if (caption === undefined || next === undefined) return grid;
  const runs = (caption.runs ?? []).filter((r) => r.text.trim() !== '');
  if (runs.length === 0) return grid;
  const from = Math.min(...runs.map((r) => r.x));
  const to = Math.max(...runs.map((r) => r.end));
  const edges = grid.columns.slice(1).map((c) => c[0]);
  const across = edges.some((e) => from < e && to > e);
  const centred = Math.abs((from + to) / 2 - (x0 + x1) / 2) <= (x1 - x0) * CENTRED;
  if (!across || !centred) return grid;
  const cut = (anchor(caption) + anchor(next)) / 2;
  return { ...grid, rows: [[cut, bottom] as const, ...grid.rows.slice(1)] };
}

/** How near a caption's middle is to its table's, as a share of the table's width. */
const CENTRED = 0.05;

/** LiteParse's pages as ours (./pdf.ts `PageLines`), and each page's table grids. */
export function pagesOfLiteParse(pages: readonly LpPage[]): { pages: PageLines[]; grids: Map<number, TableGrid[]> } {
  const out: PageLines[] = [];
  const grids = new Map<number, TableGrid[]>();
  for (const page of [...pages].sort((a, b) => a.pageNum - b.pageNum)) {
    const marks = standingMarks(page.textItems);
    const bold = new Set<string>();
    const runs: Run[] = [];
    page.textItems.forEach((item, i) => {
      if (marks.has(i) || item.text === '') return;
      const isBold = isBoldFontName(item.fontName ?? '') || (item.fontWeight ?? 0) >= 600;
      const font = `${isBold ? 'b' : 'r'}:${item.fontName ?? ''}`;
      if (isBold) bold.add(font);
      runs.push(...runsOfItem(item, page.height, font));
    });
    const rules = rulesOfPage(page);
    const lines = linesOf(runs, page.pageNum, (f) => bold.has(f));
    out.push({ page: page.pageNum, height: page.height, lines, ...(rules.length === 0 ? {} : { rules }) });
    const tables = (page.blocks ?? [])
      .filter((b) => b.kind === 'table')
      .map((b) => gridOfBlock(page, b))
      .filter((g): g is TableGrid => g !== null)
      .map((g) => withoutCaption(g, lines));
    if (tables.length > 0) grids.set(page.pageNum, tables);
  }
  return { pages: out, grids };
}

export interface LiteParseOptions {
  /** The most pages read (default 500). */
  readonly maxPages?: number;
  /** Tesseract's language for a page with no text layer (default `eng`). */
  readonly ocrLanguage?: string;
  /** Told before a document's first OCR that it reads a page so, and that the first OCR on a machine downloads its language data (kb:ingest says it once). */
  readonly onOcr?: (line: string) => void;
  /** The parser (default LiteParse itself; a test gives a fake). */
  readonly open?: LiteParseOpen;
}

const hasText = (page: LpPage): boolean => page.textItems.some((t) => t.text.trim() !== '');
/** A page LiteParse's complexity check calls a scan: `scanned` among its reasons, or one image over the page. */
const isScan = (page: LpPage): boolean => page.complexity !== undefined && (page.complexity.reasons.includes('scanned') || page.complexity.fullPageImage);

/** The sections of a document read from pages some of which OCR read, each with text from one of them marked. */
function markOcr(sections: readonly ExtractedSection[], ocrPages: ReadonlySet<number>): ExtractedSection[] {
  if (ocrPages.size === 0) return [...sections];
  return sections.map((s) => {
    if (s.page === undefined) return s;
    const last = s.lastPage ?? s.page;
    for (let p = s.page; p <= last; p += 1) if (ocrPages.has(p)) return { ...s, ocr: true as const };
    return s;
  });
}

/** A PDF's bytes to sections read by LiteParse (see the file's comment), with its page count and the reader as its provenance records it. */
export async function extractPdfLiteParse(bytes: Uint8Array, options: LiteParseOptions = {}): Promise<ExtractedDocument & { pages: number; reader: string; ocrLanguage?: string }> {
  const maxPages = options.maxPages ?? MAX_PDF_PAGES;
  const ocrLanguage = options.ocrLanguage ?? DEFAULT_OCR_LANGUAGE;
  const { count, metaTitle } = await pdfFacts(bytes, { maxPages });
  const open = options.open ?? openLiteParse;
  const first = await open({ ocrEnabled: false, ocrLanguage, maxPages }).parse(bytes);
  const byPage = new Map(first.pages.map((p) => [p.pageNum, p]));
  // Each page's note, said in the pages' order. A page with no text: a scan is read by OCR below; any other
  // (a drawing, pictures, a blank page) is noted, not read.
  const byPageNote = new Map<number, string>();
  const blank: number[] = [];
  for (const p of first.pages.filter((p) => !hasText(p))) {
    if (isScan(p)) blank.push(p.pageNum);
    else byPageNote.set(p.pageNum, `page ${p.pageNum} has no text layer and looks like a drawing: not read`);
  }
  const ocrPages = new Set<number>();
  if (blank.length > 0) {
    options.onOcr?.(`a PDF page with no text layer is read by OCR (Tesseract, ${ocrLanguage}); the first OCR on this machine downloads Tesseract's language data for it (about 15 MB)`);
    const second = await open({ ocrEnabled: true, ocrLanguage, maxPages, targetPages: blank.join(',') }).parse(bytes);
    for (const p of second.pages) {
      if (!blank.includes(p.pageNum) || !hasText(p)) continue;
      byPage.set(p.pageNum, p);
      ocrPages.add(p.pageNum);
      byPageNote.set(p.pageNum, `page ${p.pageNum}: it has no text layer, so it was read by OCR (Tesseract, ${ocrLanguage}): read its sections against the page before approving a passage from them`);
    }
  }
  const notes = [...byPageNote.entries()].sort((a, b) => a[0] - b[0]).map(([, n]) => n);
  const read = pagesOfLiteParse([...byPage.values()]);
  const doc = readPages(read.pages, new Map(), notes, { name: 'LiteParse', grids: read.grids });
  // A note said once: two of LiteParse's tables over one of ours can differ from it in the same words.
  const noted = doc.notes === undefined ? undefined : [...new Set(doc.notes)];
  const title = doc.title ?? metaTitle;
  const sections = markOcr(doc.sections, ocrPages);
  return {
    ...(title === undefined ? {} : { title }),
    sections,
    ...(noted === undefined ? {} : { notes: noted }),
    pages: count,
    reader: liteParseReader(),
    ...(ocrPages.size > 0 ? { ocrLanguage } : {}),
  };
}
