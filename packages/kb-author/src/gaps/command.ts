import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs, shown } from '../args';
import type { Io } from '../cli';
import { findKb, loadKb } from '../kbPlace';
import { formatJson, formatMarkdown, reportFromFiles } from './report';
import { defaultTraceSpecs } from './traces';

/**
 * kb:gaps [dir] [--traces <path|glob>]... [--since YYYY-MM-DD] [--samples N] [--out <file>] [--json]
 *
 * Reads the traces of real calls (./traces.ts) and ranks what callers asked the knowledge base that it
 * did not answer (./collect.ts says what counts), grouped by nearest topic with samples of their words
 * and the fix for each kind (./report.ts). Markdown by default (to stdout, or `--out`), JSON with
 * `--json`. Exit codes: 0 a report written (gaps or none), 1 a problem (the knowledge base does not
 * load, no trace files found), 2 a command line not understood.
 */

export const GAPS_USAGE = [
  'usage: kb:gaps [dir] [--traces <path|glob>]... [--since YYYY-MM-DD] [--samples N] [--out <file>] [--json]',
  '  ranks what callers asked the knowledge base that it did not answer, from the traces of real calls: a topic question answered none,',
  '  words that look like a question with no topic nominated, a passage that could not be said (stale, not in force, no translation, no facts),',
  '  and a close call between two topics; grouped by the nearest topic, with samples of their words and the fix for each kind.',
  '  --traces: a trace file, a folder of them, or a glob (default: $TRACE_DIR, else <app>/traces, else ./traces); --since: from that day on;',
  '  --samples: callers\' words shown per group (default 3); --out writes the report to a file; --json prints JSON for tools.',
  '  The traces hold the callers\' words as spoken (identity values are masked): keep the report as private as they are.',
].join('\n');

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Whether `day` is a real calendar date written YYYY-MM-DD. */
function isDay(day: string): boolean {
  if (!DAY.test(day)) return false;
  const d = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day;
}

export async function gapsCommand(args: readonly string[], io: Io): Promise<number> {
  const parsed = parseArgs(args, { values: ['--since', '--samples', '--out'], lists: ['--traces'], flags: ['--json'] });
  if (typeof parsed === 'string') {
    io.err(`kb:gaps: ${parsed}\n${GAPS_USAGE}`);
    return 2;
  }
  if (parsed.positional.length > 1) {
    io.err(`kb:gaps: give one app folder (or knowledge base folder) at most\n${GAPS_USAGE}`);
    return 2;
  }
  const since = parsed.values['--since'];
  if (since !== undefined && !isDay(since)) {
    io.err(`kb:gaps: --since must be a day written YYYY-MM-DD\n${GAPS_USAGE}`);
    return 2;
  }
  let samples = 3;
  if (parsed.values['--samples'] !== undefined) {
    samples = Number(parsed.values['--samples']);
    if (!Number.isInteger(samples) || samples < 0 || samples > 50) {
      io.err(`kb:gaps: --samples must be a whole number from 0 to 50\n${GAPS_USAGE}`);
      return 2;
    }
  }
  const dir = resolve(io.cwd, parsed.positional[0] ?? '.');
  const place = findKb(dir, shown(io.cwd, dir));
  if (typeof place === 'string') {
    io.err(`kb:gaps: ${place}`);
    return 1;
  }
  const loaded = loadKb(place);
  if (loaded.kb === null) {
    io.err(`kb:gaps: the knowledge base does not load:`);
    for (const p of loaded.problems) io.err(`  ${p}`);
    return 1;
  }
  const given = parsed.lists['--traces']!;
  const specs = given.length > 0 ? given : defaultTraceSpecs({ cwd: io.cwd, appDir: place.appDir, env: io.env ?? process.env });
  const { report, files } = reportFromFiles({ kb: loaded.kb, place, label: place.label, traces: specs, cwd: io.cwd, ...(since !== undefined ? { since } : {}), samples });
  if (files.length === 0) {
    io.err(`kb:gaps: no trace files found in ${specs.map((s) => shown(io.cwd, resolve(io.cwd, s))).join(', ')}: a server writes them to $TRACE_DIR (default ./traces); give --traces <path|glob>`);
    return 1;
  }
  const text = parsed.flags.has('--json') ? formatJson(report) : formatMarkdown(report).join('\n');
  const out = parsed.values['--out'];
  if (out !== undefined) {
    const path = resolve(io.cwd, out);
    try {
      writeFileSync(path, `${text}\n`);
    } catch (error) {
      io.err(`kb:gaps: could not write ${shown(io.cwd, path)} (${error instanceof Error ? error.message : String(error)})`);
      return 1;
    }
    io.out(`kb:gaps: wrote ${shown(io.cwd, path)}: ${report.gaps} ${report.gaps === 1 ? 'gap' : 'gaps'} in ${report.groups.length} ${report.groups.length === 1 ? 'group' : 'groups'}`);
  } else io.out(text);
  return 0;
}
