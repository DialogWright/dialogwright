import { cleanText } from '../../sections';
import { anchorOf, joinCell, type PlacedLine, type PlacedRun, type Span, type TableGrid } from './grid';

/**
 * The tables of a page found by where their text is (pdf.js gives a table's cells in any order: row by
 * row, or column by column), each proposed as a grid (./grid.ts).
 *
 * - A line with another beside it (on its baseline, give or take, past a gap of TABLE_GAP times its
 *   size) sits in a table. A table is the run of such lines, in the page's order from the top, with
 *   the lines between them and the lines just above the first and below the last that reach into one
 *   of its columns at most (a cell's first and last lines); a line as wide as most of the page with
 *   nothing beside it ends it (the prose after it).
 * - Its columns are found from its gutters: the places across the table no line's text covers but a
 *   one in twenty, one at least and two at most, in a table of eight lines or more (a heading over
 *   several columns, as "Your cost" is over "In network" and "Out of network"). A table has two columns
 *   at least. A column's edges are halfway across the gutters beside it.
 * - Its rows are bands of lines (split where a gap is over ROW_GAP times the line's size). Its first
 *   bands set wholly in bold, each with words in more than one column, are its heading rows. Each body
 *   row is anchored on its first column: a band with words in the first column is a row, and the bands
 *   without go to the row above or below them, split at the largest gap (a label set level with the
 *   middle of its text). A row's edges are halfway across the gaps beside it.
 * - A heading run over several columns ("Your cost" over "In network" and "Out of network") is a cell
 *   over the columns whose own headings are in the heading rows under it, each such column under the
 *   nearest of its row's runs over several columns.
 * - A band set in bold under its rows that says again words of its heading's (but its first column's: a
 *   second table's own heading, "Your cost" over its columns again) starts a table of its own, read apart
 *   with its own columns: read as a row of the first, it ran its heading into the rows above it.
 */

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

/** A grid proposed for some of a page's lines. */
export interface Proposal {
  readonly grid: TableGrid;
  readonly lines: readonly PlacedLine[];
}

/** A table's lines as grids (see the file's comment), or null when they are not a table. */
function gridsOf(lines: readonly PlacedLine[]): Proposal[] | null {
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
  // The heading rows: the first bands set wholly in bold.
  let first = 0;
  // The heading row each column's own words are first in, and the runs over several columns by row.
  const headBand = columns.map(() => -1);
  const over: { band: number; run: PlacedRun; mid: number }[] = [];
  // A heading's band has words in more than one column, or over several (a group's bold row under it has not).
  const across = (band: readonly PlacedLine[]): boolean => {
    const runs = runsIn(band, null, false);
    return runs.some((r) => spans(columns, r)) || new Set(runs.map((r) => columnAt(columns, (r.x + r.end) / 2))).size > 1;
  };
  while (first < bands.length - 1 && allBold(bands[first]!) && across(bands[first]!)) {
    cellsOf(bands[first]!, true).forEach((c, i) => {
      if (c !== '' && headBand[i] === -1) headBand[i] = first;
    });
    for (const r of runsIn(bands[first]!, null, false).filter((r) => spans(columns, r))) over.push({ band: first, run: r, mid: (r.x + r.end) / 2 });
    first += 1;
  }
  // A second table under this one's rows: a bold band saying again words of the heading (but its first
  // column's) starts it, and each is read on its own (its own columns).
  if (first > 0) {
    const said = new Set(bands.slice(0, first).flatMap((b) => runsIn(b, null, false)).filter((r) => columnAt(columns, (r.x + r.end) / 2) > 0).map((r) => r.text.trim()).filter((t) => t !== ''));
    const again = bands.findIndex((b, j) => j > first && allBold(b) && runsIn(b, null, false).some((r) => said.has(r.text.trim())));
    if (again > 0) return [...(gridsOf(bands.slice(0, again).flat()) ?? []), ...(gridsOf(bands.slice(again).flat()) ?? [])];
  }
  // Each heading run over several columns is a cell over the columns headed in a row below its own
  // (never the first, the rows' own labels), each under the nearest of its row's; one over no such
  // columns is a cell over those it crosses.
  const cellSpans: Span[] = [];
  // A cell over several columns where no other cell is, and no run of its row in one of its columns.
  const free = (row: number, from: number, to: number) =>
    !cellSpans.some((s) => s.row === row && s.col <= to && from <= s.col + s.cols - 1) &&
    !runsIn(bands[row]!, null, true).some((r) => {
      const c = columnAt(columns, (r.x + r.end) / 2);
      return c >= from && c <= to;
    });
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
      if (to > from && free(band, from, to)) cellSpans.push({ row: band, col: from, rows: 1, cols: to - from + 1 });
    });
    for (const o of inBand) {
      const crossed = columns.map(([a, b], k) => (o.run.x < b && o.run.end > a ? k : -1)).filter((k) => k >= 0);
      const from = Math.min(...crossed);
      const to = Math.max(...crossed);
      const mid = columnAt(columns, o.mid);
      if (mid >= from && mid <= to && free(band, from, to)) cellSpans.push({ row: band, col: from, rows: 1, cols: to - from + 1 });
    }
  }
  // The body rows: each band with words in the first column, and the bands without beside it, split
  // between the rows above and below them at the largest gap (a label set level with the middle of its text).
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
  const rows = [...bands.slice(0, first), ...rowBands];
  return [{ grid: gridOf(lines[0]!.page, columns, rows, first, cellSpans), lines }];
}

/** The grid of a table's columns and rows: each edge halfway across the gutter or gap beside it, the outer ones just past the text. */
function gridOf(page: number, columns: readonly [number, number][], rows: readonly (readonly PlacedLine[])[], headRows: number, cellSpans: readonly Span[]): TableGrid {
  const runs = rows.flat().flatMap((l) => (l.runs ?? []).filter((r) => r.text.trim() !== ''));
  const ys = rows.map((band) => band.map((l) => anchorOf(l, { x: 0, end: 0, text: '', bold: false }).y));
  const left = Math.min(columns[0]![0], ...runs.map((r) => r.x)) - 1;
  const right = Math.max(columns[columns.length - 1]![1], ...runs.map((r) => r.end)) + 1;
  const columnEdges = columns.map(([a, b], i): [number, number] => [
    i === 0 ? left : (columns[i - 1]![1] + a) / 2,
    i === columns.length - 1 ? right : (b + columns[i + 1]![0]) / 2,
  ]);
  const rowEdges = ys.map((y, i): [number, number] => [
    i === 0 ? Math.max(...y) + 1 : (Math.min(...ys[i - 1]!) + Math.max(...y)) / 2,
    i === ys.length - 1 ? Math.min(...y) - 1 : (Math.min(...y) + Math.max(...ys[i + 1]!)) / 2,
  ]);
  return { page, reader: 'alignment', columns: columnEdges, rows: rowEdges, headRows, spans: cellSpans };
}

/** A page's tables found by where their text is: each with the lines it holds (by their index in `lines`) and its grids. */
export function alignmentTables(lines: readonly PlacedLine[]): { members: number[]; proposals: Proposal[] }[] {
  const boxes = lines.map(boxOf);
  const placed = boxes.filter((b): b is Box => b !== null);
  if (placed.length < 2) return [];
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
      tables.push(current.slice(0, end + 1));
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
  const found: { members: number[]; proposals: Proposal[] }[] = [];
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
    const proposals = gridsOf(members.map((m) => m.line));
    if (proposals === null) continue;
    found.push({ members: members.map((m) => m.at), proposals });
  }
  return found;
}
