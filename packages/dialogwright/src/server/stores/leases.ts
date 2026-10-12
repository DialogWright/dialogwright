import type { CallLeases, LeaseClaim, LeaseHolder, LeaseTook, ReleaseKind, StoredCall } from './types';

/** The part of a call store the in-process leases read and write through: its records, without their leases. */
interface CallRecords {
  load(callId: string): StoredCall | null;
  save(call: StoredCall): void;
  /** Remove the record only (the store's remove also forgets the lease). */
  removeRecord(callId: string): void;
}

/** A lease as kept: its holder, until when, the call's reconnect count when it was taken, and how it was given up. */
interface Held extends LeaseHolder {
  readonly reconnects: number;
  readonly released: ReleaseKind | null;
  /** Its socket closed while a turn ran: a reconnect counted since does not let another take it. */
  readonly closing: boolean;
}

/**
 * Leases kept in this process (the memory and file stores'): one machine is the only owner there is,
 * so a lease means nothing to it, and the server reads none from these stores. They keep the rules all
 * the same, in one Map, so the contract (dialogwright/testing runStoreContract) holds every store to
 * them: one owner at a time; a lease given up, lapsed, or overtaken by a reconnect taken over; a save
 * or a removal kept only from the holder; the reconnect count never lowered. They are not saved: a
 * restarted process holds no lease, as a crashed server holds none once its leases lapse.
 */
export class InProcessLeases implements CallLeases {
  private readonly held = new Map<string, Held>();

  constructor(private readonly calls: CallRecords, private readonly now: () => number) {}

  claim(callId: string, owner: string, ttlMs: number): LeaseClaim {
    const now = this.now();
    const h = this.held.get(callId);
    const call = this.calls.load(callId);
    const reconnects = call?.reconnects ?? 0;
    let took: LeaseTook;
    if (h === undefined) took = 'new';
    else if (h.released !== null) took = h.released;
    else if (h.owner === owner) took = 'own';
    else if (h.expiresAtMs <= now) took = 'lapsed';
    else if (h.reconnects < reconnects && !h.closing) took = 'reconnected';
    else return { taken: false, owner: h.owner, expiresAtMs: h.expiresAtMs };
    this.held.set(callId, { owner, expiresAtMs: now + ttlMs, reconnects, released: null, closing: false });
    return { taken: true, call, took, silentMs: call?.droppedAtMs === undefined ? null : now - call.droppedAtMs };
  }

  renew(owner: string, ttlMs: number): string[] {
    const until = this.now() + ttlMs;
    const ids: string[] = [];
    for (const [callId, h] of this.held) {
      if (h.owner !== owner || h.released !== null) continue;
      this.held.set(callId, { ...h, expiresAtMs: until });
      ids.push(callId);
    }
    return ids;
  }

  release(callId: string, owner: string, how: ReleaseKind = 'stop'): void {
    const h = this.held.get(callId);
    if (h?.owner === owner && h.released === null) this.held.set(callId, { ...h, expiresAtMs: 0, released: how, closing: false });
  }

  markClosing(callId: string, owner: string): void {
    const h = this.held.get(callId);
    if (h?.owner === owner && h.released === null) this.held.set(callId, { ...h, closing: true });
  }

  holder(callId: string): LeaseHolder | null {
    const h = this.held.get(callId);
    return h === undefined || h.released !== null ? null : { owner: h.owner, expiresAtMs: h.expiresAtMs };
  }

  saveAs(call: StoredCall, owner: string, ttlMs: number): boolean {
    const h = this.held.get(call.callId);
    if (h?.owner !== owner || h.released !== null) return false;
    this.held.set(call.callId, { ...h, expiresAtMs: this.now() + ttlMs });
    const before = this.calls.load(call.callId);
    // The spread keeps the key where it was, so the call reads back as it was saved.
    this.calls.save(before !== null && before.reconnects > call.reconnects ? { ...call, reconnects: before.reconnects } : call);
    return true;
  }

  countReconnect(callId: string, limit: number): { before: number; counted: boolean } | null {
    const c = this.calls.load(callId);
    if (c === null) return null;
    if (c.reconnects >= limit) return { before: c.reconnects, counted: false };
    this.calls.save({ ...c, reconnects: c.reconnects + 1, droppedAtMs: this.now() });
    return { before: c.reconnects, counted: true };
  }

  /** The lease goes with its call: the store's remove calls this. */
  forget(callId: string): void {
    this.held.delete(callId);
  }

  removeAs(callId: string, owner: string): boolean {
    const h = this.held.get(callId);
    if (h?.owner !== owner || h.released !== null) return false;
    const existed = this.calls.load(callId) !== null;
    this.calls.removeRecord(callId);
    this.held.delete(callId);
    return existed;
  }

  removeUnleased(callId: string): boolean {
    const h = this.held.get(callId);
    if (h !== undefined && h.released === null && h.expiresAtMs > this.now()) return false;
    const existed = this.calls.load(callId) !== null;
    this.calls.removeRecord(callId);
    this.held.delete(callId);
    return existed;
  }

  /** A call saved with a held end, removed with its lease (CallStateStore.takeHeld). */
  takeHeld(callId: string): StoredCall | null {
    const c = this.calls.load(callId);
    if (c?.heldHandoffData === undefined) return null;
    this.calls.removeRecord(callId);
    this.held.delete(callId);
    return c;
  }
}
