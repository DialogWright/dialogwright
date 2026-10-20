import { cleanText } from '../sections';

/**
 * A PDF page's tables, read by where their text is (pdf.js gives a table's cells in any order: row by
 * row, or column by column). A table's rows become lines of their own, each saying its cells with the
 * column's heading, so a row reads as a sentence would ("Emergency room: In network: $100 a visit plus
 * 20%; Out of network: ..."), where the page as read would run its cells together.
 *
 * - A line with another beside it (on its baseline, give or take, past a gap of TABLE_GAP times its
 *   size) sits in a table. A table is the run of such lines, in the page's order from the top, with
 *   the lines between them and the lines just above the first and below the last that reach into one
 *   of its columns at most (a cell's first and last lines); a line as wide as most of the page with
 *   nothing beside it ends it (the prose after it).
 * - Its rows are anchored on its first column: a band of lines (split where a gap is over ROW_GAP times
 *   the line's size) with words in the first column is a row, and the bands without go to the row
 *   above or below them, split at the largest gap (a label set level with the middle of its text).
 * - A table of two columns whose first is short terms in bold (twelve words at most, four rows in five
 *   at least) and whose second is long (twelve words a row or more, by the median) is a list of terms:
 *   each term a heading over its text.
 * - Its columns are found from its gutters: the places across the table no line's text covers but a
 *   one in twenty, one at least and two at most, in a table of eight lines or more (a heading over
 *   several columns, as "Your cost" is over "In network" and "Out of network"). A table has two columns at least.
 * - Its first rows set wholly in bold, each with words in more than one column, are its heading: each
 *   column's words are that column's heading. A heading over several columns ("Your cost" over "In
 *   network" and "Out of network") is over the columns whose own headings are in the rows under it, each
 *   such column under the nearest of the row's headings over several columns; a row says their cells
 *   within it ("Your cost (In network: $20; Out of network: $60)"), so what its figures are is kept.
 * - A band set in bold under its rows that says again words of its heading's (but its first column's: a
 *   second table's own heading, "Your cost" over its columns again) starts a table of its own, read apart
 *   with its own columns: read as a row of the first, it ran its heading into the rows above it.
 * - A row whose only cell is its first, set in bold, names the rows under it: it is a heading of its
 *   own (level 3). Any other row with one cell is said as it is (a note under a row).
 * - A cell that is only a check mark (a symbol font's private-use character, or ✓) says "yes".
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

/** A gap beside a line over this many times its size makes the line one cell of a table's row. */
const TABLE_GAP = 1.5;
/** Two lines this many times their size apart or more vertically are in two rows. */
const ROW_GAP = 1.35;
/** Two lines beside each other are on one row when their baselines are within this many times their size. */
const ROW_MATE = 0.8;
/** A line wider than this share of the page's text, with nothing beside it, is prose: a table ends at it. */
const WIDE = 0.6;
/** The share of a table's lines that may cross a gutter (a heading over several columns), and how many at most. */
const SPANNING = 0.05;
const MAX_SPANNING = 2;
/** A table of fewer lines than this has no line over several columns. */
const MIN_SPANNED = 8;
/** The narrowest gutter, as many times the table's text size (wider than the gap after a bullet). */
const MIN_GUTTER = 1.2;

/** A term of a list of terms is this many words at most, and this share of a table's rows are terms for it to be a list. */
const MAX_TERM_WORDS = 12;
const TERM_SHARE = 0.8;

const CHECK = /^[\u{E000}-\u{F8FF}✓✔☑]+$/u;

interface Box {
  readonly at: number;
  readonly line: PlacedLine;
  readonly x0: number;
  readonly x1: number;
}

const boxOf = (line: PlacedLine, at: number): Box | null => {
  const runs = (line.runs ?? []).filter((r) => r.text.trim() !== '');
  if (runs.length === 0) return null;
  return { at, line, x0: Math.min(...runs.map((r) => r.x)), x1: Math.max(...runs.map((r) => r.end)) };
};

/** Two cells' words as one: a word broken at a hyphen joined again ("out-of-" and "network"). */
function joinCell(text: string, next: string): string {
  if (text === '') return next;
  return /\p{L}-$/u.test(text) ? text + next : `${text} ${next}`;
}

