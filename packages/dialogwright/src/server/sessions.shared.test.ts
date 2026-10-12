import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HELD_TRANSFER_MAX_MS, SessionStore, type SocketLike } from './sessions';
import { newSession } from '../core/session';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { TraceWriter } from '../trace/writer';
import { FrameLog } from './frameLog';
import { VOICE_RELAY } from '../channel/caps';
import { useTestkit } from '../testing/apps';
import { MemoryCallStateStore } from './stores/memory';
import { PGlite } from '@electric-sql/pglite';
import { pgliteSql } from './stores/pgliteSql';
import { openPostgresStores } from './stores/postgres';

/**
 * SessionStore over a store many servers share (SessionStoreOptions.lease): two servers' stores over one
 * call store, whose leases the memory store keeps in the process, as Postgres keeps them for servers
 * apart. A call is held only under its lease; a save from a server that lost it is refused and the call
 * let go there; a socket closing gives the call up; a reconnect is counted once for both.
 */

useTestkit();

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface FakeSocket extends SocketLike {
  closedWith: string | null;
}
const sock = (): FakeSocket => {
  const s: FakeSocket = { closedWith: null, send: (_d, cb) => cb?.(), close: (_code, reason) => (s.closedWith = reason ?? '') };
  return s;
};

const TTL = 1_000;

