import { randomBytes } from 'node:crypto';
import { sameToken } from '../tokens';
import { storedCallProblem, storedChatProblem } from './file';
import type { SqlClient, SqlQueryable } from './sql';
import {
  tokenHash, type CallLeases, type CallStateStore, type ChatStateStore, type LeaseClaim, type LeaseHolder, type ServerTokenStore, type StoredCall, type StoredChat,
} from './types';

/**
 * The Postgres stores (SESSION_STORE=postgres://...): calls, chats and relay tokens in one database many
 * servers share, so any of them can take a call over when the carrier reconnects to it, with one owner
 * per call at a time (CallLeases). Each passes the contract every store does (dialogwright/testing
 * runStoreContract), run in the suite on PGlite and in the two-server test by two servers at once.
 *
 *   dw_schema        the version of these tables: made on first use, never changed silently
 *   dw_calls         one row per live call: the call as saved (JSON, as it was given) and its reconnect count
 *   dw_call_leases   one row per call a server holds: its owner and until when (ms, the servers' clock)
 *   dw_chats         one row per live chat: the chat as saved and its resume token's hash
 *   dw_tokens        one row per live relay token: its hash, carrier and expiry, never the token
 *
 * A record is kept as the JSON text it was given, not as jsonb, which would reorder its keys: a call
 * loads exactly as it was saved. The reconnect count is a column of its own beside it, so a callback
 * on any server counts a reconnect in one statement (countReconnect), and it is what a load reads.
 * A record that cannot be read is logged once and loads as absent, never a crash.
 *
 * Times are the servers' clocks (`now`), as the other stores', so the clocks of servers that share a
 * database are to agree within a second (pnpm diagnose checks the clock).
 */

/** The version of the tables this code makes and reads. A database at another refuses to open: no migration runs unasked. */
export const POSTGRES_SCHEMA_VERSION = 1;

/** The name of the row in dw_schema that holds the session tables' version. */
const SCHEMA_ROW = 'sessions';

/** The key of the advisory lock two servers starting at once take while they make the tables. */
const SCHEMA_LOCK = 0x6477_5f73; // "dw_s"

const TABLES_V1 = [
  `CREATE TABLE IF NOT EXISTS dw_calls (
    call_id text PRIMARY KEY,
    body text NOT NULL,
    reconnects integer NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS dw_call_leases (
    call_id text PRIMARY KEY,
    owner text NOT NULL,
    expires_at_ms bigint NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS dw_call_leases_owner ON dw_call_leases (owner)',
  `CREATE TABLE IF NOT EXISTS dw_chats (
    chat_id text PRIMARY KEY,
    resume_hash text NOT NULL,
    body text NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS dw_chats_resume ON dw_chats (resume_hash)',
  `CREATE TABLE IF NOT EXISTS dw_tokens (
    call_id text PRIMARY KEY,
    token_hash text NOT NULL,
    provider text NOT NULL,
    expires_at_ms bigint NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS dw_tokens_hash ON dw_tokens (token_hash)',
];

/** The database's session tables are at a version this code does not read. */
export class SchemaVersionError extends Error {
  constructor(readonly found: number, readonly known: number) {
    super(found > known
      ? `the database's session tables are version ${found}, newer than this server reads (${known}): run the newer server, or point SESSION_STORE at another database`
      : `the database's session tables are version ${found}, older than this server reads (${known}), and no migration runs unasked: point SESSION_STORE at a new database, or run the server that made them`);
    this.name = 'SchemaVersionError';
  }
}

/** The version the database's session tables are at, or null when they have not been made. */
export async function schemaVersion(sql: SqlQueryable): Promise<number | null> {
  const exists = await sql.query<{ t: string | null }>("SELECT to_regclass('dw_schema')::text AS t");
  if (exists.rows[0]?.t == null) return null;
  const r = await sql.query<{ version: number | string }>('SELECT version FROM dw_schema WHERE name = $1', [SCHEMA_ROW]);
  return r.rows.length === 0 ? null : Number(r.rows[0]!.version);
}

