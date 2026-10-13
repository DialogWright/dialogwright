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
 * left), a line of the app's own code. It must not find what only looks like it, so a value is whole
 * only with no digit beside it, nor a digit across a `.`, `,`, `:`, `/` or `-` (a date, "10/13/2026" or
 * "2026-10-13"; a time, "10:42"; an amount, "1,980.50"); and a short value (fewer than SHORT_DIGITS
 * digits: a year, a day, a last four) is looked for only where the decision's own variables say it
 * (`{last4}` at an offer, `{<slot>}` in a read-back), never because the session holds it: "born April 12,
 * 1980" in a line is a date, whatever a slot holds. A longer one (an account, a phone number) is too
 * unlikely to be anything else to need that.
 */

/** A value as the voice is sent it: each group of digits one by one, a comma between groups. */
export function spellDigits(value: string): string {
  return value.trim().split(/\s+/).map((group) => [...group].join(' ')).join(', ');
}

/** The few digits a value may be, and still be looked for: one digit reads the same either way. */
const MIN_DIGITS = 2;
/**
 * The fewest digits a value the session holds is looked for with in a line its variables do not name:
 * under this, a year, a day, a time or a last four could be any number the line says.
 */
export const SHORT_DIGITS = 5;
/** A value as a digits slot holds or shows it: digits, in groups split by single spaces. */
const DIGIT_VALUE = /^\d+(?: \d+)*$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

const digitCount = (value: string): number => value.replace(/\D/g, '').length;

/**
 * What the lines of a turn may say of each slot said digit by digit (SlotSpec.sayAs), from the session
 * as it stands after the turn and the turn's decision:
 *
 * - named by the decision's own variables (the line's and its acknowledgements'): a variable named for
 *   the slot, and `{last4}` where it is the last four of the slot's value or of the number offered for it;
 * - held by the session, when it has SHORT_DIGITS digits or more: the slot's value and display, and a
 *   value read back or offered for it (the pending read-back), so a repeat of the last line, which has no
 *   variables, and a line of the app's own code say it too;
 * - on a repeat of the last line (a `replay` decision, which has no variables), what it can have said:
 *   the session's values of any length (a short read-back), and the last four of the caller's number
 *   while its offer, or the consent to text, is the question still asked.
 *
 * Every value is digits only (DIGIT_VALUE) of at least MIN_DIGITS digits. Empty for an app with no such slot.
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
  const add = (v: unknown, named: boolean): void => {
    if (typeof v !== 'string') return;
    const value = v.trim();
    if (!DIGIT_VALUE.test(value) || digitCount(value) < MIN_DIGITS) return;
    if (named || digitCount(value) >= SHORT_DIGITS) out.add(value);
  };
  // A repeat of the last line (no variables left) says what that line said: a short value the session
  // holds for such a slot is taken as named there, as its variables named it the first time.
  const replay = isObject(decision) && decision.kind === 'replay';
  for (const [id, st] of Object.entries(session.slots)) {
    if (!spelled(id) || !isObject(st)) continue;
    add(st.value, replay);
    add(st.display, replay);
    if (typeof st.value === 'string') lastFours.add(lastFour(st.value));
  }
  const pc = session.pendingConfirmation;
  if (isObject(pc) && pc.target === 'slot' && spelled(pc.slot)) {
    add(pc.value, replay);
    add(pc.display, replay);
    if (typeof pc.value === 'string') {
      lastFours.add(lastFour(pc.value));
      // The caller's number offered (or the consent to text, by the same number), asked again word for word.
      const offered = pc.from === undefined && (pc.offered === true || pc.consent === true);
      if (offered && replay) add(lastFour(pc.value), true);
    }
  }
  const vars = (v: unknown): void => {
    if (!isObject(v)) return;
    for (const [name, text] of Object.entries(v)) {
      if (spelled(name)) add(text, true);
      else if (name === 'last4' && typeof text === 'string' && lastFours.has(text)) add(text, true);
    }
  };
  if (isObject(decision)) {
    vars(decision.vars);
    if (Array.isArray(decision.acks)) for (const a of decision.acks) if (isObject(a)) vars(a.vars);
  }
  return [...out];
}

/** What may not touch a value for it to be whole: a digit, or a digit across a separator of dates, times and amounts. */
const SEPARATOR = '[.,:/\\-]';

/** A pattern for the values, longest first, each whole. */
function patternOf(values: readonly string[]): RegExp {
  const escape = (v: string): string => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const alternatives = [...new Set(values)].sort((a, b) => b.length - a.length).map(escape).join('|');
  return new RegExp(`(?<!\\p{N}|\\p{N}${SEPARATOR})(?:${alternatives})(?!\\p{N}|${SEPARATOR}\\p{N})`, 'gu');
}

/** `text` with each of `values` (digitsSaidOf), found whole, said digit by digit (spellDigits); as it is with none. */
export function sayDigits(text: string, values: readonly string[]): string {
  if (values.length === 0) return text;
  return text.replace(patternOf(values), (found) => spellDigits(found));
}
