import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { NOTICE_TABLES, PostgresNotices } from './notices';
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
  const s = await openPostgresStores(pgliteSql(db), { tokenTtlMs: ctx.tokenTtlMs, now: ctx.now, leaseNow: ctx.now });
  return { ...s, leases: s.calls };
}, { describe, it, reopen: async (ctx) => openPostgresStores(pgliteSql(db), { tokenTtlMs: ctx.tokenTtlMs, now: ctx.now, leaseNow: ctx.now }) });

describe('the Postgres store through the pg driver', () => {
  // The driver against PGlite's wire server: one connection, as PGlite is one session.
  let wire: PGLiteSocketServer;
  let other: PGlite;
  let url = '';
  beforeAll(async () => {
    other = await PGlite.create();
    // Two connections at most: one check's pool may still be closing its connection as the next opens one
    // (each pool has one, used one query at a time, so they never share a transaction).
    wire = new PGLiteSocketServer({ db: other, port: 0, host: '127.0.0.1', maxConnections: 2 });
    await wire.start();
    url = `postgres://dialogwright:not-a-password@${wire.getServerConn()}/postgres`;
  }, 30_000);
  afterAll(async () => {
    await wire.stop();
    // The wire server lets its connections go on the next turn of the loop: the database outlives them.
    await new Promise((r) => setTimeout(r, 100));
    await other.close();
  });

  runStoreContract('postgres (pg)', async (ctx) => {
    const sql = await openPgClient(url, { max: 1 });
    await empty(other);
    const s = await openPostgresStores(sql, { tokenTtlMs: ctx.tokenTtlMs, now: ctx.now, leaseNow: ctx.now });
    return { ...s, leases: s.calls };
  }, { describe, it, reopen: async (ctx) => openPostgresStores(await openPgClient(url, { max: 1 }), { tokenTtlMs: ctx.tokenTtlMs, now: ctx.now, leaseNow: ctx.now }) });
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
      openPostgresStores(pgliteSql(shared), { tokenTtlMs: 600_000, now, leaseNow: now }),
      openPostgresStores(pgliteSql(shared), { tokenTtlMs: 600_000, now, leaseNow: now }),
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
    const [saved, claimed] = await Promise.all([a.calls.saveAs(contractCall('CA-save', 7, { reconnects: 0 }), 'server-a', TTL), b.calls.claim('CA-save', 'server-b', TTL)]);
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

  it("takes the password out of every connection string in a line, and changes nothing else", () => {
    const url = 'postgres://dialogwright:p%40ss@db.example:5432/dialogwright';
    expect(maskSecrets(`could not reach ${url}`, url)).toBe('could not reach postgres://dialogwright:***@db.example:5432/dialogwright');
    // A driver that quotes another form of it.
    expect(maskSecrets('invalid connection "postgresql://dialogwright:p@ss@db.example/x"', url)).toBe('invalid connection "postgresql://dialogwright:***@db.example/x"');
    // A short or common password never mangles ordinary words.
    expect(maskSecrets('auth failed for user "u" at host a', 'postgres://u:a@h/db')).toBe('auth failed for user "u" at host a');
    expect(maskSecrets('CA1: resumed at https://localhost/cr-action/twilio', 'postgres://u:a@h/db')).toBe('CA1: resumed at https://localhost/cr-action/twilio');
  });

  it('names the package to add when the driver is missing', () => {
    expect(new PgUnavailableError(new Error("Cannot find package 'pg'")).message).toBe(
      "SESSION_STORE=postgres needs the package pg, which is not installed here (Cannot find package 'pg'): run pnpm add pg (or npm install pg) in the project, or set SESSION_STORE=file:<dir> for one machine",
    );
  });
});

