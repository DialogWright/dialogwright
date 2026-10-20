import { joinCell, type FilledTable, type RowLine } from './grid';

/**
 * A filled table's rows as lines (./grid.ts), whichever reader found it: each row says its cells with
 * their column's heading, so a row reads as a sentence would ("Emergency room: In network: $100 a visit
 * plus 20%; Out of network: ..."), where the page as read would run its cells together.
 *
 * - A column's heading is the words of its own cells in the heading rows, top to bottom.
 * - A heading cell over several columns, not the first, is over the columns under it whose own headings
 *   are in the heading rows below it; a row says their cells within it ("Your cost (In network: $20; Out
 *   of network: $60)"), so what its figures are is kept. One over no such columns is not said.
 * - A table of two columns whose first is short terms in bold (twelve words at most, four rows in five
 *   at least) and whose second is long (twelve words a row or more, by the median) is a list of terms:
 *   each term a heading over its text.
 * - A row whose only cell is its first, set in bold, names the rows under it: it is a heading of its
 *   own (level 3). Any other row with one cell is said as it is (a note under a row).
 * - A cell that is only a check mark (a symbol font's private-use character, or ✓) says "yes".
 */

/** A term of a list of terms is this many words at most, and this share of a table's rows are terms for it to be a list. */
const MAX_TERM_WORDS = 12;
const TERM_SHARE = 0.8;

const CHECK = /^[\u{E000}-\u{F8FF}✓✔☑]+$/u;

/** A filled table's rows as lines (see the file's comment). */
export function rowsOfTable(table: FilledTable): RowLine[] {
  const { grid, cells } = table;
  const width = grid.columns.length;
  // Each column's heading, and the heading row its own words are first in.
  const heads = Array.from({ length: width }, () => '');
  const headRow = Array.from({ length: width }, () => -1);
  const over: { row: number; col: number; cols: number; text: string }[] = [];
  for (let r = 0; r < grid.headRows; r += 1) {
    cells[r]!.forEach((cell, k) => {
      if (cell.covered === true || cell.text === '') return;
      if (cell.span !== undefined && cell.span.cols > 1) {
        over.push({ row: r, col: k, cols: cell.span.cols, text: cell.text });
        return;
      }
      heads[k] = joinCell(heads[k]!, cell.text);
      if (headRow[k] === -1) headRow[k] = r;
    });
  }
  // Each heading cell over several columns, and the columns under it headed in a row below its own.
  const groups: { text: string; from: number; to: number }[] = [];
  for (const o of over) {
    const under = Array.from({ length: o.cols }, (_, j) => o.col + j).filter((k) => k > 0 && headRow[k]! > o.row);
    if (under.length === 0) continue;
    const from = Math.min(...under);
    const to = Math.max(...under);
    if (to > from && !groups.some((g) => g.from <= to && from <= g.to)) groups.push({ text: o.text, from, to });
  }
  // A list of terms: two columns, each term in bold and short, its text long.
  const body = cells.slice(grid.headRows).map((row, i) => ({ row, top: table.tops[grid.headRows + i] ?? null }));
  const words = (s: string) => (s === '' ? 0 : s.split(/\s+/).length);
  const labels = body.filter(({ row }) => row[0]!.text !== '');
  const long = labels.map(({ row }) => words(row[1]?.text ?? '')).sort((x, y) => x - y);
  const termLike = labels.filter(({ row }) => row[0]!.bold && words(row[0]!.text) <= MAX_TERM_WORDS).length;
  const terms = width === 2 && long.length >= 1 && (long[long.length >> 1] ?? 0) >= 12 && termLike >= labels.length * TERM_SHARE;
  const rows: RowLine[] = [];
  for (const { row: cellsOfRow, top } of body) {
    const row = cellsOfRow.map((c) => (CHECK.test(c.text) ? 'yes' : c.text.replace(/^[•▪◦·]\s*/u, '')));
    const filled = row.filter((c) => c !== '');
    if (filled.length === 0 || top === null) continue;
    const at = { page: top.page, size: table.size, y: top.y };
    if (terms) {
      if (row[0] !== '') rows.push({ ...at, text: row[0]!, kind: 'group' });
      if (row[1] !== '') rows.push({ ...at, text: row[1]!, kind: 'row' });
      continue;
    }
    if (filled.length === 1 && row[0] !== '') {
      rows.push({ ...at, text: row[0]!, kind: cellsOfRow.every((c) => c.bold) ? 'group' : 'row' });
      continue;
    }
    const cell = (k: number): string => (row[k] === '' ? '' : heads[k] !== '' ? `${heads[k]}: ${row[k]}` : row[k]!);
    const said: string[] = [];
    for (let k = 1; k < row.length; k += 1) {
      const group = groups.find((g) => g.from === k);
      if (group === undefined) {
        if (cell(k) !== '') said.push(cell(k));
        continue;
      }
      const within = Array.from({ length: group.to - group.from + 1 }, (_, j) => cell(group.from + j)).filter((c) => c !== '');
      if (within.length > 0) said.push(`${group.text} (${within.join('; ')})`);
      k = group.to;
    }
    rows.push({ ...at, text: row[0] !== '' ? `${row[0]}: ${said.join('; ')}` : said.join('; '), kind: 'row' });
  }
  return rows;
}
