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
  expiresAt: number;
}

/** One live token per call SID, carried in the ConversationRelay URL and checked at setup. */
export class CallTokens {
  private readonly byCall = new Map<string, Entry>();

  constructor(private readonly ttlMs: number, private readonly now: () => number = Date.now) {}

  mint(callSid: string): string {
    const token = randomBytes(16).toString('hex');
    this.byCall.set(callSid, { token, expiresAt: this.now() + this.ttlMs });
    return token;
  }

  verify(token: string, callSid: string): boolean {
    const e = this.byCall.get(callSid);
    if (!e) return false;
    if (this.now() > e.expiresAt) {
      this.byCall.delete(callSid);
      return false;
    }
    return sameToken(e.token, token);
  }

  /**
   * Whether this token is live for some call. The WebSocket upgrade knows the token but not the
   * call SID (that arrives in `setup`), so this is the only check available at that point; the
   * binding to a specific call is still verified at `setup` by `verify`.
   */
  has(token: string): boolean {
    const now = this.now();
    for (const [callSid, e] of this.byCall) {
      if (!sameToken(e.token, token)) continue;
      if (now > e.expiresAt) {
        this.byCall.delete(callSid);
        return false;
      }
      return true;
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
