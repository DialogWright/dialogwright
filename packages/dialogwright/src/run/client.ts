import { parseOverride, withOverrides, type Thresholds } from '../core/thresholds';
import { defaultAppOrNull } from '../core/app/registry';
import { loadCorpus } from '../jev/corpus';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { CassetteClient } from '../jev/cassette';
import { SdkJevClient } from '../jev/sdkClient';
import { cassetteFileName, modelLines, resolveJevProvider, type JevProvider } from '../jev/provider';
import type { AnsweredBy, JevClient } from '../jev/types';
import { defaultCorpusFile, recordedDir } from './fixtures';

export { defaultCorpusFile };

/** The run's `--threshold NAME=VALUE` overrides: an engine threshold's, or one of the default app's own (App.thresholds). */
export function buildThresholds(overrides: string[]): Thresholds {
  const own = defaultAppOrNull()?.thresholds;
  return withOverrides(Object.assign({}, ...overrides.map((spec) => parseOverride(spec, own))));
}

export const CLIENT_KINDS = ['stub', 'heuristic', 'jev', 'record', 'recorded'] as const;
export type ClientKind = (typeof CLIENT_KINDS)[number];

export function isClientKind(kind: string): kind is ClientKind {
  return (CLIENT_KINDS as readonly string[]).includes(kind);
}

/**
 * The provider a run of this kind reaches the model through (jev/provider.ts): none for the stubs,
 * which ask no model; resolved without a key for a replay, which sends nothing; with one otherwise.
 */
export function providerFor(kind: ClientKind, env: Record<string, string | undefined> = process.env): JevProvider | null {
  if (kind === 'stub' || kind === 'heuristic') return null;
  return resolveJevProvider(env, { needKey: kind !== 'recorded' });
}

/** The lines a run prints first about its model (jev/provider.ts modelLines); none for a stub. */
export function modelHeader(kind: ClientKind, provider: JevProvider | null): string[] {
  return provider ? modelLines(provider, { replayed: kind === 'recorded' }) : [];
}

/**
 * One cassette per model: a model bump, or another provider's model, gets a fresh file, and never
 * touches the pinned one. Left out, the model is the resolved provider's (jev/provider.ts), which
 * with nothing set is the pinned JEV_MODEL's `jev-1.13.0.jsonl`.
 */
export function cassettePath(model: string = resolveJevProvider(process.env, { needKey: false }).model): string {
  return `${recordedDir()}/${cassetteFileName(model)}`;
}

function answeredByOf(p: JevProvider): AnsweredBy {
  return { provider: p.provider, model: p.model, official: p.official };
}

/**
 * The cassette checks that every line was answered by the model it is named for. Only TypeSafe
 * itself is known to answer with the id it was asked for; a gateway may name the model its own
 * way, so its cassette is kept apart by its file name alone.
 */
function expectModelOf(p: JevProvider): { expectModel: string } | Record<string, never> {
  return p.provider === 'typesafe' ? { expectModel: p.model } : {};
}

/**
 * The replay of the resolved model's cassette (`--client recorded`, and the trim): no key needed,
 * since nothing is sent. Loaded at once, so a corrupt file fails before the run does.
 */
export function recordedCassette(provider: JevProvider = resolveJevProvider(process.env, { needKey: false })): CassetteClient {
  const client = new CassetteClient({ path: cassettePath(provider.model), mode: 'replay', answeredBy: answeredByOf(provider), ...expectModelOf(provider) });
  client.preload();
  return client;
}

/**
 * `todayIso` is the run's date, for the clients that read one. Only the heuristic stub does: it
 * decides which spans read as a birth year, and a run that pins RunOptions.todayIso wants its
 * fallback answers pinned to the same day. Left out (the server) it is the wall clock.
 *
 * `corpusFile` is the fixture stub's corpus; left out, it is the default app's (App.fixtures), read
 * only by that stub, so the clients that need no fixtures need no app with them.
 *
 * `provider` is where jev, record and recorded reach the model (jev/provider.ts); left out, it is
 * resolved from the environment, a key required for jev and record. The stubs never read it.
 */
export function buildClient(kind: string, corpusFile: string | undefined, thresholds: Thresholds, todayIso?: string, provider?: JevProvider): JevClient {
  if (!isClientKind(kind)) throw new Error(`unknown client kind "${kind}"; expected one of ${CLIENT_KINDS.join(', ')}`);
  const heuristic = (): HeuristicStubClient => new HeuristicStubClient(todayIso === undefined ? {} : { todayIso });
  const endpoint = (needKey: boolean): JevProvider => provider ?? resolveJevProvider(process.env, { needKey });
  const live = (p: JevProvider): SdkJevClient => {
    // A provider resolved for a replay has no key; an official one is never sent an empty one.
    if (p.official && !p.apiKey) throw new Error(`missing required environment variable ${p.keyVar} (JEV_PROVIDER=${p.provider})`);
    return new SdkJevClient({ endpoint: p, timeoutMs: thresholds.JEV_TIMEOUT_MS });
  };
  switch (kind) {
    case 'stub':
      return new FixtureStubClient(loadCorpus(corpusFile ?? defaultCorpusFile()), { sharpness: thresholds.STUB_SHARPNESS, fallback: heuristic() });
    case 'heuristic':
      return heuristic();
    case 'jev':
      return live(endpoint(true));
    case 'record': {
      const p = endpoint(true);
      const client = new CassetteClient({ path: cassettePath(p.model), mode: 'record', inner: live(p), ...expectModelOf(p) });
      client.preload();
      return client;
    }
    case 'recorded':
      return recordedCassette(provider);
  }
}
