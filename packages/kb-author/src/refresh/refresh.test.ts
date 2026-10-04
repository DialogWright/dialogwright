import { mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeClock, guardedFetch, serveSite, type FixtureSite } from '../__fixtures__/server';
import { ingest } from '../ingest';
import { findKb } from '../kbPlace';
import { main, type Io } from '../cli';
import { refreshKb } from './refresh';

/** An app folder with an empty knowledge base, beside a folder outside it with a secret in it. */
function appWithOutside(): { root: string; app: string } {
  const root = mkdtempSync(join(tmpdir(), 'kb-author-refresh-bounds-'));
  const app = join(root, 'app');
  mkdirSync(join(app, 'kb', 'sources'), { recursive: true });
  mkdirSync(join(root, 'outside'));
  writeFileSync(join(root, 'outside', 'secret.md'), '# Secret\n\nThe staging password is not for callers.\n');
  writeFileSync(join(app, 'app.yaml'), 'id: demo\n');
  writeFileSync(join(app, 'kb', 'kb.yaml'), 'action: findPassage\n');
  writeFileSync(join(app, 'kb', 'topics.yaml'), '{}\n');
  return { root, app };
}

const sourceWith = (provenance: string): string => `document: A source\nprovenance:\n${provenance}  retrieved: 2026-10-03\nsections:\n  text:\n    text: Something said.\n`;

describe('what a refresh reads', () => {
  it('reads a file only inside the app folder: not ../, an absolute path, a link out of it, or a folder', async () => {
    const { root, app } = appWithOutside();
    symlinkSync(join(root, 'outside', 'secret.md'), join(app, 'linked.md'));
    const sources = join(app, 'kb', 'sources');
    writeFileSync(join(sources, 'up.yaml'), sourceWith('  file: ../outside/secret.md\n'));
    writeFileSync(join(sources, 'absolute.yaml'), sourceWith(`  file: ${join(root, 'outside', 'secret.md')}\n`));
    writeFileSync(join(sources, 'linked.yaml'), sourceWith('  file: linked.md\n'));
    writeFileSync(join(sources, 'folder.yaml'), sourceWith('  file: kb\n'));
    const before = Object.fromEntries(readdirSync(sources).map((f) => [f, readFileSync(join(sources, f), 'utf8')]));
    const place = findKb(app, 'app');
    if (typeof place === 'string') throw new Error(place);
    const report = await refreshKb({ place, today: '2026-11-01', crawl: { userAgent: 'dialogwright-kb-ingest/test' } });
    expect(report.runs.map((r) => [r.input, r.error])).toEqual([
      [join(root, 'outside', 'secret.md'), `absolute's provenance names ${join(root, 'outside', 'secret.md')}, which is outside the app folder: only a file inside the app folder is read again (the source is left as it is)`],
      ['kb', "folder's provenance names kb, which is not a file: only a file inside the app folder is read again (the source is left as it is)"],
      ['linked.md', "linked's provenance names linked.md, which is outside the app folder: only a file inside the app folder is read again (the source is left as it is)"],
      ['../outside/secret.md', "up's provenance names ../outside/secret.md, which is outside the app folder: only a file inside the app folder is read again (the source is left as it is)"],
    ]);
    // Nothing outside was read into the knowledge base, and no source changed.
    expect(Object.fromEntries(readdirSync(sources).map((f) => [f, readFileSync(join(sources, f), 'utf8')]))).toEqual(before);
    expect(JSON.stringify(report)).not.toContain('staging password');
  });

  it('refuses a provenance URL on a private network, or one that is not http(s), and says the hosts before it asks any', async () => {
    const { app } = appWithOutside();
    const sources = join(app, 'kb', 'sources');
    writeFileSync(join(sources, 'local.yaml'), sourceWith('  url: http://127.0.0.1:9/admin\n'));
    writeFileSync(join(sources, 'metadata.yaml'), sourceWith('  url: http://169.254.169.254/latest/meta-data/\n  crawl:\n    start: http://169.254.169.254/\n    depth: 1\n'));
    writeFileSync(join(sources, 'internal.yaml'), sourceWith('  url: http://wiki.internal.test/page\n'));
    writeFileSync(join(sources, 'sneaky.yaml'), sourceWith('  url: ../outside/secret.md\n'));
    const place = findKb(app, 'app');
    if (typeof place === 'string') throw new Error(place);
    const said: string[] = [];
    const resolve = async () => [{ address: '192.168.4.20', family: 4 }];
    const report = await refreshKb({ place, today: '2026-11-01', crawl: { userAgent: 'dialogwright-kb-ingest/test', resolve }, onHosts: (h) => said.push(`hosts: ${h.join(', ')}`) });
    expect(said).toEqual(['hosts: 127.0.0.1:9, 169.254.169.254, wiki.internal.test']);
    expect(report.hosts).toEqual(['127.0.0.1:9', '169.254.169.254', 'wiki.internal.test']);
    expect(report.runs.map((r) => [r.input, r.error])).toEqual([
      ['../outside/secret.md', "sneaky's provenance names ../outside/secret.md, which is not an http or https URL: it is not read (the source is left as it is)"],
      ['http://169.254.169.254/', 'http://169.254.169.254/ is not crawled: 169.254.169.254 is not a public address (link-local, where cloud metadata services answer): the crawler reads only public addresses (--allow-private reads a private network)'],
      ['http://127.0.0.1:9/admin', 'http://127.0.0.1:9/admin is not crawled: 127.0.0.1 is not a public address (loopback): the crawler reads only public addresses (--allow-private reads a private network)'],
      ['http://wiki.internal.test/page', 'http://wiki.internal.test/page is not crawled: wiki.internal.test is at 192.168.4.20, which is not a public address (private, RFC 1918): the crawler reads only public addresses (--allow-private reads a private network)'],
    ]);
    expect(report.runs.every((r) => r.documents.length === 0)).toBe(true);
  });

  it('kb:refresh prints the hosts before it asks them, and takes --allow-private', async () => {
    const { app } = appWithOutside();
    writeFileSync(join(app, 'kb', 'sources', 'local.yaml'), sourceWith('  url: http://127.0.0.1:9/admin\n'));
    const out: string[] = [];
    const io: Io = { out: (l) => out.push(l), err: (l) => out.push(l), cwd: app, today: () => '2026-11-01' };
    expect(await main(['kb:refresh'], io)).toBe(1);
    expect(out.slice(0, 3)).toEqual([
      'kb:refresh: asking 127.0.0.1:9 (the hosts the sources were read from)',
      'kb:refresh kb: 1 read (0 documents): 0 added, 0 changed, 0 unchanged',
      '  failed    http://127.0.0.1:9/admin: http://127.0.0.1:9/admin is not crawled: 127.0.0.1 is not a public address (loopback): the crawler reads only public addresses (--allow-private reads a private network)',
    ]);
    // With --allow-private it is asked (and here nothing answers: the robots.txt cannot be fetched, so the page is not read).
    out.length = 0;
    const clock = fakeClock();
    expect(await main(['kb:refresh', '--allow-private', '--dry-run'], { ...io, sleep: clock.sleep, now: clock.now })).toBe(0);
    expect(out[0]).toBe('kb:refresh: asking 127.0.0.1:9 (the hosts the sources were read from)');
    expect(out.some((l) => l.startsWith('  skipped   http://127.0.0.1:9/robots.txt: could not be fetched'))).toBe(true);
  });
});

