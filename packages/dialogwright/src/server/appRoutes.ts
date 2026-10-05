import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ServerConfig } from './config';
import type { Thresholds } from '../core/thresholds';
import type { Tools } from '../core/tools';
import type { JevClient } from '../jev/types';
import type { ChatTurnDeps } from './chatTurn';

/**
 * A page or API an app serves beside the phone line (a web chat, say), mounted by the app's
 * launcher through ServerOverrides.routes. The server hands it every request before the Twilio
 * webhooks; it answers the ones under its path and says so.
 */
export interface AppRoute {
  /** What the startup line calls it ("web chat": "[server] web chat http://localhost:3000/chat"). */
  readonly label: string;
  /** The path it is served under ("/chat"): that path and everything below it. */
  readonly path: string;
  /**
   * Whether CONSOLE_LOCAL_ONLY keeps it off the tunnel, as it keeps the console: a page for the
   * screen in front of the operator rather than for the internet (src/server/localOnly.ts).
   */
  readonly localOnly: boolean;
  /** True when the request was this route's, and has been (or is being) answered. */
  handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean>;
  /** One pass of the server's idle sweep (every minute): drop what has gone idle. */
  sweep?(): void;
  /** Work still in flight, for a shutdown that lets it finish. */
  tails?(): Promise<void>[];
}

/** Paths the engine serves itself (the console, clips, health, the Twilio webhooks, the relay socket, the relay's silent clip): no app route may sit on or under one. */
const ENGINE_PATHS: readonly string[] = ['/dashboard', '/audio', '/health', '/voice', '/cr-action', '/conversation', '/relay'];

const ROUTE_PATH = /^\/[a-z0-9-]+(\/[a-z0-9-]+)*$/;

/**
 * Whether `path` (a request's path as the server reads it, before any decoding) is the route's: its
 * path, or anything below it. The one matcher both the server's dispatch and its local-only guard use
 * (src/server/localOnly.ts isConsolePath), so a path the guard does not call the route's is never
 * handed to it: `/chatX`, `/%63hat` and `/portal/../x` are not `/chat`'s or `/portal`'s by name.
 */
export function routeOwns(route: Pick<AppRoute, 'path'>, path: string): boolean {
  return path === route.path || path.startsWith(`${route.path}/`);
}

/**
 * Checked when routes are mounted: each path is lowercase letters, digits and hyphens in segments
 * after a leading slash (no trailing slash, no dots, no encoding for a decoder to disagree about),
 * is not the engine's own, and does not overlap another route's. Throws, naming the route.
 */
export function validateRoutes(routes: readonly AppRoute[]): void {
  const seen: AppRoute[] = [];
  for (const r of routes) {
    if (!ROUTE_PATH.test(r.path)) throw new Error(`app route "${r.label}": path ${JSON.stringify(r.path)} must be "/" then lowercase letters, digits and hyphens, in segments ("/chat", "/portal/help")`);
    const engine = ENGINE_PATHS.find((e) => routeOwns({ path: e }, r.path) || routeOwns(r, e));
    if (engine) throw new Error(`app route "${r.label}": path ${r.path} overlaps ${engine}, which the engine serves`);
    const clash = seen.find((o) => routeOwns(o, r.path) || routeOwns(r, o.path));
    if (clash) throw new Error(`app route "${r.label}": path ${r.path} overlaps route "${clash.label}" at ${clash.path}`);
    seen.push(r);
  }
}

/**
 * What the server shares with an app's routes: the phone line's model client, its book of business
 * (tools), its audit chain and console, the trace directory, the downstream services, and the clock.
 */
export interface AppRouteDeps extends ChatTurnDeps {
  config: ServerConfig;
  client: JevClient;
  thresholds: Thresholds;
  todayIso: () => string;
  tools: Tools;
  traceDir: string;
  now: () => number;
}

/** The routes an app mounts, and the warnings the server logs loudly once it has said where the console is. */
export interface AppRoutes {
  routes: readonly AppRoute[];
  warnings?: readonly string[];
}

/** Builds an app's routes once the server has its client, tools, audit chain and console. */
export type AppRoutesFactory = (deps: AppRouteDeps) => AppRoutes;
