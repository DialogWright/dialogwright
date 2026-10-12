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
import { parseSegmentName, S3TraceStore, segmentName, splitCallAddress, traceReaderOf, traceStoreSettingOf, type S3TraceSetting } from './store';
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
    const name = segmentName({ first: 3, last: 4, ms: 1_760_000_000_000, server: 'web-1-ab12cd34', n: 7, kind: 'trace' });
    expect(name).toBe('000003-000004-1760000000000-web-1-ab12cd34-000007.trace.jsonl');
    expect(parseSegmentName(name)).toEqual({ first: 3, last: 4, ms: 1_760_000_000_000, server: 'web-1-ab12cd34', n: 7, kind: 'trace' });
    expect(parseSegmentName('notes.txt')).toBeNull();
    expect(splitCallAddress('s3://call-traces/prod/traces/CA123')).toEqual({ store: 's3://call-traces/prod/traces', call: 'CA123' });
    expect(splitCallAddress('s3://call-traces/CA123')).toEqual({ store: 's3://call-traces', call: 'CA123' });
  });
});

describe('TRACE_STORE: segments written by two servers, read back as one trace', () => {
  it('each server writes its own segments; the reader joins them in turn order, whatever the clocks say', async () => {
    const { s3, setting, env } = await fake();
    let turn = 0;
    // B's clock is a minute behind A's: its segments still read after A's, by the turn they carry.
    const a = new S3TraceStore(setting, { server: 'a-11111111', now: () => Date.parse('2026-10-11T12:01:00Z') });
    const b = new S3TraceStore(setting, { server: 'b-22222222', now: () => Date.parse('2026-10-11T12:00:00Z') });
    const onA = a.open('CA1', () => turn);
    onA.frames.write('in', { type: 'setup' });
    onA.trace.write(record('CA1', 1, '2026-10-11T12:01:00.000Z'));
    turn = 1;
    onA.frames.write('out', { type: 'text', token: 'Hi' });
    onA.trace.write(record('CA1', 2, '2026-10-11T12:01:01.000Z'));
    await a.flush();
    const onB = b.open('CA1', () => turn);
    turn = 2;
    onB.frames.write('in', { type: 'setup', again: true });
    onB.trace.write(record('CA1', 3, '2026-10-11T12:00:30.000Z'));
    await b.flush();
    expect([...s3.objects.keys()].every((k) => k.startsWith('prod/traces/CA1/'))).toBe(true);

    const reader = traceReaderOf('s3://call-traces/prod/traces', env)!;
    const joined = (await reader.read('CA1'))!;
    expect(joined.trace.map((l) => (JSON.parse(l) as TraceRecord).turnIndex)).toEqual([1, 2, 3]);
    // A record's line is the trace file's line, byte for byte.
    expect(joined.trace[0]).toBe(traceLine(record('CA1', 1, '2026-10-11T12:01:00.000Z')));
    expect(joined.frames.map((l) => (JSON.parse(l) as { msg: { type: string } }).msg.type)).toEqual(['setup', 'text', 'setup']);
    expect(joined.frames[0]).toBe(frameLine(Date.parse('2026-10-11T12:01:00Z'), 'in', { type: 'setup' }));
    expect((await reader.frameLog('CA1'))!.map((l) => l.line)).toEqual([1, 2, 3]);
    const listed = await reader.calls();
    expect(listed).toEqual([expect.objectContaining({ id: 'CA1', startedAt: '2026-10-11T12:01:00.000Z', turns: 3 })]);
    expect(await reader.read('CA-none')).toBeNull();
  });

  it('frames alone go out within a second; a record takes them at once', async () => {
    const { s3, setting } = await fake();
    const store = new S3TraceStore(setting, { server: 'a-1' });
    const call = store.open('CA2', () => 0);
    call.frames.write('in', { type: 'setup' });
    await settle();
    expect(s3.objects.size).toBe(0);
    await settle(1_100);
    expect([...s3.objects.keys()].map((k) => k.split('.').at(-2))).toEqual(['frames']);
    call.trace.write(record('CA2', 1, '2026-10-11T12:00:00.000Z'));
    await store.flush();
    expect(s3.objects.size).toBe(2);
  });

  it('a store that fails: the call goes on, the failure is logged once and counted, and the lines are written in order once it answers', async () => {
    const { s3, setting, env } = await fake();
    const logs: string[] = [];
    const store = new S3TraceStore(setting, { server: 'a-1', log: (l) => logs.push(l) });
    const call = store.open('CA3', () => 0);
    s3.fail(1);
    // Never throws to the turn that wrote it.
    expect(() => call.trace.write(record('CA3', 1, '2026-10-11T12:00:00.000Z'))).not.toThrow();
    await settle();
    expect(store.failures).toBe(1);
    expect(logs).toEqual(['traces: a segment of CA3 could not be written to s3://call-traces/prod/traces/ at 127.0.0.1:' + s3.port + ' (us-east-1): S3 put prod/traces/CA3/' + [...s3.requests][0]!.key.split('/').at(-1) + ': 500 InternalError; kept to try again']);
    expect(logs.join('\n')).not.toContain(KEYS.secretAccessKey);
    expect(logs.join('\n')).not.toContain(KEYS.accessKeyId);
    call.trace.write(record('CA3', 2, '2026-10-11T12:00:01.000Z'));
    await store.flush();
    const joined = (await traceReaderOf('s3://call-traces/prod/traces', env)!.read('CA3'))!;
    expect(joined.trace.map((l) => (JSON.parse(l) as TraceRecord).turnIndex)).toEqual([1, 2]);
  });

  it('retention removes a call whose newest segment is older than the days, whole, and never one in use', async () => {
    const { s3, setting } = await fake();
    const day = 86_400_000;
    const t0 = Date.parse('2026-10-01T00:00:00Z');
    s3.now = () => t0;
    const store = new S3TraceStore(setting, { server: 'a-1' });
    store.open('OLD', () => 0).trace.write(record('OLD', 1, '2026-10-01T00:00:00.000Z'));
    store.open('KEPT', () => 0).trace.write(record('KEPT', 1, '2026-10-01T00:00:00.000Z'));
    await store.flush();
    s3.now = () => t0 + 9 * day;
    store.open('NEW', () => 0).trace.write(record('NEW', 1, '2026-10-10T00:00:00.000Z'));
    await store.flush();
    expect(await store.sweep(7, t0 + 10 * day, new Set(['KEPT']))).toEqual({ objects: 1, calls: 1 });
    expect([...s3.objects.keys()].map((k) => k.split('/')[2]).sort()).toEqual(['KEPT', 'NEW']);
  });
});
