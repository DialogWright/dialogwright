import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { FOLDER } from '../__fixtures__/server';
import { checkDocxZip, DocxLimitError, extractDocx, MAX_DOCX_ENTRIES, MAX_DOCX_UNCOMPRESSED_BYTES } from './docx';
import { extractHtml } from './html';
import { extract, formatOfName } from './index';
import { extractMarkdown, extractText, stripInline } from './markdown';
import { blocksOfLines, extractPdf, MAX_PDF_PAGES, PDF_OPEN_OPTIONS, PdfLimitError } from './pdf';

/** A zip of `entries` (deflated), each with the size its headers declare (by default its own). */
function zipOf(entries: { name: string; data: Buffer; declared?: number }[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = deflateRawSync(e.data);
    const crc = crc32(e.data);
    const size = e.declared ?? e.data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, dir, end]));
}

/** A PDF of `pages` empty pages, written out by hand with its cross-reference table. */
function pdfOf(pages: number): Uint8Array {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Count ${pages} /Kids [${Array.from({ length: pages }, (_, i) => `${i + 3} 0 R`).join(' ')}] >>`];
  for (let i = 0; i < pages; i += 1) objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] >>');
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

const bytes = (name: string): Uint8Array => new Uint8Array(readFileSync(join(FOLDER, name)));
const text = (name: string): string => readFileSync(join(FOLDER, name), 'utf8');

describe('HTML', () => {
  it('reads a page with a <main> whole: headings by path, tables, lists, line breaks; never scripts, navigation or footers', () => {
    const doc = extractHtml(text('branch-guide.html'));
    expect(doc.from).toBe('main');
    expect(doc.title).toBe('Branch guide');
    expect(doc.sections).toEqual([
      { id: 'intro', text: 'The library has three branches in Example Town.' },
      { id: 'main-branch', heading: 'Main branch', text: 'The main branch is at 1 Example Square, next to the town hall.' },
      { id: 'main-branch/parking', heading: 'Parking', text: 'Free parking for two hours.\nBicycle racks by the entrance.' },
      { id: 'branch-hours', heading: 'Branch hours', text: 'Branch | Weekdays | Saturday\nMain | 9 a.m. to 8 p.m. | 10 a.m. to 4 p.m.\nRiverside | 10 a.m. to 6 p.m. | Closed' },
      { id: 'services', heading: 'Services', text: 'Printing and copying\nStudy rooms\n\nNote\n\nStudy rooms are booked at the desk.' },
      { id: 'services-2', heading: 'Services', text: 'Some services need a library card.' },
    ]);
    const all = doc.sections.map((s) => s.text).join(' ');
    expect(all).not.toMatch(/never read|555-0100|Home/);
  });

  it('lets Readability find the content of a page that does not mark it', () => {
    const doc = extractHtml(text('guides/events.html'));
    expect(doc.from).toBe('readability');
    expect(doc.title).toBe('Events at the library');
    expect(doc.sections.map((s) => s.id)).toEqual(['story-time', 'book-club']);
    expect(doc.sections[0]!.text).toMatch(/^Story time for young children is held every Tuesday/);
  });

  it('reads the one <article>, or the body when nothing else will do', () => {
    expect(extractHtml('<html><body><nav>Menu</nav><article><h2>One</h2><p>Text.</p><h2>Two</h2><p>More.</p></article></body></html>')).toMatchObject({
      from: 'article',
      sections: [{ id: 'one', heading: 'One', text: 'Text.' }, { id: 'two', heading: 'Two', text: 'More.' }],
    });
    const body = extractHtml('<html><head><title>T</title></head><body><header><a href="/">Site</a></header><p>Short.</p><script>x()</script></body></html>');
    expect(body.from).toBe('readability');
    expect(body.title).toBe('T');
    expect(body.sections).toEqual([{ id: 'text', text: 'Short.' }]);
  });

  it('keeps inline text between blocks and pre-formatted lines', () => {
    const doc = extractHtml('<main><div>Loose text <b>bold</b><p>Para.</p>tail</div><pre>line one\n  line two</pre></main>');
    expect(doc.sections).toEqual([{ id: 'text', text: 'Loose text bold\n\nPara.\n\ntail\n\nline one\nline two' }]);
  });
});

describe('Markdown and text', () => {
  it('reads headings (ATX and setext), paragraphs, lists and code, with markup stripped and front matter as the title', () => {
    const doc = extractMarkdown(text('faq.md'));
    expect(doc.title).toBe('Frequently asked questions');
    expect(doc.sections).toEqual([
      { id: 'intro', text: 'Answers to the questions the desk hears most.' },
      { id: 'borrowing', heading: 'Borrowing', text: 'You can borrow up to 20 items at a time with an adult card.' },
      { id: 'borrowing/how-long-can-i-keep-a-book', heading: 'How long can I keep a book?', text: 'Books are lent for three weeks. DVDs are lent for one week.\n\nRenew online\nRenew at any branch desk' },
      { id: 'borrowing/lost-cards', heading: 'Lost cards', text: 'Report a lost card at any branch desk; a replacement is free.' },
      { id: 'borrowing/returns', heading: 'Returns', text: 'Items can be returned at any branch, or in the return box outside the main branch.\n\nReturn box: open all day' },
    ]);
  });

  it('strips inline markup to its words, leaving snake_case and arithmetic alone', () => {
    expect(stripInline('**Bold** and *em* and _under_ and `code` and [a link](http://x.example) and ![alt](i.png) and <b>tag</b>')).toBe('Bold and em and under and code and a link and alt and tag');
    expect(stripInline('snake_case_name and 2 * 3 * 4')).toBe('snake_case_name and 2 * 3 * 4');
  });

  it('takes the first heading as the title without front matter', () => {
    expect(extractMarkdown('# Guide\n\nHello.\n\n## Hours\n\nNine.\n')).toEqual({ title: 'Guide', sections: [{ id: 'intro', text: 'Hello.' }, { id: 'hours', heading: 'Hours', text: 'Nine.' }] });
  });

  it('reads a text file as one section of paragraphs', () => {
    expect(extractText(text('notes.txt'))).toEqual({
      sections: [{ id: 'text', text: 'The reading room on the second floor is a quiet space. Phones are set to silent there.\n\nGroup study is welcome in the study rooms on the first floor.' }],
    });
  });
});

describe('PDF', () => {
  it('finds headings by size and gives sections heading ids with the page each starts on', async () => {
    const doc = await extractPdf(bytes('patron-guide.pdf'));
    expect(doc.pages).toBe(3);
    expect(doc.title).toBe('Example Town Library Patron Guide');
    expect(doc.sections.map((s) => [s.id, s.heading, s.page])).toEqual([
      ['intro', undefined, 1],
      ['opening-hours', 'Opening hours', 1],
      ['library-cards', 'Library cards', 1],
      ['late-fees', 'Late fees', 2],
      ['renewing-items', 'Renewing items', 2],
      ['meeting-rooms', 'Meeting rooms', 3],
    ]);
    expect(doc.sections[1]!.text).toBe('All branches are open Monday to Friday from 9 a.m. to 8 p.m. and on Saturday from 10 a.m. to 4 p.m. All branches are closed on Sunday.');
    expect(doc.sections[3]!.text).toBe('An adult card is charged 25 cents for each day an item is overdue, up to 5 dollars for each item.\n\nJunior cards are not charged late fees.');
    // A section running on to the next page says where it ends.
    expect([doc.sections[4]!.page, doc.sections[4]!.lastPage, doc.sections[3]!.lastPage]).toEqual([2, 3, undefined]);
    expect(doc.sections[4]!.text).toBe('Most items can be renewed twice, online or at any branch desk, unless another patron has placed a hold on them.\n\nItems borrowed from another library through the interlibrary service cannot be renewed.');
  });

  it('cuts a PDF without headings by page, its title from its metadata', async () => {
    const doc = await extractPdf(bytes('rights-notice.pdf'));
    expect(doc.title).toBe('Example Town Library Notice of Patron Rights');
    expect(doc.sections.map((s) => s.id)).toEqual(['p1', 'p2']);
    expect(doc.sections[1]!.text).toBe('A patron who disagrees with a decision about their card may ask the branch manager to review it within thirty days.');
  });

  it('joins lines into paragraphs by their gaps, keeping a hyphen at a line end', () => {
    const line = (text: string, y: number, size = 10, page = 1) => ({ page, text, size, y });
    const blocks = blocksOfLines([line('Fees', 700, 14), line('An overdue item is charged a self-', 680), line('service fee and a', 668), line('daily fee.', 656), line('A new paragraph.', 630)]);
    expect(blocks).toEqual([
      { kind: 'heading', level: 1, text: 'Fees', page: 1 },
      { kind: 'para', text: 'An overdue item is charged a self-service fee and a daily fee.', page: 1 },
      { kind: 'para', text: 'A new paragraph.', page: 1 },
    ]);
  });
});

describe('DOCX', () => {
  it('reads headings by style, the Title paragraph as the title, lists one item to a line', async () => {
    const doc = await extractDocx(bytes('volunteer-handbook.docx'));
    expect(doc.title).toBe('Example Town Library Volunteer Handbook');
    expect(doc.sections).toEqual([
      { id: 'intro', text: 'Thank you for volunteering at the Example Town Library.' },
      { id: 'getting-started', heading: 'Getting started', text: 'Every volunteer signs in at the front desk at the start of each shift.' },
      { id: 'getting-started/training', heading: 'Training', text: 'New volunteers attend one training session before their first shift. The session covers:\n\nshelving and the catalog\nhelping patrons find items\nwhat to do in an emergency' },
      { id: 'shifts', heading: 'Shifts', text: 'Shifts last three hours and are booked one month ahead.' },
      { id: 'shifts/training', heading: 'Training', text: 'Shift leads attend a second training session each spring.' },
      { id: 'contacts', heading: 'Contacts', text: 'Ask the volunteer coordinator at the main branch for any change to your shifts.' },
    ]);
  });
});

describe('extraction limits', () => {
  it('checks a DOCX\'s zip before it is opened: what it holds in all, and each entry no larger than it says', async () => {
    expect(MAX_DOCX_UNCOMPRESSED_BYTES).toBe(50 * 1024 * 1024);
    expect(MAX_DOCX_ENTRIES).toBe(10_000);
    // The fixture passes, and so does a small zip under the cap.
    expect(() => checkDocxZip(bytes('volunteer-handbook.docx'))).not.toThrow();
    // A zip bomb: 4 MB of zeros in a few kilobytes, declared as it is, over a 1 MB cap.
    const zeros = Buffer.alloc(4 * 1024 * 1024);
    const bomb = zipOf([{ name: '[Content_Types].xml', data: Buffer.from('<Types/>') }, { name: 'word/document.xml', data: zeros }]);
    expect(bomb.length).toBeLessThan(10 * 1024);
    expect(() => checkDocxZip(bomb, 1024 * 1024)).toThrow(new DocxLimitError('its entries hold over 1 MB uncompressed (a zip bomb, or a document too large to read)'));
    await expect(extractDocx(bomb, { maxBytes: 1024 * 1024 })).rejects.toThrow(DocxLimitError);
    // One that lies: its headers say 100 bytes, and it inflates to 4 MB.
    const liar = zipOf([{ name: 'word/document.xml', data: zeros, declared: 100 }]);
    expect(() => checkDocxZip(liar, 1024 * 1024)).toThrow(new DocxLimitError('its zip entry word/document.xml holds more than it says (100 bytes): a zip bomb'));
    // Not a zip at all.
    expect(() => checkDocxZip(new TextEncoder().encode('not a zip'))).toThrow(new DocxLimitError('it is not a zip (a DOCX is one)'));
  });

  it('a folder\'s DOCX that is a zip bomb is skipped with why, not read', async () => {
    const zeros = Buffer.alloc(51 * 1024 * 1024);
    const bomb = zipOf([{ name: 'word/document.xml', data: zeros }]);
    await expect(extract('docx', bomb)).rejects.toThrow('its entries hold over 50 MB uncompressed (a zip bomb, or a document too large to read)');
  });

  it('refuses a PDF of more than 500 pages before it reads a page, and opens every PDF with code evaluation off', async () => {
    expect(MAX_PDF_PAGES).toBe(500);
    const many = pdfOf(501);
    expect(many.length).toBeLessThan(64 * 1024);
    await expect(extractPdf(many)).rejects.toThrow(new PdfLimitError('it has 501 pages, over the 500 read'));
    await expect(extractPdf(pdfOf(3), { maxPages: 2 })).rejects.toThrow(new PdfLimitError('it has 3 pages, over the 2 read'));
    expect((await extractPdf(pdfOf(3))).pages).toBe(3);
    expect(PDF_OPEN_OPTIONS).toEqual({ isEvalSupported: false });
    // The pdf.js unpdf bundles evaluates no code at all: no Function constructor, no eval.
    const bundle = readFileSync(fileURLToPath(new URL('../../node_modules/unpdf/dist/pdfjs.mjs', import.meta.url)), 'utf8');
    expect(bundle).not.toMatch(/new Function\(|\beval\(/);
  });
});

describe('formats', () => {
  it('knows a format by its extension, any case', async () => {
    expect(['a.PDF', 'b.docx', 'c.htm', 'd.html', 'e.md', 'f.markdown', 'g.txt', 'h.csv', 'noext'].map(formatOfName)).toEqual(['pdf', 'docx', 'html', 'html', 'markdown', 'markdown', 'text', undefined, undefined]);
    expect((await extract('text', new TextEncoder().encode('Hello.'))).sections).toEqual([{ id: 'text', text: 'Hello.' }]);
  });
});
