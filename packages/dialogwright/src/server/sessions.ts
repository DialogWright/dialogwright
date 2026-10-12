import { SESSION_SCHEMA, type Session } from '../core/session';
import { appOf } from '../core/app/registry';
import type { CallLeases, CallStateStore, HeldFrame, LeaseClaim, PendingEffect, ReleaseKind, StoredCall } from './stores/types';
import type { RunOptions } from '../run/turn';
import type { TraceWriter } from '../trace/writer';
import type { FrameLog } from './frameLog';
import type { AuditEntry } from '../audit/types';

/** The subset of a ws.WebSocket the adapter uses, so tests can substitute a fake. */
export interface SocketLike {
  send(data: string, cb?: (err?: Error) => void): void;
  close(code?: number, reason?: string): void;
}

export interface CallResources {
  session: Session;
  opts: RunOptions;
  trace: TraceWriter;
  frames: FrameLog;
}

export interface CallEntry extends CallResources {
  callSid: string;
  socket: SocketLike | null;
  reconnects: number;
  createdAtMs: number;
  lastActivityMs: number;
  ended: boolean;
  /** When `ended` was first set, so an ended call is retained for a fixed grace period, not a TTL. */
  endedAtMs: number | null;
  tail: Promise<void>;
  inFlight: number;
  /**
   * The call's audit entries, as chained: pushed by the adapter after every turn (so with the
   * console off too) and, for the one end a turn never sees, by the `/cr-action` hangup branch
   * (src/server/http.ts). What the handoff summary (src/handoff/summary.ts) reads.
   */
  auditEntries: AuditEntry[];
  /** The carrier the call came in on (server/voice/registry.ts), when the adapter named it: what a saved call is resumed for. */
  provider?: string;
  /**
   * The service request the call is waiting on, with its idempotency key, from just before it is sent
   * until its answer's turn has run (server/adapter.ts queueService): saved with the call, so a server
   * that loads the call after a restart sends it again with the same key.
   */
  pending?: PendingEffect | null;
  /**
   * The handoff data of the call's `end` while the adapter holds it for the lines before it to play
   * (END_AFTER_PLAYBACK, server/adapter.ts), until it is sent. The call has ended by then; should its
   * socket close first with the caller still on the line (a relay session that failed, a drain), the
   * carrier's callback makes the transfer it carried (http.ts decideAction). Never saved.
   */
  heldHandoffData?: string | null;
  /**
   * When the carrier last reported the call's relay lost (its callback asking to reconnect), on this
   * server's clock: what the silence before the `resumed` line is measured from (RESUMED_AFTER_MS).
   */
  droppedAtMs?: number;
  /**
   * The lines and the `end` a turn ended the call with while it had no socket (endUndelivered): what a
   * socket that comes for it next is sent (the adapter's replay), once. Never saved as such: the store
   * keeps them in StoredCall.heldFrames.
   */
  undelivered?: readonly HeldFrame[];
}

export type CallFactory = (callSid: string) => CallResources;

/**
 * How long an ended call is kept after it ends. Long enough for a late `/cr-action` callback or a
 * stray frame to find the session it belongs to, short enough that a busy line does not accumulate
 * finished calls for the half hour the idle TTL would allow.
 */
export const ENDED_GRACE_MS = 60_000;

/**
 * How long a transfer saved as still owed (endHolding) is kept for a callback that never comes (its
 * caller hung up in the hold, and the hangup's callback reached a server that could not say): the
 * sweep removes it after this.
 */
export const HELD_TRANSFER_MAX_MS = 120_000;

/** Nothing legitimate keeps one phone call alive this long; past it the entry is a leak. */
export const DEFAULT_SESSION_MAX_AGE_MS = 7_200_000;

/**
 * A shared store's leases as this server holds them (SESSION_STORE=postgres): one owner per call at a
 * time. Only with one does anything below take, renew or give up a lease: with the memory and file
 * stores a server holds its calls as it always did.
 */
export interface SessionLease {
  /** The leases, over the same storage as `state`. */
  readonly leases: CallLeases;
  /** This server's name in the lease table: unique to this process (SERVER_ID, or "server", with a random suffix). */
  readonly owner: string;
  /** How long a hold lasts unless renewed (CALL_LEASE_MS). */
  readonly ttlMs: number;
  /** How long a setup waits for another server's hold to lapse or be released before it gives the call to a person; default one and a half holds. */
  readonly waitMs?: number;
  /** How soon it first asks again; default a twentieth of a hold, at least 25 ms, doubling with jitter up to a quarter of a hold. */
  readonly pollMs?: number;
  /** How long one question to the store may take (SESSION_STORE_TIMEOUT_MS): the bound on what a carrier's webhook waits for. Default 2000 ms. */
  readonly timeoutMs?: number;
}

/** Where a SessionStore saves its calls, and where it says what it could not do. */
export interface SessionStoreOptions {
  /**
   * Where each call is saved after every turn, and loaded from when a call this server does not hold
   * calls back (SESSION_STORE=file:<dir>, server/stores/file.ts). Absent or null (SESSION_STORE=memory,
   * the default), nowhere: the entry here is the call's only copy, as it always was.
   */
  state?: CallStateStore | null;
  /** The leases of a store many servers share (SESSION_STORE=postgres); absent or null, none is taken. */
  lease?: SessionLease | null;
  log?: (line: string) => void;
}

/**
 * What `restore` found: the call already here, loaded from the store, nothing to resume, or a call saved
 * in a shape this server cannot read; or, with a shared store, 'unavailable': the store could not be
 * asked in time, and a caller who would reconnect is put through to a person.
 */
export type RestoreResult = 'held' | 'restored' | 'none' | 'unreadable' | 'unavailable';

