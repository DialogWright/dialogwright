import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useTestkit } from '../../testing/apps';
import { writeFolderCall, writeStoreCall } from '../../testing/consoleCalls';
import { FakeS3 } from '../../testing/fakeS3';
import { defaultAppId, getApp } from '../../core/app/registry';
import { S3TraceStore, traceStoreSettingOf } from '../../trace/store';
import { forgetSummaries, type CallsSource } from './calls';
import { daysBetween, FiguresCache, FIGURES_DIR, FIGURES_PREFIX, type DayFigures } from './figuresCache';
import { FIGURES_VERSION, insightsOf } from './figures';
import { sweepRetention } from '../retention';

/**
 * The daily figures cache (figuresCache.ts): a day's figures worked out once from its traces and kept
 * beside them, read back after a restart, worked out again when the traces changed or the version did,
 * one computation per app and day at a time; counts and durations only.
 */

useTestkit();

const OPENER = 'my parcel never arrived';
const ACCOUNT = 'five five five zero one two three four';
const D1 = Date.parse('2026-09-18T15:00:00Z');
const D2 = Date.parse('2026-09-19T09:00:00Z');
const DAY1 = '2026-09-18';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  forgetSummaries();
});

function folder(): { dir: string; source: CallsSource } {
  const dir = mkdtempSync(join(tmpdir(), 'figures-cache-'));
  dirs.push(dir);
  return { dir, source: { id: null, app: getApp(defaultAppId()), traceDir: dir } };
}

/** A cache whose computations are counted, by day. */
function counted(o: { now?: () => number; endsSeen?: () => number; retentionDays?: number } = {}): { cache: FiguresCache; computed: string[] } {
  const computed: string[] = [];
  return { cache: new FiguresCache({ ...o, onCompute: (_app, day) => computed.push(day) }), computed };
}

const whole = (d: string): [number, number] => [Date.parse(`${d}T00:00:00Z`), Date.parse(`${d}T23:59:59.999Z`)];

describe('the UTC days of a range', () => {
  it('every day from the first to the last', () => {
    expect(daysBetween(Date.parse('2026-09-18T23:00:00Z'), Date.parse('2026-09-20T01:00:00Z'))).toEqual(['2026-09-18', '2026-09-19', '2026-09-20']);
  });
});

