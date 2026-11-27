import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FOLDER } from '../__fixtures__/server';
import { extractPdf } from './pdf';
import { box, fakeLiteParse, item, mergedRowsPage, scannedPages, tablePage } from '../__fixtures__/liteparse';
import { extractPdfLiteParse, liteParseVersion } from './liteparse';
import { readLabels } from './tables/labels';
import { scorePdf } from './tables/score';

const bytes = (name: string): Uint8Array => new Uint8Array(readFileSync(join(FOLDER, name)));

describe('LiteParse as the PDF reader', () => {
  it('pins the version it records', () => {
    expect(liteParseVersion()).toBe('2.21.3');
  });

  it('reads the fixtures into the sections, headings and pages our reader gives, its text items through our heading logic', async () => {
    for (const name of ['patron-guide.pdf', 'rights-notice.pdf']) {
      const ours = await extractPdf(bytes(name));
      const lite = await extractPdfLiteParse(bytes(name));
      expect(lite.title).toBe(ours.title);
      expect(lite.sections).toEqual(ours.sections);
      expect(lite.pages).toBe(ours.pages);
      expect(lite.reader).toBe('liteparse@2.21.3');
      expect(lite.notes).toBeUndefined();
    }
  });

  it('opens LiteParse with Tesseract named, OCR off for the first reading, and its blocks, word boxes and fonts', async () => {
    const fake = fakeLiteParse(() => [tablePage([{ label: 'Office visit', top: 130, values: ['$20', '$60'] }])]);
    await extractPdfLiteParse(bytes('rights-notice.pdf'), { open: fake.open });
    expect(fake.configs).toEqual([{ ocrEnabled: false, ocrLanguage: 'eng', maxPages: 500 }]);
  });

  it('says a table from LiteParse\'s blocks as our tables are said: each row with its column\'s heading', async () => {
    const fake = fakeLiteParse(() => [tablePage([
      { label: 'Office visit', top: 130, values: ['$20', '$60'] },
      { label: 'Emergency room', top: 150, values: ['$100', '$300'] },
    ])]);
    const doc = await extractPdfLiteParse(bytes('rights-notice.pdf'), { open: fake.open });
    const section = doc.sections.find((s) => s.id === 'visit-costs')!;
    expect(section.text).toBe('What a visit costs, by where it is.\n\nOffice visit: In network: $20; Out of network: $60\n\nEmergency room: In network: $100; Out of network: $300');
    // Our readers found the same table, and read the same figures in the same rows: nothing to note.
    expect(doc.notes).toBeUndefined();
  });

  it('keeps a footnote mark apart from its figure where LiteParse fused them: a smaller, raised word before or after it', async () => {
    // As LiteParse read a nutrition table: "1275" for 275 with mark 1 (one item, two word boxes), and a mark
    // of its own item touching "78".
    const page = tablePage([{ label: 'Fat', top: 130, values: ['78', '39'] }, { label: 'Total carbohydrates', top: 150, values: ['275', '150'] }]);
    const at = (t: string) => page.textItems.findIndex((i) => i.text === t);
    page.textItems[at('275')] = { ...item('1275', 246, 149), words: [{ text: '1', x: 246, y: 148, width: 3.5, height: 7 }, { text: '275', x: 250, y: 150, width: 15, height: 12 }] };
    page.textItems[at('150')] = { ...item('1502', 400, 150), words: [{ text: '150', x: 400, y: 150, width: 15, height: 12 }, { text: '2', x: 415, y: 149, width: 3.5, height: 7 }] };
    page.textItems.push({ ...item('1', 246, 129), height: 7, fontHeight: 6, words: [{ text: '1', x: 246, y: 129, width: 3.5, height: 7 }] });
    const fake = fakeLiteParse(() => [page]);
    const doc = await extractPdfLiteParse(bytes('rights-notice.pdf'), { open: fake.open });
    const text = doc.sections.find((s) => s.id === 'visit-costs')!.text;
    expect(text).toContain('Total carbohydrates: In network: 275; Out of network: 150');
    expect(text).toContain('Fat: In network: 78; Out of network: 39');
    expect(text).not.toMatch(/1275|1502|1 78/);
  });

  it('leaves out of a table the caption LiteParse read into its first row, so it stays a heading', async () => {
    // A title centred over the table and across its columns' edges, inside the box LiteParse gave its heading row (as it
    // read a nutrition table's).
    const rows = [{ label: 'Office visit', top: 130, values: ['$20', '$60'] }, { label: 'Emergency room', top: 150, values: ['$100', '$300'] }];
    const page = tablePage(rows);
    // In the page's order: after the sentence, before the table.
    page.textItems.splice(2, 0, item('Fees by visit and by network', 188, 94, 14, { bold: true }));
    const cell = (text: string, x: number, top: number, height = 12) => ({ text, bbox: box(x, top, 100, height), textItemIndices: [] });
    const header = [cell('Service', 72, 110), cell('In network', 250, 110), cell('Fees by visit and by network Out of network', 400, 94, 28)];
    const doc = await extractPdfLiteParse(bytes('rights-notice.pdf'), { open: fakeLiteParse(() => [{ ...page, blocks: [{ kind: 'table', header, rows: rows.map((r) => [cell(r.label, 72, r.top), ...r.values.map((v, k) => cell(v, 250 + k * 150, r.top))]), textItemIndices: [] }] }]).open });
    const section = doc.sections.find((s) => s.id === 'fees-by-visit-and-by-network')!;
    expect(section.heading).toBe('Fees by visit and by network');
    expect(section.text).toBe('Office visit: In network: $20; Out of network: $60\n\nEmergency room: In network: $100; Out of network: $300');
  });

  it('notes a table the two readers read differently, naming the page and the figures, and one LiteParse read weakly', async () => {
    // LiteParse ran two rows into one (as it did with two stations of a timetable); our readers kept them apart.
    const page = mergedRowsPage();
    const doc = await extractPdfLiteParse(bytes('rights-notice.pdf'), { open: fakeLiteParse(() => [page]).open });
    // LiteParse's reading is the one said.
    expect(doc.sections.find((s) => s.id === 'visit-costs')!.text).toContain('Office visit Urgent care: In network: $20 $50; Out of network: $60 $75');
    expect(doc.notes).toEqual([
      'page 1: check against the source: the two readers differ on a table of 3 columns and 1 row: LiteParse reads $20, $50, $60, $75 in "Office visit Urgent care"; ours reads $20, $60 in "Office visit", $50, $75 in "Urgent care"',
    ]);
  });

  it('reads a page with no text layer by OCR (Tesseract), marks its sections, notes it, and says once that OCR may download its language data', async () => {
    const fake = fakeLiteParse(scannedPages, 2);
    const said: string[] = [];
    const doc = await extractPdfLiteParse(bytes('rights-notice.pdf'), { open: fake.open, ocrLanguage: 'spa', onOcr: (line) => said.push(line) });
    expect(fake.configs).toEqual([
      { ocrEnabled: false, ocrLanguage: 'spa', maxPages: 500 },
      { ocrEnabled: true, ocrLanguage: 'spa', maxPages: 500, targetPages: '2' },
    ]);
    expect(doc.sections.map((s) => [s.id, s.page, s.ocr])).toEqual([
      ['opening-hours', 1, undefined],
      ['late-fees', 2, true],
    ]);
    expect(doc.sections[1]!.text).toBe('Each day late is 25 cents.');
    expect(doc.notes).toEqual(['page 2: it has no text layer, so it was read by OCR (Tesseract, spa): read its sections against the page before approving a passage from them']);
    expect(said).toEqual(['a PDF page with no text layer is read by OCR (Tesseract, spa); the first OCR on this machine downloads Tesseract\'s language data for it (about 15 MB)']);
  });

  it('is scored by kb:tables beside ours, on the same labels', async () => {
    const labels = readLabels([
      'document: rights-notice.pdf',
      'tables:',
      '  - page: 1',
      '    name: Visit costs',
      '    heads: [["Service", "In network", "Out of network"]]',
      '    rows:',
      '      - ["Office visit", "$20", "$60"]',
      '      - ["Emergency room", "$100", "$300"]',
    ].join('\n'));
    if (typeof labels === 'string') throw new Error(labels);
    const fake = fakeLiteParse(() => [tablePage([{ label: 'Office visit', top: 130, values: ['$20', '$60'] }, { label: 'Emergency room', top: 150, values: ['$100', '$300'] }])]);
    const score = await scorePdf(bytes('rights-notice.pdf'), labels, undefined, fake.open);
    // Ours reads the PDF itself (no such table on its page); LiteParse's reading (the fake's page) has it whole.
    expect(score.tables[0]!.reader).toBeUndefined();
    expect(score.tables[0]!.liteparse).toMatchObject({ reader: 'liteparse', check: 1, cells: { right: 6, of: 6 }, rows: { right: 2, of: 2 }, heads: { right: 3, of: 3 } });
  });

  it('refuses a PDF of more than 500 pages before LiteParse reads a page', async () => {
    const fake = fakeLiteParse(() => []);
    await expect(extractPdfLiteParse(bytes('rights-notice.pdf'), { open: fake.open, maxPages: 1 })).rejects.toThrow('it has 2 pages, over the 1 read');
    expect(fake.configs).toEqual([]);
  });
});
