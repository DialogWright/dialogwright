import type { TraceRecord } from './types';
import type { TraceSink } from './writer';
import type { FrameDir, FrameSink } from '../server/frameLog';

/**
 * A trace that cannot be written never fails a turn (the maintainer's decision, 8b2's review): on one
 * machine the trace file and the frame log are written through these guards, so a full disk, a
 * removed folder or a file the server may not write is logged (at most once a minute, with how many
 * since) and counted (`/health`'s `traces.failures`), and the call goes on. Whenever the disk works,
 * every line is written exactly as it was. The audit is not guarded: a turn whose audit cannot be
 * written still fails, as the audit is the record.
 */

/** How often a failure to write a trace is said: the first at once, then at most once a minute with the count. */
export const TRACE_FAILURE_LOG_EVERY_MS = 60_000;

/** The trace writes that failed on this server, said in the log without ever saying more than the error. */
export class TraceFailures {
  failures = 0;
  private loggedAt: number | null = null;
  private unlogged = 0;

  constructor(private readonly log: (line: string) => void, private readonly now: () => number = Date.now) {}

  failed(what: string, err: unknown): void {
    this.failures += 1;
    const t = this.now();
    if (this.loggedAt !== null && t - this.loggedAt < TRACE_FAILURE_LOG_EVERY_MS) {
      this.unlogged += 1;
      return;
    }
    const since = this.unlogged > 0 ? ` (${this.unlogged} more since the last said)` : '';
    this.log(`traces: ${what} could not be written (${err instanceof Error ? err.message : String(err)}); the call goes on${since}`);
    this.loggedAt = t;
    this.unlogged = 0;
  }
}

/** A sink made by `make`, made again on the next write when making it failed (a folder that comes back). */
function guarded<S>(make: () => S, failures: TraceFailures, what: string): { use(fn: (s: S) => void): void } {
  let inner: S | null = null;
  try {
    inner = make();
  } catch (err) {
    failures.failed(what, err);
  }
  return {
    use(fn) {
      try {
        inner ??= make();
        fn(inner);
      } catch (err) {
        failures.failed(what, err);
      }
    },
  };
}

/** A trace sink whose write never throws. */
export function guardTrace(make: () => TraceSink, failures: TraceFailures, what: string): TraceSink {
  const g = guarded(make, failures, what);
  return { write: (record: TraceRecord) => g.use((s) => s.write(record)) };
}

/** A frame sink whose write never throws. */
export function guardFrames(make: () => FrameSink, failures: TraceFailures, what: string): FrameSink {
  const g = guarded(make, failures, what);
  return { write: (dir: FrameDir, msg: unknown) => g.use((s) => s.write(dir, msg)) };
}
