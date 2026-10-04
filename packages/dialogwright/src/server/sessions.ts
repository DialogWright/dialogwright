import { SESSION_SCHEMA, type Session } from '../core/session';
import { appOf } from '../core/app/registry';
import type { CallStateStore, StoredCall } from './stores/types';
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
}

export type CallFactory = (callSid: string) => CallResources;

/**
 * How long an ended call is kept after it ends. Long enough for a late `/cr-action` callback or a
 * stray frame to find the session it belongs to, short enough that a busy line does not accumulate
 * finished calls for the half hour the idle TTL would allow.
 */
export const ENDED_GRACE_MS = 60_000;

/** Nothing legitimate keeps one phone call alive this long; past it the entry is a leak. */
export const DEFAULT_SESSION_MAX_AGE_MS = 7_200_000;

/** Where a SessionStore saves its calls, and where it says what it could not do. */
export interface SessionStoreOptions {
  /**
   * Where each call is saved after every turn, and loaded from when a call this server does not hold
   * calls back (SESSION_STORE=file:<dir>, server/stores/file.ts). Absent or null (SESSION_STORE=memory,
   * the default), nowhere: the entry here is the call's only copy, as it always was.
   */
  state?: CallStateStore | null;
  log?: (line: string) => void;
}

/** What `restore` found: the call already here, loaded from the store, nothing to resume, or a call saved in a shape this server cannot read. */
export type RestoreResult = 'held' | 'restored' | 'none' | 'unreadable';

/**
 * The calls this server holds, with what is live about each (its socket, its turn queue). With a call
 * store (SessionStoreOptions.state) it also saves each call after every turn (persist), forgets it
 * when it ends or is evicted, and loads one it does not hold when its carrier calls back for it after
 * a restart (restore), so the call goes on where it was.
 */
export class SessionStore {
  private readonly calls = new Map<string, CallEntry>();
  private readonly state: CallStateStore | null;
  private readonly log: (line: string) => void;
  /** Each call's saves and removals, in order, so a slow store never writes an older save over a newer one. */
  private readonly writes = new Map<string, Promise<void>>();
  /** Calls loaded from the store whose carrier has not yet reconnected: the first line they hear says they were lost for a moment. */
  private readonly restored = new Set<string>();

  constructor(
    private readonly factory: CallFactory,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxAgeMs: number = DEFAULT_SESSION_MAX_AGE_MS,
    options: SessionStoreOptions = {},
  ) {
    this.state = options.state ?? null;
    this.log = options.log ?? ((line) => console.log(`[server] ${line}`));
  }

  /** Whether calls are saved somewhere that outlives this process (a call store was given). */
  get durable(): boolean {
    return this.state !== null;
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

  /**
   * Save the call as it is now (after a turn, a reconnect): its session, its counters and its audit
   * entries. A call that has ended is forgotten instead. Without a call store, nothing.
   */
  persist(callSid: string): Promise<void> {
    const e = this.calls.get(callSid);
    if (!e || this.state === null) return Promise.resolve();
    if (e.ended || e.session.ended) return this.forget(callSid);
    const call: StoredCall = {
      callId: callSid,
      provider: e.provider ?? 'twilio',
      schema: SESSION_SCHEMA,
      session: e.session,
      reconnects: e.reconnects,
      createdAtMs: e.createdAtMs,
      lastActivityMs: e.lastActivityMs,
      auditTail: [...e.auditEntries],
    };
    return this.queueWrite(callSid, 'save the session', (state) => state.save(call));
  }

  /** Remove the call from the store (it ended, or it is past its time). */
  private forget(callSid: string): Promise<void> {
    this.restored.delete(callSid);
    return this.queueWrite(callSid, 'remove the saved session', (state) => state.remove(callSid));
  }

  /** Every save and removal queued so far, done. */
  async settled(): Promise<void> {
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
      return 'none';
    }
    if (c === null) return 'none';
    // Loaded while another callback for it did the same.
    if (this.calls.has(callId)) return 'held';
    if (c.schema !== SESSION_SCHEMA) {
      this.log(`${callId}: not resumed: saved under session schema ${c.schema}, and this server reads ${SESSION_SCHEMA}`);
      await this.forget(callId);
      return 'unreadable';
    }
    try {
      appOf(c.session);
    } catch {
      this.log(`${callId}: not resumed: saved for the app "${String(c.session.appId)}", which this server does not run`);
      await this.forget(callId);
      return 'unreadable';
    }
    if (c.provider !== provider) {
      this.log(`${callId}: not resumed: saved for ${c.provider}, and the callback is from ${provider}`);
      return 'none';
    }
    const now = this.now();
    if (!this.resumable(c, now)) {
      await this.forget(callId);
      return 'none';
    }
    const entry: CallEntry = {
      ...this.factory(callId),
      session: c.session,
      callSid: callId,
      socket: null,
      reconnects: c.reconnects,
      createdAtMs: c.createdAtMs,
      lastActivityMs: now,
      ended: false,
      endedAtMs: null,
      tail: Promise.resolve(),
      inFlight: 0,
      auditEntries: [...c.auditTail],
      provider: c.provider,
    };
    this.calls.set(callId, entry);
    this.restored.add(callId);
    this.log(`${callId}: restored from the session store (turn ${c.session.turnIndex}, reconnect ${c.reconnects})`);
    return 'restored';
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
      // One saved under another schema is kept as long as any call: its callback puts the caller through to a person.
      const keep = c !== null && (c.schema === SESSION_SCHEMA ? this.resumable(c, now) : this.inTime(c, now));
      if (c === null || this.calls.has(id) || keep) continue;
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

  detach(callSid: string): void {
    const e = this.calls.get(callSid);
    if (e) e.socket = null;
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
      if (!e.ended) e.endedAtMs = this.now();
      e.ended = true;
      e.lastActivityMs = this.now();
      if (this.state !== null) void this.forget(callSid);
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
      this.calls.delete(sid);
      if (this.state !== null) void this.forget(sid);
      gone.push(sid);
    }
    return gone;
  }
}
