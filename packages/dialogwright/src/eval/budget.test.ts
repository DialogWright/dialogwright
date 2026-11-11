import { describe, expect, it } from 'vitest';
import { Budget } from './budget';

describe('Budget', () => {
  it('accumulates the cost of a priced model', () => {
    const b = new Budget(1);
    b.add('anthropic:claude-haiku-5-5', { inputTokens: 1_000_000, outputTokens: 0 });
    expect(b.spent()).toBeCloseTo(0.1);
    b.add('anthropic:claude-haiku-5-5', { inputTokens: 0, outputTokens: 1_000_000 });
    expect(b.spent()).toBeCloseTo(0.6);
    expect(b.left()).toBeCloseTo(0.4);
  });

  it('counts an unpriced model as 0 and warns once', () => {
    const warnings: string[] = [];
    const b = new Budget(1, (l) => warnings.push(l));
    b.add('anthropic:unpriced-model', { inputTokens: 5_000_000, outputTokens: 5_000_000 });
    b.add('anthropic:unpriced-model', { inputTokens: 5_000_000, outputTokens: 5_000_000 });
    expect(b.spent()).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('anthropic:unpriced-model');
  });

  it('is exceeded only past the limit', () => {
    const b = new Budget(0.5);
    b.add('anthropic:claude-haiku-5-5', { inputTokens: 0, outputTokens: 1_000_000 });
    expect(b.exceeded()).toBe(false);
    b.add('anthropic:claude-haiku-5-5', { inputTokens: 1, outputTokens: 1 });
    expect(b.exceeded()).toBe(true);
    expect(b.left()).toBe(0);
  });
});
