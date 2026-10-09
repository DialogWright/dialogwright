import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { packagePathOf } from './define/shipped';

/**
 * The repository's Markdown pages, read as GitHub shows them: every relative link names a file or
 * folder that exists and, where it names an anchor, a heading (or an `<a id>`) the page has, by
 * GitHub's rules for a heading's anchor. The templates' pages are read as the page a scaffold writes:
 * `{{root}}/` is the repository's root, and a project of its own finds the package's pages under
 * `node_modules/dialogwright/` (src/define/shipped.ts) and the skill under `.claude/skills/create-app/`.
 *
 * The authoring guide is chapters (docs/guide/); the page it was, docs/authoring-an-app.md, keeps a
 * pointer for each heading it had, so a link to an old anchor still lands; and no page of this
 * repository links to the old page any more (scripts/relink-guide.mjs moved them, and finds nothing
 * more to move). Like site.test.ts, it reads the files from the root.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Every Markdown page git tracks or would (not what it ignores, such as the package's shipped copies), and llms.txt. */
const PAGES = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '--', '*.md', 'llms.txt'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter((f) => f !== '' && existsSync(join(ROOT, f)));

const read = (file: string): string => readFileSync(file, 'utf8');

/** The page with its fenced code blocks blanked (a link or a heading in a block is not one), lines kept. */
function prose(text: string): string {
  let fenced = false;
  return text.split('\n').map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return '';
    }
    return fenced ? '' : line;
  }).join('\n');
}

/** A heading's anchor as GitHub makes it: lower case, markup and punctuation dropped, spaces as hyphens. */
const slugOf = (heading: string): string =>
  heading.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');

const anchorCache = new Map<string, Set<string>>();

/** The anchors a page has: its headings' (a repeated one gains -1, -2, ...) and its `<a id>` and `<a name>`. */
function anchorsOf(file: string): Set<string> {
  const cached = anchorCache.get(file);
  if (cached) return cached;
  const seen = new Map<string, number>();
  const out = new Set<string>();
  for (const line of prose(read(file)).split('\n')) {
    const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (m) {
      const base = slugOf(m[1]!);
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      out.add(n === 0 ? base : `${base}-${n}`);
    }
    for (const a of line.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) out.add(a[1]!);
  }
  anchorCache.set(file, out);
  return out;
}

