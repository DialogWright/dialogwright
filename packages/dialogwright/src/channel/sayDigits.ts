import type { SlotSpec } from '../core/slots/types';
import { lastFour } from '../core/callerNumber';

/**
 * A number said digit by digit on the phone (SlotSpec.sayAs `digits`: a `digits` slot's value, by
 * default). A text-to-speech voice reads "0142" as "one hundred forty-two" and "55507788" as a number
 * in the millions (both carriers, live calls 2026-10-13), where the caller wants the digits they gave,
 * one at a time. So the voice is sent "0 1 4 2", and a value said in groups ("5550 7788", the slot's
 * `group`) as each group's digits with a short pause between them ("5 5 5 0, 7 7 8 8"), as an app's
 * `groups` rule spells them (server/adapter.ts spokenDigits).
 *
 * Like the app's own rules (App.voice.spokenDigits) and its respellings (channel/pronounce.ts), only the
 * text sent to the voice is rewritten (server/adapter.ts sendFrames): the session, the trace, the
 * console's readable text, a chat and every regression baseline keep the value as written.
 *
 * Which words are the value is known from the values themselves, never from the shape of a line: the
 * values a turn can say of each such slot (digitsSaidOf) are looked for whole in each line, as the frame
 * log's masking looks for a redacted value (trace/redact.ts turnScrubber). That finds the value wherever
 * a line holds it: a read-back or a summary from the slot's variable, a line worded by a model (which
 * keeps every value word for word, render/checks.ts), a repeat of the last line (which has no variables
 * left), a line of the app's own code; and nothing that only looks like it, inside a longer number.
 */

/** A value as the voice is sent it: each group of digits one by one, a comma between groups. */
export function spellDigits(value: string): string {
  return value.trim().split(/\s+/).map((group) => [...group].join(' ')).join(', ');
}

/** The few digits a value may be, and still be looked for: one digit reads the same either way. */
const MIN_DIGITS = 2;
/** A value as a digits slot holds or shows it: digits, in groups split by single spaces. */
const DIGIT_VALUE = /^\d+(?: \d+)*$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * What the session as it stands after a turn may have a line say of each slot said digit by digit
 * (SlotSpec.sayAs): the slot's value and display, a value read back or offered for it (the pending
 * read-back), the last four digits of the caller's number offered for it (`{last4}`, an offer or the
 * consent to text), and the decision's variables named for the slot or `last4` that are one of those
 * last fours (a line said as the offer closes). Every value is digits only (DIGIT_VALUE) of at least
 * MIN_DIGITS digits. Empty for an app with no such slot.
 */
export function digitsSaidOf(
  app: { readonly slots: Readonly<Record<string, Pick<SlotSpec, 'sayAs'>>> },
  session: {
    readonly slots: Readonly<Record<string, { readonly value?: unknown; readonly display?: unknown } | null | undefined>>;
    readonly pendingConfirmation?: unknown;
  },
  decision: unknown,
): string[] {
  const spelled = (slot: unknown): slot is string => typeof slot === 'string' && Object.hasOwn(app.slots, slot) && app.slots[slot]!.sayAs === 'digits';
  if (!Object.values(app.slots).some((spec) => spec.sayAs === 'digits')) return [];
  const out = new Set<string>();
  const lastFours = new Set<string>();
  const add = (v: unknown): void => {
    if (typeof v !== 'string') return;
    const value = v.trim();
    if (DIGIT_VALUE.test(value) && value.replace(/\D/g, '').length >= MIN_DIGITS) out.add(value);
  };
  for (const [id, st] of Object.entries(session.slots)) {
    if (!spelled(id) || !isObject(st)) continue;
    add(st.value);
    add(st.display);
    if (typeof st.value === 'string') lastFours.add(lastFour(st.value));
  }
  const pc = session.pendingConfirmation;
  if (isObject(pc) && pc.target === 'slot' && spelled(pc.slot)) {
    add(pc.value);
    add(pc.display);
    if (typeof pc.value === 'string') {
      // The caller's number offered (or the consent to text, by the same number): its line says the last four.
      if (pc.from === undefined && (pc.offered === true || pc.consent === true)) add(lastFour(pc.value));
      lastFours.add(lastFour(pc.value));
    }
  }
  const vars = (v: unknown): void => {
    if (!isObject(v)) return;
    for (const [name, text] of Object.entries(v)) {
      if (spelled(name)) add(text);
      else if (name === 'last4' && typeof text === 'string' && lastFours.has(text)) add(text);
    }
  };
  if (isObject(decision)) {
    vars(decision.vars);
    if (Array.isArray(decision.acks)) for (const a of decision.acks) if (isObject(a)) vars(a.vars);
  }
  return [...out];
}

/** A pattern for the values, longest first, each whole: not inside a longer run of digits, nor beside a decimal point or a thousands comma. */
function patternOf(values: readonly string[]): RegExp {
  const escape = (v: string): string => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const alternatives = [...new Set(values)].sort((a, b) => b.length - a.length).map(escape).join('|');
  return new RegExp(`(?<!\\p{N}|\\p{N}[.,])(?:${alternatives})(?!\\p{N}|[.,]\\p{N})`, 'gu');
}

/** `text` with each of `values` (digitsSaidOf), found whole, said digit by digit (spellDigits); as it is with none. */
export function sayDigits(text: string, values: readonly string[]): string {
  if (values.length === 0) return text;
  return text.replace(patternOf(values), (found) => spellDigits(found));
}
