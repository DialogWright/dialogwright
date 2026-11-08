/**
 * The sign-in page of CONSOLE_AUTH=token (server/console/auth.ts): a page with nothing of the app's or
 * of any call on it, which anyone who reaches the tunnel may see. It loads nothing, and its one style
 * runs by the nonce the response's policy names.
 */

export type SignInNote = 'signed-out' | 'refused' | 'limited';

export interface SignInPageOptions {
  nonce: string;
  /** How long a sign-in lasts (CONSOLE_SESSION_HOURS). */
  hours: number;
  /** The link's code, already checked to be 64 hex digits: the page then posts it. */
  code?: string;
  note?: SignInNote;
  /**
   * Where a sign-in goes: one of the app's console pages (AppRoute `auth: 'console'`), already checked
   * to be one exactly (ConsoleAuth.isPage). The form carries it; without a code, the page links to it,
   * for a browser that is signed in but was sent here from another site (its cookie, SameSite=Strict,
   * was not sent on that first request).
   */
  next?: string;
}

const NOTES: Record<SignInNote, string> = {
  'signed-out': 'Signed out.',
  refused: 'That link does not sign in: it has been used, it has expired, or a newer one replaced it.',
  limited: 'Too many sign-in attempts. Wait a quarter of an hour, then use a new link.',
};

const NEW_LINK = 'On the machine the server runs on, <code>pnpm console:link</code> prints a new sign-in link.';

const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (ch) => ESCAPES[ch]!);

export function signInPage(o: SignInPageOptions): string {
  const note = o.note ? `<p class="note" role="alert">${NOTES[o.note]}</p>` : '';
  const next = o.next === undefined ? '' : escapeHtml(o.next);
  const body = o.code
    ? `<p>This signs this browser in to the console for ${o.hours} ${o.hours === 1 ? 'hour' : 'hours'}. The link works once, for ten minutes from when it was made.</p>
<form method="post" action="/dashboard/login"><input type="hidden" name="code" value="${o.code}">${next === '' ? '' : `<input type="hidden" name="next" value="${next}">`}<button type="submit">Sign in</button></form>`
    : `<p>${NEW_LINK}</p>${next === '' ? '' : `<p>Signed in on this browser already? <a href="${next}">Open the page</a>.</p>`}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Console sign-in</title>
<style nonce="${o.nonce}">
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:#0d1016; color:#e2e6ee; font:1rem/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width:28rem; padding:24px; }
  h1 { font-size:1.3rem; margin:0 0 12px; }
  .note { color:#f0c36d; }
  code { font-family:ui-monospace, Menlo, monospace; }
  a { color:#8fb3ff; }
  button { font:inherit; padding:10px 22px; border-radius:8px; border:1px solid #323b4b; background:#2f5fb8; color:#fff; cursor:pointer; }
</style>
</head>
<body>
<main>
<h1>Sign in to the console</h1>
${note}${body}
</main>
</body>
</html>
`;
}
