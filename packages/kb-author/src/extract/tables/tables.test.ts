import { mkdtempSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FOLDER } from '../../__fixtures__/server';
import { tablesCommand } from '../../tables/command';
import { linesOf, type PageLines, type Run } from '../pdf';
import { readTables } from '../pdfTables';
import { checkTable, WEAK } from './check';
import { fillGrid, type TableGrid } from './grid';
import { readLabels } from './labels';
import { comparable, scorePages } from './score';

/**
 * The table format every reader proposes (./grid.ts), its filling from the page's own runs, the checker
 * (./check.ts), the labels a person writes (./labels.ts) and the scores on them (./score.ts, kb:tables).
 */

const run = (str: string, x: number, y: number, size = 10, font = 'R', width = str.length * size * 0.5): Run => ({ str, transform: [size, 0, 0, size, x, y], width, fontName: font });
const lines = (runs: Run[], page = 1) => linesOf(runs, page, (font) => font === 'B');

/** A table of three columns: a heading row, then two rows, the second's middle cell over two lines. */
const fees = [
  run('Item', 50, 700, 10, 'B'),
  run('Fee', 200, 700, 10, 'B'),
  run('Notes', 320, 700, 10, 'B'),
  run('Replacement card', 50, 680),
  run('$5', 200, 680, 10, 'R', 10),
  run('Once a year free', 320, 680),
  run('Late return', 50, 660),
  run('$0.25 a day', 200, 660),
  run('up to $10', 200, 648),
  run('Per item', 320, 660),
];

/** A grid over `fees` drawn by hand, as a reader that knows the table's borders would propose it. */
const drawn: TableGrid = {
  page: 1,
  reader: 'hand',
  columns: [
    [40, 190],
    [190, 310],
    [310, 450],
  ],
  rows: [
    [712, 690],
    [690, 670],
    [670, 640],
  ],
  headRows: 1,
  spans: [],
};

describe('a grid', () => {
  it('is filled with the page\'s own runs, each in the cell its anchor is in, a cell\'s lines joined top to bottom', () => {
    const table = fillGrid(drawn, lines(fees));
    expect(table.cells.map((row) => row.map((c) => c.text))).toEqual([
      ['Item', 'Fee', 'Notes'],
      ['Replacement card', '$5', 'Once a year free'],
      ['Late return', '$0.25 a day up to $10', 'Per item'],
    ]);
    expect(table.cells[0]!.every((c) => c.bold)).toBe(true);
    expect(table.outside).toBe(0);
    expect(table.tops.map((l) => l?.y)).toEqual([700, 680, 660]);
  });

  it('puts a cell over several columns\' runs in its first place, and counts the runs outside it', () => {
    const titled = [...fees, run('Fees and charges', 220, 720, 10, 'B'), run('Page 4', 50, 600)];
    const grid: TableGrid = { ...drawn, rows: [[730, 712], ...drawn.rows], headRows: 2, spans: [{ row: 0, col: 0, rows: 1, cols: 3 }] };
    const table = fillGrid(grid, lines(titled));
    expect(table.cells[0]!.map((c) => [c.text, c.covered === true])).toEqual([
      ['Fees and charges', false],
      ['', true],
      ['', true],
    ]);
    expect(table.outside).toBe('Page 4'.length);
  });

  it('notes a cell\'s lines a blank line apart, and runs side by side in it a gutter apart', () => {
    const table = fillGrid(drawn, lines([...fees, run('Lost item', 50, 641)]));
    expect(table.cells[2]![0]!.breaks).toBe(1);
    const side = fillGrid({ ...drawn, columns: [[40, 310], [310, 450]] }, lines(fees));
    expect(side.cells[1]![0]!.sideBySide).toBe(true);
    expect(fillGrid(drawn, lines(fees)).cells[1]![0]!.sideBySide).toBe(false);
  });
});

describe('the checker', () => {
  it('scores a table read whole 1, and one that left text out, ran rows together or read two columns as one less, saying why', () => {
    const page = lines(fees);
    expect(checkTable(fillGrid(drawn, page), page)).toEqual({ score: 1, problems: [] });
    const short = fillGrid(drawn, page.filter((l) => l.text !== 'Per item'));
    expect(checkTable(short, page).problems).toEqual(['9% of the text inside the table is in none of its cells']);
    const merged = fillGrid({ ...drawn, columns: [[40, 310], [310, 450]] }, page);
    const check = checkTable(merged, page);
    expect(check.score).toBeLessThan(WEAK);
    expect(check.problems).toContain('50% of its cells hold text side by side on a line (two columns read as one)');
  });

  it('checks the tables the page is read with: a table found by where its text is, read whole, scores 1', () => {
    const read = readTables(lines(fees));
    expect(read.tables).toHaveLength(1);
    expect(read.tables[0]!.table.grid.reader).toBe('alignment');
    expect(read.tables[0]!.check.score).toBe(1);
    expect(read.lines.map((l) => l.text)).toEqual(['Replacement card: Fee: $5; Notes: Once a year free', 'Late return: Fee: $0.25 a day up to $10; Notes: Per item']);
  });
});

