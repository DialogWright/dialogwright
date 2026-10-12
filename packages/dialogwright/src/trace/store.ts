import { randomBytes } from 'node:crypto';
import { S3Client, S3Error, type S3ClientOptions, type S3Settings } from './s3/client';
import { traceLine, type TraceSink } from './writer';
import type { App } from '../core/app/types';
import type { TraceRecord } from './types';
import { frameLine, parseFrameLog, type FrameDir, type FrameSink, type ReadFrameLogLine } from '../server/frameLog';

/**
 * Traces on S3-compatible storage (TRACE_STORE=s3://<bucket>/<prefix>): one logical trace per call,
 * whichever servers ran it. Each server writes its own segments under the call's id, and every reader
 * (the console, replay, kb:gaps, kb:review's Gaps tab) joins them in one order through one reader here
 * (S3TraceReader), so they all agree. Unset, traces are files in TRACE_DIR, as they always were
 * (TraceWriter, FrameLog), and nothing here runs.
 *
 * A call's objects, under `<prefix><day>/<call>/`, `day` the UTC day the call started (its session's
 * startedAtMs, which moves with the call, so a call that crosses midnight or moves server stays in one
 * folder) and `call` its id as its trace file is named (safeFileStem):
 *
 *   <first>-<last>-<gen>-<server>-<n>-<ms>.trace.jsonl    trace records, each line as a trace file's
 *   <turn>-<turn>-<gen>-<server>-<n>-<ms>.frames.jsonl    frame-log lines, each as a frame log's
 *   <first>-<last>-<gen>-<server>-<n>-<ms>.late.jsonl     records written after the server let the call go
 *
 * `first` and `last` are the turn indexes of a segment's first and last record (six digits; a frames
 * segment carries the call's turn when its first line was written), `gen` the call's reconnect count
 * when it was written (four digits), `server` the server that wrote it (SERVER_ID and its suffix), `n`
 * its count in that server's run (six digits), `ms` the time of its first line (thirteen digits, for
 * the console's list, never for order). Sorted by name, a call's segments are in the order they were
 * written: by turn, and within a turn by the reconnect that moved the call (every takeover follows a
 * reconnect the database counted, which the call carries), then by the writing server's own count; no
 * server's clock is compared. Two servers' segments of one turn and one reconnect (lines the first
 * wrote after the call moved) are in the order of the servers' names. A segment
 * is named once and never rewritten: one that fails is tried again under the same name.
 *
 * Writing never stops a call: a segment is written when a turn's record is (at once) and when frames
 * have waited a second, in the background; one that fails is kept and tried again (up to a bound per
 * call and for the server), logged and counted, and the call goes on. A process that dies loses what it
 * had not yet written: at most the last second of frame lines, and a record whose write was under way.
 */

/** How long frame-log lines wait to go out with others, when no record takes them sooner. */
export const FRAME_FLUSH_MS = 1_000;
/** The wait before a failed segment is tried again, doubled each time up to RETRY_MAX_MS. */
const RETRY_MS = 2_000;
const RETRY_MAX_MS = 30_000;
/** The most bytes a call keeps waiting to be written; past it a new line is dropped (and counted). */
const MAX_PENDING_BYTES = 4 * 1024 * 1024;
/** How many of a call's segments are read at once. */
const READ_CONCURRENCY = 8;

/** TRACE_STORE=s3://...: where the traces go, with the store's keys. */
export interface S3TraceSetting extends S3Settings {
  kind: 's3';
  /** The prefix each call's folder is under: empty, or ending in `/`. */
  prefix: string;
}

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const PREFIX = /^[A-Za-z0-9._\-/]*$/;

/** A store's location as it may be said: the bucket and the prefix, never a key. */
export function describeTraceStore(s: Pick<S3TraceSetting, 'bucket' | 'prefix' | 'endpoint' | 'region'>): string {
  return `s3://${s.bucket}/${s.prefix}${s.endpoint ? ` at ${new URL(s.endpoint).host}` : ''} (${s.region})`;
}

/**
 * TRACE_STORE and the S3_ variables read and checked, or null when TRACE_STORE is unset (today's files).
 * An error names the variable at fault and never a key's value.
 */
