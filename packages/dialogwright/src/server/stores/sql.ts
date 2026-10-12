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
}
interface PgPool {
  query(text: string, params?: readonly unknown[]): Promise<{ rows: unknown[] }>;
  connect(): Promise<PgPoolClient>;
  end(): Promise<void>;
  on(event: 'error', listener: (err: Error) => void): unknown;
}
interface PgModule {
  Pool: new (config: { connectionString: string; max?: number; connectionTimeoutMillis?: number; application_name?: string }) => PgPool;
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
  /** Where a connection's own failure (one the pool held idle) is said: masked, never thrown. */
  log?: (line: string) => void;
}

/**
 * A SqlClient on the `pg` driver over a pool. A connection that fails while idle is logged, never
 * thrown (an 'error' nobody listens for would stop the process), and the pool opens another.
 */
export async function openPgClient(url: string, o: PgClientOptions = {}): Promise<SqlClient> {
  const { Pool } = await loadPg();
  const pool = new Pool({ connectionString: url, max: o.max ?? 10, connectionTimeoutMillis: o.connectTimeoutMs ?? 5_000, application_name: 'dialogwright' });
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
  };
}

/**
 * A connection string as it may be said (a log line, a startup line, a message): its password, and any
 * `password=` parameter, as `***`. Never the string itself.
 */
export function maskConnectionString(url: string): string {
  try {
    const u = new URL(url);
    if (u.password !== '') u.password = '***';
    for (const key of [...u.searchParams.keys()]) if (/pass/i.test(key)) u.searchParams.set(key, '***');
    // URLSearchParams writes `*` as `%2A`: said as typed.
    return u.toString().replace(/%2A%2A%2A/g, '***');
  } catch {
    // Not a URL: everything between the scheme and an @ could be a password.
    return url.replace(/\/\/[^@/]*@/, '//***@').replace(/(pass[^=&]*=)[^&]*/gi, '$1***');
  }
}

/** A driver's message with the connection string's password taken out, should it hold it. */
export function maskSecrets(message: string, url: string): string {
  let out = message.split(url).join(maskConnectionString(url));
  try {
    const u = new URL(url);
    for (const password of new Set([u.password, decodeURIComponent(u.password)])) {
      if (password !== '') out = out.split(password).join('***');
    }
  } catch {
    // Not a URL: nothing more is known of it.
  }
  return out;
}
