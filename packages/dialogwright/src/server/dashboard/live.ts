import type { DashboardBus } from './bus';
import type { ConsoleMeta } from './meta';
import { callRow, settledRow, STALE_MS } from './view.js';
import type { CallRow } from './rows';

/** What the Live list's feed sends after its first list: a call's row as it now stands, or a call the console no longer keeps. */
export type LiveChange = { type: 'row'; row: CallRow } | { type: 'gone'; callSid: string };

/**
 * Events that change nothing a row shows but its last word's time: kept up without folding the call
 * again (a turn's audit entries, a delivery note, the handoff summary, a keypress or a silence, whose
 * turn follows).
 */
const LIGHT = new Set(['audit', 'delivery', 'handoff_summary', 'dtmf', 'silence', 'interrupt']);

/** How often the list looks for calls that have gone silent (STALE_MS). */
const STALE_CHECK_MS = 60_000;

/**
 * The console's Live list on the server: every call the bus keeps, each as a row (view.js callRow) in
 * its own app's words, worked out from the events the bus already carries and sent to each viewer only
 * when it changed, so a viewer of the list never receives a call's whole history. One per bus, shared by
 * every viewer; the rows are redacted as the events they are read from are (the bus carries nothing the
 * console may not show), and a row holds no value a caller gave, only what was asked.
 *
 * Events arriving together (a turn, then its audit entries) are worked out once, at the end of the
 * task that published them; an event that changes nothing shown but the time of the call's last word
 * is not worked out at all. A call with no end recorded and no word for STALE_MS is settled as ended
 * ("no end recorded", view.js settledRow), and the bus takes it for ended (bus.ts markStale): a server
 * that stopped with calls on it, or a peer that died, leaves no call in progress for ever.
 */
export class LiveCalls {
  private rows = new Map<string, CallRow>();
  private dirty = new Set<string>();
  private watchers = new Set<(change: LiveChange) => void>();
  private scheduled = false;

  constructor(private readonly bus: DashboardBus, private readonly metaOf: (app: string | null) => ConsoleMeta | null, private readonly now: () => number = Date.now) {
    bus.subscribe((e) => {
      const row = this.rows.get(e.callSid);
      if (row !== undefined && LIGHT.has(e.type) && !this.dirty.has(e.callSid)) {
        if (typeof e.at === 'number' && (row.lastAt === null || e.at > row.lastAt)) this.rows.set(e.callSid, { ...row, lastAt: e.at });
        return;
      }
      this.mark(e.callSid);
    });
    const timer = setInterval(() => this.settleStale(), STALE_CHECK_MS);
    timer.unref?.();
  }

  /** The calls silent for STALE_MS: taken for ended on the bus, and their rows settled. */
  settleStale(): void {
    for (const sid of this.bus.markStale(STALE_MS)) this.dirty.add(sid);
    for (const [sid, row] of this.rows) if (row.ending === null && settledRow(row, this.now()) !== row) this.dirty.add(sid);
    this.flush();
  }

  private mark(callSid: string): void {
    this.dirty.add(callSid);
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => this.flush());
  }

  private send(change: LiveChange): void {
    for (const w of this.watchers) {
      try { w(change); } catch { /* a broken viewer never breaks the list */ }
    }
  }

  /** Works out every call marked since the last time, and drops the calls the bus no longer keeps. */
  private flush(): void {
    this.scheduled = false;
    const keptIds = new Set(this.bus.callIds());
    for (const sid of [...this.rows.keys()]) {
      if (keptIds.has(sid)) continue;
      this.rows.delete(sid);
      this.send({ type: 'gone', callSid: sid });
    }
    const marked = [...this.dirty];
    this.dirty.clear();
    for (const sid of marked) {
      const history = this.bus.historyOf(sid);
      if (history.length === 0) continue;
      const first = history[0]!;
      const app = first.type === 'call_started' && typeof first.app === 'string' ? first.app : null;
      let row: CallRow;
      try {
        row = settledRow(callRow(history, { meta: this.metaOf(app) }), this.now());
      } catch {
        // A malformed event keeps the row as it was rather than taking the list down.
        continue;
      }
      const before = this.rows.get(sid);
      if (before !== undefined && JSON.stringify(before) === JSON.stringify(row)) continue;
      this.rows.set(sid, row);
      this.send({ type: 'row', row });
    }
  }

  /** Every kept call's row, as it now stands. */
  snapshot(): CallRow[] {
    this.flush();
    return [...this.rows.values()];
  }

  /** Each change from now on; returns the unsubscribe function. */
  watch(fn: (change: LiveChange) => void): () => void {
    this.watchers.add(fn);
    return () => { this.watchers.delete(fn); };
  }
}
