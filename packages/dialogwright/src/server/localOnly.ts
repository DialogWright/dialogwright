import type { IncomingMessage } from 'node:http';
import type { AppRoute } from './appRoutes';

/**
 * CONSOLE_LOCAL_ONLY: the operator console, and the app's pages that declare themselves local-only
 * (its chats, say), are for the screen in front of the operator, not for the internet. The tunnel
 * that carries Twilio's webhooks to PUBLIC_HOST (ngrok, or anything like it) also carries anyone
 * else's request for /dashboard or an app's page, and its agent connects from 127.0.0.1, so the
 * socket's remote address alone cannot tell a tunnelled request from a local one. What gives the
 * tunnel away is what it adds: forwarding headers, its own `ngrok-*` headers, or the public
 * hostname in `Host`. So a direct request's `Host` must name this machine (`localhost`, `127.0.0.1`,
 * `[::1]`), on a laptop and a server alike (isDirectLocalRequest).
 */

/** The engine's own console paths, always local-only under CONSOLE_LOCAL_ONLY. */
export const CONSOLE_PATHS: readonly string[] = ['/dashboard'];

/** The paths CONSOLE_LOCAL_ONLY guards: the console's, then each local-only app route's, in mount order. */
export function localOnlyPaths(routes: readonly AppRoute[] = []): string[] {
  return [...CONSOLE_PATHS, ...routes.filter((r) => r.localOnly).map((r) => r.path)];
}

/** Whether `path` is one of `paths` or anything under one. */
export function isConsolePath(path: string, paths: readonly string[] = CONSOLE_PATHS): boolean {
  return paths.some((p) => path === p || path.startsWith(`${p}/`));
}

const FORWARDING_HEADERS = ['x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-real-ip', 'forwarded', 'cf-connecting-ip'];
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
/** The names a request on this machine is addressed to: a PUBLIC_HOST that is one of them is no public name at all. */
const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Whether `host` (a hostname, without a port) names this machine: a laptop's PUBLIC_HOST rather than a public one. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_NAMES.has(host.trim().toLowerCase());
}

/**
 * True only for a request made directly on this machine: from a loopback address, with no header a
 * proxy or tunnel adds, and addressed to a name for this machine (`Host` of `localhost`, `127.0.0.1` or
 * `[::1]`, any port). The `Host` rule holds on every machine, not only a laptop's: a page on another site
 * whose name was pointed at 127.0.0.1 (DNS rebinding) reaches the server from a loopback address with no
 * forwarding header, and only its `Host` (`attacker.example:3000`) gives it away. An ssh tunnel to the
 * console (`ssh -L 3000:localhost:3000`) sends `Host: localhost:3000`, and still works. The server's public
 * name (`_publicHost`) is no longer read: a public name is never a loopback name, and a laptop's
 * (PUBLIC_HOST=localhost) is one already. It stays in the signature for its callers.
 */
export function isDirectLocalRequest(req: IncomingMessage, _publicHost: string): boolean {
  if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) return false;
  for (const name of Object.keys(req.headers)) {
    if (FORWARDING_HEADERS.includes(name) || name.startsWith('ngrok-')) return false;
  }
  const host = (req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
  // Only a name for this machine: a tunnel that adds no header, or a page whose name was pointed at 127.0.0.1, names something else.
  return isLoopbackHost(host);
}

/** A header's one value (a repeated header's first), as a form check reads it. */
function oneHeader(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Whether a form post comes from this server's own page (the console's sign-in and sign-out, and an app
 * page's own forms): Sec-Fetch-Site, when sent, is same-origin (or none, typed or bookmarked); and the Origin
 * is absent, `null` (a page under no-referrer), `https://<PUBLIC_HOST>`, or, for a request made directly on
 * this machine, `http://<its Host>`. A second layer behind a form's own token, never the only one.
 */
export function formFromOwnPage(req: IncomingMessage, publicHost: string): boolean {
  // A browser says where a request came from, whatever the page's referrer policy; a page cannot change it.
  const site = oneHeader(req, 'sec-fetch-site');
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false;
  const origin = oneHeader(req, 'origin');
  if (origin === undefined || origin === 'null') return true;
  if (origin === `https://${publicHost}`) return true;
  return isDirectLocalRequest(req, publicHost) && origin === `http://${oneHeader(req, 'host') ?? ''}`;
}

