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

/** A question id a slot declares (SlotSpec.questionIds), or asks, that it may not have, and what it collides with. */
export interface QuestionIdClash {
  slot: SlotId;
  id: string;
  /**
   * `engine`: the engine asks it; `twice`: the slot lists it twice; `undeclared`: the slot asks it but
   * its questionIds leave it out; otherwise the earlier slot that declares (or asks) it too.
   */
  with: 'engine' | 'twice' | 'undeclared' | { slot: SlotId };
  /** The slot asks it (seen when its questions() were tried), rather than declaring it. */
  asked?: boolean;
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

/**
 * Every collision among the ids the slots ask (`asked`, by slot: what their questions() returned
 * when tried, core/app/probeQuestions.ts) that declaredQuestionIdClashes cannot see: an asked id the
 * slot's own questionIds leave out, and, for a slot that declares none, an asked id the engine asks
 * or another slot declares or asks. Two declared ids are left to declaredQuestionIdClashes.
 */
export function askedQuestionIdClashes(slots: Readonly<Record<SlotId, SlotSpec>>, asked: Readonly<Record<SlotId, ReadonlySet<string>>>): QuestionIdClash[] {
  const clashes: QuestionIdClash[] = [];
  const owner = new Map<string, { slot: SlotId; declared: boolean }>();
  for (const [slot, spec] of Object.entries(slots)) {
    const declared = spec?.questionIds;
    const ids = new Map<string, boolean>();
    for (const id of declared ?? []) ids.set(id, true);
    for (const id of asked[slot] ?? []) {
      if (ids.has(id)) continue;
      if (declared !== undefined) clashes.push({ slot, id, with: 'undeclared', asked: true });
      else ids.set(id, false);
    }
    for (const [id, isDeclared] of ids) {
      if (!isDeclared && ENGINE_QUESTION_IDS.includes(id)) clashes.push({ slot, id, with: 'engine', asked: true });
      const earlier = owner.get(id);
      if (earlier === undefined) owner.set(id, { slot, declared: isDeclared });
      else if (!(earlier.declared && isDeclared)) clashes.push({ slot, id, with: { slot: earlier.slot }, asked: true });
    }
  }
  return clashes;
}

/** A clash in words: `slot "card" declares the question id "urgency", which is one the engine asks ...`. */
export function clashMessage(clash: QuestionIdClash): string {
  if (clash.asked) {
    const asks = `slot "${clash.slot}" asks the question "${clash.id}" (seen when its questions() were tried on sample turns)`;
    if (clash.with === 'undeclared') return `${asks}, which its questionIds leave out`;
    if (clash.with === 'engine') return `${asks}, which is one the engine asks, so its answers would be read as the engine's and the engine's question replaced`;
    if (clash.with === 'twice') return `${asks} twice`;
    return `slots "${clash.with.slot}" and "${clash.slot}" both ask the question "${clash.id}" (seen when their questions() were tried on sample turns), so one slot's question would replace the other's`;
  }
  const declares = `slot "${clash.slot}" declares the question id "${clash.id}"`;
  if (clash.with === 'engine') return `${declares}, which is one the engine asks, so its answers would be read as the engine's`;
  if (clash.with === 'twice') return `${declares} twice`;
  if (clash.with === 'undeclared') return `${declares}, which it does not ask`;
  return `${declares}, which the slot "${clash.with.slot}" declares too, so one slot's question would replace the other's`;
}
