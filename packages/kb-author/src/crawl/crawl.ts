import { extractDocx } from '../extract/docx';
import { extractHtmlDocument, parseHtml, type HtmlDocument } from '../extract/html';
import { extractPdf } from '../extract/pdf';
import type { ExtractedDocument } from '../sections';
import { checkedAddress, NetworkRefusal, publicFetch, type Resolver } from './net';
import { ALLOW_ALL, DISALLOW_ALL, parseRobots, type Robots } from './robots';
import { canonicalUrl, extensionOf, globToRegExp, hostOf, included, neverFetched } from './url';

/**
 * A polite crawler for building a knowledge base from a website. It reads breadth first from a start
 * page to a link depth, and:
 *
 * - stays on the start page's host (and any `allowHosts`); a link elsewhere is listed, never fetched;
 * - reads each host's robots.txt first and fetches nothing it disallows (a robots.txt the server
 *   cannot give, a server error or no answer, disallows the whole host; one that is not there, a 4xx,
 *   allows it); it honors a Crawl-delay up to 30 seconds, and a page's `<meta name="robots">` or
 *   `X-Robots-Tag` noindex and nofollow;
 * - waits `rateMs` between requests to a host (1 second by default), one request at a time;
 * - fetches at most `maxPages` pages and documents (50 by default);
 * - sends a User-Agent that names it and where it comes from, and no cookies, credentials or forms
 *   (fetch keeps no cookie jar; a URL with a user name is never followed);
 * - follows only `<a href>` links to http(s) URLs, canonical (fragment dropped), not rel="nofollow";
 * - fetches pages (HTML) and documents (PDF, DOCX); a link to an image, a stylesheet, an archive or
 *   the like is not fetched, and a response of another type is dropped unread;
 * - follows a redirect (up to 5) only where a link could go: the same host, allowed by robots.txt;
 *   robots.txt's own redirects too, each hop checked (one off the host leaves the host uncrawled);
 * - reads only public addresses (./net.ts): every host is resolved, and refused when it is on a
 *   loopback, private, link-local or other non-public network, unless `allowPrivate`; the connection
 *   goes to the address checked, so a second DNS answer cannot move it;
 * - stops reading a response over `maxBytes` (20 MB) or slower than `timeoutMs` (30 seconds).
 *
 * `include` globs (./url.ts) narrow what is fetched beyond the start page: `/help/**`, `*.pdf`.
 * It never runs in CI or in tests against the network: the tests serve a fixture site locally.
 */

export interface CrawlOptions {
  /** The page to start from (depth 0). */
  start: string;
  /** How many links away from the start page to read: 0 is the start page alone. */
  depth: number;
  /** Globs over URL paths; when given, only matching URLs are fetched beyond the start page. */
  include?: readonly string[];
  /** The most pages and documents fetched. Default 50. */
  maxPages?: number;
  /** The least time between two requests to a host, in milliseconds. Default 1000. */
  rateMs?: number;
  /** Other hosts the crawl may read (host names, with a port when not the default). */
  allowHosts?: readonly string[];
  /** The User-Agent header. */
  userAgent: string;
  /** Read hosts on private networks too (`--allow-private`). Default: public addresses only (./net.ts). */
  allowPrivate?: boolean;
  /** How host names are resolved (a test's resolver). Default: the system's. */
  resolve?: Resolver;
  /**
   * The fetch to use (a test's scripted site). Default: ./net.ts's, which checks and pins each host's
   * address. A fetch given here takes the network's place, and its checks with it.
   */
  fetch?: typeof globalThis.fetch;
  /** Waits (a test's fake clock). Default: a timer. */
  sleep?: (ms: number) => Promise<void>;
  /** The time in milliseconds (a test's fake clock). Default: Date.now. */
  now?: () => number;
  /** The most bytes read of one response. Default 20 MB. */
  maxBytes?: number;
  /** How long one request may take, in milliseconds. Default 30 seconds. */
  timeoutMs?: number;
}

