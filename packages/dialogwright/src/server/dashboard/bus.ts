import type { DashboardEvent } from './events';

/** An event as it leaves the bus: numbered, so the SSE stream has an `id` and a page can tell gaps. */
export type PublishedEvent = DashboardEvent & { seq: number };

export type Subscriber = (event: PublishedEvent) => void;

/** One call's history on the bus, and whether its latest word is that it ended. */
interface CallHistory {
  events: PublishedEvent[];
  ended: boolean;
  /** How it ended (the `ended` event's reason), and when the bus heard it (its own clock). */
  endedBy: string | null;
  endedAtMs: number;
  /** The clock (the bus's) of its latest event: a call silent for long is taken for ended (markStale). */
  lastMs: number;
  /** The history's size as written (its events' JSON), for the byte budget. */
  bytes: number;
  /** Events dropped from the history (the bounds), for a viewer who catches up on it to be told. */
  dropped: number;
}

/** How long a call handed off stays kept past `maxEnded`: the Live list shows it as with a person that long (view.js HANDED_OFF_SHOWN_MS). */
const HANDED_OFF_KEPT_MS = 120_000;

export interface BusOptions {
  /** The bus's clock (default Date.now). */
  now?: () => number;
  /** The bytes of history kept in all (each event's JSON), dropping the oldest ended calls' first; default 64 MB. */
  maxBytes?: number;
}

/**
 * Fans dashboard events out to subscribers and keeps each call's history, so a page opened mid-call
 * catches up: every call in progress (the console's Live list), and the most recent calls that ended
 * (a call's detail opened just after it ended, and the view that follows the newest call, as before).
 * A call is known from its `call_started`; an event for a call the bus never saw start is ignored, as
 * before. A `call_started` for a call already known starts its history over.
 */
export class DashboardBus {
  /** Each call's history, in the order the calls started (a call that starts again moves to the end). */
  private calls = new Map<string, CallHistory>();
  private subscribers = new Set<Subscriber>();
  /** The call that started last: the one the follow-the-newest view shows. */
  private newest: string | null = null;
  private seq = 0;
  /** Where each event published here also goes (the other servers' consoles); null on one machine. */
  private outbound: ((event: DashboardEvent) => void) | null = null;

  /**
   * `maxHistory` bounds each call's history (its `call_started` always kept); `maxEnded` how many calls
   * that ended are kept, the newest; `maxCalls` how many calls in all, dropping the oldest that ended
   * first, then the oldest.
   */
  private readonly now: () => number;
  private readonly maxBytes: number;
  private bytes = 0;

  constructor(private readonly maxHistory = 2000, private readonly maxEnded = 20, private readonly maxCalls = 500, opts: BusOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.maxBytes = opts.maxBytes ?? 64 * 1024 * 1024;
  }

  /**
   * One delivery to one subscriber. A watcher of a call can never change the call, so a throw is
   * swallowed here rather than in each caller: both the live fan-out and the history replay go
   * through this, which is what keeps a subscriber that throws on an old event from being refused
   * the new ones.
   */
  private deliver(fn: Subscriber, event: PublishedEvent): void {
    try { fn(event); } catch { /* a broken subscriber never breaks a call */ }
  }

  publish(event: DashboardEvent): void {
    this.accept(event);
    if (this.outbound !== null) {
      try { this.outbound(event); } catch { /* another server's console never breaks a call */ }
    }
  }

  /**
   * With several servers on one database (stores/notices.ts): every event published here is handed to
   * `send` too, and the events other servers publish come in through receive(), so one console follows
   * every server's calls. Not called on one machine, where the bus is as it was.
   */
  link(send: (event: DashboardEvent) => void): void {
    this.outbound = send;
  }

  /** An event another server published, taken as if published here, and sent nowhere else. */
  receive(event: DashboardEvent): void {
    this.accept(event);
  }

  private accept(event: DashboardEvent): void {
    // A reconnect for a call this bus never saw start (this server restarted, or joined the others
    // after the call began) starts it here, from what the reconnect carries: the Live list has it.
    if (event.type === 'reconnect' && event.call && !this.calls.has(event.callSid)) {
      const c = event.call;
      this.accept({
        type: 'call_started', callSid: event.callSid, at: c.startedAt, from: c.from, todayIso: c.todayIso, thresholds: c.thresholds,
        ...(c.channel !== undefined ? { channel: c.channel } : {}), ...(c.provider !== undefined ? { provider: c.provider } : {}), ...(c.app !== undefined ? { app: c.app } : {}), caller: null,
      });
    }
    let call = this.calls.get(event.callSid);
    if (event.type === 'call_started') {
      this.forget(event.callSid);
      call = { events: [], ended: false, endedBy: null, endedAtMs: 0, lastMs: this.now(), bytes: 0, dropped: 0 };
      this.calls.set(event.callSid, call);
      this.newest = event.callSid;
    } else if (call === undefined) {
      return;
    }
    call.lastMs = this.now();
    if (event.type === 'ended') {
      call.ended = true;
      call.endedBy = event.reason;
      call.endedAtMs = call.lastMs;
    } else if (event.type === 'reconnect' || call.endedBy === 'stale') {
      // A reconnect after the hangup webhook makes the call live again, as does any word from a call
      // only taken for ended for its silence; a turn finishing after an end it was told of (one in
      // flight when the hangup came) does not.
      call.ended = false;
      call.endedBy = null;
    }
    // `seq` is globally monotonic, not per call: it is the SSE id, and a page that reconnects
    // across a call boundary must never be handed an id it has already seen.
    const numbered: PublishedEvent = { ...event, seq: ++this.seq };
    const size = JSON.stringify(numbered).length;
    call.events.push(numbered);
    call.bytes += size;
    this.bytes += size;
    if (call.events.length > this.maxHistory) this.trim(call, call.events.length - this.maxHistory);
    if (event.type === 'call_started' || event.type === 'ended') this.prune();
    if (this.bytes > this.maxBytes) this.fitBytes(event.callSid);
    for (const s of this.subscribers) this.deliver(s, numbered);
  }

