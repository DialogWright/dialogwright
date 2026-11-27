import { UNANSWERED_QUESTION, UNANSWERED_QUESTION_AUDIT_DEFAULT, type ActionSpec, type AgentBusiness } from './business/schema';
import type { LookUpRecord } from './knowledge';

/**
 * The runtime's own note of a question the business could not answer (decided 2026-11-27): `unanswered_question`, offered to the
 * agent model on every turn unless agent.yaml's `gaps.note` is off, but never on an unclear turn (turn.ts unansweredQuestionNow). Only the model knows that what it had to answer from
 * did not answer the caller (a lookup that returned a passage that does not say, or a question the business information
 * does not cover with no knowledge base at all), so it says so with this. It records the question for the business to
 * review (`kb:gaps`, the console's Knowledge page), with what the turn's lookups found and the journey the call is in,
 * and does nothing else: nothing is said by it and nothing is passed on during the call. Written beside a reply with
 * nothing else called, it takes no second round of the model (converse/turn.ts).
 */

/** Its one param: the question the business could not answer, in general terms. */
export const GAP_QUESTION_PARAM = 'question';

/** The most characters the question may have. */
export const GAP_QUESTION_MAX = 300;

/** What the note is, for the model: what it is for, and what it is not (no callback). Context, never words for a reply. */
export const UNANSWERED_QUESTION_ABOUT = 'An internal record the line keeps for the business to review later: a question the caller asked that the business information and the lookups on this call do not answer, or answer only in part. Call it whenever you tell the caller you do not have that answer, in the same reply. It is part of how the line works, so never mention it to the caller: it reaches no one during the call and does nothing for the caller, so a caller who wants an answer still needs a callback note or a person, where the line can offer them.';

/** What the question is, for the model. */
export const GAP_QUESTION_ABOUT = 'The question the business could not answer, written as the question in general terms, without the caller\'s name or any of their details.';

/** What the model is told once a note is recorded: one short fact. */
export const NOTED = 'Recorded for the business to review.';

/** Whether the app has unanswered_question: on unless agent.yaml's `gaps.note` is off (in the gate; offered on every turn but an unclear one). */
export function unansweredQuestionOffered(b: AgentBusiness): boolean {
  return b.gaps?.note !== 'off';
}

/** The note as an action, for the gate, the audit and the trace: a lookup with one text param, recorded as agent.yaml's `gaps.audit` says. */
export function unansweredQuestionSpec(b: AgentBusiness): ActionSpec {
  return {
    about: UNANSWERED_QUESTION_ABOUT,
    kind: 'lookup',
    params: { [GAP_QUESTION_PARAM]: { type: 'text', about: GAP_QUESTION_ABOUT, max: GAP_QUESTION_MAX } },
    audit: { [GAP_QUESTION_PARAM]: b.gaps?.audit?.question ?? UNANSWERED_QUESTION_AUDIT_DEFAULT },
  } as ActionSpec;
}

/** One lookup of the turn as a note keeps it: what came of it, and the topic it read (or, where it read none, the one nominated first). */
export interface GapLookUp {
  outcome: LookUpRecord['outcome'];
  /** The topic the decision model read (a passage returned or withheld). */
  topic?: string;
  /** Where it read none: the topic the retriever nominated first, the nearest. */
  nearest?: string;
}

/** One note, as the trace and the audit record it. */
export interface GapNoteRecord {
  /** The question as recorded (gaps.audit; by its length by default). */
  question: string;
  /** What each of the turn's lookups in the knowledge base found, before the note, in order (none: no lookup was made). */
  lookUps: GapLookUp[];
  /** The journey the call was in (`root` where none is active); absent for an app with no journeys. */
  journey?: string;
}

/** The note of a question recorded as `recorded`, with the turn's lookups so far and the journey. */
export function gapNoteOf(recorded: string, lookUps: readonly LookUpRecord[], journey: string | undefined): GapNoteRecord {
  return {
    question: recorded,
    lookUps: lookUps.map((l): GapLookUp => ({
      outcome: l.outcome,
      ...(l.topic !== undefined ? { topic: l.topic } : l.candidates[0] !== undefined ? { nearest: l.candidates[0].topic } : {}),
    })),
    ...(journey !== undefined ? { journey } : {}),
  };
}

/** A lookup of a note's turn as the audit row lists it, in one line: its outcome, and its topic or the nearest ("answered: care", "none: nearest returns", "none"). */
export function gapLookUpText(l: GapLookUp): string {
  return l.topic !== undefined ? `${l.outcome}: ${l.topic}` : l.nearest !== undefined ? `${l.outcome}: nearest ${l.nearest}` : l.outcome;
}

export { UNANSWERED_QUESTION };
