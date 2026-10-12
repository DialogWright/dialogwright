import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { dayOf } from '../../trace/store';
import { candidatesOf, summariesOf, type Candidate, type CallsSource } from './calls';
import { COUNTED_MINUTES, DAY_MINUTES, dayDataFrom, dayDataOf, FIGURES_VERSION, hourOf, minutesToRuns, sumHours, type AppFigures, type DayData, type HourFigures } from './figures';
import { STALE_MS } from './view.js';

/**
 * The daily figures cache: Insights' figures (figures.ts) per app and UTC day, worked out from the
 * traces once and kept beside them, so a page does not read every trace every time.
 *
 * Where: on one machine a small JSON file per day in the traces' folder (`<TRACE_DIR>/.figures/<day>.json`,
 * each app's folder on a host); on the trace store an object under the day's folder
 * beside the day folders (`<prefix>.figures/<day>.json`, each app's prefix on a host). The traces' retention leaves
 * them; FIGURES_RETENTION_DAYS (unset: kept) removes them (retention.ts, trace/store.ts sweepFigures).
 *
 * What: a day's DayData (counts, durations and dollars by the hour, and how many calls were in progress
 * each minute: never a call's own times), never a value a caller gave, with FIGURES_VERSION, the
 * fingerprint of the traces it was worked out from (how many calls, and a hash of their bytes and newest
 * write), whether the day is closed, and, while a call of the day has
 * no end recorded, when it will be taken for ended (`settleBy`: its last word and STALE_MS, rounded up to
 * the next hour, so no call's time is written).
 *
 * A day is open while its traces can still change: on one machine until a day after its end (a call is
 * never longer), on the store until the day before yesterday (UTC), each with an hour's margin for a
 * late write; and while a call of it is still unsettled. A trace written for a day after it closed is
 * not counted (said in 14.9). A day older than FIGURES_RETENTION_DAYS is not read or worked out at all,
 * so a short figures retention never has a day worked out again only to be swept. An open day's figures are taken from memory for a minute while no call has ended (Console
 * 1's counter, `endsSeen`), then its traces are listed again (names, sizes and times only) and its
 * figures worked out again when the fingerprint changed or a call it held in progress is now settled.
 *
 * A closed day is final (the maintainer's to confirm, see the plan's As built): its file is its record,
 * never listed or worked out again, so it outlives its traces (trimmed, swept, gone) under the figures'
 * own retention. A closed day of an older version is worked out again while its traces are there, and
 * otherwise read as older figures where its shape can be read (`older`), or left out (`unreadable`).
 *
 * One computation per app, day and fingerprint at a time; a second asker waits for it. Every read is
 * asynchronous, a few traces at a time with the server's other work let run between (calls.ts
 * summariesOf), and a range's candidates are put in their days in one pass, so a voice call's turns are
 * never held up. Which calls are a day's: those that started in it.
 *
 * In memory each day kept is its sums, its calls by the hour and its counts by the minute (2,880 small
 * integers, about 6 KB: a quarter's range of one app is well under 1 MB) (MAX_DAYS_KEPT); its figures
 * by the hour, which a range starting or ending inside it needs, are kept for MAX_FULL_KEPT days and
 * otherwise read back from its file.
 */

const DAY_MS = 86_400_000;
/** The longest a call lasts (calls.ts's narrowing): a call that started on a day was last written by a day after its end. */
export const MAX_CALL_MS = DAY_MS;
/** How long an open day's figures are taken as they are, with no call ended since. */
const KEPT_MS = 60_000;
/** The most app-days kept in memory (each its day's sums, its calls by the hour and its counts by the minute). */
const MAX_DAYS_KEPT = 2_000;
/** The most app-days whose figures by the hour are kept in memory beside. */
const MAX_FULL_KEPT = 64;
/** A day's folder and file name. */
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The folder of one machine's figures, in a trace folder: a dot first, so no trace reader takes it for a call. */
export const FIGURES_DIR = '.figures';
/** The trace store's folder of the figures, under the prefix beside the day folders (`<prefix>.figures/<day>.json`): no day folder's listing grows with them. */
export const FIGURES_PREFIX = `${FIGURES_DIR}/`;
/** An hour's margin before a day is closed, for a write that comes late. */
const CLOSE_MARGIN_MS = 3_600_000;