describe('one machine: a JSON file per day in the trace folder', () => {
  it('worked out once and written, redacted (counts and durations only); kept in memory; read back after a restart without reading a trace', async () => {
    const { dir, source } = folder();
    await writeFolderCall(dir, 'CA_1', [OPENER, ACCOUNT], 'hangup', D1, { from: '+15555550110' });
    await writeFolderCall(dir, 'CA_2', [OPENER, 'let me talk to a person'], 'handoff', D1 + 60_000, { from: '+15555550122' });
    await writeFolderCall(dir, 'CA_3', [OPENER], 'hangup', D2);
    const { cache, computed } = counted();
    const [a] = await cache.range([source], ...whole(DAY1));
    expect(a!.figures.calls).toBe(2);
    expect(computed).toEqual([DAY1]);
    const file = JSON.parse(readFileSync(join(dir, FIGURES_DIR, `${DAY1}.json`), 'utf8')) as DayFigures;
    expect(file.v).toBe(FIGURES_VERSION);
    expect(file.day).toBe(DAY1);
    // Every trace that may be the day's: the next day's call too, last written within a day of its end.
    expect(file.fingerprint).toMatch(/^3:[0-9a-f]{16}$/);
    // No value a caller gave: not the number, not the account, not the words.
    const text = JSON.stringify(file);
    for (const said of ['5555550110', '0110', '5550123', 'parcel never', 'person', 'five']) expect(text).not.toContain(said);
    // Again: from memory.
    await cache.range([source], ...whole(DAY1));
    expect(computed).toEqual([DAY1]);
    // A restart: a new cache and no summaries in memory; the file answers, no trace is read.
    forgetSummaries();
    const again = counted();
    const [b] = await again.cache.range([source], ...whole(DAY1));
    expect(again.computed).toEqual([]);
    expect(b!.figures).toEqual(a!.figures);
  });

  it('an open day: worked out again when its traces changed (a call added), when its file is of another version or unreadable', async () => {
    const { dir, source } = folder();
    // An hour into the day: open, its traces still being written.
    const now = (): number => D1 + 3_600_000;
    await writeFolderCall(dir, 'CA_1', [OPENER], 'hangup', D1);
    await new FiguresCache({ now }).range([source], ...whole(DAY1));
    await writeFolderCall(dir, 'CA_2', [OPENER], 'hangup', D1 + 120_000);
    const changed = counted({ now });
    const [a] = await changed.cache.range([source], ...whole(DAY1));
    expect(changed.computed).toEqual([DAY1]);
    expect(a!.figures.calls).toBe(2);
    const path = join(dir, FIGURES_DIR, `${DAY1}.json`);
    const file = JSON.parse(readFileSync(path, 'utf8')) as DayFigures;
    expect(file.closed).toBe(false);
    writeFileSync(path, JSON.stringify({ ...file, v: FIGURES_VERSION + 1 }));
    const versioned = counted({ now });
    await versioned.cache.range([source], ...whole(DAY1));
    expect(versioned.computed).toEqual([DAY1]);
    expect((JSON.parse(readFileSync(path, 'utf8')) as DayFigures).v).toBe(FIGURES_VERSION);
    writeFileSync(path, 'not json');
    const broken = counted({ now });
    await broken.cache.range([source], ...whole(DAY1));
    expect(broken.computed).toEqual([DAY1]);
  });

  it('a second asker that lists newer traces than a computation under way works out its own, and each keeps the figures of the traces it listed', async () => {
    const { dir, source } = folder();
    const t = D1 + 3_600_000;
    for (let i = 0; i < 4; i++) await writeFolderCall(dir, `CA_${i}`, [OPENER], 'hangup', D1 + i * 60_000);
    let second: Promise<Awaited<ReturnType<FiguresCache['range']>>> | null = null;
    let once = true;
    const cache: FiguresCache = new FiguresCache({ now: () => t, onCompute: () => {
      if (!once) return;
      once = false;
      // A fifth call lands while the first computation runs, and a second viewer asks.
      second = writeFolderCall(dir, 'CA_late', [OPENER], 'hangup', D1 + 3_000_000).then(() => cache.range([source], ...whole(DAY1)));
    } });
    const [first] = await cache.range([source], ...whole(DAY1));
    const [then] = await second!;
    expect([first!.figures.calls, then!.figures.calls]).toEqual([4, 5]);
    // Later, the same cache and a fresh one both have the five.
    expect((await new FiguresCache({ now: () => t + 120_000 }).range([source], ...whole(DAY1)))[0]!.figures.calls).toBe(5);
  });

  it('today: taken from memory for a minute while no call ends; looked at again as soon as one has ended', async () => {
    const { dir, source } = folder();
    let t = D1 + 3_600_000;
    let ends = 0;
    const { cache, computed } = counted({ now: () => t, endsSeen: () => ends });
    await writeFolderCall(dir, 'CA_1', [OPENER], 'hangup', D1);
    expect((await cache.range([source], ...whole(DAY1)))[0]!.figures.calls).toBe(1);
    await writeFolderCall(dir, 'CA_2', [OPENER], 'hangup', D1 + 60_000);
    // No call ended (as the bus counts them) and less than a minute: as it was, nothing listed.
    t += 10_000;
    expect((await cache.range([source], ...whole(DAY1)))[0]!.figures.calls).toBe(1);
    ends += 1;
    expect((await cache.range([source], ...whole(DAY1)))[0]!.figures.calls).toBe(2);
    await writeFolderCall(dir, 'CA_3', [OPENER], 'hangup', D1 + 120_000);
    t += 61_000;
    expect((await cache.range([source], ...whole(DAY1)))[0]!.figures.calls).toBe(3);
    expect(computed).toEqual([DAY1, DAY1, DAY1]);
  });

  it('one computation per app and day at a time: a second asker waits for the first', async () => {
    const { dir, source } = folder();
    for (let i = 0; i < 5; i++) await writeFolderCall(dir, `CA_${i}`, [OPENER], 'hangup', D1 + i * 1_000);
    const { cache, computed } = counted();
    const [x, y] = await Promise.all([cache.range([source], ...whole(DAY1)), cache.range([source], ...whole(DAY1))]);
    expect(computed).toEqual([DAY1]);
    expect(x![0]!.figures).toEqual(y![0]!.figures);
  });

  it('a range takes only its hours; an empty day writes nothing', async () => {
    const { dir, source } = folder();
    await writeFolderCall(dir, 'CA_1', [OPENER], 'hangup', D1);
    await writeFolderCall(dir, 'CA_2', [OPENER], 'hangup', D1 + 3 * 3_600_000);
    const [a] = await new FiguresCache().range([source], D1, D1 + 3_600_000 - 1);
    expect(a!.figures.calls).toBe(1);
    await new FiguresCache().range([source], ...whole('2026-09-25'));
    expect(existsSync(join(dir, FIGURES_DIR, '2026-09-25.json'))).toBe(false);
  });

  it("the traces' retention leaves the figures; FIGURES_RETENTION_DAYS removes them by their day", () => {
    const { dir } = folder();
    const figures = join(dir, FIGURES_DIR);
    mkdirSync(figures, { recursive: true });
    for (const d of ['2026-09-01', '2026-09-17', '2026-09-18']) writeFileSync(join(figures, `${d}.json`), '{}');
    const now = Date.parse('2026-09-26T12:00:00Z');
    sweepRetention({ traceDir: dir, auditDir: join(dir, 'audit'), traceDays: 1 }, { now, inUse: new Set() });
    expect(['2026-09-01', '2026-09-17', '2026-09-18'].map((d) => existsSync(join(figures, `${d}.json`)))).toEqual([true, true, true]);
    expect(sweepRetention({ traceDir: dir, auditDir: join(dir, 'audit'), figuresDays: 8 }, { now, inUse: new Set() })).toMatchObject({ figuresDays: 2 });
    expect(['2026-09-01', '2026-09-17', '2026-09-18'].map((d) => existsSync(join(figures, `${d}.json`)))).toEqual([false, false, true]);
  });
});