export function traceStoreSettingOf(env: Readonly<Record<string, string | undefined>>): S3TraceSetting | null {
  const raw = env.TRACE_STORE?.trim() ?? '';
  if (raw === '') return null;
  const m = /^s3:\/\/([^/]+)(?:\/(.*))?$/i.exec(raw);
  if (!m) throw new Error(`TRACE_STORE must be s3://<bucket>/<prefix> (or unset, for files in TRACE_DIR), got "${raw}"`);
  const bucket = m[1]!;
  if (!BUCKET.test(bucket)) throw new Error(`TRACE_STORE's bucket must be 3 to 63 lowercase letters, digits, dots or dashes, got "${bucket}"`);
  const trimmed = (m[2] ?? '').replace(/^\/+|\/+$/g, '');
  if (!PREFIX.test(trimmed) || trimmed.split('/').some((p) => p === '.' || p === '..')) {
    throw new Error(`TRACE_STORE's prefix may hold only letters, digits, dots, dashes, underscores and slashes, got "${trimmed}"`);
  }
  const accessKeyId = env.S3_ACCESS_KEY_ID?.trim() ?? '';
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY?.trim() ?? '';
  if (accessKeyId === '') throw new Error('TRACE_STORE=s3://... needs S3_ACCESS_KEY_ID');
  if (secretAccessKey === '') throw new Error('TRACE_STORE=s3://... needs S3_SECRET_ACCESS_KEY');
  const region = env.S3_REGION?.trim() || 'us-east-1';
  if (!/^[a-z0-9-]{2,32}$/.test(region)) throw new Error(`S3_REGION must be a region's name (us-east-1, auto), got "${region}"`);
  const endpointRaw = env.S3_ENDPOINT?.trim() ?? '';
  let endpoint: string | undefined;
  if (endpointRaw !== '') {
    let u: URL;
    try {
      u = new URL(endpointRaw);
    } catch {
      throw new Error(`S3_ENDPOINT must be an http(s) address like https://<account>.r2.cloudflarestorage.com, got "${endpointRaw}"`);
    }
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username !== '' || u.password !== '' || (u.pathname !== '/' && u.pathname !== '') || u.search !== '') {
      throw new Error(`S3_ENDPOINT must be an http(s) address with no path, user or query, like https://<account>.r2.cloudflarestorage.com, got "${u.protocol}//${u.host}${u.pathname}"`);
    }
    endpoint = u.origin;
  }
  const pathStyle = (env.S3_FORCE_PATH_STYLE?.trim() || 'off').toLowerCase();
  if (pathStyle !== 'on' && pathStyle !== 'off') throw new Error(`S3_FORCE_PATH_STYLE must be on or off, got "${env.S3_FORCE_PATH_STYLE}"`);
  return {
    kind: 's3', bucket, prefix: trimmed === '' ? '' : `${trimmed}/`, region, credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: pathStyle === 'on', ...(endpoint !== undefined ? { endpoint } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Segment names
// ---------------------------------------------------------------------------------------------

export type SegmentKind = 'trace' | 'frames' | 'late';

export interface SegmentName {
  first: number;
  last: number;
  /** The call's reconnect count when the segment's first line was written. */
  gen: number;
  ms: number;
  server: string;
  n: number;
  kind: SegmentKind;
}

const pad = (v: number, width: number): string => String(Math.max(0, Math.min(v, 10 ** width - 1))).padStart(width, '0');

export function segmentName(s: SegmentName): string {
  return `${pad(s.first, 6)}-${pad(s.last, 6)}-${pad(s.gen, 4)}-${s.server}-${pad(s.n, 6)}-${pad(s.ms, 13)}.${s.kind}.jsonl`;
}

const SEGMENT = /^(\d{6})-(\d{6})-(\d{4})-([A-Za-z0-9._-]+)-(\d{6})-(\d{13})\.(trace|frames|late)\.jsonl$/;

/** A segment's name read back, or null for anything else in the folder. */
export function parseSegmentName(name: string): SegmentName | null {
  const m = SEGMENT.exec(name);
  if (!m) return null;
  return { first: Number(m[1]), last: Number(m[2]), gen: Number(m[3]), server: m[4]!, n: Number(m[5]), ms: Number(m[6]), kind: m[7] as SegmentKind };
}

/** A UTC day as a folder is named: YYYY-MM-DD. */
const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------

/** What a call's segments are named by, read as each line is written. */
export interface CallMeta {
  /** The session's turn index now. */
  turn: number;
  /** The call's reconnect count now (0 for a chat). */
  gen: number;
  /** When the call started (its session's startedAtMs): the day its folder is under. */
  startedAtMs: number;
  /** Whether this server still holds the call (always, on one machine and for a chat). */
  held: boolean;
}

interface Pending {
  line: string;
  turn: number;
  gen: number;
  ms: number;
}

/** A batch of lines named once: written under that name, and tried again under it until it lands. */
interface Batch {
  key: string;
  body: string;
  bytes: number;
}

/** The most bytes all calls on this server keep waiting to be written; past it a new line is dropped (and counted). */
const MAX_TOTAL_PENDING_BYTES = 64 * 1024 * 1024;

/** One call's segments from this server: lines kept until they are written, in order. */
class CallSegments implements TraceSink {
  private open: Record<SegmentKind, Pending[]> = { trace: [], frames: [], late: [] };
  private readonly batches: Batch[] = [];
  private bytes = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private retryMs = RETRY_MS;
  private failedLast = false;
  /** The call's folder (`<day>/<call>`), fixed by its first batch. */
  private folder: string | null = null;

  constructor(private readonly store: S3TraceStore, private readonly call: string, private readonly meta: () => CallMeta) {}

  get pending(): boolean {
    return this.bytes > 0 || this.running !== null;
  }

  write(record: TraceRecord): void {
    const m = this.meta();
    // A record written after this server let the call go: kept, marked, in a segment of its own.
    const late = !m.held;
    this.keep(late ? 'late' : 'trace', { line: traceLine(late ? { ...record, outlivedHold: true } : record, this.store.app), turn: record.turnIndex, gen: m.gen, ms: Date.parse(record.ts) || this.store.now() });
    // A turn's record goes out at once, with the frames before it.
    void this.flush();
  }

  /** As FrameSink: the frame-log line, out within FRAME_FLUSH_MS (or with the next record). */
  writeFrame(dir: FrameDir, msg: unknown): void {
    const at = this.store.now();
    const m = this.meta();
    this.keep('frames', { line: frameLine(at, dir, msg), turn: m.turn, gen: m.gen, ms: at });
    if (this.timer === null && this.running === null) this.schedule(FRAME_FLUSH_MS);
  }

  private keep(kind: SegmentKind, p: Pending): void {
    const size = p.line.length + 1;
    // Bounded, per call and for the server: a store that stays down drops new lines (counted), never the server's memory.
    if (this.bytes + size > MAX_PENDING_BYTES || !this.store.reserve(size)) {
      this.store.dropped += 1;
      return;
    }
    this.open[kind].push(p);
    this.bytes += size;
    this.store.track(this);
  }

  private schedule(ms: number): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, ms);
    this.timer.unref?.();
  }

  /** The lines kept since the last batch, named now as batches; a batch being tried again is never added to. */
  private seal(): void {
    for (const kind of ['trace', 'frames', 'late'] as const) {
      const lines = this.open[kind];
      if (lines.length === 0) continue;
      this.open[kind] = [];
      if (this.folder === null) this.folder = `${dayOf(this.meta().startedAtMs)}/${this.call}`;
      const name = segmentName({
        first: lines[0]!.turn, last: Math.max(...lines.map((p) => p.turn)), gen: lines[0]!.gen, ms: lines[0]!.ms, server: this.store.server, n: this.store.nextSegment(), kind,
      });
      const body = lines.map((p) => `${p.line}\n`).join('');
      this.batches.push({ key: `${this.store.prefix}${this.folder}/${name}`, body, bytes: lines.reduce((n, p) => n + p.line.length + 1, 0) });
    }
  }

  /** Everything kept so far, written (or kept to try again); resolves when this pass is done. */
  flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.running === null) {
      this.running = this.drain().finally(() => {
        this.running = null;
        if (this.bytes > 0) {
          if (this.timer === null) this.schedule(this.failedLast ? this.retryMs : FRAME_FLUSH_MS);
        } else this.store.untrack(this);
      });
    }
    return this.running;
  }

  private async drain(): Promise<void> {
    this.failedLast = false;
    for (;;) {
      this.seal();
      const batch = this.batches[0];
      if (batch === undefined) return;
      try {
        await this.store.client.put(batch.key, batch.body);
      } catch (err) {
        // Kept, under its name, ahead of anything written since, and tried again later.
        this.failedLast = true;
        this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
        this.store.failed(this.call, err);
        return;
      }
      this.batches.shift();
      this.bytes -= batch.bytes;
      this.store.release(batch.bytes);
      this.retryMs = RETRY_MS;
    }
  }
}