/** A day's figures as stored: its hours, and its counts by the minute as runs (figures.ts minutesToRuns). */
export interface DayFigures {
  hours: DayData['hours'];
  inProgress: number[];
  v: number;
  app: string | null;
  day: string;
  /** The traces it was worked out from: `<calls>:<a hash of their bytes and newest write>`. */
  fingerprint: string;
  computedAt: number;
  /** Final: worked out once the day's traces could no longer change, with every call settled. */
  closed: boolean;
  /** While a call has no end recorded: when it will be taken for ended (its last word and STALE_MS); null with none. */
  settleBy: number | null;
}

/** A day as kept in memory: its sums, its calls by the hour, its counts by the minute; never more than a range needs. */
interface Kept {
  fingerprint: string;
  closed: boolean;
  settleBy: number | null;
  checkedAt: number;
  ends: number;
  sum: HourFigures;
  hourCalls: Record<string, number>;
  minutes: Uint16Array;
  peaks: Record<string, number>;
  older?: true;
  unreadable?: true;
  /** Older than FIGURES_RETENTION_DAYS: not read. */
  expired?: true;
}

/** A figures file as read: its version, the file, and its figures (null when not of a shape this version reads). */
interface Stored {
  v: number;
  file: DayFigures;
  data: DayData | null;
}

const startOfDay = (day: string): number => Date.parse(`${day}T00:00:00Z`);

/** The UTC days from the one `fromMs` is in to the one `toMs` is in. */
export function daysBetween(fromMs: number, toMs: number): string[] {
  const out: string[] = [];
  for (let t = startOfDay(dayOf(fromMs)); t <= toMs; t += DAY_MS) out.push(dayOf(t));
  return out;
}

/**
 * The traces' fingerprint: how many calls, then a short hash of their bytes and their newest write, so
 * the file says when nothing a call did (its last write is a time of the call's).
 */
function fingerprintOf(cands: readonly Candidate[]): string {
  const bytes = cands.reduce((n, c) => n + c.size, 0);
  const newest = cands.reduce((n, c) => Math.max(n, Math.floor(c.lastMs)), 0);
  return `${cands.length}:${createHash('sha256').update(`${bytes}:${newest}`).digest('hex').slice(0, 16)}`;
}
const callsIn = (fingerprint: string): number => Number(fingerprint.split(':')[0]) || 0;

const sourceKey = (s: CallsSource): string => `${s.id ?? ''}|${s.traces ? s.traces.label : s.traceDir}`;

/** A day's figures in memory, from its DayData. */
function keptOf(data: DayData, o: { fingerprint: string; closed: boolean; settleBy: number | null; now: number; ends: number; older?: boolean; unreadable?: boolean }): Kept {
  const hourCalls: Record<string, number> = {};
  for (const [k, h] of Object.entries(data.hours)) hourCalls[k] = h.calls;
  return {
    fingerprint: o.fingerprint, closed: o.closed, settleBy: o.settleBy, checkedAt: o.now, ends: o.ends,
    sum: sumHours(Object.values(data.hours)), hourCalls, minutes: data.minutes, peaks: data.peaks ?? {},
    ...(o.older ? { older: true as const } : {}), ...(o.unreadable ? { unreadable: true as const } : {}),
  };
}

export interface FiguresCacheOptions {
  now?: () => number;
  /** How many calls the server has seen end (Console 1's counter): an open day kept is looked at again once it moves. */
  endsSeen?: () => number;
  /** FIGURES_RETENTION_DAYS: a day older is not read or worked out (unset: every day). */
  retentionDays?: number;
  /** Tests: told each day worked out from its traces (not read from memory or a file). */
  onCompute?: (app: string | null, day: string) => void;
}

