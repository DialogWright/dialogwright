import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyChain } from './verify';

/**
 * Re-walk every audit day-file's hash chain and report. The server writes where AUDIT_DIR points
 * (src/server/config.ts), so this reads the same place; a directory argument overrides both.
 * Returns the process exit code (0 when every chain is intact or there are no files, 1 otherwise).
 */
export function main(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): number {
  const dir = argv[0] ?? (env.AUDIT_DIR?.trim() || 'audit');
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

// Run when invoked directly (tsx verifyCli.ts, through a symlink too); importing it, as an app's wrapper does, runs nothing.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = main();
