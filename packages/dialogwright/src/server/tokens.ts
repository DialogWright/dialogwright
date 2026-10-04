import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string comparison. A length mismatch returns false at once: every minted token is
 * 32 hex characters, so the length says nothing about which token is live.
 */
export function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

interface Entry {
  token: string;
  /** The carrier whose webhook minted it (server/voice/registry.ts): only that carrier's socket path takes it. */
  provider: string;
  expiresAt: number;
}

/** The carrier a token is minted for when none is named: the legacy `/voice` is Twilio's. */
const LEGACY_TOKEN_PROVIDER = 'twilio';

/**
 * One live token per call SID, carried in the relay URL and checked at setup. A token is tied to the
 * carrier whose webhook minted it, so a Telnyx call's token never opens `/conversation/twilio` (or the
 * legacy `/conversation`, Twilio's), and a Twilio call's never opens `/conversation/telnyx`.
 */
export class CallTokens {
  private readonly byCall = new Map<string, Entry>();

  constructor(private readonly ttlMs: number, private readonly now: () => number = Date.now) {}

  /** A fresh token for a call on `provider` (default Twilio, the legacy `/voice`'s), replacing the call's last one. */
  mint(callSid: string, provider: string = LEGACY_TOKEN_PROVIDER): string {
    const token = randomBytes(16).toString('hex');
    this.byCall.set(callSid, { token, provider, expiresAt: this.now() + this.ttlMs });
    return token;
  }

  /** Whether `token` is the live token of `callSid`, minted for the carrier whose socket path it came in on. */
  verify(token: string, callSid: string, provider: string): boolean {
    const e = this.byCall.get(callSid);
    if (!e) return false;
    if (this.now() > e.expiresAt) {
      this.byCall.delete(callSid);
      return false;
    }
    return sameToken(e.token, token) && e.provider === provider;
  }

  /**
   * Whether this token is live for some call on `provider`. The WebSocket upgrade knows the token and
   * the carrier its path names, but not the call SID (that arrives in `setup`), so this is the only
   * check available at that point; the binding to a specific call is still verified at `setup` by `verify`.
   */
  has(token: string, provider: string): boolean {
    const now = this.now();
    for (const [callSid, e] of this.byCall) {
      if (!sameToken(e.token, token)) continue;
      if (now > e.expiresAt) {
        this.byCall.delete(callSid);
        return false;
      }
      return e.provider === provider;
    }
    return false;
  }

  revoke(callSid: string): void {
    this.byCall.delete(callSid);
  }

  evictExpired(): number {
    const now = this.now();
    let count = 0;
    for (const [callSid, e] of this.byCall) {
      if (now > e.expiresAt) {
        this.byCall.delete(callSid);
        count++;
      }
    }
    return count;
  }
}
