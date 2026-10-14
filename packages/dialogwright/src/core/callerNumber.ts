import type { App, SlotId } from './app/types';
import type { SlotCandidate } from './slots/types';
import type { PendingConfirmation, Session } from './session';
import { identityOf } from './app/lookup';

/**
 * The numbers a call came with: the caller's (the ANI) and the one called (the DNIS). They are the
 * call's data, kept for every app (Session.callerNumber, Session.calledNumber) and read by app code
 * through callerOf and calledOf, with a SIP or client address that is no number through callerUriOf.
 * The carrier's setup gives them (VoiceProvider.setupCallerOf, setupCalledOf, server/voice). What acts
 * on the caller's number is the app's choice: a slot that offers it back (a `digits` slot's
 * `callerNumber`, SlotSpec.callerNumber), the call-start lookup (app.yaml's `callerNumber.lookup`), the
 * gate's callerNumber rule, the caller-ID match (identity.yaml `callerId`). It is never identity on its
 * own: a caller ID can be forged, so `pnpm check` refuses the offer on an identity factor and the
 * engine never offers one; the number fills a slot only after the caller's yes. A number the caller
 * withheld is kept and used as any other unless app.yaml's `callerNumber.withheld` says `ignore`
 * (usableCallerNumber): honouring the caller's privacy is the app's decision.
 */

/**
 * What a carrier sends in place of a number when the caller ID is withheld: Twilio's, the keypad
 * spellings of ANONYMOUS, RESTRICTED, UNAVAILABLE and BLOCKED. RESTRICTED has ten digits and fits a
 * ten-digit phone mask, so a slot's mask alone cannot refuse it. Telnyx sends no placeholder: seen on a
 * live call (2026-10-13, a call made with *67), its answer webhook carried the caller's real number in
 * `From`, with the marks of a withheld one beside it (`CallerId` anonymous, `FromSipUri`
 * anonymous@anonymous.invalid). Its provider reads the marks (server/voice/telnyx.ts) into a flag
 * carried with the number (CallbackParams.privacy, SessionStart.callerPrivacy). A placeholder or a
 * withheld word is no number, and sets the same flag (callerPrivacyOf).
 */
export const WITHHELD_PLACEHOLDERS: readonly string[] = ['266696687', '7378742833', '86282452253', '2562533'];

/** The words a carrier may send for a withheld number, which are no number. */
const WITHHELD_WORDS = new Set(['anonymous', 'restricted', 'unavailable', 'unknown', 'private', 'blocked', 'withheld']);

/** Whether `text` is one of the words a carrier sends for a withheld number (anonymous, restricted, private...), in any case. */
export function isWithheldWord(text: string): boolean {
  return WITHHELD_WORDS.has(text.trim().toLowerCase());
}

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

/**
 * Whether the engine acts on the caller's number for the app: a slot that offers it (SlotSpec.callerNumber),
 * or app.yaml's `callerNumber` block (its lookup, its withheld setting). The number is kept for every
 * app either way; this says only where the trace notes whether it could be used (TraceRecord.callerNumber).
 */
export function actsOnCallerNumber(app: App): boolean {
  return callerNumberSlots(app).length > 0 || app.callerNumber !== undefined;
}

/**
 * Whether what the carrier sent for the caller is a withheld one: a placeholder (WITHHELD_PLACEHOLDERS)
 * or a withheld word (anonymous, restricted...). Twilio sends one of those in place of the number.
 */
export function isWithheldCaller(raw: string | null | undefined): boolean {
  if (typeof raw !== 'string') return false;
  const text = raw.trim();
  if (text === '') return false;
  if (isWithheldWord(text)) return true;
  if (!NUMBER_SHAPE.test(text)) return false;
  const digits = text.replace(/\D/g, '');
  return digits !== '' && isPlaceholder(digits);
}

/**
 * The privacy a session start carries for its caller (Session.callerPrivacy): `withheld` when the
 * carrier marked the number withheld (SessionStart.callerPrivacy, Telnyx's marks) or sent a
 * placeholder or a withheld word in its place (Twilio's); undefined otherwise.
 */
export function callerPrivacyOf(raw: string | null | undefined, marked: 'withheld' | undefined): 'withheld' | undefined {
  return marked === 'withheld' || isWithheldCaller(raw) ? 'withheld' : undefined;
}

/**
 * The caller's address when it is no phone number and no withheld word: a SIP address
 * (`sip:1001@pbx.example.com`, Twilio's From for a SIP caller) or a client name (`client:alice`, a
 * Twilio Client or WebRTC caller), as sent. Null for a number, a placeholder, a withheld word, and
 * nothing; a withheld SIP address (`sip:anonymous@anonymous.invalid`) is one too, kept as data.
 */
export function callerUriOfRaw(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (text === '' || NUMBER_SHAPE.test(text) || isWithheldWord(text)) return null;
  return text.length <= 500 ? text : null;
}

/**
 * The number the engine's own features may use (the offer, the call-start lookup, the gate's
 * callerNumber rule, the caller-ID match, the consent to text): the session's number, unless the
 * caller withheld it and app.yaml's `callerNumber.withheld` says `ignore`, when there is none.
 */
