import type { App, SlotId } from './app/types';
import type { SlotCandidate } from './slots/types';
import type { PendingConfirmation, Session } from './session';
import { identityOf } from './app/lookup';
import { appOf } from './app/registry';

/**
 * The number the caller is calling from, as an offer for a slot that holds a phone number (a `digits`
 * slot's `callerNumber`, SlotSpec.callerNumber), and as a hint for the app's own code (app.yaml's
 * `callerNumber: { use: hint }`, App.callerNumber). The carrier's setup gives it
 * (VoiceProvider.setupCallerOf, server/voice), the start event carries it (SessionStart.callerNumber)
 * only for an app with such a slot or such a block, and the session keeps it (Session.callerNumber)
 * only when the app can use it. It is never identity on its own: a caller ID can be forged, so
 * `pnpm check` refuses the option on an identity factor and the engine never offers one; the number
 * fills a slot only after the caller's yes, and app code reads it (callerOf) to look something up or
 * to propose. An app may let a caller-ID match identify an account, with a knowledge factor that
 * verifies it (identity.yaml `callerId`): the match fills the identifier silently, never offered for
 * a yes, and the factor the caller gives verifies it.
 */

/**
 * What a carrier sends in place of a number when the caller ID is withheld: Twilio's, the keypad
 * spellings of ANONYMOUS, RESTRICTED, UNAVAILABLE and BLOCKED. RESTRICTED has ten digits and fits a
 * ten-digit phone mask, so a slot's mask alone cannot refuse it. Telnyx's withheld form is not yet
 * seen on a live call (docs/live-checks.md).
 */
export const WITHHELD_PLACEHOLDERS: readonly string[] = ['266696687', '7378742833', '86282452253', '2562533'];

/** The words a carrier may send for a withheld number, which are no number. */
const WITHHELD_WORDS = new Set(['anonymous', 'restricted', 'unavailable', 'unknown', 'private', 'blocked', 'withheld']);

/** A number as a carrier writes it: digits, with a leading `+` and spacing, dashes, dots or brackets. Anything else (a SIP address, a client name) is no number. */
const NUMBER_SHAPE = /^\+?[\d\s().-]+$/;

/**
 * The digits of the number a carrier sent, or null when it sent none the engine can use: absent,
 * empty, a word (anonymous, unknown), a SIP address or anything else that is not a number, or one
 * of the withheld placeholders (WITHHELD_PLACEHOLDERS).
 */
export function callerDigits(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (text === '' || WITHHELD_WORDS.has(text.toLowerCase()) || !NUMBER_SHAPE.test(text)) return null;
  const digits = text.replace(/\D/g, '');
  if (digits === '' || isPlaceholder(digits)) return null;
  return digits;
}

/**
 * The number a carrier sent as the session keeps it (Session.callerNumber): its digits, with a
 * leading `+` when the carrier wrote it in international form (E.164, as Twilio and Telnyx do), so a
 * slot can tell a number that names its country from one that does not; null as for callerDigits.
 */
export function callerNumberOf(raw: string | null | undefined): string | null {
  const digits = callerDigits(raw);
  if (digits === null) return null;
  return raw!.trim().startsWith('+') ? `+${digits}` : digits;
}

/** Whether the digits are a withheld placeholder, as sent or with a one-digit country code before it. */
function isPlaceholder(digits: string): boolean {
  return WITHHELD_PLACEHOLDERS.includes(digits) || WITHHELD_PLACEHOLDERS.includes(digits.slice(1));
}

/** The slots that offer the caller's number: those whose spec has `callerNumber`, but never an identity factor. */
export function callerNumberSlots(app: App): SlotId[] {
  const factors = identityOf(app).factorSlots;
  return Object.values(app.slots).filter((spec) => spec.callerNumber !== undefined && !factors.includes(spec.id)).map((spec) => spec.id);
}

/** Whether the app keeps the caller's number for its own code (app.yaml's `callerNumber: { use: hint }`). */
export function hintsCallerNumber(app: App): boolean {
  return app.callerNumber?.use === 'hint';
}

/**
 * Whether the app has a slot that offers the caller's number, or keeps it for its code
 * (hintsCallerNumber): only then does a start event carry it.
 */
export function usesCallerNumber(app: App): boolean {
  return callerNumberSlots(app).length > 0 || hintsCallerNumber(app);
}

/** Whether the app keeps the number called (app.yaml's `callerNumber: { use: hint, called: true }`): only then does a start event carry it. */
export function usesCalledNumber(app: App): boolean {
  return hintsCallerNumber(app) && app.callerNumber?.called === true;
}

/**
 * The slot's value and display for the caller's number (Session.callerNumber: its digits, `+` first
 * when it came in international form), or null when the slot does not offer it or the number does
 * not fit it (its `countryCode`, `length` and `mask`). A value that is a withheld placeholder is never one.
 */
export function callerCandidate(app: App, slot: SlotId, number: string | undefined, locale?: string): SlotCandidate | null {
  if (number === undefined || !callerNumberSlots(app).includes(slot)) return null;
  const c = app.slots[slot]!.callerNumber!.take(number, locale);
  return c === null || isPlaceholder(c.value) ? null : c;
}

/**
 * What the session keeps of the number a start event carried (callerNumberOf: its digits, `+` first
 * when it came in international form): for an app that keeps it for its code (hintsCallerNumber),
 * any usable number; otherwise only one a slot of the app can use. Nothing (undefined) when there is
 * none, and for an app with neither such a slot nor the block.
 */
export function keptCallerNumber(app: App, raw: string | undefined): string | undefined {
  const number = callerNumberOf(raw);
  if (number === null) return undefined;
  if (hintsCallerNumber(app)) return number;
  return callerNumberSlots(app).some((slot) => callerCandidate(app, slot, number) !== null) ? number : undefined;
}