/**
 * What `claim` found (a setup, with a shared store): as `restore`, with the lease taken; or 'busy', the
 * lease not to be had (another server held on to it past the wait, the database could not be asked, or
 * the call is another carrier's), and the caller is put through to a person; or 'ended', the call ended
 * on the server that held it while this one waited (its last turn ended it), and the socket is closed;
 * or 'replay', the call ended with lines and an `end` no socket took (endUndelivered), now held here
 * (`undelivered`) for this socket to be sent.
 */
export type ClaimResult = RestoreResult | 'busy' | 'ended' | 'replay';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** How a lease was taken, as the log says it. */
function tookSaid(took: string): string {
  switch (took) {
    case 'socket': return 'given up as its socket closed';
    case 'stop': return 'given up by a stopping server';
    case 'lapsed': return 'its lease lapsed';
    case 'reconnected': return 'its carrier reconnected since';
    default: return took;
  }
}

/**
 * The calls this server holds, with what is live about each (its socket, its turn queue). With a call
 * store (SessionStoreOptions.state) it also saves each call after every turn (persist), forgets it
 * when it ends or is evicted, and loads one it does not hold when its carrier calls back for it after
 * a restart (restore), so the call goes on where it was.
 *
 * With a store many servers share (SessionStoreOptions.lease), a server holds a call in memory only
 * while it holds the call's lease: it takes the lease as a setup reaches it (claim, waiting for a
 * crashed server's to lapse), saves only under it (a save refused means another server has the call,
 * and this one lets it go), renews it while the call is live (renewLeases), and gives it up once the
 * call's socket has closed and its last turn is saved (detach), so the carrier's reconnect may reach any
 * server. A callback for a call it does not hold loads the call only to answer (a borrowed entry,
 * dropped once answered), counting the reconnect in the store at once (countReconnect).
 */
export class SessionStore {
  private readonly calls = new Map<string, CallEntry>();
  private readonly state: CallStateStore | null;
  private readonly lease: SessionLease | null;
  private readonly log: (line: string) => void;
  /** Each call's saves and removals, in order, so a slow store never writes an older save over a newer one. */
  private readonly writes = new Map<string, Promise<void>>();
  /** Calls loaded from the store whose carrier has not yet reconnected: the first line they hear says they were lost for a moment. */
  private readonly restored = new Set<string>();
  /** With a shared store: calls loaded only to answer a callback, without their lease. */
  private readonly borrowed = new Set<string>();
  /** With a shared store: when this server took each call's lease (this store's clock), so a renewal begun before it does not count it lost. */
  private readonly claimedAt = new Map<string, number>();
  /** With a shared store: the leases being given up as sockets close, so a stop waits for them. */
  private readonly releasing = new Set<Promise<void>>();
  /** With a shared store: whether the last renewal failed (said once, not every time). */
  private renewFailing = false;
  /** With a shared store: calls taken from a server that gave them up as their socket closed (a clean hand-off): their caller is not told they were lost. */
  private readonly quiet = new Set<string>();
  /** With a shared store: calls whose lease a setup is taking now, which a renewal must not take for leaked. */
  private readonly claiming = new Set<string>();
  /** Each call's work queued and not yet done (turns waiting or running), counted as it is queued. */
  private readonly queued = new WeakMap<CallEntry, number>();
  /** Calls resumed after their holder let them go cleanly (a stop, a drain): RESUMED_AFTER_MS decides their apology. */
  private readonly clean = new Set<string>();
  /** Calls ended with a transfer saved as still owed (endHolding): not forgotten until it is sent (heldSent). */
  private readonly holding = new Set<string>();
  /** Set once the server is stopping: a lease given up from now on says so (`stop`), and its next holder apologizes. */
  private stopping = false;

  constructor(
    private readonly factory: CallFactory,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxAgeMs: number = DEFAULT_SESSION_MAX_AGE_MS,
    options: SessionStoreOptions = {},
  ) {
    this.state = options.state ?? null;
    this.lease = options.state ? (options.lease ?? null) : null;
    this.log = options.log ?? ((line) => console.log(`[server] ${line}`));
  }

  /** Whether calls are saved somewhere that outlives this process (a call store was given). */
  get durable(): boolean {
    return this.state !== null;
  }

  /** Whether the store is shared with other servers, so a call is held under its lease (SESSION_STORE=postgres). */
  get shared(): boolean {
    return this.lease !== null;
  }

  /** This server's name in the lease table, with a shared store. */
  get owner(): string | null {
    return this.lease?.owner ?? null;
  }

  /** How long one question to a shared store may take: what a webhook waits for it at most. */
  get timeoutMs(): number {
    return this.lease?.timeoutMs ?? 2_000;
  }

  /** The server is stopping (a drain or a close): a call let go from now on is given up as by a stop. */
  markStopping(): void {
    this.stopping = true;
  }

  get(callSid: string): CallEntry | undefined {
    return this.calls.get(callSid);
  }

  /** Every entry the store is holding, ended ones included. */
  size(): number {
    return this.calls.size;
  }

  /** Entries for calls that have not ended: the sessions that could still speak to a caller. */
  liveCount(): number {
    let n = 0;
    for (const e of this.calls.values()) if (!e.ended) n += 1;
    return n;
  }

  /**
   * The call SIDs that have not ended, as of right now. `evictIdle` deletes an entry before its
   * caller can ask whether it was still live, so a sweep that needs to know takes this snapshot first.
   */
  liveCallSids(): string[] {
    const sids: string[] = [];
    for (const [sid, e] of this.calls) if (!e.ended) sids.push(sid);
    return sids;
  }

