import { describe, expect, it } from 'vitest';
import { blocksOfLines, bodyLines, coverOf, isBoldFontName, linesOf, readPages, type Line, type PageLines, type Run } from './pdf';
import { withTables } from './pdfTables';

/**
 * How a PDF's layout is read (./pdf.ts, ./pdfTables.ts), on pages made of runs placed by hand: footnote
 * markers, what a page carries on its margins, a contents page, a cover, headings by weight, a heading
 * repeated over its section's pages, and tables (a heading row, cells over several lines, check marks,
 * a group's row, cells given column by column, and a list of terms beside their texts).
 */

/** A run of text at (x, y), `width` by default half its size a character; `B` is the bold font. */
const run = (str: string, x: number, y: number, size = 10, font = 'R', width = str.length * size * 0.5): Run => ({ str, transform: [size, 0, 0, size, x, y], width, fontName: font });
const bold = (font: string) => font === 'B';
const lines = (runs: Run[], page = 1) => linesOf(runs, page, bold);
const page = (n: number, runs: Run[], height = 792): PageLines => ({ page: n, height, lines: lines(runs, n) });
const texts = (ls: readonly { text: string }[]) => ls.map((l) => l.text);

describe('a line', () => {
  it('drops a footnote marker set smaller and raised, and keeps a number set as its words are', () => {
    const got = lines([run('Benefits', 46, 726), run('6', 83, 729, 6.5), run(' Your cost is listed', 90, 726), run('3 people may enrol', 46, 700)]);
    expect(texts(got)).toEqual(['Benefits Your cost is listed', '3 people may enrol']);
    expect(texts(lines([run('Prescription Drug Benefits', 46, 700), run('8,9', 180, 703, 6.5)]))).toEqual(['Prescription Drug Benefits']);
  });

  it('ends at a gap wider than a gutter, a space as wide as it notwithstanding; and says whether it is set in bold', () => {
    const got = lines([run('Inpatient services', 64, 364), run(' ', 154, 364, 10, 'R', 170), run('20%', 328, 364), run('Notes', 46, 300, 11, 'B')]);
    expect(texts(got)).toEqual(['Inpatient services', '20%', 'Notes']);
    expect(got.map((l) => l.bold === true)).toEqual([false, false, true]);
    expect(['Arial-BoldMT', 'CenturyGothic-Bold', 'Helvetica-Black', 'OpenSans-Semibold', 'Helvetica'].map(isBoldFontName)).toEqual([true, true, true, true, false]);
  });
});

describe('what a page carries on its margins', () => {
  const pages = [1, 2, 3, 4, 5].map((n) =>
    page(n, [
      run(n <= 2 ? 'Introduction' : 'Your benefits', 72, 752, 11),
      run(String(n), 528, 752, 11),
      run(`Body text of page ${n} goes here.`, 72, 600, 11),
      ...(n === 3
        ? [run('Questions? Call member services at 1-800-555-0100, Monday to Friday.', 72, 36, 9, 'B')]
        : [run('Questions? Call member services at 1-800-555-', 72, 42, 9, 'B'), run('0100, Monday to Friday.', 72, 31, 9, 'B')]),
    ]),
  );

  it('is dropped: a running header, a page number, a footer wrapped otherwise on one page', () => {
    expect(texts(bodyLines(pages))).toEqual([1, 2, 3, 4, 5].map((n) => `Body text of page ${n} goes here.`));
  });

  it('is kept on a document of two pages, but for its page numbers; and a contents page is dropped', () => {
    const two = [1, 2].map((n) => page(n, [run('Your benefits', 72, 752, 11), run(String(n), 528, 752, 11), run(`Page ${n} text.`, 72, 600, 11)]));
    expect(texts(bodyLines(two))).toEqual(['Your benefits', 'Page 1 text.', 'Your benefits', 'Page 2 text.']);
    const contents = page(1, [run('Introduction ......................... 4', 72, 600, 11), run('Your benefits ....................... 12', 72, 586, 11), run('Text.', 72, 500, 11)]);
    expect(texts(bodyLines([contents]))).toEqual(['Text.']);
  });
});

describe('a cover', () => {
  it('is the first page\'s lines in a style no later page uses and larger than every later heading: its largest the title, the rest the first text', () => {
    const doc = [
      ...lines([run('Member Handbook', 200, 477, 28, 'B'), run('Example Health Plan', 150, 337, 16, 'B'), run('Group 555-01', 150, 297, 16)], 1),
      ...lines([run('Your coverage', 72, 700, 14, 'B'), run('The plan pays for covered services.', 72, 680, 11)], 2),
    ];
    const cover = coverOf(doc);
    expect(cover.title).toBe('Member Handbook');
    expect(cover.text).toEqual(['Example Health Plan', 'Group 555-01']);
    expect(texts(cover.rest)).toEqual(['Your coverage', 'The plan pays for covered services.']);
    expect(coverOf(lines([run('One page', 72, 700, 20, 'B'), run('Text.', 72, 680)])).title).toBeUndefined();
  });
});

