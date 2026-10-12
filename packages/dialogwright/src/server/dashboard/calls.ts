import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { S3TraceReader } from '../../trace/store';
import { dayOf } from '../../trace/store';
import type { TraceRecord } from '../../trace/types';
import { upgradeTraceRecord } from '../../trace/read';
import type { App } from '../../core/app/types';
import { DEFAULT_THRESHOLDS } from '../../core/thresholds';
import { parseFrameLog, readFrameLog, type ReadFrameLogLine } from '../frameLog';
import { maskNumber, redactFrameLine, redactRecord } from './events';
import { consoleMetaOf } from './meta';
import { callRow, replayEvents, withMeta, ENDINGS, type CallRow } from './view.js';
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
interface Candidate {
  source: CallsSource;
  sid: string;
  /** Its last write: a file's mtime, or the newest segment's. */
  lastMs: number;
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
/** A call with no end recorded and nothing written for this long ended without saying so (an evicted call). */
export const STALE_MS = 30 * 60_000;
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

/** The names of a folder's traces, with their sizes and last writes; none for a folder not made yet. */
function folderCandidates(source: CallsSource, fromMs: number | undefined): Candidate[] {
  let names: string[];
  try {
    names = readdirSync(source.traceDir);
  } catch {
    return [];
  }
  return names
    .filter((f) => f.endsWith('.jsonl') && !f.endsWith('.frames.jsonl'))
    .flatMap((f) => {
      try {
        const stat = statSync(join(source.traceDir, f));
        // A call that started in the range was last written in it or after.
        if (fromMs !== undefined && stat.mtimeMs < fromMs) return [];
        return [{ source, sid: f.slice(0, -'.jsonl'.length), lastMs: stat.mtimeMs, size: stat.size }];
      } catch {
        return [];
      }
    });
}

const DAY_MS = 86_400_000;

/** The calls of one source by name: a folder's files, or the store's day folders in the range (a day either side, for the time zones). */
async function candidatesOf(source: CallsSource, fromMs: number | undefined, toMs: number | undefined): Promise<Candidate[]> {
  if (!source.traces) return folderCandidates(source, fromMs);
  const range = {
    ...(fromMs !== undefined ? { from: dayOf(fromMs - DAY_MS) } : {}),
    ...(toMs !== undefined ? { to: dayOf(toMs + DAY_MS) } : {}),
  };
  return (await source.traces.calls(range))
    .filter((c) => fromMs === undefined || c.lastModifiedMs >= fromMs)
    .map((c) => ({ source, sid: c.id, lastMs: c.lastModifiedMs, size: c.sizeBytes, day: c.day }));
}

/** The caller as a session's start or its setup frame carries it, masked (the replay route's redaction has masked it already). */
function callerOf(records: readonly TraceRecord[], frames: readonly ReadFrameLogLine[]): string | null {
  const start = records.find((r) => r.event?.type === 'session.start')?.event;
  const provider = start && start.type === 'session.start' ? start.provider : {};
  const setup = frames.find((f) => f.dir === 'in' && (f.msg as { type?: unknown } | null)?.type === 'setup')?.msg as { from?: unknown; customParameters?: Record<string, unknown> } | undefined;
  const seen = [
    start && start.type === 'session.start' ? start.callerNumber : undefined,
    provider.from, provider['param.telnyx_call_from'], provider.telnyx_call_from,
    setup?.from, setup?.customParameters?.telnyx_call_from,
  ];
  const found = seen.find((v): v is string => typeof v === 'string' && /\d|•/.test(v));
  return found === undefined ? null : maskNumber(found);
}

/** A call's summary from its records and frame log, as raw on disk: redacted first, then folded as the page folds a replay. */
export function summaryOfTrace(rawRecords: readonly TraceRecord[], rawFrames: readonly ReadFrameLogLine[], app: App): CallRow | null {
  if (rawRecords.length === 0) return null;
  const records = rawRecords.map((r) => ({ ...redactRecord(r, app), spokenText: '' })) as ReplayRecord[];
  const frames = rawFrames.map((l) => ({ ...redactFrameLine(l, app), line: l.line }));
  const meta = consoleMetaOf(app);
  const from = callerOf(records, frames);
  const events = withMeta(meta, () => replayEvents(records, frames, { from: from ?? 'unknown', thresholds: DEFAULT_THRESHOLDS }));
  const row = callRow(events, { meta });
  // A chat names itself as the live console does.
  return row.channel === 'chat' && from === null ? { ...row, from: 'web chat' } : row;
}

/** The summaries read so far, by app, call, size and last write. */
const kept = new Map<string, CallRow | null>();

/** Forgets every summary (tests). */
export function forgetSummaries(): void {
  kept.clear();
}

const keyOf = (c: Candidate): string => `${c.source.id ?? ''}|${c.sid}|${c.lastMs}|${c.size}`;

/** A candidate's summary: kept, or read from its trace now. */
async function read(c: Candidate): Promise<CallRow | null> {
  const key = keyOf(c);
  if (kept.has(key)) return kept.get(key)!;
  let row: CallRow | null = null;
  if (c.source.traces) {
    const joined = await c.source.traces.read(c.sid, c.day);
    if (joined !== null) row = summaryOfTrace(parseTraceLines(joined.trace), parseFrameLog(joined.frames.join('\n')), c.source.app);
  } else {
    const path = join(c.source.traceDir, `${c.sid}.jsonl`);
    const frames = join(c.source.traceDir, `${c.sid}.frames.jsonl`);
    if (existsSync(path)) row = summaryOfTrace(traceLines(path), existsSync(frames) ? readFrameLog(frames) : [], c.source.app);
  }
  kept.set(key, row);
  if (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value!);
  return row;
}

/**
 * A summary as it stands at `nowMs`: a call with no end recorded that has written nothing for STALE_MS
 * ended without saying so (a server stopped, or the idle sweep evicted it): to a person if a handoff was
 * under way, else an error. A call that wrote more recently is in progress.
 */
export function settled(row: CallRow, nowMs: number): CallRow {
  if (row.ending !== null || row.lastAt === null || nowMs - row.lastAt <= STALE_MS) return row;
  if (row.status === 'transferring') return { ...row, status: 'with-person', ending: { kind: 'person', reason: row.handoffReason, text: 'to a person · no end recorded' } };
  return { ...row, status: 'ended', ending: { kind: 'error', text: 'no end recorded' } };
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
    batch.forEach((c, k) => {
      const row = read_[k];
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

/** The Live page's figures for today: the calls that started since `sinceMs`, how many ended and how, and the decision model's cost. */
export interface TodayFigures {
  calls: number;
  ended: number;
  /** Ended with no person: handled, hung up, an error. */
  contained: number;
  toPerson: number;
  /** contained / ended, or null with none ended. */
  containment: number | null;
  costUsd: number;
  partial: boolean;
}

export async function todayOf(sources: readonly CallsSource[], sinceMs: number, nowMs: number): Promise<TodayFigures> {
  const { rows, partial } = await walk(sources, sinceMs, undefined, nowMs, (r) => r.startedAt !== null && r.startedAt >= sinceMs, Number.POSITIVE_INFINITY);
  const ended = rows.filter((r) => r.ending !== null);
  const toPerson = ended.filter((r) => r.ending!.kind === 'person').length;
  const costUsd = Math.round(rows.reduce((s, r) => s + r.costUsd, 0) * 1e6) / 1e6;
  return { calls: rows.length, ended: ended.length, contained: ended.length - toPerson, toPerson, containment: ended.length === 0 ? null : (ended.length - toPerson) / ended.length, costUsd, partial };
}

/** The endings a query may name. */
export const QUERY_ENDINGS: readonly string[] = ENDINGS;
