import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { runStoreContract, contractCall, CONTRACT_LEASE_TTL_MS } from '../../testing/storeContract';
import { ensureSchema, openPostgresStores, POSTGRES_SCHEMA_VERSION, schemaVersion, SchemaVersionError, type PostgresStores } from './postgres';
import { pgliteSql } from './pgliteSql';
import { maskConnectionString, maskSecrets, openPgClient, PgUnavailableError } from './sql';

/**
 * The Postgres stores, run on PGlite (Postgres in WebAssembly): the contract every store passes, then
 * what only a store many servers share has to show, with two servers' stores over one database.
 */

/** Every table the stores keep, emptied before each check, so one database serves every check. */
const TABLES = ['dw_calls', 'dw_call_leases', 'dw_chats', 'dw_tokens'];

let db: PGlite;
beforeAll(async () => {
  db = await PGlite.create();
}, 30_000);
afterAll(async () => {
  await db.close();
});

async function empty(on: PGlite): Promise<void> {
  if ((await schemaVersion(pgliteSql(on))) === null) return;
  for (const t of TABLES) await on.query(`DELETE FROM ${t}`);
}

runStoreContract('postgres (PGlite)', async (ctx) => {
  await empty(db);
  const s = await openPostgresStores(pgliteSql(db), { tokenTtlMs: ctx.tokenTtlMs, now: ctx.now });
  return { ...s, leases: s.calls };
}, { describe, it, reopen: async (ctx) => openPostgresStores(pgliteSql(db), { tokenTtlMs: ctx.tokenTtlMs, now: ctx.now }) });

describe('the Postgres store through the pg driver', () => {
  // The driver against PGlite's wire server: one connection, as PGlite is one session.
  let wire: PGLiteSocketServer;
  let other: PGlite;
  let url = '';
  beforeAll(async () => {
    other = await PGlite.create();
    wire = new PGLiteSocketServer({ db: other, port: 0, host: '127.0.0.1' });
    await wire.start();
    url = `postgres://dialogwright:not-a-password@${wire.getServerConn()}/postgres`;
  }, 30_000);
  afterAll(async () => {
    await wire.stop();
    await other.close();
  });

  runStoreContract('postgres (pg)', async (ctx) => {
    const sql = await openPgClient(url, { max: 1 });
    await empty(other);
    const s = await openPostgresStores(sql, { tokenTtlMs: ctx.tokenTtlMs, now: ctx.now });
    return { ...s, leases: s.calls };
  }, { describe, it, reopen: async (ctx) => openPostgresStores(await openPgClient(url, { max: 1 }), { tokenTtlMs: ctx.tokenTtlMs, now: ctx.now }) });
});