/** The x-ranges between gutters that hold text, left to right. */
export function columnsOf(boxes: readonly Box[]): [number, number][] {
  const x0 = Math.floor(Math.min(...boxes.map((b) => b.x0)));
  const x1 = Math.ceil(Math.max(...boxes.map((b) => b.x1)));
  const width = x1 - x0;
  if (width <= 0 || width > 5000) return [];
  const cover = new Array<number>(width).fill(0);
  for (const b of boxes) {
    for (const r of (b.line.runs ?? []).filter((r) => r.text.trim() !== '')) {
      for (let x = Math.max(x0, Math.floor(r.x)); x < Math.min(x1, Math.ceil(r.end)); x += 1) cover[x - x0] = (cover[x - x0] ?? 0) + 1;
    }
  }
  const allowed = boxes.length < MIN_SPANNED ? 0 : Math.min(MAX_SPANNING, Math.max(1, Math.floor(boxes.length * SPANNING)));
  const sizes = boxes.map((b) => b.line.size).sort((a, b) => a - b);
  const gutter = (sizes[sizes.length >> 1] ?? 10) * MIN_GUTTER;
  // Text where more lines than a heading over several columns cover it; a gutter is a gap of MIN_GUTTER times the text's size or more.
  const columns: [number, number][] = [];
  let start = -1;
  let last = -1;
  for (let i = 0; i < width; i += 1) {
    if (cover[i]! <= allowed) continue;
    if (start >= 0 && i - last - 1 >= gutter) {
      columns.push([x0 + start, x0 + last + 1]);
      start = -1;
    }
    if (start < 0) start = i;
    last = i;
  }
  if (start >= 0) columns.push([x0 + start, x0 + last + 1]);
  return columns;
}

/** Which column a run's middle is in, or -1. */
const columnAt = (columns: readonly [number, number][], x: number): number => {
  let best = -1;
  let distance = Infinity;
  columns.forEach(([a, b], i) => {
    const d = x < a ? a - x : x > b ? x - b : 0;
    if (d < distance) {
      best = i;
      distance = d;
    }
  });
  return best;
};

/** Whether a run crosses a gutter: its text over more than one column. */
const spans = (columns: readonly [number, number][], r: PlacedRun): boolean => columns.filter(([a, b]) => r.x < b && r.end > a).length > 1;