/** A FrameSink over a call's segments (its `write` is the frame log's). */
class FrameSegments implements FrameSink {
  constructor(private readonly segments: CallSegments) {}
  write(dir: FrameDir, msg: unknown): void {
    this.segments.writeFrame(dir, msg);
  }
}

export interface S3TraceStoreOptions extends S3ClientOptions {
  /** The name this server's segments carry (the lease owner with SESSION_STORE=postgres); default `server-<random>`. */
  server?: string;
  /** The app whose slots mask each record (writer.ts traceLine): on a server of several apps, the store's own; left out, the default app. */
  app?: App;
  log?: (line: string) => void;
}

/** How often a failure to write is logged: the first at once, then at most once a minute with the count. */
const FAILURE_LOG_EVERY_MS = 60_000;

/** The traces of this server's calls written as segments on S3-compatible storage, and read back joined. */
export class S3TraceStore {
  readonly client: S3Client;
  /** The app whose slots mask each record; undefined, the default app. */
  readonly app: App | undefined;
  readonly prefix: string;
  readonly server: string;
  readonly now: () => number;
  /** Segment writes that failed (each tried again), since start. */
  failures = 0;
  /** Lines dropped because a call's (or the server's) waiting lines passed their bound. */
  dropped = 0;
  private n = 0;
  private pendingBytes = 0;
  private readonly live = new Set<CallSegments>();
  private readonly log: (line: string) => void;
  private loggedAt: number | null = null;
  private unlogged = 0;

