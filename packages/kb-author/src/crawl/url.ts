/**
 * URLs as the crawler keeps them, and the `--include` patterns it matches them with.
 */

/**
 * A URL in the one form the crawler keeps: http or https only, no user name or password, the
 * fragment dropped, the host lowercased and a default port dropped (the URL parser does both), the
 * query kept as it is. Undefined for anything else (mailto:, javascript:, a malformed href).
 */
export function canonicalUrl(href: string, base?: string | URL): string | undefined {
  let url: URL;
  try {
    url = base === undefined ? new URL(href) : new URL(href, base);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (url.username !== '' || url.password !== '') return undefined;
  url.hash = '';
  return url.href;
}

/** A URL's host as hosts are compared: the host name and any port that is not the scheme's default. */
export function hostOf(url: string): string {
  return new URL(url).host;
}

/**
 * A glob as a regular expression over a URL's path: `**` matches anything, `*` anything but a slash,
 * `?` one character but a slash. A glob with no slash matches the path's last segment (`*.pdf`); one
 * with a slash matches the whole path (`/help/**`; the leading slash is optional).
 */
export function globToRegExp(glob: string): RegExp {
  const anchored = glob.includes('/');
  const body = (anchored && !glob.startsWith('/') ? `/${glob}` : glob)
    .split(/(\*\*|\*|\?)/)
    .map((part) => (part === '**' ? '.*' : part === '*' ? '[^/]*' : part === '?' ? '[^/]' : part.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(anchored ? `^${body}$` : `(?:^|/)${body}$`);
}

/** Whether a URL's path matches one of the globs (every URL does when there are none). */
export function included(url: string, globs: readonly RegExp[]): boolean {
  if (globs.length === 0) return true;
  const path = new URL(url).pathname;
  return globs.some((g) => g.test(path));
}

/** Extensions of files that are never a page or a document the crawler reads: it does not fetch them. */
const NEVER = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'tif', 'tiff', 'avif', 'css', 'js', 'mjs', 'json', 'xml', 'rss', 'atom', 'zip', 'gz', 'tgz',
  'bz2', '7z', 'rar', 'tar', 'mp3', 'mp4', 'm4a', 'wav', 'ogg', 'webm', 'mov', 'avi', 'mkv', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'csv', 'xls', 'xlsx',
  'ppt', 'pptx', 'doc', 'odt', 'ods', 'odp', 'rtf', 'exe', 'dmg', 'pkg', 'apk', 'iso', 'bin', 'wasm', 'txt', 'md',
]);

/** A URL's path extension, lowercased, or ''. */
export function extensionOf(url: string): string {
  const last = new URL(url).pathname.split('/').pop() ?? '';
  const dot = last.lastIndexOf('.');
  return dot < 0 ? '' : last.slice(dot + 1).toLowerCase();
}

/** Whether a URL names a file the crawler never fetches, by its extension. */
export function neverFetched(url: string): boolean {
  return NEVER.has(extensionOf(url));
}