/** A page or document the crawl read. */
export interface CrawledDocument {
  /** Its canonical URL (after any redirect). */
  url: string;
  /** How many links from the start page it was found. */
  depth: number;
  format: 'html' | 'pdf' | 'docx';
  document: ExtractedDocument;
}

/** A URL the crawl did not read, and why. */
export interface CrawlSkip {
  url: string;
  reason: string;
}

/** One request the crawl made. */
export interface CrawlRequest {
  url: string;
  status: number | 'error';
  /** When it was sent (the crawl's clock, milliseconds). */
  at: number;
}

export interface CrawlResult {
  /** What was read, in the order it was fetched. */
  documents: CrawledDocument[];
  /** What was not, in the order it was met, each URL once. */
  skipped: CrawlSkip[];
  /** Every request, robots.txt included, in order. */
  requests: CrawlRequest[];
  /** Each host's robots.txt as read: found, not there, or unreadable (the host then not crawled). */
  robots: { host: string; outcome: 'found' | 'none' | 'unreadable' }[];
}

export class CrawlError extends Error {}

export const DEFAULT_MAX_PAGES = 50;
export const DEFAULT_RATE_MS = 1000;
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
/** The longest Crawl-delay honored, in milliseconds. */
const MAX_CRAWL_DELAY_MS = 30_000;
/** The most of a robots.txt read (RFC 9309 asks for at least 500 KiB). */
const MAX_ROBOTS_BYTES = 512 * 1024;

const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const ACCEPT = `text/html,application/xhtml+xml,application/pdf,${DOCX_TYPE};q=0.9,*/*;q=0.1`;

/** A response's body, or null when it is over `max` bytes (the rest is not read). */
async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel();
    return null;
  }
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** Text in a response's declared charset (UTF-8 when it declares none, or one not known). */
function decode(bytes: Uint8Array, contentType: string): string {
  const charset = /charset\s*=\s*"?([^";\s]+)/i.exec(contentType)?.[1];
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** The robots directives of a page (its meta tags) or a response (X-Robots-Tag). */
function robotsDirectives(values: readonly string[]): { noindex: boolean; nofollow: boolean } {
  const words = values.flatMap((v) => v.toLowerCase().split(/[\s,]+/));
  return { noindex: words.includes('noindex') || words.includes('none'), nofollow: words.includes('nofollow') || words.includes('none') };
}

/** The `<a href>` links of a page, resolved against its base, with whether each is rel="nofollow". */
function linksOf(doc: HtmlDocument, pageUrl: string): { url: string | undefined; nofollow: boolean }[] {
  const baseHref = doc.querySelector('base[href]')?.getAttribute('href');
  const base = (baseHref && canonicalUrl(baseHref, pageUrl)) || pageUrl;
  return [...doc.querySelectorAll('a[href]')].map((a) => ({
    url: canonicalUrl(a.getAttribute('href') ?? '', base),
    nofollow: (a.getAttribute('rel') ?? '').toLowerCase().split(/\s+/).includes('nofollow'),
  }));
}

/** The format of a response, by its type (and its extension when the type says only "bytes"). */
function formatOf(contentType: string, url: string): CrawledDocument['format'] | undefined {
  const mime = contentType.split(';')[0]!.trim().toLowerCase();
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html';
  if (mime === 'application/pdf') return 'pdf';
  if (mime === DOCX_TYPE) return 'docx';
  if (mime === 'application/octet-stream' || mime === '') {
    const ext = extensionOf(url);
    if (ext === 'pdf') return 'pdf';
    if (ext === 'docx') return 'docx';
  }
  return undefined;
}

