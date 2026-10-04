import { resolve } from 'node:path';
import { parseArgs, shown, todayUtc } from '../args';
import type { Io } from '../cli';
import { findKb } from '../kbPlace';
import { startReviewServer } from './server';

/**
 * kb:review [dir] [--port N]
 *
 * Starts the review page (./server.ts) for the knowledge base at `dir` and prints its URL, with the
 * token every request needs. It runs until Ctrl-C. Exit codes: 0 stopped, 1 a problem, 2 a command
 * line not understood.
 */

export const REVIEW_USAGE = [
  'usage: kb:review [dir] [--port N]',
  '  serves the review page on 127.0.0.1 (a free port unless --port) for this machine only, with a one-time token in its URL;',
  '  approve, edit then approve, or reject each draft, accept or merge each proposed topic, and approve passages withheld after a change. Ctrl-C stops it.',
].join('\n');

export async function reviewCommand(args: readonly string[], io: Io): Promise<number> {
  const parsed = parseArgs(args, { values: ['--port'] });
  if (typeof parsed === 'string') {
    io.err(`kb:review: ${parsed}\n${REVIEW_USAGE}`);
    return 2;
  }
  if (parsed.positional.length > 1) {
    io.err(`kb:review: give one app folder (or knowledge base folder) at most\n${REVIEW_USAGE}`);
    return 2;
  }
  let port = 0;
  if (parsed.values['--port'] !== undefined) {
    port = Number(parsed.values['--port']);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      io.err(`kb:review: --port must be a whole number from 1 to 65535\n${REVIEW_USAGE}`);
      return 2;
    }
  }
  const dir = resolve(io.cwd, parsed.positional[0] ?? '.');
  const place = findKb(dir, shown(io.cwd, dir));
  if (typeof place === 'string') {
    io.err(`kb:review: ${place}`);
    return 1;
  }
  let server;
  try {
    server = await startReviewServer({ place, today: io.today ?? todayUtc, port });
  } catch (error) {
    io.err(`kb:review: could not listen on 127.0.0.1${port !== 0 ? `:${port}` : ''} (${error instanceof Error ? error.message : String(error)})`);
    return 1;
  }
  io.out(`kb:review: reviewing ${place.label} at`);
  io.out(`  ${server.url}`);
  io.out('  open it in a browser on this machine; the token in it is needed for every request and changes each time this starts. Ctrl-C stops it.');
  if (io.onReview) {
    await io.onReview(server);
    await server.close();
    return 0;
  }
  await new Promise<void>((resolveStop) => {
    const stop = (): void => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      void server.close().then(() => resolveStop());
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
  io.out('kb:review: stopped');
  return 0;
}
