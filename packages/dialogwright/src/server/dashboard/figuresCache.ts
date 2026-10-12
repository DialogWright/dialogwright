import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { dayOf } from '../../trace/store';
import { candidatesOf, summariesOf, type Candidate, type CallsSource } from './calls';
import { FIGURES_VERSION, hourOf, hoursOf, sumHours, type AppFigures, type HourFigures } from './figures';

/**
 * The daily figures cache: Insights' figures (figures.ts) per app and UTC day, worked out from the
 * traces once and kept beside them, so a page does not read every trace every time.
 *
 * Where: on one machine a small JSON file per day in the traces' folder (`<TRACE_DIR>/.figures/<day>.json`,
 * each app's folder on a host); on the trace store an object under the day's folder
 * (`<prefix><day>/.figures/figures.json`, each app's prefix on a host). Retention removes them with
 * their day (retention.ts; the store's sweep removes the day's folder whole).
 *
 * What: HourFigures by the hour, counts, durations and dollars only, never a value a caller gave; with
 * FIGURES_VERSION (a cache of another version is worked out again) and the fingerprint of the traces it
 * was worked out from: how many calls the day's traces are, their bytes and their newest write. A day
 * is worked out again only when its file is missing, of another version, or its traces changed since.
 *
 * When: a day's figures, once read or worked out, are kept in memory and taken as they are for a minute,
 * and no longer once the server has seen a call end (Console 1's counter, `endsSeen`): today's figures
 * follow the calls as they end. Past that, the day's traces are listed again (names, sizes and times
 * only) and compared with the fingerprint. One computation per app and day at a time; a second asker
 * waits for the first's answer. Every read is asynchronous, a few traces at a time with the server's
 * other work let run between (calls.ts summariesOf), so a voice call's turns are never held up.
 *
 * Which calls are a day's: those that started in it. On the store, a call's folder is its start day;
 * on one machine, a file last written from the day's start to a day after its end (a call is never
 * longer), read for its start.
 */

const DAY_MS = 86_400_000;
/** The longest a call lasts (calls.ts's narrowing): a call that started on a day was last written by a day after its end. */
const MAX_CALL_MS = DAY_MS;
/** How long a day's figures are taken as they are, with no call ended since. */
const KEPT_MS = 60_000;
/** The most app-days kept in memory. */
const MAX_DAYS_KEPT = 2_000;
/** A day's folder and file name. */
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The folder of one machine's figures, in a trace folder: a dot first, so no trace reader takes it for a call. */
export const FIGURES_DIR = '.figures';
/** A day's figures object on the trace store, under the day's folder. */
export const FIGURES_OBJECT = `${FIGURES_DIR}/figures.json`;

/** A day's figures as stored. */
export interface DayFigures {
  v: number;
  app: string | null;
  day: string;
  /** The traces it was worked out from: `<calls>:<bytes>:<newest write>`. */
  fingerprint: string;
  computedAt: number;
  hours: Record<string, HourFigures>;
}

interface Kept {
  fingerprint: string;
  hours: Record<string, HourFigures>;
  checkedAt: number;
  ends: number;
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

const sourceKey = (s: CallsSource): string => `${s.id ?? ''}|${s.traces ? s.traces.label : s.traceDir}`;

export interface FiguresCacheOptions {
  now?: () => number;
  /** How many calls the server has seen end (Console 1's counter): a day kept is looked at again once it moves. */
  endsSeen?: () => number;
  /** Tests: told each day worked out (not read from memory or a file). */
  onCompute?: (app: string | null, day: string) => void;
}

/** One server's daily figures (per bus, as Console 1's today's figures are). */
export class FiguresCache {
  private readonly kept = new Map<string, Kept>();
  private readonly working = new Map<string, Promise<Record<string, HourFigures>>>();
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
    for (const s of sources) {
      const hours: Record<string, HourFigures> = {};
      const byDay = await this.days(s, days);
      for (const dayHours of byDay) {
        for (const [k, h] of Object.entries(dayHours)) {
          const at = Number(k);
          if (at >= hourOf(fromMs) && at <= toMs) hours[k] = h;
        }
      }
      out.push({ id: s.id, app: s.app, figures: sumHours(Object.values(hours)), hours });
    }
    return out;
  }

