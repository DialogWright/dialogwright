import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DashboardBus } from './bus';
import { redactFrameLine, redactRecord } from './events';
import { isConsolePath } from '../localOnly';
import { parseFrameLog, readFrameLog, type ReadFrameLogLine } from '../frameLog';
import type { S3TraceReader } from '../../trace/store';
import type { Chained } from '../../audit/types';
import type { TraceRecord } from '../../trace/types';
import { defaultAppId, getApp } from '../../core/app/registry';
import type { App } from '../../core/app/types';
import { spokenText } from '../../prompts/render';
import { consoleMetaOf, renderConsolePage, type ConsoleMeta } from './meta';
import { deliveriesOf, type DeliveryEvent } from './delivery';
import type { ConsoleGate, ConsoleSession } from '../console/auth';
import { listCalls, parseTraceLines, todayOf, traceLines, QUERY_ENDINGS, type CallsQuery, type CallsSource, type TodayFigures } from './calls';
import { LiveCalls } from './live';
import type { PublishedEvent } from './bus';
import { FiguresCache } from './figuresCache';
import { insightsOf, LENGTH_EDGES_S, type Insights } from './figures';
import { knowledgeStatusOf, type KnowledgeStatus } from './knowledge';
import { AuditVerifier, latencyOf, type AuditCheck, type HealthNumbers, type HealthSource, type ServerSeen } from './health';
import type { ConsolePage } from '../console/auth';

/**
 * Changes every time the server process starts. The page keeps the first one it sees and reloads
 * itself when a reconnect brings a different one, so a restarted server never leaves an open console
 * running the old page's styles and scripts.
 */
export const BOOT_ID = randomUUID();

// `enabled` duplicates `deps.bus`'s existence in production (src/server/index.ts only builds a
// bus when the dashboard is on, and src/server/http.ts only reaches this module when that bus is
// present); it is kept as its own field so routes.test.ts can exercise "disabled" against a real
// bus without also having to fake a config.
export interface DashboardDeps {
  bus: DashboardBus;
  traceDir: string;
  enabled: boolean;
  /**
   * CONSOLE_AUTH=token's sign-in (server/console/auth.ts): every path needs a session, and the access
   * log records the live feed and each replay. Absent (CONSOLE_AUTH=local), the routes are as they were.
   */
  auth?: ConsoleGate;
  /** TRACE_STORE=s3://...: the traces are read from the store, joined across servers, in place of traceDir. */
  traces?: S3TraceReader;
  /**
   * On a server of several apps (host.yaml): each app, with where its traces are (its folder in TRACE_DIR,
   * or its prefix on the trace store), the default first. The traces list has every app's calls with
   * the app on each row (and `?app=<id>` for one app's), a replay is read from its own app's, and the
   * page knows each app's console words. Absent, the one app's, as before.
   */
  apps?: readonly ConsoleApp[];
  /** Tests only: awaited before a Calls search reads, so a test can hold one open (the one-at-a-time rule). */
  holdCalls?: () => Promise<void>;
  /** Tests only: awaited before Insights' figures are read, as holdCalls. */
  holdInsights?: () => Promise<void>;
  /**
   * The carriers' rates a minute (config.carrierRates: CARRIER_RATE_PER_MIN_<CARRIER>): Insights and the
   * Live strip show the carrier's cost with them; absent, no carrier cost at all.
   */
  carrierRates?: Readonly<Partial<Record<string, number>>>;
  /** The Health page's sources (index.ts): this server, the others heard from, `/health`'s numbers, the audit. Absent, the page says only what the bus knows. */
  health?: HealthSource;
  /** On a server of one app, the app's folder when the server runs in it (the Knowledge page counts its kb/pending drafts there). */
  appDir?: string;
}

/** One app of a host, as the console reads it. */
export interface ConsoleApp {
  readonly id: string;
  readonly app: App;
  readonly traceDir: string;
  readonly traces?: S3TraceReader;
  /** The app's folder (a host file's apps all have one), for the Knowledge page's drafts. */
  readonly dir?: string;
}

/** One trace record as `/dashboard/traces/<sid>` returns it: redacted, plus the line the caller heard. */
export type ReplayRecord = TraceRecord & { spokenText: string };

const HERE = fileURLToPath(new URL('.', import.meta.url));
const HEARTBEAT_MS = 15_000;
/** The same shape `safeFileStem` produces, so nothing else can reach the filesystem. */
const SID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TRACES = 50;
/** A viewer whose socket has stalled must not make the server buffer the whole call. */
const MAX_STREAM_BACKLOG = 1_000_000;

function send(res: ServerResponse, status: number, type: string, body: string | Buffer, headOnly = false): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
  if (headOnly) res.end(); else res.end(body);
}

/**
 * What the caller heard on this turn, rendered here so the page never has to know the prompt
 * manifest. A record whose decision no longer renders — a prompt id or variable that has since
 * changed — is worth showing without its line rather than failing the whole trace.
 */
