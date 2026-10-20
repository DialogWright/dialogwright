import { readTables, type TableRead } from '../pdfTables';
import { bodyLines, pdfPages, type PageLines } from '../pdf';
import { joinCell } from './grid';
import type { LabelCell, LabelFile, LabelTable } from './labels';

/**
 * The tables read from a document scored on its labels (./labels.ts): for each labelled table, the
 * table read on its page that has the most of its cells right, and how many of its cells, whole rows
 * and headings that table has right. Cells are compared without case or spacing (a PDF's spaces are
 * where its runs fall, not where a reader sees them), and the checker's score of the table is kept
 * beside them, so how well the checker sees a weak table is measured too.
 */

export interface Tally {
  readonly right: number;
  readonly of: number;
}

export interface TableScore {
  readonly page: number;
  readonly name: string;
  /** The reader of the table matched, and the checker's score of it; absent when no table read has any of its cells (not found). */
  readonly reader?: string;
  readonly check?: number;
  readonly cells: Tally;
  readonly rows: Tally;
  readonly heads: Tally;
  /** The first cells it has wrong: the label, and the row it was matched with as read. */
  readonly misses: readonly { readonly label: string; readonly row: string | null }[];
}

export interface DocumentScore {
  readonly document: string;
  readonly tables: readonly TableScore[];
  /** Labelled words not found in the page's text (a slip in the labels, or a word the page draws as a picture). */
  readonly unseen: readonly { readonly page: number; readonly words: string }[];
}

const MISSES = 3;

/** A cell's text as compared: no case, no spacing, one form of each quote and dash. */
export const comparable = (text: string): string =>
  text.normalize('NFKC').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[\u2010-\u2015\u2212]/g, '-').replace(/\s+/g, '');

/** A read table's body rows, each its cells' texts; and its headings: each column's, and those over several columns. */
function partsOf(read: TableRead): { rows: string[][]; columnHeads: string[]; spanHeads: string[] } {
  const { grid, cells } = read.table;
  const columnHeads = grid.columns.map(() => '');
  const spanHeads: string[] = [];
  for (let r = 0; r < grid.headRows; r += 1) {
    cells[r]!.forEach((c, k) => {
      if (c.covered === true || c.text === '') return;
      if (c.span !== undefined && c.span.cols > 1) spanHeads.push(c.text);
      else columnHeads[k] = joinCell(columnHeads[k]!, c.text);
    });
  }
  const rows = cells.slice(grid.headRows).map((row) => row.filter((c) => c.covered !== true && c.text !== '').map((c) => c.text));
  return { rows, columnHeads, spanHeads };
}

/** A labelled table's headings: each column's (its cells over one column, top to bottom), and those over several. */
function labelHeads(table: LabelTable): { columnHeads: string[]; spanHeads: string[] } {
  const columnHeads = Array.from({ length: table.columns }, () => '');
  const spanHeads: string[] = [];
  for (const row of table.heads) {
    for (const c of row) {
      if (c.cols > 1) spanHeads.push(c.text);
      else columnHeads[c.col] = columnHeads[c.col] === '' ? c.text : `${columnHeads[c.col]} ${c.text}`;
    }
  }
  return { columnHeads: columnHeads.filter((h) => h !== ''), spanHeads };
}

/** A labelled table scored against one read table. */
function scoreAgainst(table: LabelTable, read: TableRead): Omit<TableScore, 'page' | 'name'> {
  const got = partsOf(read);
  const want = table.rows.map((row) => row.map((c: LabelCell) => c.text));
  // Each labelled row with the read row sharing most of its cells, best pairs first, each read row once.
  const pairs: { w: number; g: number; same: number }[] = [];
  want.forEach((row, w) => {
    got.rows.forEach((cells, g) => {
      const have = new Set(cells.map(comparable));
      const same = row.filter((t) => have.has(comparable(t))).length;
      if (same > 0) pairs.push({ w, g, same });
    });
  });
  pairs.sort((a, b) => b.same - a.same || a.w - b.w || a.g - b.g);
  const matched = new Map<number, number>();
  const used = new Set<number>();
  for (const p of pairs) {
    if (matched.has(p.w) || used.has(p.g)) continue;
    matched.set(p.w, p.g);
    used.add(p.g);
  }
  let right = 0;
  let whole = 0;
  const misses: { label: string; row: string | null }[] = [];
  want.forEach((row, w) => {
    const g = matched.get(w);
    const have = new Set((g === undefined ? [] : got.rows[g]!).map(comparable));
    const ok = row.filter((t) => have.has(comparable(t)));
    right += ok.length;
    if (ok.length === row.length) whole += 1;
    for (const t of row.filter((t) => !have.has(comparable(t)))) {
      if (misses.length < MISSES) misses.push({ label: t, row: g === undefined ? null : got.rows[g]!.join(' | ') });
    }
  });
  const heads = labelHeads(table);
  const readHeads = new Set([...got.columnHeads, ...got.spanHeads].filter((h) => h !== '').map(comparable));
  const wantHeads = [...heads.columnHeads, ...heads.spanHeads];
  return {
    reader: read.table.grid.reader,
    check: read.check.score,
    cells: { right, of: want.reduce((n, row) => n + row.length, 0) },
    rows: { right: whole, of: want.length },
    heads: { right: wantHeads.filter((h) => readHeads.has(comparable(h))).length, of: wantHeads.length },
    misses,
  };
}

/** The tables read from `pages` scored on `labels` (see the file's comment). */
export function scorePages(pages: readonly PageLines[], labels: LabelFile): DocumentScore {
  const body = bodyLines(pages);
  const readOn = new Map<number, TableRead[]>();
  const tables: TableScore[] = [];
  const unseen: { page: number; words: string }[] = [];
  for (const table of labels.tables) {
    if (!readOn.has(table.page)) readOn.set(table.page, readTables(body.filter((l) => l.page === table.page)).tables);
    const reads = readOn.get(table.page)!;
    // The read table with most of its cells; none when no read table has any of them (not found).
    const scored = reads.map((r) => scoreAgainst(table, r)).filter((s) => s.cells.right > 0).sort((a, b) => b.cells.right - a.cells.right)[0];
    const of = table.rows.reduce((n, row) => n + row.length, 0);
    const heads = labelHeads(table);
    const none = { cells: { right: 0, of }, rows: { right: 0, of: table.rows.length }, heads: { right: 0, of: heads.columnHeads.length + heads.spanHeads.length }, misses: [] };
    tables.push({ page: table.page, name: table.name, ...(scored ?? none) });
    // The labelled words the page's text does not have.
    const page = pages.find((p) => p.page === table.page);
    const text = comparable((page?.lines ?? []).map((l) => l.text).join(' '));
    const words = [...table.heads, ...table.rows].flat().flatMap((c) => c.text.split(/\s+/)).filter((w) => w !== '' && !text.includes(comparable(w)));
    if (words.length > 0) unseen.push({ page: table.page, words: [...new Set(words)].join(' ') });
  }
  return { document: labels.document, tables, unseen };
}

/** A PDF's tables scored on its labels. */
export async function scorePdf(bytes: Uint8Array, labels: LabelFile): Promise<DocumentScore> {
  const { pages } = await pdfPages(bytes);
  return scorePages(pages, labels);
}
