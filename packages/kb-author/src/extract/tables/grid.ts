import { cleanText } from '../../sections';

/**
 * A table as every reader proposes it, and its cells filled from the page's own text.
 *
 * A reader (where the text is: ./alignment.ts; later where its borders are, or a model reading the page)
 * proposes a grid: its columns' edges left to right, its rows' edges top to bottom, how many of its first
 * rows are its heading, and the cells over several columns or rows. Every other place (row, column) is a
 * cell of its own. A reader never says what a cell holds: `fillGrid` places each run of the page's text
 * in the cell its anchor (the middle of the run, a third of its size above its baseline) is in, so the
 * words are the page's own, whichever reader found the table. What happens to a table after that
 * (./assemble.ts: its rows as lines; ./check.ts: how well it was read) is the same for every reader.
 */

/** A run of text where it is on its page. */
export interface PlacedRun {
  readonly x: number;
  readonly end: number;
  readonly text: string;
  readonly bold: boolean;
}

/** A line of a page with its runs where they are. */
export interface PlacedLine {
  readonly page: number;
  readonly text: string;
  readonly size: number;
  readonly y: number;
  readonly bold?: boolean;
  readonly runs?: readonly PlacedRun[];
}

/** A table's row as a line: said as a paragraph of its own (`row`), or a heading over the rows under it (`group`). */
export interface RowLine extends PlacedLine {
  readonly kind: 'row' | 'group';
}

/** A cell over several rows or columns: its first row and column, and how many of each it covers. */
export interface Span {
  readonly row: number;
  readonly col: number;
  readonly rows: number;
  readonly cols: number;
}

/** A table as a reader proposes it: on a page, x from the left, y from the page's bottom (as pdf.js places a run). */
export interface TableGrid {
  readonly page: number;
  /** Who proposed it: `alignment` (where the text is). */
  readonly reader: string;
  /** Each column's left and right edge, left to right, each starting where the one before ends. */
  readonly columns: readonly (readonly [number, number])[];
  /** Each row's top and bottom (top above bottom), top to bottom, each starting where the one above ends. */
  readonly rows: readonly (readonly [number, number])[];
  /** How many of its first rows are its heading. */
  readonly headRows: number;
  /** Its cells over several rows or columns; they never overlap. */
  readonly spans: readonly Span[];
}

/** A cell with the page's text in it: `text` empty where nothing is, and on the places a span covers but its first. */
export interface FilledCell {
  readonly text: string;
  /** Every run in it is set in bold (so is an empty cell). */
  readonly bold: boolean;
  /** The cell over several rows or columns it is the first place of, or that covers it. */
  readonly span?: Span;
  /** A place a span covers, other than its first. */
  readonly covered?: boolean;
  /** How many gaps between its lines are wider than a blank line (BREAK times their size): separate texts run together. */
  readonly breaks: number;
  /** Whether a line of it has two of its runs a gutter apart (SIDE times their size): two columns' text in one cell. */
  readonly sideBySide: boolean;
  /** Its lines, top to bottom: each one's baseline and how many words it has in the cell. */
  readonly lines: readonly { readonly y: number; readonly words: number }[];
}

/** A grid with its cells filled. */
export interface FilledTable {
  readonly grid: TableGrid;
  /** By row, then by column. */
  readonly cells: readonly (readonly FilledCell[])[];
  /** Each row's top line (where its line is said in the page's order); null for a row nothing is in. */
  readonly tops: readonly (PlacedLine | null)[];
  /** The size of the table's top line (its rows are said at that size). */
  readonly size: number;
  /** How many characters of the runs given were placed in a cell, and how many were outside the grid. */
  readonly placed: number;
  readonly outside: number;
  /** How many characters placed in a body row's cell of one column ran past its edges (more than half their size). */
  readonly straddling: number;
}

/** A gap between a cell's lines over this many times their size is a break: a blank line's worth or more. */
const BREAK = 1.8;
/** Two runs of one line in one cell this many times their size apart are side by side (as a line's cells are split: ../pdf.ts). */
const SIDE = 1.5;

/** Where a run is taken to be: the middle of its width, a third of its size above its baseline. */
export const anchorOf = (line: PlacedLine, run: PlacedRun): { x: number; y: number } => ({ x: (run.x + run.end) / 2, y: line.y + line.size * 0.3 });

/** A grid's box: its left, right, top and bottom. */
export const boxOf = (grid: TableGrid): { x0: number; x1: number; top: number; bottom: number } => ({
  x0: grid.columns[0]![0],
  x1: grid.columns[grid.columns.length - 1]![1],
  top: grid.rows[0]![0],
  bottom: grid.rows[grid.rows.length - 1]![1],
});

