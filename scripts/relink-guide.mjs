#!/usr/bin/env node
// The authoring guide was one page, docs/authoring-an-app.md, and is now chapters in docs/guide/. The
// old page is kept as a list of pointers: one line for each heading it had, with that heading's anchor
// (`<a id="...">`) and a link to the chapter and anchor where the section is now. This script reads
// that list and rewrites every link in this repository that still names the old page (a Markdown link
// in a .md file, an href in a site page) to the new place: `authoring-an-app.md#appyaml` becomes
// `guide/02-the-files-one-by-one.md#appyaml`, keeping whatever led to docs/ before it (a relative
// path, `{{root}}/docs/` in a template, `node_modules/dialogwright/docs/`, the repository's GitHub
// URL), and a link with no anchor goes to the guide's contents, `guide/README.md`. A link to an
// anchor the old page never had is a problem it reports and leaves as it is.
//
// It was run once, when the guide was split; run again it changes nothing (src/guideLinks.test.ts in
// the engine holds that, so a new link to the old page fails the tests and this script fixes it).
// Text that names the page in code (a comment, a message) is not a link and is not touched.
//
// usage: node scripts/relink-guide.mjs [--check]   (--check: print what it would change, exit 1 if anything)
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The old page, the pointer list, as a path in the repository. */
export const OLD_PAGE = 'docs/authoring-an-app.md';
/** Where the repository's pages are read on GitHub. */
const GITHUB_DOCS = 'https://github.com/DialogWright/dialogwright/blob/main/docs/';

/** Each old anchor and where its section is now, as a path under docs/ with its anchor ('guide/02-...md#appyaml'), read from the old page's pointer lines. */
export function pointersOf(oldPage) {
  const map = new Map();
  for (const m of oldPage.matchAll(/<a id="([^"]+)"><\/a>\[[^\n]*\]\((guide\/[^)\s#]+#[^)\s]+)\)\s*$/gm)) map.set(m[1], m[2]);
  // The old page's title is a heading of the new one too, and stands for the whole guide.
  map.set('authoring-an-app', 'guide/README.md');
  return map;
}

/**
 * `link` (a link target, as written in `file`) moved from the old page to its chapter, or null when it
 * does not name the old page. Throws for an anchor the old page never had, or a path to some other
 * file of that name.
 */
export function movedLink(link, file, pointers) {
  const m = /^(.*?)authoring-an-app\.md(?:#([^\s"')]*))?$/.exec(link);
  if (!m) return null;
  const [, prefix, anchor] = m;
  const fromDocs = prefix === ''
    ? posix.dirname(file) === 'docs'
    : prefix.includes('{{') || prefix === GITHUB_DOCS || prefix.endsWith('node_modules/dialogwright/docs/') || (!/^[a-z][a-z0-9+.-]*:/i.test(prefix) && posix.normalize(posix.join(posix.dirname(file), prefix, 'authoring-an-app.md')) === OLD_PAGE);
  if (!fromDocs) throw new Error(`${file}: ${link} names a file called authoring-an-app.md that is not ${OLD_PAGE}`);
  if (anchor === undefined || anchor === '') return `${prefix}guide/README.md`;
  const to = pointers.get(anchor);
  if (to === undefined) throw new Error(`${file}: ${link} names #${anchor}, which ${OLD_PAGE} never had`);
  return `${prefix}${to}`;
}

/** The text of `file` (a .md or .html page) with each link to the old page moved, and the links changed. */
export function relinkText(text, file, pointers) {
  const changes = [];
  const move = (link) => {
    const to = movedLink(link, file, pointers);
    if (to !== null && to !== link) changes.push({ file, from: link, to });
    return to;
  };
  let out;
  if (file.endsWith('.html')) {
    out = text.replace(/(\shref=")([^"]*)"/g, (whole, head, link) => {
      const to = move(link);
      return to === null ? whole : `${head}${to}"`;
    });
  } else {
    // A link whose text is the old path (`[docs/authoring-an-app.md](docs/authoring-an-app.md)`) takes the new path as its text too
    out = text.replace(/\[([^\]\n]*)\]\(([^)\s]+)\)/g, (whole, label, link) => {
      const to = move(link);
      if (to === null) return whole;
      // (the contents as the folder, `docs/guide/`; a chapter as its file).
      const page = to.slice(link.indexOf('authoring-an-app.md')).split('#')[0];
      const newLabel = label.endsWith('authoring-an-app.md') ? `${label.slice(0, -'authoring-an-app.md'.length)}${page === 'guide/README.md' ? 'guide/' : page}` : label;
      return `[${newLabel}](${to})`;
    });
  }
  return { text: out, changes };
}

/** The pages this script reads: every .md and .html file git tracks or would (not what it ignores), but the old page itself. */
export function pagesOf(root) {
  return execFileSync('git', ['ls-files', '-co', '--exclude-standard', '--', '*.md', '*.html'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f !== '' && f !== OLD_PAGE);
}

/** Every link to the old page in the repository at `root`, moved; written when `write` is true. */
export function relinkGuide(root, { write }) {
  const pointers = pointersOf(readFileSync(posix.join(root, OLD_PAGE), 'utf8'));
  const changes = [];
  for (const file of pagesOf(root)) {
    let text;
    try {
      text = readFileSync(posix.join(root, file), 'utf8');
    } catch {
      continue; // listed by git, deleted in the working tree
    }
    const result = relinkText(text, file, pointers);
    if (result.changes.length === 0) continue;
    changes.push(...result.changes);
    if (write) writeFileSync(posix.join(root, file), result.text);
  }
  return changes;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const check = process.argv.includes('--check');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const changes = relinkGuide(root, { write: !check });
  const files = new Set(changes.map((c) => c.file));
  for (const c of changes) console.log(`${c.file}: ${c.from} -> ${c.to}`);
  console.log(`${check ? 'would move' : 'moved'} ${changes.length} links in ${files.size} files`);
  if (check && changes.length > 0) process.exit(1);
}
