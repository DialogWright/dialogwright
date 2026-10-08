import type { App, SlotId } from './app/types';
import type { SessionFacts } from './session';
import type { SlotCandidate } from './slots/types';
import { identityOf } from './app/lookup';

/**
 * A value proposed from the app's facts (a slot's `offer: facts`, SlotSpec.offer): when the form would
 * ask the slot and the facts have a candidate for it (FactsConfig.offers: e.g. the street the
 * call-start lookup found for the number calling, or one a form's entry call loaded once the caller
 * was verified: whatever the facts hold when the slot is asked), the slot asks `offer_<slot>` ("Is this about
 * 22 Alder Street?") in place of `ask_<slot>`, with the same offer machinery as the caller's number's
 * (core/turn.ts). A proposal, never verification: a yes fills that slot and nothing else, so the
 * principal, the identity level and the identity attempts stay as they were, and an action that
 * needs identity still asks for it. Never on an identity factor (`pnpm check` refuses it there, and
 * the engine never offers one), never on a slot that offers the caller's number, and never on a
 * statement (redact: length), which never says its words back.
 */

/**
 * The slots that propose a value from the facts: those whose spec has `offer: facts`, but never an
 * identity factor, a slot that offers the caller's number, or a statement (redact: length), whose
 * words are never said back and whose display the trace keeps as a stand-in.
 */
export function factsOfferSlots(app: App): SlotId[] {
  const factors = identityOf(app).factorSlots;
  return Object.values(app.slots).filter((spec) => spec.offer === 'facts' && spec.callerNumber === undefined && spec.redact !== 'length' && !factors.includes(spec.id)).map((spec) => spec.id);
}

/**
 * The facts' candidate for the slot (FactsConfig.offers), or null when the slot proposes none, the
 * app has no `offers`, or the candidate is not one to say: no candidate, or one whose value or
 * display is not a string with something in it. A hook that throws proposes nothing, and the slot is
 * asked as always: a proposal is a convenience, never a reason to lose the turn. Nothing of the error
 * is kept or logged, since its message may hold what the facts hold.
 */
export function factsCandidate(app: App, slot: SlotId, facts: Readonly<SessionFacts>): SlotCandidate | null {
  const offers = app.facts?.offers;
  if (offers === undefined || !factsOfferSlots(app).includes(slot)) return null;
  let proposed: ReturnType<typeof offers> | null | undefined;
  try {
    proposed = offers(facts);
  } catch {
    return null;
  }
  const c = proposed !== null && typeof proposed === 'object' && Object.hasOwn(proposed, slot) ? proposed[slot] : undefined;
  if (c === undefined || c === null || typeof c !== 'object') return null;
  if (typeof c.value !== 'string' || typeof c.display !== 'string' || c.value.trim() === '' || c.display.trim() === '') return null;
  return { value: c.value, display: c.display };
}

/**
 * The slots that propose at the greeting (`offerAt: greeting`, SlotSpec.offerAt), in slots.yaml order:
 * those of factsOfferSlots that say so and that some form asks (a value no form uses is not worth the
 * question). The engine makes at most one such proposal per call, at call start (core/turn.ts).
 */
export function greetingOfferSlots(app: App): SlotId[] {
  const asked = new Set(Object.values(app.forms).flatMap((form) => form.slots));
  return factsOfferSlots(app).filter((id) => app.slots[id]!.offerAt === 'greeting' && asked.has(id));
}
