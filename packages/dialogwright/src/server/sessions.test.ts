import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callFacts, CONVERSE_CALL_SCHEMA, converseCallResources, ENDED_GRACE_MS, isConverseCall, SessionStore, type SocketLike } from './sessions';
import { newSession, SESSION_SCHEMA } from '../core/session';
import type { ConverseState } from '../converse/state';
import { MemoryCallStateStore } from './stores/memory';
import { FileCallStateStore } from './stores/file';
import type { AnyStoredCall, CallStateStore, StoredCall } from './stores/types';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { TraceWriter } from '../trace/writer';
import { FrameLog } from './frameLog';
import { VOICE_RELAY } from '../channel/caps';
import { useTestkit } from '../testing/apps';

useTestkit();

type Fake = SocketLike & { sent: string[]; closed: boolean; closeArgs: { code?: number; reason?: string } | null };
function fakeSocket(): Fake {
  const s: Fake = {
    sent: [] as string[], closed: false, closeArgs: null,
    send(d: string, cb?: (e?: Error) => void) { s.sent.push(d); cb?.(); },
    close(code?: number, reason?: string) { s.closed = true; s.closeArgs = { code, reason }; },
  };
  return s;
}

function store(now: () => number, ttl = 1000, maxAge = 7_200_000) {
  const dir = mkdtempSync(join(tmpdir(), 'sessions-'));
  return new SessionStore((callSid) => ({
    session: newSession(callSid, now(), VOICE_RELAY),
    opts: { client: new HeuristicStubClient(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18', now },
    trace: new TraceWriter(join(dir, `${callSid}.jsonl`)),
    frames: new FrameLog(join(dir, `${callSid}.frames.jsonl`), now),
  }), ttl, now, maxAge);
}

describe('SessionStore', () => {
  it('creates, gets, detaches and attaches', () => {
    const s = store(() => 0);
    const sock = fakeSocket();
    const e = s.create('CA1', sock);
    expect(s.get('CA1')).toBe(e);
    expect(e.socket).toBe(sock);
    s.detach('CA1');
    expect(e.socket).toBeNull();
    const sock2 = fakeSocket();
    expect(s.attach('CA1', sock2)?.socket).toBe(sock2);
    expect(s.attach('CA9', sock2)).toBeUndefined();
    expect(() => s.create('CA1', sock)).toThrow(/exists/);
  });

  it('runs queued work one at a time in order and survives an error', async () => {
    const s = store(() => 0);
    s.create('CA1', fakeSocket());
    const order: string[] = [];
    const p1 = s.enqueue('CA1', async () => { await new Promise((r) => setTimeout(r, 30)); order.push('a'); });
    const p2 = s.enqueue('CA1', async () => { order.push('b'); throw new Error('boom'); });
    const p3 = s.enqueue('CA1', async () => { order.push('c'); });
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual(['a', 'b', 'c']);
    expect(await s.enqueue('CA9', async () => {})).toBeUndefined();
  });

  it('ends and evicts idle sessions', () => {
    let t = 0;
    const s = store(() => t, 1000);
    s.create('CA1', fakeSocket());
    s.create('CA2', fakeSocket());
    s.end('CA1');
    expect(s.get('CA1')?.ended).toBe(true);
    t = 500;
    s.touch('CA2');
    t = 1200;
    expect(s.evictIdle().sort()).toEqual(['CA1']);
    t = 1600;
    expect(s.evictIdle()).toEqual(['CA2']);
    expect(s.size()).toBe(0);
  });

  it('keeps the queue alive when the frame log itself throws', async () => {
    const s = store(() => 0);
    const e = s.create('CA1', fakeSocket());
    e.frames.write = () => {
      throw new Error('disk');
    };
    let ran = false;
    const p1 = s.enqueue('CA1', async () => {
      throw new Error('boom');
    });
    const p2 = s.enqueue('CA1', async () => {
      ran = true;
    });
    await Promise.all([p1, p2]);
    expect(ran).toBe(true);
    await expect(e.tail).resolves.toBeUndefined();
  });

  it('skips queued work after end', async () => {
    const s = store(() => 0);
    s.create('CA1', fakeSocket());
    let secondRan = false;
    const p1 = s.enqueue('CA1', async () => {
      await new Promise((r) => setTimeout(r, 20));
      s.end('CA1');
    });
    const p2 = s.enqueue('CA1', async () => {
      secondRan = true;
    });
    await Promise.all([p1, p2]);
    expect(secondRan).toBe(false);
  });

  it('does not evict a session with work in flight', async () => {
    let t = 0;
    const s = store(() => t, 1000);
    s.create('CA1', fakeSocket());
    const p = s.enqueue('CA1', async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    await new Promise((r) => setTimeout(r, 0));
    t = 2000;
    expect(s.evictIdle()).toEqual([]);
    await p;
    expect(s.evictIdle()).toEqual(['CA1']);
  });

  it('evicts an entry past the max age even with work in flight', async () => {
    let t = 0;
    const s = store(() => t, 1_000_000, 5000);
    const sock = fakeSocket();
    s.create('CA1', sock);
    let released!: () => void;
    const p = s.enqueue('CA1', () => new Promise<void>((r) => { released = r; }));
    await new Promise((r) => setTimeout(r, 0));
    expect(s.get('CA1')?.inFlight).toBe(1);
    // The idle TTL is far away and the turn is still running, so only the age cap can remove it.
    t = 4999;
    expect(s.evictIdle()).toEqual([]);
    t = 5000;
    expect(s.evictIdle()).toEqual(['CA1']);
    expect(sock.closeArgs).toEqual({ code: 1000, reason: 'session expired' });
    expect(s.get('CA1')).toBeUndefined();
    released();
    await p;
  });

  it('retains an ended call for the grace period, then drops it, and counts live sessions', () => {
    let t = 0;
    const s = store(() => t, 1_000_000);
    s.create('CA1', fakeSocket());
    s.create('CA2', fakeSocket());
    expect(s.liveCount()).toBe(2);
    s.end('CA1');
    expect(s.liveCount()).toBe(1);
    expect(s.size()).toBe(2);
    // A second end (the action callback after the adapter) must not restart the grace period.
    t = ENDED_GRACE_MS - 1;
    s.end('CA1');
    expect(s.evictIdle()).toEqual([]);
    t = ENDED_GRACE_MS;
    expect(s.evictIdle()).toEqual(['CA1']);
    expect(s.size()).toBe(1);
    expect(s.liveCount()).toBe(1);
  });

  it('closes a live socket on eviction', () => {
    let t = 0;
    const s = store(() => t, 1000);
    const sock = fakeSocket();
    s.create('CA1', sock);
    t = 2000;
    expect(s.evictIdle()).toEqual(['CA1']);
    expect(sock.closed).toBe(true);
  });
});

/**
 * A call of either runtime held, saved and restored (plan 2, Task 2): a scripted call as it always was, a
 * converse call (a ConverseState under 'converse-1') beside it, for a converse app of that id only.
 */
describe('a SessionStore of either runtime', () => {
  const CONVERSE = 'converse-app';
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const sock = (): SocketLike => ({ send: (_d, cb) => cb?.(), close: () => {} });

  /** A store whose factory builds a converse call for CONVERSE and a scripted one otherwise, as the server's does. */
  function either(state: CallStateStore | null, now: () => number, o: { ttl?: number; converseApps?: readonly string[] } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'either-'));
    dirs.push(dir);
    const logs: string[] = [];
    const sinks = (callSid: string) => ({ trace: new TraceWriter(join(dir, `${callSid}.jsonl`)), frames: new FrameLog(join(dir, `${callSid}.frames.jsonl`), now) });
    const s = new SessionStore((callSid, appId) => (appId === CONVERSE
      ? converseCallResources(callSid, appId, sinks(callSid))
      : {
          session: newSession(callSid, now(), VOICE_RELAY),
          opts: { client: new HeuristicStubClient(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18', now },
          ...sinks(callSid),
        }), o.ttl ?? 60_000, now, 7_200_000, { state, log: (l) => logs.push(l), converseApps: new Set(o.converseApps ?? [CONVERSE]) });
    return { s, logs };
  }

  const stores: [string, () => CallStateStore][] = [
    ['memory', () => new MemoryCallStateStore()],
    ['file', () => {
      const dir = mkdtempSync(join(tmpdir(), 'either-store-'));
      dirs.push(dir);
      return new FileCallStateStore(dir);
    }],
  ];

  for (const [name, make] of stores) {
    it(`a converse call is saved and restored with its schema (${name} store)`, async () => {
      const state = make();
      const first = either(state, () => 1_000).s;
      const e = first.createConverse('CA1', sock(), 'telnyx', CONVERSE);
      expect(e).not.toHaveProperty('opts');
      expect(isConverseCall(e.session)).toBe(true);
      expect(first.get('CA1')).toBeUndefined();
      expect(first.getConverse('CA1')).toBe(e);
      const conv = e.session;
      conv.messages.push({ role: 'user', content: [{ type: 'text', text: 'I would like a visit on Tuesday.' }] });
      conv.turnIndex = 1;
      e.reconnects = 1;
      await first.persist('CA1');
      const saved = await state.load('CA1');
      expect(saved).toMatchObject({ callId: 'CA1', provider: 'telnyx', schema: 'converse-1', reconnects: 1 });
      expect(saved!.session).toEqual(JSON.parse(JSON.stringify(conv)));

      const { s, logs } = either(state, () => 2_000);
      expect(await s.restore('CA1', 'telnyx')).toBe('restored');
      const back = s.getConverse('CA1')!;
      expect(back).not.toHaveProperty('opts');
      expect(back.session).toEqual(JSON.parse(JSON.stringify(conv)));
      expect(callFacts(back.session)).toEqual({ appId: CONVERSE, ended: false, locale: 'en', channel: 'voice' });
      expect(logs).toEqual(['CA1: restored from the session store (turn 1, reconnect 1)']);
    });
  }

  it('a converse call saved under another schema is unreadable', async () => {
    const state = new MemoryCallStateStore();
    const first = either(state, () => 0).s;
    first.createConverse('CA1', sock(), 'twilio', CONVERSE);
    await first.persist('CA1');
    state.save({ ...state.load('CA1')!, schema: 'converse-0' });
    const { s, logs } = either(state, () => 0);
    expect(await s.restore('CA1', 'twilio')).toBe('unreadable');
    expect(s.getAny('CA1')).toBeUndefined();
    expect(state.load('CA1')).toBeNull();
    expect(logs).toEqual([`CA1: not resumed: saved under session schema converse-0, and this server reads ${CONVERSE_CALL_SCHEMA}`]);
  });

  it('a converse call is unreadable on a server that runs no converse app of its id, and a scripted session under the converse schema too', async () => {
    const state = new MemoryCallStateStore();
    const first = either(state, () => 0).s;
    first.createConverse('CA1', sock(), 'twilio', CONVERSE);
    const scripted = first.create('CA2', sock(), 'twilio');
    await first.persist('CA1');
    await first.persist('CA2');
    state.save({ ...state.load('CA2')!, schema: CONVERSE_CALL_SCHEMA });
    const scriptedApp = callFacts(scripted.session).appId;
    const { s, logs } = either(state, () => 0, { converseApps: [] });
    expect(await s.restore('CA1', 'twilio')).toBe('unreadable');
    expect(await s.restore('CA2', 'twilio')).toBe('unreadable');
    expect(state.list()).toEqual([]);
    expect(logs).toEqual([
      `CA1: not resumed: saved for the converse app "${CONVERSE}", which this server does not run`,
      `CA2: not resumed: saved for the converse app "${scriptedApp}", which this server does not run`,
    ]);
  });

  it('a converse call keeps the words of the turn running across a save and a restore, and a scripted call never has them', async () => {
    const state = new MemoryCallStateStore();
    const first = either(state, () => 0).s;
    const e = first.createConverse('CA1', sock(), 'twilio', CONVERSE);
    e.turnWords = 'yes, book it';
    await first.persist('CA1');
    expect(state.load('CA1')).toMatchObject({ turnWords: 'yes, book it' });
    delete e.turnWords;
    await first.persist('CA1');
    expect(state.load('CA1')).not.toHaveProperty('turnWords');
    e.turnWords = 'yes, book it';
    await first.persist('CA1');
    const { s } = either(state, () => 0);
    expect(await s.restore('CA1', 'twilio')).toBe('restored');
    expect(s.getConverse('CA1')!.turnWords).toBe('yes, book it');
  });

  it('a call whose app is of the other runtime here, or whose app\'s resources cannot be made, is unreadable, never a throw', async () => {
    const state = new MemoryCallStateStore();
    const first = either(state, () => 0).s;
    first.createConverse('CA1', sock(), 'twilio', CONVERSE);
    first.create('CA2', sock(), 'twilio');
    await first.persist('CA1');
    await first.persist('CA2');
    const logs: string[] = [];
    // A server that says CONVERSE is a converse app, and whose factory makes a scripted call for it (and throws for the other).
    const odd = new SessionStore((callSid, appId) => {
      if (appId !== CONVERSE) throw new Error(`no app "${appId}"`);
      return { session: newSession(callSid, 0, VOICE_RELAY), opts: { client: new HeuristicStubClient(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18', now: () => 0 }, trace: { write() {} }, frames: { write() {} } };
    }, 60_000, () => 0, 7_200_000, { state, log: (l) => logs.push(l), converseApps: new Set([CONVERSE]) });
    expect(await odd.restore('CA1', 'twilio')).toBe('unreadable');
    expect(await odd.restore('CA2', 'twilio')).toBe('unreadable');
    expect(odd.getAny('CA1')).toBeUndefined();
    expect(odd.getAny('CA2')).toBeUndefined();
    expect(logs).toEqual([
      `CA1: not resumed: saved as a converse call, and "${CONVERSE}" is not a converse app here`,
      expect.stringMatching(/^CA2: not resumed: no app "/),
    ]);
  });

  it('a scripted call is saved exactly as before', async () => {
    const state = new MemoryCallStateStore();
    const { s } = either(state, () => 5_000);
    const e = s.create('CA1', sock(), 'twilio');
    e.session = { ...e.session, turnIndex: 2 };
    expect(e.opts).not.toBeNull();
    expect(() => s.create('CA2', sock(), 'twilio', CONVERSE)).toThrow(/converse app: its calls are made with createConverse/);
    expect(() => s.createConverse('CA3', sock(), 'twilio', 'testkit')).toThrow(/not a converse app/);
    expect(isConverseCall(e.session)).toBe(false);
    await s.persist('CA1');
    const saved = state.load('CA1')!;
    expect(Object.keys(saved)).toEqual(['callId', 'provider', 'schema', 'session', 'reconnects', 'createdAtMs', 'lastActivityMs', 'auditTail']);
    expect(saved).toEqual({
      callId: 'CA1', provider: 'twilio', schema: SESSION_SCHEMA, session: JSON.parse(JSON.stringify(e.session)), reconnects: 0,
      createdAtMs: 5_000, lastActivityMs: 5_000, auditTail: [],
    });
    expect(callFacts(e.session)).toEqual({ appId: e.session.appId, ended: false, locale: 'en-US', channel: 'voice' });
  });

  it('the sweep and renewals read either kind: an ended converse call is swept, a live one renewed', async () => {
    const state = new MemoryCallStateStore();
    const first = either(state, () => 0).s;
    first.createConverse('CA1', sock(), 'twilio', CONVERSE);
    first.createConverse('CA2', sock(), 'twilio', CONVERSE);
    await first.persist('CA1');
    await first.persist('CA2');
    // CA1's state says it ended (its closing line), as a store may hold it: swept although in time.
    const ended = state.load('CA1')! as AnyStoredCall;
    const endedCall: AnyStoredCall = { ...ended, session: { ...(ended.session as ConverseState), ended: 'closing' } };
    state.save(endedCall as StoredCall);
    const { s } = either(state, () => 1_000);
    expect((await s.sweepStored()).map((c) => c.callId)).toEqual(['CA1']);
    expect(state.list()).toEqual(['CA2']);

    // A converse call held here: an ended state is not saved, a live one is saved as let go by a stop.
    const live = s.createConverse('CA3', sock(), 'twilio', CONVERSE);
    const over = s.createConverse('CA4', sock(), 'twilio', CONVERSE);
    over.session.ended = 'handoff';
    await s.persist('CA4');
    expect(state.load('CA4')).toBeNull();
    await s.releaseAll();
    expect(state.load('CA3')).toMatchObject({ schema: CONVERSE_CALL_SCHEMA, stopped: true, session: JSON.parse(JSON.stringify(live.session)) });
    expect(state.load('CA4')).toBeNull();
  });
});
