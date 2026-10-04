import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeClock, guardedFetch, serveSite, type FixtureSite } from '../__fixtures__/server';
import { crawl, CrawlError, type CrawlOptions } from './crawl';

const UA = 'dialogwright-kb-ingest/0.0.0 (+https://github.com/DialogWright/dialogwright)';

let site: FixtureSite;
beforeAll(async () => {
  site = await serveSite();
});
afterAll(async () => {
  await site.close();
});

/** A crawl of the fixture site with a fake clock and a fetch that refuses any other host. */
async function crawlSite(options: Partial<CrawlOptions> = {}) {
  const clock = fakeClock();
  const guard = guardedFetch(site.origin);
  const from = site.requests.length;
  const result = await crawl({ start: `${site.origin}/`, depth: 2, userAgent: UA, fetch: guard.fetch, sleep: clock.sleep, now: clock.now, ...options });
  const paths = (urls: readonly string[]) => urls.map((u) => u.replace(site.origin, ''));
  return { result, clock, asked: guard.asked, served: site.requests.slice(from), docs: paths(result.documents.map((d) => d.url)), paths };
}

describe('crawling the fixture site', () => {
  it('reads breadth first to the depth, pages and linked documents, each once though the links go round', async () => {
    const { result, docs, asked, served } = await crawlSite();
    expect(docs).toEqual(['/', '/about.html', '/services/', '/events.html', '/files/patron-guide.pdf', '/private/open.html', '/services/hours.html', '/files/volunteer-handbook.docx']);
    expect(result.documents.map((d) => [d.format, d.depth])).toEqual([
      ['html', 0], ['html', 1], ['html', 1], ['html', 1], ['pdf', 1], ['html', 2], ['html', 2], ['docx', 2],
    ]);
    // Every URL asked for once (the cycle back home, the nav on every page).
    expect(new Set(asked).size).toBe(asked.length);
    expect(asked[0]).toBe(`${site.origin}/robots.txt`);
    // The extracted text is there, with its sections.
    const home = result.documents[0]!.document;
    expect(home.title).toBe('Welcome to the Example Town Library');
    expect(home.sections.map((s) => s.id)).toEqual(['intro', 'visit-us']);
    expect(result.documents[4]!.document.sections.map((s) => s.id)).toContain('late-fees');
    expect(result.documents[7]!.document.title).toBe('Example Town Library Volunteer Handbook');
    // A clear User-Agent on every request, and no cookie sent back though the server sets one.
    expect(served.every((r) => r.userAgent === UA)).toBe(true);
    expect(served.every((r) => r.cookie === undefined)).toBe(true);
    expect(result.robots).toEqual([{ host: new URL(site.origin).host, outcome: 'found' }]);
  });

  it('stays on the host, follows robots.txt, rel="nofollow", noindex and only pages and documents, and says why', async () => {
    const { result, asked, paths } = await crawlSite();
    const skipped = Object.fromEntries(result.skipped.map((s) => [s.url.replace(site.origin, ''), s.reason]));
    expect(skipped).toMatchObject({
      '/images/logo.png': 'not a page or a document',
      'http://offsite.invalid/partner.html': 'off the host',
      '/partner': 'redirects off the host, to http://offsite.invalid/partner.html',
      '/private/staff.html': 'disallowed by robots.txt',
      '/login.html': 'rel="nofollow"',
      '/draft.html': 'noindex',
      '/services/deep.html': 'beyond depth 2',
    });
    expect(paths(asked)).not.toContain('/private/staff.html');
    expect(asked.some((u) => u.includes('offsite.invalid'))).toBe(false);
    expect(paths(asked)).not.toContain('/services/deep.html');
    // A noindex page is read for its links, not kept.
    expect(paths(asked)).toContain('/draft.html');
    expect(paths(result.documents.map((d) => d.url))).not.toContain('/draft.html');
  });

  it('reads only the start page at depth 0', async () => {
    const { docs, asked, paths } = await crawlSite({ depth: 0 });
    expect(docs).toEqual(['/']);
    expect(paths(asked)).toEqual(['/robots.txt', '/']);
  });

  it('stops at the page cap', async () => {
    const { result, docs } = await crawlSite({ maxPages: 3 });
    expect(docs).toEqual(['/', '/about.html', '/services/']);
    expect(result.requests.filter((r) => !r.url.endsWith('/robots.txt'))).toHaveLength(3);
    expect(result.skipped.filter((s) => s.reason === 'over the page cap (3)').map((s) => s.url.replace(site.origin, ''))).toEqual([
      '/events.html', '/files/patron-guide.pdf', '/partner', '/private/staff.html', '/private/open.html', '/services/hours.html', '/files/volunteer-handbook.docx',
    ]);
  });

  it('fetches only what --include matches beyond the start page', async () => {
    const { docs, result } = await crawlSite({ include: ['*.pdf', '/services/**'] });
    expect(docs).toEqual(['/', '/services/', '/files/patron-guide.pdf', '/services/hours.html']);
    expect(result.skipped.find((s) => s.url.endsWith('/about.html'))?.reason).toBe('not matched by --include');
  });

  it('waits the rate between requests to the host, on its clock', async () => {
    const { result, clock } = await crawlSite({ rateMs: 1000 });
    const times = result.requests.map((r) => r.at);
    expect(times[0]).toBe(0);
    for (let i = 1; i < times.length; i += 1) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(1000);
    expect(clock.waits.length).toBe(result.requests.length - 1);
    const slow = await crawlSite({ rateMs: 2500, depth: 0 });
    expect(slow.result.requests.map((r) => r.at)).toEqual([0, 2500]);
  });

  it('refuses a start that is not an http(s) URL, and a bad depth', async () => {
    await expect(crawl({ start: 'ftp://h.test/', depth: 1, userAgent: UA })).rejects.toThrow(CrawlError);
    await expect(crawl({ start: 'http://h.test/', depth: -1, userAgent: UA })).rejects.toThrow(CrawlError);
  });
});

