import { readFileSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { S3TraceReader } from '../../trace/store';
import { dayOf } from '../../trace/store';
import type { TraceRecord } from '../../trace/types';
import { upgradeTraceRecord } from '../../trace/read';
import type { App } from '../../core/app/types';
import { DEFAULT_THRESHOLDS } from '../../core/thresholds';
import { parseFrameLog, type ReadFrameLogLine } from '../frameLog';
import { redactFrameLine, redactRecord } from './events';
import { maskCallerValue, recordsOf, type NumberRecords } from '../../channel/maskByName';
import { consoleMetaOf } from './meta';
import { callRow, replayEvents, settledRow, withMeta, ENDINGS } from './view.js';
import type { CallRow } from './rows';
import { factsOfTrace, type CallSummary } from './figures';
import type { ReplayRecord } from './routes';

/**
 * The console's Calls page and the Live page's figures for today (server/dashboard/routes.ts
 * `/dashboard/calls`, `/dashboard/today`), from the traces: local files in TRACE_DIR (each app's folder
 * on a host) or the trace store (TRACE_STORE=s3://...), through the reader every reader shares.
 *
 * What it reads, and when. The list of calls comes from names alone: a folder's file names and their
 * sizes and times, or the store's day folders and segment names, so a date range narrows the calls
 * before any is read. A call's summary (CallRow: when, the masked caller, the channel, its tasks, how it
 * ended, its turns and the decision model's cost) is read from its trace and frame log, redacted as the
 * replay route redacts them, and folded by the same functions the page uses live (view.js replayEvents,
 * callRow): read for the calls on the page shown, or, for a filter a name cannot answer (the caller's
 * last four, a task, how it ended), for the calls newest first until the page is filled. Each summary is
 * kept in memory for the server's run, by the call's size and last write, so a call is read once; at most
 * MAX_READS calls are read for one request, and an answer that stopped there says so (`partial`), for the
 * page to ask for a narrower range. Nothing is written: no summary file, no index.
 */

/** Where one app's traces are, as the console reads them; `id` null on a server of one app. */
export interface CallsSource {
  readonly id: string | null;
  readonly app: App;
  readonly traceDir: string;
  readonly traces?: S3TraceReader;
}

/** One call found by name, before its trace is read. */
export interface Candidate {
  source: CallsSource;
  sid: string;
  /** Its last write: the newer of its trace's and its frame log's mtimes, or the newest segment's (of either). */
  lastMs: number;
  /** Its bytes: its trace's and its frame log's, or its segments' (of either). */
  size: number;
  /** The store's day folder it is under. */
  day?: string;
}

/** A row of the Calls page: a call's summary, with its app's name on a host. */
export type CallsRow = CallRow & { appName?: string };

/** The calls a page holds. */
export const PAGE_SIZE = 25;
/** The calls one request reads at most (the rest are kept for the next), so a wide filter never stalls the server. */
export const MAX_READS = 1000;
/** How many calls' traces are read at once (the store answers each segment as a request of its own). */
const READ_CONCURRENCY = 8;
export { STALE_MS } from './view.js';
/** The summaries kept in memory. */
const MAX_KEPT = 20_000;

/** The parseable records of a trace's lines (a file's, or a trace store's joined segments), each in the current shape. */
export function parseTraceLines(lines: readonly string[]): TraceRecord[] {
  return lines
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed: unknown = JSON.parse(line);
        // A line that parses but isn't a plain object -- `null`, an array, a bare number or
        // string -- is as malformed as one that doesn't parse at all: redactRecord walks it as a
        // record and a `null` reaches Object.entries and throws.
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
        // A record written before the channel event model is read in the current shape.
        return [upgradeTraceRecord(parsed)];
      } catch {
        return [];
      }
    });
}

/**
 * The parseable lines of a trace file. A killed process leaves a partial last line behind, and one
 * truncated line is no reason to fail the whole route, so unparseable lines are dropped.
 */
export function traceLines(path: string): TraceRecord[] {
  return parseTraceLines(readFileSync(path, 'utf8').split('\n'));
}

/** The longest a call lasts, for the names' narrowing: a call last written after a range's end plus this started after it. */
const MAX_CALL_MS = 86_400_000;
const DAY_MS = 86_400_000;
/** How many files are looked at (stat) at once. */
const STAT_CONCURRENCY = 64;

/** Lets the server's other work (a call's turn) run between batches of a long read. */
const yieldToOthers = (): Promise<void> => new Promise((r) => setImmediate(r));