/** The indexes of `lines` with text whose anchor is inside a grid's box: the lines a grid proposed by its edges alone holds. */
export function linesIn(grid: TableGrid, lines: readonly PlacedLine[]): number[] {
  const box = boxOf(grid);
  return lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => (l.runs ?? []).some((r) => {
      if (r.text.trim() === '') return false;
      const at = anchorOf(l, r);
      return at.x >= box.x0 && at.x <= box.x1 && at.y <= box.top && at.y >= box.bottom;
    }))
    .map(({ i }) => i);
}

/** The first of `ranges` whose edges hold `v` (low to high, or high to low), or -1. */
const indexIn = (ranges: readonly (readonly [number, number])[], v: number): number =>
  ranges.findIndex(([a, b]) => v >= Math.min(a, b) && v <= Math.max(a, b));

/** Two cells' words as one: a word broken at a hyphen joined again ("out-of-" and "network"). */
export function joinCell(text: string, next: string): string {
  if (text === '') return next;
  return /\p{L}-$/u.test(text) ? text + next : `${text} ${next}`;
}

/** The span covering a place, if any. */
const spanAt = (grid: TableGrid, row: number, col: number): Span | undefined =>
  grid.spans.find((s) => row >= s.row && row < s.row + s.rows && col >= s.col && col < s.col + s.cols);

/**
 * A grid's cells filled with the runs of `lines` whose anchor is within it: each in the cell its anchor
 * is in, a cell's runs said top to bottom and left to right on each line, joined as one text.
 */
export function fillGrid(grid: TableGrid, lines: readonly PlacedLine[]): FilledTable {
  const runs: { row: number; col: number; line: PlacedLine; run: PlacedRun }[][][] = grid.rows.map(() => grid.columns.map(() => []));
  const tops: (PlacedLine | null)[] = grid.rows.map(() => null);
  let placed = 0;
  let outside = 0;
  let straddling = 0;
  for (const line of lines) {
    for (const run of line.runs ?? []) {
      if (run.text.trim() === '') continue;
      const at = anchorOf(line, run);
      const row = indexIn(grid.rows, at.y);
      const col = indexIn(grid.columns, at.x);
      if (row < 0 || col < 0) {
        outside += run.text.trim().length;
        continue;
      }
      const span = spanAt(grid, row, col);
      const r = span?.row ?? row;
      const c = span?.col ?? col;
      runs[r]![c]!.push({ row, col, line, run });
      placed += run.text.trim().length;
      const [left, right] = grid.columns[col]!;
      const loose = line.size * 0.5;
      if (row >= grid.headRows && (span === undefined || span.cols === 1) && (run.x < left - loose || run.end > right + loose)) straddling += run.text.trim().length;
      if (tops[row] === null || line.y > tops[row]!.y) tops[row] = line;
    }
  }
  const cells = grid.rows.map((_, r) =>
    grid.columns.map((_, c): FilledCell => {
      const span = spanAt(grid, r, c);
      if (span !== undefined && (span.row !== r || span.col !== c)) return { text: '', bold: true, span, covered: true, breaks: 0, sideBySide: false, lines: [] };
      const here = [...runs[r]![c]!].sort((a, b) => b.line.y - a.line.y || a.run.x - b.run.x);
      const lines = [...new Set(here.map((h) => h.line))];
      const breaks = lines.slice(1).filter((l, i) => lines[i]!.y - l.y > Math.min(l.size, lines[i]!.size) * BREAK).length;
      // Its runs on one baseline (a line split at a gutter is several lines on it), left to right.
      const sideBySide = lines.some((l) => {
        const level = here.filter((h) => Math.abs(h.line.y - l.y) <= l.size * 0.5).map((h) => h.run).sort((x, y) => x.x - y.x);
        return level.slice(1).some((run, i) => run.x - level[i]!.end > l.size * SIDE);
      });
      return {
        text: cleanText(here.reduce((text, h) => joinCell(text, h.run.text.trim()), '')),
        bold: here.every((h) => h.run.bold),
        ...(span === undefined ? {} : { span }),
        breaks,
        sideBySide,
        lines: lines.map((l) => ({ y: l.y, words: here.filter((h) => h.line === l).reduce((n, h) => n + h.run.text.trim().split(/\s+/).length, 0) })),
      };
    }),
  );
  const top = lines.reduce<PlacedLine | null>((best, l) => (best === null || l.y > best.y ? l : best), null);
  return { grid, cells, tops, size: top?.size ?? 0, placed, outside, straddling };
}
