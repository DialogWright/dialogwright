import { mkdtempSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FOLDER } from '../../__fixtures__/server';
import { tablesCommand } from '../../tables/command';
import { linesOf, type PageLines, type Run } from '../pdf';
import { readTables } from '../pdfTables';
import { borderTables } from './borders';
import { checkTable, WEAK } from './check';
import { fillGrid, type TableGrid } from './grid';
import { readLabels } from './labels';
import { gridOfModel, HttpModelTableReader, MODEL_MAX_TOKENS, MODEL_TABLE_INSTRUCTIONS, pageLayout } from './model';
import { rulesOf, type Rule } from './rules';
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
    expect(t.out).toContain('| rights-notice.pdf | 1 | Fees | not found | 0/6 (0%) | 0/2 (0%) | 0/3 (0%) |  |  |');
  });

  it('refuses labels that do not read or name no PDF beside them, and a command line with nothing to score', async () => {
    const t = io();
    writeFileSync(join(t.io.cwd, 'a.tables.yaml'), 'document: missing.pdf\ntables: []\n');
    expect(await tablesCommand(['a.tables.yaml'], t.io)).toBe(1);
    expect(t.err).toEqual(['kb:tables: a.tables.yaml: missing.pdf is not a PDF beside it']);
    expect(await tablesCommand([], io().io)).toBe(2);
  });
});

describe('the lines a page draws', () => {
  const OPS = { save: 10, restore: 11, transform: 12, constructPath: 91, stroke: 20, eoFill: 23, endPath: 28 };
  const path = (paint: number, ...data: number[]) => [paint, [Float32Array.from(data)], [0, 0, 0, 0]];
  it('are thin filled shapes along their length and straight stroked pieces, where the transform puts them; a clip, a curve\'s bend and a shading are none', () => {
    const fn = [OPS.constructPath, OPS.save, OPS.transform, OPS.constructPath, OPS.restore, OPS.constructPath, OPS.constructPath];
    const args = [
      // A border drawn as a thin rectangle: a rule across at its middle.
      path(OPS.eoFill, 0, 40, 699.5, 1, 400, 699.5, 1, 400, 700.5, 1, 40, 700.5, 4),
      null,
      [1, 0, 0, 1, 100, 0],
      // A stroked line down, moved 100 across by the transform in force.
      path(OPS.stroke, 0, 60, 600, 1, 60, 700),
      null,
      // A clip, and a cell's shading: no rules.
      path(OPS.endPath, 0, 0, 0, 1, 612, 0, 1, 612, 792, 1, 0, 792, 4),
      path(OPS.eoFill, 0, 40, 600, 1, 400, 600, 1, 400, 650, 1, 40, 650, 4),
    ];
    expect(rulesOf(fn, args, OPS)).toEqual([
      { dir: 'h', at: 700, from: 40, to: 400 },
      { dir: 'v', at: 160, from: 600, to: 700 },
    ]);
  });
});

/** A table drawn whole: a frame, rules between its rows and columns, and none between its second and third columns in its first row. */
const across = (at: number, from = 40, to = 400): Rule => ({ dir: 'h', at, from, to });
const down = (at: number, from = 600, to = 700): Rule => ({ dir: 'v', at, from, to });
const drawnRules = [across(700), across(680), across(660), across(630), across(600), down(40), down(160, 600, 700), down(280, 600, 680), down(400)];
const drawnText = [
  run('Service', 50, 688, 10, 'B'),
  run('What you pay', 230, 688, 10, 'B', 60),
  run('In network', 170, 668, 10, 'B'),
  run('Out of network', 290, 668, 10, 'B'),
  run('Office visit', 50, 640),
  run('$20', 170, 640, 10, 'R', 18),
  run('$60', 290, 640, 10, 'R', 18),
  run('Lab work', 50, 610),
  run('No charge', 170, 610),
  run('40%', 290, 610, 10, 'R', 18),
];