/** One server's daily figures (per bus, as Console 1's today's figures are). */
export class FiguresCache {
  private readonly kept = new Map<string, Kept>();
  /** Days' figures by the hour, the most recently used last, for a range that starts or ends inside a day. */
  private readonly full = new Map<string, Record<string, HourFigures>>();
  private readonly working = new Map<string, Promise<{ kept: Kept; hours: Record<string, HourFigures> }>>();
  private readonly now: () => number;
  private readonly ends: () => number;

  constructor(private readonly o: FiguresCacheOptions = {}) {
    this.now = o.now ?? Date.now;
    this.ends = o.endsSeen ?? (() => 0);
  }

  /** Every source's figures for the range, summed per app: each day kept, read, or worked out. */
  async range(sources: readonly CallsSource[], fromMs: number, toMs: number): Promise<AppFigures[]> {
    const days = daysBetween(fromMs, toMs);
    const base = startOfDay(days[0]!);
    const out: AppFigures[] = [];
    const inRange = (h: string): boolean => Number(h) >= hourOf(fromMs) && Number(h) <= toMs;
    for (const s of sources) {
      const kept = await this.days(s, days);
      const sums: HourFigures[] = [];
      const hourCalls: Record<string, number> = {};
      // Each day's counts by the minute, its own and the next day's, at its place from the range's first day.
      const minutes = new Uint32Array((days.length + 1) * DAY_MINUTES);
      const peaks: Record<string, number> = {};
      const older: string[] = [];
      const unreadable: string[] = [];
      const expired: string[] = [];
      for (const [i, day] of days.entries()) {
        // A few days at a time, the server's other work let run between.
        if (i > 0 && i % 8 === 0) await new Promise<void>((r) => setImmediate(r));
        const k = kept[i]!;
        if (k.expired) { expired.push(day); continue; }
        if (k.older) older.push(day);
        if (k.unreadable) { unreadable.push(day); continue; }
        const whole = startOfDay(day) >= fromMs && startOfDay(day) + DAY_MS - 1 <= toMs;
        if (whole || k.sum.calls === 0) {
          sums.push(k.sum);
          Object.assign(hourCalls, k.hourCalls);
        } else {
          const hours = await this.hoursOf(s, day);
          if (hours === null) { unreadable.push(day); continue; }
          for (const [h, f] of Object.entries(hours)) if (inRange(h)) { sums.push(f); hourCalls[h] = f.calls; }
        }
        const at = i * DAY_MINUTES;
        for (let m = 0; m < COUNTED_MINUTES; m++) minutes[at + m]! += k.minutes[m]!;
        for (const [h, p] of Object.entries(k.peaks)) if (inRange(h)) peaks[h] = p;
      }
      out.push({ id: s.id, app: s.app, figures: sumHours(sums), hourCalls, base, minutes, peaks, older, unreadable, expired });
    }
    return out;
  }

  /** A day's figures by the hour: kept beside, or read back from its file; null when they cannot be read. */
  private async hoursOf(s: CallsSource, day: string): Promise<Record<string, HourFigures> | null> {
    const key = `${sourceKey(s)}|${day}`;
    const had = this.full.get(key);
    if (had) { this.full.delete(key); this.full.set(key, had); return had; }
    const stored = await this.readStored(s, day);
    const data = stored?.data ?? (stored !== null && stored.v === 1 ? dayDataFrom(stored.file, 1, startOfDay(day)) : null);
    if (!data) return null;
    this.keepFull(key, data.hours);
    return data.hours;
  }

