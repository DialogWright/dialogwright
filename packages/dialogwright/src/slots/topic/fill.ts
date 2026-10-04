import type { SlotContext, SlotOutcome } from '../../core/slots/types';
import type { AnswerMap } from '../../jev/types';
import { isChoice, rankProbabilities, type Ranked } from '../../jev/types';
import type { TopicCatalog } from '../../kb/types';
import { meetsThreshold } from '../parts/thresholds';
import type { TopicOptions } from './options';
import { offeredTopics } from './questions';

/**
 * A topic slot's fill. A label is a topic it may fill with when the question offered it on that turn
 * (one of the first `cap` nominations), or, with `accept: catalog`, when it is any topic of the app's
 * knowledge; `none` never is.
 *
 * Without `disambiguate`, the model's pick is read: the topic it chose, at its own probability (or
 * the answer's confidence when the pick has none), fills when that reaches `fillAt`.
 *
 * With `disambiguate`, the probabilities of every label are read, best first:
 * - The top label not a topic the slot may fill, or below SLOT_CHOICE_CONFIRM: nothing chosen.
 * - The second a topic it may fill too, and within KB_TOPIC_MARGIN of the top: ask which of the two.
 * - Below `fillAt`: nothing chosen.
 *
 * Filled, the value is the topic's id and the display its title (display.ts); the summary reads it
 * back, so it is never acknowledged. Nothing chosen is invalid with `missReason` (raw empty) when the
 * slot was asked for, else absent.
 */
export function topicFill(
  o: TopicOptions,
  questionId: string,
  cap: number,
  catalog: TopicCatalog | undefined,
  display: (value: string, locale?: string) => string,
): (answers: AnswerMap, ctx: SlotContext) => SlotOutcome {
  const known = new Set((catalog?.topics ?? []).map((t) => t.id));
  return (answers, ctx) => {
    const t = ctx.thresholds;
    const miss: SlotOutcome = ctx.prompted ? { kind: 'invalid', reason: o.missReason, raw: '' } : { kind: 'absent' };
    const offered = new Set(offeredTopics(ctx.nominated, cap).map((n) => n.topic));
    const fillable = (label: string): boolean => label !== 'none' && (offered.has(label) || (o.accept === 'catalog' && known.has(label)));
    const a = answers[questionId];
    if (!isChoice(a)) return miss;
    const probabilities = typeof a.probabilities === 'object' && a.probabilities !== null ? a.probabilities : {};
    let top: Ranked | undefined;
    if (o.disambiguate) {
      const [first, second] = rankProbabilities(probabilities);
      if (!first || !fillable(first.label) || !meetsThreshold(t, 'SLOT_CHOICE_CONFIRM', first.p)) return miss;
      top = first;
      if (second && fillable(second.label) && !meetsThreshold(t, 'KB_TOPIC_MARGIN', first.p - second.p)) {
        return { kind: 'disambiguate', a: { value: first.label, display: display(first.label, ctx.locale) }, b: { value: second.label, display: display(second.label, ctx.locale) } };
      }
    } else {
      if (typeof a.choice !== 'string' || !fillable(a.choice)) return miss;
      top = { label: a.choice, p: probabilities[a.choice] ?? a.confidence };
    }
    if (!meetsThreshold(t, o.fillAt, top.p)) return miss;
    return { kind: 'filled', value: top.label, display: display(top.label, ctx.locale), confidence: top.p, confirm: 'none' };
  };
}
