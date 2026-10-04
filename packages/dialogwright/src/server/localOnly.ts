import type { IncomingMessage } from 'node:http';
import type { AppRoute } from './appRoutes';

/**
 * CONSOLE_LOCAL_ONLY: the operator console, and the app's pages that declare themselves local-only
 * (its chats, say), are for the screen in front of the operator, not for the internet. The tunnel
 * that carries Twilio's webhooks to PUBLIC_HOST (ngrok, or anything like it) also carries anyone
 * else's request for /dashboard or an app's page, and its agent connects from 127.0.0.1, so the
 * socket's remote address alone cannot tell a tunnelled request from a local one. What gives the
 * tunnel away is what it adds: forwarding headers, its own `ngrok-*` headers, or the public
 * hostname in `Host`. On a laptop with no public name (PUBLIC_HOST=localhost, or another loopback
 * name), a direct request's `Host` is that same name, so there it is the other way round: `Host` must
 * name this machine.
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
 * True only for a request made directly on this machine: from a loopback address, with no header
 * a proxy or tunnel adds, and not addressed to the public hostname; or, on a laptop whose public host
 * is itself a name for this machine (PUBLIC_HOST=localhost), addressed to such a name.
 */
export function isDirectLocalRequest(req: IncomingMessage, publicHost: string): boolean {
  if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) return false;
  for (const name of Object.keys(req.headers)) {
    if (FORWARDING_HEADERS.includes(name) || name.startsWith('ngrok-')) return false;
  }
  const host = (req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
  // A laptop's own name: a direct request names this machine too, and one naming anything else came
  // some other way (a tunnel that adds no header, a page whose name was pointed at 127.0.0.1).
  if (isLoopbackHost(publicHost)) return isLoopbackHost(host);
  return host !== publicHost.toLowerCase();
}
