import { afterEach, describe, expect, it } from 'vitest';
import { buildTraceRecord, traceLine } from './writer';
import { newSession } from '../core/session';
import { resolve } from '../core/turn';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { startEvent } from '../channel/events';
import { demoTools } from '../core/tools';
import { VOICE_RELAY } from '../channel/caps';
import { useTestkit } from '../testing/apps';
import { FakeS3 } from '../testing/fakeS3';
import { parseSegmentName, S3TraceStore, segmentName, splitCallAddress, traceReaderOf, traceStoreSettingOf, type CallMeta, type S3TraceSetting } from './store';
import type { TraceRecord } from './types';
import { frameLine } from '../server/frameLog';

useTestkit();

const KEYS = { accessKeyId: 'AKIDTRACESTORE', secretAccessKey: 'a-secret-the-fake-store-checks' };
const fakes: FakeS3[] = [];
afterEach(async () => {
  for (const f of fakes.splice(0)) await f.close();
});

async function fake(): Promise<{ s3: FakeS3; setting: S3TraceSetting; env: Record<string, string> }> {
  const s3 = await FakeS3.start({ bucket: 'call-traces', region: 'us-east-1', credentials: KEYS });
  fakes.push(s3);
  const env = { TRACE_STORE: 's3://call-traces/prod/traces', S3_ENDPOINT: s3.endpoint, S3_REGION: 'us-east-1', S3_ACCESS_KEY_ID: KEYS.accessKeyId, S3_SECRET_ACCESS_KEY: KEYS.secretAccessKey, S3_FORCE_PATH_STYLE: 'on' };
  return { s3, setting: traceStoreSettingOf(env)!, env };
}

/** A start turn's record for `sessionId`, with its turn index and time set. */
function record(sessionId: string, turnIndex: number, ts: string): TraceRecord {
  const event = startEvent();
  const result = resolve(newSession(sessionId, 0, VOICE_RELAY), event, null, { nowMs: 0, todayIso: '2026-09-18', thresholds: { ...DEFAULT_THRESHOLDS }, tools: demoTools() });
  const r = buildTraceRecord({ result, event, questions: null, response: null, error: null, timing: { planMs: 0, askMs: 0, resolveMs: 1, totalMs: 1 }, ts, pricePerMtok: 0.042 });
  return { ...r, turnIndex };
}