const LABELS = `document: fees.pdf
tables:
  - page: 1
    name: Fees
    heads:
      - ["Item", "Fee", "Notes"]
    rows:
      - ["Replacement card", "$5", "Once a year free"]
      - ["Late return", "$0.25 a day up to $10", "Per item"]
`;

describe('labels', () => {
  it('read each row\'s cells by column, a cell over several columns counting as several and ~ a place covered', () => {
    const labels = readLabels(`document: a.pdf
tables:
  - page: 2
    heads:
      - ["Service", { text: "What you pay", span: 2 }]
      - [~, "In network", "Out of network"]
    rows:
      - ["Office visit", "$20", ""]
`);
    expect(labels).toEqual({
      document: 'a.pdf',
      tables: [
        {
          page: 2,
          name: 'table 1',
          columns: 3,
          heads: [
            [{ text: 'Service', col: 0, cols: 1 }, { text: 'What you pay', col: 1, cols: 2 }],
            [{ text: 'In network', col: 1, cols: 1 }, { text: 'Out of network', col: 2, cols: 1 }],
          ],
          rows: [[{ text: 'Office visit', col: 0, cols: 1 }, { text: '$20', col: 1, cols: 1 }]],
        },
      ],
    });
  });

  it('refuse a row with more or fewer cells than the first, and a file that names no document', () => {
    expect(readLabels(LABELS.replace('"Per item"]', '"Per item", ""]'))).toBe('tables[0]: every row must have 3 cells, as its first has (a span counting as several); row 3 has 4');
    expect(readLabels('tables: []')).toBe('`document` must name the document beside it');
  });
});

describe('scores on labels', () => {
  const page = (runs: Run[]): PageLines => ({ page: 1, height: 792, lines: lines(runs) });
  const labels = readLabels(LABELS);
  if (typeof labels === 'string') throw new Error(labels);

  it('count the cells, whole rows and headings read right, without case or spacing, and the checker\'s score', () => {
    const got = scorePages([page(fees)], labels);
    expect(got.tables[0]).toMatchObject({ reader: 'alignment', check: 1, cells: { right: 6, of: 6 }, rows: { right: 2, of: 2 }, heads: { right: 3, of: 3 }, misses: [] });
    expect(got.unseen).toEqual([]);
    expect(comparable('$0.25  a Day')).toBe(comparable('$0.25 a day'));
  });

  it('say a cell read wrong with the row it was matched with, a table not found, and a labelled word the page does not have', () => {
    const wrong = scorePages([page(fees.map((r) => (r.str === 'Per item' ? { ...r, str: 'Each item' } : r)))], labels);
    expect(wrong.tables[0]!.cells).toEqual({ right: 5, of: 6 });
    expect(wrong.tables[0]!.misses).toEqual([{ label: 'Per item', row: 'Late return | $0.25 a day up to $10 | Each item' }]);
    expect(wrong.unseen).toEqual([{ page: 1, words: 'Per' }]);
    const prose = scorePages([page([run('The fees are listed at the desk, and each is paid when the item is returned.', 50, 700)])], labels);
    expect(prose.tables[0]).toMatchObject({ cells: { right: 0, of: 6 }, misses: [] });
    expect(prose.tables[0]!.reader).toBeUndefined();
  });
});

describe('kb:tables', () => {
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l), cwd: mkdtempSync(join(tmpdir(), 'kb-tables-')) } };
  };

  it('scores a folder of labelled documents and writes the table', async () => {
    const t = io();
    copyFileSync(join(FOLDER, 'rights-notice.pdf'), join(t.io.cwd, 'rights-notice.pdf'));
    writeFileSync(join(t.io.cwd, 'rights-notice.tables.yaml'), LABELS.replace('fees.pdf', 'rights-notice.pdf'));
    expect(await tablesCommand(['.'], t.io)).toBe(0);
    expect(t.out[0]).toBe('# Table readers scored on 1 labelled document, 1 table');
    expect(t.out).toContain('| rights-notice.pdf | 1 | Fees | not found | 0/6 (0%) | 0/2 (0%) | 0/3 (0%) |  |');
  });

  it('refuses labels that do not read or name no PDF beside them, and a command line with nothing to score', async () => {
    const t = io();
    writeFileSync(join(t.io.cwd, 'a.tables.yaml'), 'document: missing.pdf\ntables: []\n');
    expect(await tablesCommand(['a.tables.yaml'], t.io)).toBe(1);
    expect(t.err).toEqual(['kb:tables: a.tables.yaml: missing.pdf is not a PDF beside it']);
    expect(await tablesCommand([], io().io)).toBe(2);
  });
});