/**
 * Make the session tables if they are not there, under a lock so two servers starting at once make
 * them once; then the version they are at must be this code's. Returns whether they were made now.
 */
export async function ensureSchema(sql: SqlClient): Promise<boolean> {
  return sql.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [SCHEMA_LOCK]);
    await tx.query('CREATE TABLE IF NOT EXISTS dw_schema (name text PRIMARY KEY, version integer NOT NULL)');
    const found = await schemaVersion(tx);
    if (found !== null) {
      if (found !== POSTGRES_SCHEMA_VERSION) throw new SchemaVersionError(found, POSTGRES_SCHEMA_VERSION);
      return false;
    }
    for (const statement of TABLES_V1) await tx.query(statement);
    await tx.query('INSERT INTO dw_schema (name, version) VALUES ($1, $2)', [SCHEMA_ROW, POSTGRES_SCHEMA_VERSION]);
    return true;
  });
}

/** What the Postgres stores are made with. */
export interface PostgresStoreOptions {
  /** How long a relay token lives. */
  tokenTtlMs: number;
  /** The clock (default Date.now): leases' and tokens' times. */
  now?: () => number;
  /** Where a record that cannot be read, or a token write that failed, is said. */
  log?: (line: string) => void;
}

/** Records reported unreadable, so each is logged once. */
class Reported {
  private readonly seen = new Set<string>();
  constructor(private readonly log: (line: string) => void) {}
  skip(kind: string, id: string, why: string): void {
    const key = `${kind}:${id}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.log(`sessions: skipped the saved ${kind} ${JSON.stringify(id)}: ${why} (not a ${kind} this store wrote; left as it is)`);
  }
}

/** The calls, and their leases (one owner per call at a time). */
export class PostgresCallStateStore implements CallStateStore, CallLeases {
  constructor(private readonly sql: SqlClient, private readonly now: () => number, private readonly reported: Reported) {}

  /** The call in a row, with its reconnect count from its column, or null when it is not a call (logged once). */
  private read(callId: string, row: { body: string; reconnects: number | string }): StoredCall | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.body);
    } catch {
      this.reported.skip('call', callId, 'not JSON');
      return null;
    }
    const problem = storedCallProblem(parsed);
    if (problem !== null) {
      this.reported.skip('call', callId, problem);
      return null;
    }
    const call = parsed as StoredCall & { reconnects: number };
    // Assigned, not spread: the key stays where it was saved, so the call reads back as it was given.
    call.reconnects = Number(row.reconnects);
    return call.callId === callId ? call : null;
  }

  private async loadOn(q: SqlQueryable, callId: string): Promise<StoredCall | null> {
    const r = await q.query<{ body: string; reconnects: number | string }>('SELECT body, reconnects FROM dw_calls WHERE call_id = $1', [callId]);
    return r.rows.length === 0 ? null : this.read(callId, r.rows[0]!);
  }

  load(callId: string): Promise<StoredCall | null> {
    return this.loadOn(this.sql, callId);
  }

  async save(call: StoredCall): Promise<void> {
    await this.sql.query(
      `INSERT INTO dw_calls (call_id, body, reconnects) VALUES ($1, $2, $3)
       ON CONFLICT (call_id) DO UPDATE SET body = EXCLUDED.body, reconnects = EXCLUDED.reconnects`,
      [call.callId, JSON.stringify(call), call.reconnects],
    );
  }

  /** The call and its lease: it ended, or it is past its time. */
  async remove(callId: string): Promise<void> {
    await this.sql.transaction(async (tx) => {
      await tx.query('DELETE FROM dw_calls WHERE call_id = $1', [callId]);
      await tx.query('DELETE FROM dw_call_leases WHERE call_id = $1', [callId]);
    });
  }

  async list(): Promise<string[]> {
    const r = await this.sql.query<{ call_id: string }>('SELECT call_id FROM dw_calls ORDER BY call_id');
    return r.rows.map((row) => row.call_id);
  }

  async claim(callId: string, owner: string, ttlMs: number): Promise<LeaseClaim> {
    return this.sql.transaction(async (tx) => {
      const now = this.now();
      // One statement: a row locked by another claim makes this one wait, then read the row it left.
      const took = await tx.query<{ owner: string }>(
        `INSERT INTO dw_call_leases (call_id, owner, expires_at_ms) VALUES ($1, $2, $3)
         ON CONFLICT (call_id) DO UPDATE SET owner = EXCLUDED.owner, expires_at_ms = EXCLUDED.expires_at_ms
         WHERE dw_call_leases.owner = EXCLUDED.owner OR dw_call_leases.expires_at_ms <= $4
         RETURNING owner`,
        [callId, owner, now + ttlMs, now],
      );
      if (took.rows.length === 0) {
        const held = await tx.query<{ owner: string; expires_at_ms: number | string }>('SELECT owner, expires_at_ms FROM dw_call_leases WHERE call_id = $1', [callId]);
        const h = held.rows[0]!;
        return { taken: false, owner: h.owner, expiresAtMs: Number(h.expires_at_ms) };
      }
      return { taken: true, call: await this.loadOn(tx, callId) };
    });
  }

  async renew(owner: string, ttlMs: number): Promise<string[]> {
    const r = await this.sql.query<{ call_id: string }>('UPDATE dw_call_leases SET expires_at_ms = $2 WHERE owner = $1 RETURNING call_id', [owner, this.now() + ttlMs]);
    return r.rows.map((row) => row.call_id);
  }

  async release(callId: string, owner: string): Promise<void> {
    await this.sql.query('DELETE FROM dw_call_leases WHERE call_id = $1 AND owner = $2', [callId, owner]);
  }

  async holder(callId: string): Promise<LeaseHolder | null> {
    const r = await this.sql.query<{ owner: string; expires_at_ms: number | string }>('SELECT owner, expires_at_ms FROM dw_call_leases WHERE call_id = $1', [callId]);
    const h = r.rows[0];
    return h === undefined ? null : { owner: h.owner, expiresAtMs: Number(h.expires_at_ms) };
  }

  async saveAs(call: StoredCall, owner: string, ttlMs: number): Promise<boolean> {
    return this.sql.transaction(async (tx) => {
      // The lease row stays locked until the save is in: a claim by another server waits for it.
      const held = await tx.query('UPDATE dw_call_leases SET expires_at_ms = $3 WHERE call_id = $1 AND owner = $2 RETURNING owner', [call.callId, owner, this.now() + ttlMs]);
      if (held.rows.length === 0) return false;
      await tx.query(
        `INSERT INTO dw_calls (call_id, body, reconnects) VALUES ($1, $2, $3)
         ON CONFLICT (call_id) DO UPDATE SET body = EXCLUDED.body, reconnects = GREATEST(dw_calls.reconnects, EXCLUDED.reconnects)`,
        [call.callId, JSON.stringify(call), call.reconnects],
      );
      return true;
    });
  }

  async countReconnect(callId: string, limit: number): Promise<{ before: number; counted: boolean } | null> {
    const counted = await this.sql.query<{ reconnects: number | string }>('UPDATE dw_calls SET reconnects = reconnects + 1 WHERE call_id = $1 AND reconnects < $2 RETURNING reconnects', [callId, limit]);
    if (counted.rows.length > 0) return { before: Number(counted.rows[0]!.reconnects) - 1, counted: true };
    const r = await this.sql.query<{ reconnects: number | string }>('SELECT reconnects FROM dw_calls WHERE call_id = $1', [callId]);
    return r.rows.length === 0 ? null : { before: Number(r.rows[0]!.reconnects), counted: false };
  }

  async removeUnleased(callId: string): Promise<boolean> {
    return this.sql.transaction(async (tx) => {
      const now = this.now();
      const gone = await tx.query(
        `DELETE FROM dw_calls WHERE call_id = $1
         AND NOT EXISTS (SELECT 1 FROM dw_call_leases WHERE call_id = $1 AND expires_at_ms > $2)
         RETURNING call_id`,
        [callId, now],
      );
      await tx.query('DELETE FROM dw_call_leases WHERE call_id = $1 AND expires_at_ms <= $2', [callId, now]);
      return gone.rows.length > 0;
    });
  }
}

export class PostgresChatStateStore implements ChatStateStore {
  constructor(private readonly sql: SqlClient, private readonly reported: Reported) {}

  private read(id: string, body: string): StoredChat | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      this.reported.skip('chat', id, 'not JSON');
      return null;
    }
    const problem = storedChatProblem(parsed);
    if (problem !== null) {
      this.reported.skip('chat', id, problem);
      return null;
    }
    return parsed as StoredChat;
  }

  async load(id: string): Promise<StoredChat | null> {
    const r = await this.sql.query<{ body: string }>('SELECT body FROM dw_chats WHERE chat_id = $1', [id]);
    const chat = r.rows.length === 0 ? null : this.read(id, r.rows[0]!.body);
    return chat !== null && chat.id === id ? chat : null;
  }

  async findByResume(resumeHash: string): Promise<StoredChat | null> {
    const r = await this.sql.query<{ chat_id: string; body: string }>('SELECT chat_id, body FROM dw_chats WHERE resume_hash = $1 ORDER BY chat_id LIMIT 1', [resumeHash]);
    const row = r.rows[0];
    return row === undefined ? null : this.read(row.chat_id, row.body);
  }

  async save(chat: StoredChat): Promise<void> {
    await this.sql.query(
      `INSERT INTO dw_chats (chat_id, resume_hash, body) VALUES ($1, $2, $3)
       ON CONFLICT (chat_id) DO UPDATE SET resume_hash = EXCLUDED.resume_hash, body = EXCLUDED.body`,
      [chat.id, chat.resumeHash, JSON.stringify(chat)],
    );
  }

  async remove(id: string): Promise<void> {
    await this.sql.query('DELETE FROM dw_chats WHERE chat_id = $1', [id]);
  }

  async list(): Promise<string[]> {
    const r = await this.sql.query<{ chat_id: string }>('SELECT chat_id FROM dw_chats ORDER BY chat_id');
    return r.rows.map((row) => row.chat_id);
  }
}

/** The carrier a token is minted for when none is named: the legacy `/voice` is Twilio's (as server/tokens.ts). */
const LEGACY_TOKEN_PROVIDER = 'twilio';

/**
 * The relay tokens, each as its hash. `mint` and `revoke` answer at once, as the server needs
 * (ServerTokenStore), and write behind, one write after another in the order they were asked;
 * `settled(callId)` is when a call's last write has landed (and rejects when it failed), which the
 * carrier's callback awaits before it hands out a token, so the server the socket reaches can read it.
 * `verify`, `has` and `evictExpired` wait for the writes before them.
 */
export class PostgresTokenStore implements ServerTokenStore {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly pending = new Map<string, Promise<void>>();

  constructor(
    private readonly sql: SqlClient,
    private readonly ttlMs: number,
    private readonly now: () => number,
    private readonly log: (line: string) => void,
  ) {}

  private write(callId: string, what: string, text: string, params: readonly unknown[]): void {
    const run = this.chain.then(() => this.sql.query(text, params)).then(() => undefined);
    this.chain = run.catch(() => undefined);
    this.pending.set(callId, run);
    void run
      .catch((err: unknown) => this.log(`${callId}: could not ${what} the relay token: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        if (this.pending.get(callId) === run) this.pending.delete(callId);
      });
  }

  mint(callId: string, provider: string = LEGACY_TOKEN_PROVIDER): string {
    const token = randomBytes(16).toString('hex');
    this.write(callId, 'save', `INSERT INTO dw_tokens (call_id, token_hash, provider, expires_at_ms) VALUES ($1, $2, $3, $4)
      ON CONFLICT (call_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, provider = EXCLUDED.provider, expires_at_ms = EXCLUDED.expires_at_ms`,
    [callId, tokenHash(token), provider, this.now() + this.ttlMs]);
    return token;
  }

  revoke(callId: string): void {
    this.write(callId, 'remove', 'DELETE FROM dw_tokens WHERE call_id = $1', [callId]);
  }

  /** A call's last mint or revoke landed (rejecting when it failed); with no call, every write so far, failed or not. */
  async settled(callId?: string): Promise<void> {
    if (callId === undefined) {
      await this.chain;
      return;
    }
    await this.pending.get(callId);
  }

  async verify(token: string, callId: string, provider: string): Promise<boolean> {
    await this.chain;
    const r = await this.sql.query<{ token_hash: string; provider: string; expires_at_ms: number | string }>('SELECT token_hash, provider, expires_at_ms FROM dw_tokens WHERE call_id = $1', [callId]);
    const row = r.rows[0];
    if (row === undefined) return false;
    const expiresAt = Number(row.expires_at_ms);
    if (this.now() > expiresAt) {
      await this.sql.query('DELETE FROM dw_tokens WHERE call_id = $1 AND expires_at_ms = $2', [callId, expiresAt]);
      return false;
    }
    return sameToken(row.token_hash, tokenHash(token)) && row.provider === provider;
  }

  async has(token: string, provider: string): Promise<boolean> {
    await this.chain;
    const r = await this.sql.query<{ call_id: string; provider: string; expires_at_ms: number | string }>('SELECT call_id, provider, expires_at_ms FROM dw_tokens WHERE token_hash = $1 LIMIT 1', [tokenHash(token)]);
    const row = r.rows[0];
    if (row === undefined) return false;
    const expiresAt = Number(row.expires_at_ms);
    if (this.now() > expiresAt) {
      await this.sql.query('DELETE FROM dw_tokens WHERE call_id = $1 AND expires_at_ms = $2', [row.call_id, expiresAt]);
      return false;
    }
    return row.provider === provider;
  }

  async evictExpired(): Promise<number> {
    await this.chain;
    const r = await this.sql.query('DELETE FROM dw_tokens WHERE expires_at_ms < $1 RETURNING call_id', [this.now()]);
    return r.rows.length;
  }
}

/** The Postgres stores over one client, as SESSION_STORE=postgres://... opens them. */
export interface PostgresStores {
  readonly calls: PostgresCallStateStore;
  readonly chats: PostgresChatStateStore;
  readonly tokens: PostgresTokenStore;
  /** The token writes behind, landed; then the client closed. */
  close(): Promise<void>;
}

/**
 * The stores over `sql`, once the session tables are there at this code's version (made on first use;
 * a SchemaVersionError for any other). The client is the caller's: `close` closes it.
 */
export async function openPostgresStores(sql: SqlClient, o: PostgresStoreOptions): Promise<PostgresStores> {
  const log = o.log ?? (() => {});
  const now = o.now ?? Date.now;
  const made = await ensureSchema(sql);
  if (made) log(`sessions: made the session tables in Postgres (version ${POSTGRES_SCHEMA_VERSION})`);
  const reported = new Reported(log);
  const tokens = new PostgresTokenStore(sql, o.tokenTtlMs, now, log);
  return {
    calls: new PostgresCallStateStore(sql, now, reported),
    chats: new PostgresChatStateStore(sql, reported),
    tokens,
    close: async () => {
      await tokens.settled();
      await sql.close();
    },
  };
}