describe('a table found by its borders', () => {
  it('has its columns and rows where its rules are, a cell over the places no rule parts, and its bold rows as its heading', () => {
    const [found] = borderTables(lines(drawnText), drawnRules);
    expect(found!.grid).toMatchObject({ reader: 'borders', columns: [[40, 160], [160, 280], [280, 400]], rows: [[700, 680], [680, 660], [660, 630], [630, 600]], headRows: 2 });
    expect(found!.grid.spans).toEqual([{ row: 0, col: 1, rows: 1, cols: 2 }]);
    expect(found!.members).toHaveLength(drawnText.length);
  });

  it('is read over the same text found by where it is, and says its heading over two columns around their cells', () => {
    const read = readTables(lines(drawnText), drawnRules);
    expect(read.tables.map((t) => t.table.grid.reader)).toEqual(['borders']);
    expect(read.lines.map((l) => l.text)).toEqual([
      'Office visit: What you pay (In network: $20; Out of network: $60)',
      'Lab work: What you pay (In network: No charge; Out of network: 40%)',
    ]);
  });

  it('reaches past rules drawn only inside it to the text level with its rows beyond them, and leaves a caption over every column as the page\'s text', () => {
    // Inner rules only: no frame, and the rules across stop at the outer columns.
    const inner = [across(700, 160, 280), across(680, 160, 280), across(660, 160, 280), across(630, 160, 280), across(600, 160, 280), down(160), down(280)];
    const [found] = borderTables(lines(drawnText), inner);
    expect(found!.grid.columns.map(([a, b]) => [Math.round(a), Math.round(b)])).toEqual([[49, 160], [160, 280], [280, 361]]);
    const captioned = [across(720), ...drawnRules, down(40, 600, 720), down(400, 600, 720)];
    const withCaption = [run('Costs for each service', 50, 708), ...drawnText];
    const [table] = borderTables(lines(withCaption), captioned);
    expect(table!.grid.rows).toHaveLength(4);
    expect(table!.grid.headRows).toBe(2);
    expect(readTables(lines(withCaption), captioned).lines[0]!.text).toBe('Costs for each service');
  });
});

