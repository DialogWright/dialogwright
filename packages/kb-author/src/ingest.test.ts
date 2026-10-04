import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadKnowledgeFolder } from 'dialogwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FOLDER, fakeClock, guardedFetch, serveSite, type FixtureSite } from './__fixtures__/server';
import { ingest, IngestError, type IngestOptions } from './ingest';

/** A scratch app folder: the fixture documents copied into docs/, and a knowledge base with no topics yet. */
function scratchApp(): { app: string; kb: string; docs: string } {
  const app = join(mkdtempSync(join(tmpdir(), 'kb-author-')), 'app');
  const kb = join(app, 'kb');
  mkdirSync(kb, { recursive: true });
  writeFileSync(join(kb, 'kb.yaml'), 'action: findPassage\n');
  writeFileSync(join(kb, 'topics.yaml'), '{}\n');
  cpSync(FOLDER, join(app, 'docs'), { recursive: true });
  return { app, kb, docs: join(app, 'docs') };
}

const run = (app: { app: string; kb: string }, input: string, today = '2026-10-03', extra: Partial<IngestOptions> = {}) => ingest({ input, appDir: app.app, kbDir: app.kb, today, ...extra });

/** Every file under the sources folder, by name, with its bytes. */
function snapshot(kb: string): Record<string, string> {
  const dir = join(kb, 'sources');
  return Object.fromEntries(readdirSync(dir).sort().map((n) => [n, readFileSync(join(dir, n), 'utf8')]));
}

