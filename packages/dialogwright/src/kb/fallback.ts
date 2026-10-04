/**
 * When the default retriever falls back to keywords alone although kb.yaml names an embedder
 * (./hybrid.ts defaultRetriever): an index missing, unreadable or another model's, or the weights
 * not in the cache or not the pinned ones. A call still nominates, by keywords, so nothing breaks;
 * but retrieval by meaning is gone, and a production server must not run like that unnoticed.
 *
 * - When the app is defined (defineApp, defineKnowledge) and when it is registered (registerApp),
 *   a warning on stderr says why and the command that fixes it, once per retriever.
 * - When it is registered with NODE_ENV=production, or DIALOGWRIGHT_REQUIRE_EMBEDDER=1, it is an
 *   error instead: the server does not start.
 * - `pnpm check` stays independent of the model cache: it reports a missing or stale index itself
 *   (./rules.ts), never the weights, and the app code it imports is defined without the warning.
 */

/** The environment variable that makes a fallback an error at registration, whatever NODE_ENV says. */
export const REQUIRE_EMBEDDER_ENV = 'DIALOGWRIGHT_REQUIRE_EMBEDDER';

/** Each fallen-back default retriever, with why and the fix. */
const FALLBACKS = new WeakMap<object, string>();
/** The retrievers already warned about. */
const WARNED = new WeakSet<object>();
/** While above zero, no warning is said (check importing an app's code). */
let quiet = 0;

/** Records why a default retriever is keywords alone although an embedder is named. */
export function markFallback(retriever: object, why: string): void {
  FALLBACKS.set(retriever, why);
}

/** Why a default retriever fell back to keywords alone (with the fix), or null: it did not, or it is not the engine's default. */
export function fallbackOf(retriever: object | undefined): string | null {
  return retriever === undefined ? null : FALLBACKS.get(retriever) ?? null;
}

/** Whether a fallback is an error at registration: NODE_ENV=production, or DIALOGWRIGHT_REQUIRE_EMBEDDER=1. */
export function embedderRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'production' || env[REQUIRE_EMBEDDER_ENV] === '1';
}

/** The warning about a fallen-back retriever, once per retriever (none while quiet, none for one that did not fall back). */
export function warnFallback(retriever: object | undefined, label: string, warn: (line: string) => void = (line) => console.warn(line)): void {
  const why = fallbackOf(retriever);
  if (why === null || quiet > 0 || WARNED.has(retriever!)) return;
  WARNED.add(retriever!);
  warn(`dialogwright: ${label}: ${why} (with NODE_ENV=production or ${REQUIRE_EMBEDDER_ENV}=1 this is an error, and the server does not start)`);
}

/** At registration: an error when a fallback is not allowed (embedderRequired), else the warning. */
export function requireEmbedder(retriever: object | undefined, label: string, env: NodeJS.ProcessEnv = process.env): void {
  const why = fallbackOf(retriever);
  if (why === null) return;
  if (embedderRequired(env)) throw new Error(`${label}: ${why}; NODE_ENV=production or ${REQUIRE_EMBEDDER_ENV}=1 requires the embedder, so the app is not registered`);
  warnFallback(retriever, label);
}

/** Runs `fn` with no fallback warning said (check, which imports an app's code to check it). */
export async function withoutFallbackWarnings<T>(fn: () => Promise<T>): Promise<T> {
  quiet += 1;
  try {
    return await fn();
  } finally {
    quiet -= 1;
  }
}
