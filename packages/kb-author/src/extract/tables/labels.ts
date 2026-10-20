import { parse } from 'yaml';

/**
 * A document's tables as a person labelled them (`<name>.tables.yaml` beside the document), which the
 * table readers are scored on (./score.ts, `kb:tables`):
 *
 *   document: plan-summary.pdf     # beside this file
 *   source: https://...            # where it came from
 *   tables:
 *     - page: 2
 *       name: What You Will Pay
 *       heads:                     # its heading rows, top to bottom (optional)
 *         - ["Common Medical Event", "Services You May Need", { text: "What You Will Pay", span: 2 }, "Limitations"]
 *         - [~, ~, "In-Network", "Out-of-Network", ~]
 *       rows:
 *         - ["If you visit a health care provider's office or clinic", "Primary care visit", "No charge", "40% coinsurance", "None."]
 *         - [~, "Specialist visit", "$50 copayment", "40% coinsurance", "None."]
 *
 * A row is its cells left to right, as many as the table has columns: a cell's words as printed, `""` for
 * an empty cell, `~` for a place another cell covers (a heading over several columns, a cell over several
 * rows written once on its first), and `{ text, span: N }` for a cell over N columns (counting as N).
 */

/** A labelled cell: its text, its first column, and how many columns it covers. */
export interface LabelCell {
  readonly text: string;
  readonly col: number;
  readonly cols: number;
}

export interface LabelTable {
  readonly page: number;
  readonly name: string;
  readonly columns: number;
  /** Each heading row's cells and each body row's, without the places covered (`~`). */
  readonly heads: readonly (readonly LabelCell[])[];
  readonly rows: readonly (readonly LabelCell[])[];
}

export interface LabelFile {
  readonly document: string;
  readonly source?: string;
  readonly tables: readonly LabelTable[];
}

/** A labels file's text read and checked, or what is wrong with it. */
export function readLabels(text: string): LabelFile | string {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (error) {
    return `it is not YAML (${error instanceof Error ? error.message : String(error)})`;
  }
  if (typeof doc !== 'object' || doc === null) return 'it is not a mapping';
  const d = doc as Record<string, unknown>;
  if (typeof d.document !== 'string' || d.document === '') return '`document` must name the document beside it';
  if (!Array.isArray(d.tables)) return '`tables` must be a list';
  const tables: LabelTable[] = [];
  for (const [i, t] of d.tables.entries()) {
    const where = `tables[${i}]`;
    if (typeof t !== 'object' || t === null) return `${where} is not a mapping`;
    const table = t as Record<string, unknown>;
    if (!Number.isInteger(table.page) || (table.page as number) < 1) return `${where}.page must be a page number`;
    if (!Array.isArray(table.rows) || table.rows.length === 0) return `${where}.rows must be a list of rows`;
    if (table.heads !== undefined && !Array.isArray(table.heads)) return `${where}.heads must be a list of rows`;
    // Each row's cells, and how many columns each row covers.
    const read = (rows: unknown[], what: string): { cells: LabelCell[][]; widths: number[] } | string => {
      const out: LabelCell[][] = [];
      const widths: number[] = [];
      for (const [r, row] of rows.entries()) {
        if (!Array.isArray(row)) return `${where}.${what}[${r}] is not a list`;
        const cells: LabelCell[] = [];
        let col = 0;
        for (const cell of row as unknown[]) {
          if (cell === null) {
            col += 1;
            continue;
          }
          if (typeof cell === 'string') {
            if (cell !== '') cells.push({ text: cell, col, cols: 1 });
            col += 1;
            continue;
          }
          const c = cell as Record<string, unknown>;
          if (typeof c !== 'object' || typeof c.text !== 'string' || !Number.isInteger(c.span) || (c.span as number) < 1) {
            return `${where}.${what}[${r}]: a cell is a string, ~, or { text, span }`;
          }
          cells.push({ text: c.text, col, cols: c.span as number });
          col += c.span as number;
        }
        out.push(cells);
        widths.push(col);
      }
      return { cells: out, widths };
    };
    const heads = read((table.heads as unknown[] | undefined) ?? [], 'heads');
    if (typeof heads === 'string') return heads;
    const rows = read(table.rows, 'rows');
    if (typeof rows === 'string') return rows;
    const widths = [...heads.widths, ...rows.widths];
    const columns = widths[0]!;
    const off = widths.findIndex((w) => w !== columns);
    if (off >= 0) return `${where}: every row must have ${columns} cells, as its first has (a span counting as several); row ${off + 1} has ${widths[off]}`;
    tables.push({ page: table.page as number, name: typeof table.name === 'string' ? table.name : `table ${i + 1}`, columns, heads: heads.cells, rows: rows.cells });
  }
  return { document: d.document, ...(typeof d.source === 'string' ? { source: d.source } : {}), tables };
}
