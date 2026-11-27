import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The site (site/, published to GitHub Pages by .github/workflows/pages.yml): the landing page, the
 * guides under site/guides/ and the blog under site/blog/ (its posts, its index and its Atom feed). On every page, every link and asset it names exists, every link into the
 * repository on GitHub points at a path the repository has, a link to another page's section finds that
 * section, the excerpts it quotes are still in the files they come from, and the page keeps its basics
 * (a language, a title, a description, a canonical URL, a favicon, the content security policy, no script
 * from another origin). Like wording.test.ts, it is about the repository rather than the engine, so it
 * reads the files from the root.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SITE = join(ROOT, 'site');
const DOMAIN = 'dialogwright.com';
const REPO = 'https://github.com/DialogWright/dialogwright';
const CSP = "default-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'";

/** Every HTML page of the site, as its path under site/ ('index.html', 'guides/scaling.html'). */
function pagesOf(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return pagesOf(path);
    return e.isFile() && e.name.endsWith('.html') ? [relative(SITE, path).split(sep).join('/')] : [];
  });
}

const PAGES = pagesOf(SITE).sort();
const htmlOf = (page: string): string => readFileSync(join(SITE, page), 'utf8');

const decode = (s: string): string =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

/** Every value of an attribute in a page (srcset split into its URLs). */
function attributes(html: string, name: string): string[] {
  return [...html.matchAll(new RegExp(`\\s${name}="([^"]*)"`, 'g'))].flatMap((m) => {
    const value = decode(m[1]!);
    return name === 'srcset' ? value.split(',').map((part) => part.trim().split(/\s+/)[0]!) : [value];
  });
}

