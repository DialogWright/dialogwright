import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { dayOf } from '../../trace/store';
import { candidatesOf, summariesOf, type Candidate, type CallsSource } from './calls';
import { dayDataFrom, dayDataOf, FIGURES_VERSION, hourOf, sumHours, type AppFigures, type DayData, type HourFigures } from './figures';
import { STALE_MS } from './view.js';

/**
 * The daily figures cache: Insights' figures (figures.ts) per app and UTC day, worked out from the
 * traces once and kept beside them, so a page does not read every trace every time.
 *
 * Where: on one machine a small JSON file per day in the traces' folder (`<TRACE_DIR>/.figures/<day>.json`,
 * each app's folder on a host); on the trace store an object under the day's folder
 * (`<prefix><day>/.figures/figures.json`, each app's prefix on a host). The traces' retention leaves
 * them; FIGURES_RETENTION_DAYS (unset: kept) removes them (retention.ts, trace/store.ts sweepFigures).
 *
 * What: a day's DayData (counts, durations and dollars by the hour, and each call's span), never a value
 * a caller gave, with FIGURES_VERSION, the fingerprint of the traces it was worked out from (how many
 * calls, their bytes, their newest write), whether the day is closed, and, while a call of the day has
 * no end recorded, when it will be taken for ended (`settleBy`: its last word and STALE_MS).
 *
 * A day is open while its traces can still change: on one machine until a day after its end (a call is
 * never longer), on the store until the day before yesterday (UTC); and while a call of it is still
 * unsettled. An open day's figures are taken from memory for a minute while no call has ended (Console
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
 * In memory each day kept is its sums, its calls by the hour and its spans (MAX_DAYS_KEPT); its figures
 * by the hour, which a range starting or ending inside it needs, are kept for MAX_FULL_KEPT days and
 * otherwise read back from its file.
 */

const DAY_MS = 86_400_000;
/** The longest a call lasts (calls.ts's narrowing): a call that started on a day was last written by a day after its end. */
export const MAX_CALL_MS = DAY_MS;
/** How long an open day's figures are taken as they are, with no call ended since. */
const KEPT_MS = 60_000;
/** The most app-days kept in memory (each its day's sums, its calls by the hour and its spans). */
const MAX_DAYS_KEPT = 2_000;
/** The most app-days whose figures by the hour are kept in memory beside. */
const MAX_FULL_KEPT = 64;
/** A day's folder and file name. */
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The folder of one machine's figures, in a trace folder: a dot first, so no trace reader takes it for a call. */
export const FIGURES_DIR = '.figures';
/** A day's figures object on the trace store, under the day's folder. */
export const FIGURES_OBJECT = `${FIGURES_DIR}/figures.json`;

/** A day's figures as stored. */
export interface DayFigures extends DayData {
  v: number;
  app: string | null;
  day: string;
  /** The traces it was worked out from: `<calls>:<bytes>:<newest write>`. */
  fingerprint: string;
  computedAt: number;
  /** Final: worked out once the day's traces could no longer change, with every call settled. */
  closed: boolean;
  /** While a call has no end recorded: when it will be taken for ended (its last word and STALE_MS); null with none. */
  settleBy: number | null;
}

/** A day as kept in memory: its sums, its calls by the hour, its spans; never more than a range needs. */
interface Kept {
  fingerprint: string;
  closed: boolean;
  settleBy: number | null;
  checkedAt: number;
  ends: number;
  sum: HourFigures;
  hourCalls: Record<string, number>;
  spans: number[];
  peaks: Record<string, number>;
  older?: true;
  unreadable?: true;
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

function fingerprintOf(cands: readonly Candidate[]): string {
  const bytes = cands.reduce((n, c) => n + c.size, 0);
  const newest = cands.reduce((n, c) => Math.max(n, Math.floor(c.lastMs)), 0);
  return `${cands.length}:${bytes}:${newest}`;
}
const callsIn = (fingerprint: string): number => Number(fingerprint.split(':')[0]) || 0;

const sourceKey = (s: CallsSource): string => `${s.id ?? ''}|${s.traces ? s.traces.label : s.traceDir}`;

/** A day's figures in memory, from its DayData. */
function keptOf(data: DayData, o: { fingerprint: string; closed: boolean; settleBy: number | null; now: number; ends: number; older?: boolean; unreadable?: boolean }): Kept {
  const hourCalls: Record<string, number> = {};
  for (const [k, h] of Object.entries(data.hours)) hourCalls[k] = h.calls;
  return {
    fingerprint: o.fingerprint, closed: o.closed, settleBy: o.settleBy, checkedAt: o.now, ends: o.ends,
    sum: sumHours(Object.values(data.hours)), hourCalls, spans: data.spans, peaks: data.peaks ?? {},
    ...(o.older ? { older: true as const } : {}), ...(o.unreadable ? { unreadable: true as const } : {}),
  };
}

export interface FiguresCacheOptions {
  now?: () => number;
  /** How many calls the server has seen end (Console 1's counter): an open day kept is looked at again once it moves. */
  endsSeen?: () => number;
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
    const out: AppFigures[] = [];
    const inRange = (h: string): boolean => Number(h) >= hourOf(fromMs) && Number(h) <= toMs;
    for (const s of sources) {
      const kept = await this.days(s, days);
      const sums: HourFigures[] = [];
      const hourCalls: Record<string, number> = {};
      const spans: number[] = [];
      const peaks: Record<string, number> = {};
      const older: string[] = [];
      const unreadable: string[] = [];
      for (const [i, day] of days.entries()) {
        const k = kept[i]!;
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
        for (let j = 0; j + 1 < k.spans.length; j += 2) if (k.spans[j]! <= toMs && k.spans[j + 1]! >= fromMs) spans.push(k.spans[j]!, k.spans[j + 1]!);
        for (const [h, p] of Object.entries(k.peaks)) if (inRange(h)) peaks[h] = p;
      }
      out.push({ id: s.id, app: s.app, figures: sumHours(sums), hourCalls, spans, peaks, older, unreadable });
    }
    return out;
  }