const settle = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('TRACE_STORE: the setting', () => {
  it('reads the bucket, the prefix and the keys, and says the store without a key', () => {
    const s = traceStoreSettingOf({ TRACE_STORE: 's3://call-traces/prod/traces/', S3_ACCESS_KEY_ID: 'id', S3_SECRET_ACCESS_KEY: 'sec', S3_REGION: 'auto', S3_ENDPOINT: 'https://acct.r2.example.com' })!;
    expect(s).toEqual({ kind: 's3', bucket: 'call-traces', prefix: 'prod/traces/', region: 'auto', credentials: { accessKeyId: 'id', secretAccessKey: 'sec' }, forcePathStyle: false, endpoint: 'https://acct.r2.example.com' });
    expect(traceStoreSettingOf({ TRACE_STORE: 's3://call-traces', S3_ACCESS_KEY_ID: 'id', S3_SECRET_ACCESS_KEY: 'sec' })!.prefix).toBe('');
    expect(traceStoreSettingOf({})).toBeNull();
  });

  it('refuses what it cannot use, naming the variable, never a key', () => {
    const keys = { S3_ACCESS_KEY_ID: 'id', S3_SECRET_ACCESS_KEY: 'very-secret' };
    expect(() => traceStoreSettingOf({ TRACE_STORE: 'gs://b/p', ...keys })).toThrow('TRACE_STORE must be s3://<bucket>/<prefix>');
    expect(() => traceStoreSettingOf({ TRACE_STORE: 's3://B_ad/p', ...keys })).toThrow("TRACE_STORE's bucket");
    expect(() => traceStoreSettingOf({ TRACE_STORE: 's3://bucket/../up', ...keys })).toThrow("TRACE_STORE's prefix");
    expect(() => traceStoreSettingOf({ TRACE_STORE: 's3://bucket/p', S3_ACCESS_KEY_ID: 'id' })).toThrow('needs S3_SECRET_ACCESS_KEY');
    expect(() => traceStoreSettingOf({ TRACE_STORE: 's3://bucket/p', S3_SECRET_ACCESS_KEY: 'x' })).toThrow('needs S3_ACCESS_KEY_ID');
    expect(() => traceStoreSettingOf({ TRACE_STORE: 's3://bucket/p', ...keys, S3_ENDPOINT: 'ftp://x' })).toThrow('S3_ENDPOINT');
    expect(() => traceStoreSettingOf({ TRACE_STORE: 's3://bucket/p', ...keys, S3_ENDPOINT: 'https://u:very-secret@x' })).toThrow('S3_ENDPOINT');
    try {
      traceStoreSettingOf({ TRACE_STORE: 's3://bucket/p', ...keys, S3_ENDPOINT: 'https://u:very-secret@x' });
    } catch (e) {
      expect((e as Error).message).not.toContain('very-secret');
    }
    expect(() => traceStoreSettingOf({ TRACE_STORE: 's3://bucket/p', ...keys, S3_FORCE_PATH_STYLE: 'yes' })).toThrow('S3_FORCE_PATH_STYLE must be on or off');
  });

  it('names a segment so that name order is write order, and reads it back', () => {
    const name = segmentName({ first: 3, last: 4, gen: 1, ms: 1_760_000_000_000, server: 'web-1-ab12cd34', n: 7, kind: 'trace' });
    expect(name).toBe('000003-000004-0001-1760000000000-web-1-ab12cd34-000007.trace.jsonl');
    expect(parseSegmentName(name)).toEqual({ first: 3, last: 4, gen: 1, ms: 1_760_000_000_000, server: 'web-1-ab12cd34', n: 7, kind: 'trace' });
    expect(parseSegmentName('notes.txt')).toBeNull();
    expect(splitCallAddress('s3://call-traces/prod/traces/CA123')).toEqual({ store: 's3://call-traces/prod/traces', call: 'CA123' });
    expect(splitCallAddress('s3://call-traces/CA123')).toEqual({ store: 's3://call-traces', call: 'CA123' });
  });
});

/** A call as a server sees it: its turn, its reconnect count, when it started, whether this server still holds it. */
function call(turn: number, gen = 0, held = true, startedAtMs = Date.parse('2026-10-11T11:59:00Z')): CallMeta {
  return { turn, gen, startedAtMs, held };
}