/**
 * The names of a folder's traces, with their sizes and last writes, in the range by their last write:
 * a call that started in the range was last written at or after its start, and no later than a day
 * after its end. None for a folder not made yet. Read without blocking the server.
 *
 * A call's last write and size are its trace's and its frame log's together (the newer write, the two
 * sizes summed), as the trace store's are its segments' of both kinds: its end (the `end` frame, the
 * socket closed, the transfer) lands in the frame log a few seconds after its last turn record, so a
 * summary read during the call is read again once the end is there (live findings, 2026-10-14).
 */
async function folderCandidates(source: CallsSource, fromMs: number | undefined, toMs: number | undefined): Promise<Candidate[]> {
  let names: string[];
  let frameLogs: Set<string>;
  try {
    const all = await readdir(source.traceDir);
    names = all.filter((f) => f.endsWith('.jsonl') && !f.endsWith('.frames.jsonl'));
    frameLogs = new Set(all.filter((f) => f.endsWith('.frames.jsonl')));
  } catch {
    return [];
  }
  const out: Candidate[] = [];
  for (let i = 0; i < names.length; i += STAT_CONCURRENCY) {
    const batch = names.slice(i, i + STAT_CONCURRENCY);
    const statOf = (f: string) => stat(join(source.traceDir, f)).catch(() => null);
    const framesOf = (f: string): string => `${f.slice(0, -'.jsonl'.length)}.frames.jsonl`;
    const stats = await Promise.all(batch.map((f) => Promise.all([statOf(f), frameLogs.has(framesOf(f)) ? statOf(framesOf(f)) : null])));
    batch.forEach((f, k) => {
      const [st, frames] = stats[k]!;
      if (!st) return;
      const lastMs = Math.max(st.mtimeMs, frames?.mtimeMs ?? 0);
      if (fromMs !== undefined && lastMs < fromMs) return;
      if (toMs !== undefined && lastMs > toMs + MAX_CALL_MS) return;
      out.push({ source, sid: f.slice(0, -'.jsonl'.length), lastMs, size: st.size + (frames?.size ?? 0) });
    });
  }
  return out;
}

/** The calls of one source by name: a folder's files, or the store's day folders in the range (a day either side, for the time zones). */
export async function candidatesOf(source: CallsSource, fromMs: number | undefined, toMs: number | undefined): Promise<Candidate[]> {
  if (!source.traces) return folderCandidates(source, fromMs, toMs);
  const range = {
    ...(fromMs !== undefined ? { from: dayOf(fromMs - DAY_MS) } : {}),
    ...(toMs !== undefined ? { to: dayOf(toMs + DAY_MS) } : {}),
  };
  return (await source.traces.calls(range))
    .filter((c) => (fromMs === undefined || c.lastModifiedMs >= fromMs) && (toMs === undefined || c.lastModifiedMs <= toMs + MAX_CALL_MS))
    .map((c) => ({ source, sid: c.id, lastMs: c.lastModifiedMs, size: c.sizeBytes, day: c.day }));
}

/** The caller as a session's start or its setup frame carries it, as the app's records write it (the replay route's redaction has already). */
function callerOf(records: readonly TraceRecord[], frames: readonly ReadFrameLogLine[], numbers: NumberRecords): string | null {
  const start = records.find((r) => r.event?.type === 'session.start')?.event;
  const provider = start && start.type === 'session.start' ? start.provider : {};
  const setup = frames.find((f) => f.dir === 'in' && (f.msg as { type?: unknown } | null)?.type === 'setup')?.msg as { from?: unknown; customParameters?: Record<string, unknown> } | undefined;
  const seen = [
    start && start.type === 'session.start' ? start.callerNumber : undefined,
    provider.from, provider['param.telnyx_call_from'], provider.telnyx_call_from,
    setup?.from, setup?.customParameters?.telnyx_call_from,
  ];
  const found = seen.find((v): v is string => typeof v === 'string' && (/\d|•/.test(v) || /^(?:sips?|client):/i.test(v)));
  return found === undefined ? null : maskCallerValue(found, numbers);
}

