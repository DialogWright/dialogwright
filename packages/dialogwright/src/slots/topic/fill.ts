import type { SlotContext, SlotOutcome } from '../../core/slots/types';
import type { AnswerMap } from '../../jev/types';
import { isChoice, rankProbabilities, type Ranked } from '../../jev/types';
import type { TopicCatalog } from '../../kb/types';
import { meetsThreshold } from '../parts/thresholds';
import type { TopicOptions } from './options';
import { offeredTopics, sectionQuestionIdOf, SECTIONS_VALUE_PREFIX } from './questions';
import { noulValue } from '../../jev/types';

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
 *
 * With `unanswered: retry` (the default), the top label `unanswered` at `fillAt` or above (the bar a topic fills at)
 * is a question asked that none of the topics answers: a miss when the slot was asked for, as any; when
 * it was not, an invalid outcome the form holds to (`held`, SlotState.missed), so the slot's retry line
 * is said when the form comes to it rather than its question, as if nothing had been asked. At its own
 * question, `none` on top (the caller said nothing about what they want to know: "I have a question")
 * is a miss with `reask`: counted, and the question asked again as it stands rather than the retry line,
 * which says nothing answers what was asked.
 */
/** The most sections an answer from documents is worded from. */
export const MAX_ANSWER_SECTIONS = 2;

export function topicFill(
  o: TopicOptions,
  questionId: string,
  cap: number,
  catalog: TopicCatalog | undefined,
  display: (value: string, locale?: string) => string,
  slot = questionId.replace(/Topic$/, ''),
): (answers: AnswerMap, ctx: SlotContext) => SlotOutcome {
  const byTopic = topicOnly(o, questionId, cap, catalog, display);
  return (answers, ctx) => {
    const out = byTopic(answers, ctx);
    // A topic wins: sections answer only a question no topic does (kb.yaml documents), never a turn that
    // asked nothing (none on top), and never with `unanswered: ask`.
    if (out.kind === 'filled' || out.kind === 'disambiguate' || out.kind === 'help' || o.unanswered !== 'retry' || (ctx.sections ?? []).length === 0) return out;
    const a = answers[questionId];
    if (isChoice(a)) {
      const top = o.disambiguate ? rankProbabilities(typeof a.probabilities === 'object' && a.probabilities !== null ? a.probabilities : {})[0]?.label : a.choice;
      if (top === 'none') return out;
    }
    const answering = (ctx.sections ?? [])
      .map((s, i) => ({ s, p: noulValue(answers, sectionQuestionIdOf(slot, i)) }))
      .filter((x) => meetsThreshold(ctx.thresholds, 'KB_SECTION_ANSWERS', x.p))
      .sort((x, y) => y.p - x.p)
      .slice(0, MAX_ANSWER_SECTIONS);
    if (answering.length === 0) return out;
    return { kind: 'filled', value: `${SECTIONS_VALUE_PREFIX}${answering.map((x) => x.s.key).join('|')}`, display: answering[0]!.s.heading.toLowerCase(), confidence: answering[0]!.p, confirm: 'none' };
  };
}

/** The fill by the topic question alone (see topicFill). */
function topicOnly(
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
    // A question asked that no topic answers (`unanswered: retry`): a miss the form holds to when the slot was not asked for.
    const unanswered: SlotOutcome = ctx.prompted ? miss : { kind: 'invalid', reason: o.missReason, raw: '', held: true };
    // At its own question, `none` (the caller said nothing about what they want to know): the question asked again, counted.
    const nothingAsked = (label: string | undefined): boolean => o.unanswered === 'retry' && ctx.prompted && label === 'none';
    const reask: SlotOutcome = { kind: 'invalid', reason: o.missReason, raw: '', reask: true };
    const isUnanswered = (label: string | undefined, p: number): boolean => o.unanswered === 'retry' && label === 'unanswered' && meetsThreshold(t, o.fillAt, p);
    const offered = new Set(offeredTopics(ctx.nominated, cap).map((n) => n.topic));
    const fillable = (label: string): boolean => label !== 'none' && label !== 'unanswered' && (offered.has(label) || (o.accept === 'catalog' && known.has(label)));
    const a = answers[questionId];
    if (!isChoice(a)) return miss;
    const probabilities = typeof a.probabilities === 'object' && a.probabilities !== null ? a.probabilities : {};
    let top: Ranked | undefined;
    if (o.disambiguate) {
      const [first, second] = rankProbabilities(probabilities);
      if (first && isUnanswered(first.label, first.p)) return unanswered;
      if (nothingAsked(first?.label)) return reask;
      if (!first || !fillable(first.label) || !meetsThreshold(t, 'SLOT_CHOICE_CONFIRM', first.p)) return miss;
      top = first;
      if (second && fillable(second.label) && !meetsThreshold(t, 'KB_TOPIC_MARGIN', first.p - second.p)) {
        return { kind: 'disambiguate', a: { value: first.label, display: display(first.label, ctx.locale) }, b: { value: second.label, display: display(second.label, ctx.locale) } };
      }
    } else {
      if (typeof a.choice === 'string' && isUnanswered(a.choice, probabilities[a.choice] ?? a.confidence)) return unanswered;
      if (nothingAsked(a.choice)) return reask;
      if (typeof a.choice !== 'string' || !fillable(a.choice)) return miss;
      top = { label: a.choice, p: probabilities[a.choice] ?? a.confidence };
    }
    if (!meetsThreshold(t, o.fillAt, top.p)) return miss;
    return { kind: 'filled', value: top.label, display: display(top.label, ctx.locale), confidence: top.p, confirm: 'none' };
  };
}