function server(owner: string, state: MemoryCallStateStore, clock: { t: number }, lease: { waitMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'shared-'));
  dirs.push(dir);
  const logs: string[] = [];
  const now = (): number => clock.t;
  const s = new SessionStore((callSid) => ({
    session: newSession(callSid, now(), VOICE_RELAY),
    opts: { client: new HeuristicStubClient(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18', now },
    trace: new TraceWriter(join(dir, `${callSid}.jsonl`)),
    frames: new FrameLog(join(dir, `${callSid}.frames.jsonl`), now),
  }), 60_000, now, 7_200_000, { state, lease: { leases: state, owner, ttlMs: TTL, pollMs: 5, waitMs: lease.waitMs ?? 50 }, log: (l) => logs.push(l) });
  return { s, logs };
}

describe('a SessionStore over a shared store', () => {
  it('is shared only with a lease and a call store; a memory or file setup is as it always was', () => {
    const clock = { t: 1_000_000 };
    const state = new MemoryCallStateStore(() => clock.t);
    expect(server('a', state, clock).s.shared).toBe(true);
    expect(new SessionStore(() => { throw new Error('unused'); }, 60_000, () => 0, 1, { state }).shared).toBe(false);
    expect(new SessionStore(() => { throw new Error('unused'); }, 60_000, () => 0, 1, { state: null, lease: { leases: state, owner: 'a', ttlMs: TTL } }).shared).toBe(false);
  });

  it('a new call is taken at its setup and saved under its lease; another server cannot take it, and is told so', async () => {
    const clock = { t: 1_000_000 };
    const state = new MemoryCallStateStore(() => clock.t);
    const a = server('a', state, clock);
    const b = server('b', state, clock);
    expect(await a.s.claim('CA1', 'twilio')).toBe('none');
    a.s.create('CA1', sock(), 'twilio');
    await a.s.persist('CA1');
    expect(state.load('CA1')).not.toBeNull();
    expect(state.holder('CA1')).toEqual({ owner: 'a', expiresAtMs: clock.t + TTL });
    expect(await b.s.claim('CA1', 'twilio')).toBe('busy');
    expect(b.logs).toContain('CA1: not taken over: a still holds it');
    expect(b.s.get('CA1')).toBeUndefined();
  });

  it('a call whose socket closed is given up once its turn is done, and the next server takes it as a clean hand-off', async () => {
    const clock = { t: 1_000_000 };
    const state = new MemoryCallStateStore(() => clock.t);
    // A claimer waits up to two seconds: the turn running is waited for up to that less a quarter of a hold.
    const a = server('a', state, clock, { waitMs: 2_000 });
    const b = server('b', state, clock);
    await a.s.claim('CA1', 'twilio');
    const e = a.s.create('CA1', sock(), 'twilio');
    let finish!: () => void;
    // A turn still running when the socket closes: the call is given up only after it.
    void a.s.enqueue('CA1', () => new Promise<void>((r) => (finish = r)));
    e.session = { ...e.session, turnIndex: 2 };
    a.s.detach('CA1');
    await new Promise((r) => setTimeout(r, 20));
    expect(state.holder('CA1')?.owner).toBe('a');
    await a.s.persist('CA1');
    finish();
    await a.s.settled();
    expect(a.s.get('CA1')).toBeUndefined();
    expect(state.holder('CA1')).toBeNull();
    expect(a.logs).toContain('CA1: let go: its socket closed, and the server its carrier reconnects to takes it');
    expect(await b.s.claim('CA1', 'twilio')).toBe('restored');
    expect(b.s.get('CA1')!.session.turnIndex).toBe(2);
    expect(b.s.takeRestored('CA1')).toBe(true);
    // Given up as its socket closed: the caller is not told they were lost (no resumed line).
    expect(b.s.takeQuiet('CA1')).toBe(true);
    expect(state.holder('CA1')?.owner).toBe('b');
  });

  it('a socket back on the same server before the call was given up keeps it there, with its lease', async () => {
    const clock = { t: 1_000_000 };
    const state = new MemoryCallStateStore(() => clock.t);
    const a = server('a', state, clock);
    await a.s.claim('CA1', 'twilio');
    a.s.create('CA1', sock(), 'twilio');
    let finish!: () => void;
    void a.s.enqueue('CA1', () => new Promise<void>((r) => (finish = r)));
    a.s.detach('CA1');
    a.s.attach('CA1', sock());
    expect(await a.s.claim('CA1', 'twilio')).toBe('held');
    finish();
    await a.s.settled();
    expect(a.s.get('CA1')).toBeDefined();
    expect(state.holder('CA1')?.owner).toBe('a');
  });

  it('waits for a crashed server\'s lease to lapse, and takes the call then', async () => {
    const clock = { t: 1_000_000 };
    const state = new MemoryCallStateStore(() => clock.t);
    const a = server('a', state, clock);
    const b = server('b', state, clock, { waitMs: 2_000 });
    await a.s.claim('CA1', 'twilio');
    a.s.create('CA1', sock(), 'twilio');
    await a.s.persist('CA1');
    // A dies holding it: nothing renews it, and the clock runs on while B waits.
    const taking = b.s.claim('CA1', 'twilio');
    await new Promise((r) => setTimeout(r, 30));
    clock.t += TTL;
    expect(await taking).toBe('restored');
    expect(b.logs).toContain('CA1: taken over from the session store (turn 0, reconnect 0, its lease lapsed) by b');
    expect(b.s.takeQuiet('CA1')).toBe(false);
  });

  it('a server whose call was taken over lets it go: its save is refused, its socket closed, and it is never saved from there again', async () => {
    const clock = { t: 1_000_000 };
    const state = new MemoryCallStateStore(() => clock.t);
    const a = server('a', state, clock);
    const b = server('b', state, clock);
    await a.s.claim('CA1', 'twilio');
    const socket = sock();
    const e = a.s.create('CA1', socket, 'twilio');
    await a.s.persist('CA1');
    clock.t += TTL;
    expect(await b.s.claim('CA1', 'twilio')).toBe('restored');
    e.session = { ...e.session, turnIndex: 9 };
    await a.s.persist('CA1');
    expect(a.logs).toContain('CA1: let go: its save was refused: another server has the call now');
    expect(socket.closedWith).toBe('taken over');
    expect(a.s.get('CA1')).toBeUndefined();
    expect(e.ended).toBe(true);
    expect(state.load('CA1')!.session.turnIndex).toBe(0);
  });

  it('a renewal keeps what the server holds, and lets go a call another server has taken since', async () => {
    const clock = { t: 1_000_000 };
    const state = new MemoryCallStateStore(() => clock.t);
    const a = server('a', state, clock);
    const b = server('b', state, clock);
    for (const id of ['CA1', 'CA2']) {
      await a.s.claim(id, 'twilio');
      a.s.create(id, sock(), 'twilio');
      await a.s.persist(id);
    }
    clock.t += TTL / 2;
    await a.s.renewLeases();
    expect(state.holder('CA1')).toEqual({ owner: 'a', expiresAtMs: clock.t + TTL });
    // A cannot reach the store for a while; B takes CA2 meanwhile.
    clock.t += TTL;
    expect(await b.s.claim('CA2', 'twilio')).toBe('restored');
    clock.t += 1;
    await a.s.renewLeases();
    expect(a.s.get('CA1')).toBeDefined();
    expect(a.s.get('CA2')).toBeUndefined();
    expect(a.logs).toContain('CA2: let go: its lease is held by another server now');
  });

  it("a callback on a server that does not hold the call counts the reconnect in the store, once for all, and does not keep the call", async () => {
    const clock = { t: 1_000_000 };
    const state = new MemoryCallStateStore(() => clock.t);
    const a = server('a', state, clock);
    const b = server('b', state, clock);
    await a.s.claim('CA1', 'twilio');
    a.s.create('CA1', sock(), 'twilio');
    await a.s.persist('CA1');
    expect(await b.s.restore('CA1', 'twilio')).toBe('restored');
    await b.s.countReconnect('CA1', 2);
    expect(b.s.get('CA1')!.reconnects).toBe(0);
    expect(state.load('CA1')!.reconnects).toBe(1);
    // Borrowed: a save from here is not made, and the call is dropped once the callback is answered.
    b.s.get('CA1')!.reconnects = 1;
    await b.s.persist('CA1');
    b.s.dropBorrowed('CA1');
    expect(b.s.get('CA1')).toBeUndefined();
    expect(state.holder('CA1')?.owner).toBe('a');
    // At the limit, a callback's count says so: the call goes to a person.
    await state.countReconnect('CA1', 2);
    expect(await b.s.restore('CA1', 'twilio')).toBe('restored');
    await b.s.countReconnect('CA1', 2);
    expect(b.s.get('CA1')!.reconnects).toBe(2);
  });

  it('a lease taken for a socket that closed meanwhile is given back, for a new call and for one taken over', async () => {
    const clock = { t: 1_000_000 };
    const state = new MemoryCallStateStore(() => clock.t);
    const a = server('a', state, clock);
    const b = server('b', state, clock);
    expect(await b.s.claim('CA-new', 'twilio')).toBe('none');
    b.s.giveBack('CA-new');
    await b.s.settled();
    expect(state.holder('CA-new')).toBeNull();
    await a.s.claim('CA1', 'twilio');
    a.s.create('CA1', sock(), 'twilio');
    await a.s.persist('CA1');
    await a.s.releaseAll();
    expect(await b.s.claim('CA1', 'twilio')).toBe('restored');
    b.s.giveBack('CA1');
    await b.s.settled();
    expect(b.s.get('CA1')).toBeUndefined();
    expect(state.holder('CA1')).toBeNull();
  });

  it('a stop gives up every call it holds, so the next server takes them at once', async () => {
    const clock = { t: 1_000_000 };
    const state = new MemoryCallStateStore(() => clock.t);
    const a = server('a', state, clock);
    const b = server('b', state, clock);
    await a.s.claim('CA1', 'twilio');
    a.s.create('CA1', sock(), 'twilio');
    await a.s.persist('CA1');
    await a.s.releaseAll();
    expect(state.holder('CA1')).toBeNull();
    expect(await b.s.claim('CA1', 'twilio')).toBe('restored');
  });

  it("the sweep never removes a call a server holds, and only one server records each it removes", async () => {
    const clock = { t: 1_000_000 };
    const state = new MemoryCallStateStore(() => clock.t);
    const a = server('a', state, clock);
    const b = server('b', state, clock);
    const c = server('c', state, clock);
    for (const id of ['CA-live', 'CA-gone']) {
      await a.s.claim(id, 'twilio');
      a.s.create(id, sock(), 'twilio');
      await a.s.persist(id);
    }
    // CA-gone's server stops renewing it, and it is past its idle time; CA-live's lease is kept.
    clock.t += 61_000;
    await a.s.renewLeases();
    state.release('CA-gone', 'a');
    const [fromB, fromC] = await Promise.all([b.s.sweepStored(), c.s.sweepStored()]);
    expect([...fromB, ...fromC].map((x) => x.callId)).toEqual(['CA-gone']);
    expect(state.list()).toEqual(['CA-live']);
  });

  it('a server that lost a call never removes it: its end leaves the call the new holder runs, on Postgres', async () => {
    const db = await PGlite.create();
    try {
      const clock = { t: 1_000_000 };
      const stores = await Promise.all([0, 1].map(() => openPostgresStores(pgliteSql(db), { tokenTtlMs: 600_000, now: () => clock.t, leaseNow: () => clock.t })));
      const on = (owner: string, i: number) => {
        const dir = mkdtempSync(join(tmpdir(), 'shared-'));
        dirs.push(dir);
        const logs: string[] = [];
        const now = (): number => clock.t;
        const s = new SessionStore((callSid) => ({
          session: newSession(callSid, now(), VOICE_RELAY),
          opts: { client: new HeuristicStubClient(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18', now },
          trace: new TraceWriter(join(dir, `${callSid}.jsonl`)),
          frames: new FrameLog(join(dir, `${callSid}.frames.jsonl`), now),
        }), 60_000, now, 7_200_000, { state: stores[i]!.calls, lease: { leases: stores[i]!.calls, owner, ttlMs: TTL, pollMs: 5, waitMs: 50 }, log: (l) => logs.push(l) });
        return { s, logs };
      };
      const a = on('a', 0);
      const b = on('b', 1);
      expect(await a.s.claim('CA1', 'twilio')).toBe('none');
      a.s.create('CA1', sock(), 'twilio');
      await a.s.persist('CA1');
      // A could not renew (a stall): its hold lapses, and B takes the call.
      clock.t += TTL * 2;
      expect(await b.s.claim('CA1', 'twilio')).toBe('restored');
      const bs = sock();
      b.s.attach('CA1', bs);
      // A, not yet aware, ends the call: nothing of B's goes.
      a.s.end('CA1');
      await a.s.settled();
      expect((await db.query('SELECT call_id FROM dw_calls')).rows).toEqual([{ call_id: 'CA1' }]);
      expect((await db.query<{ owner: string }>('SELECT owner FROM dw_call_leases')).rows).toEqual([{ owner: 'b' }]);
      await b.s.persist('CA1');
      await b.s.settled();
      expect(b.s.get('CA1')).toBeDefined();
      expect(bs.closedWith).toBeNull();
    } finally {
      await db.close();
    }
  });

  it('the sweep keeps a held transfer only a short while for the callback that takes it', async () => {
    const clock = { t: 1_000_000 };
    const state = new MemoryCallStateStore(() => clock.t);
    const a = server('a', state, clock);
    const b = server('b', state, clock);
    await a.s.claim('CA1', 'twilio');
    a.s.create('CA1', sock(), 'twilio');
    a.s.endHolding('CA1', '{"reasonCode":"live-agent"}');
    await a.s.settled();
    await a.s.releaseAll();
    expect(state.load('CA1')?.heldHandoffData).toBe('{"reasonCode":"live-agent"}');
    clock.t += HELD_TRANSFER_MAX_MS - 1;
    expect(await b.s.sweepStored()).toEqual([]);
    clock.t += 1;
    expect((await b.s.sweepStored()).map((c) => c.callId)).toEqual(['CA1']);
    expect(state.load('CA1')).toBeNull();
  });
});

