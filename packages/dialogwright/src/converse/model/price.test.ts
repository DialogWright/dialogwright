import { describe, expect, it } from 'vitest';
import { addModelPrice, costUsd } from './price';

describe('costUsd', () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
  it('prices the candidates', () => {
    expect(costUsd('inception:mercury-3', usage)).toBeCloseTo(0.9);
    expect(costUsd('anthropic:claude-haiku-5-5', usage)).toBeGreaterThan(0);
    expect(costUsd('anthropic:claude-sonnet-5-5', usage)).toBeNull(); // unverified until confirmed
  });
  it('is null for an unknown model, and a model added is priced', () => {
    expect(costUsd('openrouter:vendor/unknown-test', usage)).toBeNull();
    addModelPrice('openrouter:vendor/unknown-test', { input: 1, output: 2 });
    expect(costUsd('openrouter:vendor/unknown-test', usage)).toBe(3);
  });
});
