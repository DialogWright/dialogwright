import type { DashboardEvent } from './events';

/** An event as it leaves the bus: numbered, so the SSE stream has an `id` and a page can tell gaps. */
export type PublishedEvent = DashboardEvent & { seq: number };

export type Subscriber = (event: PublishedEvent) => void;

/** One call's history on the bus, and whether its latest word is that it ended. */
interface CallHistory {
  events: PublishedEvent[];
  ended: boolean;
}

/** Events after which a call that said it ended is live again (a reconnect after the hangup webhook). */
const LIVE_AGAIN = new Set(['reconnect', 'asked', 'turn']);

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
  constructor(private readonly maxHistory = 2000, private readonly maxEnded = 20, private readonly maxCalls = 500) {}

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
    let call = this.calls.get(event.callSid);
    if (event.type === 'call_started') {
      this.calls.delete(event.callSid);
      call = { events: [], ended: false };
      this.calls.set(event.callSid, call);
      this.newest = event.callSid;
    } else if (call === undefined) {
      return;
    }
    if (event.type === 'ended') call.ended = true;
    else if (LIVE_AGAIN.has(event.type)) call.ended = false;
    // `seq` is globally monotonic, not per call: it is the SSE id, and a page that reconnects
    // across a call boundary must never be handed an id it has already seen.
    const numbered: PublishedEvent = { ...event, seq: ++this.seq };
    call.events.push(numbered);
    if (call.events.length > this.maxHistory) {
      // Keep call_started at index 0, drop the oldest of the rest.
      call.events.splice(1, call.events.length - this.maxHistory);
    }
    if (event.type === 'call_started' || event.type === 'ended') this.prune();
    for (const s of this.subscribers) this.deliver(s, numbered);
  }

  /** Drops the oldest calls that ended past `maxEnded`, then the oldest calls past `maxCalls`. */
  private prune(): void {
    const ended = [...this.calls].filter(([, c]) => c.ended).map(([sid]) => sid);
    for (const sid of ended.slice(0, Math.max(0, ended.length - this.maxEnded))) this.calls.delete(sid);
    while (this.calls.size > this.maxCalls) {
      const oldestEnded = [...this.calls].find(([, c]) => c.ended)?.[0];
      this.calls.delete(oldestEnded ?? this.calls.keys().next().value!);
    }
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
