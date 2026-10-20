import { anchorOf, type PlacedLine, type Span, type TableGrid } from './grid';
import type { Rule } from './rules';

/**
 * The tables of a page found by the lines it draws around and between their cells (./rules.ts), each
 * proposed as a grid (./grid.ts).
 *
 * - Rules lying on one line, touching or overlapping (within JOIN), are one rule.
 * - A table is a set of horizontal and vertical rules that cross or touch one another (within JOIN),
 *   with two columns at least (the columns beyond its rules, below, counted) and two rows at least.
 * - Its column edges are where its vertical rules are and its row edges where its horizontal rules are,
 *   each place within CLUSTER of another taken as one; a column or row narrower than SLIVER (two rules
 *   drawn side by side) is no column or row.
 * - Two cells side by side, or one above the other, with no rule along most (COVER) of the edge between
 *   them are one cell: a heading over several columns, or a label over several rows. A cell over places
 *   that do not make a rectangle is left as its places.
 * - A table drawn with inner rules only (no frame) reaches past its outer rules: where text sits beyond
 *   its first (or last) vertical rule, level with two of its rows or more and nearer than its widest
 *   column, that text is a column of its own (the labels down its left, a date down its right).
 * - A row at its top that is one cell over every column is its caption, not a row: it is left as the
 *   page's text (a paragraph boxed above a table's heading).
 * - Its heading rows are its first rows whose text is all set in bold (not every row).
 */

/** Rules this close are one rule, and a rule this close to another touches it. */
const JOIN = 2;
/** Rule places this close are one edge. */
const CLUSTER = 2;
/** A column or row narrower than this is a sliver between two rules, not a column or row. */
const SLIVER = 4;
/** The share of an edge between two cells a rule must cover for them to be two cells. */
const COVER = 0.5;

/** Rules lying on one line merged where they touch or overlap. */
function merged(rules: readonly Rule[]): Rule[] {
  const out: Rule[] = [];
  const sorted = [...rules].sort((a, b) => (a.dir === b.dir ? a.at - b.at || a.from - b.from : a.dir < b.dir ? -1 : 1));
  for (const r of sorted) {
    const last = out.find((o) => o.dir === r.dir && Math.abs(o.at - r.at) <= JOIN && r.from <= o.to + JOIN && o.from <= r.to + JOIN);
    if (last === undefined) out.push({ ...r });
    else {
      const i = out.indexOf(last);
      out[i] = { dir: r.dir, at: (last.at + r.at) / 2, from: Math.min(last.from, r.from), to: Math.max(last.to, r.to) };
    }
  }
  return out;
}

/** Whether a horizontal and a vertical rule cross or touch. */
const meets = (h: Rule, v: Rule): boolean => v.at >= h.from - JOIN && v.at <= h.to + JOIN && h.at >= v.from - JOIN && h.at <= v.to + JOIN;

/** The rules in sets that cross or touch one another. */
function groupsOf(rules: readonly Rule[]): Rule[][] {
  const parent = rules.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  rules.forEach((a, i) => {
    rules.forEach((b, j) => {
      if (j <= i || a.dir === b.dir) return;
      if (meets(a.dir === 'h' ? a : b, a.dir === 'h' ? b : a)) parent[find(i)] = find(j);
    });
  });
  const groups = new Map<number, Rule[]>();
  rules.forEach((r, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), r]));
  return [...groups.values()];
}

/** Places within CLUSTER of each other as one (their middle), in order; places closer than SLIVER after that dropped but the outer two. */
function edgesOf(places: readonly number[]): number[] {
  const sorted = [...places].sort((a, b) => a - b);
  const clusters: number[][] = [];
  for (const p of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && p - last[last.length - 1]! <= CLUSTER) last.push(p);
    else clusters.push([p]);
  }
  const edges = clusters.map((c) => (c[0]! + c[c.length - 1]!) / 2);
  const kept: number[] = [];
  edges.forEach((e, i) => {
    if (kept.length > 0 && e - kept[kept.length - 1]! < SLIVER) {
      // The outer edge is kept over the one just inside it.
      if (i === edges.length - 1) kept[kept.length - 1] = e;
      return;
    }
    kept.push(e);
  });
  return kept;
}

/** How much of [a, b] the rules along one line cover. */
function covered(rules: readonly Rule[], a: number, b: number): number {
  const parts = rules.map((r) => [Math.max(a, r.from), Math.min(b, r.to)] as const).filter(([x, y]) => y > x).sort((p, q) => p[0] - q[0]);
  let total = 0;
  let reach = a;
  for (const [x, y] of parts) {
    if (y <= reach) continue;
    total += y - Math.max(x, reach);
    reach = y;
  }
  return total;
}

