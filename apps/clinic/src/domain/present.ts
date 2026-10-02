import type { AppBrand, ConsoleConfig, VoiceConfig } from 'dialogwright';
import { PROVIDERS } from './roster';
import { ALL_SLOTS } from './slots';

/** The practice as the operator console names it. */
export const CLINIC_BRAND: AppBrand = { name: 'Example Family Practice', mark: 'EF', key: 'example-family-practice' };

/**
 * What the operator console shows of the clinic (App.console): each form and slot in words, the
 * questions that belong to a slot, and the facts a task's tool calls leave. The clinic verifies no
 * one, so every call stays at the first level.
 */
export const CLINIC_CONSOLE: ConsoleConfig = {
  formLabels: {
    schedule_new: 'Schedule an appointment',
    reschedule: 'Reschedule an appointment',
    cancel: 'Cancel an appointment',
    confirm_appointment: 'Confirm an appointment',
    billing: 'Billing',
  },
  slotOrder: ALL_SLOTS,
  slotLabels: { name: 'Name', dob: 'Date of birth', memberId: 'Member ID', provider: 'Provider', date: 'Day' },
  // A slot owns the question ids that start with its own; the member ID's detection question does not.
  questionPrefixes: { memberId: ['memberId', 'containsMemberId'] },
  detectQuestions: ['containsMemberId', 'memberIdComplete'],
  levels: ['no verification', 'no verification', 'no verification'],
  handoffReasons: { billing: 'the caller asked for billing' },
  facts: [
    { kind: 'lookup', tool: 'findAppointment', param: 'provider', noun: 'appointment with' },
    { kind: 'lookup', tool: 'listOpenings', param: 'provider', noun: 'openings with' },
    { kind: 'lookup', tool: 'bookAppointment', param: 'provider', noun: 'booking with' },
    { kind: 'lookup', tool: 'moveAppointment', param: 'provider', noun: 'move with' },
    { kind: 'lookup', tool: 'cancelAppointment', param: 'provider', noun: 'cancellation with' },
  ],
  heardBy: 'the caller',
};

/**
 * The phone line's speech settings: the providers' surnames and the words a caller says first are
 * what the recognizer should expect. A member ID is read in two groups of four ("5550 7788"), each
 * digit spelled out for the text-to-speech.
 */
export const CLINIC_VOICE: VoiceConfig = {
  hints: [
    ...PROVIDERS.map((p) => p.name),
    'appointment', 'reschedule', 'cancel', 'confirm', 'billing', 'member ID', 'morning', 'afternoon', 'agent', 'representative',
  ],
  spokenDigits: [{ pattern: /\d{4,}(?: \d{4,})+|\d{5,}/g, spell: 'groups' }],
};