function spokenOf(record: TraceRecord, app: App = getApp(defaultAppId())): string {
  // A trace record does not carry its session's app, so a stored trace is read as the default app's,
  // or on a host as the app whose folder it is in.
  try {
    const text = spokenText(app, record.decision, record.locale);
    return typeof text === 'string' ? text : '';
  } catch {
    return '';
  }
}

/**
 * The redacted records and frames of one trace. Both are raw on disk and public over this route. With
 * them, the call's delivery facts as the adapter published them live (delivery.ts deliveriesOf), read
 * from the frame log, so a reloaded call shows the same delivery notes; a page from before them reads
 * none.
 */
function readTrace(traceDir: string, sid: string, app?: App): { records: ReplayRecord[]; frames: ReadFrameLogLine[]; deliveries: DeliveryEvent[] } {
  const framesPath = join(traceDir, `${sid}.frames.jsonl`);
  return replayOf(traceLines(join(traceDir, `${sid}.jsonl`)), existsSync(framesPath) ? readFrameLog(framesPath) : [], sid, app);
}

/** A trace as the replay route answers it: its records redacted with the line each said, its frames redacted, and its delivery facts. */
function replayOf(raw: readonly TraceRecord[], read: readonly ReadFrameLogLine[], sid: string, app?: App): { records: ReplayRecord[]; frames: ReadFrameLogLine[]; deliveries: DeliveryEvent[] } {
  const records = raw.map((r) => {
    const record = app === undefined ? redactRecord(r) : redactRecord(r, app);
    return { ...record, spokenText: spokenOf(record, app) };
  });
  // redactFrameLine widens the type back to FrameLogLine; readFrameLog's line number survives the
  // spread, so it is restored here rather than dropped from what the page gets.
  const frames = read.map((l) => ({ ...(app === undefined ? redactFrameLine(l) : redactFrameLine(l, app)), line: l.line }));
  return { records, frames, deliveries: deliveriesOf(frames, sid) };
}

/**
 * The traces list and one trace's replay read from the trace store (TRACE_STORE=s3://...), through the
 * one reader every reader shares: the same answers as from TRACE_DIR, a call's segments from every
 * server joined. A store that cannot be read answers 503, never a crash.
 */
function fromStore(res: ServerResponse, head: boolean, reader: S3TraceReader, sid: string | null, onReplay: (() => Chained<void>) | null): void {
  const work = async (): Promise<void> => {
    if (sid === null) {
      const rows = (await reader.calls({ limit: MAX_TRACES })).slice(0, MAX_TRACES).map((c) => ({ callSid: c.id, startedAt: c.startedAt, turns: c.turns, sizeBytes: c.sizeBytes }))
        .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
      send(res, 200, 'application/json', JSON.stringify(rows), head);
      return;
    }
    const joined = await reader.read(sid);
    if (joined === null) {
      send(res, 404, 'text/plain', 'not found', head);
      return;
    }
    const replay = replayOf(parseTraceLines(joined.trace), parseFrameLog(joined.frames.join('\n')), sid);
    // Recorded before the answer: a replay the audit could not record is not served.
    const noted = onReplay?.();
    if (noted instanceof Promise) await noted;
    send(res, 200, 'application/json', JSON.stringify(replay), head);
  };
  work().catch((err: unknown) => {
    if (!res.headersSent) send(res, 503, 'text/plain', `the trace store could not be read: ${err instanceof Error ? err.message : String(err)}`, head);
    else res.end();
  });
}

/** One row of the traces list: a call's trace, newest first; on a host, with its app's id and name. */
interface TraceRow {
  callSid: string;
  startedAt: string | null;
  turns: number;
  sizeBytes: number;
  app?: string;
  appName?: string;
}

/** The traces in a folder, newest first, at most MAX_TRACES. */
function folderRows(traceDir: string): TraceRow[] {
  // Nothing creates the trace directory until the first call, so an empty dashboard is the
  // normal state of a fresh checkout rather than a 500.
  let names: string[];
  try {
    names = readdirSync(traceDir);
  } catch {
    names = [];
  }
  return names
    .filter((f) => f.endsWith('.jsonl') && !f.endsWith('.frames.jsonl'))
    .flatMap((f) => {
      const full = join(traceDir, f);
      try {
        const stat = statSync(full);
        return [{ f, full, mtimeMs: stat.mtimeMs, sizeBytes: stat.size }];
      } catch {
        return [];
      }
    })
    // Newest first by mtime, so only the files the page can show are read off disk.
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_TRACES)
    .map(({ f, full, sizeBytes }) => {
      const lines = traceLines(full);
      // Turns as the console counts them (the header's "9 turns", Replay's "Turn 9 of 9"), not trace
      // records: each keyed digit, a barge-in and a downstream service's answer are records of their own,
      // and a digit's record shares the turn it was keyed at.
      const turns = new Set(lines.map((r) => r.turnIndex)).size;
      return { callSid: f.slice(0, -'.jsonl'.length), startedAt: lines[0]?.ts ?? null, turns, sizeBytes };
    });
}

const newestFirst = (a: TraceRow, b: TraceRow): number => (b.startedAt ?? '').localeCompare(a.startedAt ?? '');

