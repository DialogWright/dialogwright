import { afterEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgliteSql } from '../server/stores/pgliteSql';
import { AUDIT_SCHEMA_VERSION, chainOf, openPostgresAudit, verifyPostgresAudit, type PostgresAuditLog } from './postgres';
import { AuditLog, entryHash, GENESIS } from './log';
import { SchemaVersionError, schemaVersion } from '../server/stores/postgres';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuditEntry } from './types';

/**
 * AUDIT_STORE=postgres: a hash chain per call, each call's newest hash anchored into the day's chain, on
 * PGlite. Two servers appending to one call never fork it; the entries are the day files' shapes; the
 * verifier finds an edit, a deletion, a forged entry and a cut tail.
 */

const dbs: PGlite[] = [];
afterEach(async () => {
  for (const db of dbs.splice(0)) await db.close();
});

async function fresh(now: () => number = () => Date.UTC(2026, 9, 11, 12, 0, 0)): Promise<{ db: PGlite; audit: PostgresAuditLog; at: (ms: number) => void }> {
  const db = await PGlite.create();
  dbs.push(db);
  let t = now();
  const audit = await openPostgresAudit(pgliteSql(db), { now: () => t });
  return { db, audit, at: (ms) => { t = ms; } };
}

const draft = (type: string, detail: AuditEntry['detail'] = {}) => ({ type, detail });

