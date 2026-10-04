import { createPublicKey, verify, type KeyObject } from 'node:crypto';

/**
 * Telnyx's webhook signature (developers.telnyx.com, webhook signing): Ed25519 over
 * `${telnyx-timestamp}|${raw body}`, base64 in the `telnyx-signature-ed25519` header, verified with
 * the account's public key (Mission Control, Keys & Credentials, shown as base64). Telnyx says to
 * reject a webhook whose timestamp is more than five minutes old.
 */

/** How far a webhook's timestamp may be from now, in seconds, before it is refused as a replay. */
export const TELNYX_TOLERANCE_SEC = 300;

/** The DER prefix of an Ed25519 SubjectPublicKeyInfo; a bare 32-byte key is wrapped in it. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** The account's public key, from the base64 Telnyx shows (32 raw bytes) or from SPKI DER. Throws when it is neither. */
export function telnyxPublicKey(base64: string): KeyObject {
  const bytes = Buffer.from(base64.trim(), 'base64');
  const der = bytes.length === 32 ? Buffer.concat([ED25519_SPKI_PREFIX, bytes]) : bytes;
  const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`not an Ed25519 key (${key.asymmetricKeyType ?? 'unknown'})`);
  return key;
}

export interface TelnyxSigned {
  signature: string | undefined;
  timestamp: string | undefined;
  rawBody: string;
  nowSec: number;
}

/** Ed25519 over `${timestamp}|${rawBody}`, inside the tolerance; any malformed input is a refusal. */
export function verifyTelnyxSignature(s: TelnyxSigned, publicKeyBase64: string): boolean {
  if (!s.signature || !s.timestamp || !/^\d{1,12}$/.test(s.timestamp)) return false;
  if (Math.abs(s.nowSec - Number(s.timestamp)) > TELNYX_TOLERANCE_SEC) return false;
  try {
    return verify(null, Buffer.from(`${s.timestamp}|${s.rawBody}`), telnyxPublicKey(publicKeyBase64), Buffer.from(s.signature, 'base64'));
  } catch {
    return false;
  }
}
