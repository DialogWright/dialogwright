/**
 * Which sites may open a web chat (CHAT_ALLOWED_ORIGINS). A browser sends the page's origin with
 * every WebSocket upgrade, and the server checks it before the upgrade: a page on another site
 * cannot open a chat in a visitor's browser.
 */
export type AllowedOrigins = { readonly any: true } | { readonly any: false; readonly set: ReadonlySet<string> };

/** CHAT_ALLOWED_ORIGINS: exact origins (scheme, host, optional port), comma-separated, or * on a laptop only. */
export function parseAllowedOrigins(raw: string, publicHost: string): AllowedOrigins {
  const items = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (items.length === 0) throw new Error('CHAT_ALLOWED_ORIGINS must name at least one origin');
  if (items.length === 1 && items[0] === '*') {
    if (publicHost !== 'localhost') throw new Error('CHAT_ALLOWED_ORIGINS may be * only when PUBLIC_HOST is localhost');
    return { any: true };
  }
  const set = new Set<string>();
  for (const item of items) {
    let url: URL | null;
    try {
      url = new URL(item);
    } catch {
      url = null;
    }
    // The origin as a browser sends it: the item must be exactly that (no path, no trailing slash, no user).
    if (url === null || (url.protocol !== 'https:' && url.protocol !== 'http:') || url.origin !== item) {
      throw new Error(`CHAT_ALLOWED_ORIGINS must be origins like https://www.example.com, got "${item}"`);
    }
    set.add(url.origin);
  }
  return { any: false, set };
}

/** Whether a request's Origin header is one of the allowed; a request without one is not. */
export function originAllowed(allowed: AllowedOrigins, origin: string | undefined): boolean {
  if (origin === undefined || origin === '') return false;
  return allowed.any || allowed.set.has(origin);
}

/** How the startup line names the allowed origins. */
export function describeOrigins(allowed: AllowedOrigins): string {
  return allowed.any ? 'any origin (laptop)' : [...allowed.set].join(', ');
}
