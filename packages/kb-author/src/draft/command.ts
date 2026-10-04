import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs, shown, todayUtc } from '../args';
import type { Io } from '../cli';
import { findKb } from '../kbPlace';
import { ClaudeDrafter, DEFAULT_DRAFT_MODEL } from './claude';
import { DraftCommandError, draftKb, formatDraftReport } from './draft';
import type { Drafter } from './drafter';

/**
 * kb:draft [dir] [--source <doc>]... [--topic-hint <text>]... [--model <id>] [--all] [--dry-run] [--json]
 *
 * Drafts passages from the knowledge base's sources into kb/pending (./draft.ts) with the Claude
 * drafter (./claude.ts) and the author's own key. It does not run in CI. Exit codes: 0 done, 1 a
 * problem (a drafter that failed, the knowledge base not loading), 2 a command line not understood.
 */

export const DRAFT_USAGE = [
  'usage: kb:draft [dir] [--source <doc>]... [--topic-hint <text>]... [--model <id>] [--all] [--dry-run] [--json]',
  '  drafts passages from kb/sources into kb/pending with Claude (ANTHROPIC_API_KEY, your own key; never in CI);',
  '  each draft quotes its source word for word and is checked before it is written; nothing pending is ever said.',
  `  --source: only these documents (default: all); --all: every section, not only those nothing cites yet; --model (default ${DEFAULT_DRAFT_MODEL})`,
].join('\n');

export async function draftCommand(args: readonly string[], io: Io): Promise<number> {
  const parsed = parseArgs(args, { values: ['--model'], lists: ['--source', '--topic-hint'], flags: ['--all', '--dry-run', '--json'] });
  if (typeof parsed === 'string') {
    io.err(`kb:draft: ${parsed}\n${DRAFT_USAGE}`);
    return 2;
  }
  if (parsed.positional.length > 1) {
    io.err(`kb:draft: give one app folder (or knowledge base folder) at most\n${DRAFT_USAGE}`);
    return 2;
  }
  const dir = resolve(io.cwd, parsed.positional[0] ?? '.');
  const place = findKb(dir, shown(io.cwd, dir));
  if (typeof place === 'string') {
    io.err(`kb:draft: ${place}`);
    return 1;
  }
  const model = parsed.values['--model'];
  let drafter: Drafter;
  if (io.drafter) drafter = io.drafter(model);
  else {
    const env = io.env ?? process.env;
    if (env.CI !== undefined && env.CI !== '' && env.CI !== 'false') {
      io.err('kb:draft: it does not run in CI: drafting asks a model with your own key, on your machine, and a person reviews every draft');
      return 1;
    }
    // The key may be in .env where the command is run; Node reads it into the environment, and it is never read here.
    if (io.env === undefined && env.ANTHROPIC_API_KEY === undefined && existsSync(join(io.cwd, '.env'))) process.loadEnvFile(join(io.cwd, '.env'));
    drafter = new ClaudeDrafter(model !== undefined ? { model } : {});
  }
  const dryRun = parsed.flags.has('--dry-run');
  try {
    const report = await draftKb({ place, drafter, today: (io.today ?? todayUtc)(), sources: parsed.lists['--source']!, topicHints: parsed.lists['--topic-hint']!, allSections: parsed.flags.has('--all'), dryRun });
    if (parsed.flags.has('--json')) io.out(JSON.stringify(report, null, 2));
    else for (const line of formatDraftReport(report, { kb: place.label, dryRun })) io.out(line);
    return report.documents.some((d) => d.error !== undefined) ? 1 : 0;
  } catch (error) {
    if (error instanceof DraftCommandError) {
      io.err(`kb:draft: ${error.message}`);
      for (const p of error.problems) io.err(`  ${p}`);
      return 1;
    }
    throw error;
  }
}
