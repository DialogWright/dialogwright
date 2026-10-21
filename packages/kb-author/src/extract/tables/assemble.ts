import { joinCell, type FilledCell, type FilledTable, type RowLine } from './grid';

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
 * - A table whose body cells are all list items (each starts with a bullet, or is a bullet alone) is a list
 *   set in columns, not a table: a summary of benefits' "Services Your Plan Generally Does NOT Cover" over
 *   three columns of bullets. It is said as one line, its heading rows' words (its caption) then its items
 *   down each column in turn ("Services ... NOT Cover: Acupuncture; Bariatric surgery; ..."), so no item is
 *   read as another's label and what the list is stays with every item of it. Rows at its end with no list
 *   item in them are its notes (a footnote under the list), each said as a line after it.
 * - A table whose first column holds labels over several rows (a summary of benefits' "If you visit a
 *   health care provider's office or clinic" beside its services) groups its rows: each label is a heading
 *   of its own (level 3) over the rows beside it, and each row is said by its second cell ("Specialist
 *   visit: In-Network: $50 copayment; ..."), so the label is said once and a document's sections are cut at it.
 */

/** A term of a list of terms is this many words at most, and this share of a table's rows are terms for it to be a list. */
const MAX_TERM_WORDS = 12;
const TERM_SHARE = 0.8;

const CHECK = /^[\u{E000}-\u{F8FF}✓✔☑]+$/u;

/** A bullet that starts a list item. */
const BULLET = /^[•●▪◦·]/u;
const BULLETS = /\s*[•●▪◦·]\s*/u;

/** A list set in columns said as one line, then its notes (see the file's comment), or null where the table is not one. */
function listOfTable(table: FilledTable): RowLine[] | null {
  const { grid, cells } = table;
  const shown = (row: readonly FilledCell[]) => row.filter((c) => c.covered !== true && c.text !== '');
  const rows = cells.slice(grid.headRows);
  // Its notes: the rows at its end with no list item in them.
  let end = rows.length;
  while (end > 0 && !shown(rows[end - 1]!).some((c) => BULLET.test(c.text))) end -= 1;
  const body = rows.slice(0, end);
  const filled = body.flatMap(shown);
  if (filled.length < 2 || !filled.every((c) => BULLET.test(c.text))) return null;
  const items: string[] = [];
  for (let k = 0; k < grid.columns.length; k += 1) {
    for (const row of body) {
      const cell = row[k];
      if (cell === undefined || cell.covered === true) continue;
      items.push(...cell.text.split(BULLETS).filter((t) => t !== ''));
    }
  }
  if (items.length === 0) return null;
  const caption = cells
    .slice(0, grid.headRows)
    .flatMap((row) => row.filter((c) => c.covered !== true && c.text !== '').map((c) => c.text))
    .join(' ');
  const top = table.tops.find((t) => t !== null);
  if (top === undefined || top === null) return null;
  const said = items.join('; ');
  const at = { page: top.page, size: table.size };
  const notes = rows.slice(end).flatMap((row, i) => {
    const text = shown(row).map((c) => c.text).join(' ');
    const noteTop = table.tops[grid.headRows + end + i];
    return text === '' ? [] : [{ ...at, y: noteTop?.y ?? top.y, text, kind: 'row' as const }];
  });
  return [{ ...at, y: top.y, text: caption === '' ? said : `${caption.replace(/:$/, '')}: ${said}`, kind: 'row' }, ...notes];
}

/** A filled table's rows as lines (see the file's comment). */
export function rowsOfTable(table: FilledTable): RowLine[] {
  const list = listOfTable(table);
  if (list !== null) return list;
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
  // A row's cells from column `from` on, each with its column's heading, those under a heading over several
  // columns said within it ("What You Will Pay (In-Network: $50; Out-of-Network: 40%)").
  const sayFrom = (row: readonly string[], from: number): string[] => {
    const cell = (k: number): string => (row[k] === '' ? '' : heads[k] !== '' ? `${heads[k]}: ${row[k]}` : row[k]!);
    const said: string[] = [];
    for (let k = from; k < row.length; k += 1) {
      const group = groups.find((g) => g.from === k);
      if (group === undefined) {
        if (cell(k) !== '') said.push(cell(k));
        continue;
      }
      const within = Array.from({ length: group.to - group.from + 1 }, (_, j) => cell(group.from + j)).filter((c) => c !== '');
      if (within.length > 0) said.push(`${group.text} (${within.join('; ')})`);
      k = group.to;
    }
    return said;
  };
  // A first column of labels over several rows: each label a heading over its rows, each row said by its second cell.
  const grouped = width > 2 && body.some(({ row }) => row[0]!.span !== undefined && row[0]!.span.rows > 1 && !row[0]!.covered);
  const rows: RowLine[] = [];
  for (const { row: cellsOfRow, top } of body) {
    const row = cellsOfRow.map((c) => (CHECK.test(c.text) ? 'yes' : c.text.replace(/^[•▪◦·]\s*/u, '')));
    if (grouped) {
      if (top === null || row.every((c) => c === '')) continue;
      const at = { page: top.page, size: table.size, y: top.y };
      if (row[0] !== '' && cellsOfRow[0]!.covered !== true) rows.push({ ...at, text: row[0]!, kind: 'group' });
      const rest = row.slice(1);
      if (rest.every((c) => c === '')) continue;
      const said = sayFrom(row, 2);
      rows.push({ ...at, text: rest[0] !== '' ? `${rest[0]}: ${said.join('; ')}` : said.join('; '), kind: 'row' });
      continue;
    }
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
    const said = sayFrom(row, 1);
    rows.push({ ...at, text: row[0] !== '' ? `${row[0]}: ${said.join('; ')}` : said.join('; '), kind: 'row' });
  }
  return rows;
}
