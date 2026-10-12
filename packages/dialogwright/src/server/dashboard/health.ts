import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { DashboardBus } from './bus';
import { verifyChainAsync } from '../../audit/verify';
import { verifyPostgresAudit } from '../../audit/postgres';
import type { SqlQueryable } from '../stores/sql';

/**
 * The console's Health page: is the line healthy. What it reads is the server's own: the servers seen
 * (this one, and with a shared store every server that said it is up in the last minutes, through the
 * notices), `/health`'s numbers, the decision model's latency over the last hour (from the console's bus,
 * so every server's calls with a shared store), the reconnects and fallback dials today, and the audit
 * verified on demand. Numbers only: no call, no caller.
 */

/** `/health`'s numbers, as the server answers them. */
export interface HealthNumbers {
  sessions: number;
  retained: number;
  chat?: number;
  draining?: boolean;
  disk?: { traceBytes: number; auditBytes: number; freeBytes?: number | null; low?: boolean };
  traces?: { failures: number; dropped: number };
}

/** What a server says of itself, to the others (a notice) and to its own console. */
export interface ServerReport {
  /** Its name (SERVER_ID with its suffix). */
  server: string;
  /** The calls (and chats) it holds now. */
  calls: number;
  chats: number;
  /** Today (the server's day, TIMEZONE): reconnects answered, and calls put through to a person by the server itself rather than a decision (a fallback dial). */
  reconnects: number;
  fallbacks: number;
  day: string;
}

/** A server another one heard from, and when. */
export interface ServerSeen extends ServerReport {
  lastSeenMs: number;
  self: boolean;
}

/**
 * The reconnects and fallback dials this server answered today (http.ts counts them): a reconnect is a
 * live call's carrier connecting again after its socket closed; a fallback dial is a call put through to
 * the handoff number by the server rather than by the dialog (the server draining or closing, a token or
 * a store that could not be written or read, a call past its reconnects).
 */
export class DayCounters {
  private day = '';
  private counts = { reconnects: 0, fallbacks: 0 };

  constructor(private readonly today: () => string) {}

  private roll(): void {
    const d = this.today();
    if (d !== this.day) { this.day = d; this.counts = { reconnects: 0, fallbacks: 0 }; }
  }

  count(kind: 'reconnects' | 'fallbacks'): void {
    this.roll();
    this.counts[kind] += 1;
  }

  /** Today's counts, and the day. */
  now(): { reconnects: number; fallbacks: number; day: string } {
    this.roll();
    return { ...this.counts, day: this.day };
  }
}

/** Whether a callback's note (http.ts decideAction's) is a reconnect, a fallback dial, or neither. */
export function noteKind(note: string): 'reconnects' | 'fallbacks' | null {
  if (note.includes('dial:') || note === 'gave-up') return 'fallbacks';
  if (note.startsWith('reconnect')) return 'reconnects';
  return null;
}

/** The latency window: an hour. */
const LATENCY_WINDOW_MS = 3_600_000;
/** The most asks kept in the window. */
const LATENCY_MAX = 50_000;

/**
 * The decision model's latency over the last hour: each turn that asked it (a record with questions) as
 * the console's bus carries it, its `timing.askMs`. Watched from the server's start (index.ts), so the
 * Health page has the hour before it was opened.
 */
export class ModelLatency {
  private readonly asks: { at: number; ms: number }[] = [];

  constructor(bus: DashboardBus, private readonly now: () => number = Date.now) {
    bus.subscribe((e) => {
      if (e.type !== 'turn') return;
      const r = e.record;
      const ms = r?.timing?.askMs;
      if (!r || r.questions === null || r.questions === undefined || typeof ms !== 'number' || !Number.isFinite(ms)) return;
      this.add(ms);
    });
  }

  add(ms: number): void {
    this.asks.push({ at: this.now(), ms });
    if (this.asks.length > LATENCY_MAX) this.asks.splice(0, this.asks.length - LATENCY_MAX);
  }

  /** The median and 95th percentile of the last hour's asks, in ms, and how many; nulls with none. */
  stats(): { asks: number; medianMs: number | null; p95Ms: number | null } {
    const since = this.now() - LATENCY_WINDOW_MS;
    while (this.asks.length > 0 && this.asks[0]!.at < since) this.asks.shift();
    const sorted = this.asks.map((a) => a.ms).sort((a, b) => a - b);
    const at = (q: number): number | null => (sorted.length === 0 ? null : Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!));
    return { asks: sorted.length, medianMs: at(0.5), p95Ms: at(0.95) };
  }
}

const latencies = new WeakMap<DashboardBus, ModelLatency>();
/** The bus's latency window, made the first time it is asked for (index.ts asks at start). */
export function latencyOf(bus: DashboardBus): ModelLatency {
  let l = latencies.get(bus);
  if (!l) { l = new ModelLatency(bus); latencies.set(bus, l); }
  return l;
}

