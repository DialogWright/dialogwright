import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ServerConfig } from './config';
import type { Thresholds } from '../core/thresholds';
import type { Tools } from '../core/tools';
import type { JevClient } from '../jev/types';
import type { ChatTurnDeps } from './chatTurn';
import type { ChatSettings } from './config';
import type { App } from '../core/app/types';

/**
 * A page or API an app serves beside the phone line (a web chat, say): one of the app's own pages
 * (App.pages, mounted under `/<app id>` by every server that runs the app, a host's included), or one
 * a launcher mounts through ServerOverrides.routes. The server hands it every request before the
 * Twilio webhooks; it answers the ones under its path and says so.
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

/** Paths the engine serves itself (the console, clips, health, the Twilio webhooks, the relay socket): no app route may sit on or under one. */
const ENGINE_PATHS: readonly string[] = ['/dashboard', '/audio', '/health', '/voice', '/cr-action', '/conversation'];

const ROUTE_PATH = /^\/[a-z0-9_-]+(\/[a-z0-9_-]+)*$/;

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
 * Checked when routes are mounted: each path is lowercase letters, digits, hyphens and underscores in segments
 * after a leading slash (no trailing slash, no dots, no encoding for a decoder to disagree about),
 * is not the engine's own, and does not overlap another route's. Throws, naming the route.
 */
export function validateRoutes(routes: readonly AppRoute[]): void {
  const seen: AppRoute[] = [];
  for (const r of routes) {
    if (!ROUTE_PATH.test(r.path)) throw new Error(`app route "${r.label}": path ${JSON.stringify(r.path)} must be "/" then lowercase letters, digits, hyphens and underscores, in segments ("/chat", "/portal/help")`);
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

/**
 * What an app's own pages (App.pages) are built with: what a launcher's routes are given, for the app
 * itself (its client, tools, audit, traces and services, on a host as alone), and where it is mounted.
 */
export interface AppPageDeps extends AppRouteDeps {
  /** The app whose pages these are. */
  app: App;
  /** The path its pages are mounted under, `/<app id>`: each route's path is below it ("/portal" is served at "/harbor/portal"). */
  base: string;
  /** Where the app's web chat is: `/chat/<app id>` on a server of several apps (host.yaml), `/chat` on a server of one. */
  chatPath: string;
  /**
   * The app's web chat settings as its chat reads them (on a host, its own CHAT_AUDIENCE, CHAT_ISSUER and
   * CHAT_JWKS_URL over the server's); absent when CHAT is off.
   */
  chat?: ChatSettings;
  /**
   * One of the app's settings by name, as its code reads them at call time (ctx.env): on a host its own
   * settings file over the server's settings, on a server of one the server's environment.
   */
  env(name: string): string | undefined;
}

/**
 * An app's own pages (App.pages): built once the server has the app's client, tools, audit chain and
 * console, by a one-app server and a host's alike. A switch the app reads from `env` decides whether a
 * page exists at all: a factory that returns no route leaves every path under its base a 404.
 */
export type AppPagesFactory = (deps: AppPageDeps) => AppRoutes;

/** The prefix an app's pages are mounted under: `/<app id>`. */
export function appPagesBase(appId: string): string {
  return `/${appId}`;
}

/**
 * An app's routes as the server mounts them: each route's path put under `base` (`/<app id>`), and
 * its handler given the path below it ("/portal/jwks.json" for a request to "/harbor/portal/jwks.json"),
 * so an app's pages never name where they are mounted. Each route keeps its label, its `localOnly`, its
 * sweep and its tails; the mounted paths are validated with every other route (validateRoutes), so two
 * apps' pages, or an app's and a launcher's, can never sit on one path.
 */
export function mountAppPages(base: string, routes: readonly AppRoute[]): AppRoute[] {
  return routes.map((r) => {
    if (!ROUTE_PATH.test(r.path)) throw new Error(`app route "${r.label}": path ${JSON.stringify(r.path)} must be "/" then lowercase letters, digits, hyphens and underscores, in segments ("/chat", "/portal/help")`);
    const mounted: AppRoute = {
      label: r.label,
      path: `${base}${r.path}`,
      localOnly: r.localOnly,
      handle: (req, res, path) => r.handle(req, res, path.slice(base.length)),
      ...(r.sweep ? { sweep: () => r.sweep!() } : {}),
      ...(r.tails ? { tails: () => r.tails!() } : {}),
    };
    return mounted;
  });
}
