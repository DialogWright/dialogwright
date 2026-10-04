import type { App } from './types';
import { validateApp } from './validate';
import { requireEmbedder } from '../../kb/fallback';

/**
 * The apps this process serves, by id. A session carries only its app's id (sessions stay plain,
 * serializable values); engine code resolves the app through `appOf`. The first app registered is
 * the default, which is what a session without an appId (and every test that predates apps) gets.
 */
const apps = new Map<string, App>();
let first: string | null = null;

export function registerApp(app: App): void {
  validateApp(app);
  // The engine's default retriever fell back to keywords although kb.yaml names an embedder: a
  // warning, or under NODE_ENV=production (or DIALOGWRIGHT_REQUIRE_EMBEDDER=1) an error (../../kb/fallback.ts).
  requireEmbedder(app.knowledge?.retriever, `app "${app.id}"`);
  if (apps.has(app.id)) throw new Error(`app "${app.id}" is already registered`);
  apps.set(app.id, app);
  first ??= app.id;
}

export function getApp(id: string): App {
  const app = apps.get(id);
  if (!app) throw new Error(`no app registered with id "${id}"`);
  return app;
}

export function defaultAppId(): string {
  if (first === null) throw new Error('no app registered');
  return first;
}

/** The default app, or null when none is registered (a stub or a metric that can do without one). */
export function defaultAppOrNull(): App | null {
  return first === null ? null : getApp(first);
}

export function appOf(session: { readonly appId?: string }): App {
  return getApp(session.appId ?? defaultAppId());
}

/** Tests only: forget every registered app. */
export function resetAppsForTest(): void {
  apps.clear();
  first = null;
}
