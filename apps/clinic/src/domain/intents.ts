import type { IntentDef } from 'dialogwright';

/** Every intent the clinic line hears, in the order the decision model is offered them. */
export const INTENTS = [
  'schedule_new',
  'reschedule',
  'cancel',
  'confirm_appointment',
  'billing',
  'agent',
  'repeat_prompt',
  'capabilities',
  'other',
  'none',
] as const;
export type Intent = (typeof INTENTS)[number];

/** The intents that start a form, one form each. */
export const FORM_INTENTS = ['schedule_new', 'reschedule', 'cancel', 'confirm_appointment', 'billing'] as const;
export type ClinicForm = (typeof FORM_INTENTS)[number];

/** Forms that book an opening the line offers: the summary names the opening, and the caller may move it. */
export const SCHEDULING_FORMS: readonly string[] = ['schedule_new', 'reschedule'] satisfies readonly ClinicForm[];
/** Forms that act on a booking the directory finds for the caller. */
export const EXISTING_FORMS: readonly string[] = ['confirm_appointment', 'cancel', 'reschedule'] satisfies readonly ClinicForm[];

/** Criteria sent to the decision model. */
const CRITERIA: Record<Intent, string> = {
  schedule_new: 'Wants to book a new appointment that does not exist yet',
  reschedule: 'Wants to move an existing appointment to a different day',
  cancel: 'Wants to cancel an existing appointment',
  confirm_appointment: 'Wants to check or confirm the details of an existing appointment',
  billing: 'Asks about a bill, charge, payment, or insurance coverage',
  agent: 'Asks to speak with a person, representative, or operator',
  repeat_prompt: 'Asks the system to repeat what it just said',
  capabilities: 'Asks what the system can do, what it is, what the options are, or how to use it, as in what can you do, what are my options, or what is this',
  other: 'A request the clinic line does not handle',
  none: 'No request is expressed; the caller is only answering a question or saying something incidental',
};

/** Spoken labels, as acknowledgements and confirmations say them ("I'd be happy to help you {label}"). */
const LABELS: Record<Intent, string> = {
  schedule_new: 'schedule a new appointment',
  reschedule: 'reschedule your appointment',
  cancel: 'cancel your appointment',
  confirm_appointment: 'confirm your appointment',
  billing: 'talk to billing',
  agent: 'speak with someone',
  repeat_prompt: 'hear that again',
  capabilities: 'hear what I can do',
  other: 'something else',
  none: 'nothing',
};

function kindOf(intent: Intent): IntentDef['kind'] {
  if ((FORM_INTENTS as readonly string[]).includes(intent)) return 'form';
  return intent === 'capabilities' ? 'informational' : 'control';
}

/**
 * The intents as the App contract holds them. `capabilities` is informational: its line is said and
 * the caller goes back to the question they were on. There is no `done`: a call ends when its task
 * is done (a completion), handed off, or hung up.
 */
export const CLINIC_INTENTS: Record<Intent, IntentDef> = Object.fromEntries(
  INTENTS.map((i): [Intent, IntentDef] => [
    i,
    { criteria: CRITERIA[i], label: LABELS[i], kind: kindOf(i), ...(i === 'capabilities' ? { promptId: 'capabilities' } : {}) },
  ]),
) as Record<Intent, IntentDef>;

/** The keypad menu: each task by digit, and 0 for a person. */
export const MENU: ReadonlyArray<{ digit: string; intent: Intent }> = [
  { digit: '1', intent: 'schedule_new' },
  { digit: '2', intent: 'reschedule' },
  { digit: '3', intent: 'cancel' },
  { digit: '4', intent: 'confirm_appointment' },
  { digit: '5', intent: 'billing' },
  { digit: '0', intent: 'agent' },
];

export function intentLabel(intent: Intent): string {
  return LABELS[intent];
}
