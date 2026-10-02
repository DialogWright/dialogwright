import { describe, expect, it } from 'vitest';
import { atLeast, DEFAULT_THRESHOLDS, THRESHOLD_EPSILON, withOverrides, parseOverride } from './thresholds';

describe('thresholds', () => {
  it('applies a single override without mutating defaults', () => {
    const before = DEFAULT_THRESHOLDS.INTENT_ROUTE;
    const t = withOverrides({ INTENT_ROUTE: 0.9 });
    expect(t.INTENT_ROUTE).toBe(0.9);
    expect(DEFAULT_THRESHOLDS.INTENT_ROUTE).toBe(before);
  });

  it('parses NAME=VALUE strings', () => {
    expect(parseOverride('GATE_ADDRESSED=0.5')).toEqual({ GATE_ADDRESSED: 0.5 });
  });

  it('rejects unknown names', () => {
    expect(() => parseOverride('NOPE=1')).toThrow(/unknown threshold/);
  });

  it('rejects prototype-chain names', () => {
    expect(() => parseOverride('constructor=1')).toThrow(/unknown threshold/);
  });

  it('rejects specs with multiple equals signs', () => {
    expect(() => parseOverride('INTENT_ROUTE=0.5=1')).toThrow(/bad threshold override/);
  });

  it('rejects empty values', () => {
    expect(() => parseOverride('INTENT_ROUTE=')).toThrow(/bad threshold value/);
  });

  it('atLeast meets a threshold a floating-point sum or difference misses by rounding, and nothing further below', () => {
    expect(0.7 - 0.3).toBe(0.39999999999999997);
    expect(0.7 - 0.3 >= 0.4).toBe(false);
    expect(atLeast(0.7 - 0.3, 0.4)).toBe(true);
    expect(atLeast(0.6 - 0.45, 0.15)).toBe(true);
    expect(atLeast(0.4, 0.4)).toBe(true);
    expect(atLeast(0.41, 0.4)).toBe(true);
    expect(atLeast(0.4 - 10 * THRESHOLD_EPSILON, 0.4)).toBe(false);
    expect(atLeast(0.39, 0.4)).toBe(false);
  });
});