describe('TRACE_STORE: segments written by two servers, read back as one trace', () => {
  it('orders a takeover by the turn and the reconnect, never the clocks; a record written after its server let the call go is kept, marked, and not counted', async () => {
    const { s3, setting, env } = await fake();
    // A's clock is a minute ahead of B's.
    const a = new S3TraceStore(setting, { server: 'a-11111111', now: () => Date.parse('2026-10-11T12:01:00Z') });
    const b = new S3TraceStore(setting, { server: 'b-22222222', now: () => Date.parse('2026-10-11T12:00:10Z') });
    let onAsMeta = call(1);
    const onA = a.open('CA1', () => onAsMeta);
    onA.frames.write('in', { type: 'setup' });
    onA.trace.write(record('CA1', 1, '2026-10-11T12:01:00.000Z'));
    onAsMeta = call(2);
    onA.trace.write(record('CA1', 2, '2026-10-11T12:01:01.000Z'));
    onA.frames.write('out', { type: 'text', token: 'A-last-reply' });
    onA.frames.write('in', { type: 'closed-on-A' });
    await a.flush();
    // The carrier reconnects (counted: reconnect 1), and B takes the call at turn 2.
    const onB = b.open('CA1', () => call(2, 1));
    onB.frames.write('in', { type: 'setup-on-B' });
    onB.trace.write(record('CA1', 3, '2026-10-11T12:00:11.000Z'));
    await b.flush();
    // A turn that outlived A's hold writes turn 3 too.
    onAsMeta = call(3, 0, false);
    onA.trace.write(record('CA1', 3, '2026-10-11T12:01:02.000Z'));
    await a.flush();
    expect([...s3.objects.keys()].every((k) => k.startsWith('prod/traces/2026-10-11/CA1/'))).toBe(true);

    const reader = traceReaderOf('s3://call-traces/prod/traces', env)!;
    const joined = (await reader.read('CA1'))!;
    expect(joined.frames.map((l) => (JSON.parse(l) as { msg: { type: string } }).msg.type)).toEqual(['setup', 'text', 'closed-on-A', 'setup-on-B']);
    const records = joined.trace.map((l) => JSON.parse(l) as TraceRecord);
    expect(records.map((r) => [r.turnIndex, r.outlivedHold ?? false])).toEqual([[1, false], [2, false], [3, true], [3, false]]);
    // A record's line is the trace file's line, byte for byte (but for the mark on a late one).
    expect(joined.trace[0]).toBe(traceLine(record('CA1', 1, '2026-10-11T12:01:00.000Z')));
    expect(joined.frames[0]).toBe(frameLine(Date.parse('2026-10-11T12:01:00Z'), 'in', { type: 'setup' }));
    expect((await reader.frameLog('CA1'))!.map((l) => l.line)).toEqual([1, 2, 3, 4]);
    // The turns counted: 1 to 3, the late record not among them.
    expect(await reader.calls()).toEqual([expect.objectContaining({ id: 'CA1', day: '2026-10-11', startedAt: '2026-10-11T12:01:00.000Z', turns: 3 })]);
    expect(await reader.read('CA-none')).toBeNull();
  });

  it('frames alone go out within a second; a record takes them at once', async () => {
    const { s3, setting } = await fake();
    const store = new S3TraceStore(setting, { server: 'a-1' });
    const c = store.open('CA2', () => call(0));
    c.frames.write('in', { type: 'setup' });
    await settle();
    expect(s3.objects.size).toBe(0);
    await settle(1_100);
    expect([...s3.objects.keys()].map((k) => k.split('.').at(-2))).toEqual(['frames']);
    c.trace.write(record('CA2', 1, '2026-10-11T12:00:00.000Z'));
    await store.flush();
    expect(s3.objects.size).toBe(2);
  });

  it('a store that fails: the call goes on, the failure is logged once and counted, and the lines are written in order once it answers', async () => {
    const { s3, setting, env } = await fake();
    const logs: string[] = [];
    const store = new S3TraceStore(setting, { server: 'a-1', log: (l) => logs.push(l) });
    const c = store.open('CA3', () => call(1));
    s3.fail(1);
    // Never throws to the turn that wrote it.
    expect(() => c.trace.write(record('CA3', 1, '2026-10-11T12:00:00.000Z'))).not.toThrow();
    await settle();
    expect(store.failures).toBe(1);
    expect(logs).toEqual(['traces: a segment of CA3 could not be written to s3://call-traces/prod/traces/ at 127.0.0.1:' + s3.port + ' (us-east-1): S3 put ' + [...s3.requests][0]!.key + ': 500 InternalError; kept to try again']);
    expect(logs.join('\n')).not.toContain(KEYS.secretAccessKey);
    expect(logs.join('\n')).not.toContain(KEYS.accessKeyId);
    c.trace.write(record('CA3', 2, '2026-10-11T12:00:01.000Z'));
    await store.flush();
    const joined = (await traceReaderOf('s3://call-traces/prod/traces', env)!.read('CA3'))!;
    expect(joined.trace.map((l) => (JSON.parse(l) as TraceRecord).turnIndex)).toEqual([1, 2]);
  });

  it('a segment the store took but whose answer was lost is tried again under the same name: written once', async () => {
    const { s3, setting, env } = await fake();
    let first = true;
    const flaky: typeof fetch = async (url, init) => {
      const res = await fetch(url, init);
      if (first && init?.method === 'PUT') {
        first = false;
        throw new Error('socket hang up');
      }
      return res;
    };
    const store = new S3TraceStore({ ...setting }, { server: 'a-1', fetch: flaky });
    const c = store.open('CA1', () => call(1));
    c.trace.write(record('CA1', 1, '2026-10-11T12:00:00.000Z'));
    await settle();
    // Written while the first is being tried again: a batch of its own, never merged into the first.
    c.trace.write(record('CA1', 2, '2026-10-11T12:00:01.000Z'));
    await store.flush(10_000);
    expect(s3.objects.size).toBe(2);
    const joined = (await traceReaderOf('s3://call-traces/prod/traces', env)!.read('CA1'))!;
    expect(joined.trace.map((l) => (JSON.parse(l) as TraceRecord).turnIndex)).toEqual([1, 2]);
  });

  it('retention removes whole day folders older than the days, never a call in use; a size bound removes the calls written least recently', async () => {
    const { s3, setting } = await fake();
    const day = 86_400_000;
    const t0 = Date.parse('2026-10-01T00:00:00Z');
    s3.now = () => t0;
    const store = new S3TraceStore(setting, { server: 'a-1' });
    store.open('OLD', () => call(1, 0, true, t0)).trace.write(record('OLD', 1, '2026-10-01T00:00:00.000Z'));
    store.open('KEPT', () => call(1, 0, true, t0)).trace.write(record('KEPT', 1, '2026-10-01T00:00:00.000Z'));
    await store.flush();
    s3.now = () => t0 + 9 * day;
    store.open('NEW', () => call(1, 0, true, t0 + 9 * day)).trace.write(record('NEW', 1, '2026-10-10T00:00:00.000Z'));
    await store.flush();
    const before = s3.requests.length;
    expect(await store.sweep(7, t0 + 10 * day, new Set(['KEPT']))).toEqual({ objects: 1, calls: 1 });
    // Only the days past the bound were listed (the day folders, then 2026-10-01's).
    expect(s3.requests.slice(before).filter((r) => r.method === 'GET').length).toBe(2);
    expect([...s3.objects.keys()].map((k) => k.split('/').slice(2, 4).join('/')).sort()).toEqual(['2026-10-01/KEPT', '2026-10-10/NEW']);
    // Past a size: KEPT (written least recently) goes first, NEW stays.
    const one = [...s3.objects.values()][0]!.body.length;
    expect(await store.trim(one + 10, new Set())).toEqual({ objects: 1, calls: 1, bytes: expect.any(Number) });
    expect([...s3.objects.keys()].map((k) => k.split('/')[3])).toEqual(['NEW']);
  });

  it("the console's list reads the newest days only, as far as it needs", async () => {
    const { s3, setting, env } = await fake();
    const store = new S3TraceStore(setting, { server: 'a-1' });
    for (const d of ['2026-10-09', '2026-10-10', '2026-10-11']) {
      store.open(`CA-${d}`, () => call(1, 0, true, Date.parse(`${d}T09:00:00Z`))).trace.write(record(`CA-${d}`, 1, `${d}T09:00:00.000Z`));
    }
    await store.flush();
    const reader = traceReaderOf('s3://call-traces/prod/traces', env)!;
    const before = s3.requests.length;
    expect((await reader.calls({ limit: 1 })).map((c) => c.id)).toEqual(['CA-2026-10-11']);
    expect(s3.requests.length - before).toBe(2);
    expect((await reader.calls()).map((c) => c.id).sort()).toEqual(['CA-2026-10-09', 'CA-2026-10-10', 'CA-2026-10-11']);
  });
});
