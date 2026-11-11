import { describe, expect, it } from 'vitest';
import { addModelPrice, costUsd, priceOf } from './price';

describe('costUsd', () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
  it('prices the candidates', () => {
    expect(costUsd('inception:mercury-3', usage)).toBeCloseTo(0.9);
    expect(costUsd('anthropic:claude-haiku-5-5', usage)).toBeCloseTo(0.6);
    expect(costUsd('anthropic:claude-sonnet-5-5', usage)).toBeCloseTo(12);
    expect(costUsd('meta:muse-ember-1.0', usage)).toBeCloseTo(0.6);
    expect(costUsd('meta:muse-spark-1.3', usage)).toBeCloseTo(5.5);
    expect(costUsd('openrouter:openai/gpt-oss-120b@groq', usage)).toBeCloseTo(0.75);
  });
  it('says where each price came from', () => {
    for (const id of ['inception:mercury-3', 'anthropic:claude-haiku-5-5', 'anthropic:claude-sonnet-5-5', 'meta:muse-ember-1.0']) expect(priceOf(id)?.source).toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(priceOf('openrouter:vendor/never-priced')).toBeNull();
  });
  it('is null for an unknown model, and a model added is priced', () => {
    expect(costUsd('openrouter:vendor/unknown-test', usage)).toBeNull();
    addModelPrice('openrouter:vendor/unknown-test', { input: 1, output: 2, source: 'a test, 2026-11-11' });
    expect(costUsd('openrouter:vendor/unknown-test', usage)).toBe(3);
  });
});