/** The app's name as its console shows it. */
const appNameOf = (app: App): string => app.brand?.name ?? app.id;

/**
 * On a host: every app's traces (or the one `?app=` names), each row with its app, newest first, at most
 * MAX_TRACES; a trace store that cannot be read answers 503, as for one app.
 */
function hostRows(res: ServerResponse, head: boolean, apps: readonly ConsoleApp[], only: string | null): void {
  const chosen = only === null ? apps : apps.filter((a) => a.id === only);
  const work = async (): Promise<void> => {
    const rows: TraceRow[] = [];
    for (const a of chosen) {
      const own = a.traces
        ? (await a.traces.calls({ limit: MAX_TRACES })).slice(0, MAX_TRACES).map((c) => ({ callSid: c.id, startedAt: c.startedAt, turns: c.turns, sizeBytes: c.sizeBytes }))
        : folderRows(a.traceDir);
      rows.push(...own.map((r) => ({ ...r, app: a.id, appName: appNameOf(a.app) })));
    }
    send(res, 200, 'application/json', JSON.stringify(rows.sort(newestFirst).slice(0, MAX_TRACES)), head);
  };
  work().catch((err: unknown) => {
    if (!res.headersSent) send(res, 503, 'text/plain', `the trace store could not be read: ${err instanceof Error ? err.message : String(err)}`, head);
    else res.end();
  });
}

/** On a host: one call's replay, from the app whose traces have it, with that app's lines and its id. */
function hostReplay(res: ServerResponse, head: boolean, apps: readonly ConsoleApp[], sid: string, only: string | null, onReplay: ((app: string) => Chained<void>) | null): void {
  // Addressed by its app (`?app=<id>`, as the list's rows say): an id two apps' records both hold is never ambiguous.
  const chosen = only === null ? apps : apps.filter((a) => a.id === only);
  const work = async (): Promise<void> => {
    for (const a of chosen) {
      let replay: ReturnType<typeof replayOf> | null = null;
      if (a.traces) {
        const joined = await a.traces.read(sid);
        if (joined !== null) replay = replayOf(parseTraceLines(joined.trace), parseFrameLog(joined.frames.join('\n')), sid, a.app);
      } else if (existsSync(join(a.traceDir, `${sid}.jsonl`))) {
        replay = readTrace(a.traceDir, sid, a.app);
      }
      if (replay === null) continue;
      // Recorded before the answer, with the call's app: a replay the audit could not record is not served.
      const noted = onReplay?.(a.id);
      if (noted instanceof Promise) await noted;
      send(res, 200, 'application/json', JSON.stringify({ ...replay, app: a.id }), head);
      return;
    }
    send(res, 404, 'text/plain', 'not found', head);
  };
  work().catch((err: unknown) => {
    if (!res.headersSent) send(res, 503, 'text/plain', `the traces could not be read: ${err instanceof Error ? err.message : String(err)}`, head);
    else res.end();
  });
}

/**
 * The console's metadata: the default app's (or, on a host, the app `?app=` names, the page's filter),
 * and on a host every app's, so the page shows each call in its own app's words.
 */
function pageMeta(deps: DashboardDeps, query: URLSearchParams): ConsoleMeta {
  const apps = deps.apps;
  if (!apps || apps.length === 0) return consoleMetaOf(getApp(defaultAppId()));
  const wanted = query.get('app');
  const filter = wanted !== null && apps.some((a) => a.id === wanted) ? wanted : null;
  const shown = apps.find((a) => a.id === filter) ?? apps[0]!;
  return { ...consoleMetaOf(shown.app), apps: apps.map((a) => ({ id: a.id, name: appNameOf(a.app), meta: consoleMetaOf(a.app) })), filter };
}

/** The Live list of each bus (live.ts), made on the list's first viewer and shared by every viewer after. */
const lists = new WeakMap<DashboardBus, LiveCalls>();

/** The bus's Live list, each call in its own app's words: on a host the app its call_started names, else the default app. */
function liveCallsOf(deps: DashboardDeps): LiveCalls {
  let list = lists.get(deps.bus);
  if (list) return list;
  const metas = new Map<string | null, ConsoleMeta>();
  const metaOf = (app: string | null): ConsoleMeta => {
    const known = metas.get(app);
    if (known) return known;
    const found = app !== null ? deps.apps?.find((a) => a.id === app)?.app : undefined;
    const meta = consoleMetaOf(found ?? getApp(defaultAppId()));
    metas.set(app, meta);
    return meta;
  };
  list = new LiveCalls(deps.bus, metaOf);
  lists.set(deps.bus, list);
  return list;
}

/**
 * Which events one viewer of the live feed is sent, by what it asked for:
 * - `?call=<id>`: that call's history and events (a call's detail, opened from the Live list);
 * - nothing: the newest call, as the console has always followed it, switching to each call that starts
 *   (on a host with `?app=<id>`, the newest of that app's calls).
 * Null for a call id that is not one.
 */
