import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The site (site/, published to GitHub Pages by .github/workflows/pages.yml): the landing page and the
 * guides under site/guides/. On every page, every link and asset it names exists, every link into the
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
    expect(PAGES).toEqual(expect.arrayContaining(['index.html', 'guides/home-server.html', 'guides/scaling.html']));
  });

  it('has its own title and canonical URL on every page', () => {
    const titles = PAGES.map((page) => /<title>([^<]+)<\/title>/.exec(htmlOf(page))?.[1]?.trim());
    expect(new Set(titles).size).toBe(PAGES.length);
    for (const page of PAGES) {
      const canonical = /<link rel="canonical" href="([^"]+)">/.exec(htmlOf(page))?.[1];
      expect(canonical, page).toBe(`https://${DOMAIN}/${page === 'index.html' ? '' : page}`);
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
  });
});
