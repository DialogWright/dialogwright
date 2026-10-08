import type { SlotPrompt, SlotSpec } from '../../core/slots/types';
import { examplesFrom } from '../parts/examples';
import { defineSlotType } from '../slotType';
import type { SlotType } from '../types';
import { digitsDisplay } from './display';
import { digitsFill, digitsFit } from './fill';
import { digitsOptions, type DigitsOptions } from './options';
import { digitsQuestions, idsOf, thingOf } from './questions';

export { digitsOptions, DIGITS_PARTS, DIGITS_QUESTIONS, MIN_CONFIDENCE } from './options';
export type { DigitsOptions } from './options';
export { digitsDisplay } from './display';

const examples = examplesFrom(new URL('./examples.yaml', import.meta.url));

/** The lines a digits slot may lead to, beyond ask_<slot> and ask_<slot>_retry. */
function promptsOf(id: string, o: DigitsOptions): SlotPrompt[] {
  const thing = thingOf(o);
  const prompts: SlotPrompt[] = [];
  if (o.lengthRetryPromptId !== undefined) {
    const shape = o.length !== undefined && o.mask === undefined ? `not ${o.length} digits` : 'not a number of the right shape';
    prompts.push({ id: o.lengthRetryPromptId, why: `the caller said a number that is ${shape} (the fill's retryPromptId)` });
  }
  if (o.confirm === 'by-confidence') prompts.push({ id: `ack_${id}`, why: `it acknowledges ${thing} it is less sure of`, vars: [id] });
  if (o.keypad) prompts.push({ id: `ask_${id}_dtmf`, why: `it asks for ${thing} on the keypad after spoken answers missed` });
  if (o.callerNumber !== undefined) prompts.push({ id: `offer_${id}`, why: `it offers the number the caller is calling from for ${thing}, as a yes or no (callerNumber)`, vars: ['last4'] });
  return prompts;
}

/**
 * The slot's value for the number the caller is calling from (its digits, `+` first when the carrier
 * wrote it in international form): held to the slot's pattern as a spoken number is, null when it
 * does not fit. A number in international form names its country, so it must begin with the slot's
 * country code, which is taken off ("+15555550142" is 5555550142; "+3545550142", ten digits from
 * another country, is no number for the slot). One with no `+` has the country code taken off when
 * what is left has the slot's `length` (with no `length`, when what is left fits); otherwise it is
 * taken as it is.
 */
function callerNumberOf(o: DigitsOptions, display: (value: string, locale?: string) => string): NonNullable<SlotSpec['callerNumber']> {
  const fits = digitsFit(o);
  const code = o.callerNumber!.countryCode;
  return {
    take(number, locale) {
      const international = number.startsWith('+');
      const digits = international ? number.slice(1) : number;
      const rest = digits.startsWith(code) ? digits.slice(code.length) : null;
      const local = international ? rest
        : rest !== null && (o.length !== undefined ? rest.length === o.length : fits(rest)) ? rest : digits;
      return local !== null && fits(local) ? { value: local, display: display(local, locale) } : null;
    },
  };
}

/**
 * `digits`: a number of fixed shape that no list holds (an account, a card, a tracking number). The
 * model is asked whether a number is stated, which span of the caller's words it is, and whether it
 * was said whole; the code turns the span into digits and checks them against the pattern, so the
 * value is always something the caller said and the model never writes it. See README.md beside this
 * file.
 */
export const digitsType: SlotType<DigitsOptions> = defineSlotType<DigitsOptions>({
  type: 'digits',
  options: digitsOptions,
  build(id, o) {
    const ids = idsOf(id, o);
    const display = digitsDisplay(o);
    const fits = digitsFit(o);
    return {
      id,
      spokenConfirm: o.confirm,
      ...(o.redact === 'last4' ? { redact: 'last4' as const } : {}),
      ...(o.handoff !== 'display' ? { handoff: o.handoff } : {}),
      detect: true,
      questionIds: [ids.given, ids.span, ids.complete],
      prompts: promptsOf(id, o),
      ...(o.minConfidence !== 'none' ? { thresholds: [o.minConfidence] } : {}),
      questions: digitsQuestions(id, o),
      fill: digitsFill(o, ids, display),
      ...(o.keypad && o.length !== undefined
        ? { dtmf: { length: o.length, parse: (digits: string, ctx: { locale?: string }) => (fits(digits) ? { value: digits, display: display(digits, ctx.locale) } : null) } }
        : {}),
      ...(o.callerNumber !== undefined ? { callerNumber: callerNumberOf(o, display) } : {}),
      display,
    };
  },
  get examples() {
    return examples();
  },
  describe: {
    summary: 'A number of a fixed shape that no list holds: an account, a library card, a tracking number.',
    notes: 'The model judges whether a number is stated, which span of the words is it, and whether it was said whole; the code turns the span into digits and checks them, so the value is always something the caller said. Identifiers are masked by their last four digits by default.',
  },
});