function feedFilter(deps: DashboardDeps, query: URLSearchParams): ((event: PublishedEvent, replaying: boolean) => boolean) | null {
  const call = query.get('call');
  if (call !== null) {
    if (!SID.test(call)) return null;
    return (event) => event.callSid === call;
  }
  const app = deps.apps && deps.apps.length > 0 ? query.get('app') : null;
  const appOf = (sid: string): string | undefined => {
    const first = deps.bus.historyOf(sid)[0];
    return first?.type === 'call_started' ? first.app : undefined;
  };
  // The newest call kept (of the app asked for): its history is what a viewer opening now catches up on.
  let target = deps.bus.callIds().reverse().find((sid) => app === null || appOf(sid) === app) ?? null;
  return (event, replaying) => {
    if (!replaying && event.type === 'call_started' && (app === null || event.app === app)) target = event.callSid;
    return event.callSid === target;
  };
}

/** Opens an event stream: its headers, the connection comment and the boot id. False for a HEAD, which is a probe, not a viewer. */
function openStream(res: ServerResponse, head: boolean): boolean {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  if (head) { res.end(); return false; }
  res.write(': connected\n\n');
  res.write(`event: boot\ndata: ${JSON.stringify({ bootId: BOOT_ID })}\n\n`);
  return true;
}

/**
 * Keeps a stream going while its viewer is there and (with a sign-in) its session lasts: a heartbeat,
 * and `stillSignedIn` for each write. `start` subscribes and returns its unsubscribe.
 */
function keepStream(req: IncomingMessage, res: ServerResponse, auth: ConsoleGate | undefined, start: (stillSignedIn: () => boolean) => () => void): void {
  let off: () => void = () => {};
  let beat: ReturnType<typeof setInterval> | undefined;
  const end = (): void => { off(); clearInterval(beat); };
  // With a sign-in, the session is asked again before each write: a feed whose session has signed
  // out or expired ends rather than send another event.
  const stillSignedIn = (): boolean => {
    if (!auth || auth.sessionOf(req) !== null) return true;
    end();
    res.end();
    return false;
  };
  off = start(stillSignedIn);
  // A comment line keeps a proxy (and ngrok) from closing an idle stream between calls.
  beat = setInterval(() => { if (stillSignedIn()) res.write(': hb\n\n'); }, HEARTBEAT_MS);
  beat.unref?.();
  req.on('close', end);
}

/**
 * The live feed of one call (`?call=<id>`) or of the newest call (no query): its history, then every
 * event as it comes, while the session (with a sign-in) lasts.
 */
