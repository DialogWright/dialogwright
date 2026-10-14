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
import type { SlotExhausted } from '../core/outcome';
import type { RouteTaken } from '../core/routes';
import type { RenderRecord } from '../render/types';

export type TraceSource = AnswerSource | 'dtmf' | 'silence' | 'error' | 'none';

export interface TraceTiming {
  /** How long the knowledge retriever took, before planning; only on a turn it ran (TraceRecord.retrieval). */
  retrieveMs?: number;
  /** How long the generated lines took, after the core decided; only on a turn that rendered one (TraceRecord.render). */
  renderMs?: number;
  /** How long the turn's second request took (TraceRecord.followUp), its retrieval not included (that is `retrieveMs`); only on a turn that asked for one. */
  followUpMs?: number;
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

/**
 * A turn's second request on the same words (core/turn.ts FollowUp; run/turn.ts): why it was made, the
 * slot whose question it asked, its questions and answers (null when it failed), where they came from,
 * the error when it failed (the turn went on without it), and its usage, which the record's `usage`
 * includes. `answers` are not in the record's own `answers`, which are its first request's.
 */
export interface FollowUpRecord {
  reason: 'aside-topic';
  slot: SlotId;
  questions: QuestionMap;
  answers: AnswerMap | null;
  source: TraceSource;
  error: { name: string; message: string } | null;
  usage: { inputTokens: number; outputTokens: number; estimated: boolean } | null;
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
   * Written by a server after it had let the call go (TRACE_STORE=s3://..., trace/store.ts): a turn that
   * outlived its server's hold on the call, whose record is kept for what it did, but whose turn the
   * server that took the call over ran too. Readers show it marked, and kb:gaps and the turn counts pass
   * over it. Absent on every other record (and always on one machine).
   */
  outlivedHold?: true;
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
   * not fit the slot, or for an app that keeps it for its code, no usable number), so a builder can
   * see why no offer or lookup was made. Only on the session start's record of an app with a slot
   * that offers it (SlotSpec.callerNumber) or that keeps it (app.yaml's callerNumber); absent for
   * every other app.
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
   * The turn's second request (FollowUpRecord): only on a turn that made one (an aside asked for in
   * the middle of a task, its topic unknown, retrieval nominating something); absent on every other.
   */
  followUp?: FollowUpRecord;
  /**
   * Only on a turn that joined the final prompts of a caller who had not finished (run/continuation.ts,
   * voice.continueWithinMs): the prompts, in order, as each was heard. The event's words are them
   * joined; each fragment's own turn is an earlier record. With `waitedFor`, the words the voice server
   * held for the rest of that slot's value before any turn ran (a `digits` slot's `waitForRestMs`,
   * run/continuation.ts HeldWords): no fragment had a turn of its own. Absent on every other turn.
   */
  joined?: { fragments: string[]; waitedFor?: string };
  effects?: Effect[];
  /**
   * The slot_exhausted event: the slot that ran out of attempts on this turn, the failures it took,
   * and what followed (its onMaxAttempts' then; core/outcome.ts). Only for a slot with retries of its
   * own (SlotSpec.attempts or onMaxAttempts); absent on every other turn, and for every other slot,
   * whose running out is the handoff it always was.
   */
  slotExhausted?: SlotExhausted;
  /**
   * A form entered again by a move within one turn (`next`, or an outcome's `then: form`), so the call
   * went to a person (`needs-human`) rather than round the loop: the form, and the form it was entered
   * from. Absent on every other turn.
   */
  formLoop?: { form: FormId; from?: FormId };
  /**
   * The routes taken on this turn (routes.yaml, core/routes.ts), in order: the point, the form (after a
   * form), the rule (its number, the first being 1, or `else`), what followed, and the subjects the rule read, never
   * their values. Absent on every other turn, and for every app without routes.
   */
  routes?: RouteTaken[];
  /** The app's start hook (App.onStart) threw on this turn: its kind of error (a class's name), never its message. Absent on every other turn. */
  startHookFailed?: string;
  /**
   * A keypad menu key taken at the open question, before the menu was offered (intents.yaml's
   * menuListens, a menu entry's fromGreeting): the key and the intent it chose. Absent on every other
   * turn, a key on the offered menu among them (the event and the decision say that one).
   */
  menuKey?: { digit: string; intent: string };
  /**
   * This turn's audit drafts, in the order they were chained -- before chaining: no `seq` or
   * `hash` yet (those are the sink's, core/audit.ts's `AuditDraft` is what a turn reports). The
   * dashboard's live audit tail (hash and all) comes from the separate `audit` bus event instead;
   * this is what a replayed trace has to count a turn's audit entries by, since that event is
   * never written to the trace file.
   */
  audit?: AuditDraft[];
  /**
   * What generated wording did on this turn (render/turn.ts): the call's group (RENDER_SHARE), and each
   * line the app generates that the turn said, with its mode, its fixed line, the wording said or why
   * it fell back, and what it cost. `actions` hold the words as said; `decision` is the core's, whose
   * lines are the fixed ones. Only for an app that generates a line, on a run with a renderer, on the
   * call's first turn and each turn that says such a line; absent on every other record.
   */
  render?: RenderRecord;
}
