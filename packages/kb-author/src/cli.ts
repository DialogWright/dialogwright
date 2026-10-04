#!/usr/bin/env tsx
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CrawlError, DEFAULT_MAX_PAGES, DEFAULT_RATE_MS } from './crawl/crawl';
import type { Drafter } from './draft/drafter';
import { draftCommand } from './draft/command';
import { formatReport, ingest, IngestError, isUrl } from './ingest';
import { todayUtc } from './args';

/**
 * The authoring commands (the `dialogwright-kb` bin; the workspace's `pnpm kb:ingest` and `kb:draft`):
 *
 *   kb:ingest <folder | file | url> [--dir <app folder>] [--depth N] [--include <glob>]...
 *             [--max-pages M] [--rate <ms>] [--allow-host <host>]... [--dry-run] [--json]
 *   kb:draft [dir] [--source <doc>]... [--topic-hint <text>]... [--model <id>] [--all] [--dry-run] [--json]
 *             (./draft/command.ts)
 *
 * It reads a folder (recursively), a file or a website into sections and writes each document to
 * the app's kb/sources/<doc>.yaml, saying what was added, changed and unchanged. `--dir` is the app
 * folder (or its kb folder); without it, the folder it is run in when that is an app folder. The
 * crawl options are for a URL only. Exit codes: 0 done, 1 a problem (said on stderr), 2 a command
 * line not understood.
 */

export interface Io {
  out(line: string): void;
  err(line: string): void;
  /** Where relative paths are from (pnpm's INIT_CWD when run through a script). */
  cwd: string;
  /** Today, as an ISO date. Default: today (UTC). */
  today?: () => string;
  /** The crawl's fetch, timer and clock (a test's). */
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** kb:draft's drafter, in place of the Claude adapter (a test's fake). */
  drafter?: (model: string | undefined) => Drafter;
  /** The environment (kb:draft reads CI and, through the Claude adapter, ANTHROPIC_API_KEY). Default: process.env. */
  env?: NodeJS.ProcessEnv;
}

/** The package's version, for the User-Agent. */
export const VERSION: string = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

/** The User-Agent the crawler sends: what it is, its version, and where to read about it. */
export const USER_AGENT = `dialogwright-kb-ingest/${VERSION} (+https://github.com/DialogWright/dialogwright)`;

/** The least --rate allowed, in milliseconds. */
const MIN_RATE_MS = 100;

const USAGE = [
  'usage: kb:ingest <folder | file | url> [--dir <app folder>] [--dry-run] [--json]',
  '       for a url: [--depth N] [--include <glob>]... [--max-pages M] [--rate <ms>] [--allow-host <host>]...',
  '  reads PDF, DOCX, HTML, Markdown and text files (a folder recursively), or a website to a link depth,',
  '  and writes each document to <app>/kb/sources/<doc>.yaml with its sections and provenance;',
  `  a crawl stays on the start page's host, follows robots.txt, waits --rate ms between requests (default ${DEFAULT_RATE_MS})`,
  `  and reads at most --max-pages pages (default ${DEFAULT_MAX_PAGES}); --depth is how many links from the start page (default 1);`,
  '  --include narrows what is fetched beyond the start page by URL path (/help/**, *.pdf)',
].join('\n');

const stdio = (): Io => ({
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  cwd: process.env.INIT_CWD ?? process.cwd(),
});

/** Where the sources go: the app folder and its kb folder, from --dir (or the working directory). */
function placeOf(dir: string): { appDir: string; kbDir: string } | string {
  if (existsSync(join(dir, 'kb.yaml')) || (basename(dir) === 'kb' && !existsSync(join(dir, 'app.yaml')))) return { appDir: resolve(dir, '..'), kbDir: dir };
  if (existsSync(join(dir, 'app.yaml')) || existsSync(join(dir, 'kb'))) return { appDir: dir, kbDir: join(dir, 'kb') };
  return `${dir} is not an app folder (it has no app.yaml) or a knowledge base folder: give the app folder with --dir`;
}

