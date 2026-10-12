import { randomBytes } from 'node:crypto';
import { S3Client, S3Error, type S3ClientOptions, type S3Settings } from './s3/client';
import { traceLine, type TraceSink } from './writer';
import type { TraceRecord } from './types';
import { frameLine, parseFrameLog, type FrameDir, type FrameSink, type ReadFrameLogLine } from '../server/frameLog';

/**
 * Traces on S3-compatible storage (TRACE_STORE=s3://<bucket>/<prefix>): one logical trace per call,
 * whichever servers ran it. Each server writes its own segments under the call's id, and every reader
 * (the console, replay, kb:gaps, kb:review's Gaps tab) joins them in one order through one reader here
 * (S3TraceReader), so they all agree. Unset, traces are files in TRACE_DIR, as they always were
 * (TraceWriter, FrameLog), and nothing here runs.
 *
 * A call's objects, under `<prefix><call>/` (the call's id as its trace file is named: safeFileStem):
 *
 *   <first>-<last>-<ms>-<server>-<n>.trace.jsonl    trace records, each line as a trace file's
 *   <turn>-<turn>-<ms>-<server>-<n>.frames.jsonl    frame-log lines, each as a frame log's
 *
 * `first` and `last` are the turn indexes of a segment's first and last record (six digits), `ms` the
 * time of its first line (thirteen digits), `server` the server that wrote it (SERVER_ID and its
 * suffix), `n` its count in that server's run (six digits). A frames segment carries the call's turn
 * when its first line was written. Sorted by name, a call's segments are in the order they were
 * written: the turn index comes first, and it is the call's own (the session moves with the call), so
 * a takeover reads on in order whatever the two servers' clocks say. A segment is never rewritten.
 *
 * Writing never stops a call: a segment is written when a turn's record is (at once) and when frames
 * have waited a second, in the background; one that fails is kept and tried again (up to a bound per
 * call), logged and counted, and the call goes on. A process that dies loses what it had not yet
 * written: at most the last second of frame lines, and a record whose write was under way.
 */

/** How long frame-log lines wait to go out with others, when no record takes them sooner. */
export const FRAME_FLUSH_MS = 1_000;
/** The wait before a failed segment is tried again, doubled each time up to RETRY_MAX_MS. */
const RETRY_MS = 2_000;
const RETRY_MAX_MS = 30_000;
/** The most bytes a call keeps waiting to be written; past it the oldest lines are dropped (and counted). */
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

export type SegmentKind = 'trace' | 'frames';

export interface SegmentName {
  first: number;
  last: number;
  ms: number;
  server: string;
  n: number;
  kind: SegmentKind;
}

const pad = (v: number, width: number): string => String(Math.max(0, Math.min(v, 10 ** width - 1))).padStart(width, '0');

export function segmentName(s: SegmentName): string {
  return `${pad(s.first, 6)}-${pad(s.last, 6)}-${pad(s.ms, 13)}-${s.server}-${pad(s.n, 6)}.${s.kind}.jsonl`;
}

const SEGMENT = /^(\d{6})-(\d{6})-(\d{13})-([A-Za-z0-9._-]+)-(\d{6})\.(trace|frames)\.jsonl$/;

/** A segment's name read back, or null for anything else in the folder. */
export function parseSegmentName(name: string): SegmentName | null {
  const m = SEGMENT.exec(name);
  if (!m) return null;
  return { first: Number(m[1]), last: Number(m[2]), ms: Number(m[3]), server: m[4]!, n: Number(m[5]), kind: m[6] as SegmentKind };
}

// ---------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------

interface Pending {
  line: string;
  turn: number;
  ms: number;
}

/** One call's segments from this server: lines kept until they are written, in order. */
class CallSegments implements TraceSink {
  private trace: Pending[] = [];
  private frames: Pending[] = [];
  private bytes = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private retryMs = RETRY_MS;

  constructor(private readonly store: S3TraceStore, private readonly folder: string, private readonly turnOf: () => number) {}

  get pending(): boolean {
    return this.trace.length > 0 || this.frames.length > 0 || this.running !== null;
  }