/** A table's grid from its rules: its edges, and the cells no rule parts (see the file's comment). */
function gridOfRules(page: number, rules: readonly Rule[]): Omit<TableGrid, 'headRows'> | null {
  const xs = edgesOf(rules.filter((r) => r.dir === 'v').map((r) => r.at));
  const ys = edgesOf(rules.filter((r) => r.dir === 'h').map((r) => r.at)).reverse();
  // One column at least between the rules (two after the columns beyond them, below), two rows at least.
  if (xs.length < 2 || ys.length < 3) return null;
  const columns = xs.slice(1).map((x, i): [number, number] => [xs[i]!, x]);
  const rows = ys.slice(1).map((y, i): [number, number] => [ys[i]!, y]);
  const along = (dir: 'h' | 'v', at: number) => rules.filter((r) => r.dir === dir && Math.abs(r.at - at) <= CLUSTER + JOIN);
  // Each place joined to its neighbour on the right, or below, where no rule parts them.
  const parent = rows.flatMap((_, r) => columns.map((__, c) => r * columns.length + c));
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  rows.forEach(([top, bottom], r) => {
    columns.forEach(([left, right], c) => {
      const here = r * columns.length + c;
      if (c + 1 < columns.length && covered(along('v', right), bottom, top) < (top - bottom) * COVER) parent[find(here)] = find(here + 1);
      if (r + 1 < rows.length && covered(along('h', bottom), left, right) < (right - left) * COVER) parent[find(here)] = find(here + columns.length);
    });
  });
  const members = new Map<number, number[]>();
  parent.forEach((_, i) => members.set(find(i), [...(members.get(find(i)) ?? []), i]));
  let spans: Span[] = [];
  for (const places of members.values()) {
    if (places.length < 2) continue;
    const rs = places.map((p) => Math.floor(p / columns.length));
    const cs = places.map((p) => p % columns.length);
    const [r0, r1, c0, c1] = [Math.min(...rs), Math.max(...rs), Math.min(...cs), Math.max(...cs)];
    // A cell over places that make a rectangle; any other shape is left as its places.
    if ((r1 - r0 + 1) * (c1 - c0 + 1) === places.length) spans.push({ row: r0, col: c0, rows: r1 - r0 + 1, cols: c1 - c0 + 1 });
  }
  // A caption: the top rows that are one cell over every column.
  let caption = 0;
  while (caption < rows.length - 2 && spans.some((s) => s.row === caption && s.rows === 1 && s.col === 0 && s.cols === columns.length)) caption += 1;
  if (caption > 0) {
    spans = spans.filter((s) => s.row >= caption).map((s) => ({ ...s, row: s.row - caption }));
  }
  return { page, reader: 'borders', columns, rows: rows.slice(caption), spans };
}

/** A grid with a column added on either side for text beyond its outer rules (see the file's comment). */
function withOuterColumns(grid: Omit<TableGrid, 'headRows'>, lines: readonly PlacedLine[]): Omit<TableGrid, 'headRows'> {
  const [x0, x1] = [grid.columns[0]![0], grid.columns[grid.columns.length - 1]![1]];
  const widest = Math.max(...grid.columns.map(([a, b]) => b - a));
  const rowOf = (y: number) => grid.rows.findIndex(([top, bottom]) => y <= top && y >= bottom);
  const beyond = (side: 'left' | 'right') => {
    const runs: { x: number; end: number; row: number }[] = [];
    for (const line of lines) {
      for (const run of line.runs ?? []) {
        if (run.text.trim() === '') continue;
        const row = rowOf(anchorOf(line, run).y);
        if (row < 0) continue;
        if (side === 'left' && run.end <= x0 + 1 && x0 - run.end < widest) runs.push({ ...run, row });
        if (side === 'right' && run.x >= x1 - 1 && run.x - x1 < widest) runs.push({ ...run, row });
      }
    }
    return new Set(runs.map((r) => r.row)).size >= 2 ? runs : [];
  };
  const left = beyond('left');
  const right = beyond('right');
  const columns = [
    ...(left.length > 0 ? [[Math.min(...left.map((r) => r.x)) - 1, x0] as [number, number]] : []),
    ...grid.columns,
    ...(right.length > 0 ? [[x1, Math.max(...right.map((r) => r.end)) + 1] as [number, number]] : []),
  ];
  const shift = left.length > 0 ? 1 : 0;
  return { ...grid, columns, spans: grid.spans.map((s) => ({ ...s, col: s.col + shift })) };
}

/** The first rows whose text is all bold (not every row), from the page's lines. */
function headRowsOf(grid: Omit<TableGrid, 'headRows'>, lines: readonly PlacedLine[]): number {
  const rowOf = (y: number) => grid.rows.findIndex(([top, bottom]) => y <= top && y >= bottom);
  const [x0, x1] = [grid.columns[0]![0], grid.columns[grid.columns.length - 1]![1]];
  const bold = grid.rows.map(() => ({ any: false, all: true }));
  for (const line of lines) {
    for (const run of line.runs ?? []) {
      if (run.text.trim() === '') continue;
      const at = anchorOf(line, run);
      if (at.x < x0 || at.x > x1) continue;
      const r = rowOf(at.y);
      if (r < 0) continue;
      bold[r]!.any = true;
      if (!run.bold) bold[r]!.all = false;
    }
  }
  let heads = 0;
  while (heads < grid.rows.length - 1 && bold[heads]!.any && bold[heads]!.all) heads += 1;
  return heads;
}

/** A page's tables found by their borders: each grid with the indexes of the lines that have text in it. */
export function borderTables(lines: readonly PlacedLine[], rules: readonly Rule[]): { members: number[]; grid: TableGrid }[] {
  const found: { members: number[]; grid: TableGrid }[] = [];
  for (const group of groupsOf(merged(rules))) {
    const ruled = gridOfRules(lines[0]?.page ?? 0, group);
    if (ruled === null) continue;
    const grid = withOuterColumns(ruled, lines);
    if (grid.columns.length < 2) continue;
    const [x0, x1] = [grid.columns[0]![0], grid.columns[grid.columns.length - 1]![1]];
    const [top, bottom] = [grid.rows[0]![0], grid.rows[grid.rows.length - 1]![1]];
    const members = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => (l.runs ?? []).some((r) => {
        if (r.text.trim() === '') return false;
        const at = anchorOf(l, r);
        return at.x >= x0 && at.x <= x1 && at.y <= top && at.y >= bottom;
      }))
      .map(({ i }) => i);
    if (members.length === 0) continue;
    found.push({ members, grid: { ...grid, headRows: headRowsOf(grid, members.map((i) => lines[i]!)) } });
  }
  return found;
}
