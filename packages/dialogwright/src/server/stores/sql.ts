/**
 * The little of a SQL connection the Postgres stores (stores/postgres.ts) use, so the same code runs on
 * the `pg` driver against a real Postgres and, in the engine's tests, on PGlite (Postgres compiled to
 * WebAssembly, in the process: stores/pgliteSql.ts), with nothing installed to develop it.
 *
 * Parameters are positional (`$1`, `$2`); a bigint column may come back as a number (PGlite) or a
 * string (`pg`), so a store reads every number through Number().
 */

/** A connection, or a transaction on one, that answers a query. */
export interface SqlQueryable {
  query<R = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<{ rows: R[] }>;
}

export interface SqlClient extends SqlQueryable {
  /** `fn` in one transaction on one connection: committed when it resolves, rolled back when it throws. */
  transaction<T>(fn: (tx: SqlQueryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  /**
   * LISTEN on `channel` (a fixed identifier, never a caller's) on a connection of its own, kept open
   * and opened again when it fails: `onNotify` gets each NOTIFY's payload, and an empty payload each
   * time the connection is (re)opened, when a notice may have been missed. Resolves to what stops it.
   * Absent on a client that cannot listen.
   */
  listen?(channel: string, onNotify: (payload: string) => void, onError?: (err: Error) => void): Promise<() => Promise<void>>;
}

/** The driver the server runs Postgres on: an optional dependency, imported only when SESSION_STORE names Postgres. */
export const PG_PACKAGE = 'pg';

/** The `pg` package is not installed (or did not load). */
export class PgUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`SESSION_STORE=postgres needs the package ${PG_PACKAGE}, which is not installed here (${cause instanceof Error ? cause.message : String(cause)}): run pnpm add ${PG_PACKAGE} (or npm install ${PG_PACKAGE}) in the project, or set SESSION_STORE=file:<dir> for one machine`);
    this.name = 'PgUnavailableError';
  }
}

/** What the stores read of the `pg` package. */
interface PgPoolClient {
  query(text: string, params?: readonly unknown[]): Promise<{ rows: unknown[] }>;
  release(err?: Error | boolean): void;
  on(event: 'notification', listener: (m: { channel: string; payload?: string }) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
}
interface PgPool {
  query(text: string, params?: readonly unknown[]): Promise<{ rows: unknown[] }>;
  connect(): Promise<PgPoolClient>;
  end(): Promise<void>;
  on(event: 'error', listener: (err: Error) => void): unknown;
}
interface PgModule {
  Pool: new (config: {
    connectionString: string; max?: number; connectionTimeoutMillis?: number; application_name?: string;
    query_timeout?: number; statement_timeout?: number; keepAlive?: boolean;
  }) => PgPool;
}

/** The `pg` package, imported on first use; a PgUnavailableError when it is not there. */
export async function loadPg(): Promise<PgModule> {
  // A variable specifier: the type checker and bundlers do not look for an optional package.
  const specifier: string = PG_PACKAGE;
  let mod: { Pool?: unknown; default?: { Pool?: unknown } };
  try {
    mod = (await import(specifier)) as typeof mod;
  } catch (error) {
    throw new PgUnavailableError(error);
  }
  const Pool = mod.Pool ?? mod.default?.Pool;
  if (typeof Pool !== 'function') throw new PgUnavailableError(new Error('it has no Pool'));
  return { Pool: Pool as PgModule['Pool'] };
}

export interface PgClientOptions {
  /** The most connections the pool opens; default 10. */
  max?: number;
  /** How long a connection may take to open; default 5000 ms. */
  connectTimeoutMs?: number;
  /**
   * How long a query may take, on the client (query_timeout: a database that stops answering, its
   * connection kept alive but silent) and on the server (statement_timeout); default 2000 ms
   * (SESSION_STORE_TIMEOUT_MS). TCP keepalive is on, so a dead connection is found too.
   */
  queryTimeoutMs?: number;
  /** Where a connection's own failure (one the pool held idle) is said: masked, never thrown. */
  log?: (line: string) => void;
}

/** How long a query to the session store may take, unless SESSION_STORE_TIMEOUT_MS says otherwise. */
export const DEFAULT_SQL_TIMEOUT_MS = 2_000;

/** A query to the session store that did not answer in time. */
export class SqlTimeoutError extends Error {
  constructor(ms: number) {
    super(`the session store did not answer within ${ms} ms`);
    this.name = 'SqlTimeoutError';
  }
}

/** `p`, or a SqlTimeoutError once `ms` have passed (the work itself may still finish, unseen). */
export function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SqlTimeoutError(ms)), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * `sql` with a deadline on every query and transaction, on this side of the wire: whatever the driver
 * does, a store that stops answering fails in `ms` rather than hold a caller in silence. A transaction
 * that times out here may still commit there; what depends on one (a lease) is made safe for it by
 * its renewal (a lease this server holds but does not run is given up).
 */