  constructor(readonly setting: S3TraceSetting, o: S3TraceStoreOptions = {}) {
    this.client = new S3Client(setting, o);
    this.prefix = setting.prefix;
    this.server = o.server ?? `server-${randomBytes(4).toString('hex')}`;
    this.app = o.app;
    this.now = o.now ?? Date.now;
    this.log = o.log ?? (() => {});
  }

  get label(): string {
    return describeTraceStore(this.setting);
  }

  /**
   * The trace and the frame log of one call on this server, under `call` (safeFileStem of its id); `meta`
   * reads the call as it is now (its turn, its reconnect count, when it started, whether this server
   * still holds it). A number in place of `meta` is a fixed turn source, for a caller with no call.
   */
  open(call: string, meta: (() => CallMeta) | (() => number)): { trace: TraceSink; frames: FrameSink } {
    const read = (): CallMeta => {
      const m = meta();
      return typeof m === 'number' ? { turn: m, gen: 0, startedAtMs: this.now(), held: true } : m;
    };
    const segments = new CallSegments(this, call, read);
    return { trace: segments, frames: new FrameSegments(segments) };
  }

  /** The reader every reader shares. */
  reader(): S3TraceReader {
    return new S3TraceReader(this.client, this.prefix);
  }

  nextSegment(): number {
    this.n += 1;
    return this.n;
  }

  /** Room for `bytes` more waiting lines on this server, taken if there is. */
  reserve(bytes: number): boolean {
    if (this.pendingBytes + bytes > MAX_TOTAL_PENDING_BYTES) return false;
    this.pendingBytes += bytes;
    return true;
  }

  release(bytes: number): void {
    this.pendingBytes = Math.max(0, this.pendingBytes - bytes);
  }

  track(s: CallSegments): void {
    this.live.add(s);
  }

  untrack(s: CallSegments): void {
    if (!s.pending) this.live.delete(s);
  }