/** A call's summary from its records and frame log, as raw on disk: redacted first, then folded as the page folds a replay. */
export function summaryOfTrace(rawRecords: readonly TraceRecord[], rawFrames: readonly ReadFrameLogLine[], app: App): CallRow | null {
  if (rawRecords.length === 0) return null;
  const records = rawRecords.map((r) => ({ ...redactRecord(r, app), spokenText: '' })) as ReplayRecord[];
  const frames = rawFrames.map((l) => ({ ...redactFrameLine(l, app), line: l.line }));
  const meta = consoleMetaOf(app);
  const from = callerOf(records, frames, recordsOf(app));
  const events = withMeta(meta, () => replayEvents(records, frames, { from: from ?? 'unknown', thresholds: DEFAULT_THRESHOLDS }));
  const row = callRow(events, { meta });
  // The carrier, as the adapter logs it at the call's setup (a call recorded before it names none).
  const carrier = row.channel === 'chat' ? null : frames.find((f) => f.dir === 'log' && typeof (f.msg as { provider?: unknown } | null)?.provider === 'string')?.msg as { provider: string } | undefined;
  const withCarrier = carrier && row.provider === null ? { ...row, provider: carrier.provider } : row;
  // A chat names itself as the live console does.
  return withCarrier.channel === 'chat' && from === null ? { ...withCarrier, from: 'web chat' } : withCarrier;
}

/** The summaries read so far (with what each call adds to Insights' figures), by app, call, size and last write, the most recently used last (an LRU). */
const kept = new Map<string, CallSummary | null>();

/** Forgets every summary (tests). */
export function forgetSummaries(): void {
  kept.clear();
}

export const keyOf = (c: Candidate): string => `${c.source.id ?? ''}|${c.sid}|${c.lastMs}|${c.size}`;

/** A candidate's summary and facts: kept, or read from its trace now. */
async function read(c: Candidate): Promise<CallSummary | null> {
  const key = keyOf(c);
  if (kept.has(key)) {
    // Used: to the end, so the least recently used summary is the one let go.
    const row = kept.get(key)!;
    kept.delete(key);
    kept.set(key, row);
    return row;
  }
  let row: CallSummary | null = null;
  const summarize = (records: TraceRecord[], frames: ReadFrameLogLine[]): CallSummary | null => {
    const summary = summaryOfTrace(records, frames, c.source.app);
    return summary === null ? null : { row: summary, facts: factsOfTrace(records, c.source.app) };
  };
  if (c.source.traces) {
    const joined = await c.source.traces.read(c.sid, c.day);
    if (joined !== null) row = summarize(parseTraceLines(joined.trace), parseFrameLog(joined.frames.join('\n')));
  } else {
    // Read without blocking the server: a voice call's turns run on the same thread.
    const trace = await readFile(join(c.source.traceDir, `${c.sid}.jsonl`), 'utf8').catch(() => null);
    const frames = await readFile(join(c.source.traceDir, `${c.sid}.frames.jsonl`), 'utf8').catch(() => '');
    if (trace !== null) row = summarize(parseTraceLines(trace.split('\n')), parseFrameLog(frames));
  }
  kept.set(key, row);
  if (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value!);
  return row;
}

/** A summary as it stands at `nowMs` (view.js settledRow): a call silent for STALE_MS with no end recorded ended without saying so. */
export function settled(row: CallRow, nowMs: number): CallRow {
  return settledRow(row, nowMs);
}

/** What the Calls page asks for; each field already checked (routes.ts callsQueryOf). */
export interface CallsQuery {
  last4?: string;
  fromMs?: number;
  toMs?: number;
  task?: string;
  ending?: string;
  page: number;
}

const nameOf = (app: App): string => app.brand?.name ?? app.id;

/** Whether a settled summary answers the query. */
function fits(row: CallRow, q: CallsQuery): boolean {
  if (q.last4 !== undefined && !row.from.endsWith(q.last4)) return false;
  if (q.fromMs !== undefined && (row.startedAt === null || row.startedAt < q.fromMs)) return false;
  if (q.toMs !== undefined && (row.startedAt === null || row.startedAt > q.toMs)) return false;
  if (q.task !== undefined && !row.tasks.some((t) => t.id === q.task)) return false;
  if (q.ending !== undefined && row.ending?.kind !== q.ending) return false;
  return true;
}

/**
 * Walks the candidates newest first, reading summaries a few at a time, until `enough` rows fit or
 * MAX_READS calls had to be read; `partial` when it stopped at the bound.
 */