  /** A new call, on `provider`'s socket (default Twilio's, as the legacy path is). */
  create(callSid: string, socket: SocketLike, provider?: string): CallEntry {
    if (this.calls.has(callSid)) throw new Error(`session for ${callSid} already exists`);
    const entry: CallEntry = {
      ...this.factory(callSid),
      callSid,
      socket,
      reconnects: 0,
      createdAtMs: this.now(),
      lastActivityMs: this.now(),
      ended: false,
      endedAtMs: null,
      tail: Promise.resolve(),
      inFlight: 0,
      auditEntries: [],
      ...(provider !== undefined ? { provider } : {}),
    };
    this.calls.set(callSid, entry);
    return entry;
  }

  /** Run `write` after the call's earlier saves and removals; a failure is logged, never thrown. */
  private queueWrite(callSid: string, what: string, write: (state: CallStateStore) => unknown): Promise<void> {
    const state = this.state;
    if (state === null) return Promise.resolve();
    const run = (this.writes.get(callSid) ?? Promise.resolve())
      .then(() => write(state))
      .then(() => undefined, (err: unknown) => this.log(`${callSid}: could not ${what}: ${err instanceof Error ? err.message : String(err)}`));
    this.writes.set(callSid, run);
    void run.then(() => {
      if (this.writes.get(callSid) === run) this.writes.delete(callSid);
    });
    return run;
  }

  /** `step` after the call's earlier saves, removals and lease steps, with its answer; a failure rejects, and the order goes on. */
  private inOrder<T>(callSid: string, step: () => T | Promise<T>): Promise<T> {
    const run = (this.writes.get(callSid) ?? Promise.resolve()).then(step);
    const settled = run.then(() => undefined, () => undefined);
    this.writes.set(callSid, settled);
    void settled.then(() => {
      if (this.writes.get(callSid) === settled) this.writes.delete(callSid);
    });
    return run;
  }

  /**
   * Save the call as it is now (after a turn, a reconnect): its session, its counters and its audit
   * entries. A call that has ended is forgotten instead. Without a call store, nothing. With a shared
   * store, only under the call's lease: a call loaded only to answer a callback is not saved from here,
   * and a save the store refuses (another server has the call now) lets the call go here.
   */
  persist(callSid: string): Promise<void> {
    const e = this.calls.get(callSid);
    if (!e || this.state === null) return Promise.resolve();
    // A transfer saved as still owed stays saved until it is sent.
    if (this.holding.has(callSid)) return Promise.resolve();
    if (e.ended) return this.forget(callSid);
    // A session over whose call has not ended yet: `end` (or `endHolding`, for a transfer whose line is
    // still to play) forgets or keeps it, and nothing is saved meanwhile.
    if (e.session.ended) return Promise.resolve();
    if (this.lease !== null && this.borrowed.has(callSid)) return Promise.resolve();
    const call = this.storedOf(e);
    const lease = this.lease;
    if (lease !== null) {
      return this.queueWrite(callSid, 'save the session', async () => {
        if (await lease.leases.saveAs(call, lease.owner, lease.ttlMs)) return;
        if (this.calls.get(callSid) === e) this.lose(callSid, 'its save was refused: another server has the call now');
      });
    }
    return this.queueWrite(callSid, 'save the session', (state) => state.save(call));
  }

  /** The call as it is saved. */
  private storedOf(e: CallEntry, extra: Partial<StoredCall> = {}): StoredCall {
    return {
      callId: e.callSid,
      provider: e.provider ?? 'twilio',
      schema: SESSION_SCHEMA,
      session: e.session,
      reconnects: e.reconnects,
      createdAtMs: e.createdAtMs,
      lastActivityMs: e.lastActivityMs,
      auditTail: [...e.auditEntries],
      ...(e.pending ? { pending: e.pending } : {}),
      // One machine's: a store many servers share keeps the time with its reconnect count.
      ...(e.droppedAtMs !== undefined && this.lease === null ? { droppedAtMs: e.droppedAtMs } : {}),
      ...extra,
    };
  }

  /**
   * The call has ended with a transfer whose `end` is held for its line to play (END_AFTER_PLAYBACK):
   * ended here as by `end`, but with a durable store saved with the transfer rather than forgotten, so
   * whichever server the carrier's callback reaches, should the socket close first, puts the caller
   * through, once (takeHeld). Forgotten once the `end` is sent (heldSent). Without a store, `end`.
   */
  endHolding(callSid: string, handoffData: string): void {
    const e = this.calls.get(callSid);
    if (!e) return;
    if (this.state === null) {
      this.end(callSid);
      return;
    }
    if (!e.ended) e.endedAtMs = this.now();
    e.ended = true;
    e.lastActivityMs = this.now();
    this.holding.add(callSid);
    const call = this.storedOf(e, { heldHandoffData: handoffData });
    const lease = this.lease;
    if (lease !== null) {
      void this.queueWrite(callSid, 'save the held transfer', () => lease.leases.saveAs(call, lease.owner, lease.ttlMs));
      return;
    }
    void this.queueWrite(callSid, 'save the held transfer', (state) => state.save(call));
  }

  /**
   * A turn ended the call while it had no socket (it closed as the turn ran), so its lines and its `end`
   * reached no one. With a durable store they are kept, not forgotten: saved with the call (heldFrames,
   * and the `end`'s handoff as heldHandoffData), and the call given up, so the server the carrier's
   * socket reaches next sends them, once, and the caller hears the goodbye or is put through where the
   * turn decided. Without a store, `end`.
   */
  endUndelivered(callSid: string, frames: readonly HeldFrame[]): void {
    const e = this.calls.get(callSid);
    const end = frames.find((f) => f.type === 'end');
    if (!e || this.state === null || end === undefined) {
      this.end(callSid);
      return;
    }
    if (!e.ended) e.endedAtMs = this.now();
    e.ended = true;
    e.lastActivityMs = this.now();
    e.undelivered = frames;
    this.holding.add(callSid);
    const call = this.storedOf(e, { heldHandoffData: typeof end.handoffData === 'string' ? end.handoffData : '{}', heldFrames: frames });
    const lease = this.lease;
    if (lease !== null) {
      void this.queueWrite(callSid, 'save the undelivered end', async () => {
        if (!(await lease.leases.saveAs(call, lease.owner, lease.ttlMs))) return;
        // Given up as by its socket, so whichever server the carrier reaches next takes it at once.
        await lease.leases.release(callSid, lease.owner, 'socket');
      });
      return;
    }
    void this.queueWrite(callSid, 'save the undelivered end', (state) => state.save(call));
  }

