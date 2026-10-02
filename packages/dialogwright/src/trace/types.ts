import type { SessionEvent } from '../channel/events';
import type { Action } from '../channel/actions';
import type { AnswerMap, AnswerSource, QuestionMap } from '../jev/types';
import type { TurnState } from '../core/state';
import type { GateRow } from '../core/gates';
import type { Decision } from '../core/decision';
import type { PendingConfirmation, SlotState } from '../core/session';
import type { FormId, SlotId } from '../core/app/types';
import type { ScreenResult } from '../core/screen';
import type { Effect, GateEvent, KbSource } from '../core/lifecycle';
import type { AuditDraft } from '../audit/types';

export type TraceSource = AnswerSource | 'dtmf' | 'silence' | 'error' | 'none';

export interface TraceTiming {
  planMs: number;
  askMs: number;
  resolveMs: number;
  totalMs: number;
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
