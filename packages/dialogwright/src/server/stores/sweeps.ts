import { ensureTables, type TablePart } from './postgres';
import type { SqlClient } from './sql';

/**
 * Which server runs a sweep the servers on one database share (the trace store's retention, say), so
 * they do not all list and delete the same objects each hour: a row per sweep, taken by one server
 * until a time on the database's clock. A server that finds it taken skips that sweep.
 */

export const SWEEPS_SCHEMA_VERSION = 1;

export const SWEEP_TABLES: TablePart = {
  row: 'sweeps',
  version: SWEEPS_SCHEMA_VERSION,
  what: 'sweep table',
  setting: 'SESSION_STORE',
  tables: [
    `CREATE TABLE IF NOT EXISTS dw_sweeps (
      name text PRIMARY KEY,
      owner text NOT NULL,
      until_ms bigint NOT NULL
    )`,
  ],
};

const DB_NOW = '(extract(epoch from clock_timestamp()) * 1000)::bigint';

/** The sweeps over `sql` (the session store's), the table made on first use. */
export async function openSweeps(sql: SqlClient): Promise<{ claim(name: string, owner: string, holdMs: number): Promise<boolean> }> {
  await ensureTables(sql, SWEEP_TABLES);
  return {
    /** Whether `owner` runs sweep `name` now: taken when no one has it, or its hold has passed; held `holdMs`. */
    async claim(name, owner, holdMs) {
      const r = await sql.query<{ owner: string }>(
        `INSERT INTO dw_sweeps (name, owner, until_ms) VALUES ($1, $2, ${DB_NOW} + $3::bigint)
         ON CONFLICT (name) DO UPDATE SET owner = EXCLUDED.owner, until_ms = EXCLUDED.until_ms WHERE dw_sweeps.until_ms < ${DB_NOW}
         RETURNING owner`,
        [name, owner, holdMs],
      );
      return r.rows.length > 0;
    },
  };
}