describe('a closed day is final (its traces can no longer change, every call settled)', () => {
  it('its file is its record: not listed or worked out again when its traces are trimmed, or all gone', async () => {
    const { dir, source } = folder();
    for (let i = 0; i < 4; i++) await writeFolderCall(dir, `CA_${i}`, [OPENER], 'hangup', D1 + i * 60_000);
    const now = (): number => Date.parse('2026-10-12T00:00:00Z');
    const first = counted({ now });
    expect((await first.cache.range([source], ...whole(DAY1)))[0]!.figures.calls).toBe(4);
    expect((JSON.parse(readFileSync(join(dir, FIGURES_DIR, `${DAY1}.json`), 'utf8')) as DayFigures).closed).toBe(true);
    for (const [k, gone] of [[0, ['CA_0', 'CA_1']], [1, ['CA_2', 'CA_3']]] as const) {
      for (const f of gone) { rmSync(join(dir, `${f}.jsonl`)); rmSync(join(dir, `${f}.frames.jsonl`)); }
      forgetSummaries();
      const after = counted({ now });
      expect((await after.cache.range([source], ...whole(DAY1)))[0]!.figures.calls, `step ${k}`).toBe(4);
      expect(after.computed).toEqual([]);
    }
  });

  it('a call with no end recorded is in progress until half an hour after its last word: the day is not closed, and settles once it is past', async () => {
    const { dir, source } = folder();
    const late = Date.parse('2026-09-18T23:50:00Z');
    await writeFolderCall(dir, 'CA_ok', [OPENER], 'hangup', late - 3_600_000);
    await writeFolderCall(dir, 'CA_dead', [OPENER], 'none', late);
    let t = late + 5 * 60_000;
    let [a] = await new FiguresCache({ now: () => t }).range([source], ...whole(DAY1));
    expect([a!.figures.calls, a!.figures.ended]).toEqual([2, 1]);
    const file = JSON.parse(readFileSync(join(dir, FIGURES_DIR, `${DAY1}.json`), 'utf8')) as DayFigures;
    expect(file.closed).toBe(false);
    // Half an hour after its last word, rounded up to the hour: no call's own time in the file.
    expect(file.settleBy).toBe(Date.parse('2026-09-19T01:00:00Z'));
    // A month later, after a restart: the call is taken for ended ("no end recorded", an error), and the day closed.
    t = late + 30 * 86_400_000;
    forgetSummaries();
    [a] = await new FiguresCache({ now: () => t }).range([source], ...whole(DAY1));
    expect([a!.figures.calls, a!.figures.ended, a!.figures.errors]).toEqual([2, 2, 1]);
    expect((JSON.parse(readFileSync(join(dir, FIGURES_DIR, `${DAY1}.json`), 'utf8')) as DayFigures).closed).toBe(true);
  });

  it('a file of an older version: worked out again while its traces are there; with them gone, read as older figures where it can be, else left out as unreadable', async () => {
    const { dir, source } = folder();
    mkdirSync(join(dir, FIGURES_DIR));
    const hour = String(D1);
    const v1hour = { calls: 2, ended: 2, contained: 1, toPerson: 0, hungUp: 1, errors: 0, peak: 2, lengthMs: 1000, lengths: [2, 0, 0, 0, 0, 0, 0], voice: 2, voiceMs: 1000, billedMinutes: { twilio: 2 }, costUsd: 0.01, transfers: {}, abandoned: { 'the greeting': 1 }, asked: {}, tasks: {}, screenHits: 0, refusals: {}, stepUps: 0, afterHours: 0, hours: {}, gaps: 0, gapKinds: {}, gapTopics: {} };
    writeFileSync(join(dir, FIGURES_DIR, `${DAY1}.json`), JSON.stringify({ v: 1, app: null, day: DAY1, fingerprint: '2:10:10', computedAt: 0, hours: { [hour]: v1hour } }));
    writeFileSync(join(dir, FIGURES_DIR, '2026-09-19.json'), JSON.stringify({ v: 1, app: null, day: '2026-09-19', fingerprint: '1:1:1', computedAt: 0, hours: { [hour]: { calls: 'x' } } }));
    const now = (): number => Date.parse('2026-10-12T00:00:00Z');
    const [a] = await new FiguresCache({ now }).range([source], Date.parse('2026-09-18T00:00:00Z'), Date.parse('2026-09-19T23:59:59.999Z'));
    expect(a!.figures).toMatchObject({ calls: 2, hungUp: 1, abandoned: { 'text:the greeting': 1 } });
    expect(a!.peaks).toEqual({ [hour]: 2 });
    expect(a!.older).toEqual([DAY1]);
    expect(a!.unreadable).toEqual(['2026-09-19']);
    // With fewer traces than it was worked out from (two), it is still the record, read as older figures.
    await writeFolderCall(dir, 'CA_1', [OPENER], 'hangup', D1);
    forgetSummaries();
    const fewer = counted({ now });
    const [b] = await fewer.cache.range([source], ...whole(DAY1));
    expect(fewer.computed).toEqual([]);
    expect([b!.figures.calls, b!.older]).toEqual([2, [DAY1]]);
    // With all of them there, a day of an older version is worked out again.
    await writeFolderCall(dir, 'CA_2', [OPENER], 'hangup', D1 + 60_000);
    forgetSummaries();
    const again = counted({ now });
    const [c] = await again.cache.range([source], ...whole(DAY1));
    expect(again.computed).toEqual([DAY1]);
    expect([c!.figures.calls, c!.older]).toEqual([2, []]);
  });

  it('a version-2 file (each call\'s span) is made counts by the minute as it is read, and written so: no call\'s own times are left on disk', async () => {
    const { dir, source } = folder();
    await writeFolderCall(dir, 'CA_1', [OPENER], 'hangup', D1);
    const now = (): number => Date.parse('2026-10-12T00:00:00Z');
    await new FiguresCache({ now }).range([source], ...whole(DAY1));
    const p = join(dir, FIGURES_DIR, `${DAY1}.json`);
    const v3 = JSON.parse(readFileSync(p, 'utf8')) as DayFigures & { spans?: unknown };
    expect(v3.v).toBe(FIGURES_VERSION);
    expect(v3.spans).toBeUndefined();
    const { inProgress: _runs, ...rest } = v3;
    writeFileSync(p, JSON.stringify({ ...rest, v: 2, spans: [D1, D1 + 6_000] }));
    forgetSummaries();
    const read = counted({ now });
    const [a] = await read.cache.range([source], ...whole(DAY1));
    expect(read.computed).toEqual([]);
    expect(insightsOf([a!], undefined, { from: whole(DAY1)[0], to: whole(DAY1)[1] }).totals.peak).toBe(1);
    const after = readFileSync(p, 'utf8');
    expect(JSON.parse(after)).toMatchObject({ v: FIGURES_VERSION, inProgress: [15 * 60, 1, 1] });
    // Nothing in the file is a time of day of a call: only its day, the hours' keys, and when it was worked out.
    expect(after).not.toContain(String(D1 + 6_000));
    expect(after).not.toContain('spans');
  });

  it('FIGURES_RETENTION_DAYS: a day older is neither read nor worked out, and is named as such', async () => {
    const { dir, source } = folder();
    await writeFolderCall(dir, 'CA_1', [OPENER], 'hangup', D1);
    const { cache, computed } = counted({ now: () => Date.parse('2026-10-12T00:00:00Z'), retentionDays: 7 });
    const [a] = await cache.range([source], ...whole(DAY1));
    expect(computed).toEqual([]);
    expect([a!.figures.calls, a!.expired]).toEqual([0, [DAY1]]);
    expect(existsSync(join(dir, FIGURES_DIR, `${DAY1}.json`))).toBe(false);
  });

  it('a day closes an hour after its traces can no longer change, not before', async () => {
    const { dir, source } = folder();
    await writeFolderCall(dir, 'CA_1', [OPENER], 'hangup', D1);
    const closes = Date.parse('2026-09-20T01:00:00Z');
    await new FiguresCache({ now: () => closes - 60_000 }).range([source], ...whole(DAY1));
    expect((JSON.parse(readFileSync(join(dir, FIGURES_DIR, `${DAY1}.json`), 'utf8')) as DayFigures).closed).toBe(false);
    await new FiguresCache({ now: () => closes + 1 }).range([source], ...whole(DAY1));
    expect((JSON.parse(readFileSync(join(dir, FIGURES_DIR, `${DAY1}.json`), 'utf8')) as DayFigures).closed).toBe(true);
  });

  it('a file with a value of another shape (its numbers checked as it is read) is worked out again from its traces', async () => {
    const { dir, source } = folder();
    await writeFolderCall(dir, 'CA_1', [OPENER], 'hangup', Date.parse('2026-09-18T10:00:00Z'));
    const now = (): number => Date.parse('2026-10-12T00:00:00Z');
    await new FiguresCache({ now }).range([source], ...whole(DAY1));
    const p = join(dir, FIGURES_DIR, `${DAY1}.json`);
    const f = JSON.parse(readFileSync(p, 'utf8')) as DayFigures;
    const k = Object.keys(f.hours)[0]!;
    writeFileSync(p, JSON.stringify({ ...f, hours: { [k]: { ...f.hours[k], hungUp: '<img src=x onerror=alert(1)>' } } }));
    forgetSummaries();
    const [a] = await new FiguresCache({ now }).range([source], ...whole(DAY1));
    expect(a!.figures.hungUp).toBe(1);
  });
});