  /** A held transfer's `end` has gone: the call is forgotten, as `end` forgets one. */
  heldSent(callSid: string): void {
    if (!this.holding.delete(callSid)) return;
    if (this.state !== null && this.calls.has(callSid)) void this.forget(callSid);
  }

  /**
   * The transfer a callback for an ended call still owes, from a durable store: taken with the call in
   * one step, so of every server the callbacks reach exactly one puts the caller through. A string to
   * dial, null when none is owed (sent, taken, or never held), or 'unknown' when the store could not be
   * asked; undefined without a store (the entry in memory says).
   */
  async takeHeld(callId: string): Promise<string | null | 'unknown' | undefined> {
    const state = this.state;
    if (state === null) return undefined;
    try {
      const c = await this.takeHeldCall(callId);
      return c?.heldHandoffData ?? null;
    } catch (err) {
      this.log(`${callId}: could not read a held transfer: ${err instanceof Error ? err.message : String(err)}`);
      return 'unknown';
    }
  }

  /** A call saved with a held end, taken from the store in one step (CallStateStore.takeHeld), or null. */
  private takeHeldCall(callId: string): Promise<StoredCall | null> {
    const state = this.state;
    if (state === null) return Promise.resolve(null);
    return this.inOrder(callId, async () => {
      if (state.takeHeld) return state.takeHeld(callId);
      const c = await state.load(callId);
      if (c?.heldHandoffData === undefined) return null;
      await state.remove(callId);
      return c;
    });
  }