/** A crawled site refreshed with the crawl's own settings, kept in each page's provenance. */

describe('refreshing a crawled site', () => {
  let site: FixtureSite;
  beforeAll(async () => {
    site = await serveSite();
  });
  afterAll(async () => {
    await site.close();
  });

  it('crawls again from the same start with the same depth and globs, and changes nothing when the site has not changed', async () => {
    const app = join(mkdtempSync(join(tmpdir(), 'kb-author-refresh-')), 'app');
    mkdirSync(join(app, 'kb'), { recursive: true });
    writeFileSync(join(app, 'app.yaml'), 'id: demo\n');
    writeFileSync(join(app, 'kb', 'kb.yaml'), 'action: findPassage\n');
    writeFileSync(join(app, 'kb', 'topics.yaml'), '{}\n');
    const crawl = () => {
      const clock = fakeClock();
      const guard = guardedFetch(site.origin);
      return { guard, options: { userAgent: 'dialogwright-kb-ingest/test', fetch: guard.fetch, sleep: clock.sleep, now: clock.now } };
    };
    const first = crawl();
    await ingest({ input: `${site.origin}/`, appDir: app, kbDir: join(app, 'kb'), today: '2026-10-03', crawl: { ...first.options, depth: 1, include: ['/services/**', '/about.html'] } });
    const ids = readdirSync(join(app, 'kb', 'sources')).sort();
    expect(ids).toEqual(['about.yaml', 'index.yaml', 'services.yaml']);
    expect(readFileSync(join(app, 'kb', 'sources', 'about.yaml'), 'utf8')).toContain(`  crawl:\n    start: ${site.origin}/\n    depth: 1\n    include:\n      - /services/**\n      - /about.html\n`);

    const place = findKb(app, 'app');
    if (typeof place === 'string') throw new Error(place);
    const again = crawl();
    const report = await refreshKb({ place, today: '2026-11-01', crawl: again.options });
    // One crawl, with the settings it had: the same pages asked for, in the same order.
    expect(report.runs.map((r) => [r.kind, r.input.replace(site.origin, '')])).toEqual([['crawl', '/']]);
    expect(again.guard.asked).toEqual(first.guard.asked);
    expect(report.runs[0]!.documents.map((d) => [d.id, d.status])).toEqual([
      ['index', 'unchanged'],
      ['about', 'unchanged'],
      ['services', 'unchanged'],
    ]);
    expect(report.notRead).toEqual([]);
    expect(readdirSync(join(app, 'kb', 'sources')).sort()).toEqual(ids);
    expect(readFileSync(join(app, 'kb', 'sources', 'about.yaml'), 'utf8')).toContain('retrieved: 2026-10-03');
  });
});
