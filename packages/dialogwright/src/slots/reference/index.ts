import type { AnswerMap, QuestionMap } from '../../jev/types';
import { isChoice, noulValue } from '../../jev/types';
import type { SlotContext, SlotOutcome, SlotPrompt } from '../../core/slots/types';
import { examplesFrom } from '../parts/examples';
import { readBackOf, readBackPrompts } from '../parts/readBack';
import { meetsThreshold } from '../parts/thresholds';
import { defineSlotType } from '../slotType';
import type { SlotType } from '../types';
import { REFERENCE_PARTS, REFERENCE_QUESTIONS, referenceOptions, type ReferenceOptions } from './options';
import { readReference, referenceFits, referenceSpans, tokensOf } from './read';

export { referenceOptions, REFERENCE_PARTS, REFERENCE_QUESTIONS, DEFAULT_ALPHABET, MAX_REFERENCE_LENGTH } from './options';
export type { ReferenceOptions } from './options';
export { readReference, referenceSpans, tokensOf } from './read';

const examples = examplesFrom(new URL('./examples.yaml', import.meta.url));

const idsOf = (slot: string, o: ReferenceOptions) => ({ given: REFERENCE_QUESTIONS.id(slot, 'given', o.ids), span: REFERENCE_QUESTIONS.id(slot, 'span', o.ids) });
const articleOf = (o: ReferenceOptions): string => o.article ?? (/^[aeiou]/i.test(o.noun ?? '') ? 'an' : 'a');

/** How a reference is said: its characters one at a time ("K E V H U D"), in every locale, so a voice spells it and a reader can check it. */
export function referenceDisplay(value: string): string {
  return value.split('').join(' ');
}

/** The questions: whether the caller states the reference, and which of the spans read as one it is (and none). */
function referenceQuestions(slot: string, o: ReferenceOptions): (ctx: SlotContext) => QuestionMap {
  const ids = idsOf(slot, o);
  const vars = { article: articleOf(o), noun: o.noun ?? '' };
  const given = REFERENCE_PARTS.render('given', o.text, vars);
  const span = REFERENCE_PARTS.render('span', o.text, vars);
  const none = REFERENCE_PARTS.render('none', o.text, vars);
  return (ctx) => {
    const criteria: Record<string, string | null> = {};
    for (const s of referenceSpans(ctx.text, o.length, o.alphabet, ctx.locale)) criteria[s] = null;
    criteria.none = none;
    return {
      [ids.given]: { type: 'noul', instructions: given },
      [ids.span]: { type: 'choice', instructions: span, criteria },
    };
  };
}

/**
 * The fill. Not stated (SLOT_DETECT): absent. No span chosen: invalid, "no_span". The span read, and
 * not a reference of the slot's length and alphabet: invalid, "shape". Otherwise filled, said one
 * character at a time.
 */
function referenceFill(o: ReferenceOptions, slot: string): (answers: AnswerMap, ctx: SlotContext) => SlotOutcome {
  const ids = idsOf(slot, o);
  return (answers, ctx) => {
    if (!meetsThreshold(ctx.thresholds, 'SLOT_DETECT', noulValue(answers, ids.given))) return { kind: 'absent' };
    const span = answers[ids.span];
    if (!isChoice(span) || typeof span.choice !== 'string' || span.choice === 'none') return { kind: 'invalid', reason: 'no_span', raw: '' };
    const value = readReference(tokensOf(span.choice), o.alphabet, ctx.locale);
    if (value === null || !referenceFits(value, o.length, o.alphabet)) return { kind: 'invalid', reason: 'shape', raw: value ?? '' };
    const p = span.probabilities?.[span.choice] ?? span.confidence;
    return { kind: 'filled', value, display: referenceDisplay(value), confidence: p, confirm: o.confirm === 'acknowledge' ? 'implicit' : 'none' };
  };
}

/**
 * `reference`: a code of letters and digits of a set length, such as a booking code or an order
 * reference. Code reads the caller's words for spans that spell one (typed, spelled, by letter names
 * or the spelling alphabet), the model chooses which span the caller meant, and code checks it, so the
 * value is always something the caller said. See README.md beside this file.
 */
export const referenceType: SlotType<ReferenceOptions> = defineSlotType<ReferenceOptions>({
  type: 'reference',
  options: referenceOptions,
  build(id, o) {
    const ids = idsOf(id, o);
    const acknowledge = o.confirm === 'acknowledge';
    const prompts: SlotPrompt[] = acknowledge
      ? [{ id: `ack_${id}`, why: 'it says the reference back as soon as it is heard (confirm: acknowledge)', vars: [id] }]
      : [...readBackPrompts(id, o.confirm === 'always' ? 'always' : 'summary')];
    return {
      id,
      // Acknowledged: the engine says ack_<slot> for a fill that asks for an implicit read-back (SlotSpec.spokenConfirm by-confidence).
      ...(acknowledge ? { spokenConfirm: 'by-confidence' as const } : readBackOf(o.confirm === 'always' ? 'always' : 'summary')),
      ...(o.redact === 'last4' ? { redact: 'last4' as const } : {}),
      ...(o.redact === 'length' ? { redact: 'length' as const, statement: false as const } : {}),
      ...(o.handoff !== 'display' ? { handoff: o.handoff } : {}),
      detect: true,
      questionIds: [ids.given, ids.span],
      prompts,
      questions: referenceQuestions(id, o),
      fill: referenceFill(o, id),
      display: (value: string) => referenceDisplay(value),
    };
  },
  get examples() {
    return examples();
  },
  describe: {
    summary: 'A code of letters and digits of a set length: a booking code, an order reference.',
    notes: 'Code reads the spans of the caller\'s words that spell a reference (typed, spelled, by letter names or the spelling alphabet) and checks the one the model chooses, so the value is always something the caller said. Masked by its length by default.',
  },
});