describe('headings', () => {
  const line = (text: string, y: number, size = 11, b = false, p = 1): Line => ({ page: p, text, size, y, ...(b ? { bold: true } : {}) });

  it('are larger lines, and bold ones at the body size that are no run-in ("Benefits include:"), each style a level', () => {
    const blocks = blocksOfLines([
      line('Your benefits', 700, 14, true),
      line('Ambulance services', 680, 12, true),
      line('Air ambulance', 660, 11, true),
      line('Benefits include:', 640, 11, true),
      line('Transport to the nearest hospital.', 626),
      line('A plain paragraph of body text that runs on.', 600),
    ]);
    expect(blocks.map((b) => [b.kind, 'level' in b ? b.level : null, b.text])).toEqual([
      ['heading', 1, 'Your benefits'],
      ['heading', 2, 'Ambulance services'],
      ['heading', 3, 'Air ambulance'],
      ['para', null, 'Benefits include: Transport to the nearest hospital.'],
      ['para', null, 'A plain paragraph of body text that runs on.'],
    ]);
  });

  it('that say again the heading their section is under continue it ("..., continued", or the heading over each page)', () => {
    const blocks = blocksOfLines([
      line('Exclusions', 700, 14, true, 1),
      line('Cosmetic surgery is not covered.', 680, 11, false, 1),
      line('Exclusions', 700, 14, true, 2),
      line('Hearing aids are covered once a year.', 680, 11, false, 2),
      line('Exclusions, continued', 700, 14, true, 3),
      line('Travel is not covered.', 680, 11, false, 3),
      line('Definitions', 600, 14, true, 3),
    ]);
    expect(blocks.filter((b) => b.kind === 'heading').map((b) => b.text)).toEqual(['Exclusions', 'Definitions']);
  });

  it('drop a contents section', () => {
    const doc = readPages([page(1, [run('Table of contents', 72, 700, 14, 'B'), run('Introduction 3', 72, 680, 11), run('Introduction', 72, 600, 14, 'B'), run('Welcome to the plan.', 72, 580, 11), run('Your benefits', 72, 500, 14, 'B'), run('The plan pays for care.', 72, 480, 11)])]);
    expect(doc.sections.map((s) => s.id)).toEqual(['introduction', 'your-benefits']);
  });
});

describe('a table', () => {
  /** A benefits table: a heading row over two lines, a group's row, a row whose cell runs over three lines level with its middle, check marks. */
  const benefits = [
    run('Benefits', 46, 726, 10, 'B'),
    run('Your cost', 393, 726, 10, 'B', 69),
    run('Using an', 305, 705, 10, 'B', 45),
    run('in-network', 307, 693, 10, 'B', 55),
    run('Deductible', 387, 705, 10, 'B', 35),
    run('applies', 387, 693, 10, 'B', 35),
    run('Using an', 439, 705, 10, 'B', 45),
    run('out-of-', 445, 693, 10, 'B', 35),
    run('network', 442, 681, 10, 'B', 45),
    run('Imaging services', 46, 650, 10, 'B'),
    run('• Laboratory center', 64, 630),
    run('20%', 328, 630, 10, 'R', 18),
    run('', 399, 630, 10, 'S', 10),
    run('40%', 463, 630, 10, 'R', 18),
    run('• Hospital outpatient', 64, 600),
    run('20%', 328, 600, 10, 'R', 18),
    run('40%', 463, 624 - 12, 10, 'R', 18),
    run('Subject to a', 444, 600, 10, 'R', 55),
    run('maximum of $300 a day', 442, 588, 10, 'R', 60),
  ];

  it('reads each row with its columns\' headings, a cell over several lines whole, a check mark as yes, a group\'s row as a heading', () => {
    const got = withTables(lines(benefits));
    expect(got.map((l) => [('kind' in l && l.kind) || null, l.text])).toEqual([
      ['group', 'Imaging services'],
      ['row', 'Laboratory center: Using an in-network: 20%; Deductible applies: yes; Using an out-of-network: 40%'],
      ['row', 'Hospital outpatient: Using an in-network: 20%; Using an out-of-network: 40% Subject to a maximum of $300 a day'],
    ]);
  });

  it('reads cells given column by column as it reads them row by row', () => {
    const byColumn = [...benefits.filter((r) => r.transform[4]! < 300), ...benefits.filter((r) => r.transform[4]! >= 300)];
    expect(texts(withTables(lines(byColumn)))).toEqual(texts(withTables(lines(benefits))));
  });

  it('leaves prose as it is, and ends at the prose after it', () => {
    const prose = [run('The plan pays for services a provider gives you, as this booklet says, each year.', 72, 700, 11), run('It pays them once the deductible is met.', 72, 686, 11)];
    expect(texts(withTables(lines(prose)))).toEqual(texts(lines(prose)));
    const after = [...benefits, run('Claims are paid within thirty days of the day the claim is received in full.', 46, 540, 11)];
    expect(texts(withTables(lines(after))).at(-1)).toBe('Claims are paid within thirty days of the day the claim is received in full.');
  });

  it('of terms beside their texts, each level with its text\'s middle, is each term a heading over its text; a text from the page before stays with its term', () => {
    const terms = [
      run('to the end of the previous term on the page before it.', 199, 706, 11),
      run('The services given for an emergency, among them a screening', 199, 680, 11),
      run('and the care to make the condition stable at the facility', 199, 666, 11),
      run('Emergency Services', 72, 659, 11, 'B', 100),
      run('where the member is seen, as the law requires it to be.', 199, 652, 11),
      run('A person who meets the plan\'s rules for who may enroll and', 199, 620, 11),
      run('Employee', 72, 613, 11, 'B', 50),
      run('who works for the employer named in the plan document.', 199, 606, 11),
    ];
    expect(withTables(lines(terms)).map((l) => [('kind' in l && l.kind) || null, l.text])).toEqual([
      ['row', 'to the end of the previous term on the page before it.'],
      ['group', 'Emergency Services'],
      ['row', 'The services given for an emergency, among them a screening and the care to make the condition stable at the facility where the member is seen, as the law requires it to be.'],
      ['group', 'Employee'],
      ['row', 'A person who meets the plan\'s rules for who may enroll and who works for the employer named in the plan document.'],
    ]);
  });
});
