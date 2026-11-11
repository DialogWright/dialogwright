import type { AuditDraft, AuditEntry, Chained } from './types';

export type { Chained };

/**
 * Where a turn's audit drafts are chained: the server's AuditLog (day files), its Postgres audit
 * (AUDIT_STORE=postgres, audit/postgres.ts), or a test's collector. A sink that chains at once returns
 * the entry; one that chains in a database returns a promise of it.
 */
export interface AuditSink {
  append(callId: string, channel: string, d: AuditDraft): Chained<AuditEntry>;
  /** A turn's drafts chained together (in one transaction, for a database); absent, each is appended in turn. */
  appendAll?(callId: string, channel: string, ds: readonly AuditDraft[]): Promise<AuditEntry[]>;
}

/** `ds` chained in order: at once from a sink that chains at once (as it always was), else a promise of the entries. */
export function chainDrafts(sink: AuditSink, callId: string, channel: string, ds: readonly AuditDraft[]): Chained<AuditEntry[]> {
  if (sink.appendAll && ds.length > 0) return sink.appendAll(callId, channel, ds);
  const out = ds.map((d) => sink.append(callId, channel, d));
  return out.some((e) => e instanceof Promise) ? Promise.all(out) : (out as AuditEntry[]);
}

/** `fn` with what was chained: at once when it is there, else once it is (a failure goes to `onError`, never thrown). */
export function whenChained<T>(x: Chained<T>, fn: (t: T) => void, onError: (err: unknown) => void): void {
  if (x instanceof Promise) x.then(fn, onError);
  else fn(x);
}