describe('the audit in Postgres', () => {
  it('chains each call from GENESIS, in the shapes a day file has, and anchors each call\'s newest hash into the day', async () => {
    const { db, audit } = await fresh();
    const [started] = await audit.appendAll('CA1', 'voice', [draft('call_started', { channel: 'voice' })]);
    await audit.append('CA2', 'chat', draft('call_started'));
    const turn = await audit.appendAll('CA1', 'voice', [draft('gate', { tool: 'getParcel', verdict: 'ALLOW' }), draft('tool_result', { tool: 'getParcel', summary: 'in transit' })]);
    expect(started).toEqual({ type: 'call_started', detail: { channel: 'voice' }, seq: 1, at: '2026-10-11T12:00:00.000Z', callId: 'CA1', channel: 'voice', prevHash: GENESIS, hash: started!.hash });
    expect(turn.map((e) => e.seq)).toEqual([2, 3]);
    expect(turn[0]!.prevHash).toBe(started!.hash);
    // The same entry a day file would hold, hashed the same way.
    const { hash, ...rest } = turn[1]!;
    expect(entryHash(rest)).toBe(hash);
    const anchors = (await db.query<{ body: string }>('SELECT body FROM dw_audit_anchors ORDER BY seq')).rows.map((r) => JSON.parse(r.body) as { callId: string; callSeq: number });
    expect(anchors.map((a) => [a.callId, a.callSeq])).toEqual([['CA1', 1], ['CA2', 1], ['CA1', 3]]);
    expect(await verifyPostgresAudit(db)).toEqual({ chains: 2, entries: 4, days: [{ day: '2026-10-11', server: 'server', anchors: 3 }], breaks: [] });
    expect(await schemaVersion(db, 'audit')).toBe(AUDIT_SCHEMA_VERSION);
  });

  it('two servers appending to one call at once never fork it: one chain, in the order the database took them', async () => {
    const db = await PGlite.create();
    dbs.push(db);
    const a = await openPostgresAudit(pgliteSql(db), { server: 'a-1' });
    const b = await openPostgresAudit(pgliteSql(db), { server: 'b-2' });
    await a.append('CA1', 'voice', draft('call_started'));
    // A turn that outlived A's hold on the call, and B's first turn, at once.
    await Promise.all([
      a.appendAll('CA1', 'voice', [draft('gate', { from: 'a' }), draft('tool_result', { from: 'a' })]),
      b.appendAll('CA1', 'voice', [draft('gate', { from: 'b' })]),
      b.append('CA1', 'voice', draft('call_ended', { from: 'b' })),
    ]);
    const r = await verifyPostgresAudit(db);
    expect(r.breaks).toEqual([]);
    expect(r.entries).toBe(5);
    const seqs = (await db.query<{ seq: number }>('SELECT seq FROM dw_audit_entries WHERE chain = $1 ORDER BY seq', ['CA1'])).rows.map((x) => Number(x.seq));
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
    // B's own two appends kept their order.
    const bodies = (await db.query<{ body: string }>('SELECT body FROM dw_audit_entries ORDER BY seq')).rows.map((x) => JSON.parse(x.body) as AuditEntry);
    const fromB = bodies.filter((e) => e.detail.from === 'b').map((e) => e.type);
    expect(fromB).toEqual(['gate', 'call_ended']);
    // Each server anchors into its own chain for the day, so neither waits on the other's anchors; the call's newest entry is anchored.
    expect(r.days).toEqual([{ day: expect.any(String), server: 'a-1', anchors: 2 }, { day: expect.any(String), server: 'b-2', anchors: 2 }]);
    const anchors = (await db.query<{ body: string }>('SELECT body FROM dw_audit_anchors')).rows.map((x) => JSON.parse(x.body) as { callSeq: number });
    expect(Math.max(...anchors.map((a) => a.callSeq))).toBe(5);
  });

  it('one server sweeps at a time: two at once, and the one that finds the sweep taken removes nothing', async () => {
    const day = 86_400_000;
    const t0 = Date.UTC(2026, 9, 1, 12, 0, 0);
    let t = t0;
    const db = await PGlite.create();
    dbs.push(db);
    const a = await openPostgresAudit(pgliteSql(db), { now: () => t, server: 'a-1' });
    const b = await openPostgresAudit(pgliteSql(db), { now: () => t, server: 'b-2' });
    await a.append('OLD', 'voice', draft('call_started'));
    t = t0 + 9 * day;
    await a.append('NEW', 'voice', draft('call_started'));
    const [x, y] = await Promise.all([a.sweep(7, t0 + 10 * day), b.sweep(7, t0 + 10 * day)]);
    expect([x.chains, y.chains].sort()).toEqual([0, 1]);
    expect((await verifyPostgresAudit(db)).breaks).toEqual([]);
  });

  it("the console's access log is chained per day, so no chain grows without end", async () => {
    const { audit, at, db } = await fresh();
    await audit.append('console', 'console', draft('console_access', { event: 'link_made' }));
    at(Date.UTC(2026, 9, 12, 9, 0, 0));
    const next = await audit.append('console', 'console', draft('console_access', { event: 'sign_in' }));
    expect(next.seq).toBe(1);
    expect(next.callId).toBe('console');
    expect(chainOf('console', '2026-10-12')).toBe('console@2026-10-12');
    expect((await verifyPostgresAudit(db)).breaks).toEqual([]);
  });

  it('the verifier finds an edit, a link broken, a forged entry, an anchor that names nothing, and a cut tail', async () => {
    const { db, audit } = await fresh();
    for (const id of ['CA1', 'CA2', 'CA3', 'CA4']) await audit.appendAll(id, 'voice', [draft('call_started'), draft('gate', { tool: 'x' }), draft('call_ended')]);
    // An edit: a value changed, its hash left.
    const e2 = (await db.query<{ body: string }>("SELECT body FROM dw_audit_entries WHERE chain = 'CA1' AND seq = 2")).rows[0]!.body;
    await db.query("UPDATE dw_audit_entries SET body = $1 WHERE chain = 'CA1' AND seq = 2", [e2.replace('"tool":"x"', '"tool":"y"')]);
    // A deletion inside a chain.
    await db.query("DELETE FROM dw_audit_entries WHERE chain = 'CA2' AND seq = 2");
    // A forged entry added after the last one anchored, hashed properly.
    const last = JSON.parse((await db.query<{ body: string }>("SELECT body FROM dw_audit_entries WHERE chain = 'CA3' AND seq = 3")).rows[0]!.body) as AuditEntry;
    const forgedBase = { type: 'gate', detail: {}, seq: 4, at: last.at, callId: 'CA3', channel: 'voice', prevHash: last.hash };
    await db.query("INSERT INTO dw_audit_entries (chain, seq, day, body) VALUES ('CA3', 4, '2026-10-11', $1)", [JSON.stringify({ ...forgedBase, hash: entryHash(forgedBase) })]);
    // A tail cut: CA4's last entry gone, its anchor still naming it.
    await db.query("DELETE FROM dw_audit_entries WHERE chain = 'CA4' AND seq = 3");
    const r = await verifyPostgresAudit(db);
    expect(r.breaks).toEqual([
      'call CA1: BROKEN at entry 2 (hash mismatch)',
      'call CA2: BROKEN at entry 3 (entry 2 is missing)',
      'call CA4: BROKEN at entry 3 (anchored on 2026-10-11, and not there as anchored)',
      'call CA3: BROKEN after entry 3 (1 newer entry is anchored nowhere)',
    ]);
    // An anchor of the day's chain edited: the day's chain breaks there.
    const a2 = (await db.query<{ body: string }>("SELECT body FROM dw_audit_anchors WHERE seq = 2")).rows[0]!.body;
    await db.query('UPDATE dw_audit_anchors SET body = $1 WHERE seq = 2', [a2.replace('"callSeq":3', '"callSeq":2')]);
    expect((await verifyPostgresAudit(db)).breaks).toContain('day 2026-10-11 (server): BROKEN at anchor 2 (hash mismatch)');
  });

  it('retention removes a chain whole once its newest entry is past the days, and the days\' anchors; what stays verifies', async () => {
    const day = 86_400_000;
    const t0 = Date.UTC(2026, 9, 1, 12, 0, 0);
    const { db, audit, at } = await fresh(() => t0);
    await audit.append('OLD', 'voice', draft('call_started'));
    await audit.append('SPANS', 'voice', draft('call_started'));
    await audit.append('console', 'console', draft('console_access', { event: 'live' }));
    at(t0 + 9 * day);
    await audit.append('SPANS', 'voice', draft('call_ended'));
    await audit.append('NEW', 'voice', draft('call_started'));
    expect(await audit.sweep(7, t0 + 10 * day)).toEqual({ days: 1, chains: 2, entries: 2 });
    const chains = (await db.query<{ chain: string }>('SELECT DISTINCT chain FROM dw_audit_entries ORDER BY chain')).rows.map((r) => r.chain);
    expect(chains).toEqual(['NEW', 'SPANS']);
    expect((await verifyPostgresAudit(db)).breaks).toEqual([]);
  });

  it('tables at another version are refused, naming AUDIT_STORE; tables made are read with no DDL after', async () => {
    const db = await PGlite.create();
    dbs.push(db);
    await openPostgresAudit(pgliteSql(db));
    await db.query("UPDATE dw_schema SET version = 2 WHERE name = 'audit'");
    const err = await openPostgresAudit(pgliteSql(db)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SchemaVersionError);
    expect((err as Error).message).toBe("the database's audit tables are version 2, newer than this server reads (1): run the newer server, or point AUDIT_STORE at another database");
  });

  it('a day file and the database hold the same entry for the same drafts and time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-same-'));
    try {
      const t = Date.UTC(2026, 9, 11, 12, 0, 0);
      const file = new AuditLog(dir, () => t);
      const fromFile = file.append('CA1', 'voice', draft('call_started', { channel: 'voice' }));
      const { audit } = await fresh(() => t);
      const fromDb = await audit.append('CA1', 'voice', draft('call_started', { channel: 'voice' }));
      expect(fromDb).toEqual(fromFile);
      expect(JSON.stringify(fromDb)).toBe(readFileSync(file.path, 'utf8').trim());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
