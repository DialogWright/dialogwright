import { posix } from 'node:path';

/**
 * The pages of this repository the `dialogwright` package carries beside its code, so a project of
 * its own (`dialogwright create-app --standalone`, `npm create dialogwright`) can point an assistant
 * at them: the authoring guide, the slot types' pages and the create-app skill. The package's build
 * (scripts/shipDocs.ts) copies them in; their links to pages the package does not carry become links
 * to the repository on GitHub.
 */

/** Each shipped page or folder: its path in this repository, and its path in the package. */
export const SHIPPED: readonly (readonly [repo: string, pkg: string])[] = [
  ['docs/authoring-an-app.md', 'docs/authoring-an-app.md'],
  ['docs/slots/', 'docs/slots/'],
  ['.claude/skills/create-app/', 'skills/create-app/'],
];

/** Where a page of this repository is read on GitHub: this prefix and its path. */
export const REPOSITORY_PAGES = 'https://github.com/DialogWright/dialogwright/blob/main/';

/** The package's path for a page of this repository it carries, or null when it carries none there. */
export function packagePathOf(repoPath: string): string | null {
  for (const [repo, pkg] of SHIPPED) {
    if (repo.endsWith('/') ? repoPath.startsWith(repo) : repoPath === repo) return pkg + repoPath.slice(repo.length);
  }
  return null;
}

const LINK = /\]\(([^)\s]+)\)/g;

/**
 * `markdown` (a page at `from`, its path in this repository) with each relative link given to
 * `place`: the link's target as a path in this repository, and its anchor (`#...`, or ''). `place`
 * returns the new link, or null to keep it as it is. Links to a web page, a mail address or an anchor
 * of the same page are kept.
 */
export function relinkMarkdown(markdown: string, from: string, place: (target: string, anchor: string) => string | null): string {
  return markdown.replace(LINK, (whole, link: string) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(link) || link.startsWith('#') || link.startsWith('/')) return whole;
    const hash = link.indexOf('#');
    const path = hash === -1 ? link : link.slice(0, hash);
    const anchor = hash === -1 ? '' : link.slice(hash);
    const target = posix.normalize(posix.join(posix.dirname(from), path));
    if (target.startsWith('..')) return whole;
    const placed = place(target, anchor);
    return placed === null ? whole : `](${placed})`;
  });
}

/** The link from `fromDir` (a folder, a path in one tree) to `to` (a path in the same tree). */
export function linkBetween(fromDir: string, to: string): string {
  const rel = posix.relative(fromDir, to);
  return rel === '' ? posix.basename(to) : rel;
}

/** A page of this repository (at `repoPath`) as the package carries it: links between shipped pages kept relative, any other to GitHub. */
export function packageCopy(text: string, repoPath: string): string {
  const pkgPath = packagePathOf(repoPath);
  if (pkgPath === null) throw new Error(`${repoPath} is not a page the package carries`);
  return relinkMarkdown(text, repoPath, (target, anchor) => {
    const shipped = packagePathOf(target);
    return shipped === null ? `${REPOSITORY_PAGES}${target}${anchor}` : `${linkBetween(posix.dirname(pkgPath), shipped)}${anchor}`;
  });
}
