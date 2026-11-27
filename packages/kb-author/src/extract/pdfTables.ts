import { alignmentTables, type Proposal } from './tables/alignment';
import { rowsOfTable } from './tables/assemble';
import { borderTables } from './tables/borders';
import { checkTable, type TableCheck } from './tables/check';
import { fillGrid, linesIn, type FilledTable, type PlacedLine, type RowLine, type TableGrid } from './tables/grid';
import type { Rule } from './tables/rules';

export { columnsOf } from './tables/alignment';
export type { PlacedLine, PlacedRun, RowLine } from './tables/grid';
export type { Rule } from './tables/rules';

/**
 * A PDF page's tables, each read as its rows (./tables/):
 *
 * 1. Readers propose each table's grid: its columns, its rows, its heading rows and its cells over
 *    several of either. One finds tables by the lines the page draws around their cells
 *    (./tables/borders.ts), one by where their text is (./tables/alignment.ts), and a model's grids may be
 *    given beside them (./tables/model.ts). Where two proposals hold the same lines, the one the checker
 *    scores higher is read (on a tie the borders', then the alignment's, then the model's: drawn lines say
 *    where a cell is, and a model's is read only where it does better), and the other is not.
 * 2. The grid's cells are filled with the page's own runs, each in the cell its anchor is in
 *    (./tables/grid.ts): the words are the page's, whoever found the table.
 * 3. The table is checked against its page (./tables/check.ts): text left out, text across a column's
 *    edge, rows run together, rows with no label. A weak table is said so to the author.
 * 4. Its rows become lines of their own (./tables/assemble.ts), each saying its cells with the column's
 *    heading, so a row reads as a sentence would, where the page as read would run its cells together.
 */

/** A table read on a page: its grid filled, its check, and its rows as lines. */
export interface TableRead {
  readonly table: FilledTable;
  readonly check: TableCheck;
  readonly rows: readonly RowLine[];
}

/**
 * A page's lines with each table's lines read as its rows (see the file's comment), in the page's order,
 * and the tables read; `rules` are the lines the page draws (./tables/rules.ts), and `proposed` grids a
 * reader of its own gives (a model's, ./tables/model.ts), each holding the lines inside it. `proposed` in
 * the result is every reader's reading, read or not (kb:tables scores each).
 */
export function readTables<L extends PlacedLine>(
  lines: readonly L[],
  rules: readonly Rule[] = [],
  proposed: readonly TableGrid[] = [],
  options: { own?: boolean } = {},
): { lines: (L | RowLine)[]; tables: TableRead[]; proposed: TableRead[] } {
  // Ties go to drawn lines, then where the text is, then a model's grid: a model's is read only where it
  // checks strictly better (the checker cannot see a heading put over the wrong columns, which a model's
  // grid can do where the alignment's reads the same). With `own: false`, only the grids proposed are read
  // (another reader's tables, ./liteparse.ts: ours are then its second opinion, `differences`).
  const own = options.own ?? true;
  const found: { members: number[]; proposals: readonly Proposal[]; rank: number }[] = [
    ...(own ? borderTables(lines, rules).map(({ members, grid }) => ({ members, proposals: [{ grid, lines: members.map((i) => lines[i]!) }], rank: 2 })) : []),
    ...proposed.map((grid) => ({ grid, members: linesIn(grid, lines) })).filter((p) => p.members.length > 0).map(({ grid, members }) => ({ members, proposals: [{ grid, lines: members.map((i) => lines[i]!) }], rank: 0 })),
    ...(own ? alignmentTables(lines).map((f) => ({ ...f, rank: 1 })) : []),
  ];
  if (found.length === 0) return { lines: [...lines], tables: [], proposed: [] };
  // Each proposal filled, checked and said; a region's score is its tables' least.
  const regions = found.map((f) => {
    const reads = f.proposals.map((p): TableRead => {
      const table = fillGrid(p.grid, p.lines);
      return { table, check: checkTable(table, lines), rows: rowsOfTable(table) };
    });
    return { ...f, reads, score: Math.min(...reads.map((r) => r.check.score)) };
  });
  // The best first; one holding a line a better one holds is not read.
  regions.sort((a, b) => b.score - a.score || b.rank - a.rank);
  const taken = new Set<number>();
  const tables: TableRead[] = [];
  const read: { at: number; rows: RowLine[] }[] = [];
  for (const region of regions) {
    if (region.members.some((m) => taken.has(m))) continue;
    for (const m of region.members) taken.add(m);
    tables.push(...region.reads);
    read.push({ at: Math.min(...region.members), rows: region.reads.flatMap((r) => r.rows) });
  }
  const out: (L | RowLine)[] = [];
  lines.forEach((l, i) => {
    const table = read.find((r) => r.at === i);
    if (table) out.push(...table.rows);
    if (!taken.has(i)) out.push(l);
  });
  return { lines: out, tables, proposed: regions.flatMap((r) => r.reads) };
}

/** A page's lines with each table's lines read as its rows, in the page's order. */
export function withTables<L extends PlacedLine>(lines: readonly L[]): (L | RowLine)[] {
  return readTables(lines).lines;
}

/** A line that is a table's row, read apart from the lines its page sets as prose. */
export const isRowLine = (l: PlacedLine): l is RowLine => 'kind' in l && ((l as RowLine).kind === 'row' || (l as RowLine).kind === 'group');

/** A figure as two readings are compared: a number, with its sign, currency and percent. */
const FIGURE = /[-\u2212\u2013+\u00b1]?\$?\d+(?:[.,]\d+)*%?/gu;

/**
 * What a table reads as its figures: each figure in a body row's cell with the row's label (its first
 * cell, or the cell over several rows that covers it), "label\u0000figure", as many times as it is read.
 */
export function figuresOf(read: TableRead): string[] {
  const { grid, cells } = read.table;
  const out: string[] = [];
  for (let r = grid.headRows; r < cells.length; r += 1) {
    const row = cells[r]!;
    const first = row[0]!;
    const label = first.covered === true && first.span !== undefined ? cells[first.span.row]![first.span.col]!.text : first.text;
    row.forEach((c, k) => {
      if (k === 0 || c.covered === true) return;
      for (const m of c.text.match(FIGURE) ?? []) out.push(`${label}\u0000${m.replace(/\u2212|\u2013/gu, '-')}`);
    });
  }
  return out;
}

/** The figures one reading has that another does not (each as often as it has more of it), in its order. */
export function figuresNotIn(mine: readonly string[], theirs: readonly string[]): string[] {
  const left = new Map<string, number>();
  for (const f of theirs) left.set(f, (left.get(f) ?? 0) + 1);
  const out: string[] = [];
  for (const f of mine) {
    const n = left.get(f) ?? 0;
    if (n > 0) left.set(f, n - 1);
    else out.push(f);
  }
  return out;
}