describe('a table a model proposes', () => {
  it('is checked before it is read: edges in order, two columns and two rows at least, its cells within it and apart', () => {
    expect(gridOfModel(1, { columns: [40, 160, 400], rows: [700, 680, 600], headRows: 1 })).toMatchObject({ reader: 'model', columns: [[40, 160], [160, 400]], rows: [[700, 680], [680, 600]], headRows: 1, spans: [] });
    expect(gridOfModel(1, { columns: [40, 400], rows: [700, 680, 600], headRows: 0 })).toBe('fewer than two columns or two rows');
    expect(gridOfModel(1, { columns: [40, 30, 400], rows: [700, 680, 600], headRows: 0 })).toBe('column edges not in order');
    expect(gridOfModel(1, { columns: [40, 160, 400], rows: [600, 680, 700], headRows: 0 })).toBe('row edges not in order, top to bottom');
    const spans = gridOfModel(1, { columns: [40, 160, 280, 400], rows: [700, 680, 660, 600], headRows: 9, spans: [{ row: 0, col: 1, rows: 1, cols: 2 }, { row: 0, col: 2, rows: 2, cols: 1 }, { row: 2, col: 0, rows: 5, cols: 1 }] });
    // A heading count past the table is none; a span over another, or past the table, is left out.
    expect(spans).toMatchObject({ headRows: 0, spans: [{ row: 0, col: 1, rows: 1, cols: 2 }] });
  });

  it('is asked of the page as text: each line\'s runs where they are, bold marked, then the lines the page draws', () => {
    expect(pageLayout(lines(fees.slice(0, 5)), [{ dir: 'h', at: 690, from: 40, to: 450 }]).split('\n')).toEqual([
      'y=700 size=10 | 50-70 b "Item" | 200-215 b "Fee" | 320-345 b "Notes"',
      'y=680 size=10 | 50-130 "Replacement card" | 200-210 "$5"',
      '',
      'Drawn lines (h: across at y, from x to x; v: down at x, from y to y):',
      'h 690 40-450',
    ]);
  });

  it('is asked of OpenRouter or Anthropic with the author\'s key from the environment, and refused with why', async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    const answering = (body: unknown, status = 200) => (async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(url), init: init! });
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
    const tables = { tables: [{ columns: [40, 160, 400], rows: [700, 680, 600], headRows: 1, spans: [] }] };
    const or = new HttpModelTableReader('openrouter:anthropic/claude-haiku-5.5', { OPENROUTER_API_KEY: 'sk-or-test-1234' }, answering({ choices: [{ message: { content: JSON.stringify(tables) } }], usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.001 } }));
    expect(await or.propose(1, 'y=700 ...')).toEqual(tables.tables);
    expect(sent[0]!.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(JSON.parse(String(sent[0]!.init.body))).toMatchObject({ model: 'anthropic/claude-haiku-5.5', messages: [{ role: 'system', content: MODEL_TABLE_INSTRUCTIONS }, { role: 'user', content: 'Page 1:\ny=700 ...' }] });
    expect(or.spent).toEqual({ requests: 1, inputTokens: 100, outputTokens: 20, costUsd: 0.001 });
    const an = new HttpModelTableReader('anthropic:claude-haiku-5-5', { ANTHROPIC_API_KEY: 'sk-ant-test-1234' }, answering({ content: [{ type: 'text', text: JSON.stringify(tables) }], usage: { input_tokens: 90, output_tokens: 10 } }));
    expect(await an.propose(2, 'y=700 ...')).toEqual(tables.tables);
    expect(sent[1]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect((sent[1]!.init.headers as Record<string, string>)['x-api-key']).toBe('sk-ant-test-1234');
    await expect(new HttpModelTableReader('openrouter:x/y', {}).propose(1, '')).rejects.toThrow('OPENROUTER_API_KEY is not set');
    expect(() => new HttpModelTableReader('azure:x', {})).toThrow('a model is <openrouter|anthropic>:<model id>');
    const refused = new HttpModelTableReader('openrouter:x/y', { OPENROUTER_API_KEY: 'sk-or-test-1234' }, answering({ error: { message: 'bad key sk-or-test-1234' } }, 401));
    await expect(refused.propose(1, '')).rejects.toThrow('openrouter answered 401: bad key [key]');
    const cut = new HttpModelTableReader('openrouter:x/y', { OPENROUTER_API_KEY: 'sk-or-test-1234' }, answering({ choices: [{ finish_reason: 'length', message: { content: null } }] }));
    await expect(cut.propose(1, '')).rejects.toThrow(`openrouter:x/y's answer is not the JSON asked for (cut off at ${MODEL_MAX_TOKENS} tokens)`);
  });

  it('is read where it scores better than the readings by where the text is, and every reading is returned', () => {
    // Columns too close for a gutter: where the text is, the table is one column; the model's grid parts them.
    const close = [run('Tier 1', 50, 700), run('$10', 90, 700, 10, 'R', 18), run('Tier 2', 50, 690), run('$25', 90, 690, 10, 'R', 18), run('Tier 3', 50, 680), run('$40', 90, 680, 10, 'R', 18)];
    const grid = gridOfModel(1, { columns: [45, 85, 115], rows: [706, 696, 686, 676], headRows: 0 });
    if (typeof grid === 'string') throw new Error(grid);
    const read = readTables(lines(close), [], [grid]);
    expect(read.tables.map((t) => t.table.grid.reader)).toEqual(['model']);
    expect(read.lines.map((l) => l.text)).toEqual(['Tier 1: $10', 'Tier 2: $25', 'Tier 3: $40']);
    expect(read.proposed.map((t) => t.table.grid.reader)).toContain('model');
  });
});