  /** Whether a day's traces can no longer change: on the store from the day after yesterday; on one machine a day after its end. */
  private closable(s: CallsSource, day: string, now: number): boolean {
    return s.traces ? now >= startOfDay(day) + 2 * DAY_MS + CLOSE_MARGIN_MS : now > startOfDay(day) + DAY_MS + MAX_CALL_MS + CLOSE_MARGIN_MS;
  }

  /** Whether a day is older than FIGURES_RETENTION_DAYS (by its name, as the sweep removes it). */
  private expired(day: string, now: number): boolean {
    const days = this.o.retentionDays;
    return days !== undefined && startOfDay(dayOf(now)) - startOfDay(day) > days * DAY_MS;
  }

  /** One source's figures for each day, in order. */
  private async days(s: CallsSource, days: readonly string[]): Promise<Kept[]> {
    const now = this.now();
    const ends = this.ends();
    const keyOf = (day: string): string => `${sourceKey(s)}|${day}`;
    const out: (Kept | null)[] = [];
    const stored = new Map<string, Stored | null>();
    const toList: string[] = [];
    for (const day of days) {
      if (this.expired(day, now)) {
        out.push({ ...keptOf({ hours: {}, minutes: new Uint16Array(COUNTED_MINUTES) }, { fingerprint: '', closed: true, settleBy: null, now, ends }), expired: true });
        continue;
      }
      const k = this.kept.get(keyOf(day));
      if (k && (k.closed || (k.ends === ends && now - k.checkedAt < KEPT_MS && !(k.settleBy !== null && now >= k.settleBy)))) {
        this.touch(keyOf(day));
        out.push(k);
        continue;
      }
      if (!k && this.closable(s, day, now)) {
        // A closed day's file is its record: read, never listed again.
        const file = await this.readStored(s, day);
        stored.set(day, file);
        if (file !== null && file.data !== null && file.file.closed) {
          const kept = keptOf(file.data, { fingerprint: file.file.fingerprint, closed: true, settleBy: null, now, ends });
          this.keep(keyOf(day), kept);
          out.push(kept);
          continue;
        }
      }
      out.push(null);
      toList.push(day);
    }
    if (toList.length === 0) return out as Kept[];
    const byDay = await this.listDays(s, toList);
    for (const [i, day] of days.entries()) {
      if (out[i] !== null) continue;
      const key = keyOf(day);
      const cands = byDay.get(day) ?? [];
      const fingerprint = fingerprintOf(cands);
      const closable = this.closable(s, day, now);
      const had = this.kept.get(key);
      if (had && had.fingerprint === fingerprint && !(had.settleBy !== null && now >= had.settleBy) && !(closable && !had.closed)) {
        had.checkedAt = now;
        had.ends = ends;
        out[i] = had;
        continue;
      }
      // One computation per app, day and fingerprint: a second asker with the same traces waits for the first;
      // one with other traces works out its own, and each keeps the figures of the traces it listed.
      const workKey = `${key}|${fingerprint}|${closable}`;
      let work = this.working.get(workKey);
      if (!work) {
        work = this.load(s, day, cands, fingerprint, closable, stored.has(day) ? stored.get(day)! : undefined, now, ends).finally(() => this.working.delete(workKey));
        this.working.set(workKey, work);
      }
      const done = await work;
      this.keep(key, done.kept);
      this.keepFull(key, done.hours);
      out[i] = done.kept;
    }
    return out as Kept[];
  }

