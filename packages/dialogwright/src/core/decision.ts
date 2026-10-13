import type { SlotPartial, SlotSpec } from './slots/types';
import { handoffUnconfirmedOf, identityOf, slotSpecOf } from './app/lookup';
import { appOf } from './app/registry';
import type { FormId, SlotId } from './app/types';
import { handoffPromptId } from '../prompts/render';
import { maskId } from '../gate/principal';
import { isAnonymous } from '../gate/types';
import type { Ack } from './fia';
import type { Session } from './session';
import { slotLocaleOf } from './locale';
import { chooseTransfer, type TransferChoice } from './transfer';
import { sessionConditionFacts, type ConditionClock } from './routes';
import { callDataOf } from './callData';
import { handoffDataSlots } from '../handoff/data';

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
  /**
   * The line must be heard word for word: a summary read back exactly after a no (forms.yaml's
   * `summary.onNo: read-back`). A generated line is said fixed (render/turn.ts, skip `exact`). Absent on every other prompt.
   */
  exact?: true;
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
  /**
   * `false`: the line is the call's last, and the app's goodbye is not said after it (an ending
   * outcome's or a completion's `goodbye: false`, for a line that says goodbye itself). Absent, the
   * goodbye follows the line, unless the line is the goodbye.
   */
  goodbye?: false;
}

export interface HandoffDecision {
  kind: 'handoff';
  reason: string;
  /**
   * The replies that did not pass their tool's check this turn (core/lifecycle.ts UncheckedReply), for a
   * handoff with the reason `result-unchecked`: the tool, whether it wrote (the write ran and is not
   * undone), and the record it made where it named a plain reference. Absent on every other handoff.
   */
  unchecked?: readonly { readonly tool: string; readonly wrote: boolean; readonly ref?: string }[];
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
  /**
   * The slots of `slots` the caller never confirmed (unconfirmedSlots), in the app's slot order: only
   * for an app whose handoff data marks or leaves them out (HandoffData.unconfirmed `mark` or `omit`).
   * Absent otherwise, so every other app's handoff is as it was.
   */
  unconfirmed?: SlotId[];
  /**
   * Where the transfer goes and what goes with it (app.yaml's `transfer`, core/transfer.ts): the
   * target's variable (never the number), the rule taken, and the headers and chat data resolved. Only
   * for an app with `transfer`; absent otherwise, so every other app's handoff is as it was.
   */
  transfer?: TransferChoice;
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

/** A slot recorded by its length that is a secret, not the caller's words (SlotSpec.statement false: a PIN). */
export function isSecretByLength(spec: Pick<SlotSpec, 'redact' | 'statement'> | undefined): boolean {
  return spec?.redact === 'length' && spec.statement === false;
}

export function handoff(s: Session, reason: string, acks: Ack[] = []): HandoffDecision {
  // Whatever the caller added and the call never got to is the agent's problem now,
  // so it rides along in the handoff data -- together with what the call did collect,
  // which is the only record of it for a form that hands off without a summary.
  const app = appOf(s);
  const slots: Record<string, string> = {};
  for (const [id, spec] of Object.entries(app.slots)) {
    const slot = s.slots[id]!;
    if (slot.value === null) continue;
    // A factor the caller-ID match filled, for a caller it did not verify: it came from the number,
    // not from the caller, so the person taking the call is not handed it as if the caller had said it.
    if (slot.by === 'caller-id' && isAnonymous(s.principal)) continue;
    // A secret by its length (a PIN, SlotSpec.statement false) goes by its real length unless it is
    // handed over only as verified: never its digits, nor a last four that may be most of it.
    if (spec.handoff !== 'verified' && isSecretByLength(spec)) slots[id] = `<${slot.value.length} chars>`;
    else if (spec.handoff === 'last4') slots[id] = maskId(slot.value.replace(/\D/g, ''));
    else if (spec.handoff === 'verified') slots[id] = s.principal.kind === identityOf(app).subjectKind ? IDENTITY_VERIFIED : IDENTITY_UNVERIFIED;
    else if (spec.displayFrom === 'said') slots[id] = slot.value;
    else slots[id] = slot.display ?? slot.value;
  }
  const decision: HandoffDecision = { kind: 'handoff', reason, promptId: handoffPromptId(reason), acks, completed: [...s.completed], queued: [...s.queued], slots };
  if (handoffUnconfirmedOf(app) !== 'send') decision.unconfirmed = unconfirmedSlots(s);
  // The transfer target, chosen on the reason, the form the caller is in (or, with none open, the last
  // one completed) and the call data; a slot it sends goes as the handoff data sends it.
  if (app.transfer !== undefined) {
    decision.transfer = chooseTransfer(app, {
      reason,
      form: s.form ?? s.completed.at(-1) ?? null,
      callData: callDataOf(s),
      slots: handoffDataSlots(app, slots, decision.unconfirmed),
    }, sessionConditionFacts(app, s, null));
  }
  return decision;
}

/**
 * A handoff's transfer chosen again with what only the turn knows (its clock, the environment, the
 * app's predicates): a target on the hours, the number called or a predicate (core/conditions.ts) is
 * judged at the turn's moment. The turn (core/turn.ts) asks this of the handoff it ends with; the
 * choice is as handoff() made it for every other condition. Nothing for an app without `transfer`.
 */
export function withTurnTransfer(s: Session, decision: HandoffDecision, clock: ConditionClock): void {
  const app = appOf(s);
  if (app.transfer === undefined) return;
  decision.transfer = chooseTransfer(app, {
    reason: decision.reason,
    form: s.form ?? s.completed.at(-1) ?? null,
    callData: callDataOf(s),
    slots: handoffDataSlots(app, decision.slots, decision.unconfirmed),
  }, sessionConditionFacts(app, s, clock, decision.reason));
}

/**
 * The filled slots the caller never confirmed (HandoffData.unconfirmed): neither `confirmed` (a yes
 * to the slot's own read-back, a keyed value, a fill the slot takes with no read-back) nor holding
 * the value the caller said yes to at a summary (Session.agreed). An identity factor, and a slot
 * handed over only as `verified`, is never listed: what was proven of the caller is the Identity
 * line's, not a heard value's.
 */
export function unconfirmedSlots(s: Session): SlotId[] {
  const app = appOf(s);
  const factors = identityOf(app).factorSlots;
  const out: SlotId[] = [];
  for (const [id, spec] of Object.entries(app.slots)) {
    const slot = s.slots[id]!;
    if (slot.value === null || slot.confirmed || factors.includes(id) || spec.handoff === 'verified') continue;
    if (s.agreed !== undefined && Object.hasOwn(s.agreed, id) && s.agreed[id] === slot.value) continue;
    out.push(id);
  }
  return out;
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
