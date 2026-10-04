import type { SlotPartial } from './slots/types';
import { identityOf, slotSpecOf } from './app/lookup';
import { appOf } from './app/registry';
import type { FormId, SlotId } from './app/types';
import { handoffPromptId } from '../prompts/render';
import { maskId } from '../gate/principal';
import type { Ack } from './fia';
import type { Session } from './session';
import { slotLocaleOf } from './locale';

export interface PromptDecision {
  kind: 'prompt';
  promptId: string;
  vars: Record<string, string>;
  /** implicit-confirm phrases spoken before the prompt */
  acks: Ack[];
  /** what the prompt asks for; drives DTMF and attempt accounting. 'otp' is the keypad code, never a slot. */
  target: 'intent' | 'confirm' | 'otp' | SlotId | null;
  /** spoken options, for disambiguation and menus */
  options: string[];
  /** this prompt played the DTMF intent menu, so the next digit picks an option */
  menu?: boolean;
  /** the help prompt this decision plays in place of the target slot's question; recorded on the slot once it is actually spoken */
  help?: { slot: SlotId; promptId: string };
}

export interface CompleteDecision {
  kind: 'complete';
  /** the form whose completion ended the call, or null when the caller said they were done */
  form: FormId | null;
  promptId: string;
  vars: Record<string, string>;
  /** implicit-confirm and bridge phrases spoken before the completion */
  acks: Ack[];
  /** forms closed by a completion prompt on this call */
  completed: FormId[];
}

export interface HandoffDecision {
  kind: 'handoff';
  reason: string;
  promptId: string;
  acks: Ack[];
  completed: FormId[];
  /** intents the caller added that the call never started */
  queued: FormId[];
  /**
   * what the call collected, as the caller heard it: filled slots only, display values. Identity is
   * never handed over as collected (SlotSpec.handoff): an identifier by its last four, a factor only
   * as IDENTITY_VERIFIED or IDENTITY_UNVERIFIED. The human agent needs to know who, and
   * how strongly; the whole identifier and the factor would put PHI on Twilio's side of the call.
   * What of this a transfer sends the channel is the app's handoff data option (handoff/data.ts):
   * by default no identity factor at all, and a redacted slot masked.
   */
  slots: Record<string, string>;
}

export type Decision =
  | { kind: 'ignore' }
  | { kind: 'hold' }
  | PromptDecision
  | CompleteDecision
  | HandoffDecision
  | { kind: 'replay'; text: string };

export function prompt(promptId: string, target: PromptDecision['target'], vars: Record<string, string> = {}, acks: Ack[] = [], options: string[] = []): PromptDecision {
  return { kind: 'prompt', promptId, vars, acks, target, options };
}

/** A `handoff: 'verified'` slot's handoff value once the factors matched a subject (level 1 or above). */
export const IDENTITY_VERIFIED = 'verified';
/** A `handoff: 'verified'` slot's handoff value when it was collected but the caller is not verified. */
export const IDENTITY_UNVERIFIED = 'not verified';

export function handoff(s: Session, reason: string, acks: Ack[] = []): HandoffDecision {
  // Whatever the caller added and the call never got to is the agent's problem now,
  // so it rides along in the handoff data -- together with what the call did collect,
  // which is the only record of it for a form that hands off without a summary.
  const app = appOf(s);
  const slots: Record<string, string> = {};
  for (const [id, spec] of Object.entries(app.slots)) {
    const slot = s.slots[id]!;
    if (slot.value === null) continue;
    if (spec.handoff === 'last4') slots[id] = maskId(slot.value.replace(/\D/g, ''));
    else if (spec.handoff === 'verified') slots[id] = s.principal.kind === identityOf(app).subjectKind ? IDENTITY_VERIFIED : IDENTITY_UNVERIFIED;
    else slots[id] = slot.display ?? slot.value;
  }
  return { kind: 'handoff', reason, promptId: handoffPromptId(reason), acks, completed: [...s.completed], queued: [...s.queued], slots };
}

/** "Would you like me to connect you with a support specialist?" */
export function offerTransfer(acks: Ack[] = []): PromptDecision {
  return prompt('offer_transfer', 'confirm', {}, acks, ['yes', 'no']);
}

/**
 * Asks for `slot`: for the rest of it when it holds only part of a value (`window`, the slot's own
 * partialPromptId, with its partialVars), otherwise its own ask_<slot>.
 */
export function askSlot(s: Session, slot: SlotId, window: SlotPartial | null, acks: Ack[]): PromptDecision {
  const spec = slotSpecOf(appOf(s), slot);
  const partial = window ? spec.partialPromptId : undefined;
  return prompt(partial ?? `ask_${slot}`, slot, window ? (spec.partialVars?.(window, slotLocaleOf(s)) ?? {}) : {}, acks);
}
