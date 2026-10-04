/**
 * Types for `view.js`. The module itself is plain JavaScript so the browser can load it with no
 * build step; this file is what TypeScript resolves for `import … from './view.js'`.
 */
import type { DashboardEvent } from './events';
import type { ReplayRecord } from './routes';
import type { FrameLogLine } from '../frameLog';
import type { Thresholds } from '../../core/thresholds';
import type { GateRow } from '../../core/gates';
import type { AnswerMap, QuestionMap } from '../../jev/types';
import type { PendingConfirmation } from '../../core/session';
import type { ConsoleMeta } from './meta';

export interface Row {
  id: string;
  kind: string;
  p: number | null;
  value: string | null;
  threshold: number | null;
  decisive: boolean;
  top: Array<{ label: string; p: number }> | null;
}

export interface Group {
  name: string;
  rows: Row[];
  decisive: boolean;
  quiet: number;
}

export interface Chip {
  id: string;
  state: 'empty' | 'partial' | 'filled';
  label: string;
  changed: boolean;
  attempts: number;
}

export interface Line {
  /** `handoff` is the transfer to a person, as its own labelled row ("to …9110 · caller asked for a person"). */
  kind: 'system' | 'caller' | 'marker' | 'handoff';
  text: string;
  promptId?: string;
  turn?: number;
}

export interface StageCell {
  state: 'pass' | 'fail' | 'warn' | 'skip' | 'idle';
  label: string;
}

/** The five stages the console shows per caller turn: screen, perception, dialog policy, action gate, audit. */
export interface Stages {
  screen: StageCell;
  perception: StageCell;
  policy: StageCell;
  gate: StageCell;
  audit: StageCell;
}

export interface TurnView {
  turnIndex: number;
  /** The line the caller heard on this turn, or null when nothing was said (a keypad digit, a silence). */
  said: string | null;
  /** The turn's event type: `user.speech` or `user.text` for words, `user.key`, `user.silence`, `service.result` for a downstream service's answer, `session.start`. */
  input: string | null;
  stages: Stages;
  /** On a downstream service's answer turn: what the app's service client made of the reply, in words; `warn` when anything was refused or ignored. */
  service: { text: string; warn: boolean } | null;
}

export interface GateRule {
  id: string;
  description: string;
  compared: string;
  pass: boolean;
}

/** The latest action-gate decision: the redacted call, its verdict, and every rule it checked. */
export interface GateView {
  display: string;
  verdict: string;
  reason: string | null;
  rules: GateRule[];
  /** The turn this call came from; the gate card labels itself from this, and from `View.gateIsCurrent`. */
  turnIndex: number;
}

/** The knowledge-base passage the latest answer came from (core/lifecycle.ts KbSource, as the card shows it). */
export interface SourceView {
  passageId: string;
  document: string;
  section: string;
  version: string;
  /** The first day it is in force, and the last (null: open-ended). */
  effective: string;
  effectiveTo: string | null;
  /** The day it was approved and by whom (null: no approval). */
  approved: string | null;
  approvedBy: string | null;
  fresh: boolean;
  /** Whom it answered, one "fact: value" line per fact, sorted by fact. */
  applies: string[];
  locale: string | null;
  /** The approval's short digests (12 hex characters), of the source text and of everything approved. */
  sourceHash: string | null;
  approvalHash: string | null;
}

/**
 * One line of the audit tail; `hash` is the entry's first eight hex characters.
 * `fromTrace` marks a row `reduce`'s `fromTrace` option reconstructed from a record's own `audit`
 * drafts (replay only) rather than a real, chained `audit` bus event -- such a row has no `seq` or
 * `hash` yet, so both are null instead of a fabricated or stale value.
 */
export interface AuditTailEntry {
  seq: number | null;
  type: string;
  line: string;
  hash: string | null;
  fromTrace?: boolean;
}

/** The handoff card: the reason, the Claude-written summary (null until it arrives, or on failure), and the collected packet. */
export interface HandoffView {
  reason: string;
  summary: string | null;
  /** True until the `handoff_summary` event arrives (live only: a replayed trace never has one). */
  summaryPending: boolean;
  /** The summary is the demo feed's scripted text (`handoff_summary` with `demo: true`), not a model's. */
  summaryDemo: boolean;
  packet: string[];
}

/**
 * One NOW chip. `label` is display-safe by construction (ConsoleMeta.chipStyle): an identifier only
 * by its last four, a verified factor only as `given`/`verified`, the caller's words only as `recorded`.
 */
export interface NowChip {
  id: string;
  /** The slot in words (ConsoleMeta.slotLabels), or its id. */
  name: string;
  state: 'empty' | 'partial' | 'filled';
  label: string;
}

/** The transfer, as the NOW panel says it; `number` is the adapter's masked one, null until known (or in replay). */
export interface NowHandoff {
  number: string | null;
  reason: string;
  reasonText: string;
}

/**
 * The NOW panel: what the agent is working on at this moment. `handoff` wins over everything, then
 * an open form (`task`), then the last form completed on the call (`completed`), else `idle`.
 */
export interface NowView {
  state: 'idle' | 'task' | 'completed' | 'handoff';
  /** The open form (task), or the one open when the call was handed off. */
  form: string | null;
  /** `form` in words (formLabel). */
  label: string | null;
  /** The form's slots, preceded by the identity slots while the caller is being stepped up. Task only. */
  chips: NowChip[];
  /** "asking expectedDate · attempt 1 of 3", "confirming the summary with the caller", or null. */
  asking: string | null;
  /** Forms waiting behind the open one, in words, lower case. */
  queued: string[];
  /** The forms completed on the call so far, in words, or null. */
  completedLabel: string | null;
  /** What the task established, from its audit drafts by the app's fact rules (ConsoleMeta.facts). */
  fact: string | null;
  handoff: NowHandoff | null;
}