describe('two servers over one Postgres', () => {
  let shared: PGlite;
  let a: PostgresStores;
  let b: PostgresStores;
  let t = 1_700_000_000_000;
  const now = (): number => t;
  const TTL = CONTRACT_LEASE_TTL_MS;
  beforeAll(async () => {
    shared = await PGlite.create();
    // Two clients, as two servers each have their own connection to the one database.
    [a, b] = await Promise.all([
      openPostgresStores(pgliteSql(shared), { tokenTtlMs: 600_000, now }),
      openPostgresStores(pgliteSql(shared), { tokenTtlMs: 600_000, now }),
    ]);
  }, 30_000);
  afterAll(async () => {
    await shared.close();
  });

  it('race to take one call: exactly one wins, and the other is told who holds it', async () => {
    await empty(shared);
    await a.calls.save(contractCall('CA-race'));
    const [x, y] = await Promise.all([a.calls.claim('CA-race', 'server-a', TTL), b.calls.claim('CA-race', 'server-b', TTL)]);
    expect([x.taken, y.taken].filter(Boolean)).toHaveLength(1);
    const winner = x.taken ? 'server-a' : 'server-b';
    const loser = x.taken ? y : x;
    expect(loser).toEqual({ taken: false, owner: winner, expiresAtMs: t + TTL });
    // The winner read the call in the same step that took it.
    expect((x.taken ? x : y)).toMatchObject({ taken: true, call: { callId: 'CA-race' } });
  });

  it('a lapsed lease (a server that crashed) is taken over; its old holder can no longer save', async () => {
    await empty(shared);
    await a.calls.save(contractCall('CA-crash'));
    expect((await a.calls.claim('CA-crash', 'server-a', TTL)).taken).toBe(true);
    t += TTL - 1;
    expect((await b.calls.claim('CA-crash', 'server-b', TTL)).taken).toBe(false);
    t += 1;
    expect((await b.calls.claim('CA-crash', 'server-b', TTL)).taken).toBe(true);
    expect(await a.calls.saveAs(contractCall('CA-crash', 9), 'server-a', TTL)).toBe(false);
    expect((await b.calls.load('CA-crash'))?.session.turnIndex).toBe(3);
  });

  it('a released lease (a server that drained) is taken at once', async () => {
    await empty(shared);
    await a.calls.claim('CA-drain', 'server-a', TTL);
    expect((await b.calls.claim('CA-drain', 'server-b', TTL)).taken).toBe(false);
    await a.calls.release('CA-drain', 'server-a');
    expect((await b.calls.claim('CA-drain', 'server-b', TTL)).taken).toBe(true);
  });

  it('renewal keeps a lease past its first lifetime', async () => {
    await empty(shared);
    await a.calls.claim('CA-renew', 'server-a', TTL);
    for (let i = 0; i < 5; i++) {
      t += TTL / 3;
      expect(await a.calls.renew('server-a', TTL)).toEqual(['CA-renew']);
      expect((await b.calls.claim('CA-renew', 'server-b', TTL)).taken).toBe(false);
    }
  });

  it("a save renews the holder's lease: a claim racing it is refused, and the next owner reads what it saved", async () => {
    await empty(shared);
    await a.calls.claim('CA-save', 'server-a', TTL);
    // The lease is about to lapse when the last turn saves.
    t += TTL - 1;
    const [saved, claimed] = await Promise.all([a.calls.saveAs(contractCall('CA-save', 7), 'server-a', TTL), b.calls.claim('CA-save', 'server-b', TTL)]);
    expect(saved).toBe(true);
    expect(claimed.taken).toBe(false);
    // Past the first lifetime, the save's renewal still holds it.
    t += 2;
    expect((await b.calls.claim('CA-save', 'server-b', TTL)).taken).toBe(false);
    await a.calls.release('CA-save', 'server-a');
    expect(await b.calls.claim('CA-save', 'server-b', TTL)).toMatchObject({ taken: true, call: { session: { turnIndex: 7 } } });
  });

  it('reconnects counted by both servers at once are each counted once, up to the limit', async () => {
    await empty(shared);
    await a.calls.save(contractCall('CA-count', 3, { reconnects: 0 }));
    const counts = await Promise.all([0, 1, 2, 3].map((i) => (i % 2 === 0 ? a : b).calls.countReconnect('CA-count', 2)));
    expect(counts.filter((c) => c?.counted).map((c) => c!.before).sort()).toEqual([0, 1]);
    expect((await b.calls.load('CA-count'))?.reconnects).toBe(2);
  });

  it("a token one server mints is the other's to verify once the write has landed", async () => {
    await empty(shared);
    const token = a.tokens.mint('CA-token', 'telnyx');
    await a.tokens.settled('CA-token');
    expect(await b.tokens.verify(token, 'CA-token', 'telnyx')).toBe(true);
    expect(await b.tokens.has(token, 'telnyx')).toBe(true);
    b.tokens.revoke('CA-token');
    await b.tokens.settled('CA-token');
    expect(await a.tokens.verify(token, 'CA-token', 'telnyx')).toBe(false);
  });
});

