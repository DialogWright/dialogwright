import type { App, SlotId } from './app/types';
import type { SlotCandidate } from './slots/types';
import { identityOf } from './app/lookup';

/**
 * The number the caller is calling from, as an offer for a slot that holds a phone number (a `digits`
 * slot's `callerNumber`, SlotSpec.callerNumber). The carrier's setup gives it (VoiceProvider.setupCallerOf,
 * server/voice), the start event carries it (SessionStart.callerNumber) only for an app with such a
 * slot, and the session keeps it (Session.callerNumber) only when a slot can use it. It is never
 * identity: a caller ID can be forged, so `pnpm check` refuses the option on an identity factor and
 * the engine never offers one; the number is used only after the caller's yes.
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

/** Whether the app has a slot that offers the caller's number: only then does a start event carry it. */
export function usesCallerNumber(app: App): boolean {
  return callerNumberSlots(app).length > 0;
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
 * when it came in international form), when a slot of the app can use it, otherwise nothing
 * (undefined). An app with no such slot keeps nothing.
 */
export function keptCallerNumber(app: App, raw: string | undefined): string | undefined {
  const number = callerNumberOf(raw);
  if (number === null) return undefined;
  return callerNumberSlots(app).some((slot) => callerCandidate(app, slot, number) !== null) ? number : undefined;
}

/** The last four digits of a value, as the offer line says them ({last4}) and the console masks a number. */
export function lastFour(value: string): string {
  return value.replace(/\D/g, '').slice(-4);
}
