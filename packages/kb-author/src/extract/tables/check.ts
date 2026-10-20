import { anchorOf, boxOf, type FilledTable, type PlacedLine } from './grid';

/**
 * How well a table was read, from the page alone (no labels): a score from 0 to 1 and the problems
 * behind it, the same for every reader, so one reader's grid can be weighed against another's and a
 * weak one shown to the author.
 *
 * - Text inside the table's box that is in none of its cells (a reader that left lines out).
 * - Text in a body row's cell of one column that runs past the column's edges (a gutter that is not one:
 *   two columns of prose read as a table, or a column split through its words).
 * - Rows whose first cell has a break in it, a blank line's worth between two of its lines (several
 *   rows run together into one: a whole column read as one cell).
 * - Cells holding text side by side on a line, a gutter apart (two columns read as one, their lines
 *   interleaved).
 * - Body rows with text but nothing in their first cell (rows split where the label is not).
 *
 * The score multiplies what is left of each: a table with none of these scores 1. Under WEAK it is
 * weak, and said so.
 */

/** A table scoring under this is weak. */
export const WEAK = 0.8;

export interface TableCheck {
  readonly score: number;
  readonly problems: readonly string[];
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** A filled table checked against its page's lines (see the file's comment). */
export function checkTable(table: FilledTable, pageLines: readonly PlacedLine[]): TableCheck {
  const { grid, cells } = table;
  const box = boxOf(grid);
  // The page's text inside the box, all of it.
  let inBox = 0;
  for (const line of pageLines) {
    for (const run of line.runs ?? []) {
      if (run.text.trim() === '') continue;
      const at = anchorOf(line, run);
      if (at.x >= box.x0 && at.x <= box.x1 && at.y <= box.top && at.y >= box.bottom) inBox += run.text.trim().length;
    }
  }
  const problems: string[] = [];
  const missed = Math.max(0, inBox - table.placed);
  const left = inBox === 0 ? 0 : missed / inBox;
  if (left > 0) problems.push(`${pct(left)} of the text inside the table is in none of its cells`);
  const straddle = table.placed === 0 ? 0 : table.straddling / table.placed;
  if (straddle > 0) problems.push(`${pct(straddle)} of its text runs across a column's edge`);
  const body = cells.slice(grid.headRows).filter((row) => row.some((c) => c.text !== ''));
  const runTogether = body.length === 0 ? 0 : body.filter((row) => row[0]!.breaks > 0).length / body.length;
  if (runTogether > 0) problems.push(`${pct(runTogether)} of its rows have several texts in their first cell (rows run together)`);
  const cellsOfBody = body.flat().filter((c) => c.text !== '');
  const sideBySide = cellsOfBody.length === 0 ? 0 : cellsOfBody.filter((c) => c.sideBySide).length / cellsOfBody.length;
  if (sideBySide > 0) problems.push(`${pct(sideBySide)} of its cells hold text side by side on a line (two columns read as one)`);
  const unlabelled = body.length === 0 ? 0 : body.filter((row) => row[0]!.text === '' && row[0]!.covered !== true).length / body.length;
  if (unlabelled > 0) problems.push(`${pct(unlabelled)} of its rows have nothing in their first cell`);
  const score = (1 - left) * (1 - straddle) * (1 - runTogether) * (1 - sideBySide) * (1 - unlabelled / 2);
  return { score, problems };
}