describe('ingesting a folder', () => {
  it('writes each document to kb/sources with its provenance and sections, in a form the engine loads', async () => {
    const app = scratchApp();
    const report = await run(app, app.docs);
    expect(report.kind).toBe('folder');
    expect(report.documents.map((d) => [d.id, d.status, 'file' in d.provenance ? d.provenance.file : d.provenance.url])).toEqual([
      ['branch-guide', 'added', 'docs/branch-guide.html'],
      ['faq', 'added', 'docs/faq.md'],
      ['guides-events', 'added', 'docs/guides/events.html'],
      ['notes', 'added', 'docs/notes.txt'],
      ['patron-guide', 'added', 'docs/patron-guide.pdf'],
      ['rights-notice', 'added', 'docs/rights-notice.pdf'],
      ['volunteer-handbook', 'added', 'docs/volunteer-handbook.docx'],
    ]);
    // A file of another type is listed; a hidden one is passed over.
    expect(report.skipped).toEqual([{ what: 'schedule.csv', reason: 'not a type read here (.pdf, .docx, .html, .htm, .md, .markdown, .txt)' }]);
    const folder = loadKnowledgeFolder(app.kb);
    expect(folder.problems).toEqual([]);
    expect(Object.keys(folder.kb!.sources)).toEqual(report.documents.map((d) => d.id));
    expect(readFileSync(join(app.kb, 'sources', 'patron-guide.yaml'), 'utf8')).toBe(
      [
        'document: Example Town Library Patron Guide',
        'provenance:',
        '  file: docs/patron-guide.pdf',
        '  retrieved: 2026-10-03',
        'sections:',
        '  p1:',
        '    text: This guide explains how to use the branches of the Example Town Library.',
        '  p1-opening-hours:',
        '    heading: Opening hours',
        '    text: All branches are open Monday to Friday from 9 a.m. to 8 p.m. and on Saturday from 10 a.m. to 4 p.m. All branches are closed on Sunday.',
        '  p1-library-cards:',
        '    heading: Library cards',
        '    text: |-',
        '      A library card is free for anyone who lives, works or studies in Example Town. Bring a photo ID to any branch desk to get one.',
        '',
        '      A card is valid for three years and is renewed at any branch desk.',
        '  p2-late-fees:',
        '    heading: Late fees',
        '    text: |-',
        '      An adult card is charged 25 cents for each day an item is overdue, up to 5 dollars for each item.',
        '',
        '      Junior cards are not charged late fees.',
        '  p2-renewing-items:',
        '    heading: Renewing items',
        '    text: |-',
        '      Most items can be renewed twice, online or at any branch desk, unless another patron has placed a hold on them.',
        '',
        '      Items borrowed from another library through the interlibrary service cannot be renewed.',
        '  p3-meeting-rooms:',
        '    heading: Meeting rooms',
        '    text: Meeting rooms can be booked up to sixty days ahead at no charge by any card holder. Each booking may last up to three hours.',
        '',
      ].join('\n'),
    );
  });

  it('gives the same bytes for the same input: a second run (another day) changes nothing, and a fresh folder gets the same files', async () => {
    const app = scratchApp();
    await run(app, app.docs, '2026-10-03');
    const first = snapshot(app.kb);
    const again = await run(app, app.docs, '2026-11-15');
    expect(again.documents.every((d) => d.status === 'unchanged' && d.sections.every((s) => s.status === 'unchanged'))).toBe(true);
    expect(snapshot(app.kb)).toEqual(first);
    const other = scratchApp();
    await run(other, other.docs, '2026-10-03');
    expect(snapshot(other.kb)).toEqual(first);
  });

  it('reports what changed, by document and section, and dates only what changed', async () => {
    const app = scratchApp();
    await run(app, app.docs, '2026-10-03');
    const faq = join(app.docs, 'faq.md');
    writeFileSync(
      faq,
      readFileSync(faq, 'utf8')
        .replace('a replacement is free', 'a replacement costs 1 dollar')
        .replace('## How long can I keep a book?', '## How long may I keep a book?')
        .replace(/Returns\n-------[\s\S]*$/, '## Holds\n\nPlace a hold online.\n'),
    );
    // Re-wrapping a paragraph changes no word: not a change.
    const notes = join(app.docs, 'notes.txt');
    writeFileSync(notes, readFileSync(notes, 'utf8').replace('is a quiet space.\nPhones', 'is a quiet\n   space. Phones'));
    const report = await run(app, app.docs, '2026-11-15');
    const faqChange = report.documents.find((d) => d.id === 'faq')!;
    expect(faqChange.status).toBe('changed');
    expect(faqChange.sections).toEqual([
      { id: 'intro', status: 'unchanged' },
      { id: 'borrowing', status: 'unchanged' },
      { id: 'borrowing/how-long-may-i-keep-a-book', status: 'added' },
      { id: 'borrowing/lost-cards', status: 'changed' },
      { id: 'borrowing/holds', status: 'added' },
      { id: 'borrowing/how-long-can-i-keep-a-book', status: 'removed' },
      { id: 'borrowing/returns', status: 'removed' },
    ]);
    expect(report.documents.filter((d) => d.status !== 'unchanged').map((d) => d.id)).toEqual(['faq']);
    expect(readFileSync(join(app.kb, 'sources', 'faq.yaml'), 'utf8')).toContain('retrieved: 2026-11-15');
    expect(readFileSync(join(app.kb, 'sources', 'notes.yaml'), 'utf8')).toContain('retrieved: 2026-10-03');
  });

  it('counts a changed heading over the same text as a change of heading only', async () => {
    const app = scratchApp();
    const md = join(app.docs, 'faq.md');
    await run(app, md);
    writeFileSync(md, readFileSync(md, 'utf8').replace('# Borrowing', '# Borrowing items'));
    // The heading's id moves with it; the same text under a new id is a new section.
    const moved = await run(app, md);
    expect(moved.documents[0]!.sections.filter((s) => s.status !== 'unchanged').map((s) => [s.id, s.status])).toEqual([
      ['borrowing-items', 'added'],
      ['borrowing-items/how-long-can-i-keep-a-book', 'added'],
      ['borrowing-items/lost-cards', 'added'],
      ['borrowing-items/returns', 'added'],
      ['borrowing', 'removed'],
      ['borrowing/how-long-can-i-keep-a-book', 'removed'],
      ['borrowing/lost-cards', 'removed'],
      ['borrowing/returns', 'removed'],
    ]);
    const doc = join(app.docs, 'branch-guide.html');
    await run(app, doc);
    writeFileSync(doc, readFileSync(doc, 'utf8').replace('<h3>Parking</h3>', '<h3>parking</h3>'));
    const heading = await run(app, doc);
    expect(heading.documents[0]!.sections.find((s) => s.status !== 'unchanged')).toEqual({ id: 'main-branch/parking', status: 'changed', headingOnly: true });
  });

  it('keeps ids from run to run, tells two documents with one name apart, and never overwrites a source it did not write', async () => {
    const app = scratchApp();
    mkdirSync(join(app.kb, 'sources'));
    const handWritten = 'document: Notes kept by hand\nsections:\n  one:\n    text: Written by a person.\n';
    writeFileSync(join(app.kb, 'sources', 'notes.yaml'), handWritten);
    writeFileSync(join(app.docs, 'faq.html'), '<main><h2>A</h2><p>One.</p><h2>B</h2><p>Two.</p></main>');
    const first = await run(app, app.docs);
    const ids = Object.fromEntries(first.documents.map((d) => ['file' in d.provenance ? d.provenance.file : '', d.id]));
    expect(ids['docs/notes.txt']).toBe('notes-txt');
    expect(ids['docs/faq.html']).toBe('faq');
    expect(ids['docs/faq.md']).toBe('faq-md');
    expect(readFileSync(join(app.kb, 'sources', 'notes.yaml'), 'utf8')).toBe(handWritten);
    // Without the HTML, the Markdown keeps the id it was given.
    rmSync(join(app.docs, 'faq.html'));
    const second = await run(app, app.docs);
    expect(second.documents.find((d) => 'file' in d.provenance && d.provenance.file === 'docs/faq.md')!.id).toBe('faq-md');
    // The HTML's source is not deleted: it is listed as not read this time.
    expect(second.notSeen).toEqual(['faq']);
    expect(existsSync(join(app.kb, 'sources', 'faq.yaml'))).toBe(true);
  });

  it('reads one file; a dry run writes nothing', async () => {
    const app = scratchApp();
    const dry = await run(app, join(app.docs, 'notes.txt'), '2026-10-03', { dryRun: true });
    expect(dry.kind).toBe('file');
    expect(dry.documents.map((d) => [d.id, d.status])).toEqual([['notes', 'added']]);
    expect(dry.documents[0]!.yaml).toBe('document: Notes\nprovenance:\n  file: docs/notes.txt\n  retrieved: 2026-10-03\nsections:\n  text:\n    text: |-\n      The reading room on the second floor is a quiet space. Phones are set to silent there.\n\n      Group study is welcome in the study rooms on the first floor.\n');
    expect(existsSync(join(app.kb, 'sources'))).toBe(false);
  });

  it('refuses a document too large for the loader, and an input that is not there or not read', async () => {
    const app = scratchApp();
    const big = join(app.docs, 'big.txt');
    writeFileSync(big, Array.from({ length: 30_000 }, (_, i) => `Paragraph ${i} of a very long text.`).join('\n\n'));
    const report = await run(app, big);
    expect(report.documents[0]!.refused).toMatch(/^it would be \d+ bytes, over the 1048576 a knowledge base file may be/);
    expect(existsSync(join(app.kb, 'sources', 'big.yaml'))).toBe(false);
    await expect(run(app, join(app.docs, 'missing'))).rejects.toThrow(IngestError);
    await expect(run(app, join(app.docs, 'schedule.csv'))).rejects.toThrow(/not a type read here/);
  });

  it('writes the editor schema comment when dialogwright is found above the app', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-author-ws-'));
    mkdirSync(join(root, 'packages', 'dialogwright', 'schemas'), { recursive: true });
    writeFileSync(join(root, 'packages', 'dialogwright', 'schemas', 'kb-source.schema.json'), '{}');
    const app = join(root, 'apps', 'demo');
    mkdirSync(join(app, 'kb'), { recursive: true });
    writeFileSync(join(app, 'notes.md'), 'Hello.\n');
    await ingest({ input: join(app, 'notes.md'), appDir: app, kbDir: join(app, 'kb'), today: '2026-10-03' });
    expect(readFileSync(join(app, 'kb', 'sources', 'notes.yaml'), 'utf8').split('\n')[0]).toBe('# yaml-language-server: $schema=../../../../packages/dialogwright/schemas/kb-source.schema.json');
  });
});

