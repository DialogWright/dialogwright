import { handoff, type Completion, type CompletionContext, type FormDef, type Session } from 'dialogwright';
import { factsOf } from './facts';
import type { ClinicForm } from './intents';
import { bookingOf, clinicVars, hasWhatItActsOn, keepsDay, moveOffer, onSchedulingAnswers, readSummary } from './scheduling';
import type { ClinicTool } from './tools';

const valueOf = (s: Session, slot: string): string => s.slots[slot]?.value ?? '';

/** Who the booking is for, with whom: the part of every write's params the slots hold. */
function whoParams(s: Session): { name: string; dob: string; provider: string } {
  return { name: valueOf(s, 'name'), dob: valueOf(s, 'dob'), provider: valueOf(s, 'provider') };
}

/**
 * A booking or a move writes the day the caller chose at the time offered on it. Read from the slots
 * and the offer as they stand: after "yes, but Thursday" the day is Thursday and no opening has been
 * offered on it, so the values differ from those read back and R3 refuses.
 */
export function bookingParams(s: Session): Record<string, string> {
  const who = whoParams(s);
  const date = valueOf(s, 'date');
  return { ...who, date, time: bookingOf(factsOf(s), who.provider, date)?.time ?? '' };
}

/** A cancellation writes the booking the summary read back (found for this caller and provider). */
export function cancelParams(s: Session): Record<string, string> {
  const existing = factsOf(s).existing;
  return { ...whoParams(s), date: existing?.date ?? '', time: existing?.time ?? '' };
}

/**
 * A yes to "no booking found" or "no openings that day" (scheduling.ts readSummary): the caller says
 * the details stand, and the line has nothing it can write or confirm. A person can look further (a
 * booking under another name, a waiting list), so the call goes to one with what it collected,
 * rather than ending on a line that names an empty booking or saying "anything else?" after a dead end.
 */
function nothingToActOn(c: CompletionContext): Completion | null {
  const { s, acks } = c;
  return hasWhatItActsOn(s.form ?? '', factsOf(s)) ? null : { kind: 'decision', decision: handoff(s, 'needs-human', acks) };
}

/**
 * The summary's yes: the confirmation armed, the write made through the gate, and the call ends on
 * the form's line. Nothing to act on (no booking found, no opening on the day): no write, a person.
 * A value changed since the summary was read: R3 refuses and the summary is read again (reconfirm).
 * Any other refusal: the engine's (a person).
 */
function writeThenEnd(tool: ClinicTool, params: (s: Session) => Record<string, string>, promptId: string): (c: CompletionContext) => Completion {
  return (c) => {
    const none = nothingToActOn(c);
    if (none) return none;
    const { s, acks } = c;
    s.confirmedHash = s.pendingHash;
    const { decision } = c.callTool({ tool, params: params(s) });
    s.confirmedHash = null;
    if (decision.verdict === 'BLOCK' && decision.reason === 'confirmation') return { kind: 'reconfirm', acks };
    if (decision.verdict !== 'ALLOW') return c.refusal(decision);
    s.pendingHash = null;
    return { kind: 'end', promptId, vars: clinicVars(s), acks };
  };
}

/** What every form with a summary shares: the summary names the booking found or the opening offered. */
const reads: Pick<FormDef, 'onSummaryRead'> = { onSummaryRead: readSummary };

/** What a scheduling form adds: a part of the day kept, the offer moved, the day kept on a time move. */
const schedules: Pick<FormDef, 'onSummaryRead' | 'onAnswers' | 'onSummaryAnswer' | 'keepsSlot'> = {
  ...reads,
  onAnswers: onSchedulingAnswers,
  onSummaryAnswer: moveOffer,
  keepsSlot: keepsDay,
};

/**
 * The clinic's five forms. None has an entry call (nothing to look up or verify before the slots).
 * The four on an appointment confirm a summary and end the call on their line; billing collects the
 * member ID and hands off to the billing team.
 */
export const FORMS: Record<ClinicForm, FormDef> = {
  schedule_new: {
    slots: ['name', 'dob', 'provider', 'date'],
    summaryPromptId: 'confirm_schedule',
    ...schedules,
    confirmedParams: bookingParams,
    complete: writeThenEnd('bookAppointment', bookingParams, 'schedule_confirmed'),
  },
  reschedule: {
    slots: ['name', 'dob', 'provider', 'date'],
    summaryPromptId: 'confirm_reschedule',
    ...schedules,
    confirmedParams: bookingParams,
    complete: writeThenEnd('moveAppointment', bookingParams, 'reschedule_confirmed'),
  },
  cancel: {
    slots: ['name', 'dob', 'provider'],
    summaryPromptId: 'confirm_cancel',
    ...reads,
    confirmedParams: cancelParams,
    complete: writeThenEnd('cancelAppointment', cancelParams, 'cancel_confirmed'),
  },
  confirm_appointment: {
    slots: ['name', 'dob', 'provider'],
    summaryPromptId: 'confirm_appointment_details',
    ...reads,
    // Nothing is written: the caller agreed that the booking read back is theirs (and with none found, a person).
    complete: (c) => nothingToActOn(c) ?? { kind: 'end', promptId: 'appointment_details', vars: clinicVars(c.s), acks: c.acks },
  },
  billing: {
    slots: ['memberId'],
    summaryPromptId: null,
    complete: ({ s, acks }) => ({ kind: 'decision', decision: handoff(s, 'billing', acks) }),
  },
};