  write(record: TraceRecord): void {
    this.keep(this.trace, { line: traceLine(record), turn: record.turnIndex, ms: Date.parse(record.ts) || this.store.now() });
    // A turn's record goes out at once, with the frames before it.
    void this.flush();
  }

  /** As FrameSink: the frame-log line, out within FRAME_FLUSH_MS (or with the next record). */
  writeFrame(dir: FrameDir, msg: unknown): void {
    const at = this.store.now();
    this.keep(this.frames, { line: frameLine(at, dir, msg), turn: this.turnOf(), ms: at });
    if (this.timer === null && this.running === null) this.schedule(FRAME_FLUSH_MS);
  }

  private keep(into: Pending[], p: Pending): void {
    into.push(p);
    this.bytes += p.line.length + 1;
    this.store.track(this);
    // Bounded: a store that stays down loses the oldest lines of a long call, never the server's memory.
    while (this.bytes > MAX_PENDING_BYTES) {
      const from = this.frames.length > 0 ? this.frames : this.trace;
      const gone = from.shift();
      if (gone === undefined) break;
      this.bytes -= gone.line.length + 1;
      this.store.dropped += 1;
    }
  }

  private schedule(ms: number): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, ms);
    this.timer.unref?.();
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
        if (this.trace.length > 0 || this.frames.length > 0) {
          if (this.timer === null) this.schedule(this.failedLast ? this.retryMs : FRAME_FLUSH_MS);
        } else this.store.untrack(this);
      });
    }
    return this.running;
  }

  private failedLast = false;

  private async drain(): Promise<void> {
    this.failedLast = false;
    while (this.trace.length > 0 || this.frames.length > 0) {
      for (const kind of ['trace', 'frames'] as const) {
        const lines = kind === 'trace' ? this.trace : this.frames;
        if (lines.length === 0) continue;
        const batch = lines.splice(0);
        const name = segmentName({
          first: batch[0]!.turn, last: Math.max(...batch.map((p) => p.turn)), ms: batch[0]!.ms, server: this.store.server, n: this.store.nextSegment(), kind,
        });
        try {
          await this.store.client.put(`${this.store.prefix}${this.folder}/${name}`, batch.map((p) => `${p.line}\n`).join(''));
          this.bytes -= batch.reduce((n, p) => n + p.line.length + 1, 0);
          this.retryMs = RETRY_MS;
        } catch (err) {
          // Kept, in order, ahead of anything written since, and tried again later.
          lines.unshift(...batch);
          this.failedLast = true;
          this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
          this.store.failed(this.folder, err);
          return;
        }
      }
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
  log?: (line: string) => void;
}

/** How often a failure to write is logged: the first at once, then at most once a minute with the count. */
const FAILURE_LOG_EVERY_MS = 60_000;

/** The traces of this server's calls written as segments on S3-compatible storage, and read back joined. */
export class S3TraceStore {
  readonly client: S3Client;
  readonly prefix: string;
  readonly server: string;
  readonly now: () => number;
  /** Segment writes that failed (each tried again), since start. */
  failures = 0;
  /** Lines dropped because a call's waiting lines passed their bound. */
  dropped = 0;
  private n = 0;
  private readonly live = new Set<CallSegments>();
  private readonly log: (line: string) => void;
  private loggedAt: number | null = null;
  private unlogged = 0;

  constructor(readonly setting: S3TraceSetting, o: S3TraceStoreOptions = {}) {
    this.client = new S3Client(setting, o);
    this.prefix = setting.prefix;
    this.server = o.server ?? `server-${randomBytes(4).toString('hex')}`;
    this.now = o.now ?? Date.now;
    this.log = o.log ?? (() => {});
  }

  get label(): string {
    return describeTraceStore(this.setting);
  }

  /** The trace and the frame log of one call on this server, under `folder` (safeFileStem of its id); `turnOf` reads its turn index now. */
  open(folder: string, turnOf: () => number): { trace: TraceSink; frames: FrameSink } {
    const segments = new CallSegments(this, folder, turnOf);
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

  track(s: CallSegments): void {
    this.live.add(s);
  }

  untrack(s: CallSegments): void {
    if (!s.pending) this.live.delete(s);
  }

  /** A segment could not be written: counted, and logged (the first at once, then once a minute with how many since). */
  failed(folder: string, err: unknown): void {
    this.failures += 1;
    const t = this.now();
    if (this.loggedAt !== null && t - this.loggedAt < FAILURE_LOG_EVERY_MS) {
      this.unlogged += 1;
      return;
    }
    const why = err instanceof S3Error ? err.message : err instanceof Error ? err.message : String(err);
    const since = this.unlogged > 0 ? ` (${this.unlogged} more since the last said)` : '';
    this.log(`traces: a segment of ${folder} could not be written to ${this.label}: ${why}; kept to try again${since}`);
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

  /**
   * TRACE_RETENTION_DAYS on the store: every call whose last segment is older than `days`, and not in
   * `inUse`, removed whole, never in part. Returns the objects and calls removed.
   */
  async sweep(days: number, nowMs: number, inUse: ReadonlySet<string>): Promise<{ objects: number; calls: number }> {
    const cutoff = nowMs - days * 86_400_000;
    const { objects } = await this.client.list(this.prefix);
    const byCall = new Map<string, { keys: string[]; newest: number }>();
    for (const o of objects) {
      const rest = o.key.slice(this.prefix.length);
      const slash = rest.indexOf('/');
      if (slash <= 0) continue;
      const call = rest.slice(0, slash);
      const c = byCall.get(call) ?? { keys: [], newest: 0 };
      c.keys.push(o.key);
      c.newest = Math.max(c.newest, o.lastModifiedMs);
      byCall.set(call, c);
    }
    let removed = 0;
    let calls = 0;
    for (const [call, c] of byCall) {
      if (c.newest >= cutoff || inUse.has(call)) continue;
      for (const key of c.keys) {
        await this.client.delete(key);
        removed += 1;
      }
      calls += 1;
    }
    return { objects: removed, calls };
  }
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

/** One call with a trace in the store, as the console lists it. */
export interface StoredTrace {
  /** The call's folder: its id as its trace file is named. */
  id: string;
  /** Its first record's time, or null when it has none. */
  startedAt: string | null;
  /** The turns its records span (their turn indexes are consecutive, so last minus first, plus one). */
  turns: number;
  sizeBytes: number;
  lastModifiedMs: number;
}

/** One call's trace, joined across the servers that wrote it. */
export interface JoinedTrace {
  /** The trace records' lines, in order. */
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

  /** Every call with segments in the store, newest first by its last write. */
  async calls(): Promise<StoredTrace[]> {
    const { objects } = await this.client.list(this.prefix);
    const byCall = new Map<string, { size: number; newest: number; segments: SegmentName[] }>();
    for (const o of objects) {
      const rest = o.key.slice(this.prefix.length);
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
      out.push({ id, startedAt: new Date(earliest.ms).toISOString(), turns: last - first + 1, sizeBytes: c.size, lastModifiedMs: c.newest });
    }
    return out.sort((a, b) => b.lastModifiedMs - a.lastModifiedMs);
  }

  /** One call's trace and frame log, each segment's lines in name order; null when the call has no trace records. */
  async read(id: string): Promise<JoinedTrace | null> {
    const folder = `${this.prefix}${id}/`;
    const { objects } = await this.client.list(folder);
    const named = objects
      .map((o) => ({ key: o.key, seg: parseSegmentName(o.key.slice(folder.length)) }))
      .filter((x): x is { key: string; seg: SegmentName } => x.seg !== null)
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    if (!named.some((x) => x.seg.kind === 'trace')) return null;
    const texts = await mapLimit(named, READ_CONCURRENCY, (x) => this.client.get(x.key));
    const joined: JoinedTrace = { trace: [], frames: [] };
    named.forEach((x, i) => {
      const lines = (texts[i] ?? '').split('\n').filter((l) => l.trim() !== '');
      (x.seg.kind === 'trace' ? joined.trace : joined.frames).push(...lines);
    });
    return joined;
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
