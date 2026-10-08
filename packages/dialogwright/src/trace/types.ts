import type { SessionEvent } from '../channel/events';
import type { Action } from '../channel/actions';
import type { AnsweredBy, AnswerMap, AnswerSource, QuestionMap } from '../jev/types';
import type { TurnState } from '../core/state';
import type { GateRow } from '../core/gates';
import type { Decision } from '../core/decision';
import type { PendingConfirmation, SlotState } from '../core/session';
import type { FormId, SlotId } from '../core/app/types';
import type { ScreenResult } from '../core/screen';
import type { Effect, GateEvent, KbSource } from '../core/lifecycle';
import type { AuditDraft } from '../audit/types';
import type { NominationVia } from '../kb/types';

export type TraceSource = AnswerSource | 'dtmf' | 'silence' | 'error' | 'none';

export interface TraceTiming {
  /** How long the knowledge retriever took, before planning; only on a turn it ran (TraceRecord.retrieval). */
  retrieveMs?: number;
  planMs: number;
  askMs: number;
  resolveMs: number;
  totalMs: number;
}

/**
 * What the knowledge retriever did on a turn (run/retrieve.ts): the topics it nominated, each with
 * its score and how it was found, best first, and the index it read. `failed` says why it nominated
 * nothing when it did not answer as asked: `error` (it threw or rejected, with `message`), `invalid`
 * (it returned something other than a list of nominations), `late` (not back within the budget).
 */
export interface RetrievalRecord {
  retrieverId: string;
  indexHash?: string;
  nominated: Array<{ topic: string; score: number; via: NominationVia }>;
  failed?: 'error' | 'invalid' | 'late';
  message?: string;
}

export interface TraceUsage {
  inputTokens: number;
  outputTokens: number;
  estimated: boolean;
  costUsd: number;
}

/**
 * All three layers write this shape. v2: `event` is the core's SessionEvent and
 * `actions` what the core asked the channel to do; a v1 record carried the ConversationRelay frame
 * in and the frames out, and src/trace/read.ts upgrades one wherever a trace is read back.
 */
export interface TraceRecord {
  v: 2;
  sessionId: string;
  turnIndex: number;
  ts: string;
  event: SessionEvent;
  turnState: TurnState | null;
  questions: QuestionMap | null;
  answers: AnswerMap | null;
  source: TraceSource;
  error: { name: string; message: string } | null;
  gates: GateRow[];
  decision: Decision;
  actions: Action[];
  /** the form active after this turn, null when none is */
  form: string | null;
  slots: Record<SlotId, SlotState>;
  timing: TraceTiming;
  usage: TraceUsage;
  /** Added for the dashboard; optional so records written before then still load. */
  queued?: FormId[];
  pendingConfirmation?: PendingConfirmation | null;
  promptedFor?: 'intent' | 'confirm' | 'otp' | SlotId | null;
  /** Added later: the forms completed on the call so far. Optional so older records still load. */
  completed?: FormId[];
  /**
   * The language the session speaks after this turn (Session.locale), which only a session of an app
   * that declares locales (App.locales) has; absent otherwise, and in records written before locales.
   */
  locale?: string;
  /**
   * The combined hash of the configuration the session's app was built from (App.configHashes.app):
   * on every record of a call of an app that has hashes, so any one record names the configuration
   * in force; the full per-file list is in the call's call_started audit row (and so in its first
   * record's `audit`). Absent for an app without hashes, and in records written before them.
   */
  configHash?: string;
  /**
   * What answers the call's asks (JevClient.answeredBy): the provider, the model id, and whether it
   * is TypeSafe's Jev (`official`), whose probabilities the thresholds were measured on. Only on the
   * session start's record, so a run says what answered it; absent for a stub, which asks no model,
   * and in records written before it.
   */
  answeredBy?: AnsweredBy;
  /**
   * Whether the session kept the number the caller is calling from (core/callerNumber.ts): `kept`,
   * or `none` when the call had no number a slot can offer (none sent, withheld, or one that does
   * not fit the slot), so a builder can see why no offer was made. Only on the session start's record
   * of an app with a slot that offers it (SlotSpec.callerNumber); absent for every other app.
   */
  callerNumber?: 'kept' | 'none';
  /**
   * Added later: the injection screen's reading of this turn (null when it was not asked), and
   * whether it quarantined the turn. A quarantined record keeps `answers` for debugging, but nothing
   * acted on them. Optional so older records still load. The screen's usage is included in `usage`.
   */
  screen?: ScreenResult | null;
  quarantined?: boolean;
  /**
   * Added for the dashboard: every gate decision this turn
   * made, already redacted (GateEvent's `decision.call` is the redacted copy; core/lifecycle.ts's
   * `redactCall`), the knowledge-base passage an answer came from, and the side effects the runner
   * performs after the turn (a downstream service call). Optional so records written before this still load.
   */
  gateEvents?: GateEvent[];
  kb?: KbSource | null;
  /**
   * What the knowledge retriever nominated before the turn was planned: only on a turn it ran (an
   * app with a knowledge base and a retriever, words, and a topic slot listening); absent on every
   * other turn and for every other app.
   */
  retrieval?: RetrievalRecord;
  /**
   * Only on a turn that joined the final prompts of a caller who had not finished (run/continuation.ts,
   * voice.continueWithinMs): the prompts, in order, as each was heard. The event's words are them
   * joined; each fragment's own turn is an earlier record. Absent on every other turn.
   */
  joined?: { fragments: string[] };
  effects?: Effect[];
  /**
   * This turn's audit drafts, in the order they were chained -- before chaining: no `seq` or
   * `hash` yet (those are the sink's, core/audit.ts's `AuditDraft` is what a turn reports). The
   * dashboard's live audit tail (hash and all) comes from the separate `audit` bus event instead;
   * this is what a replayed trace has to count a turn's audit entries by, since that event is
   * never written to the trace file.
   */
  audit?: AuditDraft[];
}