describe('the trace store: an object under the day\'s folder', () => {
  it('written beside the day\'s calls, read back by another server; the traces\' retention leaves it, its own removes it', async () => {
    const keys = { accessKeyId: 'AKIDFIGURES', secretAccessKey: 'a-secret-the-fake-store-checks' };
    const s3 = await FakeS3.start({ bucket: 'call-traces', region: 'us-east-1', credentials: keys });
    try {
      const setting = traceStoreSettingOf({ TRACE_STORE: 's3://call-traces/prod/traces', S3_ENDPOINT: s3.endpoint, S3_REGION: 'us-east-1', S3_ACCESS_KEY_ID: keys.accessKeyId, S3_SECRET_ACCESS_KEY: keys.secretAccessKey, S3_FORCE_PATH_STYLE: 'on' })!;
      await writeStoreCall(setting, 'CA_s1', [OPENER], 'hangup', D1, { from: '+15555550133' });
      await writeStoreCall(setting, 'CA_s2', [OPENER, 'let me talk to a person'], 'handoff', D1 + 60_000);
      const source: CallsSource = { id: null, app: getApp(defaultAppId()), traceDir: '/nowhere', traces: new S3TraceStore(setting, { server: 'reader' }).reader() };
      const { cache, computed } = counted();
      const [a] = await cache.range([source], ...whole(DAY1));
      expect(a!.figures.calls).toBe(2);
      expect(a!.figures.toPerson).toBe(1);
      expect(computed).toEqual([DAY1]);
      // Beside the day folders, never in one: no day's listing grows with them.
      const key = `prod/traces/${FIGURES_PREFIX}${DAY1}.json`;
      expect(s3.objects.has(key)).toBe(true);
      // The figures object is not a call: the Calls page's listing never shows it.
      expect((await source.traces!.calls()).map((c) => c.id).sort()).toEqual(['CA_s1', 'CA_s2']);
      forgetSummaries();
      const other = counted();
      await other.cache.range([source], ...whole(DAY1));
      expect(other.computed).toEqual([]);
      // The traces' retention removes the day's calls and leaves its figures; FIGURES_RETENTION_DAYS removes them.
      const writer = new S3TraceStore(setting, { server: 'sweeper' });
      await writer.sweep(7, Date.parse('2026-10-12T00:00:00Z'), new Set());
      expect([...s3.objects.keys()].filter((k) => k.startsWith(`prod/traces/${DAY1}/`))).toEqual([]);
      expect(s3.objects.has(key)).toBe(true);
      await writer.trim(0, new Set());
      expect(s3.objects.has(key)).toBe(true);
      forgetSummaries();
      expect((await counted().cache.range([source], ...whole(DAY1)))[0]!.figures.calls).toBe(2);
      expect(await writer.sweepFigures(30, Date.parse('2026-10-12T00:00:00Z'))).toBe(0);
      expect(await writer.sweepFigures(7, Date.parse('2026-10-12T00:00:00Z'))).toBe(1);
      expect(s3.objects.has(key)).toBe(false);
    } finally {
      await s3.close();
    }
  });
});

