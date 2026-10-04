import { verify, type KeyObject } from 'node:crypto';

/**
 * A compact JWS (a JWT: an OpenID Connect ID token, or any signed token a site's identity provider
 * issues), verified with node:crypto against the provider's published keys. Public-key signatures
 * only: `none` and HMAC are refused, so the server never holds a site's signing secret, and a public
 * key can never be mistaken for an HMAC secret. A reason never carries the token or a claim's value.
 */

/** The algorithms a chat sign-in accepts, each with the key type its signature needs. */
const ALGS = { RS256: 'rsa', ES256: 'ec', EdDSA: 'ed25519' } as const;
type Alg = keyof typeof ALGS;
/** How far the clocks of the server and the identity provider may disagree. */
export const JWT_SKEW_SEC = 60;
/** The smallest RSA key taken (NIST's floor). */
const RSA_MIN_BITS = 2048;

export interface JwtExpect {
  issuer: string;
  audience: string;
  nowSec: number;
}

export type JwtResult = { ok: true; claims: Record<string, unknown> } | { ok: false; reason: JwtRefusal };
export type JwtRefusal = 'malformed' | 'algorithm' | 'unknown key' | 'signature' | 'issuer' | 'audience' | 'expired' | 'not yet valid';

const B64URL = /^[A-Za-z0-9_-]*$/;

function decode(part: string): Record<string, unknown> | null {
  if (part === '' || !B64URL.test(part)) return null;
  try {
    const v: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Whether `key` is one `alg` may be verified with: its type, a P-256 curve for ES256, at least 2048 bits for RS256. */
function keyFits(alg: Alg, key: KeyObject): boolean {
  if (key.type !== 'public' || key.asymmetricKeyType !== ALGS[alg]) return false;
  if (alg === 'ES256') return key.asymmetricKeyDetails?.namedCurve === 'prime256v1';
  if (alg === 'RS256') return (key.asymmetricKeyDetails?.modulusLength ?? 0) >= RSA_MIN_BITS;
  return true;
}

/** A compact JWS, verified against the key its `kid` names, then checked for issuer, audience and time. */
export async function verifyJwt(token: string, keyFor: (kid: string) => Promise<KeyObject | null>, want: JwtExpect): Promise<JwtResult> {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [h, p, s] = parts as [string, string, string];
  const header = decode(h);
  const claims = decode(p);
  if (header === null || claims === null || !B64URL.test(s)) return { ok: false, reason: 'malformed' };
  // A header that names extensions the verifier must understand (RFC 7515 crit): none are understood here.
  if (header.crit !== undefined) return { ok: false, reason: 'malformed' };
  const alg = header.alg;
  if (typeof alg !== 'string' || !Object.hasOwn(ALGS, alg)) return { ok: false, reason: 'algorithm' };
  if (typeof header.kid !== 'string' || header.kid === '') return { ok: false, reason: 'unknown key' };
  const key = await keyFor(header.kid);
  if (key === null) return { ok: false, reason: 'unknown key' };
  if (!keyFits(alg as Alg, key)) return { ok: false, reason: 'algorithm' };
  const input = Buffer.from(`${h}.${p}`);
  const sig = Buffer.from(s, 'base64url');
  let good = false;
  try {
    good = alg === 'EdDSA' ? verify(null, input, key, sig)
      : alg === 'ES256' ? verify('sha256', input, { key, dsaEncoding: 'ieee-p1363' }, sig)
      : verify('sha256', input, key, sig);
  } catch {
    good = false;
  }
  if (!good) return { ok: false, reason: 'signature' };
  if (claims.iss !== want.issuer) return { ok: false, reason: 'issuer' };
  const aud = claims.aud;
  if (!(aud === want.audience || (Array.isArray(aud) && aud.includes(want.audience)))) return { ok: false, reason: 'audience' };
  if (typeof claims.exp !== 'number' || claims.exp < want.nowSec - JWT_SKEW_SEC) return { ok: false, reason: 'expired' };
  if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf > want.nowSec + JWT_SKEW_SEC)) return { ok: false, reason: 'not yet valid' };
  if (claims.iat !== undefined && (typeof claims.iat !== 'number' || claims.iat > want.nowSec + JWT_SKEW_SEC)) return { ok: false, reason: 'not yet valid' };
  return { ok: true, claims };
}