  /** Drops a call's `n` oldest events after its call_started, counting them. */
  private trim(call: CallHistory, n: number): void {
    const gone = call.events.splice(1, n);
    const size = gone.reduce((sum, e) => sum + JSON.stringify(e).length, 0);
    call.bytes -= size;
    this.bytes -= size;
    call.dropped += gone.length;
  }

  private forget(callSid: string): void {
    const call = this.calls.get(callSid);
    if (!call) return;
    this.bytes -= call.bytes;
    this.calls.delete(callSid);
  }

  /** A call handed off a moment ago, which the Live list still shows as with a person. */
  private handedOffLately(c: CallHistory): boolean {
    return c.endedBy === 'handoff' && this.now() - c.endedAtMs < HANDED_OFF_KEPT_MS;
  }

  /**
   * Drops the oldest calls that ended past `maxEnded` (a call handed off a moment ago is kept while the
   * Live list shows it), then the oldest calls past `maxCalls`, those that ended first.
   */
  private prune(): void {
    const ended = [...this.calls].filter(([, c]) => c.ended && !this.handedOffLately(c)).map(([sid]) => sid);
    for (const sid of ended.slice(0, Math.max(0, ended.length - this.maxEnded))) this.forget(sid);
    while (this.calls.size > this.maxCalls) {
      const oldestEnded = [...this.calls].find(([, c]) => c.ended)?.[0];
      this.forget(oldestEnded ?? this.calls.keys().next().value!);
    }
  }

  /**
   * Over the byte budget: the oldest ended calls go first (not `keep`, the call just written to); then
   * the oldest events of the calls in progress, oldest call first, each call's call_started kept and its
   * drops counted, so a viewer who catches up on it is told (routes.ts `event: missed`).
   */
  private fitBytes(keep: string): void {
    for (const [sid, c] of [...this.calls]) {
      if (this.bytes <= this.maxBytes) return;
      if (c.ended && sid !== keep) this.forget(sid);
    }
    for (const c of this.calls.values()) {
      while (this.bytes > this.maxBytes && c.events.length > 1) this.trim(c, Math.max(1, Math.ceil((c.events.length - 1) / 2)));
      if (this.bytes <= this.maxBytes) return;
    }
  }

  /**
   * Takes for ended every call in progress that has had no event for `staleMs` (a server that stopped
   * with it, a peer that died): it is no longer counted in progress, and is dropped as ended calls are.
   * Publishes nothing: the Live list settles its row (calls.ts settled). Returns the calls it marked.
   */
  markStale(staleMs: number): string[] {
    const cutoff = this.now() - staleMs;
    const marked: string[] = [];
    for (const [sid, c] of this.calls) {
      if (c.ended || c.lastMs > cutoff) continue;
      c.ended = true;
      c.endedBy = 'stale';
      c.endedAtMs = this.now();
      marked.push(sid);
    }
    if (marked.length > 0) this.prune();
    return marked;
  }

  /** How many of a call's events its history no longer holds (its bounds), for a viewer catching up on it. */
  droppedOf(callSid: string): number {
    return this.calls.get(callSid)?.dropped ?? 0;
  }

  /** The bytes of history kept. */
  sizeInBytes(): number {
    return this.bytes;
  }

  /** Replays every kept call's history in the order it was published, then streams. Returns the unsubscribe function. */
  subscribe(fn: Subscriber): () => void {
    for (const e of this.history()) this.deliver(fn, e);
    this.subscribers.add(fn);
    return () => { this.subscribers.delete(fn); };
  }

  /** Every kept call's events, in the order they were published. */
  history(): PublishedEvent[] {
    return [...this.calls.values()].flatMap((c) => c.events).sort((a, b) => a.seq - b.seq);
  }

  /** One call's events as kept, or an empty list for a call the bus does not keep. */
  historyOf(callSid: string): readonly PublishedEvent[] {
    return this.calls.get(callSid)?.events ?? [];
  }

  /** The calls kept, in the order they started. */
  callIds(): string[] {
    return [...this.calls.keys()];
  }

  /** Whether the call's latest word is that it ended (false for a call the bus does not keep). */
  hasEnded(callSid: string): boolean {
    return this.calls.get(callSid)?.ended ?? false;
  }

  /** The call that started last, kept or not: the one the follow-the-newest view shows. */
  current(): string | null { return this.newest; }
  size(): number { return this.subscribers.size; }
}
