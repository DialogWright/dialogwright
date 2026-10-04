import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeClock, guardedFetch, serveSite, type FixtureSite } from '../__fixtures__/server';
import { ingest } from '../ingest';
import { findKb } from '../kbPlace';
import { refreshKb } from './refresh';

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
