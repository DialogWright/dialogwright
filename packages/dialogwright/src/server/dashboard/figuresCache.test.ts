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
import { daysBetween, FiguresCache, FIGURES_DIR, FIGURES_OBJECT, type DayFigures } from './figuresCache';
import { FIGURES_VERSION } from './figures';
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
function counted(o: { now?: () => number; endsSeen?: () => number } = {}): { cache: FiguresCache; computed: string[] } {
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
    expect(file.fingerprint).toMatch(/^3:\d+:\d+$/);
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

  it('worked out again when the traces changed (a call added), and when the file is of another version', async () => {
    const { dir, source } = folder();
    await writeFolderCall(dir, 'CA_1', [OPENER], 'hangup', D1);
    await new FiguresCache().range([source], ...whole(DAY1));
    await writeFolderCall(dir, 'CA_2', [OPENER], 'hangup', D1 + 120_000);
    const changed = counted();
    const [a] = await changed.cache.range([source], ...whole(DAY1));
    expect(changed.computed).toEqual([DAY1]);
    expect(a!.figures.calls).toBe(2);
    const path = join(dir, FIGURES_DIR, `${DAY1}.json`);
    const file = JSON.parse(readFileSync(path, 'utf8')) as DayFigures;
    writeFileSync(path, JSON.stringify({ ...file, v: FIGURES_VERSION + 1 }));
    const versioned = counted();
    await versioned.cache.range([source], ...whole(DAY1));
    expect(versioned.computed).toEqual([DAY1]);
    expect((JSON.parse(readFileSync(path, 'utf8')) as DayFigures).v).toBe(FIGURES_VERSION);
    writeFileSync(path, 'not json');
    const broken = counted();
    await broken.cache.range([source], ...whole(DAY1));
    expect(broken.computed).toEqual([DAY1]);
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

  it('retention removes a day\'s figures with its traces', () => {
    const { dir } = folder();
    const figures = join(dir, FIGURES_DIR);
    rmSync(figures, { recursive: true, force: true });
    for (const d of ['2026-09-01', '2026-09-17', '2026-09-18']) {
      mkdirSync(figures, { recursive: true });
      writeFileSync(join(figures, `${d}.json`), '{}');
    }
    sweepRetention({ traceDir: dir, auditDir: join(dir, 'audit'), traceDays: 7 }, { now: Date.parse('2026-09-26T12:00:00Z'), inUse: new Set() });
    expect(['2026-09-01', '2026-09-17', '2026-09-18'].map((d) => existsSync(join(figures, `${d}.json`)))).toEqual([false, false, true]);
  });
});

describe('the trace store: an object under the day\'s folder', () => {
  it('written beside the day\'s calls, read back by another server, and swept with the day', async () => {
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
      const key = `prod/traces/${DAY1}/${FIGURES_OBJECT}`;
      expect(s3.objects.has(key)).toBe(true);
      // The figures object is not a call: the Calls page's listing never shows it.
      expect((await source.traces!.calls()).map((c) => c.id).sort()).toEqual(['CA_s1', 'CA_s2']);
      forgetSummaries();
      const other = counted();
      await other.cache.range([source], ...whole(DAY1));
      expect(other.computed).toEqual([]);
      const writer = new S3TraceStore(setting, { server: 'sweeper' });
      await writer.sweep(7, Date.parse('2026-10-12T00:00:00Z'), new Set());
      expect(s3.objects.has(key)).toBe(false);
    } finally {
      await s3.close();
    }
  });
});