describe('the crawler with a scripted server', () => {
  /** A fetch answering from a table by path; anything else is a 404. Records what was asked. */
  function scripted(table: Record<string, () => Response>) {
    const asked: string[] = [];
    const fetch: typeof globalThis.fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      asked.push(url);
      const answer = table[new URL(url).pathname];
      return answer ? answer() : new Response('not found', { status: 404 });
    };
    return { fetch, asked };
  }
  const html = (body: string, headers: Record<string, string> = {}) => () => new Response(`<html><body><main>${body}</main></body></html>`, { headers: { 'content-type': 'text/html', ...headers } });
  const run = (fetch: typeof globalThis.fetch, options: Partial<CrawlOptions> = {}) => {
    const clock = fakeClock();
    return crawl({ start: 'http://h.test/', depth: 3, userAgent: UA, fetch, sleep: clock.sleep, now: clock.now, ...options }).then((result) => ({ result, clock }));
  };

  it('crawls nothing on a host whose robots.txt the server cannot give', async () => {
    const s = scripted({ '/robots.txt': () => new Response('down', { status: 503 }), '/': html('<p>Home.</p>') });
    const { result } = await run(s.fetch);
    expect(s.asked).toEqual(['http://h.test/robots.txt']);
    expect(result.documents).toEqual([]);
    expect(result.robots).toEqual([{ host: 'h.test', outcome: 'unreadable' }]);
    expect(result.skipped).toEqual([{ url: 'http://h.test/', reason: 'disallowed by robots.txt' }]);
  });

  it('crawls everything when there is no robots.txt, and honors a Crawl-delay over the rate', async () => {
    const none = scripted({ '/': html('<p>Home.</p>') });
    expect((await run(none.fetch)).result.robots).toEqual([{ host: 'h.test', outcome: 'none' }]);
    const delayed = scripted({ '/robots.txt': () => new Response('User-agent: *\nCrawl-delay: 5\n'), '/': html('<p><a href="/a.html">a</a></p>'), '/a.html': html('<p>A.</p>') });
    const { result } = await run(delayed.fetch, { rateMs: 1000 });
    expect(result.requests.map((r) => r.at)).toEqual([0, 5000, 10000]);
  });

  it('honors X-Robots-Tag and meta nofollow', async () => {
    const s = scripted({
      '/': html('<p><a href="/a.html">a</a> <a href="/b.html">b</a></p>'),
      '/a.html': html('<p>A. <a href="/c.html">c</a></p>', { 'x-robots-tag': 'noindex, nofollow' }),
      '/b.html': () => new Response('<html><head><meta name="robots" content="nofollow"></head><body><p>B. <a href="/d.html">d</a></p></body></html>', { headers: { 'content-type': 'text/html' } }),
    });
    const { result } = await run(s.fetch);
    expect(result.documents.map((d) => d.url)).toEqual(['http://h.test/', 'http://h.test/b.html']);
    expect(s.asked).not.toContain('http://h.test/c.html');
    expect(s.asked).not.toContain('http://h.test/d.html');
  });

  it('follows a redirect on the host, records where it landed, and refuses a loop', async () => {
    const s = scripted({
      '/': html('<p><a href="/old">old</a> <a href="/loop">loop</a></p>'),
      '/old': () => new Response(null, { status: 301, headers: { location: '/new.html' } }),
      '/new.html': html('<p>New.</p>'),
      '/loop': () => new Response(null, { status: 302, headers: { location: '/loop' } }),
    });
    const { result } = await run(s.fetch);
    expect(result.documents.map((d) => d.url)).toEqual(['http://h.test/', 'http://h.test/new.html']);
    expect(result.skipped.find((sk) => sk.url === 'http://h.test/loop')?.reason).toBe('more than 5 redirects');
  });

  it('drops a response of another type unread, one over the size limit, and an error status', async () => {
    const s = scripted({
      '/': html('<p><a href="/feed">feed</a> <a href="/big.html">big</a> <a href="/gone.html">gone</a></p>'),
      '/feed': () => new Response('{}', { headers: { 'content-type': 'application/json' } }),
      '/big.html': () => new Response('x'.repeat(2000), { headers: { 'content-type': 'text/html' } }),
    });
    const { result } = await run(s.fetch, { maxBytes: 1000 });
    expect(result.skipped).toEqual([
      { url: 'http://h.test/feed', reason: 'not a page or a document (application/json)' },
      { url: 'http://h.test/big.html', reason: 'over 1000 bytes' },
      { url: 'http://h.test/gone.html', reason: 'HTTP 404' },
    ]);
  });

  it('reads a page in its declared charset', async () => {
    const latin1 = new Uint8Array([...new TextEncoder().encode('<html><body><main><p>Caf'), 0xe9, ...new TextEncoder().encode('.</p></main></body></html>')]);
    const s = scripted({ '/': () => new Response(latin1, { headers: { 'content-type': 'text/html; charset=iso-8859-1' } }) });
    const { result } = await run(s.fetch);
    expect(result.documents[0]!.document.sections[0]!.text).toBe('Café.');
  });

  it('reads another host only when allowed', async () => {
    const s = scripted({ '/': html('<p><a href="http://docs.h.test/guide.html">guide</a></p>'), '/guide.html': html('<p>Guide.</p>') });
    const off = await run(s.fetch);
    expect(off.result.skipped).toEqual([{ url: 'http://docs.h.test/guide.html', reason: 'off the host' }]);
    const on = await run(s.fetch, { allowHosts: ['docs.h.test'] });
    expect(on.result.documents.map((d) => d.url)).toEqual(['http://h.test/', 'http://docs.h.test/guide.html']);
    expect(on.result.robots.map((r) => r.host)).toEqual(['h.test', 'docs.h.test']);
  });
});
