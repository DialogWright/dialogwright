import { alignmentTables } from './tables/alignment';
import { rowsOfTable } from './tables/assemble';
import { checkTable, type TableCheck } from './tables/check';
import { fillGrid, type FilledTable, type PlacedLine, type RowLine } from './tables/grid';

export { columnsOf } from './tables/alignment';
export type { PlacedLine, PlacedRun, RowLine } from './tables/grid';

/**
 * A PDF page's tables, each read as its rows (./tables/):
 *
 * 1. A reader proposes each table's grid: its columns, its rows, its heading rows and its cells over
 *    several of either. Today's reader finds them by where their text is (./tables/alignment.ts).
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

/** A page's lines with each table's lines read as its rows (see the file's comment), in the page's order, and the tables read. */
export function readTables<L extends PlacedLine>(lines: readonly L[]): { lines: (L | RowLine)[]; tables: TableRead[] } {
  const found = alignmentTables(lines);
  if (found.length === 0) return { lines: [...lines], tables: [] };
  const taken = new Set<number>();
  const tables: TableRead[] = [];
  const read: { at: number; rows: RowLine[] }[] = [];
  for (const { members, proposals } of found) {
    const rows: RowLine[] = [];
    for (const p of proposals) {
      const table = fillGrid(p.grid, p.lines);
      const said = rowsOfTable(table);
      tables.push({ table, check: checkTable(table, lines), rows: said });
      rows.push(...said);
    }
    for (const m of members) taken.add(m);
    read.push({ at: Math.min(...members), rows });
  }
  const out: (L | RowLine)[] = [];
  lines.forEach((l, i) => {
    const table = read.find((r) => r.at === i);
    if (table) out.push(...table.rows);
    if (!taken.has(i)) out.push(l);
  });
  return { lines: out, tables };
}

/** A page's lines with each table's lines read as its rows, in the page's order. */
export function withTables<L extends PlacedLine>(lines: readonly L[]): (L | RowLine)[] {
  return readTables(lines).lines;
}

/** A line that is a table's row, read apart from the lines its page sets as prose. */
export const isRowLine = (l: PlacedLine): l is RowLine => 'kind' in l && ((l as RowLine).kind === 'row' || (l as RowLine).kind === 'group');