describe('a quarter read without holding up a call', () => {
  it('92 closed days of a busy line: read, and said, with no synchronous stretch over 20 ms; a second read from memory too', async () => {
    const { dir, source } = folder();
    const DAY_MS = 86_400_000;
    const start = Date.parse('2026-07-01T00:00:00Z');
    await writeFolderCall(dir, 'CA_t', [OPENER], 'hangup', start + 3_600_000);
    const now = (): number => Date.parse('2026-10-12T12:00:00Z');
    await new FiguresCache({ now }).range([source], start, start + DAY_MS - 1);
    const template = JSON.parse(readFileSync(join(dir, FIGURES_DIR, '2026-07-01.json'), 'utf8')) as DayFigures;
    const hour = Object.values(template.hours)[0]!;
    for (let d = 0; d < 92; d++) {
      const day0 = start + d * DAY_MS;
      const day = new Date(day0).toISOString().slice(0, 10);
      const hours: Record<string, unknown> = {};
      for (let h = 0; h < 24; h++) hours[String(day0 + h * 3_600_000)] = { ...hour, calls: 208 };
      // Every minute a different count: the largest runs a day can have.
      const inProgress: number[] = [];
      for (let m = 0; m < 1_440; m++) inProgress.push(m, 1, 1 + ((m * 7) % 40));
      writeFileSync(join(dir, FIGURES_DIR, `${day}.json`), JSON.stringify({ ...template, day, fingerprint: '5000:0123456789abcdef', closed: true, settleBy: null, hours, inProgress }));
    }
    const cache = new FiguresCache({ now });
    const from = start;
    const to = start + 92 * DAY_MS - 1;
    /** The longest the event loop went without a turn while `work` ran, by a timer that asks every 2 ms. */
    const longest = async (work: () => Promise<unknown>): Promise<number> => {
      let last = performance.now();
      let worst = 0;
      const probe = setInterval(() => { const t = performance.now(); worst = Math.max(worst, t - last); last = t; }, 2);
      await work();
      clearInterval(probe);
      return Math.max(worst, performance.now() - last);
    };
    let apps: Awaited<ReturnType<FiguresCache['range']>> = [];
    const first = await longest(async () => { apps = await cache.range([source], from, to); });
    expect(apps[0]!.figures.calls).toBe(92 * 24 * 208);
    // The fastest of three runs: a stretch the code itself holds the loop for shows in every run, where a
    // busy machine's pause (a CI runner's neighbour, a collection) shows in one. The first read is timed
    // once, as it is the only cold one.
    const fastest = async (work: () => Promise<unknown>): Promise<number> => Math.min(await longest(work), await longest(work), await longest(work));
    const said = await fastest(async () => { insightsOf(apps, undefined, { from, to }); });
    const again = await fastest(async () => { apps = await cache.range([source], from, to); insightsOf(apps, undefined, { from, to }); });
    expect(insightsOf(apps, undefined, { from, to }).totals.peak).toBe(40);
    // 20 ms on a developer's machine (about 6 ms measured); a CI runner running the whole suite at once is four to five
    // times slower, so it is held to 60 ms there, and a real regression is still caught by the local run before a commit.
    const budget = process.env.CI ? 60 : 20;
    expect({ first: first < budget, said: said < budget, again: again < budget }).toEqual({ first: true, said: true, again: true });
  });
});