  /** A segment could not be written: counted, and logged (the first at once, then once a minute with how many since). */
  failed(call: string, err: unknown): void {
    this.failures += 1;
    const t = this.now();
    if (this.loggedAt !== null && t - this.loggedAt < FAILURE_LOG_EVERY_MS) {
      this.unlogged += 1;
      return;
    }
    const why = err instanceof S3Error ? err.message : err instanceof Error ? err.message : String(err);
    const since = this.unlogged > 0 ? ` (${this.unlogged} more since the last said)` : '';
    this.log(`traces: a segment of ${call} could not be written to ${this.label}: ${why}; kept to try again${since}`);
    this.loggedAt = t;
    this.unlogged = 0;
  }

  /**
   * Every call's waiting lines written, tried again a few times a second while the store fails, or `ms`
   * past (default 5 s): what a stopping server does last. What is still waiting then is lost, and counted.
   */
  async flush(ms = 5_000): Promise<void> {
    const deadline = Date.now() + ms;
    const sleep = (t: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, t).unref?.());
    while ([...this.live].some((s) => s.pending)) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all([...this.live].map((s) => s.flush())),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, left);
          timer.unref?.();
        }),
      ]).finally(() => clearTimeout(timer));
      if ([...this.live].some((s) => s.pending)) await sleep(Math.min(250, Math.max(0, deadline - Date.now())));
    }
  }

  /** The day folders under the prefix, oldest first. */
  private async days(): Promise<string[]> {
    const { prefixes } = await this.client.list(this.prefix, { delimiter: '/' });
    return prefixes.map((p) => p.slice(this.prefix.length, -1)).filter((d) => DAY.test(d)).sort();
  }

  /** Every key given deleted, a few at a time. */
  private async remove(keys: readonly string[]): Promise<void> {
    await mapLimit(keys, READ_CONCURRENCY, (key) => this.client.delete(key));
  }

  /**
   * TRACE_RETENTION_DAYS on the store: every day folder older than `days` removed, never a call in
   * `inUse`; only those days are listed. Returns the objects and calls removed. A bucket's own lifecycle
   * rule (expiration on the prefix after N days) does the same without the server, and is the native way.
   */
  async sweep(days: number, nowMs: number, inUse: ReadonlySet<string>): Promise<{ objects: number; calls: number }> {
    const cutoff = dayOf(nowMs - days * 86_400_000);
    let objects = 0;
    let calls = 0;
    for (const day of await this.days()) {
      if (day >= cutoff) break;
      const { objects: found } = await this.client.list(`${this.prefix}${day}/`);
      const byCall = groupByCall(found.map((o) => o.key), `${this.prefix}${day}/`);
      for (const [call, keys] of byCall) {
        if (inUse.has(call)) continue;
        await this.remove(keys);
        objects += keys.length;
        calls += 1;
      }
    }
    return { objects, calls };
  }

  /**
   * FIGURES_RETENTION_DAYS on the store: the console's daily figures of each day older than `days`
   * removed (`<prefix>.figures/<day>.json`, beside the day folders, which the traces' own retention
   * leaves). Returns the days removed.
   */
  async sweepFigures(days: number, nowMs: number): Promise<number> {
    const cutoff = dayOf(nowMs - days * 86_400_000);
    const under = `${this.prefix}${CONSOLE_FIGURES}/`;
    const { objects } = await this.client.list(under);
    const old = objects.map((o) => o.key).filter((k) => {
      const m = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(k.slice(under.length));
      return m !== null && m[1]! < cutoff;
    });
    await this.remove(old);
    return old.length;
  }

  /**
   * TRACE_MAX_GB on the store: while its traces are larger than `maxBytes`, the calls written least
   * recently are removed whole, never a call in `inUse`, one day folder at a time from the oldest (each
   * listed on its own, so no listing grows with the whole store). Returns the objects and calls removed,
   * and the bytes left.
   */
  async trim(maxBytes: number, inUse: ReadonlySet<string>): Promise<{ objects: number; calls: number; bytes: number }> {
    const byDay = async (day: string): Promise<Map<string, { keys: string[]; size: number; newest: number }>> => {
      const under = `${this.prefix}${day}/`;
      const { objects: found } = await this.client.list(under);
      const calls = new Map<string, { keys: string[]; size: number; newest: number }>();
      for (const o of found) {
        const rest = o.key.slice(under.length);
        const slash = rest.indexOf('/');
        if (slash <= 0) continue;
        const id = rest.slice(0, slash);
        // The console's daily figures are no call's: they outlive the traces (FIGURES_RETENTION_DAYS).
        if (id === CONSOLE_FIGURES) continue;
        const c = calls.get(id) ?? { keys: [], size: 0, newest: 0 };
        c.keys.push(o.key);
        c.size += o.size;
        c.newest = Math.max(c.newest, o.lastModifiedMs);
        calls.set(id, c);
      }
      return calls;
    };
    const days = await this.days();
    const sizes = new Map<string, number>();
    let total = 0;
    for (const day of days) {
      const size = [...(await byDay(day)).values()].reduce((n, c) => n + c.size, 0);
      sizes.set(day, size);
      total += size;
    }
    let objects = 0;
    let calls = 0;
    for (const day of days) {
      if (total <= maxBytes) break;
      for (const [id, c] of [...(await byDay(day))].sort((x, y) => x[1].newest - y[1].newest)) {
        if (total <= maxBytes) break;
        if (inUse.has(id)) continue;
        await this.remove(c.keys);
        total -= c.size;
        objects += c.keys.length;
        calls += 1;
      }
    }
    return { objects, calls, bytes: total };
  }
}