  /** A day's figures by the hour: kept beside, or read back from its file; null when they cannot be read. */
  private async hoursOf(s: CallsSource, day: string): Promise<Record<string, HourFigures> | null> {
    const key = `${sourceKey(s)}|${day}`;
    const had = this.full.get(key);
    if (had) { this.full.delete(key); this.full.set(key, had); return had; }
    const stored = await this.readStored(s, day);
    const data = stored?.data ?? (stored !== null && stored.v < FIGURES_VERSION ? dayDataFrom(stored.file, true) : null);
    if (!data) return null;
    this.keepFull(key, data.hours);
    return data.hours;
  }

  /** Whether a day's traces can no longer change: on the store from the day after yesterday; on one machine a day after its end. */
  private closable(s: CallsSource, day: string, now: number): boolean {
    return s.traces ? startOfDay(dayOf(now)) >= startOfDay(day) + 2 * DAY_MS : now > startOfDay(day) + DAY_MS + MAX_CALL_MS;
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
    if (cands.length === 0) {
      // No trace of the day: a file of an older version is read as it can be; else the day had no call.
      if (stored !== null && current === null) {
        const older = stored.v >= 1 && stored.v < FIGURES_VERSION ? dayDataFrom(stored.file, true) : null;
        if (older !== null) return { kept: keptOf(older, { fingerprint, closed: closable, settleBy: null, now, ends, older: true }), hours: older.hours };
        return { kept: keptOf({ hours: {}, spans: [] }, { fingerprint, closed: closable, settleBy: null, now, ends, unreadable: true }), hours: {} };
      }
      return { kept: keptOf({ hours: {}, spans: [] }, { fingerprint, closed: closable, settleBy: null, now, ends }), hours: {} };
    }
    this.o.onCompute?.(s.id, day);
    const from = startOfDay(day);
    const summaries = (await summariesOf(cands, now)).map((x) => x.summary).filter((x) => x.row.startedAt !== null && x.row.startedAt >= from && x.row.startedAt < from + DAY_MS);
    const data = dayDataOf(summaries);
    // A call with no end recorded is in progress until STALE_MS after its last word: the day is looked at again then.
    const open = summaries.filter((x) => x.row.ending === null && x.row.lastAt !== null).map((x) => x.row.lastAt! + STALE_MS);
    const settleBy = open.length === 0 ? null : Math.max(...open);
    let closed = closable && settleBy === null;
    if (data.spans.length > 0) {
      const file: DayFigures = { v: FIGURES_VERSION, app: s.id, day, fingerprint, computedAt: now, closed, settleBy, ...data };
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
      text = s.traces ? await s.traces.client.get(`${s.traces.prefix}${day}/${FIGURES_OBJECT}`) : await readFile(join(s.traceDir, FIGURES_DIR, `${day}.json`), 'utf8');
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
    const data = v === FIGURES_VERSION && ok ? dayDataFrom(parsed) : null;
    return { v, file: parsed as DayFigures, data };
  }

  private async writeStored(s: CallsSource, day: string, file: DayFigures): Promise<void> {
    if (!DAY.test(day)) return;
    const body = JSON.stringify(file);
    if (s.traces) {
      await s.traces.client.put(`${s.traces.prefix}${day}/${FIGURES_OBJECT}`, body);
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
