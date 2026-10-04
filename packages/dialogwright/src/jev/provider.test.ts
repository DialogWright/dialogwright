import { describe, expect, it } from 'vitest';
import { cassetteFileName, JEV_PROVIDERS, modelLines, resolveJevProvider, UNCALIBRATED_WARNING } from './provider';
import { JEV_MODEL } from './sdkClient';

const KEY = 'test-key-5550001';

/** Every message a resolution throws, so a test can hold all of them to one rule. */
function thrown(env: Record<string, string>, needKey = true): string {
  try {
    resolveJevProvider(env, { needKey });
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error('expected the resolution to throw');
}

describe('resolveJevProvider', () => {
  it('lists the four providers', () => {
    expect([...JEV_PROVIDERS]).toEqual(['typesafe', 'openrouter', 'vercel', 'custom']);
  });

  it('defaults to TypeSafe itself, the pinned model and TYPESAFE_API_KEY', () => {
    expect(resolveJevProvider({ TYPESAFE_API_KEY: KEY })).toEqual({
      provider: 'typesafe', baseURL: 'https://api.typesafe.ai', model: JEV_MODEL, apiKey: KEY, keyVar: 'TYPESAFE_API_KEY', official: true,
    });
    expect(JEV_MODEL).toBe('jev-1.13.0');
  });

  it('knows OpenRouter and the Vercel AI Gateway, each with its own key variable and model id', () => {
    expect(resolveJevProvider({ JEV_PROVIDER: 'openrouter', OPENROUTER_API_KEY: KEY })).toEqual({
      provider: 'openrouter', baseURL: 'https://openrouter.ai/api', model: 'typesafe/jev-1.13', apiKey: KEY, keyVar: 'OPENROUTER_API_KEY', official: true,
    });
    expect(resolveJevProvider({ JEV_PROVIDER: 'vercel', AI_GATEWAY_API_KEY: KEY })).toEqual({
      provider: 'vercel', baseURL: 'https://ai-gateway.vercel.sh/typesafe', model: 'typesafe-ai/jev', apiKey: KEY, keyVar: 'AI_GATEWAY_API_KEY', official: true,
    });
  });

  it('reads only the chosen provider\'s key variable', () => {
    expect(thrown({ JEV_PROVIDER: 'openrouter', TYPESAFE_API_KEY: KEY })).toMatch(/OPENROUTER_API_KEY/);
    expect(thrown({ JEV_PROVIDER: 'vercel', OPENROUTER_API_KEY: KEY })).toMatch(/AI_GATEWAY_API_KEY/);
  });

  it('takes JEV_BASE_URL and JEV_MODEL as overrides, trailing slashes trimmed, and an official provider stays official', () => {
    const p = resolveJevProvider({ TYPESAFE_API_KEY: KEY, JEV_BASE_URL: 'https://jev.example.test/', JEV_MODEL: 'jev-1.14.0' });
    expect(p).toMatchObject({ provider: 'typesafe', baseURL: 'https://jev.example.test', model: 'jev-1.14.0', official: true });
  });

  it('keeps honoring the SDK\'s own TYPESAFE_BASE_URL for the typesafe provider, below JEV_BASE_URL', () => {
    expect(resolveJevProvider({ TYPESAFE_API_KEY: KEY, TYPESAFE_BASE_URL: 'https://staging.example.test' }).baseURL).toBe('https://staging.example.test');
    expect(resolveJevProvider({ TYPESAFE_API_KEY: KEY, TYPESAFE_BASE_URL: 'https://staging.example.test', JEV_BASE_URL: 'https://jev.example.test' }).baseURL).toBe('https://jev.example.test');
    expect(resolveJevProvider({ JEV_PROVIDER: 'openrouter', OPENROUTER_API_KEY: KEY, TYPESAFE_BASE_URL: 'https://staging.example.test' }).baseURL).toBe('https://openrouter.ai/api');
  });

  it('names the exact variable a missing key belongs in', () => {
    expect(thrown({})).toBe('missing required environment variable TYPESAFE_API_KEY (JEV_PROVIDER=typesafe)');
    expect(thrown({ JEV_PROVIDER: 'openrouter' })).toBe('missing required environment variable OPENROUTER_API_KEY (JEV_PROVIDER=openrouter)');
    expect(thrown({ JEV_PROVIDER: 'vercel', AI_GATEWAY_API_KEY: '   ' })).toBe('missing required environment variable AI_GATEWAY_API_KEY (JEV_PROVIDER=vercel)');
  });

  it('needs no key to replay a cassette', () => {
    expect(resolveJevProvider({}, { needKey: false })).toMatchObject({ provider: 'typesafe', model: JEV_MODEL, apiKey: null });
    expect(resolveJevProvider({ JEV_PROVIDER: 'openrouter' }, { needKey: false })).toMatchObject({ model: 'typesafe/jev-1.13', apiKey: null });
  });

  it('refuses an unknown provider, listing the valid ones', () => {
    expect(thrown({ JEV_PROVIDER: 'acme' })).toBe('JEV_PROVIDER must be typesafe, openrouter, vercel or custom, got "acme"');
  });

  it('needs JEV_BASE_URL and JEV_MODEL for a custom endpoint, and its key is optional', () => {
    expect(thrown({ JEV_PROVIDER: 'custom', JEV_MODEL: 'open-jev-7b' })).toBe('missing required environment variable JEV_BASE_URL (JEV_PROVIDER=custom)');
    expect(thrown({ JEV_PROVIDER: 'custom', JEV_BASE_URL: 'http://127.0.0.1:8080' })).toBe('missing required environment variable JEV_MODEL (JEV_PROVIDER=custom)');
    expect(resolveJevProvider({ JEV_PROVIDER: 'custom', JEV_BASE_URL: 'http://127.0.0.1:8080', JEV_MODEL: 'open-jev-7b' })).toEqual({
      provider: 'custom', baseURL: 'http://127.0.0.1:8080', model: 'open-jev-7b', apiKey: null, keyVar: 'JEV_API_KEY', official: false,
    });
    expect(resolveJevProvider({ JEV_PROVIDER: 'custom', JEV_BASE_URL: 'https://jev.example.test/v2', JEV_MODEL: 'open-jev-7b', JEV_API_KEY: KEY }).apiKey).toBe(KEY);
  });

  it('refuses plain http to another machine, and allows it to this one', () => {
    for (const url of ['http://jev.example.test', 'http://10.0.0.5:8080', 'http://localhost.example.test']) {
      expect(thrown({ JEV_PROVIDER: 'custom', JEV_BASE_URL: url, JEV_MODEL: 'm' })).toMatch(/JEV_BASE_URL must be https unless its host is localhost, 127\.0\.0\.1 or \[::1\]/);
    }
    for (const url of ['http://localhost:8080', 'http://127.0.0.1:8080/jev', 'http://[::1]:8080']) {
      expect(resolveJevProvider({ JEV_PROVIDER: 'custom', JEV_BASE_URL: url, JEV_MODEL: 'm' }).baseURL).toBe(url);
    }
    expect(thrown({ TYPESAFE_API_KEY: KEY, JEV_BASE_URL: 'http://jev.example.test' })).toMatch(/must be https/);
    expect(thrown({ TYPESAFE_API_KEY: KEY, TYPESAFE_BASE_URL: 'http://jev.example.test' })).toMatch(/TYPESAFE_BASE_URL must be https/);
    expect(thrown({ JEV_PROVIDER: 'custom', JEV_BASE_URL: 'ftp://jev.example.test', JEV_MODEL: 'm' })).toMatch(/must be https/);
    expect(thrown({ JEV_PROVIDER: 'custom', JEV_BASE_URL: 'not a url', JEV_MODEL: 'm' })).toMatch(/JEV_BASE_URL must be a URL/);
  });

  it('never puts a key in an error message', () => {
    const envs: Record<string, string>[] = [
      { JEV_PROVIDER: 'acme', TYPESAFE_API_KEY: KEY },
      { JEV_PROVIDER: 'openrouter', TYPESAFE_API_KEY: KEY, AI_GATEWAY_API_KEY: KEY },
      { JEV_PROVIDER: 'custom', JEV_API_KEY: KEY, JEV_MODEL: 'm' },
      { JEV_PROVIDER: 'custom', JEV_API_KEY: KEY, JEV_BASE_URL: 'http://jev.example.test', JEV_MODEL: 'm' },
      { JEV_PROVIDER: 'custom', JEV_API_KEY: KEY, JEV_BASE_URL: `http://${KEY}@jev.example.test`, JEV_MODEL: 'm' },
      { TYPESAFE_API_KEY: KEY, JEV_BASE_URL: `http://user:${KEY}@jev.example.test` },
      { TYPESAFE_API_KEY: KEY, JEV_BASE_URL: `${KEY} is not a url` },
    ];
    for (const env of envs) expect(thrown(env)).not.toContain(KEY);
  });
});

describe('cassetteFileName', () => {
  it('is the pinned model\'s existing file by default', () => {
    expect(cassetteFileName(resolveJevProvider({}, { needKey: false }).model)).toBe('jev-1.13.0.jsonl');
  });

  it('makes a slashed or otherwise unsafe model id safe to name a file', () => {
    expect(cassetteFileName('typesafe/jev-1.13')).toBe('typesafe__jev-1.13.jsonl');
    expect(cassetteFileName('typesafe-ai/jev')).toBe('typesafe-ai__jev.jsonl');
    expect(cassetteFileName('org\\model:7b q4')).toBe('org__model_7b_q4.jsonl');
    expect(cassetteFileName('../../etc')).toBe('..__..__etc.jsonl');
    expect(cassetteFileName('../../etc')).not.toContain('/');
  });
});

describe('modelLines', () => {
  const official = resolveJevProvider({ TYPESAFE_API_KEY: KEY });
  const custom = resolveJevProvider({ JEV_PROVIDER: 'custom', JEV_BASE_URL: 'http://127.0.0.1:8080', JEV_MODEL: 'open-jev-7b', JEV_API_KEY: KEY });

  it('names the provider and model, and never the key', () => {
    expect(modelLines(official)).toEqual(['model jev-1.13.0 from typesafe (https://api.typesafe.ai)']);
    for (const l of [...modelLines(official), ...modelLines(custom)]) expect(l).not.toContain(KEY);
  });

  it('warns once, for a model that is not Jev, that its probabilities are not Jev\'s', () => {
    const lines = modelLines(custom);
    expect(lines[0]).toBe('model open-jev-7b from custom (http://127.0.0.1:8080)');
    expect(lines.filter((l) => l === UNCALIBRATED_WARNING)).toHaveLength(1);
    expect(UNCALIBRATED_WARNING).toMatch(/not Jev's/);
    expect(UNCALIBRATED_WARNING).toMatch(/re-measur/);
    expect(UNCALIBRATED_WARNING).toMatch(/regress/);
    for (const p of [official, resolveJevProvider({ JEV_PROVIDER: 'openrouter', OPENROUTER_API_KEY: KEY }), resolveJevProvider({ JEV_PROVIDER: 'vercel', AI_GATEWAY_API_KEY: KEY })]) {
      expect(modelLines(p)).not.toContain(UNCALIBRATED_WARNING);
    }
  });
});