describe('the session tables', () => {
  it('are made on first use at this version, once however many servers start at once', async () => {
    const fresh = await PGlite.create();
    try {
      expect(await schemaVersion(pgliteSql(fresh))).toBeNull();
      const made = await Promise.all([ensureSchema(pgliteSql(fresh)), ensureSchema(pgliteSql(fresh)), ensureSchema(pgliteSql(fresh))]);
      expect(made.filter(Boolean)).toHaveLength(1);
      expect(await schemaVersion(pgliteSql(fresh))).toBe(POSTGRES_SCHEMA_VERSION);
      const logs: string[] = [];
      await openPostgresStores(pgliteSql(fresh), { tokenTtlMs: 1000, log: (l) => logs.push(l) });
      expect(logs).toEqual([]);
    } finally {
      await fresh.close();
    }
  });

  it('refuse to open at a newer version, saying what to do, and change nothing', async () => {
    const fresh = await PGlite.create();
    try {
      await ensureSchema(pgliteSql(fresh));
      await fresh.query('UPDATE dw_schema SET version = 2');
      const opened = openPostgresStores(pgliteSql(fresh), { tokenTtlMs: 1000 });
      await expect(opened).rejects.toThrow(SchemaVersionError);
      await expect(opened).rejects.toThrow("the database's session tables are version 2, newer than this server reads (1): run the newer server, or point SESSION_STORE at another database");
      expect(await schemaVersion(pgliteSql(fresh))).toBe(2);
      await fresh.query('UPDATE dw_schema SET version = 0');
      await expect(openPostgresStores(pgliteSql(fresh), { tokenTtlMs: 1000 })).rejects.toThrow('no migration runs unasked');
    } finally {
      await fresh.close();
    }
  });

  it('log a saved call that cannot be read once, and load it as absent', async () => {
    const fresh = await PGlite.create();
    try {
      const logs: string[] = [];
      const s = await openPostgresStores(pgliteSql(fresh), { tokenTtlMs: 1000, log: (l) => logs.push(l) });
      await fresh.query("INSERT INTO dw_calls (call_id, body, reconnects) VALUES ('CA-bad', '{\"half\":', 0), ('CA-odd', '{\"callId\":\"CA-odd\"}', 0)");
      expect(await s.calls.load('CA-bad')).toBeNull();
      expect(await s.calls.load('CA-bad')).toBeNull();
      expect(await s.calls.load('CA-odd')).toBeNull();
      expect(logs.slice(1)).toEqual([
        'sessions: skipped the saved call "CA-bad": not JSON (not a call this store wrote; left as it is)',
        'sessions: skipped the saved call "CA-odd": no provider (not a call this store wrote; left as it is)',
      ]);
    } finally {
      await fresh.close();
    }
  });
});

describe('a connection string as it is said', () => {
  it('never has its password', () => {
    expect(maskConnectionString('postgres://dialogwright:s3cret@db.example:5432/dialogwright')).toBe('postgres://dialogwright:***@db.example:5432/dialogwright');
    expect(maskConnectionString('postgresql://db.example/dialogwright?user=dw&password=s3cret&sslmode=require')).toBe('postgresql://db.example/dialogwright?user=dw&password=***&sslmode=require');
    expect(maskConnectionString('postgres://db.example/dialogwright')).toBe('postgres://db.example/dialogwright');
    expect(maskConnectionString('postgres://dw:s3cret@[bad')).not.toContain('s3cret');
  });

  it("takes the password out of a driver's message", () => {
    const url = 'postgres://dialogwright:p%40ss@db.example:5432/dialogwright';
    expect(maskSecrets(`could not reach ${url}: password p@ss refused`, url)).toBe('could not reach postgres://dialogwright:***@db.example:5432/dialogwright: password *** refused');
  });

  it('names the package to add when the driver is missing', () => {
    expect(new PgUnavailableError(new Error("Cannot find package 'pg'")).message).toBe(
      "SESSION_STORE=postgres needs the package pg, which is not installed here (Cannot find package 'pg'): run pnpm add pg (or npm install pg) in the project, or set SESSION_STORE=file:<dir> for one machine",
    );
  });
});