export function boundedSql(sql: SqlClient, ms: number): SqlClient {
  return {
    query: (text, params) => within(sql.query(text, params), ms),
    transaction: (fn) => within(sql.transaction(fn), ms),
    close: () => sql.close(),
    ...(sql.listen ? { listen: sql.listen.bind(sql) } : {}),
  };
}

/** A channel name LISTEN takes as it is: letters, digits and underscores, never from outside. */
const CHANNEL = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * A SqlClient on the `pg` driver over a pool. A connection that fails while idle is logged, never
 * thrown (an 'error' nobody listens for would stop the process), and the pool opens another.
 */
export async function openPgClient(url: string, o: PgClientOptions = {}): Promise<SqlClient> {
  const { Pool } = await loadPg();
  const queryTimeoutMs = o.queryTimeoutMs ?? DEFAULT_SQL_TIMEOUT_MS;
  const pool = new Pool({
    connectionString: url, max: o.max ?? 10, connectionTimeoutMillis: o.connectTimeoutMs ?? 5_000, application_name: 'dialogwright',
    query_timeout: queryTimeoutMs, statement_timeout: queryTimeoutMs, keepAlive: true,
  });
  pool.on('error', (err) => o.log?.(`sessions: a Postgres connection failed while idle: ${maskSecrets(err.message, url)}`));
  const query = async <R>(text: string, params?: readonly unknown[]): Promise<{ rows: R[] }> => {
    const r = await pool.query(text, params as unknown[] | undefined);
    return { rows: r.rows as R[] };
  };
  return {
    query,
    async transaction<T>(fn: (tx: SqlQueryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      let broken = false;
      try {
        await client.query('BEGIN');
        const result = await fn({ query: async <R>(text: string, params?: readonly unknown[]) => ({ rows: (await client.query(text, params)).rows as R[] }) });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // A connection that cannot roll back is not handed out again.
          broken = true;
        }
        throw err;
      } finally {
        client.release(broken);
      }
    },
    close: () => pool.end(),
    async listen(channel, onNotify, onError) {
      if (!CHANNEL.test(channel)) throw new Error(`not a channel name: ${channel}`);
      let stopped = false;
      let client: PgPoolClient | null = null;
      let retry: ReturnType<typeof setTimeout> | null = null;
      const open = async (): Promise<void> => {
        const c = await pool.connect();
        c.on('notification', (m) => {
          if (m.channel === channel) onNotify(m.payload ?? '');
        });
        c.on('error', (err) => {
          onError?.(err);
          if (client === c) client = null;
          c.release(true);
          again();
        });
        try {
          await c.query(`LISTEN ${channel}`);
        } catch (err) {
          c.release(true);
          throw err;
        }
        if (stopped) {
          c.release(true);
          return;
        }
        client = c;
        // Anything sent while no connection listened is read now.
        onNotify('');
      };
      const again = (): void => {
        if (stopped || retry !== null) return;
        retry = setTimeout(() => {
          retry = null;
          open().catch((err: unknown) => {
            onError?.(err instanceof Error ? err : new Error(String(err)));
            again();
          });
        }, 1_000);
        retry.unref?.();
      };
      await open();
      return async () => {
        stopped = true;
        if (retry !== null) clearTimeout(retry);
        const c = client;
        client = null;
        if (c) {
          await c.query(`UNLISTEN ${channel}`).catch(() => undefined);
          c.release();
        }
      };
    },
  };
}

/**
 * A connection string as it may be said (a log line, a startup line, a message): its password, and any
 * `password=` parameter, as `***`. Never the string itself.
 */
export function maskConnectionString(url: string): string {
  // Read by hand, not with URL: a password may hold characters a URL would take for its end (`/`, `#`,
  // `?`, a space), and a parser that stopped early would leave the rest of it in the open.
  let out = url;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(url);
  if (scheme) {
    const rest = url.slice(scheme[0].length);
    // Everything up to the last @ is the user's part; a password is whatever follows its first colon.
    const at = rest.lastIndexOf('@');
    if (at >= 0) {
      const userinfo = rest.slice(0, at);
      const colon = userinfo.indexOf(':');
      if (colon >= 0) out = `${scheme[0]}${userinfo.slice(0, colon)}:***${rest.slice(at)}`;
    }
  }
  return out.replace(/([?&][^=&#]*pass[^=&#]*=)[^&#]*/gi, '$1***');
}

/**
 * A line with the connection string's password taken out wherever a connection string stands in it:
 * the one given, as written, and any other `scheme://...` in it (a driver's message that quotes one).
 * Nothing else in the line changes, so a short or common password never mangles ordinary words; a
 * driver does not say a password outside a connection string.
 */
export function maskSecrets(message: string, url: string): string {
  return message.split(url).join(maskConnectionString(url)).replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, (found) => maskConnectionString(found));
}
