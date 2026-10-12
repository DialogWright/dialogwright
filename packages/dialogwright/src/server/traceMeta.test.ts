import { afterEach, describe, expect, it } from 'vitest';
import { FakeS3 } from '../testing/fakeS3';
import { S3TraceStore, traceReaderOf, traceStoreSettingOf } from '../trace/store';
import { chatTraceMeta, type ChatSeen } from './traceMeta';
import type { TraceRecord } from '../trace/types';

/**
 * The reviewer's probe-chatend shape, on one server with TRACE_STORE on the fake store: a chat's turns
 * written out, then the chat leaves the server's sessions and a line is written alone in a segment of
 * its own (its `ended`, or its `resumedElsewhere` when another server took it). That line carries the
 * chat's last turn, so the joined frame log ends with it, never begins with it.
 */

const KEYS = { accessKeyId: 'AKIDCHATEND', secretAccessKey: 'a-secret-only-the-fake-store-knows' };
const fakes: FakeS3[] = [];
afterEach(async () => {
  for (const f of fakes.splice(0)) await f.close();
});

async function chatOnStore(): Promise<{ store: S3TraceStore; env: Record<string, string>; sessions: Map<string, ChatSeen>; entry: ChatSeen; sinks: ReturnType<S3TraceStore['open']> }> {
  const s3 = await FakeS3.start({ bucket: 'call-traces', region: 'us-east-1', credentials: KEYS });
  fakes.push(s3);
  const env = { TRACE_STORE: 's3://call-traces/p', S3_ENDPOINT: s3.endpoint, S3_ACCESS_KEY_ID: KEYS.accessKeyId, S3_SECRET_ACCESS_KEY: KEYS.secretAccessKey, S3_FORCE_PATH_STYLE: 'on' };
  const store = new S3TraceStore(traceStoreSettingOf(env)!, { server: 'a-1' });
  const sessions = new Map<string, ChatSeen>();
  const names = chatTraceMeta('CH1', sessions, Date.now);
  const sinks = store.open('CH1', names.meta);
  names.bind(sinks.frames);
  const entry: ChatSeen = { session: { turnIndex: 0, startedAtMs: Date.parse('2026-10-11T12:00:00Z') } as ChatSeen['session'], frames: sinks.frames };
  sessions.set('CH1', entry);
  // Three turns, each written out before the next.
  for (let t = 1; t <= 3; t++) {
    sinks.frames.write('in', { type: `user-${t}` });
    sinks.trace.write({ v: 2, ts: '2026-10-11T12:00:01.000Z', sessionId: 'CH1', turnIndex: t } as unknown as TraceRecord);
    entry.session.turnIndex = t;
    await store.flush();
  }
  return { store, env, sessions, entry, sinks };
}

const msgs = (lines: string[]): unknown[] => lines.map((l) => (JSON.parse(l) as { msg: unknown }).msg);

describe("a chat's last lines, written alone after it left the server's sessions", () => {
  it('its end: the joined frame log ends with it', async () => {
    const { store, env, sessions, sinks } = await chatOnStore();
    sessions.delete('CH1');
    sinks.frames.write('log', { ended: 'idle' });
    await store.flush();
    const joined = (await traceReaderOf('s3://call-traces/p', env)!.read('CH1'))!;
    expect(msgs(joined.frames)).toEqual([{ type: 'user-1' }, { type: 'user-2' }, { type: 'user-3' }, { ended: 'idle' }]);
  });

  it('its let-go to another server: the joined frame log ends with it, and a turn it still writes is late', async () => {
    const { store, env, sessions, entry, sinks } = await chatOnStore();
    entry.movedAway = true;
    sessions.delete('CH1');
    sinks.frames.write('log', { resumedElsewhere: true });
    await store.flush();
    sinks.trace.write({ v: 2, ts: '2026-10-11T12:00:02.000Z', sessionId: 'CH1', turnIndex: 4 } as unknown as TraceRecord);
    await store.flush();
    const joined = (await traceReaderOf('s3://call-traces/p', env)!.read('CH1'))!;
    expect(msgs(joined.frames).at(-1)).toEqual({ resumedElsewhere: true });
    expect(joined.trace.map((l) => (JSON.parse(l) as TraceRecord).outlivedHold ?? false)).toEqual([false, false, false, true]);
  });
});
