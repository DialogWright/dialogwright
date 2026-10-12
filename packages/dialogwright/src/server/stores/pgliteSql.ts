import type { PGlite } from '@electric-sql/pglite';
import type { SqlClient, SqlQueryable } from './sql';

/**
 * A SqlClient over PGlite (Postgres in WebAssembly, a devDependency): what the engine's tests run the
 * Postgres stores on, with nothing installed. A test seam, not an option: the server opens Postgres
 * only through the `pg` driver (stores/sql.ts openPgClient). PGlite is one connection, which runs one
 * transaction at a time and holds every other query until it is done, so two clients over one PGlite
 * are two servers sharing one database. `close` closes the client only, never the database, which
 * the test that made it closes; `cut` makes every later query fail, as a server that crashed can no
 * longer reach its database.
 */
export interface PgliteSql extends SqlClient {
  /** From now on every query fails, as a crashed server's would. */
  cut(): void;
}

export function pgliteSql(db: PGlite): PgliteSql {
  let cut = false;
  const check = (): void => {
    if (cut) throw new Error('connection cut (the server went away)');
  };
  const query = async <R>(text: string, params?: readonly unknown[]): Promise<{ rows: R[] }> => {
    check();
    const r = await db.query<R>(text, params as unknown[] | undefined);
    return { rows: r.rows };
  };
  return {
    query,
    async transaction<T>(fn: (tx: SqlQueryable) => Promise<T>): Promise<T> {
      check();
      return db.transaction(async (tx) => fn({
        query: async <R>(text: string, params?: readonly unknown[]) => {
          check();
          return { rows: (await tx.query<R>(text, params as unknown[] | undefined)).rows };
        },
      }));
    },
    close: async () => {},
    cut: () => {
      cut = true;
    },
  };
}