/** A table's lines as its rows (see the file's comment), or null when they are not a table. */
function rowsOf(lines: readonly PlacedLine[]): RowLine[] | null {
  const boxes = lines.map(boxOf).filter((b): b is Box => b !== null);
  const columns = columnsOf(boxes);
  if (columns.length < 2) return null;
  // Bands, top to bottom: a gap over ROW_GAP starts one.
  const sorted = [...lines].sort((a, b) => b.y - a.y);
  const bands: PlacedLine[][] = [];
  let above = Infinity;
  for (const l of sorted) {
    if (bands.length === 0 || above - l.y > l.size * ROW_GAP) bands.push([]);
    bands[bands.length - 1]!.push(l);
    above = l.y;
  }
  const runsIn = (band: readonly PlacedLine[], column: number | null, skipSpanning: boolean): PlacedRun[] => {
    const out: PlacedRun[] = [];
    for (const l of [...band].sort((a, b) => b.y - a.y)) {
      for (const r of [...(l.runs ?? [])].sort((a, b) => a.x - b.x)) {
        if (r.text.trim() === '' || (skipSpanning && spans(columns, r))) continue;
        const c = columnAt(columns, (r.x + r.end) / 2);
        if (c >= 0 && (column === null || c === column)) out.push(r);
      }
    }
    return out;
  };
  const cellsOf = (band: readonly PlacedLine[], skipSpanning = false): string[] =>
    columns.map((_, i) => cleanText(runsIn(band, i, skipSpanning).reduce((text, r) => joinCell(text, r.text.trim()), '')));
  const allBold = (band: readonly PlacedLine[]): boolean => band.every((l) => (l.runs ?? []).every((r) => r.text.trim() === '' || r.bold));
  // The heading: the first bands set wholly in bold.
  let first = 0;
  const heads = columns.map(() => '');
  // The heading band each column's own words are first in, and the headings over several columns by band.
  const headBand = columns.map(() => -1);
  const over: { band: number; text: string; mid: number }[] = [];
  // A heading's band has words in more than one column, or over several (a group's bold row under it has not).
  const across = (band: readonly PlacedLine[]): boolean => {
    const runs = runsIn(band, null, false);
    return runs.some((r) => spans(columns, r)) || new Set(runs.map((r) => columnAt(columns, (r.x + r.end) / 2))).size > 1;
  };
  while (first < bands.length - 1 && allBold(bands[first]!) && across(bands[first]!)) {
    cellsOf(bands[first]!, true).forEach((c, i) => {
      if (c === '') return;
      heads[i] = joinCell(heads[i]!, c);
      if (headBand[i] === -1) headBand[i] = first;
    });
    for (const r of runsIn(bands[first]!, null, false).filter((r) => spans(columns, r))) over.push({ band: first, text: cleanText(r.text), mid: (r.x + r.end) / 2 });
    first += 1;
  }
  // Each heading over several columns, and the columns under it: those headed in a band below its own
  // (never the first, the rows' own labels), each under the nearest of its band's.
  const groups: { text: string; from: number; to: number }[] = [];
  for (const band of [...new Set(over.map((o) => o.band))]) {
    const inBand = over.filter((o) => o.band === band);
    const under = new Map<number, number[]>();
    columns.forEach(([a, b], k) => {
      if (k === 0 || headBand[k]! <= band) return;
      const mid = (a + b) / 2;
      const nearest = inBand.reduce((best, o, i) => (Math.abs(o.mid - mid) < Math.abs(inBand[best]!.mid - mid) ? i : best), 0);
      under.set(nearest, [...(under.get(nearest) ?? []), k]);
    });
    under.forEach((ks, i) => {
      const from = Math.min(...ks);
      const to = Math.max(...ks);
      if (to > from && !groups.some((g) => g.from <= to && from <= g.to)) groups.push({ text: inBand[i]!.text, from, to });
    });
  }
  // A second table under this one's rows: a bold band saying again words of the heading (but its first
  // column's) starts it, and each is read on its own (its own columns).
  if (first > 0) {
    const said = new Set(bands.slice(0, first).flatMap((b) => runsIn(b, null, false)).filter((r) => columnAt(columns, (r.x + r.end) / 2) > 0).map((r) => r.text.trim()).filter((t) => t !== ''));
    const again = bands.findIndex((b, j) => j > first && allBold(b) && runsIn(b, null, false).some((r) => said.has(r.text.trim())));
    if (again > 0) {
      const upper = bands.slice(0, again).flat();
      const lower = bands.slice(again).flat();
      return [...(rowsOf(upper) ?? []), ...(rowsOf(lower) ?? [])];
    }
  }
  // The rows: each band with words in the first column, and the bands without beside it, split between
  // the rows above and below them at the largest gap (a label set level with the middle of its text).
  const body = bands.slice(first);
  const labelled = body.map((b) => runsIn(b, 0, false).length > 0);
  const topOf = (b: readonly PlacedLine[]) => Math.max(...b.map((l) => l.y));
  const lowOf = (b: readonly PlacedLine[]) => Math.min(...b.map((l) => l.y));
  const gapAt = (i: number): number => (i <= 0 || i >= body.length ? -1 : lowOf(body[i - 1]!) - topOf(body[i]!));
  const owner = body.map((_, i) => (labelled[i] ? i : -1));
  for (let s = 0; s < body.length; s += 1) {
    if (labelled[s]) continue;
    let e = s;
    while (e + 1 < body.length && !labelled[e + 1]) e += 1;
    const a = s - 1;
    const b = e + 1 < body.length ? e + 1 : -1;
    if (b < 0) {
      for (let i = s; i <= e; i += 1) owner[i] = a;
    } else {
      // The largest gap between the row above (or the table's top) and the row below.
      let split = b;
      let widest = -1;
      for (let i = a < 0 ? s + 1 : s; i <= b; i += 1) {
        if (gapAt(i) > widest) {
          widest = gapAt(i);
          split = i;
        }
      }
      for (let i = s; i <= e; i += 1) owner[i] = i < split ? a : b;
    }
    s = e;
  }
  const rowBands: PlacedLine[][] = [];
  const keys: number[] = [];
  owner.forEach((o, i) => {
    if (!keys.includes(o)) {
      keys.push(o);
      rowBands.push([]);
    }
    rowBands[keys.indexOf(o)]!.push(...body[i]!);
  });
  // A list of terms: two columns, each term in bold and short, its text long.
  const cells = rowBands.map((b) => cellsOf(b));
  const termed = rowBands.map((b, i) => keys[i]! >= 0 && runsIn(b, 0, false).every((r) => r.bold));
  const words = (s: string) => (s === '' ? 0 : s.split(/\s+/).length);
  const long = cells.filter((c) => c[0] !== '').map((c) => words(c[1] ?? '')).sort((x, y) => x - y);
  const labels = cells.map((c, i) => ({ c, i })).filter(({ c }) => c[0] !== '');
  const termLike = labels.filter(({ c, i }) => termed[i] && words(c[0]!) <= MAX_TERM_WORDS).length;
  const terms = columns.length === 2 && long.length >= 1 && (long[long.length >> 1] ?? 0) >= 12 && termLike >= labels.length * TERM_SHARE;
  const size = sorted[0]!.size;
  const rows: RowLine[] = [];
  rowBands.forEach((band, i) => {
    const row = cells[i]!.map((c) => (CHECK.test(c) ? 'yes' : c.replace(/^[•▪◦·]\s*/u, '')));
    const filled = row.filter((c) => c !== '');
    if (filled.length === 0) return;
    const top = [...band].sort((a, b) => b.y - a.y)[0]!;
    const at = { page: top.page, size, y: top.y };
    if (terms) {
      if (row[0] !== '') rows.push({ ...at, text: row[0]!, kind: 'group' });
      if (row[1] !== '') rows.push({ ...at, text: row[1]!, kind: 'row' });
      return;
    }
    if (filled.length === 1 && row[0] !== '') {
      rows.push({ ...at, text: row[0]!, kind: allBold(band) ? 'group' : 'row' });
      return;
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
  });
  return rows;
}

/** A page's lines with each table's lines read as its rows (see the file's comment), in the page's order. */
export function withTables<L extends PlacedLine>(lines: readonly L[]): (L | RowLine)[] {
  const boxes = lines.map(boxOf);
  const placed = boxes.filter((b): b is Box => b !== null);
  if (placed.length < 2) return [...lines];
  const left = Math.min(...placed.map((b) => b.x0));
  const right = Math.max(...placed.map((b) => b.x1));
  const pageWidth = right - left;
  const beside = (a: Box): boolean =>
    placed.some((b) => b !== a && Math.abs(b.line.y - a.line.y) <= Math.max(a.line.size, b.line.size) * ROW_MATE && (b.x0 - a.x1 >= a.line.size * TABLE_GAP || a.x0 - b.x1 >= a.line.size * TABLE_GAP));
  const top = [...placed].sort((a, b) => b.line.y - a.line.y || a.x0 - b.x0);
  // The tables, each the lines from its first line with another beside it to its last.
  const tables: Box[][] = [];
  let current: Box[] = [];
  let mates = 0;
  const close = () => {
    if (mates >= 2) {
      // A table ends at its last line beside another, and the lines just below it in one column.
      let end = current.length - 1;
      while (end >= 0 && !beside(current[end]!)) end -= 1;
      const kept = current.slice(0, end + 1);
      tables.push(kept);
    }
    current = [];
    mates = 0;
  };
  for (const b of top) {
    const mate = beside(b);
    if (!mate && current.length === 0) continue;
    if (!mate && b.x1 - b.x0 > pageWidth * WIDE) {
      close();
      continue;
    }
    if (current.length > 0) {
      const lowest = Math.min(...current.map((c) => c.line.y));
      if (lowest - b.line.y > b.line.size * ROW_GAP * 2.5 && !mate) {
        close();
        continue;
      }
    }
    current.push(b);
    if (mate) mates += 1;
  }
  close();
  if (tables.length === 0) return [...lines];
  // The lines just below a table's last row that fall within one column are that row's last lines.
  const taken = new Set<number>();
  const read: { at: number; rows: RowLine[] }[] = [];
  for (const table of tables) {
    const columns = columnsOf(table);
    if (columns.length < 2) continue;
    const members = [...table];
    // The lines just above its first and below its last that reach into one column at most: a cell's
    // first and last lines (a long text beside a label set level with its middle).
    const within = (b: Box) => columns.filter(([a, z]) => b.x0 < z && b.x1 > a).length <= 1;
    let highest = Math.max(...members.map((m) => m.line.y));
    for (const b of [...top].reverse()) {
      if (members.includes(b) || b.line.y <= highest) continue;
      if (!within(b) || b.line.y - highest > b.line.size * ROW_GAP * 2) break;
      members.push(b);
      highest = b.line.y;
    }
    let lowest = Math.min(...members.map((m) => m.line.y));
    for (const b of top) {
      if (members.includes(b) || b.line.y >= lowest) continue;
      if (!within(b) || lowest - b.line.y > b.line.size * ROW_GAP * 2) break;
      members.push(b);
      lowest = b.line.y;
    }
    const rows = rowsOf(members.map((m) => m.line));
    if (rows === null) continue;
    for (const m of members) taken.add(m.at);
    read.push({ at: Math.min(...members.map((m) => m.at)), rows });
  }
  const out: (L | RowLine)[] = [];
  lines.forEach((l, i) => {
    const table = read.find((r) => r.at === i);
    if (table) out.push(...table.rows);
    if (!taken.has(i)) out.push(l);
  });
  return out;
}

/** A line that is a table's row, read apart from the lines its page sets as prose. */
export const isRowLine = (l: PlacedLine): l is RowLine => 'kind' in l && ((l as RowLine).kind === 'row' || (l as RowLine).kind === 'group');