describe('the review of 8b1', () => {
  it("leases are timed by the database's clock: a server whose clock runs ahead never holds a call longer for it", async () => {
    const fresh = await PGlite.create();
    try {
      // No leaseNow: the database's clock, whatever the servers' say (they are not even asked).
      const a = await openPostgresStores(pgliteSql(fresh), { tokenTtlMs: 600_000, now: () => Date.now() + 60_000 });
      const b = await openPostgresStores(pgliteSql(fresh), { tokenTtlMs: 600_000, now: () => Date.now() });
      await a.calls.save(contractCall('CA-skew'));
      expect((await a.calls.claim('CA-skew', 'server-a', 300)).taken).toBe(true);
      const h = (await a.calls.holder('CA-skew'))!;
      expect(Math.abs(h.expiresAtMs - (Date.now() + 300))).toBeLessThan(250);
      expect((await b.calls.claim('CA-skew', 'server-b', 300)).taken).toBe(false);
      await new Promise((r) => setTimeout(r, 350));
      expect(await b.calls.claim('CA-skew', 'server-b', 300)).toMatchObject({ taken: true, took: 'lapsed' });
    } finally {
      await fresh.close();
    }
  });

  it('a claim that finds the lease row changing under it reads it again, and says so if it never settles', async () => {
    // A connection whose every answer is empty: the claim's insert finds a row its read did not, every time.
    const tx = { query: async () => ({ rows: [] as never[] }) };
    const sql = { query: tx.query, transaction: <T>(fn: (q: typeof tx) => Promise<T>) => fn(tx), close: async () => {} };
    const { PostgresCallStateStore } = await import('./postgres');
    const calls = new (PostgresCallStateStore as unknown as new (s: unknown, n: null, r: { skip(): void }) => { claim(id: string, o: string, t: number): Promise<unknown> })(sql, null, { skip() {} });
    await expect(calls.claim('CA1', 'b', 5000)).rejects.toThrow('the lease on "CA1" changed 3 times while it was claimed');
  });

  it('a server whose user may only read and write the tables starts once they are made (no DDL at startup)', async () => {
    const fresh = await PGlite.create();
    try {
      expect(await ensureSchema(pgliteSql(fresh))).toBe(true);
      await fresh.exec(`CREATE ROLE dw_app LOGIN; REVOKE CREATE ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO dw_app;
        GRANT SELECT, INSERT, UPDATE, DELETE ON dw_schema, dw_calls, dw_call_leases, dw_chats, dw_tokens TO dw_app; SET ROLE dw_app;`);
      expect((await fresh.query<{ u: string }>('SELECT current_user AS u')).rows).toEqual([{ u: 'dw_app' }]);
      const s = await openPostgresStores(pgliteSql(fresh), { tokenTtlMs: 1000 });
      await s.calls.save(contractCall('CA-role'));
      expect((await s.calls.claim('CA-role', 'server-a', 1000)).taken).toBe(true);
      // Tables its owner made without their version row (or one whose row was lost) are taken as they are, with no DDL.
      await fresh.exec('RESET ROLE; DELETE FROM dw_schema; SET ROLE dw_app;');
      expect(await ensureSchema(pgliteSql(fresh))).toBe(false);
      // The notices beside them, made by the owner: a user that may not create opens them with no DDL too.
      await fresh.exec(`RESET ROLE; ${NOTICE_TABLES.tables.join('; ')}; GRANT SELECT, INSERT, DELETE ON dw_notices TO dw_app; GRANT USAGE ON SEQUENCE dw_notices_id_seq TO dw_app; SET ROLE dw_app;`);
      const notices = await PostgresNotices.open(pgliteSql(fresh), { origin: 'a-1' });
      await notices.close();
      // The same user could not make them: a first start needs a user that may.
      await fresh.exec('RESET ROLE; DROP TABLE dw_schema, dw_calls, dw_call_leases, dw_chats, dw_tokens; SET ROLE dw_app;');
      await expect(ensureSchema(pgliteSql(fresh))).rejects.toThrow(/permission denied/);
    } finally {
      await fresh.close();
    }
  });

  it('every query has a deadline: a database that stops answering fails in its time', async () => {
    const never = new Promise<never>(() => {});
    const hung = { query: () => never, transaction: () => never, close: async () => {} };
    const t0 = Date.now();
    await expect(openPostgresStores(hung as never, { tokenTtlMs: 1000, timeoutMs: 150 })).rejects.toThrow('the session store did not answer within 150 ms');
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
