import type { TextRecord } from '../texts/types';
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
import type { RenderLine, RenderRecord } from '../render/types';
import type { ValueCheck } from '../slots/types';
import type { ConverseTraceRecord } from '../converse/trace';

/**
 * Any record a call's trace holds: a scripted turn's (TraceRecord, v 2), or a converse runtime's turn
 * (ConverseTraceRecord, v 3, kind 'converse': written as it is, its values already masked by its turn).
 */
export type AnyTraceRecord = TraceRecord | ConverseTraceRecord;
export type { ConverseTraceRecord };

/** Whether a record read from a trace is a converse runtime's turn. */
export function isConverseRecord(r: unknown): r is ConverseTraceRecord {
  return typeof r === 'object' && r !== null && (r as { kind?: unknown }).kind === 'converse';
}

export type TraceSource = AnswerSource | 'dtmf' | 'silence' | 'error' | 'none';

export interface TraceTiming {
  /** How long the knowledge retriever took, before planning; only on a turn it ran (TraceRecord.retrieval). */
  retrieveMs?: number;
  /** How long the generated lines took, after the core decided; only on a turn that rendered one (TraceRecord.render). */
  renderMs?: number;
  /** How long the turn's second request took (TraceRecord.followUp), its retrieval not included (that is `retrieveMs`); only on a turn that asked for one. */
  followUpMs?: number;
  /** How long the old agent mode's agent model took (TraceRecord.agent), within `askMs`: only in a trace written before that mode was taken out. */
  agentMs?: number;
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
  /** The sections of approved documents nominated beside the topics (kb.yaml documents), by key; absent with none to nominate. */
  sections?: { retrieverId: string; nominated: Array<{ key: string; score: number; via: NominationVia }>; failed?: 'error' | 'invalid' | 'late' };
}

/**
 * A turn's second request on the same words (core/turn.ts FollowUp; run/turn.ts): why it was made, the
 * slot whose question it asked, its questions and answers (null when it failed), where they came from,
 * the error when it failed (the turn went on without it), and its usage, which the record's `usage`
 * includes. `answers` are not in the record's own `answers`, which are its first request's.
 */
export interface FollowUpRecord {
  /** Why it was made (core/turn.ts FollowUp): an aside's topic, or (in a trace written before call 54 of the agent-mode design) the scripted reading of a read-back an agent answer failed at. */
  reason: 'aside-topic' | 'agent-failed';
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
   * Whether the engine could use the number the caller is calling from (core/callerNumber.ts
   * usableCallerNumber): `kept`; `ignored`, a number the caller withheld that the app ignores
   * (app.yaml's `callerNumber.withheld: ignore`); or `none` when the call had no usable number (none
   * sent, a placeholder for a withheld one, a SIP address), so a builder can see why no offer or
   * lookup was made. Only on the session start's record of an app that acts on the number (a slot that
   * offers it, or app.yaml's callerNumber: core/callerNumber.ts actsOnCallerNumber); absent for every
   * other app.
   */
  callerNumber?: 'kept' | 'ignored' | 'none';
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
   * What the turn waited on (core/toolWait.ts): each tool call that returned a promise, with how long it
   * took and what it came to, how many times the core ran, and the hold line and thinking sound said while
   * it waited (`hold.said` false where the channel says nothing early: the text harness, a one-reply chat).
   * Only on a turn that called such a tool; absent on every other turn and for every other app.
   */
  waited?: WaitedRecord;
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
  /**
   * What a turn of the old agent mode made of its agent model's answer, and what it was sent (AgentTurnRecord,
   * AgentSentRecord). Nothing writes it now: only in a trace written before that mode was taken out.
   */
  agent?: AgentTurnRecord & { sent?: AgentSentRecord };
  /**
   * The line the old agent mode said while its agent model was slow on a call: its prompt, when it came due (ms
   * from the model first asked), and whether the channel said it. Nothing writes it now: only in a trace
   * written before that mode was taken out.
   */
  filler?: { promptId: string; atMs: number; said: boolean };
  /**
   * The texts the turn's tools sent (texts/types.ts TextRecord): each number by its last four, the body by
   * its length, the media by their count, the provider's id and status. Only on a turn that sent one.
   */
  texts?: TextRecord[];
}

/** What a turn waited on (TraceRecord.waited). */
export interface WaitedRecord {
  calls: { tool: string; ms: number; outcome: 'replied' | 'failed' | 'late' }[];
  /** How many times the core ran: one more than the times it waited. */
  passes: number;
  /** The hold line, when it was due: its line, when (ms after the turn first waited) and whether the channel said it. */
  hold?: { promptId: string; atMs: number; said: boolean };
  /** How many times the thinking sound played. */
  sounds?: number;
}

