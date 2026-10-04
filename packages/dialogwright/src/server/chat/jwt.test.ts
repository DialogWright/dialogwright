import { createHmac, generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyJwt } from './jwt';

/** Keys are made here, for this run, and never stored. */
const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');
function makeJwt(alg: 'RS256' | 'ES256' | 'EdDSA', key: KeyObject, kid: string, claims: Record<string, unknown>, header: Record<string, unknown> = {}): string {
  const head = b64url(JSON.stringify({ alg, kid, typ: 'JWT', ...header }));
  const body = b64url(JSON.stringify(claims));
  const input = Buffer.from(`${head}.${body}`);
  const sig = alg === 'EdDSA' ? cryptoSign(null, input, key)
    : alg === 'ES256' ? cryptoSign('sha256', input, { key, dsaEncoding: 'ieee-p1363' })
    : cryptoSign('sha256', input, key);
  return `${head}.${body}.${b64url(sig)}`;
}

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const ed = generateKeyPairSync('ed25519');
const ec384 = generateKeyPairSync('ec', { namedCurve: 'P-384' });
const rsaShort = generateKeyPairSync('rsa', { modulusLength: 1024 });
const keys = new Map([['r1', rsa.publicKey], ['e1', ec.publicKey], ['d1', ed.publicKey], ['p384', ec384.publicKey], ['short', rsaShort.publicKey]]);
const lookup = async (kid: string) => keys.get(kid) ?? null;
const NOW = 1_700_000_000;
const good = { iss: 'https://id.example.com', aud: 'chat', sub: '55501234', exp: NOW + 300, iat: NOW - 10 };
const want = { issuer: 'https://id.example.com', audience: 'chat', nowSec: NOW };

describe('JWT verification', () => {
  it('accepts RS256, ES256 and EdDSA tokens from the published keys', async () => {
    for (const [alg, k, kid] of [['RS256', rsa.privateKey, 'r1'], ['ES256', ec.privateKey, 'e1'], ['EdDSA', ed.privateKey, 'd1']] as const) {
      const r = await verifyJwt(makeJwt(alg, k, kid, good), lookup, want);
      expect(r.ok, alg).toBe(true);
      expect(r).toMatchObject({ claims: { sub: '55501234' } });
    }
  });

  it('refuses alg none, HMAC, an unknown kid and a key of the wrong type', async () => {
    const parts = makeJwt('RS256', rsa.privateKey, 'r1', good).split('.');
    const none = `${b64url(JSON.stringify({ alg: 'none', kid: 'r1' }))}.${parts[1]}.`;
    expect(await verifyJwt(none, lookup, want)).toEqual({ ok: false, reason: 'algorithm' });
    // HMAC keyed with what a confused verifier might take for the secret: the public key's own bytes.
    const hsHead = b64url(JSON.stringify({ alg: 'HS256', kid: 'r1' }));
    const hsSig = createHmac('sha256', rsa.publicKey.export({ format: 'pem', type: 'spki' })).update(`${hsHead}.${parts[1]}`).digest();
    expect(await verifyJwt(`${hsHead}.${parts[1]}.${b64url(hsSig)}`, lookup, want)).toEqual({ ok: false, reason: 'algorithm' });
    expect(await verifyJwt(makeJwt('RS256', rsa.privateKey, 'nope', good), lookup, want)).toEqual({ ok: false, reason: 'unknown key' });
    expect(await verifyJwt(makeJwt('RS256', rsa.privateKey, 'r1', good, { kid: 7 }), lookup, want)).toEqual({ ok: false, reason: 'unknown key' });
    expect(await verifyJwt(makeJwt('ES256', ec.privateKey, 'r1', good), lookup, want)).toEqual({ ok: false, reason: 'algorithm' });
    expect(await verifyJwt(makeJwt('EdDSA', ed.privateKey, 'e1', good), lookup, want)).toEqual({ ok: false, reason: 'algorithm' });
  });

  it('refuses an EC key off P-256, an RSA key under 2048 bits, and a header it must understand but does not', async () => {
    expect(await verifyJwt(makeJwt('ES256', ec384.privateKey, 'p384', good), lookup, want)).toEqual({ ok: false, reason: 'algorithm' });
    expect(await verifyJwt(makeJwt('RS256', rsaShort.privateKey, 'short', good), lookup, want)).toEqual({ ok: false, reason: 'algorithm' });
    expect(await verifyJwt(makeJwt('RS256', rsa.privateKey, 'r1', good, { crit: ['exp'] }), lookup, want)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('checks issuer, audience, expiry and not-before with a minute of skew', async () => {
    const t = (c: Record<string, unknown>) => verifyJwt(makeJwt('RS256', rsa.privateKey, 'r1', { ...good, ...c }), lookup, want);
    expect(await t({ iss: 'https://evil.test' })).toEqual({ ok: false, reason: 'issuer' });
    expect(await t({ aud: ['other', 'chat'] })).toMatchObject({ ok: true });
    expect(await t({ aud: 'other' })).toEqual({ ok: false, reason: 'audience' });
    expect(await t({ aud: undefined })).toEqual({ ok: false, reason: 'audience' });
    expect(await t({ exp: NOW - 61 })).toEqual({ ok: false, reason: 'expired' });
    expect(await t({ exp: NOW - 30 })).toMatchObject({ ok: true });
    expect(await t({ exp: undefined })).toEqual({ ok: false, reason: 'expired' });
    expect(await t({ exp: String(NOW + 300) })).toEqual({ ok: false, reason: 'expired' });
    expect(await t({ nbf: NOW + 61 })).toEqual({ ok: false, reason: 'not yet valid' });
    expect(await t({ nbf: NOW + 30 })).toMatchObject({ ok: true });
    expect(await t({ iat: NOW + 61 })).toEqual({ ok: false, reason: 'not yet valid' });
  });

  it('refuses a tampered payload, and what is not a compact JWS', async () => {
    const [h, , s] = makeJwt('RS256', rsa.privateKey, 'r1', good).split('.');
    expect(await verifyJwt(`${h}.${b64url(JSON.stringify({ ...good, sub: 'someone-else' }))}.${s}`, lookup, want)).toEqual({ ok: false, reason: 'signature' });
    for (const bad of ['', 'a.b', 'a.b.c.d', 'x.y.z', `${b64url('[1]')}.${b64url('{}')}.`]) {
      expect(await verifyJwt(bad, lookup, want), bad).toMatchObject({ ok: false, reason: 'malformed' });
    }
  });

  it('never puts the token in a reason', async () => {
    const token = makeJwt('RS256', rsa.privateKey, 'r1', { ...good, iss: 'https://evil.test' });
    const r = await verifyJwt(token, lookup, want);
    expect(JSON.stringify(r)).not.toContain(token.split('.')[2]);
  });
});