/**
 * What the session keeps of the number called (Session.calledNumber): its digits, `+` first when it
 * came in international form, only for an app that keeps it (usesCalledNumber); otherwise nothing.
 */
export function keptCalledNumber(app: App, raw: string | undefined): string | undefined {
  if (!usesCalledNumber(app)) return undefined;
  return callerNumberOf(raw) ?? undefined;
}

/** The caller's number as app code reads it (callerOf): as the session keeps it, and its last four digits. */
export interface CallerNumber {
  /** Its digits, `+` first when the carrier wrote it in international form ("+15555550142"). */
  readonly number: string;
  /** Its last four digits, as a line may say them ("0142"). */
  readonly last4: string;
}

/**
 * The number the caller is calling from, for the app's code: a hint to look something up by or to
 * propose a value from, never proof of who is calling. Null on a chat, on a call with no usable
 * number, and for an app that does not keep it for its code (app.yaml's `callerNumber: { use: hint }`),
 * so code written against it is safe anywhere.
 */
export function callerOf(s: Session): CallerNumber | null {
  if (s.callerNumber === undefined || !hintsCallerNumber(appOf(s))) return null;
  return { number: s.callerNumber, last4: lastFour(s.callerNumber) };
}

/**
 * The number the caller called (the DNIS), for the app's code: its digits, `+` first when the carrier
 * wrote it in international form. Null on a chat, when the carrier sent none, and for an app that
 * does not keep it (app.yaml's `callerNumber: { use: hint, called: true }`).
 */
export function calledOf(s: Session): string | null {
  if (s.calledNumber === undefined || !usesCalledNumber(appOf(s))) return null;
  return s.calledNumber;
}

/**
 * What the gate knows of the caller's number (GateFacts.callerNumber and callerNumberAs), for a
 * session that kept one: the number as kept, and as each slot that offers it would hold it (its
 * `callerNumber.take`), so the callerNumber rule compares a slot's param as the slot holds it.
 */
export function callerGateFacts(app: App, number: string): { callerNumber: string; callerNumberAs?: Readonly<Record<SlotId, string>> } {
  const as = Object.fromEntries(callerNumberSlots(app).flatMap((slot) => {
    const c = callerCandidate(app, slot, number);
    return c === null ? [] : [[slot, c.value] as const];
  }));
  return Object.keys(as).length > 0 ? { callerNumber: number, callerNumberAs: as } : { callerNumber: number };
}

/** The slot's callerNumber option, when it skips on a no (`onNo: skip`). */
export function skipsOnNo(app: App, slot: SlotId): boolean {
  return app.slots[slot]?.callerNumber?.onNo === 'skip';
}

/** The slot's callerNumber option, when it skips with no number to offer (`ifNone: skip`). */
export function skipsIfNone(app: App, slot: SlotId): boolean {
  return app.slots[slot]?.callerNumber?.ifNone === 'skip';
}

/** A slot's value offered for a yes (the caller's number, or a value proposed from the facts), pending. */
export type OfferPending = Extract<PendingConfirmation, { target: 'slot' }> & { offered: true };

/**
 * Whether `pc` is an offer that takes a yes or a no only (OfferAnswers `yes-no`): the caller's number's
 * offer whose slot says `callerNumber.answers: yes-no`, or a proposal from the facts whose slot says
 * `offerAnswers: yes-no`. The slot offered then takes no value from the turn at its offer (fia.ts
 * slotsToFill), a value said there with no clear yes is a no, and the keypad's 1 and 2 are a yes and
 * a no (core/turn.ts). False for every other confirmation, and for an offer that takes a value too
 * (the default), which is as it was.
 */
export function yesNoOffer(app: App, pc: PendingConfirmation | null): pc is OfferPending {
  if (pc?.target !== 'slot' || pc.offered !== true) return false;
  const spec = app.slots[pc.slot];
  return pc.from === 'facts' ? spec?.offerAnswers === 'yes-no' : spec?.callerNumber?.answers === 'yes-no';
}

/**
 * A number to stand in for the caller's in a replayed call (harness-text/replay.ts). The frame log
 * keeps only the last four digits of a number the live session kept (the adapter's
 * `{ callerNumber: '…0142' }` line), which is all the offer said and all the model was told, so a
 * made-up number (the 555 range) ending in them makes the same offer: the shortest such number a
 * slot of the app takes. An app that keeps the number for its code (app.yaml's callerNumber) is given
 * one in the international form carriers send (Twilio and Telnyx both write E.164), +1 555 555 and
 * the last four, so its code and its call-start lookup see the number in the form the live call's
 * had, and a lookup fixture keyed by the last four answers as the live lookup was answered; for an
 * app with a slot that offers it, only when that slot takes it too, else the slot's number as above.
 * Undefined when the app keeps no number, or `last4` is not four digits.
 */
export function standInCallerNumber(app: App, last4: string): string | undefined {
  if (!/^\d{4}$/.test(last4)) return undefined;
  const slots = callerNumberSlots(app);
  if (hintsCallerNumber(app)) {
    const international = `+1555555${last4}`;
    if (slots.length === 0 || slots.some((slot) => callerCandidate(app, slot, international) !== null)) return international;
  }
  if (slots.length === 0) return undefined;
  for (let pad = 0; pad <= 11; pad++) {
    const number = '5'.repeat(pad) + last4;
    if (slots.some((slot) => callerCandidate(app, slot, number) !== null)) return number;
  }
  return undefined;
}

/** The last four digits of a value, as the offer line says them ({last4}) and the console masks a number. */
export function lastFour(value: string): string {
  return value.replace(/\D/g, '').slice(-4);
}
