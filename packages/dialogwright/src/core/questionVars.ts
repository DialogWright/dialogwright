import type { App, SlotId } from './app/types';
import type { Session } from './session';
import { DEFAULT_THRESHOLDS } from './thresholds';
import type { Decision } from './decision';
import type { SlotContext } from './slots/types';
import { slotSpecOf } from './app/lookup';
import { lineOf } from '../prompts/segments';

/**
 * A slot's own question, with the values its question lines may say (SlotSpec.questionVars: a record
 * slot's {choices}): given to the decision when it asks `ask_<slot>`, one of its other wordings, or one of
 * its retry lines (`ask_<slot>_retry`, `ask_<slot>_retry2`), so the line said and the line the turn keeps
 * (lastPromptText) are the same. The decision's own values win. Every other decision is as it was.
 */
export function withQuestionVars(app: App, decision: Decision, ctx: () => SlotContext): void {
  if (decision.kind !== 'prompt' || decision.target === null || !Object.hasOwn(app.slots, decision.target)) return;
  const slot = decision.target;
  const line = lineOf(decision.promptId);
  if (line !== `ask_${slot}` && !line.startsWith(`ask_${slot}_retry`)) return;
  const given = slotSpecOf(app, slot).questionVars;
  if (given === undefined) return;
  decision.vars = { ...given.of(ctx()), ...decision.vars };
}

/**
 * The values `slot`'s question lines may say, outside a turn (the harness setting a corpus line at the
 * slot's question): from the session's facts as the slot sees them (FactsConfig.forSlots) and its
 * language. Empty for a slot that gives none.
 */
export function questionVarsFor(app: App, s: Session, slot: SlotId): Readonly<Record<string, string>> {
  const given = slotSpecOf(app, slot).questionVars;
  if (given === undefined) return {};
  const lists = app.facts?.forSlots?.(s.facts);
  const ctx = {
    text: '', candidateSpans: [], candidateWordSpans: [], todayIso: '', thresholds: { ...DEFAULT_THRESHOLDS },
    window: null, current: null, prompted: false, records: lists?.records ?? [],
    ...(lists?.sources !== undefined ? { sources: lists.sources } : {}),
    ...(s.locale !== undefined ? { locale: s.locale } : {}),
  } as unknown as SlotContext;
  return given.of(ctx);
}
