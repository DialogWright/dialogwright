import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore, type SocketLike } from './sessions';
import { newSession, SESSION_SCHEMA } from '../core/session';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { TraceWriter } from '../trace/writer';
import { FrameLog } from './frameLog';
import { VOICE_RELAY } from '../channel/caps';
import { useTestkit } from '../testing/apps';
import { MemoryCallStateStore } from './stores/memory';
import type { AuditEntry } from '../audit/types';

/**
 * A call saved after every turn and loaded again by a server that does not hold it (SessionStore with
 * a CallStateStore): what is saved, when it is forgotten, and what is not resumed.
 */

useTestkit();

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sock = (): SocketLike => ({ send: (_d, cb) => cb?.(), close: () => {} });

function store(state: MemoryCallStateStore | null, now: () => number, ttl = 60_000, maxAge = 7_200_000) {
  const dir = mkdtempSync(join(tmpdir(), 'restore-'));
  dirs.push(dir);
  const logs: string[] = [];
  const s = new SessionStore((callSid) => ({
    session: newSession(callSid, now(), VOICE_RELAY),
    opts: { client: new HeuristicStubClient(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18', now },
    trace: new TraceWriter(join(dir, `${callSid}.jsonl`)),
    frames: new FrameLog(join(dir, `${callSid}.frames.jsonl`), now),
  }), ttl, now, maxAge, { state, log: (l) => logs.push(l) });
  return { s, logs };
}

const entry = (callId: string, seq: number): AuditEntry => ({ type: 'gate', detail: {}, seq, at: '2026-09-18T12:00:00.000Z', callId, channel: 'voice', prevHash: '0'.repeat(64), hash: 'b'.repeat(64) });

describe('a SessionStore with a call store', () => {
  it('saves a call with its carrier, schema, session, counters and audit entries', async () => {
    const state = new MemoryCallStateStore();
    const { s } = store(state, () => 5_000);
    const e = s.create('CA1', sock(), 'telnyx');
    e.session = { ...e.session, turnIndex: 4, lastPromptText: 'What is the account number?' };
    e.reconnects = 1;
    e.auditEntries.push(entry('CA1', 1));
    await s.persist('CA1');
    expect(state.load('CA1')).toEqual({
      callId: 'CA1', provider: 'telnyx', schema: SESSION_SCHEMA, session: JSON.parse(JSON.stringify(e.session)), reconnects: 1,
      createdAtMs: 5_000, lastActivityMs: 5_000, auditTail: [entry('CA1', 1)],
    });
    expect(s.durable).toBe(true);
  });

  it('forgets a call that ends, and one the sweep evicts', async () => {
    const state = new MemoryCallStateStore();
    let now = 0;
    const { s } = store(state, () => now, 1_000);
    s.create('CA1', sock());
    s.create('CA2', sock());
    await s.persist('CA1');
    await s.persist('CA2');
    s.end('CA1');
    now = 5_000;
    s.evictIdle();
    await s.settled();
    expect(state.list()).toEqual([]);
  });

  it('loads a call it does not hold, as it was saved, with no socket, and says once that it was restored', async () => {
    const state = new MemoryCallStateStore();
    const first = store(state, () => 1_000).s;
    const e = first.create('CA1', sock(), 'twilio');
    e.session = { ...e.session, turnIndex: 3, form: 'report' as never };
    e.reconnects = 1;
    e.auditEntries.push(entry('CA1', 1), entry('CA1', 2));
    await first.persist('CA1');
    const { s, logs } = store(state, () => 2_000);
    expect(await s.restore('CA1', 'twilio')).toBe('restored');
    const back = s.get('CA1')!;
    expect(back).toMatchObject({ callSid: 'CA1', provider: 'twilio', socket: null, reconnects: 1, createdAtMs: 1_000, lastActivityMs: 2_000, ended: false, endedAtMs: null, inFlight: 0 });
    expect(back.session).toEqual(JSON.parse(JSON.stringify(e.session)));
    expect(back.auditEntries).toEqual([entry('CA1', 1), entry('CA1', 2)]);
    expect(s.takeRestored('CA1')).toBe(true);
    expect(s.takeRestored('CA1')).toBe(false);
    expect(await s.restore('CA1', 'twilio')).toBe('held');
    expect(logs).toEqual(['CA1: restored from the session store (turn 3, reconnect 1)']);
  });

  it('finds nothing without a call store, and with one for a call never saved', async () => {
    expect(await store(null, () => 0).s.restore('CA1', 'twilio')).toBe('none');
    expect(store(null, () => 0).s.durable).toBe(false);
    expect(await store(new MemoryCallStateStore(), () => 0).s.restore('CA1', 'twilio')).toBe('none');
  });

  it('does not resume a call saved under another session schema, forgets it, and says why', async () => {
    const state = new MemoryCallStateStore();
    const first = store(state, () => 0).s;
    first.create('CA1', sock());
    await first.persist('CA1');
    state.save({ ...state.load('CA1')!, schema: SESSION_SCHEMA + 1 });
    const { s, logs } = store(state, () => 0);
    expect(await s.restore('CA1', 'twilio')).toBe('unreadable');
    expect(s.get('CA1')).toBeUndefined();
    expect(state.load('CA1')).toBeNull();
    expect(logs).toEqual([`CA1: not resumed: saved under session schema ${SESSION_SCHEMA + 1}, and this server reads ${SESSION_SCHEMA}`]);
  });

  it("does not resume a call from another carrier's callback, and keeps it for its own", async () => {
    const state = new MemoryCallStateStore();
    const first = store(state, () => 0).s;
    first.create('CA1', sock(), 'twilio');
    await first.persist('CA1');
    const { s, logs } = store(state, () => 0);
    expect(await s.restore('CA1', 'telnyx')).toBe('none');
    expect(state.load('CA1')).not.toBeNull();
    expect(logs).toEqual(['CA1: not resumed: saved for twilio, and the callback is from telnyx']);
  });

  it('does not resume a call idle past its time, or older than the cap, and forgets it', async () => {
    const state = new MemoryCallStateStore();
    const first = store(state, () => 0).s;
    first.create('CA1', sock());
    first.create('CA2', sock());
    await first.persist('CA1');
    await first.persist('CA2');
    expect(await store(state, () => 60_000, 60_000).s.restore('CA1', 'twilio')).toBe('none');
    expect(await store(state, () => 10_000, 60_000, 10_000).s.restore('CA2', 'twilio')).toBe('none');
    expect(state.list()).toEqual([]);
  });

  it('sweeps the calls saved before a restart that never called back, once they are past their time, and names them', async () => {
    const state = new MemoryCallStateStore();
    const first = store(state, () => 0).s;
    first.create('CA1', sock());
    first.create('CA2', sock());
    await first.persist('CA1');
    first.get('CA2')!.lastActivityMs = 50_000;
    await first.persist('CA2');
    const { s } = store(state, () => 70_000, 60_000);
    const gone = await s.sweepStored();
    expect(gone.map((c) => c.callId)).toEqual(['CA1']);
    expect(state.list()).toEqual(['CA2']);
  });

  it('is not durable, and saves nothing, without a call store', async () => {
    const { s } = store(null, () => 0);
    s.create('CA1', sock());
    await s.persist('CA1');
    expect(await s.sweepStored()).toEqual([]);
  });

  it('logs a save that fails, and goes on', async () => {
    const state = new MemoryCallStateStore();
    state.save = () => {
      throw new Error('disk full');
    };
    const { s, logs } = store(state, () => 0);
    s.create('CA1', sock());
    await s.persist('CA1');
    expect(logs).toEqual(['CA1: could not save the session: disk full']);
  });
});