function liveFeed(req: IncomingMessage, res: ServerResponse, deps: DashboardDeps, head: boolean, auth: ConsoleGate | undefined, shows: (event: PublishedEvent, replaying: boolean) => boolean): void {
  if (!openStream(res, head)) return;
  keepStream(req, res, auth, (stillSignedIn) => {
    let replaying = true;
    let missed = 0;
    const off = deps.bus.subscribe((event) => {
      if (!shows(event, replaying)) return;
      if (!stillSignedIn()) return;
      // A history the bus had to trim (its bounds) is caught up on short: the viewer is told how short.
      if (replaying && event.type === 'call_started') missed += deps.bus.droppedOf(event.callSid);
      // A stalled viewer is dropped frames, not unbounded memory; its next write says how many
      // (`event: missed`), and the page shows a warning rather than reloading on its own. The events'
      // numbers are the bus's across every call, so a feed of one call has gaps that are no loss.
      if (res.writableLength > MAX_STREAM_BACKLOG) { missed += 1; return; }
      if (missed > 0) { res.write(`event: missed\ndata: ${JSON.stringify({ count: missed })}\n\n`); missed = 0; }
      res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    replaying = false;
    return off;
  });
}

/**
 * The Live list's feed (`?view=calls`): every kept call's row (`event: rows`), then each row as it
 * changes (`event: row`) and each call the console no longer keeps (`event: gone`). A reconnect starts
 * with the whole list again.
 */
function listFeed(req: IncomingMessage, res: ServerResponse, deps: DashboardDeps, head: boolean, auth: ConsoleGate | undefined): void {
  if (!openStream(res, head)) return;
  const list = liveCallsOf(deps);
  keepStream(req, res, auth, (stillSignedIn) => {
    const whole = (): void => { res.write(`event: rows\ndata: ${JSON.stringify({ rows: list.snapshot() })}\n\n`); };
    whole();
    // A stalled viewer is dropped changes, not unbounded memory; its next write is the whole list again.
    let behind = false;
    return list.watch((change) => {
      if (!stillSignedIn()) return;
      if (res.writableLength > MAX_STREAM_BACKLOG) { behind = true; return; }
      if (behind) { behind = false; whole(); return; }
      res.write(change.type === 'row' ? `event: row\ndata: ${JSON.stringify(change.row)}\n\n` : `event: gone\ndata: ${JSON.stringify({ callSid: change.callSid })}\n\n`);
    });
  });
}

/** Where the Calls page and today's figures read: each app's traces on a host (or the one `?app=` names), else the one app's. */
function callsSources(deps: DashboardDeps, only: string | null): CallsSource[] {
  if (deps.apps && deps.apps.length > 0) {
    return deps.apps.filter((a) => only === null || a.id === only).map((a) => ({ id: a.id, app: a.app, traceDir: a.traceDir, ...(a.traces ? { traces: a.traces } : {}) }));
  }
  return [{ id: null, app: getApp(defaultAppId()), traceDir: deps.traceDir, ...(deps.traces ? { traces: deps.traces } : {}) }];
}

/** A whole number of milliseconds from a query, or undefined. */
function msOf(v: string | null): number | undefined {
  if (v === null || !/^\d{1,15}$/.test(v)) return undefined;
  return Number(v);
}

/** The Calls page's query, each field kept only when well formed. */
function callsQueryOf(query: URLSearchParams): CallsQuery {
  const last4 = query.get('last4');
  const task = query.get('task');
  const ending = query.get('ending');
  const page = msOf(query.get('page'));
  const fromMs = msOf(query.get('from'));
  const toMs = msOf(query.get('to'));
  return {
    ...(last4 !== null && /^\d{4}$/.test(last4) ? { last4 } : {}),
    ...(fromMs !== undefined ? { fromMs } : {}),
    ...(toMs !== undefined ? { toMs } : {}),
    ...(task !== null && /^[A-Za-z0-9_.-]{1,64}$/.test(task) ? { task } : {}),
    ...(ending !== null && QUERY_ENDINGS.includes(ending) ? { ending } : {}),
    page: page !== undefined ? Math.min(page, 10_000) : 0,
  };
}

/** Answers JSON from `work`, or 503 when the traces cannot be read. */
function answerJson(res: ServerResponse, head: boolean, work: () => Promise<unknown>): void {
  work().then((body) => send(res, 200, 'application/json', JSON.stringify(body), head), (err: unknown) => {
    if (!res.headersSent) send(res, 503, 'text/plain', `the traces could not be read: ${err instanceof Error ? err.message : String(err)}`, head);
    else res.end();
  });
}

/** Runs `next` once `first` is recorded (at once, or once a Promise resolves). */
function chain(first: Chained<void>, next: () => Chained<void>): Chained<void> {
  return first instanceof Promise ? first.then(next) : next();
}

/** The app a kept call is in, on a host (its call_started says so); undefined otherwise. */
function appOfCall(deps: DashboardDeps, callSid: string): string | undefined {
  const first = deps.bus.historyOf(callSid)[0];
  return first?.type === 'call_started' ? first.app : undefined;
}

/** The sessions (or `local`) with a Calls search running. */
const searching = new Set<string>();

/** How long today's figures are kept before they are worked out again, when no call has ended since. */
const TODAY_KEPT_MS = 60_000;
/** Today's figures by bus, app and day start, with the bus's count of ended calls they were worked out at. */
const todayKept = new WeakMap<DashboardBus, Map<string, { at: number; ends: number; figures: Promise<TodayFigures> }>>();
/** The calls each bus has seen end, counted, so today's figures are worked out again only when one has. */
const endsSeen = new WeakMap<DashboardBus, { n: number }>();

/**
 * Today's figures, kept: worked out again when a call has ended since (the bus says so) or a minute has
 * passed, never on every poll of every viewer. The summaries under them are kept too (calls.ts), so working
 * them out again reads only the calls written since.
 */
/** The bus's count of calls that ended, counted from the first time it is asked for. */
function endsOf(bus: DashboardBus): { n: number } {
  let ends = endsSeen.get(bus);
  if (!ends) {
    const counter = { n: 0 };
    bus.subscribe((e) => { if (e.type === 'ended') counter.n += 1; });
    endsSeen.set(bus, counter);
    ends = counter;
  }
  return ends;
}

function todayFigures(deps: DashboardDeps, only: string | null, since: number): Promise<TodayFigures> {
  const ends = endsOf(deps.bus);
  let kept = todayKept.get(deps.bus);
  if (!kept) { kept = new Map(); todayKept.set(deps.bus, kept); }
  const key = `${only ?? ''}|${since}`;
  const now = Date.now();
  const had = kept.get(key);
  if (had && had.ends === ends.n && now - had.at < TODAY_KEPT_MS) return had.figures;
  const figures = todayOf(callsSources(deps, only), since, now);
  kept.set(key, { at: now, ends: ends.n, figures });
  figures.catch(() => kept!.delete(key));
  if (kept.size > 50) kept.delete(kept.keys().next().value!);
  return figures;
}

/** The carrier's cost of minutes billed, by each carrier's rate a minute; null with no rate set (none shown). */
function carrierCostOf(billed: Readonly<Record<string, number>>, rates: DashboardDeps['carrierRates']): number | null {
  if (!rates || Object.keys(rates).length === 0) return null;
  const usd = Object.entries(billed).reduce((sum, [c, minutes]) => sum + (rates[c] !== undefined ? minutes * rates[c]! : 0), 0);
  return Math.round(usd * 1e4) / 1e4;
}

/** The daily figures cache of each bus (figuresCache.ts), told of each call that ends. */
const figuresKept = new WeakMap<DashboardBus, FiguresCache>();
function figuresOf(deps: DashboardDeps): FiguresCache {
  let f = figuresKept.get(deps.bus);
  if (!f) {
    const ends = endsOf(deps.bus);
    f = new FiguresCache({ endsSeen: () => ends.n });
    figuresKept.set(deps.bus, f);
  }
  return f;
}

/** The longest range Insights reads: a quarter. */
const MAX_RANGE_MS = 92 * 86_400_000;
/** The sessions (or `local`) with Insights' figures being read. */
const reading = new Set<string>();

/** The app `?app=` names on a host (one it runs), else null: every app. */
function onlyApp(deps: DashboardDeps, query: URLSearchParams): string | null {
  const wanted = deps.apps && deps.apps.length > 0 ? query.get('app') : null;
  return wanted !== null && deps.apps!.some((a) => a.id === wanted) ? wanted : null;
}

/** What /dashboard/insights answers. */
export interface InsightsAnswer {
  from: number;
  to: number;
  insights: Insights;
  /** The call-length buckets' upper edges, in seconds (figures.ts LENGTH_EDGES_S). */
  lengthEdgesS: readonly number[];
  /** Whether any app has a knowledge base, so the unanswered questions are counted; and the command that ranks them. */
  knowledge: { apps: number; command: string } | null;
}

/** Records a page's first read in a session (with a sign-in), then answers what `work` gives; 503 when the record could not be made. */
function viewed(res: ServerResponse, head: boolean, deps: DashboardDeps, session: ConsoleSession | null, page: ConsolePage, work: () => Promise<unknown>): void {
  const noted = !head && deps.auth && session ? deps.auth.noteView(session, page) : undefined;
  if (noted instanceof Promise) {
    noted.then(() => answerJson(res, head, work), () => send(res, 503, 'text/plain', 'the access could not be recorded', head));
    return;
  }
  answerJson(res, head, work);
}

/**
 * Insights for a range (`?from=<ms>&to=<ms>`, at most a quarter) and an app (`?app=`, on a host) or all:
 * from the daily figures cache; one read at a time per session (429 for a second), as the Calls page's.
 */
function insightsRoute(req: IncomingMessage, res: ServerResponse, deps: DashboardDeps, head: boolean, query: URLSearchParams, session: ConsoleSession | null): void {
  const from = msOf(query.get('from'));
  const to = msOf(query.get('to'));
  if (from === undefined || to === undefined || to < from || to - from > MAX_RANGE_MS) {
    send(res, 400, 'text/plain', 'give a range: from and to, in milliseconds, at most 92 days apart', head);
    return;
  }
  const who = session?.id ?? 'local';
  if (reading.has(who)) { send(res, 429, 'text/plain', 'Insights are already being read: try again when they answer', head); return; }
  reading.add(who);
  const done = (): void => { reading.delete(who); };
  res.once('close', done);
  const only = onlyApp(deps, query);
  viewed(res, head, deps, session, 'insights', async () => {
    try {
      if (deps.holdInsights) await deps.holdInsights();
      const sources = callsSources(deps, only);
      const apps = await figuresOf(deps).range(sources, from, to);
      const withKb = sources.filter((s) => s.app.knowledge !== undefined).length;
      const answer: InsightsAnswer = { from, to, insights: insightsOf(apps, deps.carrierRates), lengthEdgesS: LENGTH_EDGES_S, knowledge: withKb === 0 ? null : { apps: withKb, command: 'pnpm kb:gaps' } };
      return answer;
    } finally {
      done();
    }
  });
}

/** One app's part of the Knowledge page. */
export interface KnowledgeApp {
  id: string | null;
  name: string;
  status: KnowledgeStatus;
  /** The unanswered questions of the last `days` days, by nearest topic, the most first (at most 10), and how many in all. */
  unanswered: { total: number; top: { topic: string; label: string; n: number; latest: string }[] };
}

const KNOWLEDGE_DAYS = [7, 30, 90];

/** The Knowledge page: each app's knowledge base counted, and its unanswered questions of the last `?days=` (7, 30 or 90) days. */
async function knowledgeOf(deps: DashboardDeps, query: URLSearchParams): Promise<{ days: number; apps: KnowledgeApp[] }> {
  const asked = Number(query.get('days'));
  const days = KNOWLEDGE_DAYS.includes(asked) ? asked : 30;
  const only = onlyApp(deps, query);
  const sources = callsSources(deps, only);
  const to = Date.now();
  const out: KnowledgeApp[] = [];
  for (const s of sources) {
    const dir = s.id === null ? deps.appDir : deps.apps?.find((a) => a.id === s.id)?.dir;
    const status = await knowledgeStatusOf(s.app, dir);
    let unanswered: KnowledgeApp['unanswered'] = { total: 0, top: [] };
    if (status.kind !== 'none') {
      const [figures] = await figuresOf(deps).range([s], to - days * 86_400_000, to);
      const ins = insightsOf(figures ? [{ ...figures, id: null }] : [], undefined);
      unanswered = { total: ins.totals.gaps, top: ins.gapTopics.slice(0, 10).map((g) => ({ topic: g.key, label: g.label, n: g.value.n, latest: g.value.latest })) };
    }
    out.push({ id: s.id, name: appNameOf(s.app), status, unanswered });
  }
  return { days, apps: out };
}

/** What /dashboard/health answers. */
export interface HealthAnswer {
  at: number;
  /** This server first, then the others heard from in the last minutes (with a shared store). */
  servers: ServerSeen[];
  shared: boolean;
  numbers: HealthNumbers | null;
  latency: { asks: number; medianMs: number | null; p95Ms: number | null };
  audit: { available: boolean; label: string | null; running: boolean; last: AuditCheck | null };
}

const verifiers = new WeakMap<HealthSource, AuditVerifier>();
function verifierOf(h: HealthSource | undefined): AuditVerifier | null {
  if (!h?.verify) return null;
  let v = verifiers.get(h);
  if (!v) { v = new AuditVerifier(h.verify); verifiers.set(h, v); }
  return v;
}

function healthOf(deps: DashboardDeps): HealthAnswer {
  const h = deps.health;
  const now = Date.now();
  const self: ServerSeen | null = h ? { ...h.self(), lastSeenMs: now, self: true } : null;
  const peers = h?.peers?.() ?? [];
  const v = verifierOf(h);
  return {
    at: now,
    servers: [...(self ? [self] : []), ...peers.filter((p) => p.server !== self?.server)],
    shared: h?.peers !== undefined,
    numbers: h ? h.numbers() : null,
    latency: latencyOf(deps.bus).stats(),
    audit: { available: v !== null, label: h?.auditLabel ?? null, running: v?.busy ?? false, last: v?.last ?? null },
  };
}

/** The audit verified (one at a time: an asker while one runs gets its answer), each asking recorded first. */
function auditRoute(res: ServerResponse, deps: DashboardDeps, head: boolean, session: ConsoleSession | null): void {
  const v = verifierOf(deps.health);
  if (v === null) { send(res, 404, 'text/plain', 'no audit to verify on this server', head); return; }
  if (head) { send(res, 200, 'application/json', '{}', head); return; }
  const noted = deps.auth && session ? deps.auth.noteAuditCheck(session) : undefined;
  const run = (): void => answerJson(res, head, () => v.verify());
  if (noted instanceof Promise) { noted.then(run, () => send(res, 503, 'text/plain', 'the access could not be recorded', head)); return; }
  run();
}

/** Returns true when the request was a dashboard route (handled), false to let the caller continue. */
export function handleDashboardRequest(req: IncomingMessage, res: ServerResponse, deps: DashboardDeps): boolean {
  const path = (req.url ?? '/').split('?')[0] ?? '/';
  if (!isConsolePath(path)) return false;
  if (!deps.enabled) return false;
  const auth = deps.auth;
  let session: ConsoleSession | null = null;
  if (auth) {
    auth.protect(res);
    if (auth.handle(req, res, path)) return true;
    session = auth.sessionOf(req);
    if (session === null) { auth.refuse(req, res, path); return true; }
  }
  const head = req.method === 'HEAD';
  if (req.method !== 'GET' && !head) { send(res, 405, 'text/plain', 'method not allowed'); return true; }

  const query = new URLSearchParams((req.url ?? '').includes('?') ? (req.url ?? '').slice((req.url ?? '').indexOf('?') + 1) : '');
  // The page is the default app's console: its name, mark and words are put in as it is served. On a
  // host, the app `?app=` names (its filter), with every app's words beside it.
  if (path === '/dashboard' || path === '/dashboard/') {
    const template = readFileSync(join(HERE, 'page.html'), 'utf8');
    const meta = pageMeta(deps, query);
    if (!auth) {
      send(res, 200, 'text/html; charset=utf-8', renderConsolePage(template, meta), head);
      return true;
    }
    // Signed in: the page's own script and style run by this answer's nonce, and it can sign out.
    const nonce = randomBytes(16).toString('base64');
    auth.protect(res, nonce);
    const withNonce = template.replace('<script type="module">', `<script type="module" nonce="${nonce}">`).replace('<style>', `<style nonce="${nonce}">`);
    send(res, 200, 'text/html; charset=utf-8', renderConsolePage(withNonce, meta, { signOut: true }), head);
    return true;
  }
  if (path === '/dashboard/view.js') {
    send(res, 200, 'text/javascript; charset=utf-8', readFileSync(join(HERE, 'view.js')), head);
    return true;
  }
  // Replay mode has no live feed to carry the boot id, so the page asks for it here instead; with
  // it, the app the console serves (the same metadata the page was served with).
  if (path === '/dashboard/boot') {
    send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ bootId: BOOT_ID, app: pageMeta(deps, query) }), head);
    return true;
  }
  if (path === '/dashboard/events') {
    // The Live list's rows (`?view=calls`), one call's events (`?call=<id>`), or the newest call's.
    const list = query.get('view') === 'calls';
    const shows = list ? null : feedFilter(deps, query);
    if (!list && shows === null) { send(res, 404, 'text/plain', 'not found', head); return true; }
    const open = (): void => (list ? listFeed(req, res, deps, head, auth) : liveFeed(req, res, deps, head, auth, shows!));
    // Recorded before a byte of the feed is sent: a watch the audit could not record is not served. A
    // call's own feed is recorded under the call too, the first time a session opens it, as a replay is.
    const call = query.get('call');
    const noted = !head && auth && session
      ? chain(auth.noteLive(session), () => (call !== null ? auth.noteCall(session!, call, appOfCall(deps, call)) : undefined))
      : undefined;
    if (noted instanceof Promise) {
      // AUDIT_STORE=postgres: the feed starts once the database has the record.
      noted.then(open, () => send(res, 503, 'text/plain', 'the access could not be recorded', head));
      return true;
    }
    open();
    return true;
  }
  // The Calls page: past calls from the traces, filtered and paged (calls.ts).
  if (path === '/dashboard/calls') {
    const only = deps.apps && deps.apps.length > 0 ? query.get('app') : null;
    const q = callsQueryOf(query);
    // One search at a time per session (or, with no sign-in, for the console): a second waits for no
    // one, it is refused, so a console cannot keep the server reading traces.
    const who = session?.id ?? 'local';
    if (searching.has(who)) { send(res, 429, 'text/plain', 'a search is already running: try again when it answers', head); return true; }
    searching.add(who);
    const done = (): void => { searching.delete(who); };
    res.once('close', done);
    // A search by a caller's last four is recorded before it is answered, with its range: who looked for whom.
    const noted = !head && auth && session && q.last4 !== undefined
      ? auth.noteSearch(session, { last4: q.last4, ...(q.fromMs !== undefined ? { fromMs: q.fromMs } : {}), ...(q.toMs !== undefined ? { toMs: q.toMs } : {}), app: only })
      : undefined;
    answerJson(res, head, async () => {
      try {
        if (noted instanceof Promise) await noted;
        if (deps.holdCalls) await deps.holdCalls();
        return await listCalls(callsSources(deps, only), q, Date.now());
      } finally {
        done();
      }
    });
    return true;
  }
  // The Live page's figures for today: since the start of the viewer's day (`?since=<ms>`), from the traces.
  if (path === '/dashboard/today') {
    const only = deps.apps && deps.apps.length > 0 ? query.get('app') : null;
    const since = msOf(query.get('since')) ?? new Date(new Date().setHours(0, 0, 0, 0)).getTime();
    answerJson(res, head, async () => {
      const t = await todayFigures(deps, only, since);
      return { ...t, carrierUsd: carrierCostOf(t.billedMinutes, deps.carrierRates) };
    });
    return true;
  }
  // Insights, Knowledge and Health: each read recorded (its first in a session), then answered.
  if (path === '/dashboard/insights') {
    insightsRoute(req, res, deps, head, query, session);
    return true;
  }
  if (path === '/dashboard/knowledge') {
    viewed(res, head, deps, session, 'knowledge', () => knowledgeOf(deps, query));
    return true;
  }
  if (path === '/dashboard/health') {
    viewed(res, head, deps, session, 'health', async () => healthOf(deps));
    return true;
  }
  if (path === '/dashboard/health/audit') {
    auditRoute(res, deps, head, session);
    return true;
  }
  if (path === '/dashboard/traces' && deps.apps && deps.apps.length > 0) {
    hostRows(res, head, deps.apps, query.get('app'));
    return true;
  }
  if (path === '/dashboard/traces' && deps.traces) {
    fromStore(res, head, deps.traces, null, null);
    return true;
  }
  if (path === '/dashboard/traces') {
    const rows = folderRows(deps.traceDir).sort(newestFirst);
    send(res, 200, 'application/json', JSON.stringify(rows), head);
    return true;
  }
  const m = /^\/dashboard\/traces\/([^/]+)$/.exec(path);
  if (m) {
    let sid: string;
    try {
      sid = decodeURIComponent(m[1]!);
    } catch {
      send(res, 404, 'text/plain', 'not found', head);
      return true;
    }
    if (SID.test(sid) && deps.apps && deps.apps.length > 0) {
      hostReplay(res, head, deps.apps, sid, query.get('app'), !head && auth && session ? (app: string) => auth.noteReplay(session!, sid, app) : null);
      return true;
    }
    if (SID.test(sid) && deps.traces) {
      fromStore(res, head, deps.traces, sid, !head && auth && session ? () => auth.noteReplay(session!, sid) : null);
      return true;
    }
    if (!SID.test(sid) || !existsSync(join(deps.traceDir, `${sid}.jsonl`))) {
      send(res, 404, 'text/plain', 'not found', head);
      return true;
    }
    const replay = readTrace(deps.traceDir, sid);
    const noted = !head && auth && session ? auth.noteReplay(session, sid) : undefined;
    if (noted instanceof Promise) {
      // AUDIT_STORE=postgres: answered once the database has the record of it.
      noted.then(() => send(res, 200, 'application/json', JSON.stringify(replay), head), () => send(res, 503, 'text/plain', 'the access could not be recorded', head));
      return true;
    }
    send(res, 200, 'application/json', JSON.stringify(replay), head);
    return true;
  }
  send(res, 404, 'text/plain', 'not found', head);
  return true;
}
