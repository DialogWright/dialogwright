import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeClock, guardedFetch, serveSite, type FixtureSite } from '../__fixtures__/server';
import { crawl, CrawlError, type CrawlOptions } from './crawl';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { NetworkRefusal, pinnedLookup, privateAddressKind, publicFetch } from './net';

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

describe('the crawler stays off private networks', () => {
  /** A fetch that records each URL and passes it to the network (only the tests' own servers on 127.0.0.1). */
  function recording() {
    const asked: string[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      asked.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      return globalThis.fetch(input, init);
    };
    return { fetch, asked };
  }

  it('follows robots.txt\'s redirects one hop at a time, and never off the host', async () => {
    const other = await serveSite();
    const redirecting = await serveSite({ '/robots.txt': { status: 302, headers: { location: `${other.origin}/latest/meta-data/` } } });
    try {
      const r = recording();
      const clock = fakeClock();
      const result = await crawl({ start: `${redirecting.origin}/`, depth: 0, userAgent: UA, fetch: r.fetch, sleep: clock.sleep, now: clock.now });
      expect(other.requests).toEqual([]);
      expect(r.asked).toEqual([`${redirecting.origin}/robots.txt`]);
      expect(result.robots).toEqual([{ host: new URL(redirecting.origin).host, outcome: 'unreadable' }]);
      expect(result.skipped).toEqual([
        { url: `${redirecting.origin}/robots.txt`, reason: `redirects off the host, to ${other.origin}/latest/meta-data/: the host is not crawled` },
        { url: `${redirecting.origin}/`, reason: 'disallowed by robots.txt' },
      ]);
      expect(result.documents).toEqual([]);
    } finally {
      await other.close();
      await redirecting.close();
    }
  });

  it('follows a robots.txt redirect on the host', async () => {
    const moved = await serveSite({ '/robots.txt': { status: 301, headers: { location: '/site-robots.txt' } }, '/site-robots.txt': { status: 200, headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nDisallow: /\n' } });
    try {
      const clock = fakeClock();
      const result = await crawl({ start: `${moved.origin}/`, depth: 0, userAgent: UA, fetch: guardedFetch(moved.origin).fetch, sleep: clock.sleep, now: clock.now });
      expect(result.robots).toEqual([{ host: new URL(moved.origin).host, outcome: 'found' }]);
      expect(result.skipped).toEqual([{ url: `${moved.origin}/`, reason: 'disallowed by robots.txt' }]);
    } finally {
      await moved.close();
    }
  });

  it('refuses a start on 127.0.0.1 without --allow-private, asking it nothing', async () => {
    const from = site.requests.length;
    await expect(crawl({ start: `${site.origin}/`, depth: 0, userAgent: UA })).rejects.toThrow(
      new CrawlError(`${site.origin}/ is not crawled: 127.0.0.1 is not a public address (loopback): the crawler reads only public addresses (--allow-private reads a private network)`),
    );
    await expect(crawl({ start: 'http://[::ffff:7f00:1]/', depth: 0, userAgent: UA })).rejects.toThrow('::ffff:7f00:1 is not a public address (loopback, in an IPv6 address)');
    await expect(crawl({ start: 'http://169.254.169.254/latest/meta-data/', depth: 0, userAgent: UA })).rejects.toThrow('169.254.169.254 is not a public address (link-local, where cloud metadata services answer)');
    expect(site.requests.length).toBe(from);
  });

  it('reads the fixture site with --allow-private, through its own fetch', async () => {
    const clock = fakeClock();
    const from = site.requests.length;
    const result = await crawl({ start: `${site.origin}/`, depth: 0, userAgent: UA, allowPrivate: true, sleep: clock.sleep, now: clock.now });
    expect(result.documents.map((d) => d.url)).toEqual([`${site.origin}/`]);
    expect(site.requests.slice(from).map((r) => r.path)).toEqual(['/robots.txt', '/']);
  });

  it('refuses a host name that resolves to a private address, whichever of its addresses it is', async () => {
    const resolve = async (host: string) => (host === 'intranet.test' ? [{ address: '10.1.2.3', family: 4 }] : [{ address: '203.0.113.7', family: 4 }, { address: 'fd00::7', family: 6 }]);
    await expect(crawl({ start: 'http://intranet.test/', depth: 0, userAgent: UA, resolve })).rejects.toThrow('intranet.test is at 10.1.2.3, which is not a public address (private, RFC 1918)');
    await expect(crawl({ start: 'http://mixed.test/', depth: 0, userAgent: UA, resolve })).rejects.toThrow('mixed.test is at fd00::7, which is not a public address (unique local, fc00::/7)');
  });

  it('checks every request, not only the start: a link, a redirect or another allowed host is refused before it is sent', async () => {
    // Every request the crawl makes goes through this fetch; it resolves and checks before it connects.
    const resolve = async (host: string) => [{ address: host === 'internal.test' ? '192.168.0.10' : '203.0.113.7', family: 4 }];
    const fetchIt = publicFetch({ resolve });
    await expect(fetchIt('http://internal.test/admin')).rejects.toThrow(new NetworkRefusal('internal.test is at 192.168.0.10, which is not a public address (private, RFC 1918): the crawler reads only public addresses (--allow-private reads a private network)'));
    await expect(fetchIt(`${site.origin}/`)).rejects.toThrow(NetworkRefusal);
    await expect(fetchIt('http://[fe80::1]/')).rejects.toThrow('fe80::1 is not a public address (link-local)');
    await expect(publicFetch({ resolve: async () => [] })('http://nowhere.test/')).rejects.toThrow('nowhere.test does not resolve');
  });

  it('connects to the address it checked: the name is not looked up again (no rebinding)', async () => {
    const port = new URL(site.origin).port;
    const answers: string[] = [];
    // The first answer is the fixture server; any later one would be an address where nothing listens.
    const resolve = async (host: string) => {
      answers.push(host);
      return [{ address: answers.length === 1 ? '127.0.0.1' : '127.0.0.2', family: 4 }];
    };
    const res = await publicFetch({ allowPrivate: true, resolve })(`http://rebind.test:${port}/about.html`, { headers: { 'user-agent': UA } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('About');
    expect(answers).toEqual(['rebind.test']);
    // The socket's lookup answers with the checked address whatever it is asked.
    const lookup = pinnedLookup('203.0.113.9', 4) as unknown as (h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => void;
    const got: unknown[][] = [];
    lookup('rebind.test', {}, (...a) => got.push(a));
    lookup('anything.else', { all: true }, (...a) => got.push(a));
    expect(got).toEqual([[null, '203.0.113.9', 4], [null, [{ address: '203.0.113.9', family: 4 }]]]);
  });

  it('reads a compressed answer, decoded, though it asks for none', async () => {
    const page = '<html><body><main><p>Compressed hello.</p></main></body></html>';
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
      res.end(gzipSync(page));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const res = await publicFetch({ allowPrivate: true })(`http://127.0.0.1:${(server.address() as AddressInfo).port}/z.html`);
      expect(await res.text()).toBe(page);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('knows which addresses are not public', () => {
    const kinds = Object.fromEntries(
      [
        '127.0.0.1', '10.0.0.1', '172.16.5.4', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '100.127.255.255', '0.0.0.0', '224.0.0.1', '255.255.255.255',
        '::', '::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '::ffff:10.0.0.1', '64:ff9b::a00:1', '2002:c0a8:101::1', 'ff02::1',
        '8.8.8.8', '93.184.216.34', '100.128.0.1', '172.32.0.1', '2606:4700::1111', '::ffff:8.8.8.8', '2002:808:808::1',
      ].map((a) => [a, privateAddressKind(a)]),
    );
    expect(kinds).toEqual({
      '127.0.0.1': 'loopback',
      '10.0.0.1': 'private, RFC 1918',
      '172.16.5.4': 'private, RFC 1918',
      '172.31.255.255': 'private, RFC 1918',
      '192.168.1.1': 'private, RFC 1918',
      '169.254.169.254': 'link-local, where cloud metadata services answer',
      '100.64.0.1': 'shared, carrier-grade NAT',
      '100.127.255.255': 'shared, carrier-grade NAT',
      '0.0.0.0': 'unspecified, "this network"',
      '224.0.0.1': 'multicast',
      '255.255.255.255': 'reserved or broadcast',
      '::': 'unspecified',
      '::1': 'loopback',
      'fe80::1': 'link-local',
      'fc00::1': 'unique local, fc00::/7',
      'fd12:3456::1': 'unique local, fc00::/7',
      '::ffff:127.0.0.1': 'loopback, in an IPv6 address',
      '::ffff:7f00:1': 'loopback, in an IPv6 address',
      '::ffff:a9fe:a9fe': 'link-local, where cloud metadata services answer, in an IPv6 address',
      '::ffff:10.0.0.1': 'private, RFC 1918, in an IPv6 address',
      '64:ff9b::a00:1': 'private, RFC 1918, in an IPv6 address',
      '2002:c0a8:101::1': 'private, RFC 1918, in an IPv6 address',
      'ff02::1': 'multicast',
      '8.8.8.8': null,
      '93.184.216.34': null,
      '100.128.0.1': null,
      '172.32.0.1': null,
      '2606:4700::1111': null,
      '::ffff:8.8.8.8': null,
      '2002:808:808::1': null,
    });
  });
});