/** The servers on one database say they are up this often (a notice), and are listed while heard from within SEEN_MS. */
export const REPORT_EVERY_MS = 30_000;
export const SEEN_MS = 120_000;

/** The servers heard from (the notices' `server` topic): each one's latest report, and when. */
export class ServersSeen {
  private readonly seen = new Map<string, { report: ServerReport; at: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** A report another server sent (its body, as published). */
  heard(origin: string, body: string): void {
    let r: Partial<ServerReport>;
    try {
      r = JSON.parse(body) as Partial<ServerReport>;
    } catch {
      return;
    }
    const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
    this.seen.set(origin, { at: this.now(), report: { server: origin, calls: n(r.calls), chats: n(r.chats), reconnects: n(r.reconnects), fallbacks: n(r.fallbacks), day: typeof r.day === 'string' ? r.day.slice(0, 10) : '' } });
    if (this.seen.size > 500) this.seen.delete(this.seen.keys().next().value!);
  }

  /** Whether a server was heard from before (within SEEN_MS). */
  knows(origin: string): boolean {
    const s = this.seen.get(origin);
    return s !== undefined && s.at >= this.now() - SEEN_MS;
  }

  /** The servers heard from within SEEN_MS, the most recent first. */
  list(): ServerSeen[] {
    const since = this.now() - SEEN_MS;
    return [...this.seen.values()].filter((s) => s.at >= since).sort((a, b) => b.at - a.at).map((s) => ({ ...s.report, lastSeenMs: s.at, self: false }));
  }
}

/** One verification of the audit, as the Health page shows it. */
export interface AuditCheck {
  ok: boolean;
  kind: 'files' | 'postgres';
  /** Day files (or the database's chains) walked, and their entries. */
  chains: number;
  entries: number;
  /** The first breaks found, at most 20 (each names a day file and line, or a call and entry: no value). */
  breaks: string[];
  at: number;
  tookMs: number;
}

/**
 * Verifies the audit as `pnpm audit:verify` does: every day file's chain under `dir` (and each app's
 * folder and the server's own on a host), or, with AUDIT_STORE=postgres, every call's chain and every
 * day's anchors in the database; read and walked without holding the server's calls up.
 */
export async function verifyAudit(target: { dir: string } | { sql: SqlQueryable }, now: () => number = Date.now): Promise<AuditCheck> {
  const started = now();
  if ('sql' in target) {
    const r = await verifyPostgresAudit(target.sql);
    return { ok: r.breaks.length === 0, kind: 'postgres', chains: r.chains, entries: r.entries, breaks: r.breaks.slice(0, 20), at: now(), tookMs: now() - started };
  }
  const breaks: string[] = [];
  let files = 0;
  let entries = 0;
  const walk = async (folder: string, prefix: string): Promise<void> => {
    let names: string[];
    try {
      names = (await readdir(folder)).filter((n) => n.endsWith('.jsonl')).sort();
    } catch {
      return;
    }
    for (const f of names) {
      const r = await verifyChainAsync(join(folder, f)).catch((e: unknown) => ({ ok: false as const, entries: 0, brokenAt: 0, why: e instanceof Error ? e.message : String(e) }));
      files += 1;
      entries += r.entries;
      if (!r.ok) breaks.push(`${prefix}${f}: BROKEN at line ${r.brokenAt} of ${r.entries} (${r.why})`);
    }
  };
  await walk(target.dir, '');
  let subs: string[] = [];
  try {
    subs = (await readdir(target.dir, { withFileTypes: true })).filter((e) => e.isDirectory() && /^(_server|[a-z][a-z0-9_-]*)$/.test(e.name)).map((e) => e.name).sort();
  } catch {
    subs = [];
  }
  for (const sub of subs) await walk(join(target.dir, sub), `${sub}/`);
  return { ok: breaks.length === 0, kind: 'files', chains: files, entries, breaks: breaks.slice(0, 20), at: now(), tookMs: now() - started };
}

/** What the server gives the console's Health page (index.ts makes it; DashboardDeps.health). */
export interface HealthSource {
  /** This server's report, as it would send it. */
  self(): ServerReport;
  /** `/health`'s numbers. */
  numbers(): HealthNumbers;
  /** With a shared store, the other servers heard from; absent on one machine. */
  peers?: () => ServerSeen[];
  /** Verifies the audit (files, or the database); absent when there is none to verify. */
  verify?: () => Promise<AuditCheck>;
  /** Where the audit is, in words (a folder or the database, password masked). */
  auditLabel?: string;
}

/** The audit verified on demand, one at a time: an asker while one runs gets its answer; the last kept for the page. */
export class AuditVerifier {
  private running: Promise<AuditCheck> | null = null;
  last: AuditCheck | null = null;

  constructor(private readonly run: () => Promise<AuditCheck>) {}

  verify(): Promise<AuditCheck> {
    this.running ??= this.run().then((r) => { this.last = r; return r; }).finally(() => { this.running = null; });
    return this.running;
  }

  get busy(): boolean {
    return this.running !== null;
  }
}
