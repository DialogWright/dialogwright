import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FOLDER, fakeClock, guardedFetch, serveSite, type FixtureSite } from './__fixtures__/server';
import { main, USER_AGENT, VERSION, type Io } from './cli';

/** A scratch app folder (app.yaml, an empty knowledge base, the fixture documents in docs/), and an io run from it. */
function scratch(extra: Partial<Io> = {}): { app: string; io: Io; out: string[]; err: string[] } {
  const app = join(mkdtempSync(join(tmpdir(), 'kb-author-cli-')), 'app');
  mkdirSync(join(app, 'kb'), { recursive: true });
  writeFileSync(join(app, 'app.yaml'), 'name: demo\n');
  writeFileSync(join(app, 'kb', 'kb.yaml'), 'action: findPassage\n');
  writeFileSync(join(app, 'kb', 'topics.yaml'), '{}\n');
  cpSync(FOLDER, join(app, 'docs'), { recursive: true });
  const out: string[] = [];
  const err: string[] = [];
  return { app, out, err, io: { out: (l) => out.push(l), err: (l) => err.push(l), cwd: app, today: () => '2026-10-03', ...extra } };
}

describe('kb:ingest', () => {
  it('reads a folder and says what it wrote, then that nothing changed', async () => {
    const s = scratch();
    expect(await main(['kb:ingest', 'docs'], s.io)).toBe(0);
    expect(s.out).toEqual([
      'docs: 7 documents read into kb/sources: 7 added, 0 changed, 0 unchanged; 1 skipped',
      '  added     branch-guide (docs/branch-guide.html): 6 sections; wrote kb/sources/branch-guide.yaml',
      '  added     faq (docs/faq.md): 5 sections; wrote kb/sources/faq.yaml',
      '  added     guides-events (docs/guides/events.html): 2 sections; wrote kb/sources/guides-events.yaml',
      '  added     notes (docs/notes.txt): 1 section; wrote kb/sources/notes.yaml',
      '  added     patron-guide (docs/patron-guide.pdf): 6 sections; wrote kb/sources/patron-guide.yaml',
      '  added     rights-notice (docs/rights-notice.pdf): 2 sections; wrote kb/sources/rights-notice.yaml',
      '  added     volunteer-handbook (docs/volunteer-handbook.docx): 6 sections; wrote kb/sources/volunteer-handbook.yaml',
      '  skipped   schedule.csv: not a type read here (.pdf, .docx, .html, .htm, .md, .markdown, .txt)',
    ]);
    s.out.length = 0;
    writeFileSync(join(s.app, 'docs', 'notes.txt'), `${readFileSync(join(s.app, 'docs', 'notes.txt'), 'utf8')}\nA new paragraph.\n`);
    expect(await main(['kb:ingest', 'docs', '--dir', '.'], s.io)).toBe(0);
    expect(s.out[0]).toBe('docs: 7 documents read into kb/sources: 0 added, 1 changed, 6 unchanged; 1 skipped');
    expect(s.out).toContain('  changed   notes (docs/notes.txt): 0 added, 1 changed, 0 unchanged, 0 removed; wrote kb/sources/notes.yaml');
    expect(s.out).toContain('    ~ text');
  });

  it('writes nothing on a dry run, and reports as JSON', async () => {
    const s = scratch();
    expect(await main(['kb:ingest', 'docs/faq.md', '--dry-run', '--json'], s.io)).toBe(0);
    const report = JSON.parse(s.out.join('\n'));
    expect(report.kind).toBe('file');
    expect(report.documents).toEqual([
      {
        id: 'faq',
        file: 'sources/faq.yaml',
        title: 'Frequently asked questions',
        provenance: { file: 'docs/faq.md' },
        status: 'added',
        sections: ['intro', 'borrowing', 'borrowing/how-long-can-i-keep-a-book', 'borrowing/lost-cards', 'borrowing/returns'].map((id) => ({ id, status: 'added' })),
      },
    ]);
    s.out.length = 0;
    expect(await main(['kb:ingest', 'docs/faq.md', '--dry-run'], s.io)).toBe(0);
    expect(s.out[0]).toBe('docs/faq.md: 1 document read into kb/sources: 1 added, 0 changed, 0 unchanged (a dry run: nothing written)');
    expect(s.out[1]).toBe('  added     faq (docs/faq.md): 5 sections; would write kb/sources/faq.yaml');
  });

  it('refuses a command line it does not understand (exit 2) and an input or folder that will not do (exit 1)', async () => {
    const cases: [string[], number, RegExp][] = [
      [['kb:ingest'], 2, /give one folder, file or url/],
      [['kb:ingest', 'a', 'b'], 2, /give one folder, file or url/],
      [['kb:ingest', 'docs', '--depth', '2'], 2, /--depth is for a url only/],
      [['kb:ingest', 'docs', '--include', '*.pdf', '--max-pages', '3'], 2, /--max-pages, --include are for a url only/],
      [['kb:ingest', 'http://h.test/', '--rate', '10'], 2, /--rate must be a whole number, 100 or more/],
      [['kb:ingest', 'http://h.test/', '--depth', 'x'], 2, /--depth must be a whole number, 0 or more/],
      [['kb:ingest', 'docs', '--dir'], 2, /--dir needs a value/],
      [['kb:ingest', 'docs', '--fast'], 2, /--fast is not an option/],
      [['kb:other'], 2, /unknown command kb:other/],
      [['kb:ingest', 'nowhere'], 1, /nowhere is not there/],
      [['kb:ingest', 'docs', '--dir', 'docs'], 1, /is not an app folder/],
    ];
    for (const [args, code, message] of cases) {
      const s = scratch();
      expect([args.join(' '), await main(args, s.io)]).toEqual([args.join(' '), code]);
      expect(s.err.join('\n')).toMatch(message);
    }
  });

  it('names itself in the User-Agent with its version and where it comes from', () => {
    expect(USER_AGENT).toBe(`dialogwright-kb-ingest/${VERSION} (+https://github.com/DialogWright/dialogwright)`);
  });
});

