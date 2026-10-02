import { matchesMask } from '../../core/extract/mask';
import type { SlotPrompt } from '../../core/slots/types';
import { examplesFrom } from '../parts/examples';
import { defineSlotType } from '../slotType';
import type { SlotType } from '../types';
import { digitsDisplay } from './display';
import { digitsFill, maskOf } from './fill';
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
  return prompts;
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
    const mask = maskOf(o);
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
        ? { dtmf: { length: o.length, parse: (digits: string, ctx: { locale?: string }) => (matchesMask(digits, mask) ? { value: digits, display: display(digits, ctx.locale) } : null) } }
        : {}),
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
