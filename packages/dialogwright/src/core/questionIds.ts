import type { SlotId } from './app/types';
import type { SlotSpec } from './slots/types';

/**
 * The question ids the engine itself asks (core/questions.ts builds the questions), and the check
 * that keeps a slot's declared ids (SlotSpec.questionIds) off them and off each other. A leaf
 * module, so app validation (core/app/validate.ts) can read it without the turn's modules.
 */

export const ALWAYS_ON_IDS = [
  'intent', 'intentTentative',
  'addressedToSystem', 'utteranceComplete', 'wantsHuman', 'rephrasingLastTurn', 'confusedByPrompt', 'spokeAMenuNumber',
  'frustration', 'urgency', 'triedSelfService', 'languageSwitch',
  'intelligible',
] as const;

/**
 * Every question id the engine itself asks, in any state: the always-on ones, the confirmation's,
 * the in-form, opener, summary and menu ones, and the injection screen's. An app's own question
 * (App.questions) may not take one, even in a state where the engine would not ask it, since the
 * engine reads its answers by these names; nor may a slot's (SlotSpec.questions), for the same reason.
 */
export const ENGINE_QUESTION_IDS: readonly string[] = [
  ...ALWAYS_ON_IDS, 'confirmsYes', 'confirmsNo', 'intentChange', 'secondIntent', 'changeSlot', 'menuNumberSaid', 'manipulation',
];

/** A question id a slot declares (SlotSpec.questionIds) that it may not have, and what it collides with. */
export interface QuestionIdClash {
  slot: SlotId;
  id: string;
  /** `engine`: the engine asks it; `twice`: the slot lists it twice; otherwise the earlier slot that declares it too. */
  with: 'engine' | 'twice' | { slot: SlotId };
}

/**
 * Every collision among the slots' declared question ids, in the slots' order: an id the engine asks,
 * an id the slot lists twice, an id an earlier slot declares too. Slots that declare none are not
 * checked here (buildQuestions checks what they ask, turn by turn).
 */
export function declaredQuestionIdClashes(slots: Readonly<Record<SlotId, SlotSpec>>): QuestionIdClash[] {
  const clashes: QuestionIdClash[] = [];
  const owner = new Map<string, SlotId>();
  for (const [slot, spec] of Object.entries(slots)) {
    const ids = spec?.questionIds;
    if (ids === undefined) continue;
    const own = new Set<string>();
    for (const id of ids) {
      if (ENGINE_QUESTION_IDS.includes(id)) clashes.push({ slot, id, with: 'engine' });
      else if (own.has(id)) clashes.push({ slot, id, with: 'twice' });
      else if (owner.has(id)) clashes.push({ slot, id, with: { slot: owner.get(id)! } });
      own.add(id);
      if (!owner.has(id)) owner.set(id, slot);
    }
  }
  return clashes;
}

/** A clash in words: `slot "card" declares the question id "urgency", which is one the engine asks ...`. */
export function clashMessage(clash: QuestionIdClash): string {
  const declares = `slot "${clash.slot}" declares the question id "${clash.id}"`;
  if (clash.with === 'engine') return `${declares}, which is one the engine asks, so its answers would be read as the engine's`;
  if (clash.with === 'twice') return `${declares} twice`;
  return `${declares}, which the slot "${clash.with.slot}" declares too, so one slot's question would replace the other's`;
}