describe('kb:ingest <url>', () => {
  let site: FixtureSite;
  beforeAll(async () => {
    site = await serveSite();
  });
  afterAll(async () => {
    await site.close();
  });

  it('crawls the site and reports what it read, what it did not and why, and its requests', async () => {
    const clock = fakeClock();
    const s = scratch({ fetch: guardedFetch(site.origin).fetch, sleep: clock.sleep, now: clock.now });
    expect(await main(['kb:ingest', `${site.origin}/`, '--depth', '1', '--include', '/about.html', '--include', '*.pdf', '--rate', '2000'], s.io)).toBe(0);
    const at = (line: string) => line.replace(site.origin, 'ORIGIN');
    expect(s.out.map(at)).toEqual([
      'ORIGIN/: 3 documents read into kb/sources: 3 added, 0 changed, 0 unchanged; 9 skipped',
      '  added     index (ORIGIN/): 2 sections; wrote kb/sources/index.yaml',
      '  added     about (ORIGIN/about.html): 2 sections; wrote kb/sources/about.yaml',
      '  added     files-patron-guide (ORIGIN/files/patron-guide.pdf): 6 sections; wrote kb/sources/files-patron-guide.yaml',
      '  skipped   ORIGIN/services/: not matched by --include',
      '  skipped   ORIGIN/events.html: not matched by --include',
      '  skipped   ORIGIN/images/logo.png: not a page or a document',
      '  skipped   http://offsite.invalid/partner.html: off the host',
      '  skipped   ORIGIN/partner: not matched by --include',
      '  skipped   ORIGIN/private/staff.html: not matched by --include',
      '  skipped   ORIGIN/login.html: rel="nofollow"',
      '  skipped   ORIGIN/private/open.html: not matched by --include',
      '  skipped   ORIGIN/services/hours.html: not matched by --include',
      `  4 requests; robots.txt: ${new URL(site.origin).host} read`,
    ]);
    expect(clock.waits).toEqual([2000, 2000, 2000]);
  });
});
