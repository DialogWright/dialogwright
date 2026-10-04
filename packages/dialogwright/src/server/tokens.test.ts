import { describe, expect, it } from 'vitest';
import { CallTokens, sameToken } from './tokens';

describe('CallTokens', () => {
  it('mints a token bound to a call and verifies it once per call', () => {
    let t = 0;
    const tokens = new CallTokens(1000, () => t);
    const tok = tokens.mint('CA1');
    expect(tok).toMatch(/^[0-9a-f]{32}$/);
    expect(tokens.verify(tok, 'CA1', 'twilio')).toBe(true);
    expect(tokens.verify(tok, 'CA2', 'twilio')).toBe(false);
    expect(tokens.verify('nope', 'CA1', 'twilio')).toBe(false);
  });

  it('compares tokens in constant time, and a wrong length or a near miss never matches', () => {
    expect(sameToken('a'.repeat(32), 'a'.repeat(32))).toBe(true);
    expect(sameToken('a'.repeat(32), 'a'.repeat(31) + 'b')).toBe(false);
    expect(sameToken('a'.repeat(32), 'a'.repeat(31))).toBe(false);
    expect(sameToken('', '')).toBe(true);
    const tokens = new CallTokens(1000, () => 0);
    const tok = tokens.mint('CA1');
    expect(tokens.verify(tok.slice(0, 31), 'CA1', 'twilio')).toBe(false);
    expect(tokens.verify(tok + '0', 'CA1', 'twilio')).toBe(false);
    expect(tokens.verify('', 'CA1', 'twilio')).toBe(false);
    expect(tokens.has(tok.slice(0, 31), 'twilio')).toBe(false);
    expect(tokens.has('', 'twilio')).toBe(false);
  });

  it('expires tokens', () => {
    let t = 0;
    const tokens = new CallTokens(1000, () => t);
    const tok = tokens.mint('CA1');
    t = 1001;
    expect(tokens.verify(tok, 'CA1', 'twilio')).toBe(false);
  });

  it('a new mint for the same call replaces the old token', () => {
    const tokens = new CallTokens(1000, () => 0);
    const a = tokens.mint('CA1');
    const b = tokens.mint('CA1');
    expect(tokens.verify(a, 'CA1', 'twilio')).toBe(false);
    expect(tokens.verify(b, 'CA1', 'twilio')).toBe(true);
  });

  it('has() finds a live token without knowing its call, and never an expired or unminted one', () => {
    let t = 0;
    const tokens = new CallTokens(1000, () => t);
    const a = tokens.mint('CA1');
    const b = tokens.mint('CA2');
    expect(tokens.has(a, 'twilio')).toBe(true);
    expect(tokens.has(b, 'twilio')).toBe(true);
    expect(tokens.has('f'.repeat(32), 'twilio')).toBe(false);
    tokens.revoke('CA1');
    expect(tokens.has(a, 'twilio')).toBe(false);
    t = 1001;
    expect(tokens.has(b, 'twilio')).toBe(false);
  });

  it('evicts expired tokens for calls that never connect', () => {
    let t = 0;
    const tokens = new CallTokens(1000, () => t);
    const a = tokens.mint('CA1');
    const b = tokens.mint('CA2');
    t = 1001;
    expect(tokens.evictExpired()).toBe(2);
    expect(tokens.verify(a, 'CA1', 'twilio')).toBe(false);
    expect(tokens.verify(b, 'CA2', 'twilio')).toBe(false);
  });

  it("binds a token to the carrier it was minted for: another carrier's socket never takes it", () => {
    const tokens = new CallTokens(1000, () => 0);
    const tw = tokens.mint('CA1', 'twilio');
    const tx = tokens.mint('v2:abc', 'telnyx');
    expect(tokens.verify(tw, 'CA1', 'twilio')).toBe(true);
    expect(tokens.verify(tw, 'CA1', 'telnyx')).toBe(false);
    expect(tokens.verify(tx, 'v2:abc', 'telnyx')).toBe(true);
    expect(tokens.verify(tx, 'v2:abc', 'twilio')).toBe(false);
    expect(tokens.has(tw, 'twilio')).toBe(true);
    expect(tokens.has(tw, 'telnyx')).toBe(false);
    expect(tokens.has(tx, 'telnyx')).toBe(true);
    expect(tokens.has(tx, 'twilio')).toBe(false);
  });

  it("mints for Twilio when no carrier is named, as the legacy /voice always did", () => {
    const tokens = new CallTokens(1000, () => 0);
    const tok = tokens.mint('CA1');
    expect(tokens.verify(tok, 'CA1', 'twilio')).toBe(true);
    expect(tokens.verify(tok, 'CA1', 'telnyx')).toBe(false);
    expect(tokens.has(tok, 'telnyx')).toBe(false);
  });
});