/** Every relative link of a page's prose, as written, with its line (inline code is not a link). */
function linksOf(text: string): { link: string; line: number }[] {
  return prose(text).split('\n').flatMap((line, i) =>
    [...line.replace(/`[^`]*`/g, '').matchAll(/\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g)]
      .map((m) => ({ link: m[1]!, line: i + 1 }))
      .filter(({ link }) => !/^[a-z][a-z0-9+.-]*:/i.test(link)));
}

const STANDALONE = 'packages/dialogwright/templates/standalone/';

/** The file in this repository a link from `page` leads to, or null when it leads outside it. */
function targetOf(page: string, path: string): string | null {
  if (path.startsWith('{{root}}/')) return join(ROOT, path.slice('{{root}}/'.length));
  if (page.startsWith(STANDALONE)) {
    // A project's README and CLAUDE.md, at the project's root.
    if (path.startsWith('node_modules/dialogwright/')) {
      const inPackage = path.slice('node_modules/dialogwright/'.length).replace(/\/$/, '');
      const fromRepo = ['docs/guide', 'docs/slots', 'docs/authoring-an-app.md', 'docs/first-app.md'].find((p) => inPackage === p || inPackage.startsWith(`${p}/`));
      return fromRepo === undefined ? null : join(ROOT, inPackage);
    }
    if (path.startsWith('.claude/skills/create-app/')) return join(ROOT, path);
    return join(ROOT, STANDALONE, path);
  }
  return resolve(dirname(join(ROOT, page)), decodeURIComponent(path));
}

describe('the Markdown pages', () => {
  it('are read, the guide\'s chapters among them', () => {
    for (const page of ['README.md', 'llms.txt', 'docs/README.md', 'docs/guide/README.md', 'docs/guide/12-the-knowledge-base.md', 'docs/authoring-an-app.md', 'docs/first-app.md', '.claude/skills/create-app/SKILL.md', `${STANDALONE}README.md`]) expect(PAGES, page).toContain(page);
  });

  it('link only to files that exist, and to anchors their pages have', () => {
    const broken: string[] = [];
    for (const page of PAGES) {
      for (const { link, line } of linksOf(read(join(ROOT, page)))) {
        const hash = link.indexOf('#');
        const path = hash === -1 ? link : link.slice(0, hash);
        const anchor = hash === -1 ? '' : link.slice(hash + 1);
        const target = path === '' ? join(ROOT, page) : targetOf(page, path);
        if (target === null) {
          broken.push(`${page}:${line}: ${link} (outside the repository and not a page the package carries)`);
          continue;
        }
        if (!existsSync(target)) broken.push(`${page}:${line}: ${link} (no such file)`);
        else if (anchor !== '' && target.endsWith('.md') && statSync(target).isFile() && !anchorsOf(target).has(anchor)) broken.push(`${page}:${line}: ${link} (no such anchor in ${relative(ROOT, target)})`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('carry the shipped pages a standalone template names', () => {
    expect(packagePathOf('docs/guide/README.md')).toBe('docs/guide/README.md');
    expect(packagePathOf('docs/authoring-an-app.md')).toBe('docs/authoring-an-app.md');
    expect(packagePathOf('docs/first-app.md')).toBe('docs/first-app.md');
  });
});

describe('the authoring guide in chapters', () => {
  const chapters = PAGES.filter((p) => /^docs\/guide\/\d\d-[a-z0-9-]+\.md$/.test(p)).sort();
  const contents = read(join(ROOT, 'docs/guide/README.md'));

  it('has a chapter per numbered section, in order, each titled with its number, and the contents lists each', () => {
    expect(chapters.length).toBeGreaterThanOrEqual(15);
    chapters.forEach((chapter, i) => {
      const n = i + 1;
      expect(posix.basename(chapter).startsWith(`${String(n).padStart(2, '0')}-`), chapter).toBe(true);
      const title = /^# (.+)$/m.exec(read(join(ROOT, chapter)))?.[1];
      expect(title, chapter).toMatch(new RegExp(`^${n}\\. `));
      expect(posix.basename(chapter), chapter).toBe(`${String(n).padStart(2, '0')}-${slugOf(title!).replace(/^\d+-/, '')}.md`);
      expect(contents, chapter).toContain(`${n}. [${title!.replace(/^\d+\. /, '')}](${posix.basename(chapter)})`);
    });
  });

  it('keeps every anchor of the page it was as a pointer to its new place', () => {
    const old = read(join(ROOT, 'docs/authoring-an-app.md'));
    const pointers = [...old.matchAll(/^\s*- <a id="([^"]+)"><\/a>\[[^\n]*\]\((guide\/[^)#]+)#([^)]+)\)$/gm)];
    // The single page had 127 headings below its title; each is a line here (the title is this page's own).
    expect(pointers.length).toBe(127);
    const ids = pointers.map((m) => m[1]!);
    expect(new Set(ids).size).toBe(ids.length);
    expect(anchorsOf(join(ROOT, 'docs/authoring-an-app.md')).has('authoring-an-app')).toBe(true);
    for (const [, id, file, anchor] of pointers) {
      expect(anchorsOf(join(ROOT, 'docs', file!)).has(anchor!), `${id} -> ${file}#${anchor}`).toBe(true);
    }
  });

  it('is linked to by no page of this repository under its old name (scripts/relink-guide.mjs finds nothing to move)', async () => {
    type Relink = {
      relinkGuide(root: string, o: { write: boolean }): { file: string; from: string; to: string }[];
      relinkText(text: string, file: string, pointers: Map<string, string>): { text: string; changes: unknown[] };
      pointersOf(oldPage: string): Map<string, string>;
    };
    const relink = (await import(/* @vite-ignore */ new URL('../../../scripts/relink-guide.mjs', import.meta.url).href)) as Relink;
    expect(relink.relinkGuide(ROOT, { write: false })).toEqual([]);

    const pointers = relink.pointersOf(read(join(ROOT, 'docs/authoring-an-app.md')));
    const moved = (text: string, file: string) => relink.relinkText(text, file, pointers).text;
    expect(moved('[the files](../../../docs/authoring-an-app.md#appyaml)', '.claude/skills/create-app/SKILL.md')).toBe('[the files](../../../docs/guide/02-the-files-one-by-one.md#appyaml)');
    expect(moved('[docs/authoring-an-app.md](docs/authoring-an-app.md)', 'README.md')).toBe('[docs/guide/](docs/guide/README.md)');
    expect(moved('see [14](authoring-an-app.md#1412-the-options)', 'docs/design.md')).toBe('see [14](guide/14-running-it.md#1412-the-options)');
    expect(moved('[guide]({{root}}/docs/authoring-an-app.md#3-policy-and-identity)', 'packages/dialogwright/templates/app/README.md')).toBe('[guide]({{root}}/docs/guide/03-policy-and-identity.md#3-policy-and-identity)');
    expect(moved('<a href="https://github.com/DialogWright/dialogwright/blob/main/docs/authoring-an-app.md#131-the-options">', 'site/index.html')).toBe('<a href="https://github.com/DialogWright/dialogwright/blob/main/docs/guide/13-channels.md#131-the-options">');
    expect(() => moved('[x](authoring-an-app.md#no-such-section)', 'docs/design.md')).toThrow(/never had/);
    expect(() => moved('[x](elsewhere/authoring-an-app.md)', 'docs/design.md')).toThrow(/not docs\/authoring-an-app.md/);
    expect(moved('[a pattern](patterns.md#known-gaps) and `docs/authoring-an-app.md`', '.claude/skills/create-app/SKILL.md')).toBe('[a pattern](patterns.md#known-gaps) and `docs/authoring-an-app.md`');
  });
});

describe('your first app (docs/first-app.md)', () => {
  const page = read(join(ROOT, 'docs/first-app.md'));
  const paragraph = /^> (Build a phone assistant for .+)$/m.exec(page)?.[1];

  it('gives the assistant the paragraph it shows, word for word, with the skill, and says it is being tried', () => {
    expect(paragraph).toBeDefined();
    const prompt = /```text\n([\s\S]*?)```/.exec(page)?.[1] ?? '';
    expect(prompt).toContain('.claude/skills/create-app/SKILL.md');
    expect(prompt).toContain(`\n${paragraph}\n`);
    expect(page).toMatch(/^> \*\*Being tried\.\*\*/m);
  });

  it('names a business no one has: an invented one, as every app here does', () => {
    expect(paragraph).toMatch(/^Build a phone assistant for Example [A-Z]/);
  });
});
