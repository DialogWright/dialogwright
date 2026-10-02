import type { AnswerMap, QuestionMap } from '../../jev/types';
import type { Thresholds } from '../thresholds';
import type { SlotId } from '../app/types';

/**
 * A slot's own pending narrowing: part of a value heard, the rest still owed (e.g. a date of birth: a
 * month and day, the year to come). `kind` is the slot's word for it; the parts are its own, and
 * the engine only compares them, part by part, and zeroes the numeric ones where the slot's value
 * is redacted (SlotSpec.redact). A date-valued slot (SlotSpec.valueKind 'date') names the day it
 * has heard as numeric `month` and `day` parts, which the engine reads to tell one day heard twice.
 */
export interface SlotPartial {
  kind: string;
  [part: string]: string | number;
}

export interface SlotContext {
  text: string;
  candidateSpans: string[];
  candidateWordSpans: string[];
  todayIso: string;
  thresholds: Thresholds;
  /** the slot's own pending partial, null when none is pending */
  window: SlotPartial | null;
  /** the slot's own current value (slotCtx sets it per spec), null when unfilled */
  current: string | null;
  /**
   * The app's records the slot specs may offer to choose from (App.facts.forSlots; e.g. the
   * customer's parcels, so one can be chosen by what it holds). Opaque to the engine; empty when
   * the app gives none, or before it has any.
   */
  records: readonly unknown[];
  /** The last prompt asked for this slot (slotCtx sets it per spec); a miss then is invalid rather than absent. */
  prompted: boolean;
  /**
   * The language the session speaks (core/locale.ts localeOf), for a slot to hear and say its value
   * in: number words, the order of a day and a month, a display. Only an app that declares locales
   * (App.locales) has one, so a slot formats as it always has (en-US) when it is absent, and an app
   * without locales sees no change at all. A slot formats en-US the same whether this is `en-US`
   * or absent.
   */
  locale?: string;
}

export interface SlotCandidate {
  value: string;
  display: string;
}

export type SlotOutcome =
  | { kind: 'absent' }
  | { kind: 'filled'; value: string; display: string; confidence: number; confirm: 'none' | 'implicit' }
  | { kind: 'disambiguate'; a: SlotCandidate; b: SlotCandidate }
  | { kind: 'window'; window: SlotPartial; confidence: number }
  /**
   * What the caller said cannot be the value. `retryPromptId`, when set, is the re-ask at the open
   * rung in place of the slot's generic `ask_<slot>_retry`, for a reason that generic text would
   * misdescribe.
   */
  | { kind: 'invalid'; reason: string; raw: string; retryPromptId?: string }
  /** The caller said whether they know the value rather than saying it; play this prompt in place of the question. */
  | { kind: 'help'; promptId: string };

/**
 * A line a slot can lead the engine to say, beyond the `ask_<slot>` and `ask_<slot>_retry` every
 * asked slot has (e.g. `disambiguate_<slot>` with {a} and {b}, a help prompt, a retryPromptId, the
 * partialPromptId with its partialVars). `dialogwright check` requires the line in every locale and
 * refuses one that uses a variable not listed here.
 */
export interface SlotPrompt {
  /** The prompt id, as the slot's outcome or the engine names it. */
  id: string;
  /** When it is said, in words, for check's message ("the caller said a number that is not eight digits"). */
  why: string;
  /** The variables the line is given (`a`, `b`; a slot's own id for an ack or a read-back). Absent: none. */
  vars?: readonly string[];
}

