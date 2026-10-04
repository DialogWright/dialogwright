import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FOLDER } from '../__fixtures__/server';
import { extractDocx } from './docx';
import { extractHtml } from './html';
import { extract, formatOfName } from './index';
import { extractMarkdown, extractText, stripInline } from './markdown';
import { blocksOfLines, extractPdf } from './pdf';

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

describe('formats', () => {
  it('knows a format by its extension, any case', async () => {
    expect(['a.PDF', 'b.docx', 'c.htm', 'd.html', 'e.md', 'f.markdown', 'g.txt', 'h.csv', 'noext'].map(formatOfName)).toEqual(['pdf', 'docx', 'html', 'html', 'markdown', 'markdown', 'text', undefined, undefined]);
    expect((await extract('text', new TextEncoder().encode('Hello.'))).sections).toEqual([{ id: 'text', text: 'Hello.' }]);
  });
});