/** Crawls a site (see the file's comment). */
export async function crawl(options: CrawlOptions): Promise<CrawlResult> {
  const start = canonicalUrl(options.start);
  if (start === undefined) throw new CrawlError(`${options.start} is not an http or https URL`);
  if (!Number.isInteger(options.depth) || options.depth < 0) throw new CrawlError('the depth must be a whole number, 0 or more');
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const rateMs = options.rateMs ?? DEFAULT_RATE_MS;
  const net = { ...(options.allowPrivate ? { allowPrivate: true } : {}), ...(options.resolve ? { resolve: options.resolve } : {}) };
  const doFetch = options.fetch ?? publicFetch(net);
  if (!options.fetch) {
    // The start is checked before anything is asked of it: a private address is refused up front.
    try {
      await checkedAddress(new URL(start).hostname.replace(/^\[(.*)\]$/, '$1'), net);
    } catch (error) {
      if (error instanceof NetworkRefusal) throw new CrawlError(`${start} is not crawled: ${error.message}`);
      throw error;
    }
  }
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const globs = (options.include ?? []).map(globToRegExp);
  const hosts = new Set([hostOf(start), ...(options.allowHosts ?? []).map((h) => h.toLowerCase())]);
  const headers = { 'user-agent': options.userAgent, accept: ACCEPT };

  const result: CrawlResult = { documents: [], skipped: [], requests: [], robots: [] };
  const seen = new Set<string>([start]);
  const skippedUrls = new Set<string>();
  const skip = (url: string, reason: string): void => {
    if (skippedUrls.has(url)) return;
    skippedUrls.add(url);
    result.skipped.push({ url, reason });
  };

  // One request at a time; to each host, no sooner than the rate (or its Crawl-delay) after the last.
  const lastAt = new Map<string, number>();
  const robotsByHost = new Map<string, Robots>();
  const pace = async (host: string): Promise<void> => {
    const delay = robotsByHost.get(host)?.crawlDelay;
    const interval = Math.max(rateMs, delay === undefined ? 0 : Math.min(delay * 1000, MAX_CRAWL_DELAY_MS));
    const last = lastAt.get(host);
    if (last !== undefined) {
      const wait = last + interval - now();
      if (wait > 0) await sleep(wait);
    }
    lastAt.set(host, now());
  };
  const request = async (url: string, redirect: RequestRedirect): Promise<Response | null> => {
    await pace(hostOf(url));
    const at = now();
    try {
      const res = await doFetch(url, { redirect, headers, signal: AbortSignal.timeout(timeoutMs) });
      result.requests.push({ url, status: res.status, at });
      return res;
    } catch (error) {
      result.requests.push({ url, status: 'error', at });
      skip(url, `could not be fetched (${error instanceof Error ? error.message : String(error)})`);
      return null;
    }
  };
  const robotsFor = async (url: string): Promise<Robots> => {
    const host = hostOf(url);
    const known = robotsByHost.get(host);
    if (known) return known;
    const robotsUrl = new URL('/robots.txt', url).href;
    // Its redirects are followed one hop at a time, each checked as a page's are: on the hosts the crawl may read, at most 5.
    let res: Response | null = null;
    for (let hop = 0, at = robotsUrl; ; hop += 1) {
      res = await request(at, 'manual');
      if (!res || res.status < 300 || res.status >= 400 || !res.headers.has('location')) break;
      await res.body?.cancel();
      const next = canonicalUrl(res.headers.get('location')!, at);
      const refused =
        hop + 1 > MAX_REDIRECTS ? `more than ${MAX_REDIRECTS} redirects`
        : next === undefined ? 'redirects to a URL that is not http or https'
        : !hosts.has(hostOf(next)) ? `redirects off the host, to ${next}`
        : null;
      if (refused !== null || next === undefined) {
        skip(robotsUrl, `${refused ?? 'redirects nowhere'}: the host is not crawled`);
        res = null;
        break;
      }
      at = next;
    }
    let robots: Robots;
    let outcome: CrawlResult['robots'][number]['outcome'];
    if (res && res.status >= 200 && res.status < 300) {
      const bytes = await readCapped(res, MAX_ROBOTS_BYTES);
      robots = bytes ? parseRobots(new TextDecoder('utf-8').decode(bytes)) : DISALLOW_ALL;
      outcome = bytes ? 'found' : 'unreadable';
    } else if (res && res.status >= 400 && res.status < 500) {
      await res.body?.cancel();
      robots = ALLOW_ALL;
      outcome = 'none';
    } else {
      await res?.body?.cancel();
      robots = DISALLOW_ALL;
      outcome = 'unreadable';
    }
    robotsByHost.set(host, robots);
    result.robots.push({ host, outcome });
    return robots;
  };
  const allowedByRobots = async (url: string): Promise<boolean> => {
    const u = new URL(url);
    return (await robotsFor(url)).allows(u.pathname + u.search);
  };

  const queue: { url: string; depth: number }[] = [{ url: start, depth: 0 }];
  let fetched = 0;
  while (queue.length > 0) {
    const item = queue.shift()!;
    if (fetched >= maxPages) {
      skip(item.url, `over the page cap (${maxPages})`);
      continue;
    }
    if (!(await allowedByRobots(item.url))) {
      skip(item.url, 'disallowed by robots.txt');
      continue;
    }
    fetched += 1;

    // Fetch, following redirects only where a link could go.
    let url = item.url;
    let res: Response | null = null;
    for (let hop = 0; ; hop += 1) {
      res = await request(url, 'manual');
      if (!res || res.status < 300 || res.status >= 400 || !res.headers.has('location')) break;
      await res.body?.cancel();
      const next = canonicalUrl(res.headers.get('location')!, url);
      const refused =
        hop + 1 > MAX_REDIRECTS ? `more than ${MAX_REDIRECTS} redirects`
        : next === undefined ? 'redirects to a URL that is not http or https'
        : !hosts.has(hostOf(next)) ? `redirects off the host, to ${next}`
        : next !== url && seen.has(next) ? `redirects to ${next}, read on its own`
        : !(await allowedByRobots(next)) ? `redirects to ${next}, disallowed by robots.txt`
        : null;
      if (refused !== null || next === undefined) {
        skip(item.url, refused ?? 'redirects nowhere');
        res = null;
        break;
      }
      seen.add(next);
      url = next;
    }
    if (!res) continue;
    if (res.status < 200 || res.status >= 300) {
      await res.body?.cancel();
      skip(url, `HTTP ${res.status}`);
      continue;
    }
    const contentType = res.headers.get('content-type') ?? '';
    const format = formatOf(contentType, url);
    if (!format) {
      await res.body?.cancel();
      skip(url, `not a page or a document (${contentType.split(';')[0]!.trim() || 'no type'})`);
      continue;
    }
    const header = robotsDirectives(res.headers.get('x-robots-tag') ? [res.headers.get('x-robots-tag')!] : []);
    const bytes = await readCapped(res, maxBytes);
    if (!bytes) {
      skip(url, `over ${maxBytes} bytes`);
      continue;
    }

    try {
      if (format !== 'html') {
        if (header.noindex) skip(url, 'noindex');
        else result.documents.push({ url, depth: item.depth, format, document: format === 'pdf' ? await extractPdf(bytes) : await extractDocx(bytes) });
        continue;
      }
      const doc = parseHtml(decode(bytes, contentType));
      const meta = robotsDirectives([...doc.querySelectorAll('meta[name]')].filter((m) => /^(robots|dialogwright-kb)$/i.test(m.getAttribute('name') ?? '')).map((m) => m.getAttribute('content') ?? ''));
      const noindex = header.noindex || meta.noindex;
      const nofollow = header.nofollow || meta.nofollow;
      if (!nofollow) {
        for (const link of linksOf(doc, url)) {
          if (link.url === undefined || seen.has(link.url)) continue;
          if (link.nofollow) skip(link.url, 'rel="nofollow"');
          else if (!hosts.has(hostOf(link.url))) skip(link.url, 'off the host');
          else if (neverFetched(link.url)) skip(link.url, 'not a page or a document');
          else if (!included(link.url, globs)) skip(link.url, 'not matched by --include');
          else if (item.depth + 1 > options.depth) skip(link.url, `beyond depth ${options.depth}`);
          else {
            seen.add(link.url);
            queue.push({ url: link.url, depth: item.depth + 1 });
          }
        }
      }
      if (noindex) skip(url, 'noindex');
      else {
        const { from: _from, ...document } = extractHtmlDocument(doc);
        result.documents.push({ url, depth: item.depth, format, document });
      }
    } catch (error) {
      skip(url, `could not be read (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return result;
}
