import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TELNYX_TOLERANCE_SEC, telnyxPublicKey, verifyTelnyxSignature } from './telnyxSignature';

// A key pair made here: the test needs no secret from anywhere.
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicKeyB64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const signed = (timestamp: string, body: string): string => sign(null, Buffer.from(`${timestamp}|${body}`), privateKey).toString('base64');

describe('Telnyx webhook signatures', () => {
  const body = 'CallSid=v2%3Aabc&From=%2B15555550100';

  it('accepts the account key over timestamp|body', () => {
    expect(verifyTelnyxSignature({ signature: signed('1000', body), timestamp: '1000', rawBody: body, nowSec: 1000 }, publicKeyB64)).toBe(true);
  });

  it('refuses a changed body, a wrong key, a missing header and a malformed timestamp', () => {
    expect(verifyTelnyxSignature({ signature: signed('1000', body), timestamp: '1000', rawBody: body + 'x', nowSec: 1000 }, publicKeyB64)).toBe(false);
    const other = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    expect(verifyTelnyxSignature({ signature: signed('1000', body), timestamp: '1000', rawBody: body, nowSec: 1000 }, other)).toBe(false);
    expect(verifyTelnyxSignature({ signature: undefined, timestamp: '1000', rawBody: body, nowSec: 1000 }, publicKeyB64)).toBe(false);
    expect(verifyTelnyxSignature({ signature: signed('1000', body), timestamp: undefined, rawBody: body, nowSec: 1000 }, publicKeyB64)).toBe(false);
    expect(verifyTelnyxSignature({ signature: signed('1e3', body), timestamp: '1e3', rawBody: body, nowSec: 1000 }, publicKeyB64)).toBe(false);
    expect(verifyTelnyxSignature({ signature: 'not base64 at all', timestamp: '1000', rawBody: body, nowSec: 1000 }, publicKeyB64)).toBe(false);
    expect(verifyTelnyxSignature({ signature: signed('1000', body), timestamp: '1000', rawBody: body, nowSec: 1000 }, 'bm90IGEga2V5')).toBe(false);
  });

  it('refuses a timestamp outside the tolerance, either way, and accepts one at its edge', () => {
    const t = '1000';
    expect(verifyTelnyxSignature({ signature: signed(t, body), timestamp: t, rawBody: body, nowSec: 1000 + TELNYX_TOLERANCE_SEC + 1 }, publicKeyB64)).toBe(false);
    expect(verifyTelnyxSignature({ signature: signed(t, body), timestamp: t, rawBody: body, nowSec: 1000 - TELNYX_TOLERANCE_SEC - 1 }, publicKeyB64)).toBe(false);
    expect(verifyTelnyxSignature({ signature: signed(t, body), timestamp: t, rawBody: body, nowSec: 1000 + TELNYX_TOLERANCE_SEC }, publicKeyB64)).toBe(true);
  });

  it('accepts the bare 32-byte base64 key Telnyx shows, as well as SPKI DER', () => {
    const raw = publicKey.export({ format: 'jwk' }).x!; // base64url of the 32 raw bytes
    const bare = Buffer.from(raw, 'base64url').toString('base64');
    expect(verifyTelnyxSignature({ signature: signed('1000', body), timestamp: '1000', rawBody: body, nowSec: 1000 }, bare)).toBe(true);
    expect(telnyxPublicKey(` ${bare}\n`).asymmetricKeyType).toBe('ed25519');
  });

  it('refuses a key that is not an Ed25519 public key', () => {
    expect(() => telnyxPublicKey('bm90IGEga2V5')).toThrow();
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    expect(() => telnyxPublicKey(rsa)).toThrow('not an Ed25519 key');
  });
});