  /** One source's figures for each day, in order. */
  private async days(s: CallsSource, days: readonly string[]): Promise<Record<string, HourFigures>[]> {
    const now = this.now();
    const ends = this.ends();
    const keyOf = (day: string): string => `${sourceKey(s)}|${day}`;
    // Every day kept a moment ago, with no call ended since: as it is, nothing listed.
    const fresh = (day: string): Kept | undefined => {
      const k = this.kept.get(keyOf(day));
      return k && k.ends === ends && now - k.checkedAt < KEPT_MS ? k : undefined;
    };
    if (days.every((d) => fresh(d) !== undefined)) return days.map((d) => this.touch(keyOf(d))!.hours);
    const byDay = await this.listDays(s, days);
    const out: Record<string, HourFigures>[] = [];
    for (const day of days) {
      const key = keyOf(day);
      const cands = byDay.get(day) ?? [];
      const fingerprint = fingerprintOf(cands);
      const had = this.kept.get(key);
      if (had && had.fingerprint === fingerprint) {
        this.keep(key, { ...had, checkedAt: now, ends });
        out.push(had.hours);
        continue;
      }
      // One computation per app and day: a second asker waits for the first.
      let work = this.working.get(key);
      if (!work) {
        work = this.load(s, day, cands, fingerprint).finally(() => this.working.delete(key));
        this.working.set(key, work);
      }
      const hours = await work;
      this.keep(key, { fingerprint, hours, checkedAt: now, ends });
      out.push(hours);
    }
    return out;
  }

  /** The day's figures from its file when it was worked out from these traces, else worked out now and stored. */
  private async load(s: CallsSource, day: string, cands: readonly Candidate[], fingerprint: string): Promise<Record<string, HourFigures>> {
    if (cands.length === 0) return {};
    const stored = await this.readStored(s, day);
    if (stored !== null && stored.v === FIGURES_VERSION && stored.fingerprint === fingerprint && stored.day === day) return stored.hours;
    this.o.onCompute?.(s.id, day);
    const from = startOfDay(day);
    const summaries = await summariesOf(cands, this.now());
    const theDays = summaries.map((x) => x.summary).filter((x) => x.row.startedAt !== null && x.row.startedAt >= from && x.row.startedAt < from + DAY_MS);
    const hours = hoursOf(theDays);
    const file: DayFigures = { v: FIGURES_VERSION, app: s.id, day, fingerprint, computedAt: this.now(), hours };
    // Stored best-effort: figures that could not be written are worked out again next time, never an error.
    await this.writeStored(s, day, file).catch(() => undefined);
    return hours;
  }

  /** The day's calls by name, for each day asked: the store's day folders, or a folder's files by their last write. */
  private async listDays(s: CallsSource, days: readonly string[]): Promise<Map<string, Candidate[]>> {
    const out = new Map<string, Candidate[]>();
    if (days.length === 0) return out;
    if (s.traces) {
      const calls = await s.traces.calls({ from: days[0]!, to: days.at(-1)! });
      for (const c of calls) {
        if (!days.includes(c.day)) continue;
        const list = out.get(c.day) ?? [];
        list.push({ source: s, sid: c.id, lastMs: c.lastModifiedMs, size: c.sizeBytes, day: c.day });
        out.set(c.day, list);
      }
      return out;
    }
    const all = await candidatesOf(s, startOfDay(days[0]!), startOfDay(days.at(-1)!) + DAY_MS - 1);
    for (const day of days) {
      const from = startOfDay(day);
      out.set(day, all.filter((c) => c.lastMs >= from && c.lastMs <= from + DAY_MS + MAX_CALL_MS));
    }
    return out;
  }

  private async readStored(s: CallsSource, day: string): Promise<DayFigures | null> {
    if (!DAY.test(day)) return null;
    let text: string | null;
    try {
      text = s.traces ? await s.traces.client.get(`${s.traces.prefix}${day}/${FIGURES_OBJECT}`) : await readFile(join(s.traceDir, FIGURES_DIR, `${day}.json`), 'utf8');
    } catch {
      return null;
    }
    if (text === null) return null;
    try {
      const parsed = JSON.parse(text) as Partial<DayFigures>;
      if (typeof parsed !== 'object' || parsed === null || typeof parsed.fingerprint !== 'string' || typeof parsed.hours !== 'object' || parsed.hours === null) return null;
      return parsed as DayFigures;
    } catch {
      return null;
    }
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

  private touch(key: string): Kept | undefined {
    const k = this.kept.get(key);
    if (k) { this.kept.delete(key); this.kept.set(key, k); }
    return k;
  }

  private keep(key: string, k: Kept): void {
    this.kept.delete(key);
    this.kept.set(key, k);
    if (this.kept.size > MAX_DAYS_KEPT) this.kept.delete(this.kept.keys().next().value!);
  }
}