/**
 * What a turn of the old agent mode made of its agent model's answer (TraceRecord.agent), as a trace written
 * before that mode was taken out holds it. Nothing writes it now; it is kept so such a trace still reads.
 */
export interface AgentTurnRecord {
  /** How long the answer took, ms. */
  ms: number;
  /** `used`: the turn read it; `dropped`: the turn was decided without it (`dropped` says by what); `failed`: there was no answer to read (`fallback` says why). */
  use: 'used' | 'dropped' | 'failed';
  /** What decided the turn without the answer: the gates' verdict, or what the call was at (a pending offer, a screen). */
  dropped?: string;
  /** Why there was no answer to read (agentFallback): the fallback was said. */
  fallback?: AgentFailure;
  /** The failure's detail, safe to record (no key, no words of the answer). */
  detail?: string;
  /**
   * Each value the answer gave: the value proposed and the caller's words it cited, and what its check made
   * of it; an accepted one with its `shown`. Each masked in the trace as the records mask its field's slot.
   * `earlier`: its cited words are not in this turn's words but in an earlier line of the caller's on the call,
   * which the check held them to (a text, name or digits field still empty; calls 57 to 59). `counted: false`:
   * refused by its slot type's check (its shape, its words, unsupported), and no attempt counted on its field:
   * the model's value, not the caller's miss; past business.yaml's `values.refusedUncounted` refusals of the field each counts.
   */
  values: { field: string; slot?: SlotId; value: string; words: string; outcome: AgentValueOutcome; shown?: string; restated?: true; by?: 'decision-model'; earlier?: true; counted?: false }[];
  /**
   * A choice of yes and no the line had just asked, read by the decision model's yes or no (yesNoRead): the
   * field, the option it filled, and the readings with their bar. Its value is on `values` with `by:
   * 'decision-model'`, in place of any the answer gave the field. Absent on every other turn.
   */
  yesNo?: { field: string; option: string; yes: number; no: number; at: number };
  /** The reply the answer gave, said or not (`replySaid`); masked in the trace as a line said is. */
  reply?: string;
  /** The action the answer proposed (`none` where it proposed none, or there was no answer). */
  action: string;
  /**
   * What the turn did with it: `taken`; `checked`, a `callback` the decision model read only some sign of a
   * person asked for on, asked of the caller first ("do you want to speak with someone?"); or `ignored` (a
   * `submit` with a field empty, a `callback` the decision model read no sign of or against a yes at the
   * read-back, an action the turn had no use for).
   * Absent with no action.
   */
  actionOutcome?: 'taken' | 'checked' | 'ignored';
  /** Whether the answer said it answers from the facts. */
  fromFacts?: boolean;
  /** Whether the reply was said, as an agent line in place of its fallback or before it. */
  replySaid: boolean;
  /**
   * The field the answer said its reply's question asks for (AgentAnswer.asks; the agent-mode design, call 55),
   * recorded whenever the answer named one, and whether the turn took it as its question (`taken`: the reply,
   * asking something, said in place of that field's fixed question, which is its fallback, what a silence asks
   * again and what the next turn reads the words for). Not taken where the reply was not said, asks nothing (an
   * aside, said before the form's next question), or names no field of the form open still empty, or a choice
   * of yes and no (whose own fixed question is always said): the form's own next field, as before.
   */
  asks?: { field: string; taken: boolean };
  /**
   * The answer said its reply takes leave of the caller (AgentAnswer.closes, call 55), recorded whenever it did:
   * such a reply is never said. Absent otherwise.
   */
  closes?: true;
  /**
   * The cancel question at the read-back on this turn (TurnOut.cancel; call 55): `asked` (the caller said they don't
   * want to go ahead), `kept` (their no: the read-back again) or `cancelled` (their yes: nothing sent, the call
   * ended). Absent on every other turn.
   */
  cancel?: 'asked' | 'kept' | 'cancelled';
  /**
   * The fixed line said whole before the turn's line in place of the reply (the price line): the one the answer
   * named (AgentAnswer.fixedLine), or the price line the decision model read the caller asking for where the
   * answer named none (`priceAsked`). The reply was not said.
   */
  fixedLine?: string;
  /**
   * The decision model's reading of whether the caller asks what something costs (its `asksPrice` question), on
   * a turn of an app with a price line (the agent-mode design, call 43): `score`, the bar it was read against
   * (AGENT_PRICE_ASKED), and whether the answer named the price line. The line is said where the score reaches
   * the bar (and the form open allows it, `prices.forms`), named or not; under it, never, and where the answer
   * named it, nor is the reply (call 43's amendment). Absent where the decision model gave no reading: then a
   * line named is said (the safe outcome) and none named is not.
   */
  priceAsked?: { score: number; at: number; named: boolean };
  /**
   * The reply held to the facts (render/agentLine.ts): the agent line as said (`mode: generated`, with the
   * judge's reading) or replaced by its fixed line (`mode: fixed`, with why, the reply refused, and the
   * judge's reading where it was asked). Absent where no reply was said.
   */
  line?: RenderLine;
  /** The agent model's tokens and their cost, US dollars (the provider's own, else at the model's price); set by the runner. */
  usage?: { inputTokens: number; outputTokens: number };
  costUsd?: number;
  /**
   * The agent model asked again on this turn, with the results of the tools it sees (TurnResult.agentAgain),
   * set by the runner: the tools whose results it was shown, how long the second answer took, ms, and why
   * there was none where it failed (the turn then said what it first decided, its reply not said). This
   * record is then of the second answer where it came, and `ms` is both answers' time.
   */
  again?: { tools: string[]; ms: number; fallback?: AgentFailure; detail?: string };
  /**
   * The agent model asked once more, the same request, after an answer not in its shape on a turn that needed
   * it (AgentRunner.retry, AGENT_RETRY; call 60), or after one the provider's content filter refused (call 61), set by
   * the runner: why the first answer could not be used (`invalid` or `filtered`, its failure's detail, one of the
   * two), how long the second took, ms, and why it failed too where it did. Where
   * the second came, this record is of it (the turn resolved again with it, as with any answer); where it
   * failed, of the first (its fallback said). `ms` is then both answers' time.
   */
  retried?: { invalid?: string; filtered?: string; ms: number; fallback?: AgentFailure; detail?: string };
  /**
   * At a form's read-back, the scripted reading: the decision model asked the form's own questions in the
   * turn's own request, beside the agent's ask (run/turn.ts readBackReading; the agent-mode design's calls 38
   * and 54). `read`: the agent's answer failed, and the turn was decided from the reading (a yes completes, a
   * correction is read back); `unused`: asked and not needed (the agent answered, or the second failure in a
   * row handed off); `none`: the agent's answer failed and there was no reading (the turn's request failed),
   * so the read-back was said again. Absent on every other turn. (Before call 54 the reading was a second
   * request after the agent failed, and `none` was a reading not in time.)
   */
  scripted?: 'read' | 'none' | 'unused';
  /**
   * The text values accepted that are not the caller's words as cited, each as the drift judge read it
   * against them (run/turn.ts, render/agentLine.ts judgeTextValues; calls 40 and 45): held as given
   * (`value`), or not held (`before`: the judge refused it, failed or was late, so the field kept what it
   * held before, or none, and its question was asked again). Absent where none was judged.
   */
  textJudged?: { field: string; score?: number; refuseAt: number; held: 'value' | 'before' }[];
}

