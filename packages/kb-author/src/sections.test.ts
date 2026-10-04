import { describe, expect, it } from 'vitest';
import { cleanLines, cleanText, distinct, sectionsOf, slugOf, type Block } from './sections';

const h = (level: 1 | 2 | 3, text: string, page?: number): Block => ({ kind: 'heading', level, text, ...(page === undefined ? {} : { page }) });
const p = (text: string, page?: number): Block => ({ kind: 'para', text, ...(page === undefined ? {} : { page }) });
const li = (text: string): Block => ({ kind: 'item', text });

describe('slugs and text', () => {
  it('slugs headings to readable ids', () => {
    expect(slugOf('Late fees')).toBe('late-fees');
    expect(slugOf('  Café & Reading-Room (2nd floor)!  ')).toBe('cafe-reading-room-2nd-floor');
    expect(slugOf('???')).toBe('section');
    expect(slugOf('???', 'intro')).toBe('intro');
    const long = slugOf('How long can I keep a book that I borrowed from another branch of the library');
    expect(long.length).toBeLessThanOrEqual(48);
    expect(long).toBe('how-long-can-i-keep-a-book-that-i-borrowed-from');
  });

  it('tells ids apart in order', () => {
    const taken = new Set<string>();
    expect([distinct('a', taken), distinct('a', taken), distinct('a', taken), distinct('b', taken)]).toEqual(['a', 'a-2', 'a-3', 'b']);
  });

  it('collapses whitespace and drops invisible characters, keeping lines where they matter', () => {
    expect(cleanText('  one  two\n\tthree­four​ ')).toBe('one two threefour');
    expect(cleanLines(' first  line \n\n  second\nline ')).toBe('first line\nsecond\nline');
  });
});

describe('sectionsOf', () => {
  it('takes the title heading out and cuts at the other headings by path', () => {
    const doc = sectionsOf([h(1, 'Guide'), p('Welcome.'), h(2, 'Cards'), p('Free.'), h(3, 'Renewal'), p('Every three years.'), h(2, 'Fees'), li('One'), li('Two'), p('After.')]);
    expect(doc.title).toBe('Guide');
    expect(doc.sections).toEqual([
      { id: 'intro', text: 'Welcome.' },
      { id: 'cards', heading: 'Cards', text: 'Free.' },
      { id: 'cards/renewal', heading: 'Renewal', text: 'Every three years.' },
      { id: 'fees', heading: 'Fees', text: 'One\nTwo\n\nAfter.' },
    ]);
  });

  it('keeps every heading in the path when there is no single title heading', () => {
    const doc = sectionsOf([h(1, 'Getting started'), p('Sign in.'), h(2, 'Training'), p('Once.'), h(1, 'Shifts'), h(2, 'Training'), p('Each spring.')]);
    expect(doc.title).toBeUndefined();
    expect(doc.sections.map((s) => s.id)).toEqual(['getting-started', 'getting-started/training', 'shifts/training']);
  });

  it('tells two sections with one path apart, and skips a heading with no text', () => {
    const doc = sectionsOf([h(2, 'Services'), p('Printing.'), h(2, 'Services'), p('Rooms.'), h(2, 'Empty')]);
    expect(doc.sections.map((s) => s.id)).toEqual(['services', 'services-2']);
  });

  it('makes a document without headings one section, text', () => {
    expect(sectionsOf([p('One.'), p('Two.')]).sections).toEqual([{ id: 'text', text: 'One.\n\nTwo.' }]);
  });

  it('a document that names its title elsewhere keeps its first heading as a section', () => {
    expect(sectionsOf([h(1, 'Borrowing'), p('Twenty items.')], { titled: true }).sections).toEqual([{ id: 'borrowing', heading: 'Borrowing', text: 'Twenty items.' }]);
  });

  it('gives a paged document page ids, by heading or by page', () => {
    const headed = sectionsOf([h(1, 'Guide', 1), p('Intro.', 1), h(2, 'Hours', 1), p('Nine to five.', 1), h(2, 'Fees', 2), p('Some.', 2), p('More, on the next page.', 3)], { paged: true });
    expect(headed.sections).toEqual([
      { id: 'p1', text: 'Intro.', page: 1 },
      { id: 'p1-hours', heading: 'Hours', text: 'Nine to five.', page: 1 },
      { id: 'p2-fees', heading: 'Fees', text: 'Some.\n\nMore, on the next page.', page: 2 },
    ]);
    const plain = sectionsOf([p('One.', 1), p('Two.', 2), p('Three.', 2)], { paged: true });
    expect(plain.sections).toEqual([
      { id: 'p1', text: 'One.', page: 1 },
      { id: 'p2', text: 'Two.\n\nThree.', page: 2 },
    ]);
  });
});
