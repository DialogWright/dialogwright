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

  it('accepts a code of four to eight digits, the lengths identity.yaml allows, and no other', () => {
    expect(mockCodeVerifier.check('1234')).toBe(true);
    expect(mockCodeVerifier.check('12345678')).toBe(true);
    expect(mockCodeVerifier.check('1235')).toBe(false);
    expect(mockCodeVerifier.check('124')).toBe(false);
    expect(mockCodeVerifier.check('123456780')).toBe(false);
  });
});
