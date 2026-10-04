import { resolve } from 'node:path';
import { parseArgs, shown, todayUtc } from '../args';
import { USER_AGENT, type Io } from '../cli';
import { findKb } from '../kbPlace';
import { formatRefreshReport, refreshKb } from './refresh';

/**
 * kb:refresh [dir] [--allow-private] [--dry-run] [--json]
 *
 * Reads every source document again from where it came from (./refresh.ts), writes those that
 * changed, and lists the passages now withheld and the sections nothing cites. Exit codes: 0 done
 * (a withheld passage is reported, and pnpm check fails on it), 1 a problem (a source could not be
 * read again), 2 a command line not understood. Before it asks any website, it says which hosts it
 * will ask (those the sources' provenance names); a host on a private network is refused unless
 * --allow-private, and a file outside the app folder is never read.
 */

export const REFRESH_USAGE = [
  'usage: kb:refresh [dir] [--allow-private] [--dry-run] [--json]',
  '  reads every source in kb/sources again from its file, or with the crawl that read it, and writes those that changed;',
  '  it reads only files inside the app folder and public addresses (--allow-private: a site on a private network too), and names the hosts it asks first;',
  '  passages whose section changed are withheld until approved again (pnpm kb:review); new sections are offered to pnpm kb:draft.',
].join('\n');

export async function refreshCommand(args: readonly string[], io: Io): Promise<number> {
  const parsed = parseArgs(args, { flags: ['--allow-private', '--dry-run', '--json'] });
  if (typeof parsed === 'string') {
    io.err(`kb:refresh: ${parsed}\n${REFRESH_USAGE}`);
    return 2;
  }
  if (parsed.positional.length > 1) {
    io.err(`kb:refresh: give one app folder (or knowledge base folder) at most\n${REFRESH_USAGE}`);
    return 2;
  }
  const dir = resolve(io.cwd, parsed.positional[0] ?? '.');
  const place = findKb(dir, shown(io.cwd, dir));
  if (typeof place === 'string') {
    io.err(`kb:refresh: ${place}`);
    return 1;
  }
  const dryRun = parsed.flags.has('--dry-run');
  const report = await refreshKb({
    place,
    today: (io.today ?? todayUtc)(),
    dryRun,
    crawl: {
      userAgent: USER_AGENT,
      ...(parsed.flags.has('--allow-private') ? { allowPrivate: true } : {}),
      ...(io.fetch ? { fetch: io.fetch } : {}),
      ...(io.resolve ? { resolve: io.resolve } : {}),
      ...(io.sleep ? { sleep: io.sleep } : {}),
      ...(io.now ? { now: io.now } : {}),
    },
    onHosts: (hosts) => (parsed.flags.has('--json') ? io.err : io.out)(`kb:refresh: asking ${hosts.join(', ')} (the hosts the sources were read from)`),
  });
  if (parsed.flags.has('--json')) io.out(JSON.stringify({ ...report, runs: report.runs.map((r) => ({ ...r, documents: r.documents.map(({ yaml: _yaml, ...d }) => d) })) }, null, 2));
  else for (const line of formatRefreshReport(report, { kb: place.label, dryRun })) io.out(line);
  return report.runs.some((r) => r.error !== undefined) ? 1 : 0;
}
