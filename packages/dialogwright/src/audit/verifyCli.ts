import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyChain } from './verify';
import { maskConnectionString, maskSecrets, openPgClient, type SqlClient } from '../server/stores/sql';
import { schemaVersion } from '../server/stores/postgres';
import { AUDIT_SCHEMA_VERSION, AUDIT_TABLES, verifyPostgresAudit } from './postgres';

/**
 * Re-walk every audit day-file's hash chain and report. The server writes where AUDIT_DIR points
 * (src/server/config.ts), so this reads the same place; a directory argument overrides both. A
 * relative one is from where the command was run (pnpm's INIT_CWD: `pnpm audit:verify` runs this in
 * the engine package's folder), else from the working directory. It is `pnpm audit:verify [dir]` at
 * the repository root. Returns the process exit code (0 when every chain is intact or there are no
 * files, 1 otherwise).
 *
 * With AUDIT_STORE=postgres://... (the setting, or a `postgres://` argument in place of the folder),
 * the audit in the database instead (audit/postgres.ts): every call's chain and every day's anchors,
 * the connection string said with its password masked. Then the code is a promise.
 */
export function main(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env, deps: { sql?: SqlClient } = {}): number | Promise<number> {
  const named = argv[0] ?? (env.AUDIT_STORE?.trim() || env.AUDIT_DIR?.trim() || 'audit');
  if (/^postgres(ql)?:\/\//i.test(named)) return verifyDatabase(named, deps.sql);
  const dir = isAbsolute(named) ? named : resolve(env.INIT_CWD?.trim() || process.cwd(), named);
  if (!existsSync(dir)) {
    console.log(`no audit files in ${dir}`);
    return 0;
  }
  let bad = 0;
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort()) {
    const r = verifyChain(join(dir, f));
    if (r.ok) console.log(`${f}: ${r.entries} entries, chain intact`);
    else { bad++; console.log(`${f}: BROKEN at line ${r.brokenAt} of ${r.entries} (${r.why})`); }
  }
  return bad ? 1 : 0;
}

/** The audit in the database `url` names: 0 when every chain and every day verifies (or there is none yet), 1 at a break. */
async function verifyDatabase(url: string, given?: SqlClient): Promise<number> {
  const shown = maskConnectionString(url);
  let sql: SqlClient | null = null;
  try {
    sql = given ?? (await openPgClient(url, { max: 1, queryTimeoutMs: 30_000 }));
    const version = await schemaVersion(sql, AUDIT_TABLES.row);
    if (version === null) {
      console.log(`no audit tables in ${shown}`);
      return 0;
    }
    if (version !== AUDIT_SCHEMA_VERSION) {
      console.log(`${shown}: the audit tables are version ${version}, and this reads ${AUDIT_SCHEMA_VERSION}: run the audit:verify of the server that made them`);
      return 1;
    }
    const r = await verifyPostgresAudit(sql);
    console.log(`${shown}: ${r.chains} ${r.chains === 1 ? 'chain' : 'chains'}, ${r.entries} entries`);
    for (const d of r.days) {
      const broken = r.breaks.some((b) => b.startsWith(`day ${d.day} (${d.server}):`));
      if (!broken) console.log(`${d.day} (${d.server}): ${d.anchors} ${d.anchors === 1 ? 'anchor' : 'anchors'}, chain intact`);
    }
    for (const b of r.breaks) console.log(b);
    if (r.breaks.length === 0) console.log("every call's chain intact, and each one's newest entry anchored");
    return r.breaks.length > 0 ? 1 : 0;
  } catch (err) {
    console.log(`${shown}: ${maskSecrets(err instanceof Error ? err.message : String(err), url)}`);
    return 1;
  } finally {
    if (given === undefined) await sql?.close().catch(() => undefined);
  }
}

// Run when invoked directly (tsx verifyCli.ts, through a symlink too); importing it, as an app's wrapper does, runs nothing.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const code = main();
  if (typeof code === 'number') process.exitCode = code;
  else void code.then((c) => { process.exitCode = c; });
}
