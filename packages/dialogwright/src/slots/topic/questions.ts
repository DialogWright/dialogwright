import type { SlotContext } from '../../core/slots/types';
import type { QuestionMap } from '../../jev/types';
import type { Nomination } from '../../kb/types';
import { renderCriterion } from './criterion';
import { TOPIC_PARTS, type TopicOptions } from './options';

/** The id of a topic slot's question: the slot's id followed by `Topic`, unless `ids.choice` says otherwise. */
export const topicIdOf = (slot: string, o: Pick<TopicOptions, 'ids'>): string => o.ids?.choice ?? `${slot}Topic`;

/**
 * The topics the question offers: the nominated ones (SlotContext.nominated), best first as the
 * retriever gave them, each once, at most `cap`. A topic whose id is `none` would be the question's
 * own none label, so it is never offered.
 */
export function offeredTopics(nominated: readonly Nomination[] | undefined, cap: number): Nomination[] {
  const seen = new Set<string>();
  const out: Nomination[] = [];
  for (const n of nominated ?? []) {
    if (out.length >= cap) break;
    if (n.topic === 'none' || seen.has(n.topic)) continue;
    seen.add(n.topic);
    out.push(n);
  }
  return out;
}

/**
 * A topic slot's one question: which of the nominated topics does the caller ask about? Each label is
 * a topic's id, its criterion rendered from `criterion` with the title the retriever gave, then
 * `none`. With nothing nominated (no retrieval this turn, or nothing found) the slot asks nothing, so
 * a turn with no plausible topic costs nothing.
 */
export function topicQuestions(slot: string, o: TopicOptions, cap: number): (ctx: SlotContext) => QuestionMap {
  const id = topicIdOf(slot, o);
  const instructions = TOPIC_PARTS.render('instructions', o.text, {});
  const none = TOPIC_PARTS.render('none', o.text, {});
  return (ctx) => {
    const offered = offeredTopics(ctx.nominated, cap);
    if (offered.length === 0) return {};
    const criteria: Record<string, string> = {};
    for (const n of offered) criteria[n.topic] = renderCriterion(o.criterion, { title: n.title, topic: n.topic });
    criteria.none = none;
    return { [id]: { type: 'choice', instructions, criteria } };
  };
}