  /**
   * One machine's durable store: a call this server ended with lines and an `end` no socket took
   * (endUndelivered), taken from the store as a socket comes for it, so it is sent once. False when
   * another took it (or the store could not say: nothing is sent twice).
   */
  async takeUndelivered(callId: string): Promise<boolean> {
    try {
      return (await this.takeHeldCall(callId)) !== null;
    } catch (err) {
      this.log(`${callId}: could not take its undelivered end: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** A call this server held under a lease it no longer has: let go here, with its socket, never saved or ended from here again. */
  private lose(callSid: string, why: string): void {
    const e = this.calls.get(callSid);
    if (!e) return;
    this.log(`${callSid}: let go: ${why}`);
    this.drop(callSid);
    if (e.socket) e.socket.close(1000, 'taken over');
  }

  /**
   * Remove the call from the store (it ended, or it is past its time), and with it its lease. With a
   * shared store, only as its holder (`owned`, by default when this server holds the call), so a server
   * that has lost a call never removes the call another now runs; one loaded only to answer is removed
   * only when no server holds it.
   */
  private forget(callSid: string, owned: boolean = this.calls.has(callSid) && !this.borrowed.has(callSid)): Promise<void> {
    this.restored.delete(callSid);
    this.claimedAt.delete(callSid);
    this.quiet.delete(callSid);
    const lease = this.lease;
    if (lease !== null) {
      return this.queueWrite(callSid, 'remove the saved session', () =>
        owned ? lease.leases.removeAs(callSid, lease.owner) : lease.leases.removeUnleased(callSid));
    }
    return this.queueWrite(callSid, 'remove the saved session', (state) => state.remove(callSid));
  }

  /** Every save and removal queued so far, done, and every lease being given up. */
  async settled(): Promise<void> {
    await Promise.all([...this.releasing]);
    await Promise.all([...this.writes.values()]);
  }

  /** Whether a saved call is within its idle time and its cap at `now` (read from the stored counters, whatever its schema). */
  private inTime(c: StoredCall, now: number): boolean {
    return now - c.lastActivityMs < this.ttlMs && now - c.createdAtMs < this.maxAgeMs;
  }

  /** Whether a saved call may still go on at `now`: in time, and not over. */
  private resumable(c: StoredCall, now: number): boolean {
    return this.inTime(c, now) && !c.session.ended;
  }

  /**
   * Load a call this server does not hold from the store, for its carrier's callback (`provider`, the
   * callback's path): 'restored' when it can go on, with no socket until the carrier reconnects;
   * 'held' when this server already has it; 'none' when there is nothing to resume (never saved, ended,
   * past its time, or saved for another carrier); 'unreadable' when it was saved under another
   * SESSION_SCHEMA (or for an app this server does not run), which is then forgotten: its caller is
   * put through to a person (http.ts).
   */
  async restore(callId: string, provider: string): Promise<RestoreResult> {
    if (this.calls.has(callId)) return 'held';
    if (this.state === null) return 'none';
    let c: StoredCall | null;
    try {
      c = await this.state.load(callId);
    } catch (err) {
      this.log(`${callId}: could not load the saved session: ${err instanceof Error ? err.message : String(err)}`);
      return this.lease !== null ? 'unavailable' : 'none';
    }
    if (c === null) return 'none';
    // Loaded while another callback for it did the same.
    if (this.calls.has(callId)) return 'held';
    const fit = await this.fits(c, provider, false);
    if (fit !== 'ok') return fit;
    this.hold(c);
    // With a shared store, held only to answer the callback: the lease is taken where the socket lands.
    if (this.lease !== null) this.borrowed.add(callId);
    else this.log(`${callId}: restored from the session store (turn ${c.session.turnIndex}, reconnect ${c.reconnects})`);
    return 'restored';
  }

  /**
   * Whether a saved call may go on here, on `provider`'s callback or socket: 'ok'; 'unreadable' when it
   * was saved under another SESSION_SCHEMA or for an app this server does not run (then forgotten);
   * 'none' when it is another carrier's, or past its time or over (then forgotten), or it ended with a
   * transfer still owed (kept for the callback that takes it). `owned`: this server holds its lease.
   */
  private async fits(c: StoredCall, provider: string, owned: boolean): Promise<'ok' | 'none' | 'unreadable'> {
    const callId = c.callId;
    if (c.heldHandoffData !== undefined) return 'none';
    if (c.schema !== SESSION_SCHEMA) {
      this.log(`${callId}: not resumed: saved under session schema ${c.schema}, and this server reads ${SESSION_SCHEMA}`);
      await this.forget(callId, owned);
      return 'unreadable';
    }
    try {
      appOf(c.session);
    } catch {
      this.log(`${callId}: not resumed: saved for the app "${String(c.session.appId)}", which this server does not run`);
      await this.forget(callId, owned);
      return 'unreadable';
    }
    if (c.provider !== provider) {
      this.log(`${callId}: not resumed: saved for ${c.provider}, and the callback is from ${provider}`);
      return 'none';
    }
    if (!this.resumable(c, this.now())) {
      await this.forget(callId, owned);
      return 'none';
    }
    return 'ok';
  }

  /**
   * The carrier's callback asked to reconnect the call: when, so the silence its caller is left in is
   * known at the setup that resumes it. With a store many servers share the store records it as it
   * counts the reconnect (CallLeases.countReconnect), on its own clock.
   */
  markDropped(callSid: string): void {
    const e = this.calls.get(callSid);
    if (e && this.lease === null) e.droppedAtMs = this.now();
  }

  /** How long the call's caller has been in silence since its carrier reported the relay lost, or undefined when no one knows; read once. */
  takeSilence(callSid: string): number | undefined {
    const e = this.calls.get(callSid);
    if (e?.droppedAtMs === undefined) return undefined;
    const ms = this.now() - e.droppedAtMs;
    delete e.droppedAtMs;
    return ms;
  }

  /** A saved call held here, with no socket until its carrier connects. */
  private hold(c: StoredCall, silentMs?: number | null): CallEntry {
    const callId = c.callId;
    const entry: CallEntry = {
      ...this.factory(callId),
      session: c.session,
      callSid: callId,
      socket: null,
      reconnects: c.reconnects,
      createdAtMs: c.createdAtMs,
      lastActivityMs: this.now(),
      ended: false,
      endedAtMs: null,
      tail: Promise.resolve(),
      inFlight: 0,
      auditEntries: [...c.auditTail],
      provider: c.provider,
      // Only a request the session still waits on: one answered before the save is not sent again.
      pending: c.pending && c.session.pendingService === c.pending.effect.service ? c.pending : null,
    };
    // On this server's clock: the store's silence, or the time one machine saved.
    const dropped = silentMs !== undefined && silentMs !== null ? this.now() - silentMs : c.droppedAtMs;
    if (dropped !== undefined) entry.droppedAtMs = dropped;
    this.calls.set(callId, entry);
    this.restored.add(callId);
    // One machine: let go by a stopping server (a drain or a close), not lost to a crash. The mark is
    // cleared in the store at once, so a crash of this server before its next save is not taken for a stop.
    if (c.stopped === true && this.lease === null) {
      this.clean.add(callId);
      void this.queueWrite(callId, 'save the session', (state) => state.save(this.storedOf(entry)));
    }
    return entry;
  }

  /**
   * With a shared store, as a carrier's socket reaches this server for a call (its setup): take the
   * call's lease and read the call in one step (CallLeases.claim), waiting while another server holds
   * it, until a deadline (one that crashed holds it until it lapses, or until the carrier's reconnect has
   * been counted; one that let it go gave it up). 'held' when this server has the call and its lease;
   * 'restored' when the call was loaded from the store, to go on here (its caller hears they were lost
   * for a moment, unless the server before gave it up as its socket closed: takeQuiet); 'none' when
   * there is no call to go on (a new one, now this server's); 'unreadable' as restore; 'busy' when the
   * lease is not to be had by the deadline or the store cannot be asked.
   */
  async claim(callId: string, provider: string): Promise<ClaimResult> {
    const lease = this.lease;
    if (lease === null) throw new Error('claim needs a shared store (SessionStoreOptions.lease)');
    const held = this.calls.get(callId);
    if (held !== undefined && this.borrowed.has(callId)) this.drop(callId);
    // A deadline on the wall clock, whatever each question to the store takes.
    const deadline = Date.now() + (lease.waitMs ?? lease.ttlMs * 1.5);
    let pause = this.pollMs(lease);
    // Whether another server held the call as this claim began: a call gone by the time it is taken ended there.
    let waited = false;
    this.claiming.add(callId);
    try {
      for (;;) {
        let r: LeaseClaim;
        try {
          r = await this.inOrder(callId, () => lease.leases.claim(callId, lease.owner, lease.ttlMs));
        } catch (err) {
          this.log(`${callId}: could not take the call's lease: ${err instanceof Error ? err.message : String(err)}`);
          return 'busy';
        }
        if (!r.taken) {
          waited = true;
          const left = deadline - Date.now();
          if (left <= 0) {
            this.log(`${callId}: not taken over: ${r.owner} still holds it`);
            return 'busy';
          }
          // Backing off, with jitter, so servers waiting on one call do not ask in step.
          await sleep(Math.min(left, pause * (0.5 + Math.random() / 2)));
          pause = Math.min(pause * 2, Math.max(this.pollMs(lease), lease.ttlMs / 4));
          continue;
        }
        const claimedAt = this.now();
        let mine = this.calls.get(callId);
        // Ended here (its last turn's end reached no socket): what the store says now decides, below.
        if (mine !== undefined && !this.borrowed.has(callId) && mine.ended) {
          this.drop(callId);
          mine = undefined;
        }
        if (mine !== undefined && !this.borrowed.has(callId)) {
          this.claimedAt.set(callId, claimedAt);
          if (r.silentMs !== null) mine.droppedAtMs = this.now() - r.silentMs;
          return 'held';
        }
        if (mine !== undefined) this.drop(callId);
        if (r.call === null) {
          if (waited) {
            // Its last turn, on the server that held it, ended it while this one waited: nothing goes on here.
            this.log(`${callId}: ended on the server that held it while its socket waited here`);
            await this.inOrder(callId, () => lease.leases.removeAs(callId, lease.owner)).catch(() => undefined);
            return 'ended';
          }
          this.claimedAt.set(callId, claimedAt);
          return 'none';
        }
        if (r.call.heldFrames !== undefined && r.call.provider === provider) {
          // Ended by a turn whose lines and `end` reached no socket: taken from the store (once, whatever
          // server tries) and held here for this socket, under this server's lease, to be sent them.
          const taken = await this.takeHeldCall(callId).catch(() => null);
          if (taken?.heldFrames === undefined) return 'ended';
          await this.inOrder(callId, () => lease.leases.claim(callId, lease.owner, lease.ttlMs)).catch(() => undefined);
          const entry = this.hold(taken);
          this.restored.delete(callId);
          entry.undelivered = taken.heldFrames;
          this.claimedAt.set(callId, claimedAt);
          this.log(`${callId}: its last turn's lines and end reached no socket: sent on this one`);
          return 'replay';
        }
        if (r.call.provider !== provider || r.call.heldHandoffData !== undefined) {
          // A token opens only its own carrier's path, and a call that ended with a transfer owed is no
          // call to begin again: either way no one's call is begun or ended here, and this caller goes to a person.
          this.log(`${callId}: not taken: ${r.call.heldHandoffData !== undefined ? 'it ended with a transfer still owed' : `saved for ${r.call.provider}, and the socket is ${provider}'s`}`);
          await this.inOrder(callId, () => lease.leases.release(callId, lease.owner, 'stop')).catch(() => undefined);
          return 'busy';
        }
        const fit = await this.fits(r.call, provider, true);
        // Past its time or over: forgotten with its lease, which is taken again for the call begun in its place.
        if (fit === 'none') continue;
        if (fit === 'unreadable') return fit;
        this.hold(r.call, r.silentMs);
        this.claimedAt.set(callId, claimedAt);
        if (r.took === 'socket') this.quiet.add(callId);
        // Let go cleanly (a stop, or this server's own): RESUMED_AFTER_MS decides its apology. A lapsed or
        // overtaken lease is a holder that never let go: its caller always hears the resumed line.
        if (r.took === 'stop' || r.took === 'own') this.clean.add(callId);
        this.log(`${callId}: taken over from the session store (turn ${r.call.session.turnIndex}, reconnect ${r.call.reconnects}, ${tookSaid(r.took)}) by ${lease.owner}`);
        return 'restored';
      }
    } finally {
      this.claiming.delete(callId);
    }
  }

