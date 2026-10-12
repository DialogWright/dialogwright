import type { CallLeases, LeaseClaim, LeaseHolder, StoredCall } from './types';

/** The part of a call store the in-process leases read and write through: its records, without their leases. */
interface CallRecords {
  load(callId: string): StoredCall | null;
  save(call: StoredCall): void;
  /** Remove the record only (the store's remove also forgets the lease). */
  removeRecord(callId: string): void;
}

/**
 * Leases kept in this process (the memory and file stores'): one machine is the only owner there is,
 * so a lease means nothing to it, and the server reads none from these stores. They keep the rules all
 * the same, in one Map, so the contract (dialogwright/testing runStoreContract) holds every store to
 * them: one owner at a time, a lapsed or released lease taken over, a save kept only from the holder,
 * the reconnect count never lowered. They are not saved: a restarted process holds no lease, as a
 * crashed server holds none once its leases lapse.
 */
export class InProcessLeases implements CallLeases {
  private readonly held = new Map<string, LeaseHolder>();

  constructor(private readonly calls: CallRecords, private readonly now: () => number) {}

  /** The lease on `callId` when it is live at `now` and held by someone other than `owner`. */
  private heldByOther(callId: string, owner: string, now: number): LeaseHolder | null {
    const h = this.held.get(callId);
    return h !== undefined && h.owner !== owner && h.expiresAtMs > now ? h : null;
  }

  claim(callId: string, owner: string, ttlMs: number): LeaseClaim {
    const now = this.now();
    const other = this.heldByOther(callId, owner, now);
    if (other !== null) return { taken: false, owner: other.owner, expiresAtMs: other.expiresAtMs };
    this.held.set(callId, { owner, expiresAtMs: now + ttlMs });
    return { taken: true, call: this.calls.load(callId) };
  }

  renew(owner: string, ttlMs: number): string[] {
    const until = this.now() + ttlMs;
    const ids: string[] = [];
    for (const [callId, h] of this.held) {
      if (h.owner !== owner) continue;
      this.held.set(callId, { owner, expiresAtMs: until });
      ids.push(callId);
    }
    return ids;
  }

  release(callId: string, owner: string): void {
    if (this.held.get(callId)?.owner === owner) this.held.delete(callId);
  }

  holder(callId: string): LeaseHolder | null {
    const h = this.held.get(callId);
    return h === undefined ? null : { owner: h.owner, expiresAtMs: h.expiresAtMs };
  }

  saveAs(call: StoredCall, owner: string, ttlMs: number): boolean {
    if (this.held.get(call.callId)?.owner !== owner) return false;
    this.held.set(call.callId, { owner, expiresAtMs: this.now() + ttlMs });
    const before = this.calls.load(call.callId);
    // The spread keeps the key where it was, so the call reads back as it was saved.
    this.calls.save(before !== null && before.reconnects > call.reconnects ? { ...call, reconnects: before.reconnects } : call);
    return true;
  }

  countReconnect(callId: string, limit: number): { before: number; counted: boolean } | null {
    const c = this.calls.load(callId);
    if (c === null) return null;
    if (c.reconnects >= limit) return { before: c.reconnects, counted: false };
    this.calls.save({ ...c, reconnects: c.reconnects + 1 });
    return { before: c.reconnects, counted: true };
  }

  /** The lease goes with its call: the store's remove calls this. */
  forget(callId: string): void {
    this.held.delete(callId);
  }

  removeUnleased(callId: string): boolean {
    const h = this.held.get(callId);
    if (h !== undefined && h.expiresAtMs > this.now()) return false;
    const existed = this.calls.load(callId) !== null;
    this.calls.removeRecord(callId);
    this.held.delete(callId);
    return existed;
  }
}