/**
 * What a value's check came to: accepted, refused by its slot type (ValueCheck's reason), `field`, naming no
 * field of the form it was given in, `judged`, a text value the drift judge refused against the caller's
 * words (or did not read in time), never held (call 45), or `full`, an option of a `freeFrom` field given for
 * words that name another option, one the day's result shows full, and not it: the caller asked for the full
 * one, so the value is not held and the field's full line is said, no attempt counted (call 55). `range` is a
 * value refused as not free (call 54).
 */
export type AgentValueOutcome = 'accepted' | Extract<ValueCheck, { ok: false }>['reason'] | 'field' | 'judged' | 'full';

/** Why the old agent mode's answer could not be used, as its traces record it. */
export type AgentFailure = 'timeout' | 'invalid' | 'filtered' | 'error';

/** What a trace written by the old agent mode keeps of what its agent model was sent (TraceRecord.agent.sent). */
export interface AgentSentRecord {
  form: string | null;
  fields: { name: string; type: string; value: string | null; required: boolean }[];
  actions: string[];
  conversation: { who: 'caller' | 'line'; text: string }[];
  caller: { account: string | null };
  channel: 'voice' | 'chat';
  overLine: boolean;
  today: string;
  /** The checked results it was shown (a closed form, only the fields each check names); absent where none. */
  seen?: { tool: string; result: unknown }[];
}
