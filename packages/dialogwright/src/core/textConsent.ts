import type { App, SlotId } from './app/types';
import type { Session, TextConsentAnswer } from './session';

/**
 * Consent to text for the whole call (app.yaml's `textConsent`, App.textConsent): asked once, on a
 * call, right after the greeting (`greeting_offer`, then `consent_texts` with the last four digits of
 * the number calling, then `greet_after_offer` once it is settled), when the session kept the caller's
 * number, the first slot it covers can take it, and the app's callerOffer hook allows that slot
 * (core/turn.ts). The caller-ID question at the greeting comes first, a proposal at the greeting after:
 * only one question follows the greeting.
 *
 * - Granted (a yes, or the keypad's 1): each slot it covers, when its form would offer it the caller's
 *   number, is filled with that number, confirmed, with no question (the hook still asked for it), and
 *   an `offer` row with `answer: consent` records the use. The summary still reads it back, and the
 *   gate's callerNumber rule passes it as the caller's own.
 * - Declined (a no, a value with no yes, the keypad's 2), or unknown (a request said instead, or no
 *   answer): each slot asks its own offer, as without it.
 * - The grant itself is a `consent` row (`scope: call`, `granted` true, false or null), in the day's
 *   hash chain. A caller who later asks for no more texts is the app's to handle (an intent): the
 *   engine records the answer and reads it only for the slots it covers.
 */

/** The consent question's line. */
export const CONSENT_PROMPT = 'consent_texts';

/** What the caller answered to the consent to text for the whole call, or null when it was never asked. */
export function textConsentOf(s: Session): TextConsentAnswer | null {
  return s.textConsent?.answer ?? null;
}

/** The slots the app's consent covers, in app.yaml's order; none for an app without it. */
export function consentCovers(app: App): readonly SlotId[] {
  return app.textConsent?.covers ?? [];
}

/** Whether the caller granted the consent, and it covers `slot`: the slot is filled with the caller's number without asking. */
export function grantedFor(app: App, s: Session, slot: SlotId): boolean {
  return s.textConsent?.answer === 'granted' && consentCovers(app).includes(slot);
}