export interface SlotSpec {
  id: SlotId;
  /**
   * Every question id `questions()` may return, in any state, declared up front so a collision with
   * another slot's, the engine's (core/questions.ts ENGINE_QUESTION_IDS) or the app's own questions is
   * found when the app is validated rather than on the turn that asks both. A spec that declares
   * them may ask no other (a turn that does throws). Absent: the ids are known only per turn, and
   * buildQuestions checks them there.
   */
  questionIds?: readonly string[];
  /**
   * Every line the slot can lead the engine to say beyond `ask_<slot>` and `ask_<slot>_retry`
   * (SlotPrompt). It may also list the ones check derives from the spec (`ack_<slot>`,
   * `confirm_<slot>`, `ask_<slot>_dtmf`, the partialPromptId) to declare their variables. Absent:
   * check knows only the derived ones.
   */
  prompts?: readonly SlotPrompt[];
  /** always: a spoken fill is read back and must be confirmed before it counts, which needs a `confirm_<slot>`
   * entry in the prompt manifest (no slot uses this today, so none is there); by-confidence: the fill outcome
   * decides; summary: a spoken fill is neither acked nor read back; the final confirm covers it */
  spokenConfirm: 'always' | 'by-confidence' | 'summary';
  /** Questions this slot adds to the turn schema. */
  questions(ctx: SlotContext): QuestionMap;
  /** Interpret the answers to those questions. */
  fill(answers: AnswerMap, ctx: SlotContext): SlotOutcome;
  /** DTMF fallback: how many digits to collect and how to parse them. Absent: the slot has no
   * keypad rung; its retry ladder is retry, retry, agent. */
  dtmf?: {
    length: number;
    parse(digits: string, ctx: SlotContext): SlotCandidate | null;
  };
  /**
   * The value as it is said, in `locale` (SlotContext.locale) when given. The engine does not call
   * it: a fill and a keypad parse carry their own display, which a slot formats with ctx.locale.
   */
  display(value: string, locale?: string): string;
  /**
   * How the slot's value is masked wherever it leaves the turn: a tool call's param of the same
   * name as it is recorded (the gate event, the trace, the audit), and the trace's and console's
   * copies of the slot (its value, display, the turn state the model saw, a readback, a handoff's
   * collected slots, a side effect's params). Absent: the value is kept as it is.
   * - `last4`: an identifier, by its last four digits ("...1234").
   * - `mask`: hidden, but for a year it holds ("••/••/1985"); a call's param as "•".
   * - `length`: the caller's own words, by their length ("<38 chars>"), in the trace's value and a
   *   call's or effect's params; the slot's display is a stand-in and is kept, and the live console
   *   keeps the words (StatementMode 'keep').
   * A redacted slot's pending partial is masked too: its numeric parts are zeroed, its shape kept.
   */
  redact?: 'last4' | 'mask' | 'length';
  /**
   * How a handoff hands the slot over in what the call collected (HandoffDecision.slots). Absent:
   * its display. `last4`: the value's last four digits. `verified`: only whether identity was
   * verified (IDENTITY_VERIFIED, or IDENTITY_UNVERIFIED), never the value itself.
   */
  handoff?: 'last4' | 'verified';
  /**
   * `date`: the value is a calendar day (an ISO date), so it can hear the same day as another
   * date-valued slot on one turn (fia.ts sameDayAsPrompted). Absent: any other value.
   */
  valueKind?: 'date';
  /**
   * The slot's fill rests on a yes-or-no detection question (e.g. an account ID: "does the caller
   * state one?"), so its gate row is measured against SLOT_DETECT. Absent: the slot is picked by a
   * choice question, measured against SLOT_CHOICE_CONFIRM.
   */
  detect?: boolean;
  /**
   * The prompt that asks for the rest of a value the slot holds only part of (a pending partial,
   * SlotOutcome 'window'; e.g. a date of birth: ask_dob_year). Absent: the slot's own ask_<slot>.
   */
  partialPromptId?: string;
  /**
   * The variables of the prompt asking for the rest of a partial value (e.g. a date window's
   * "{window}. Which day works for you?" gets "next week"), read wherever that question is asked.
   * Absent: none. `locale` is the session's, as SlotContext.locale has it (absent for an app
   * without locales).
   */
  partialVars?(window: SlotPartial, locale?: string): Record<string, string>;
}
