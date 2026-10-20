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
 *    (./tables/borders.ts), one by where their text is (./tables/alignment.ts). Where two proposals
 *    hold the same lines, the one the checker scores higher is read (the borders' on a tie: drawn lines
 *    say where a cell is), and the other is not.
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
export function readTables<L extends PlacedLine>(lines: readonly L[], rules: readonly Rule[] = [], proposed: readonly TableGrid[] = []): { lines: (L | RowLine)[]; tables: TableRead[]; proposed: TableRead[] } {
  // Ties go to drawn lines, then a model's grid, then where the text is.
  const found: { members: number[]; proposals: readonly Proposal[]; rank: number }[] = [
    ...borderTables(lines, rules).map(({ members, grid }) => ({ members, proposals: [{ grid, lines: members.map((i) => lines[i]!) }], rank: 2 })),
    ...proposed.map((grid) => ({ grid, members: linesIn(grid, lines) })).filter((p) => p.members.length > 0).map(({ grid, members }) => ({ members, proposals: [{ grid, lines: members.map((i) => lines[i]!) }], rank: 1 })),
    ...alignmentTables(lines).map((f) => ({ ...f, rank: 0 })),
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