  /** Whether a call resumed was let go cleanly by the server before (a stop or a drain), so RESUMED_AFTER_MS decides its apology; true once. */
  takeClean(callSid: string): boolean {
    return this.clean.delete(callSid);
  }

  /** Whether a call taken over was given up as its socket closed (a clean hand-off), so its caller is not told they were lost; true once. */
  takeQuiet(callSid: string): boolean {
    return this.quiet.delete(callSid);
  }

  private pollMs(lease: SessionLease): number {
    return lease.pollMs ?? Math.max(25, Math.round(lease.ttlMs / 20));
  }

  /**
   * A call held here dropped from memory only (nothing in the store changes). Its entry is marked ended
   * for this server, so nothing queued for it here runs (a service's answer that comes after: the
   * server that has the call now sends the request again, with the same key).
   */
  private drop(callId: string): void {
    const e = this.calls.get(callId);
    if (e && !e.ended) {
      e.ended = true;
      e.endedAtMs = this.now();
    }
    this.calls.delete(callId);
    this.borrowed.delete(callId);
    this.restored.delete(callId);
    this.claimedAt.delete(callId);
    this.quiet.delete(callId);
    this.clean.delete(callId);
    this.holding.delete(callId);
  }

  /**
   * With a shared store, a callback that will reconnect the call: its reconnect counted in the store, at
   * once for every server (CallLeases.countReconnect), and the entry's count set to the count before it,
   * so the callback's decision (http.ts decideAction) adds the one it counts as it always did, and
   * gives the call to a person at the limit. A store that cannot be asked gives it to a person too.
   */
  async countReconnect(callId: string, limit: number): Promise<void> {
    const lease = this.lease;
    const e = this.calls.get(callId);
    if (lease === null || !e || e.ended) return;
    try {
      const r = await this.inOrder(callId, () => lease.leases.countReconnect(callId, limit));
      if (r !== null) e.reconnects = r.before;
    } catch (err) {
      this.log(`${callId}: could not count the reconnect: ${err instanceof Error ? err.message : String(err)}`);
      e.reconnects = limit;
    }
  }

