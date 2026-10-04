import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The landing page (site/, published to GitHub Pages by .github/workflows/pages.yml): every link and
 * asset it names exists, every link into the repository on GitHub points at a path the repository
 * has, the excerpts it quotes are still in the files they come from, and the page keeps its basics
 * (a language, a title, a description, a favicon, no script from another origin). Like wording.test.ts,
 * it is about the repository rather than the engine, so it reads the files from the root.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SITE = join(ROOT, 'site');
const DOMAIN = 'dialogwright.com';
const REPO = 'https://github.com/DialogWright/dialogwright';

const html = readFileSync(join(SITE, 'index.html'), 'utf8');

const decode = (s: string): string =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

/** Every value of an attribute in the page (srcset split into its URLs). */
function attributes(name: string): string[] {
  return [...html.matchAll(new RegExp(`\\s${name}="([^"]*)"`, 'g'))].flatMap((m) => {
    const value = decode(m[1]!);
    return name === 'srcset' ? value.split(',').map((part) => part.trim().split(/\s+/)[0]!) : [value];
  });
}

const references = (): string[] => [...attributes('href'), ...attributes('src'), ...attributes('srcset'), ...attributes('content').filter((c) => /^https?:\/\//.test(c))];

const isFile = (path: string): boolean => existsSync(path) && statSync(path).isFile();
const isDir = (path: string): boolean => existsSync(path) && statSync(path).isDirectory();

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

describe('the landing page', () => {
  it('names its domain in CNAME', () => {
    expect(readFileSync(join(SITE, 'CNAME'), 'utf8').trim()).toBe(DOMAIN);
  });

  it('has a language, a title, a description and a favicon', () => {
    expect(html).toMatch(/<html lang="[a-z]{2}(-[A-Z]{2})?">/);
    expect(/<title>([^<]+)<\/title>/.exec(html)?.[1]?.trim()).toMatch(/^DialogWright/);
    expect(/<meta name="description" content="([^"]{50,})">/.test(html)).toBe(true);
    const icons = [...html.matchAll(/<link rel="icon" href="([^"]+)"/g)].map((m) => m[1]!);
    expect(icons.length).toBeGreaterThan(0);
    for (const icon of icons) expect(isFile(join(SITE, icon)), icon).toBe(true);
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
    for (const ref of references()) {
      if (/^(mailto:|#)/.test(ref)) continue;
      let path: string;
      if (ref.startsWith(`https://${DOMAIN}/`)) path = ref.slice(`https://${DOMAIN}/`.length);
      else if (/^[a-z]+:|^\/\//.test(ref)) continue;
      else path = ref;
      path = path.split('#')[0]!.split('?')[0]!;
      if (path === '' || path.endsWith('/')) path += 'index.html';
      if (!isFile(join(SITE, path))) missing.push(ref);
    }
    expect(missing).toEqual([]);
  });

  it('links within the page only to ids it has', () => {
    const ids = new Set(attributes('id'));
    expect(attributes('href').filter((h) => h.startsWith('#') && !ids.has(h.slice(1)))).toEqual([]);
  });

  it('links into the repository on GitHub only at paths the repository has, and only at main', () => {
    const links = references().filter((r) => r.startsWith('https://github.com/'));
    expect(links.length).toBeGreaterThan(10);
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
    expect(excerpts.length).toBeGreaterThanOrEqual(3);
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
    const brand = [...new Set(references().filter((r) => !/^[a-z]+:/.test(r) || r.startsWith(`https://${DOMAIN}/`)))]
      .map((r) => r.replace(`https://${DOMAIN}/`, ''))
      .filter((r) => r.startsWith('brand/'));
    expect(brand.length).toBeGreaterThan(3);
    for (const file of brand) {
      const name = file.slice('brand/'.length);
      expect(readFileSync(join(SITE, file)).equals(readFileSync(join(ROOT, 'assets/brand', name))), file).toBe(true);
    }
  });
});