const references = (html: string): string[] => [
  ...attributes(html, 'href'),
  ...attributes(html, 'src'),
  ...attributes(html, 'srcset'),
  ...attributes(html, 'content').filter((c) => /^https?:\/\//.test(c)),
];

const isFile = (path: string): boolean => existsSync(path) && statSync(path).isFile();
const isDir = (path: string): boolean => existsSync(path) && statSync(path).isDirectory();

/**
 * The site file a reference from `page` names, as a path under site/ with its anchor, or null for a
 * reference that is not to this site (another origin, mailto:, an in-page anchor).
 */
function siteTarget(page: string, ref: string): { path: string; anchor: string | null } | null {
  if (/^(mailto:|#)/.test(ref)) return null;
  let path: string;
  if (ref.startsWith(`https://${DOMAIN}/`)) path = ref.slice(`https://${DOMAIN}/`.length);
  else if (/^[a-z]+:|^\/\//.test(ref)) return null;
  else path = normalize(join(dirname(page), ref)).split(sep).join('/');
  const anchor = path.includes('#') ? path.slice(path.indexOf('#') + 1) : null;
  path = path.split('#')[0]!.split('?')[0]!;
  if (path === '.' || path === '' || path.endsWith('/')) path = `${path === '.' ? '' : path}index.html`;
  return { path, anchor };
}

/** The anchors GitHub gives a Markdown file's headings. */
function anchorsOf(markdown: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    const m = !fenced && /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const base = m[1]!.toLowerCase().replace(/`/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

describe('the site', () => {
  it('names its domain in CNAME', () => {
    expect(readFileSync(join(SITE, 'CNAME'), 'utf8').trim()).toBe(DOMAIN);
  });

  it('has the landing page and the guides', () => {
    expect(PAGES).toEqual(expect.arrayContaining(['index.html', 'agent-mode.html', 'guides/home-server.html', 'guides/scaling.html', 'blog/index.html']));
  });

  it('has its own title and canonical URL on every page', () => {
    const titles = PAGES.map((page) => /<title>([^<]+)<\/title>/.exec(htmlOf(page))?.[1]?.trim());
    expect(new Set(titles).size).toBe(PAGES.length);
    for (const page of PAGES) {
      const canonical = /<link rel="canonical" href="([^"]+)">/.exec(htmlOf(page))?.[1];
      // A folder's index is canonical as the folder itself (https://dialogwright.com/blog/).
      expect(canonical, page).toBe(`https://${DOMAIN}/${page.endsWith('index.html') ? page.slice(0, -'index.html'.length) : page}`);
    }
  });

  it('links between its pages only to sections they have', () => {
    const wrong: string[] = [];
    for (const page of PAGES) {
      for (const ref of attributes(htmlOf(page), 'href')) {
        const target = siteTarget(page, ref);
        if (!target?.anchor || !target.path.endsWith('.html') || !isFile(join(SITE, target.path))) continue;
        if (!attributes(htmlOf(target.path), 'id').includes(target.anchor)) wrong.push(`${page}: ${ref}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  describe.each(PAGES)('%s', (page) => {
    const html = htmlOf(page);

    it('has a language, a title, a description and a favicon', () => {
      expect(html).toMatch(/<html lang="[a-z]{2}(-[A-Z]{2})?">/);
      expect(/<title>([^<]+)<\/title>/.exec(html)?.[1]?.trim()).toMatch(/^DialogWright/);
      expect(/<meta name="description" content="([^"]{50,})">/.test(html)).toBe(true);
      const icons = [...html.matchAll(/<link rel="icon" href="([^"]+)"/g)].map((m) => m[1]!);
      expect(icons.length).toBeGreaterThan(0);
      for (const icon of icons) expect(isFile(join(SITE, dirname(page), icon)), icon).toBe(true);
    });

    it('carries the content security policy, and nothing it would refuse', () => {
      expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${CSP}">`);
      // default-src 'self' refuses inline styles and handlers: a page that had one would look right
      // only where the policy is not enforced.
      expect(html).not.toMatch(/<style\b/);
      expect(html).not.toMatch(/\sstyle="/);
      expect(html).not.toMatch(/\son[a-z]+="/);
    });

    it('loads no script, stylesheet or font from another origin, and has no inline script', () => {
      const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
      for (const [, attrs, body] of scripts) {
        const src = /\ssrc="([^"]*)"/.exec(attrs!)?.[1];
        expect(src, `a script tag with no src: ${attrs}`).toBeDefined();
        expect(src, `a script from another origin: ${src}`).not.toMatch(/^(https?:)?\/\//);
        expect(body!.trim(), 'an inline script').toBe('');
      }
      for (const m of html.matchAll(/<link\b[^>]*\brel="(?:stylesheet|preload|preconnect|dns-prefetch)"[^>]*>/g)) {
        expect(m[0], 'a stylesheet or connection to another origin').not.toMatch(/href="(https?:)?\/\//);
      }
      expect(html).not.toMatch(/<iframe\b/);
    });

    it('refers only to files the site has', () => {
      const missing: string[] = [];
      for (const ref of references(html)) {
        const target = siteTarget(page, ref);
        if (target === null) continue;
        if (target.path.startsWith('..') || !isFile(join(SITE, target.path))) missing.push(ref);
      }
      expect(missing).toEqual([]);
    });

    it('links within the page only to ids it has', () => {
      const ids = new Set(attributes(html, 'id'));
      expect(attributes(html, 'href').filter((h) => h.startsWith('#') && !ids.has(h.slice(1)))).toEqual([]);
    });

    it('links into the repository on GitHub only at paths the repository has, and only at main', () => {
      const links = references(html).filter((r) => r.startsWith('https://github.com/'));
      expect(links.length).toBeGreaterThan(page === 'index.html' ? 10 : 3);
      const wrong: string[] = [];
      for (const link of links) {
        if (link === REPO || link === `${REPO}.git`) continue;
        const m = new RegExp(`^${REPO}/(blob|tree)/main/([^#?]+)(?:#(.+))?$`).exec(link);
        if (!m) {
          wrong.push(`${link}: not a blob or tree link on main of ${REPO}`);
          continue;
        }
        const [, kind, path, anchor] = m;
        const local = join(ROOT, decodeURIComponent(path!));
        if (kind === 'blob' ? !isFile(local) : !isDir(local)) {
          wrong.push(`${link}: no ${kind === 'blob' ? 'file' : 'folder'} ${path}`);
          continue;
        }
        if (anchor && !anchorsOf(readFileSync(local, 'utf8')).has(anchor)) wrong.push(`${link}: no heading #${anchor} in ${path}`);
      }
      expect(wrong).toEqual([]);
    });

    it('quotes its excerpts from the files they name, line for line', () => {
      const excerpts = [...html.matchAll(/<pre data-from="([^"]+)"><code>([\s\S]*?)<\/code><\/pre>/g)];
      if (page === 'index.html') expect(excerpts.length).toBeGreaterThanOrEqual(3);
      const stale: string[] = [];
      for (const [, from, body] of excerpts) {
        const lines = new Set(readFileSync(join(ROOT, from!), 'utf8').split('\n').map((l) => l.trimEnd()));
        for (const line of decode(body!.replace(/<[^>]+>/g, '')).split('\n')) {
          if (line.trim() !== '' && !lines.has(line.trimEnd())) stale.push(`${from}: ${line}`);
        }
      }
      expect(stale).toEqual([]);
    });

    it('carries copies of the brand files that match assets/brand', () => {
      const brand = [...new Set(references(html).map((r) => siteTarget(page, r)?.path).filter((p): p is string => p !== undefined && p.startsWith('brand/')))];
      expect(brand.length).toBeGreaterThan(3);
      for (const file of brand) {
        const name = file.slice('brand/'.length);
        expect(readFileSync(join(SITE, file)).equals(readFileSync(join(ROOT, 'assets/brand', name))), file).toBe(true);
      }
    });

    it('says on a phone what each of its comparison tables says', () => {
      // The phone shows one card per approach in place of each table (the cards that follow it); each card is a column of it.
      const tables = [...html.matchAll(/<table class="compare(?: [^"]*)?">([\s\S]*?)<\/table>/g)].map((m) => m[1]!);
      if (tables.length === 0) return expect(html).not.toContain('class="ccard');
      const groups = [...html.matchAll(/<div class="compare-cards">([\s\S]*?)<\/div>/g)].map((m) => m[1]!);
      expect(groups.length).toBe(tables.length);
      tables.forEach((table, t) => {
        const columns = [...table.matchAll(/<th scope="col"[^>]*>(.*?)<\/th>/g)].map((m) => m[1]!);
        const rows = [...table.matchAll(/<tr>\s*<th scope="row">(.*?)<\/th>([\s\S]*?)<\/tr>/g)].map((m) => ({ label: m[1]!, cells: [...m[2]!.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((c) => c[1]!) }));
        const fromTable = columns.map((column, i) => ({ column, answers: rows.map((r) => [r.label, r.cells[i]]) }));
        const cards = [...groups[t]!.matchAll(/<section class="ccard[^"]*"[^>]*>\s*<h3>(.*?)<\/h3>\s*<dl>([\s\S]*?)<\/dl>/g)].map((m) => ({
          column: m[1]!,
          answers: [...m[2]!.matchAll(/<dt>(.*?)<\/dt><dd>(.*?)<\/dd>/g)].map((a) => [a[1], a[2]]),
        }));
        expect(columns.length).toBeGreaterThanOrEqual(2);
        expect(rows.length).toBeGreaterThan(3);
        expect(cards).toEqual(fromTable);
      });
    });
  });
});

describe('the blog', () => {
  /** A post is site/blog/<yyyy-mm-dd>-<slug>.html; the blog's index and its feed list every one. */
  const POST = /^blog\/(\d{4}-\d{2}-\d{2})-[a-z0-9]+(?:-[a-z0-9]+)*\.html$/;
  const posts = PAGES.filter((page) => page.startsWith('blog/') && page !== 'blog/index.html');
  const index = htmlOf('blog/index.html');
  const feed = readFileSync(join(SITE, 'blog/feed.xml'), 'utf8');
  const titleOf = (page: string): string => decode(/<h1>([^<]+)<\/h1>/.exec(htmlOf(page))?.[1]?.trim() ?? '');
  const fileOf = (page: string): string => page.slice('blog/'.length);

  it('has posts, each named by its date and a slug', () => {
    expect(posts.length).toBeGreaterThan(0);
    for (const page of posts) expect(page, page).toMatch(POST);
  });

  it('gives each post its title, its author and its date', () => {
    for (const page of posts) {
      const html = htmlOf(page);
      expect(titleOf(page), page).not.toBe('');
      const byline = /<p class="byline">([\s\S]*?)<\/p>/.exec(html)?.[1] ?? '';
      expect(byline, page).toContain('Jason Stiles');
      expect(byline, page).toContain(`<time datetime="${POST.exec(page)![1]}">`);
    }
  });

  it('lists every post on its index, with its date and title, newest first', () => {
    const items = [...index.matchAll(/<li>\s*<time datetime="([^"]+)">[\s\S]*?<a href="([^"]+)">([^<]+)<\/a>[\s\S]*?<\/li>/g)].map((m) => ({ date: m[1]!, file: m[2]!, title: decode(m[3]!) }));
    expect(items.map((i) => i.file).sort()).toEqual(posts.map(fileOf).sort());
    for (const item of items) {
      const page = `blog/${item.file}`;
      expect(item.date, page).toBe(POST.exec(page)![1]);
      expect(item.title, page).toBe(titleOf(page));
    }
    const dates = items.map((i) => i.date);
    expect(dates).toEqual([...dates].sort().reverse());
  });

  it('has every post in its feed, and nothing else', () => {
    expect(feed).toMatch(/^<\?xml version="1.0" encoding="utf-8"\?>\n<feed xmlns="http:\/\/www.w3.org\/2005\/Atom">/);
    for (const field of ['<title>', '<id>', '<updated>', '<name>Jason Stiles</name>']) expect(feed).toContain(field);
    const entries = [...feed.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => ({
      title: decode(/<title>([^<]+)<\/title>/.exec(m[1]!)?.[1] ?? ''),
      link: /<link rel="alternate" type="text\/html" href="([^"]+)"\/>/.exec(m[1]!)?.[1] ?? '',
      id: /<id>([^<]+)<\/id>/.exec(m[1]!)?.[1] ?? '',
      updated: /<updated>([^<]+)<\/updated>/.exec(m[1]!)?.[1] ?? '',
    }));
    expect(entries.map((e) => e.link).sort()).toEqual(posts.map((p) => `https://${DOMAIN}/${p}`).sort());
    for (const entry of entries) {
      const page = entry.link.slice(`https://${DOMAIN}/`.length);
      expect(entry.title, page).toBe(titleOf(page));
      expect(entry.id, page).toBe(entry.link);
      expect(entry.updated.slice(0, 10), page).toBe(POST.exec(page)![1]);
    }
  });

  it('points every page of the blog at its feed', () => {
    for (const page of ['blog/index.html', ...posts]) {
      expect(htmlOf(page), page).toContain('<link rel="alternate" type="application/atom+xml" title="DialogWright blog" href="feed.xml">');
    }
  });
});