  /**
   * A day's figures: from its file when it was worked out from these traces (and nothing it held in
   * progress is settled since), from its file alone when its traces are fewer or gone and the day can no
   * longer change, else worked out now and stored, closed when it can be.
   */
  private async load(s: CallsSource, day: string, cands: readonly Candidate[], fingerprint: string, closable: boolean, read: Stored | null | undefined, now: number, ends: number): Promise<{ kept: Kept; hours: Record<string, HourFigures> }> {
    const stored = read === undefined ? await this.readStored(s, day) : read;
    const current = stored !== null && stored.data !== null ? stored : null;
    if (current !== null) {
      const f = current.file;
      const data = current.data!;
      const settled = f.settleBy === null;
      // The same traces, nothing in progress since settled: as it is (closed now if it can be).
      if (f.fingerprint === fingerprint && (settled || now < f.settleBy!)) {
        let close = closable && settled;
        if (close && !f.closed) await this.writeStored(s, day, { ...f, closed: true }).catch(() => { close = false; });
        return { kept: keptOf(data, { fingerprint, closed: close, settleBy: f.settleBy, now, ends }), hours: data.hours };
      }
      // The day can no longer change and fewer of its traces are left than it was worked out from (a
      // retention or a size bound removed some): the file is the day's record.
      if (closable && settled && cands.length < callsIn(f.fingerprint)) {
        if (!f.closed) await this.writeStored(s, day, { ...f, closed: true }).catch(() => undefined);
        return { kept: keptOf(data, { fingerprint, closed: true, settleBy: null, now, ends }), hours: data.hours };
      }
    }
    // A version-1 file of a day that can no longer change, with fewer traces left than it was worked out
    // from (or none): read as older figures rather than worked out again from what is left.
    const fewer = cands.length === 0 || (typeof stored?.file.fingerprint === 'string' && cands.length < callsIn(stored.file.fingerprint));
    if (stored !== null && current === null && stored.v === 1 && fewer && (closable || cands.length === 0)) {
      const older = dayDataFrom(stored.file, 1, startOfDay(day));
      if (older !== null) return { kept: keptOf(older, { fingerprint, closed: closable, settleBy: null, now, ends, older: true }), hours: older.hours };
    }
    if (cands.length === 0) {
      // No trace of the day: a file that could not be read is said to be so; else the day had no call.
      const empty = { hours: {}, minutes: new Uint16Array(COUNTED_MINUTES) };
      if (stored !== null && current === null) return { kept: keptOf(empty, { fingerprint, closed: closable, settleBy: null, now, ends, unreadable: true }), hours: {} };
      return { kept: keptOf(empty, { fingerprint, closed: closable, settleBy: null, now, ends }), hours: {} };
    }
    this.o.onCompute?.(s.id, day);
    const from = startOfDay(day);
    const summaries = (await summariesOf(cands, now)).map((x) => x.summary).filter((x) => x.row.startedAt !== null && x.row.startedAt >= from && x.row.startedAt < from + DAY_MS);
    const data = dayDataOf(summaries, from);
    // A call with no end recorded is in progress until STALE_MS after its last word: the day is looked at again then.
    const open = summaries.filter((x) => x.row.ending === null && x.row.lastAt !== null).map((x) => x.row.lastAt! + STALE_MS);
    // Rounded up to the hour: the file holds no call's own time.
    const settleBy = open.length === 0 ? null : Math.ceil(Math.max(...open) / 3_600_000) * 3_600_000;
    let closed = closable && settleBy === null;
    if (summaries.length > 0) {
      const file: DayFigures = { v: FIGURES_VERSION, app: s.id, day, fingerprint, computedAt: now, closed, settleBy, hours: data.hours, inProgress: minutesToRuns(data.minutes) };
      // Stored best-effort: figures that could not be written are worked out again next time, never an
      // error, and a day whose file is not written is not closed.
      await this.writeStored(s, day, file).catch(() => { closed = false; });
    }
    return { kept: keptOf(data, { fingerprint, closed, settleBy, now, ends }), hours: data.hours };
  }