  /**
   * With a shared store, a call whose lease a setup took for a socket that closed meanwhile: let go here,
   * and its lease given up, so the server the carrier's next socket reaches takes it at once.
   */
  giveBack(callId: string): void {
    const lease = this.lease;
    if (lease === null) return;
    if (this.calls.has(callId) && !this.borrowed.has(callId)) {
      this.detach(callId);
      return;
    }
    const run = this.inOrder(callId, () => lease.leases.release(callId, lease.owner, this.releaseKind()))
      .catch((err: unknown) => this.log(`${callId}: could not give up the call's lease: ${err instanceof Error ? err.message : String(err)}`));
    this.releasing.add(run);
    void run.then(() => this.releasing.delete(run));
  }

  /** How a lease given up now is given up: by its socket (a clean hand-off), or by a stop. */
  private releaseKind(): ReleaseKind {
    return this.stopping ? 'stop' : 'socket';
  }

  /** With a shared store, a call loaded only to answer a callback, dropped once it is answered (its lease is where its socket lands). */
  dropBorrowed(callId: string): void {
    if (this.borrowed.has(callId)) this.drop(callId);
  }

  /**
   * With a shared store, every lease this server holds renewed (one statement), as an interval does
   * every third of a hold. A call held here whose lease another server has taken since (one that took
   * it over while this one could not be reached) is let go here.
   */
  async renewLeases(): Promise<void> {
    const lease = this.lease;
    if (lease === null) return;
    const began = this.now();
    let mine: Set<string>;
    try {
      mine = new Set(await lease.leases.renew(lease.owner, lease.ttlMs));
    } catch (err) {
      // Said once until a renewal works again, not every third of a hold.
      if (!this.renewFailing) this.log(`could not renew the calls' leases (said once until it works again): ${err instanceof Error ? err.message : String(err)}`);
      this.renewFailing = true;
      return;
    }
    if (this.renewFailing) this.log("renewing the calls' leases again");
    this.renewFailing = false;
    // A lease this server holds for a call it does not run (a claim that timed out here and committed
    // there, or a held transfer whose call has gone from memory): given up, so no caller waits on it.
    for (const callId of mine) {
      const e = this.calls.get(callId);
      if ((e !== undefined && !this.borrowed.has(callId)) || this.claiming.has(callId)) continue;
      void this.inOrder(callId, () => lease.leases.release(callId, lease.owner, 'stop'))
        .catch((err: unknown) => this.log(`${callId}: could not give up the call's lease: ${err instanceof Error ? err.message : String(err)}`));
    }
    for (const [callId, e] of [...this.calls]) {
      if (e.ended || this.borrowed.has(callId) || mine.has(callId)) continue;
      // Taken after the renewal began: its claim may have come after the renewal's statement.
      if ((this.claimedAt.get(callId) ?? began) >= began) continue;
      this.lose(callId, 'its lease is held by another server now');
    }
  }

  /**
   * With a shared store, every call this server holds let go and its lease given up (a stop, which has
   * already given the turns running their time), after the saves queued for it.
   */
  async releaseAll(): Promise<void> {
    const lease = this.lease;
    if (lease === null) {
      // One machine's durable store: each live call saved as let go by a stop, so the server that resumes
      // it knows a planned restart from a crash (RESUMED_AFTER_MS applies to the first only).
      if (this.state === null) return;
      await Promise.all([...this.calls].filter(([callSid, e]) => !e.ended && !this.holding.has(callSid) && !e.session.ended)
        .map(([callSid, e]) => this.queueWrite(callSid, 'save the session', (state) => state.save(this.storedOf(e, { stopped: true })))));
      return;
    }
    const held = [...this.calls.keys()].filter((callId) => !this.calls.get(callId)!.ended && !this.borrowed.has(callId));
    await Promise.all(held.map(async (callId) => {
      this.drop(callId);
      await this.inOrder(callId, () => lease.leases.release(callId, lease.owner, 'stop')).catch((err: unknown) =>
        this.log(`${callId}: could not give up the call's lease: ${err instanceof Error ? err.message : String(err)}`));
    }));
  }

  /** Whether the call was restored and has not reconnected since; true once, at its reconnect. */
  takeRestored(callSid: string): boolean {
    return this.restored.delete(callSid);
  }