/** The folder of a day the console's daily figures are in (server/dashboard/figuresCache.ts): no call's, so no trace retention removes it. */
const CONSOLE_FIGURES = '.figures';

/** Keys under `under` (`<prefix><day>/`) grouped by the call folder they are in (the console's figures are in none). */
function groupByCall(keys: readonly string[], under: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const key of keys) {
    const rest = key.slice(under.length);
    const slash = rest.indexOf('/');
    if (slash <= 0) continue;
    const call = rest.slice(0, slash);
    if (call === CONSOLE_FIGURES) continue;
    out.set(call, [...(out.get(call) ?? []), key]);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

/** One call with a trace in the store, as the console lists it. */
export interface StoredTrace {
  /** The call's folder: its id as its trace file is named. */
  id: string;
  /** The UTC day the call started, which its folder is under. */
  day: string;
  /** Its first record's time, or null when it has none. */
  startedAt: string | null;
  /**
   * The turns its records span (their turn indexes are consecutive, so last minus first, plus one),
   * not counting records written after a server let the call go (`late`).
   */
  turns: number;
  sizeBytes: number;
  lastModifiedMs: number;
}

/** One call's trace, joined across the servers that wrote it. */
export interface JoinedTrace {
  /** The trace records' lines, in order, a record written after its server let the call go marked `outlivedHold`. */
  trace: string[];
  /** The frame log's lines, in order. */
  frames: string[];
}

/** The one reader of traces on S3-compatible storage: the console, replay, kb:gaps and kb:review read through it. */
export class S3TraceReader {
  constructor(readonly client: S3Client, readonly prefix: string) {}

  get label(): string {
    return `s3://${this.client.settings.bucket}/${this.prefix}`;
  }

  /** The day folders under the prefix, newest first. */
  async days(): Promise<string[]> {
    const { prefixes } = await this.client.list(this.prefix, { delimiter: '/' });
    return prefixes.map((p) => p.slice(this.prefix.length, -1)).filter((d) => DAY.test(d)).sort().reverse();
  }

  /** The calls with records in one day's folder. */
  private async callsOn(day: string): Promise<StoredTrace[]> {
    const under = `${this.prefix}${day}/`;
    const { objects } = await this.client.list(under);
    const byCall = new Map<string, { size: number; newest: number; segments: SegmentName[] }>();
    for (const o of objects) {
      const rest = o.key.slice(under.length);
      const slash = rest.indexOf('/');
      if (slash <= 0) continue;
      const seg = parseSegmentName(rest.slice(slash + 1));
      if (seg === null) continue;
      const id = rest.slice(0, slash);
      const c = byCall.get(id) ?? { size: 0, newest: 0, segments: [] };
      c.size += o.size;
      c.newest = Math.max(c.newest, o.lastModifiedMs);
      c.segments.push(seg);
      byCall.set(id, c);
    }
    const out: StoredTrace[] = [];
    for (const [id, c] of byCall) {
      const records = c.segments.filter((s) => s.kind === 'trace');
      if (records.length === 0) continue;
      const first = Math.min(...records.map((s) => s.first));
      const last = Math.max(...records.map((s) => s.last));
      const earliest = records.reduce((a, b) => (segmentName(a) <= segmentName(b) ? a : b));
      out.push({ id, day, startedAt: new Date(earliest.ms).toISOString(), turns: last - first + 1, sizeBytes: c.size, lastModifiedMs: c.newest });
    }
    return out;
  }

  /**
   * The calls with records in the store, newest first by their last write: the newest days' folders
   * only, until at least `limit` calls are found (every day when `limit` is unset), and only the day
   * folders from `from` to `to` (YYYY-MM-DD, each optional) when they are given: the console's Calls
   * page narrows a date range by the folders' names before it reads a call.
   */
  async calls(o: { limit?: number; from?: string; to?: string } = {}): Promise<StoredTrace[]> {
    const out: StoredTrace[] = [];
    for (const day of await this.days()) {
      if ((o.from !== undefined && day < o.from) || (o.to !== undefined && day > o.to)) continue;
      out.push(...(await this.callsOn(day)));
      if (o.limit !== undefined && out.length >= o.limit) break;
    }
    return out.sort((a, b) => b.lastModifiedMs - a.lastModifiedMs);
  }

  /**
   * One call's trace and frame log, each segment's lines in name order; null when the call has no trace
   * records. The call's day folder is looked for from the newest day back, unless `day` names it.
   */
  async read(id: string, day?: string): Promise<JoinedTrace | null> {
    for (const d of day !== undefined ? [day] : await this.days()) {
      const folder = `${this.prefix}${d}/${id}/`;
      const { objects } = await this.client.list(folder);
      const named = objects
        .map((o) => ({ key: o.key, seg: parseSegmentName(o.key.slice(folder.length)) }))
        .filter((x): x is { key: string; seg: SegmentName } => x.seg !== null)
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      if (named.length === 0) continue;
      if (!named.some((x) => x.seg.kind !== 'frames')) return null;
      const texts = await mapLimit(named, READ_CONCURRENCY, (x) => this.client.get(x.key));
      const joined: JoinedTrace = { trace: [], frames: [] };
      named.forEach((x, i) => {
        const lines = (texts[i] ?? '').split('\n').filter((l) => l.trim() !== '');
        (x.seg.kind === 'frames' ? joined.frames : joined.trace).push(...lines);
      });
      return joined;
    }
    return null;
  }

  /** One call's frame log, joined, as replay reads a frame-log file (each line numbered in the joined log); null when there is none. */
  async frameLog(id: string, onSkip?: (lineNumber: number) => void): Promise<ReadFrameLogLine[] | null> {
    const joined = await this.read(id);
    return joined === null ? null : parseFrameLog(joined.frames.join('\n'), onSkip);
  }
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * A reader of the traces `spec` names when it is an `s3://<bucket>/<prefix>` address (the S3_ variables
 * give the keys, as the server's do), else null: what replay, kb:gaps and kb:review use, so a trace on
 * the store reads there as the console reads it.
 */
export function traceReaderOf(spec: string, env: Readonly<Record<string, string | undefined>>, o: S3ClientOptions = {}): S3TraceReader | null {
  if (!/^s3:\/\//i.test(spec.trim())) return null;
  const setting = traceStoreSettingOf({ ...env, TRACE_STORE: spec });
  return setting === null ? null : new S3TraceReader(new S3Client(setting, o), setting.prefix);
}

/**
 * An `s3://<bucket>/<prefix>/<call>` address split into the store's (`s3://<bucket>/<prefix>`) and the
 * call's id: what `--replay` takes for one call on the store.
 */
export function splitCallAddress(spec: string): { store: string; call: string } | null {
  const m = /^(s3:\/\/[^/]+(?:\/.*)?)\/([A-Za-z0-9_-]{1,64})\/?$/i.exec(spec.trim());
  return m ? { store: m[1]!, call: m[2]! } : null;
}
