/**
 * kb/approvals.jsonl, the log of approvals: one JSON line per approval, appended by pnpm kb:approve
 * (./approval.ts) and never rewritten. The loader reads it (./folder.ts) so `pnpm check` can hold
 * each passage's approval to a line of it (./rules.ts kbStateProblems): an approval with no line of
 * the same id and hash was written outside kb:approve (by hand, or copied with its file), and check
 * refuses it. The log is not configuration: it is read as data, never hashed into the app's
 * configuration hashes, and nothing a call does consults it.
 */

import type { KbPassage, KnowledgeBase } from './types';

/** Where the log of approvals is, in the kb folder. */
export const APPROVALS_LOG = 'approvals.jsonl';

/** The most bytes the log may have for the loader to read it. */
export const MAX_APPROVALS_LOG_BYTES = 32 * 1024 * 1024;

/** One line of kb/approvals.jsonl. */
export interface ApprovalLogLine {
  id: string;
  version: string;
  approvedBy: string;
  owner: string;
  on: string;
  sourceHash: string;
  hash: string;
  /**
   * What was approved: a draft from kb/pending, or a passage already in kb/passages (both written by
   * kb:approve; a passage's too when a person confirms in kb:review an approval a migration carried
   * over); or `migration`: an approval carried over from the app's earlier format of the same
   * content by the app's own script, never by kb:approve. A migration line keeps the original
   * approver, owner and day (`approvedBy`, `owner`, `on`), records the hashes taken under this
   * format, and says why in `note`; the people who own the content confirm it in review (it is in
   * the log, and kb:status marks the passages it approved): kb:review's "Confirm this approval"
   * appends their line, `from: passage`, with the same hashes. The log is appended to, never
   * rewritten: a migration taken again under a later format is new lines, and the last line with a
   * passage's id and hash is the one that stands.
   */
  from: 'pending' | 'passage' | 'migration';
  /**
   * The source section's text as it was approved (its hash is `sourceHash`), so a review after the
   * source changes can show what changed (kb:review's diff). Lines written before it was kept lack it.
   */
  sourceText?: string;
  /** For a migration, what was carried over and from where, and what its owners are to confirm. */
  note?: string;
}

/**
 * The lines of a log's text, oldest first. A line that is not JSON, or lacks an id, a hash or a
 * `from`, is passed over: the log is for people, and a line someone wrote by hand must not stop
 * kb:status (a passage whose only line is such a one has no line, and check says so).
 */
export function parseApprovalLog(text: string): ApprovalLogLine[] {
  const lines: ApprovalLogLine[] = [];
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    try {
      const l = JSON.parse(raw) as Partial<ApprovalLogLine> | null;
      if (l && typeof l === 'object' && typeof l.id === 'string' && typeof l.hash === 'string' && typeof l.from === 'string') lines.push(l as ApprovalLogLine);
    } catch {
      // a line that does not parse is passed over
    }
  }
  return lines;
}

/** The last line of `log` that recorded the approval `{ id, hash }`, or null when none did. */
export function logLineOf<L extends Pick<ApprovalLogLine, 'id' | 'hash'>>(log: readonly L[], id: string, hash: string | undefined): L | null {
  if (hash === undefined) return null;
  for (let i = log.length - 1; i >= 0; i--) if (log[i]!.id === id && log[i]!.hash === hash) return log[i]!;
  return null;
}

/**
 * Whether a passage's approval is in the log the loader read (a line of its id and hash): true or
 * false, or null when it has no approval or there is no log to hold it to (a knowledge base built in
 * code, or a log that could not be read, which check reports on its own).
 */
export function approvalLogged(kb: Pick<KnowledgeBase, 'approvalLog'>, passage: Pick<KbPassage, 'id' | 'approval'>): boolean | null {
  const log = kb.approvalLog;
  if (passage.approval === undefined || log === undefined || 'invalid' in log) return null;
  return logLineOf(log.lines, passage.id, passage.approval.hash) !== null;
}
