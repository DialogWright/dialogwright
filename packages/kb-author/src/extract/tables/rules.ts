/**
 * The lines a PDF page draws (a table's borders and the rules between its cells), from pdf.js's operator
 * list: each painted path's straight horizontal and vertical pieces, where they are on the page.
 *
 * - A path is painted when its `constructPath` names a fill or a stroke (`endPath` only clips: never a line).
 * - A filled shape thinner than THIN across is a rule along its length (a border drawn as a thin
 *   rectangle, as a word processor draws one). A larger filled shape is no rule: its edges are where a
 *   shading is, which is not where a cell ends (a word processor fills a box behind each line of a cell's
 *   text, and behind a cell inside its padding; taking their edges cut cells in two).
 * - A stroked path gives each of its pieces that runs straight across or straight down.
 * - Points are taken through the transform in force (`transform`, `save`, `restore`, a form's matrix),
 *   so a rule is where the page shows it, in the units of its text (y from the page's bottom).
 */

/** A rule: horizontal (`h`, at a height, from one x to another) or vertical (`v`, at an x, from one height to another). */
export interface Rule {
  readonly dir: 'h' | 'v';
  readonly at: number;
  readonly from: number;
  readonly to: number;
}

/** A filled shape this thin or thinner across is a rule. */
const THIN = 3;
/** The shortest rule kept. */
const SHORTEST = 2;
/** A stroked piece is straight across (or down) when it leans this little. */
const LEAN = 1;

type Matrix = [number, number, number, number, number, number];

const times = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
];

const apply = (m: Matrix, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** pdf.js's codes in a path's data (DrawOPS). */
const MOVE = 0;
const LINE = 1;
const CURVE = 2;
const QUAD = 3;
const CLOSE = 4;

/** A path's data as its subpaths, each its points (curves by their ends) and whether it closes. */
function subpathsOf(data: ArrayLike<number>, m: Matrix): { points: [number, number][]; closed: boolean }[] {
  const out: { points: [number, number][]; closed: boolean }[] = [];
  let current: { points: [number, number][]; closed: boolean } | null = null;
  for (let i = 0; i < data.length; ) {
    const op = data[i]!;
    if (op === MOVE) {
      current = { points: [apply(m, data[i + 1]!, data[i + 2]!)], closed: false };
      out.push(current);
      i += 3;
    } else if (op === LINE) {
      current?.points.push(apply(m, data[i + 1]!, data[i + 2]!));
      i += 3;
    } else if (op === CURVE) {
      current?.points.push(apply(m, data[i + 5]!, data[i + 6]!));
      i += 7;
    } else if (op === QUAD) {
      current?.points.push(apply(m, data[i + 3]!, data[i + 4]!));
      i += 5;
    } else if (op === CLOSE) {
      if (current) current.closed = true;
      i += 1;
    } else {
      break;
    }
  }
  return out;
}

const ruleAcross = (y: number, x0: number, x1: number): Rule => ({ dir: 'h', at: y, from: Math.min(x0, x1), to: Math.max(x0, x1) });
const ruleDown = (x: number, y0: number, y1: number): Rule => ({ dir: 'v', at: x, from: Math.min(y0, y1), to: Math.max(y0, y1) });

/** The rules a page draws, from its operator list (`fnArray`, `argsArray`) and pdf.js's `OPS` (see the file's comment). */
export function rulesOf(fnArray: ArrayLike<number>, argsArray: ArrayLike<unknown>, OPS: Readonly<Record<string, number>>): Rule[] {
  const name = new Map(Object.entries(OPS).map(([k, v]) => [v, k]));
  const rules: Rule[] = [];
  let m: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];
  for (let i = 0; i < fnArray.length; i += 1) {
    const op = name.get(fnArray[i]!);
    const args = argsArray[i] as unknown[] | null;
    if (op === 'save') stack.push(m);
    else if (op === 'restore') m = stack.pop() ?? m;
    else if (op === 'transform' && args) m = times(args as Matrix, m);
    else if (op === 'paintFormXObjectBegin') {
      stack.push(m);
      const matrix = args?.[0];
      if (Array.isArray(matrix) && matrix.length === 6) m = times(matrix as Matrix, m);
    } else if (op === 'paintFormXObjectEnd') m = stack.pop() ?? m;
    else if (op === 'constructPath' && args) {
      const paint = name.get(args[0] as number) ?? '';
      const data = (args[1] as ArrayLike<number>[] | undefined)?.[0];
      if (data === undefined || paint === 'endPath') continue;
      const fills = /fill/i.test(paint);
      const strokes = /stroke/i.test(paint);
      for (const { points, closed } of subpathsOf(data, m)) {
        if (points.length < 2) continue;
        if (fills) {
          const xs = points.map((p) => p[0]);
          const ys = points.map((p) => p[1]);
          const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
          const w = x1 - x0;
          const h = y1 - y0;
          if (Math.max(w, h) < SHORTEST) continue;
          if (h <= THIN && w > h) rules.push(ruleAcross((y0 + y1) / 2, x0, x1));
          else if (w <= THIN && h > w) rules.push(ruleDown((x0 + x1) / 2, y0, y1));
        }
        if (strokes) {
          const pts = closed ? [...points, points[0]!] : points;
          for (let k = 1; k < pts.length; k += 1) {
            const [ax, ay] = pts[k - 1]!;
            const [bx, by] = pts[k]!;
            if (Math.abs(ay - by) <= LEAN && Math.abs(ax - bx) >= SHORTEST) rules.push(ruleAcross((ay + by) / 2, ax, bx));
            else if (Math.abs(ax - bx) <= LEAN && Math.abs(ay - by) >= SHORTEST) rules.push(ruleDown((ax + bx) / 2, ay, by));
          }
        }
      }
    }
  }
  return rules;
}