/** `kb:ingest`. */
export async function ingestCommand(args: readonly string[], io: Io): Promise<number> {
  const values: Record<string, string> = {};
  const lists: Record<string, string[]> = { '--include': [], '--allow-host': [] };
  const flags = new Set<string>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a === '--dry-run' || a === '--json') flags.add(a);
    else if (['--dir', '--depth', '--max-pages', '--rate', '--include', '--allow-host'].includes(a)) {
      const v = args[i + 1];
      if (v === undefined || v.startsWith('--')) {
        io.err(`kb:ingest: ${a} needs a value\n${USAGE}`);
        return 2;
      }
      if (a in lists) lists[a]!.push(v);
      else values[a] = v;
      i += 1;
    } else if (a.startsWith('-')) {
      io.err(`kb:ingest: ${a} is not an option\n${USAGE}`);
      return 2;
    } else positional.push(a);
  }
  if (positional.length !== 1) {
    io.err(`kb:ingest: give one folder, file or url\n${USAGE}`);
    return 2;
  }
  const input = positional[0]!;
  const url = isUrl(input);
  const crawlOnly = ['--depth', '--max-pages', '--rate'].filter((o) => o in values).concat(['--include', '--allow-host'].filter((o) => lists[o]!.length > 0));
  if (!url && crawlOnly.length > 0) {
    io.err(`kb:ingest: ${crawlOnly.join(', ')} ${crawlOnly.length === 1 ? 'is' : 'are'} for a url only\n${USAGE}`);
    return 2;
  }
  const whole = (name: string, fallback: number, min: number): number | string => {
    if (!(name in values)) return fallback;
    const n = Number(values[name]);
    return Number.isInteger(n) && n >= min ? n : `${name} must be a whole number, ${min} or more`;
  };
  const depth = whole('--depth', 1, 0);
  const maxPages = whole('--max-pages', DEFAULT_MAX_PAGES, 1);
  const rate = whole('--rate', DEFAULT_RATE_MS, MIN_RATE_MS);
  for (const v of [depth, maxPages, rate]) {
    if (typeof v === 'string') {
      io.err(`kb:ingest: ${v}\n${USAGE}`);
      return 2;
    }
  }

  const place = placeOf(resolve(io.cwd, values['--dir'] ?? '.'));
  if (typeof place === 'string') {
    io.err(`kb:ingest: ${place}`);
    return 1;
  }
  const show = (p: string): string => {
    const rel = relative(io.cwd, p);
    return rel === '' ? '.' : rel.startsWith('..') ? p : rel;
  };
  try {
    const report = await ingest({
      input: url ? input : resolve(io.cwd, input),
      appDir: place.appDir,
      kbDir: place.kbDir,
      today: (io.today ?? todayUtc)(),
      dryRun: flags.has('--dry-run'),
      ...(url
        ? {
            crawl: {
              depth: depth as number,
              maxPages: maxPages as number,
              rateMs: rate as number,
              include: lists['--include']!,
              allowHosts: lists['--allow-host']!,
              userAgent: USER_AGENT,
              ...(io.fetch ? { fetch: io.fetch } : {}),
              ...(io.sleep ? { sleep: io.sleep } : {}),
              ...(io.now ? { now: io.now } : {}),
            },
          }
        : {}),
    });
    if (flags.has('--json')) io.out(JSON.stringify({ ...report, documents: report.documents.map(({ yaml: _yaml, ...d }) => d) }, null, 2));
    else for (const line of formatReport(report, { input, sources: show(join(place.kbDir, 'sources')), dryRun: flags.has('--dry-run') })) io.out(line);
    return report.documents.some((d) => d.refused !== undefined) ? 1 : 0;
  } catch (error) {
    if (error instanceof IngestError || error instanceof CrawlError) {
      io.err(`kb:ingest: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

/** Runs the command with `argv`; returns the exit code. */
export async function main(argv: readonly string[], io: Io = stdio()): Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'kb:ingest') return ingestCommand(rest, io);
  if (command === 'kb:draft') return draftCommand(rest, io);
  io.err(`unknown command ${command ?? '(none)'}: the commands are kb:ingest and kb:draft\n${USAGE}`);
  return 2;
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.exitCode = await main(process.argv.slice(2));
}