  /**
   * Forget the calls saved before a restart that this server never took back (their carrier never
   * called back) once they are past their time, and return them, so the caller can record their end.
   * Without a call store, none.
   */
  async sweepStored(): Promise<StoredCall[]> {
    if (this.state === null) return [];
    const gone: StoredCall[] = [];
    let ids: readonly string[];
    try {
      ids = await this.state.list();
    } catch (err) {
      this.log(`could not list the saved sessions: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
    const now = this.now();
    for (const id of ids) {
      if (this.calls.has(id)) continue;
      let c: StoredCall | null;
      try {
        c = await this.state.load(id);
      } catch {
        continue;
      }
      // One saved under another schema is kept as long as any call: its callback puts the caller through to a
      // person; so is one that ended with a transfer still owed, for the callback that takes it.
      const keep = c !== null && (c.heldHandoffData !== undefined
        ? now - c.lastActivityMs < HELD_TRANSFER_MAX_MS
        : c.schema === SESSION_SCHEMA ? this.resumable(c, now) : this.inTime(c, now));
      if (c === null || this.calls.has(id) || keep) continue;
      const lease = this.lease;
      if (lease !== null) {
        // Shared: never one a server holds, and only one server records each call it sweeps.
        let removed = false;
        try {
          removed = await lease.leases.removeUnleased(id);
        } catch {
          continue;
        }
        if (removed) gone.push(c);
        continue;
      }
      await this.forget(id);
      gone.push(c);
    }
    return gone;
  }

  attach(callSid: string, socket: SocketLike): CallEntry | undefined {
    const e = this.calls.get(callSid);
    if (!e) return undefined;
    e.socket = socket;
    e.lastActivityMs = this.now();
    return e;
  }

  /**
   * The call's socket is gone. With a shared store the carrier's reconnect may reach any server, so once
   * the turns running are done and saved this server lets the call go and gives up its lease, unless
   * the socket came back meanwhile or the call ended.
   */
  detach(callSid: string): void {
    const e = this.calls.get(callSid);
    if (!e) return;
    e.socket = null;
    const lease = this.lease;
    if (lease === null || e.ended || this.borrowed.has(callSid)) return;
    // The turn running saves first, waited for until a quarter of a hold before the server the carrier
    // reconnects to stops waiting for this one (so it takes the call rather than send the caller to a
    // person). A wait on a service is not waited out: the request is saved with the call, and the server
    // that takes it over sends it again. A turn still running when the call is given up acts on nothing
    // the call shares (the adapter checks it still holds the call before it ends it or revokes its token).
    const waitMs = Math.max(0, (lease.waitMs ?? lease.ttlMs * 1.5) - lease.ttlMs / 4);
    // A turn still running: the lease is marked closing, so the carrier's reconnect, counted in the store,
    // does not let another server take the call before this one gives it up with that turn saved.
    const turning = (this.queued.get(e) ?? 0) > 0 && !e.pending;
    if (turning) {
      void this.inOrder(callSid, () => lease.leases.markClosing(callSid, lease.owner))
        .catch((err: unknown) => this.log(`${callSid}: could not mark the call's lease closing: ${err instanceof Error ? err.message : String(err)}`));
    }
    const waiting = turning ? Promise.race([e.tail, sleep(waitMs)]) : Promise.resolve();
    const run = waiting
      .then(() => this.inOrder(callSid, async () => {
        if (this.calls.get(callSid) !== e || e.socket !== null || e.ended) return;
        const how = this.releaseKind();
        this.drop(callSid);
        await lease.leases.release(callSid, lease.owner, how);
        this.log(`${callSid}: let go: its socket closed, and the server its carrier reconnects to takes it`);
      }))
      .catch((err: unknown) => this.log(`${callSid}: could not give up the call's lease: ${err instanceof Error ? err.message : String(err)}`));
    this.releasing.add(run);
    void run.then(() => this.releasing.delete(run));
  }

  touch(callSid: string): void {
    const e = this.calls.get(callSid);
    if (e) e.lastActivityMs = this.now();
  }

  /**
   * Serialize work per call: fn runs after everything previously queued for this call, errors
   * are logged, the chain continues. A call already ended skips the fn (a turn queued behind
   * the completing turn must not speak after the end). The chain itself can never become a
   * rejected promise, even if logging the error fails (e.g. ENOSPC) - a poisoned tail would
   * cause every later enqueue to silently skip its fn forever.
   */
  enqueue(callSid: string, fn: (entry: CallEntry) => Promise<void>): Promise<void> {
    const e = this.calls.get(callSid);
    if (!e) return Promise.resolve();
    const run = e.tail
      .then(async () => {
        if (e.ended) return;
        e.inFlight++;
        try {
          await fn(e);
        } finally {
          e.inFlight--;
        }
      })
      .catch((err: unknown) => {
        const stack = err instanceof Error && err.stack ? `\n${err.stack}` : '';
        const message = err instanceof Error ? `${err.name}: ${err.message}${stack}` : String(err);
        try {
          e.frames.write('log', { error: message });
        } catch (logErr) {
          console.error(`sessions: failed to log turn error for ${callSid}`, message, logErr);
        }
      });
    e.tail = run.catch(() => {});
    e.lastActivityMs = this.now();
    this.queued.set(e, (this.queued.get(e) ?? 0) + 1);
    void e.tail.then(() => this.queued.set(e, (this.queued.get(e) ?? 1) - 1));
    return run;
  }

  /** The queue tail of every live call, so a shutdown can wait for turns that are already running. */
  tails(): Promise<void>[] {
    return [...this.calls.values()].map((e) => e.tail);
  }

  end(callSid: string): void {
    const e = this.calls.get(callSid);
    if (e) {
      // `end` is idempotent and can arrive twice (the adapter and the action callback both call
      // it), but the grace period runs from the first end, not the last.
      // Forgotten at the first end: a second (the callback's, after a turn's) leaves alone a transfer
      // the first saved as still owed (endHolding).
      const first = !e.ended;
      if (first) e.endedAtMs = this.now();
      e.ended = true;
      e.lastActivityMs = this.now();
      if (this.state !== null && first && !this.holding.has(callSid)) void this.forget(callSid, !this.borrowed.has(callSid));
    }
  }

  /**
   * Remove sessions that have outlived their usefulness, and return the evicted call SIDs.
   *
   * Three reasons to go: the entry is older than `maxAgeMs` (a hard cap, which is the only one
   * that ignores in-flight work - an entry that old is stuck, and waiting for a turn that will
   * never finish is what leaked it), the call ended more than `ENDED_GRACE_MS` ago, or it has
   * been idle longer than the TTL.
   */
  evictIdle(): string[] {
    const now = this.now();
    const idleCutoff = now - this.ttlMs;
    const gone: string[] = [];
    for (const [sid, e] of this.calls) {
      const expired = now - e.createdAtMs >= this.maxAgeMs;
      if (!expired) {
        if (e.inFlight > 0) continue;
        const graceOver = e.ended && e.endedAtMs !== null && now - e.endedAtMs >= ENDED_GRACE_MS;
        if (!graceOver && e.lastActivityMs >= idleCutoff) continue;
      }
      if (e.socket) e.socket.close(1000, expired ? 'session expired' : 'session evicted');
      const owned = !this.borrowed.has(sid);
      this.calls.delete(sid);
      this.borrowed.delete(sid);
      this.holding.delete(sid);
      if (this.state !== null) void this.forget(sid, owned);
      gone.push(sid);
    }
    return gone;
  }
}