export interface View {
  status: string;
  callSid: string | null;
  turnCount: number;
  /** `p50AskMs` is the median ask time over the turns that consulted the model. */
  totals: { askMs: number; tokens: number; usd: number; p50AskMs: number };
  lines: Line[];
  form: string | null;
  chips: Chip[];
  pending: string | null;
  queued: string[];
  asking: string | null;
  jev: { header: string; pending: boolean; groups: Group[]; decision: string };
  thresholds: Partial<Thresholds>;
  /** The session's channel kind (`voice`, `chat`), as call_started names it. */
  channel: string | null;
  /**
   * The language the session speaks (a language tag), from the latest turn record that names one:
   * only a call of an app that declares locales (App.locales) has one; absent otherwise.
   */
  locale?: string;
  /**
   * The combined hash of the configuration the call runs under (App.configHashes.app), from the
   * latest turn record that names one: only a call of an app built from a folder has one; absent otherwise.
   */
  configHash?: string;
  caller: string | null;
  /** The last turn's `turnState.caller.level`; unset while a non-model turn is in flight, it holds the last one seen. */
  level: 0 | 1 | 2;
  turnsView: TurnView[];
  gate: GateView | null;
  /** True when the turn on screen (the latest live, or the selected one in replay) made a call of its own. */
  gateIsCurrent: boolean;
  source: SourceView | null;
  /** The call's audit entries seen live (at most 500), newest last. Empty in replay: the trace holds no audit event (see replayEvents). */
  auditTail: AuditTailEntry[];
  handoff: HandoffView | null;
  /** True when the turn on screen was quarantined: perception ran but nothing acted on its answers. */
  perceptionDiscarded: boolean;
  now: NowView;
}

export interface ReplayOptions {
  from?: string;
  thresholds?: Partial<Thresholds>;
  /** Masked, for the handoff row's `to …4567`; the trace does not record the number dialled. */
  handoffNumber?: string;
}

/** Options `reduce` reads; see the doc comment on the function itself. */
export interface ReduceOptions {
  fromTrace?: boolean;
}

/** A row of `/dashboard/traces`, the shape `latestTrace` and the trace picker read. */
export interface TraceRow {
  callSid: string;
  startedAt: string | null;
  turns: number;
  sizeBytes: number;
}

/** Takes the app's console metadata; until then the view is neutral, with no slots. */
export function configure(meta: ConsoleMeta): void;
/** Every slot of the configured app, in the order shown outside a form (ConsoleMeta.slotOrder). */
export const ALL_SLOTS: readonly string[];
/** Each form's slots in the configured app (ConsoleMeta.formSlots). */
export const FORM_SLOTS: Readonly<Record<string, readonly string[]>>;

/** A form id in words: the app's label (ConsoleMeta.formLabels), or the id with spaces. */
export function formLabel(form: string | null | undefined): string;
/** A handoff reason in words: `live-agent` reads "caller asked for a person"; the app's own from ConsoleMeta.handoffReasons. */
export function handoffReasonText(reason: string | null | undefined): string;
export function reduce(events: DashboardEvent[], opts?: ReduceOptions): View;
export function replayEvents(records: ReplayRecord[], frames: FrameLogLine[], opts?: ReplayOptions): DashboardEvent[];
export function latestTrace(rows: TraceRow[]): TraceRow | null;
export const TRACE_NAME_MAX: number;
export function cleanTraceName(raw: unknown): string;
export function traceLabel(row: TraceRow, name?: string | null): string;
export function positionText(turnCount: number, totalTurns: number, cursor: number, totalEvents: number): string;

/**
 * One exchange of the conversation pane: what the agent said, what came back, and the turn that
 * handled what came back (null while nothing has).
 */
export interface Exchange {
  turn: number | null;
  prompt: Line[];
  input: Line[];
}
export function exchanges(lines: readonly Line[]): Exchange[];
/** A downstream service's answer, in the app's words (ConsoleMeta.serviceNote). */
export function serviceNoteView(event: { result?: unknown; note?: { outcome: string; reason: string | null; ignoredTextParts: number } } | null | undefined): { text: string; warn: boolean };

/** One line of the script view. `screened` marks a caller line the injection screen quarantined. */
export interface ScriptLine {
  who: 'caller' | 'agent' | 'keypad' | 'handoff' | 'note';
  text: string;
  screened?: boolean;
  /** A caller line that held a one-time code said aloud, masked on arrival. */
  codeMasked?: boolean;
}
export const CODE_MASK: string;
export function scriptOf(lines: readonly Line[], turnsView: readonly TurnView[]): ScriptLine[];

/** The replay positions a step lands on: a keypad entry is one step, not two per digit. */
export function replayStops(events: readonly DashboardEvent[]): number[];
/** The stop `delta` steps from `cursor`, clamped to the ends. */
export function stepStop(stops: readonly number[], cursor: number, delta: number): number;
export function decisiveRows(
  answers: AnswerMap | Record<string, unknown> | null,
  thresholds: Partial<Thresholds>,
  gateRows: readonly GateRow[] | readonly unknown[],
  questions?: QuestionMap | Record<string, unknown> | null,
  /** The form the batch was asked under: which rung the `intent` row's tick is drawn at. */
  activeForm?: string | null,
): Row[];
export function groupRows(rows: Row[], formSlots: readonly string[], pending: PendingConfirmation | { target: string } | null): Group[];
export function thresholdFor(id: string, thresholds: Partial<Thresholds>, activeForm?: string | null): number | null;