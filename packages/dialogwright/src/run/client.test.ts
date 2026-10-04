import { describe, expect, it } from 'vitest';
import { useTestkit } from '../testing/apps';
import { buildClient, buildThresholds, cassettePath, defaultCorpusFile, isClientKind, modelHeader, providerFor } from './client';
import { loadCorpus } from '../jev/corpus';
import { CassetteClient } from '../jev/cassette';
import { resolveJevProvider, UNCALIBRATED_WARNING } from '../jev/provider';
import type { QuestionMap } from '../jev/types';

/** The variables the provider is resolved from, cleared for a test and put back after it. */
const PROVIDER_VARS = ['JEV_PROVIDER', 'JEV_BASE_URL', 'JEV_MODEL', 'JEV_API_KEY', 'TYPESAFE_API_KEY', 'TYPESAFE_BASE_URL', 'OPENROUTER_API_KEY', 'AI_GATEWAY_API_KEY'];
function withEnv<T>(env: Record<string, string>, fn: () => T): T {
  const saved = Object.fromEntries(PROVIDER_VARS.map((k) => [k, process.env[k]]));
  for (const k of PROVIDER_VARS) delete process.env[k];
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    for (const k of PROVIDER_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

useTestkit();

const questions: QuestionMap = {
  intent: { type: 'choice', instructions: 'What does the caller want?', criteria: { cancel: null, none: null } },
};

const state = { asr: { text: 'zzz qqq wwww', isFinal: true }, activeForm: null };

describe('isClientKind', () => {
  it('accepts a listed kind and rejects anything else', () => {
    expect(isClientKind('recorded')).toBe(true);
    expect(isClientKind('nope')).toBe(false);
  });
});

describe('buildClient', () => {
  const t = buildThresholds([]);

  it('builds a heuristic client that answers from keywords', async () => {
    const r = await buildClient('heuristic', defaultCorpusFile(), t).ask({ state, questions });
    expect(r.source).toBe('stub:heuristic');
    expect(r.answers.intent).toBeDefined();
  });

  it('builds a fixture-backed stub client keyed on the corpus file', async () => {
    const client = buildClient('stub', defaultCorpusFile(), t);
    const corpusText = loadCorpus(defaultCorpusFile())[0]!.text;
    const keyed = await client.ask({ state: { ...state, asr: { text: corpusText, isFinal: true } }, questions });
    expect(keyed.source).toBe('stub:fixture');
    // an utterance the corpus does not label falls through to the heuristic
    const unlabelled = await client.ask({ state: { ...state, asr: { text: 'zzz qqq wwww', isFinal: true } }, questions });
    expect(unlabelled.source).toBe('stub:heuristic');
  });

  it('builds a replay-only cassette client for recorded', async () => {
    const r = buildClient('recorded', defaultCorpusFile(), t).ask({ state, questions });
    await expect(r).rejects.toThrow(/cassette miss/);
  });

  // Deterministic across machines only because every test that constructs jev or record clears
  // the provider's variables first; a bare buildClient('jev') here would issue a live request from
  // a shell that has the key exported. No test here asks a client built for jev or record.
  it('fails fast for jev and record when the provider\'s key is unset, naming it, and never needs one for recorded', () => {
    withEnv({}, () => {
      expect(() => buildClient('jev', defaultCorpusFile(), t)).toThrow('missing required environment variable TYPESAFE_API_KEY (JEV_PROVIDER=typesafe)');
      expect(() => buildClient('record', defaultCorpusFile(), t)).toThrow(/TYPESAFE_API_KEY/);
      expect(() => buildClient('recorded', defaultCorpusFile(), t)).not.toThrow();
    });
    withEnv({ JEV_PROVIDER: 'openrouter', TYPESAFE_API_KEY: 'test-key' }, () => {
      expect(() => buildClient('jev', defaultCorpusFile(), t)).toThrow(/OPENROUTER_API_KEY/);
    });
  });

  it('refuses a live client for an official provider resolved with no key, rather than send it an empty one', () => {
    const keyless = resolveJevProvider({ JEV_PROVIDER: 'openrouter' }, { needKey: false });
    expect(() => buildClient('jev', defaultCorpusFile(), t, undefined, keyless)).toThrow('missing required environment variable OPENROUTER_API_KEY (JEV_PROVIDER=openrouter)');
    expect(() => buildClient('record', defaultCorpusFile(), t, undefined, keyless)).toThrow(/OPENROUTER_API_KEY/);
  });

  it('builds a live client for the resolved provider, which says what answers', () => {
    const custom = resolveJevProvider({ JEV_PROVIDER: 'custom', JEV_BASE_URL: 'http://127.0.0.1:9', JEV_MODEL: 'open-jev-7b' });
    expect(buildClient('jev', defaultCorpusFile(), t, undefined, custom).answeredBy).toEqual({ provider: 'custom', model: 'open-jev-7b', official: false });
    withEnv({ JEV_PROVIDER: 'vercel', AI_GATEWAY_API_KEY: 'test-key' }, () => {
      expect(buildClient('jev', defaultCorpusFile(), t).answeredBy).toEqual({ provider: 'vercel', model: 'typesafe-ai/jev', official: true });
    });
  });

  it('records and replays each model in its own cassette, the pinned one by default', () => {
    withEnv({}, () => {
      const replay = buildClient('recorded', defaultCorpusFile(), t) as CassetteClient;
      expect(replay.path).toBe('src/testing/testkit/fixtures/recorded/jev-1.13.0.jsonl');
      expect(replay.answeredBy).toEqual({ provider: 'typesafe', model: 'jev-1.13.0', official: true });
    });
    withEnv({ JEV_PROVIDER: 'openrouter' }, () => {
      expect((buildClient('recorded', defaultCorpusFile(), t) as CassetteClient).path).toBe('src/testing/testkit/fixtures/recorded/typesafe__jev-1.13.jsonl');
    });
    const custom = resolveJevProvider({ JEV_PROVIDER: 'custom', JEV_BASE_URL: 'http://127.0.0.1:9', JEV_MODEL: 'open-jev-7b' });
    const record = buildClient('record', defaultCorpusFile(), t, undefined, custom) as CassetteClient;
    expect(record.path).toBe('src/testing/testkit/fixtures/recorded/open-jev-7b.jsonl');
    expect(record.answeredBy).toEqual({ provider: 'custom', model: 'open-jev-7b', official: false });
  });

  it('throws on an unknown kind, listing the valid ones', () => {
    expect(() => buildClient('nope', defaultCorpusFile(), t)).toThrow(/stub, heuristic, jev, record, recorded/);
  });
});

describe('cassettePath', () => {
  it('is one file per pinned model under the app\'s fixtures/recorded', () => {
    withEnv({}, () => expect(cassettePath()).toBe('src/testing/testkit/fixtures/recorded/jev-1.13.0.jsonl'));
    expect(cassettePath('jev-2.0.0')).toBe('src/testing/testkit/fixtures/recorded/jev-2.0.0.jsonl');
  });

  it('follows the resolved model, made safe to name a file', () => {
    withEnv({ JEV_PROVIDER: 'vercel' }, () => expect(cassettePath()).toBe('src/testing/testkit/fixtures/recorded/typesafe-ai__jev.jsonl'));
    expect(cassettePath('typesafe/jev-1.13')).toBe('src/testing/testkit/fixtures/recorded/typesafe__jev-1.13.jsonl');
  });
});

describe('providerFor and modelHeader', () => {
  const custom = resolveJevProvider({ JEV_PROVIDER: 'custom', JEV_BASE_URL: 'http://127.0.0.1:9', JEV_MODEL: 'open-jev-7b', JEV_API_KEY: 'test-key' });

  it('resolves a provider only for the kinds that ask a model or replay one, a key only for those that ask', () => {
    withEnv({}, () => {
      expect(providerFor('stub')).toBeNull();
      expect(providerFor('heuristic')).toBeNull();
      expect(providerFor('recorded')).toMatchObject({ provider: 'typesafe', model: 'jev-1.13.0', apiKey: null });
      expect(() => providerFor('jev')).toThrow(/TYPESAFE_API_KEY/);
      expect(() => providerFor('record')).toThrow(/TYPESAFE_API_KEY/);
    });
  });

  it('says which model answers a run, a replay as replayed, and nothing for a stub', () => {
    expect(modelHeader('stub', null)).toEqual([]);
    const official = resolveJevProvider({}, { needKey: false });
    expect(modelHeader('recorded', official)).toEqual(['model jev-1.13.0 from typesafe, replayed from its cassette']);
    expect(modelHeader('jev', custom)).toEqual(['model open-jev-7b from custom (http://127.0.0.1:9)', UNCALIBRATED_WARNING]);
  });

  it('warns once for a model that is not Jev, live, recording or replayed, and never for an official one', () => {
    for (const kind of ['jev', 'record', 'recorded'] as const) {
      expect(modelHeader(kind, custom).filter((l) => l === UNCALIBRATED_WARNING)).toHaveLength(1);
      expect(modelHeader(kind, resolveJevProvider({ JEV_PROVIDER: 'vercel', AI_GATEWAY_API_KEY: 'test-key' }))).not.toContain(UNCALIBRATED_WARNING);
    }
    expect(modelHeader('jev', custom).join('\n')).not.toContain('test-key');
  });
});