describe('ingesting a website', () => {
  let site: FixtureSite;
  beforeAll(async () => {
    site = await serveSite();
  });
  afterAll(async () => {
    await site.close();
  });

  it('writes each page and document with its URL, ids from the URL path, and is stable on a second crawl', async () => {
    const app = scratchApp();
    const crawlOptions = () => {
      const clock = fakeClock();
      return { depth: 2, userAgent: 'dialogwright-kb-ingest/test', fetch: guardedFetch(site.origin).fetch, sleep: clock.sleep, now: clock.now };
    };
    const report = await ingest({ input: `${site.origin}/`, appDir: app.app, kbDir: app.kb, today: '2026-10-03', crawl: crawlOptions() });
    expect(report.kind).toBe('site');
    expect(report.documents.map((d) => [d.id, 'url' in d.provenance ? d.provenance.url.replace(site.origin, '') : ''])).toEqual([
      ['index', '/'],
      ['about', '/about.html'],
      ['services', '/services/'],
      ['events', '/events.html'],
      ['files-patron-guide', '/files/patron-guide.pdf'],
      ['private-open', '/private/open.html'],
      ['services-hours', '/services/hours.html'],
      ['files-volunteer-handbook', '/files/volunteer-handbook.docx'],
    ]);
    expect(report.skipped.map((s) => s.reason)).toContain('disallowed by robots.txt');
    expect(report.crawl!.robots[0]!.outcome).toBe('found');
    expect(loadKnowledgeFolder(app.kb).problems).toEqual([]);
    expect(readFileSync(join(app.kb, 'sources', 'about.yaml'), 'utf8')).toBe(
      [
        'document: About the library',
        'provenance:',
        `  url: ${site.origin}/about.html`,
        '  retrieved: 2026-10-03',
        'sections:',
        '  intro:',
        '    text: The Example Town Library opened in 1921 and has three branches.',
        '  our-mission:',
        '    heading: Our mission',
        '    text: |-',
        '      We help everyone in Example Town read, learn and meet.',
        '',
        '      Back home, our public notices and opening hours.',
        '',
      ].join('\n'),
    );
    const first = snapshot(app.kb);
    const again = await ingest({ input: `${site.origin}/`, appDir: app.app, kbDir: app.kb, today: '2026-12-01', crawl: crawlOptions() });
    expect(again.documents.every((d) => d.status === 'unchanged')).toBe(true);
    expect(snapshot(app.kb)).toEqual(first);
    // A shallower crawl leaves the deeper pages' sources, listed as not read this time.
    const shallow = await ingest({ input: `${site.origin}/`, appDir: app.app, kbDir: app.kb, today: '2026-12-01', crawl: { ...crawlOptions(), depth: 0 } });
    expect(shallow.notSeen).toEqual(['about', 'events', 'files-patron-guide', 'files-volunteer-handbook', 'private-open', 'services', 'services-hours']);
  });
});