export function usableCallerNumber(app: App, s: Pick<Session, 'callerNumber' | 'callerPrivacy'>): string | undefined {
  if (s.callerNumber === undefined) return undefined;
  return s.callerPrivacy === 'withheld' && app.callerNumber?.withheld === 'ignore' ? undefined : s.callerNumber;
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
 * when it came in international form): any usable number, for every app. Nothing (undefined) when
 * there is none: absent, a placeholder, a withheld word, a SIP or client address (callerUriOfRaw).
 */
export function keptCallerNumber(_app: App, raw: string | undefined): string | undefined {
  return callerNumberOf(raw) ?? undefined;
}

/**
 * What the session keeps of the number called (Session.calledNumber): its digits, `+` first when it
 * came in international form, for every app; nothing when there is none.
 */
export function keptCalledNumber(_app: App, raw: string | undefined): string | undefined {
  return callerNumberOf(raw) ?? undefined;
}

/** The caller's number as app code reads it (callerOf): as the session keeps it, its last four digits, and what the carrier said of it. */
export interface CallerNumber {
  /** Its digits, `+` first when the carrier wrote it in international form ("+15555550142"). */
  readonly number: string;
  /** Its last four digits, as a line may say them ("0142"). */
  readonly last4: string;
  /**
   * The caller asked for their number to be withheld (*67), and the carrier sent it anyway, marked so
   * (Telnyx). Honouring that is the app's choice: app.yaml's `callerNumber.withheld: ignore` keeps the
   * engine's own features off it, and the app's code may do as it likes. Absent otherwise.
   */
  readonly withheld?: true;
  /** The STIR/SHAKEN attestation the carrier gave the number, as it wrote it (`A`, `TN-Validation-Passed-A`); absent when it sent none. */
  readonly attestation?: string;
}

/**
 * The number the caller is calling from, for the app's code: a hint to look something up by or to
 * propose a value from, never proof of who is calling. Null on a chat and on a call with no usable
 * number (a withheld one Twilio sent as a placeholder among them: callerPrivacyOf says so). A number
 * the caller withheld comes with `withheld: true`, whatever app.yaml's `callerNumber.withheld` says:
 * what the app's own code does with it is the app's decision.
 */
export function callerOf(s: Session): CallerNumber | null {
  if (s.callerNumber === undefined) return null;
  return {
    number: s.callerNumber,
    last4: lastFour(s.callerNumber),
    ...(s.callerPrivacy === 'withheld' ? { withheld: true as const } : {}),
    ...(s.callerAttestation !== undefined ? { attestation: s.callerAttestation } : {}),
  };
}

/** Whether the caller withheld their number (Session.callerPrivacy), whether or not a number came with it. */
export function callerWithheldOf(s: Session): boolean {
  return s.callerPrivacy === 'withheld';
}

/**
 * The caller's address when it is no phone number: a SIP address (`sip:1001@pbx.example.com`) or a
 * client name (`client:alice`), as the carrier sent it. Null on a call from a number, a chat, and a call
 * with no address.
 */
export function callerUriOf(s: Session): string | null {
  return s.callerUri ?? null;
}

/**
 * The number the caller called (the DNIS), for the app's code: its digits, `+` first when the carrier
 * wrote it in international form. Null on a chat and when the carrier sent none.
 */
export function calledOf(s: Session): string | null {
  return s.calledNumber ?? null;
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
 * `offerAnswers: yes-no`, and the consent to text for the whole call (core/textConsent.ts). The slot offered then takes no value from the turn at its offer (fia.ts
 * slotsToFill), a value said there with no clear yes is a no, and the keypad's 1 and 2 are a yes and
 * a no (core/turn.ts). False for every other confirmation, and for an offer that takes a value too
 * (the default), which is as it was.
 */
export function yesNoOffer(app: App, pc: PendingConfirmation | null): pc is OfferPending {
  if (pc?.target !== 'slot' || pc.offered !== true) return false;
  // The consent to text for the whole call (app.yaml's textConsent) is a yes or no question.
  if (pc.consent === true) return true;
  const spec = app.slots[pc.slot];
  return pc.from === 'facts' ? spec?.offerAnswers === 'yes-no' : spec?.callerNumber?.answers === 'yes-no';
}

/**
 * A number to stand in for the caller's in a replayed call (harness-text/replay.ts). The frame log
 * keeps only the last four digits of the number (the adapter's `{ callerNumber: '…0142' }` line), which
 * is all the offer said and all the model was told, so a made-up number (the 555 range) ending in them
 * makes the same offer. The international form carriers send (Twilio and Telnyx both write E.164),
 * +1 555 555 and the last four, so the app's code and its call-start lookup see the number in the form
 * the live call's had, and a lookup fixture keyed by the last four answers as the live lookup was
 * answered, for an app with no slot that offers the number or with app.yaml's callerNumber; for one whose
 * slot offers it and nothing else reads it, or whose slot does not take that form, the shortest such
 * number the slot takes. Undefined when `last4` is not four digits, or no slot that offers the number
 * takes any such number.
 */
export function standInCallerNumber(app: App, last4: string): string | undefined {
  if (!/^\d{4}$/.test(last4)) return undefined;
  const slots = callerNumberSlots(app);
  const international = `+1555555${last4}`;
  // The international form for an app whose code or lookup reads the number (no slot, or app.yaml's
  // callerNumber), where its slots take that form too; a slot's own shortest stand-in otherwise.
  const forCode = slots.length === 0 || app.callerNumber !== undefined;
  if (forCode && (slots.length === 0 || slots.some((slot) => callerCandidate(app, slot, international) !== null))) return international;
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
