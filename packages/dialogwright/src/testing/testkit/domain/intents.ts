import type { IntentDef } from '../../../core/app/types';

/** The three forms, in keypad order. */
export const FORM_INTENTS = ['track_parcel', 'delivery_window', 'report_missing'] as const;
export type TestkitForm = (typeof FORM_INTENTS)[number];

/** Every intent: the forms, an informational one, and the control intents the engine reads. */
export const INTENTS: Record<string, IntentDef> = {
  track_parcel: {
    criteria: 'Asks where a parcel is, whether it has been delivered, or about a parcel by its number or by what is in it',
    label: 'track a parcel',
    kind: 'form',
  },
  delivery_window: {
    criteria: 'Wants to choose or check a day and a time of day for a delivery',
    label: 'book a delivery window',
    kind: 'form',
  },
  report_missing: {
    criteria: 'Says a parcel is missing, lost or never arrived, and wants to report it',
    label: 'report a missing parcel',
    kind: 'form',
  },
  agent: { criteria: 'Asks to speak with a person, representative, or operator', label: 'speak with someone', kind: 'control' },
  repeat_prompt: { criteria: 'Asks the system to repeat what it just said', label: 'hear that again', kind: 'control' },
  capabilities: {
    criteria: 'Asks what the system can do, what it is, or what the options are',
    label: 'hear what I can do',
    kind: 'informational',
    promptId: 'capabilities',
  },
  done: {
    criteria: 'Says they are finished or need nothing more, as in no thanks, that is all, or goodbye, including a bare no when node.promptJustPlayed asked whether there is anything else',
    label: 'finish up',
    kind: 'control',
  },
  other: { criteria: 'A request the parcel line does not handle', label: 'something else', kind: 'control' },
  none: { criteria: 'No request is expressed; the caller is only answering a question or saying something incidental', label: 'nothing', kind: 'control' },
};

export const MENU: ReadonlyArray<{ digit: string; intent: string }> = [
  { digit: '1', intent: 'track_parcel' },
  { digit: '2', intent: 'delivery_window' },
  { digit: '3', intent: 'report_missing' },
  { digit: '0', intent: 'agent' },
];
