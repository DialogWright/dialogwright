import { ensureTables, type TablePart } from './postgres';
import { boundedSql, DEFAULT_SQL_TIMEOUT_MS, type SqlClient } from './sql';

/**
 * Notices between the servers on one database (SESSION_STORE=postgres://...): the console's events, so
 * one console sees every server's calls, and a chat resumed on another server, so the one that had it
 * closes its socket. A notice is a row (dw_notices: its topic, the server that sent it, its body) and a
 * NOTIFY naming the row's id, since a NOTIFY's payload is at most 8000 bytes and a console event (a
 * turn's record) can be larger. Each server LISTENs, reads the rows it has not seen, and hands each one
 * another server sent to the topic's subscribers. Rows are swept after a few minutes: a notice is for
 * now, never a record (the audit and the traces are).
 *
 * The bodies are what the sender would have handed its own subscribers: the console's events as
 * redacted as they are on one machine (dashboard/observer.ts, events.ts), and a chat's id.
 */

export const NOTICES_SCHEMA_VERSION = 1;

export const NOTICE_TABLES: TablePart = {
  row: 'notices',
  version: NOTICES_SCHEMA_VERSION,
  what: 'notice tables',
  setting: 'SESSION_STORE',
  tables: [
    `CREATE TABLE IF NOT EXISTS dw_notices (
      id bigserial PRIMARY KEY,
      topic text NOT NULL,
      origin text NOT NULL,
      body text NOT NULL,
      at_ms bigint NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS dw_notices_at ON dw_notices (at_ms)',
  ],
};

/** The channel every server LISTENs on; its payload is a row's id. */
export const NOTICE_CHANNEL = 'dw_notices';
/** How long a notice is kept for a server that reads late. */
export const NOTICE_KEEP_MS = 10 * 60_000;
/** How often a server reads the notices whether or not a NOTIFY came (one lost with a connection, say). */
export const NOTICE_CATCH_UP_MS = 30_000;
/** The database's clock, in ms: what a notice is stamped and swept by. */
const DB_NOW = '(extract(epoch from clock_timestamp()) * 1000)::bigint';
/**
 * How far back by id a read looks again for a row it has not seen: ids are taken in insert order but
 * become visible in commit order, so a row with a smaller id may appear just after a larger one.
 */
const LOOKBACK = 256;

type Num = number | string;

export interface NoticesOptions {
  /** This server's name: its own notices are not handed back to it. */
  origin: string;
  log?: (line: string) => void;
  now?: () => number;
  timeoutMs?: number;
  /** How often to read whether or not a NOTIFY came; default NOTICE_CATCH_UP_MS. */
  catchUpMs?: number;
}

export class PostgresNotices {
  private readonly subscribers = new Map<string, Set<(body: string, origin: string, id: number) => void>>();
  private catchUp: ReturnType<typeof setInterval> | null = null;
  private lastId = 0;
  private readonly seen = new Set<number>();
  private reading: Promise<void> | null = null;
  private again = false;
  private sending: Promise<void> = Promise.resolve();
  private stop: (() => Promise<void>) | null = null;
  private closed = false;
  /** Notices that could not be sent, since start. */
  failures = 0;

  private constructor(private readonly sql: SqlClient, private readonly o: NoticesOptions) {}

  /** The notices over `given` (the session store's client): the table made on first use, and LISTEN started. */
  static async open(given: SqlClient, o: NoticesOptions): Promise<PostgresNotices> {
    const sql = boundedSql(given, o.timeoutMs ?? DEFAULT_SQL_TIMEOUT_MS);
    if (await ensureTables(sql, NOTICE_TABLES)) o.log?.(`notices: made the notice table in Postgres (version ${NOTICES_SCHEMA_VERSION})`);
    const n = new PostgresNotices(sql, o);
    const r = await sql.query<{ id: Num | null }>('SELECT max(id) AS id FROM dw_notices');
    n.lastId = Number(r.rows[0]?.id ?? 0);
    // What is there already was for the servers running before this one: seen, never handed on.
    const before = await sql.query<{ id: Num }>('SELECT id FROM dw_notices WHERE id > $1', [Math.max(0, n.lastId - LOOKBACK)]);
    for (const row of before.rows) n.seen.add(Number(row.id));
    if (!given.listen) throw new Error('the session store\'s connection cannot LISTEN');
    n.stop = await given.listen(NOTICE_CHANNEL, () => n.read(), (err) => o.log?.(`notices: the listening connection failed (${err.message}); opening another`));
    n.catchUp = setInterval(() => n.read(), o.catchUpMs ?? NOTICE_CATCH_UP_MS);
    n.catchUp.unref?.();
    return n;
  }

  /** `fn` with each notice of `topic` another server sends (and its id, which orders all notices); returns what stops it. */
  subscribe(topic: string, fn: (body: string, origin: string, id: number) => void): () => void {
    const set = this.subscribers.get(topic) ?? new Set();
    set.add(fn);
    this.subscribers.set(topic, set);
    return () => {
      set.delete(fn);
    };
  }

  /**
   * Send a notice to the other servers: in the order sent from here, in the background; a failure is
   * logged and counted, never thrown. Resolves to the notice's id (null when it could not be sent):
   * ids order every server's notices.
   */
  publish(topic: string, body: string): Promise<number | null> {
    if (this.closed) return Promise.resolve(null);
    const sent = this.sending.then(async (): Promise<number | null> => {
      try {
        const r = await this.sql.query<{ id: Num }>(
          `WITH r AS (INSERT INTO dw_notices (topic, origin, body, at_ms) VALUES ($1, $2, $3, ${DB_NOW}) RETURNING id)
           SELECT id, pg_notify('${NOTICE_CHANNEL}', id::text) FROM r`,
          [topic, this.o.origin, body],
        );
        return Number(r.rows[0]!.id);
      } catch (err) {
        this.failures += 1;
        if (this.failures === 1 || this.failures % 100 === 0) this.o.log?.(`notices: a ${topic} notice could not be sent (${err instanceof Error ? err.message : String(err)}); ${this.failures} so far`);
        return null;
      }
    });
    this.sending = sent.then(() => undefined);
    return sent;
  }

  /** Every notice sent from here so far, done. */
  async settled(): Promise<void> {
    await this.sending;
  }

  /** The rows not yet seen, read and handed on; one read at a time, another after it when asked meanwhile. */
  private read(): void {
    if (this.closed) return;
    if (this.reading !== null) {
      this.again = true;
      return;
    }
    this.reading = this.readOnce()
      .catch((err: unknown) => this.o.log?.(`notices: could not read the notices (${err instanceof Error ? err.message : String(err)})`))
      .finally(() => {
        this.reading = null;
        if (this.again) {
          this.again = false;
          this.read();
        }
      });
  }

  private async readOnce(): Promise<void> {
    const low = Math.max(0, this.lastId - LOOKBACK);
    const ids = (await this.sql.query<{ id: Num }>('SELECT id FROM dw_notices WHERE id > $1 ORDER BY id', [low])).rows.map((r) => Number(r.id));
    const fresh = ids.filter((id) => !this.seen.has(id));
    if (fresh.length === 0) return;
    const rows = await this.sql.query<{ id: Num; topic: string; origin: string; body: string }>(
      `SELECT id, topic, origin, body FROM dw_notices WHERE id IN (${fresh.map((_, i) => `$${i + 1}`).join(', ')}) ORDER BY id`,
      fresh,
    );
    for (const row of rows.rows) {
      const id = Number(row.id);
      if (this.seen.has(id)) continue;
      this.seen.add(id);
      this.lastId = Math.max(this.lastId, id);
      if (row.origin === this.o.origin) continue;
      for (const fn of this.subscribers.get(row.topic) ?? []) {
        try {
          fn(row.body, row.origin, id);
        } catch {
          // A subscriber that throws never stops the others.
        }
      }
    }
    for (const id of this.seen) if (id <= this.lastId - LOOKBACK) this.seen.delete(id);
  }

  /** Notices older than NOTICE_KEEP_MS by the database's clock removed (any server may; each does it with its sweep). `aheadMs` moves that clock, for a test. */
  async sweep(aheadMs = 0): Promise<number> {
    const r = await this.sql.query<{ id: Num }>(`DELETE FROM dw_notices WHERE at_ms < ${DB_NOW} + $1::bigint - $2::bigint RETURNING id`, [aheadMs, NOTICE_KEEP_MS]);
    return r.rows.length;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.catchUp !== null) clearInterval(this.catchUp);
    await this.sending.catch(() => undefined);
    await this.stop?.().catch(() => undefined);
    await this.reading?.catch(() => undefined);
  }
}