  /**
   * The calls of the days asked by name, each in its days, in one pass: on the store each day's folder;
   * on one machine a file counts for each day whose window (from its start to a day after its end) its
   * last write is in.
   */
  private async listDays(s: CallsSource, days: readonly string[]): Promise<Map<string, Candidate[]>> {
    const out = new Map<string, Candidate[]>(days.map((d) => [d, []]));
    const sorted = [...days].sort();
    if (s.traces) {
      // Each day's folder on its own: the days asked are the open ones and the closed ones not yet worked out, rarely next to each other.
      for (const day of sorted) {
        for (const c of await s.traces.calls({ from: day, to: day })) out.get(c.day)?.push({ source: s, sid: c.id, lastMs: c.lastModifiedMs, size: c.sizeBytes, day: c.day });
      }
      return out;
    }
    for (const c of await candidatesOf(s, startOfDay(sorted[0]!), startOfDay(sorted.at(-1)!) + DAY_MS - 1)) {
      // The days whose window holds this last write: the day it was written on, back to a day and a call's length before.
      for (let t = startOfDay(dayOf(c.lastMs)); t >= c.lastMs - DAY_MS - MAX_CALL_MS; t -= DAY_MS) out.get(dayOf(t))?.push(c);
    }
    return out;
  }

  /** A day's figures file, read and checked; null for no file. */
  private async readStored(s: CallsSource, day: string): Promise<Stored | null> {
    if (!DAY.test(day)) return null;
    let text: string | null;
    try {
      text = s.traces ? await s.traces.client.get(`${s.traces.prefix}${FIGURES_PREFIX}${day}.json`) : await readFile(join(s.traceDir, FIGURES_DIR, `${day}.json`), 'utf8');
    } catch {
      return null;
    }
    if (text === null) return null;
    let parsed: Partial<DayFigures>;
    try {
      parsed = JSON.parse(text) as Partial<DayFigures>;
    } catch {
      return { v: -1, file: { v: -1 } as DayFigures, data: null };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { v: -1, file: { v: -1 } as DayFigures, data: null };
    const v = typeof parsed.v === 'number' ? parsed.v : -1;
    const ok = parsed.day === day && typeof parsed.fingerprint === 'string' && typeof parsed.closed === 'boolean'
      && (parsed.settleBy === null || (typeof parsed.settleBy === 'number' && Number.isFinite(parsed.settleBy)));
    const data = (v === FIGURES_VERSION || v === 2) && ok ? dayDataFrom(parsed as never, v, startOfDay(day)) : null;
    // A version-2 file kept each call's span: made counts by the minute as it is read, and written so at once.
    if (v === 2 && data !== null) {
      const { spans: _spans, ...rest } = parsed as DayFigures & { spans?: unknown };
      const file: DayFigures = { ...rest, v: FIGURES_VERSION, hours: data.hours, inProgress: minutesToRuns(data.minutes) } as DayFigures;
      await this.writeStored(s, day, file).catch(() => undefined);
      return { v: FIGURES_VERSION, file, data };
    }
    return { v, file: parsed as DayFigures, data };
  }

  private async writeStored(s: CallsSource, day: string, file: DayFigures): Promise<void> {
    if (!DAY.test(day)) return;
    const body = JSON.stringify(file);
    if (s.traces) {
      await s.traces.client.put(`${s.traces.prefix}${FIGURES_PREFIX}${day}.json`, body);
      return;
    }
    const dir = join(s.traceDir, FIGURES_DIR);
    await mkdir(dir, { recursive: true });
    // Written whole and then renamed, so a reader never sees half a file.
    const tmp = join(dir, `.${day}.${randomBytes(4).toString('hex')}.tmp`);
    await writeFile(tmp, body);
    await rename(tmp, join(dir, `${day}.json`));
  }

  private touch(key: string): void {
    const k = this.kept.get(key);
    if (k) { this.kept.delete(key); this.kept.set(key, k); }
  }

  private keep(key: string, k: Kept): void {
    this.kept.delete(key);
    this.kept.set(key, k);
    if (this.kept.size > MAX_DAYS_KEPT) this.kept.delete(this.kept.keys().next().value!);
  }

  private keepFull(key: string, hours: Record<string, HourFigures>): void {
    this.full.delete(key);
    this.full.set(key, hours);
    if (this.full.size > MAX_FULL_KEPT) this.full.delete(this.full.keys().next().value!);
  }
}