async function walk(sources: readonly CallsSource[], fromMs: number | undefined, toMs: number | undefined, nowMs: number, keep: (row: CallsRow) => boolean, enough: number): Promise<{ rows: CallsRow[]; partial: boolean }> {
  const candidates = (await Promise.all(sources.map((s) => candidatesOf(s, fromMs, toMs)))).flat().sort((a, b) => b.lastMs - a.lastMs);
  const rows: CallsRow[] = [];
  let reads = 0;
  for (let i = 0; i < candidates.length && rows.length < enough; i += READ_CONCURRENCY) {
    const batch = candidates.slice(i, i + READ_CONCURRENCY);
    const fresh = batch.filter((c) => !kept.has(keyOf(c))).length;
    if (reads + fresh > MAX_READS) return { rows, partial: true };
    reads += fresh;
    const read_ = await Promise.all(batch.map(read));
    if (fresh > 0) await yieldToOthers();
    batch.forEach((c, k) => {
      const row = read_[k]?.row;
      if (!row || rows.length >= enough) return;
      const shown: CallsRow = { ...settled(row, nowMs), ...(c.source.id !== null ? { app: c.source.id, appName: nameOf(c.source.app) } : {}) };
      if (keep(shown)) rows.push(shown);
    });
  }
  return { rows, partial: false };
}

/** A page of the Calls page: the calls that fit, newest first by their last write, and whether there are more. */
export async function listCalls(sources: readonly CallsSource[], q: CallsQuery, nowMs: number): Promise<{ rows: CallsRow[]; page: number; pageSize: number; more: boolean; partial: boolean }> {
  const end = (q.page + 1) * PAGE_SIZE;
  const { rows, partial } = await walk(sources, q.fromMs, q.toMs, nowMs, (r) => fits(r, q), end + 1);
  return { rows: rows.slice(q.page * PAGE_SIZE, end), page: q.page, pageSize: PAGE_SIZE, more: rows.length > end, partial };
}

/**
 * The Live page's figures for today: the calls that started since `sinceMs`, how many ended and how, and
 * the decision model's cost. Containment is the calls the agent handled to the end with no handoff (an
 * `ended{completed}`), of every call that ended: a hang-up or an error is not counted as handled (Console
 * 2's Insights shows them apart).
 */
export interface TodayFigures {
  calls: number;
  ended: number;
  /** Ended handled by the agent, with no person. */
  contained: number;
  toPerson: number;
  hungUp: number;
  errors: number;
  /** contained / ended, or null with none ended. */
  containment: number | null;
  costUsd: number;
  /** Minutes billed on voice calls by carrier, each call rounded up to the minute (at least one), for the carrier's cost when a rate is set. */
  billedMinutes: Record<string, number>;
  partial: boolean;
}

export async function todayOf(sources: readonly CallsSource[], sinceMs: number, nowMs: number): Promise<TodayFigures> {
  const { rows, partial } = await walk(sources, sinceMs, undefined, nowMs, (r) => r.startedAt !== null && r.startedAt >= sinceMs, Number.POSITIVE_INFINITY);
  const ended = rows.filter((r) => r.ending !== null);
  const count = (kind: string): number => ended.filter((r) => r.ending!.kind === kind).length;
  const contained = count('handled');
  const costUsd = Math.round(rows.reduce((s, r) => s + r.costUsd, 0) * 1e6) / 1e6;
  const billedMinutes: Record<string, number> = {};
  for (const r of rows) {
    if (r.channel === 'chat' || r.startedAt === null) continue;
    const until = r.endedAt ?? r.lastAt ?? r.startedAt;
    const carrier = r.provider ?? 'unknown';
    billedMinutes[carrier] = (billedMinutes[carrier] ?? 0) + Math.max(1, Math.ceil(Math.max(0, until - r.startedAt) / 60_000));
  }
  return { calls: rows.length, ended: ended.length, contained, toPerson: count('person'), hungUp: count('hangup'), errors: count('error'), containment: ended.length === 0 ? null : contained / ended.length, costUsd, billedMinutes, partial };
}

/** The endings a query may name. */
export const QUERY_ENDINGS: readonly string[] = ENDINGS;

/**
 * Every candidate's summary and facts, kept or read now, a few at a time with the server's other work let
 * run between (Insights' figures, figuresCache.ts): no bound on how many, as a day's figures need every
 * call of the day; each settled at `nowMs` as the Calls page settles it.
 */
export async function summariesOf(candidates: readonly Candidate[], nowMs: number): Promise<{ candidate: Candidate; summary: CallSummary }[]> {
  const out: { candidate: Candidate; summary: CallSummary }[] = [];
  for (let i = 0; i < candidates.length; i += READ_CONCURRENCY) {
    const batch = candidates.slice(i, i + READ_CONCURRENCY);
    const fresh = batch.some((c) => !kept.has(keyOf(c)));
    const read_ = await Promise.all(batch.map(read));
    if (fresh) await yieldToOthers();
    batch.forEach((c, k) => {
      const s = read_[k];
      if (s) out.push({ candidate: c, summary: { row: settled(s.row, nowMs), facts: s.facts } });
    });
  }
  return out;
}
