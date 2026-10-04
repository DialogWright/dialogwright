import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RetrievalRecord, TraceRecord, TraceTiming } from './types';
import { redactRecordSlots } from './redact';
import type { SessionEvent } from '../channel/events';
import type { JevResponse, JevUsage, QuestionMap } from '../jev/types';
import type { TurnError, TurnResult } from '../core/turn';
import type { Session } from '../core/session';
import { appOf } from '../core/app/registry';
import { recordedEffect } from '../core/recording';

export class TraceWriter {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  /**
   * The identity FIELDS are masked: wherever the record carries a slot, the account ID
   * is its last four, the date of birth its year, a free-text note its length
   * (redactRecordSlots), and a keyed digit of the code, account ID or birth date is masked
   * (runTurn). The caller's words are kept, though: the ASR transcript (the event, and the turn
   * state and questions the model was shown) is the trace's reason to exist, and a caller who says
   * their account ID, birth date or note says it there. So a trace file is PHI-bearing, and is
   * kept apart from the audit log, which holds none. The record in memory is left whole; the core
   * and the harness read it.
   */
  write(record: TraceRecord): void {
    appendFileSync(this.path, JSON.stringify(redactRecordSlots(record, 'length')) + '\n');
  }
}

export interface TraceInput {
  result: TurnResult;
  event: SessionEvent;
  questions: QuestionMap | null;
  response: JevResponse | null;
  error: TurnError | null;
  /** the injection screen's usage, when it answered; added into the record's usage and cost */
  screenUsage?: JevUsage | null;
  timing: TraceTiming;
  /** What the knowledge retriever did before the turn was planned; null or absent when it did not run. */
  retrieval?: RetrievalRecord | null;
  ts: string;
  pricePerMtok: number;
}

/** The record's `configHash`: the combined hash of the session's app (App.configHashes), when it has one. */
function configHashOf(session: Session): { configHash: string } | Record<string, never> {
  const hashes = appOf(session).configHashes;
  return hashes ? { configHash: hashes.app } : {};
}

export function buildTraceRecord(input: TraceInput): TraceRecord {
  const { result, event, questions, response, error, timing, ts, pricePerMtok } = input;
  const screenUsage = input.screenUsage ?? null;
  const source = error ? 'error' : response ? response.source : event.type === 'user.key' ? 'dtmf' : event.type === 'user.silence' ? 'silence' : 'none';
  const inputTokens = (response?.usage.inputTokens ?? 0) + (screenUsage?.inputTokens ?? 0);
  return {
    v: 2,
    sessionId: result.session.sessionId,
    turnIndex: result.session.turnIndex,
    ts,
    event,
    turnState: result.turnState,
    questions,
    answers: response?.answers ?? null,
    source,
    error,
    gates: result.rows,
    decision: result.decision,
    actions: result.actions,
    form: result.session.form,
    slots: result.session.slots,
    queued: [...result.session.queued],
    // Copied, not aliased: `attempts` on the session's pendingConfirmation is mutated in place by
    // later turns, and the dashboard holds records like this one in memory.
    pendingConfirmation: result.session.pendingConfirmation ? { ...result.session.pendingConfirmation } : null,
    promptedFor: result.session.promptedFor,
    completed: [...result.session.completed],
    // Only a session of an app that declares locales has one; every other record is as it was.
    ...(result.session.locale !== undefined ? { locale: result.session.locale } : {}),
    // Only an app built from a folder has configuration hashes; every other record is as it was.
    ...configHashOf(result.session),
    screen: result.screen ? { ...result.screen } : null,
    quarantined: result.quarantined,
    // Added for the dashboard's stages, gate and source-of-truth cards: every gate
    // decision, the knowledge-base passage, the runner's side effects, and this turn's audit
    // drafts (before chaining -- no seq or hash yet; those live only on the live `audit` bus event).
    gateEvents: [...result.gateEvents],
    kb: result.kb,
    // Only on a turn the retriever ran: every other record is as it was.
    ...(input.retrieval ? { retrieval: input.retrieval } : {}),
    // As recorded: each param masked as its call was (core/recording.ts recordedEffect); the runner sends the effect itself.
    effects: result.effects.map(recordedEffect),
    audit: [...result.audit],
    timing,
    usage: {
      inputTokens,
      outputTokens: (response?.usage.outputTokens ?? 0) + (screenUsage?.outputTokens ?? 0),
      estimated: (response?.usage.estimated ?? true) || (screenUsage?.estimated ?? false),
      costUsd: (inputTokens * pricePerMtok) / 1_000_000,
    },
  };
}
