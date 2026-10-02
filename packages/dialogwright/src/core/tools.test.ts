import { describe, expect, it } from 'vitest';
import { mockCodeVerifier } from './tools';

describe('mockCodeVerifier', () => {
  it('accepts any six digits ending in an even digit and nothing else', () => {
    expect(mockCodeVerifier.check('123456')).toBe(true);
    expect(mockCodeVerifier.check('123450')).toBe(true);
    expect(mockCodeVerifier.check('123457')).toBe(false);
    expect(mockCodeVerifier.check('12345')).toBe(false);
    expect(mockCodeVerifier.check('12345a')).toBe(false);
  });
});
