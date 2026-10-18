import type { SlotContext } from '../../core/slots/types';
import type { QuestionMap } from '../../jev/types';
import type { Nomination } from '../../kb/types';
import { renderTemplate } from '../parts/template';
import { renderCriterion } from './criterion';
import { TOPIC_PARTS, UNANSWERED_DEFAULTS, type TopicOptions } from './options';

/** A section score's levels and the text part that says what each means. */
const SECTION_LEVEL_PARTS = [['none', 'sectionNone'], ['little', 'sectionLittle'], ['partly', 'sectionPartly'], ['mostly', 'sectionMostly'], ['completely', 'sectionCompletely']] as const;

/** The id of the yes-or-no asked of a topic slot's `i`th nominated section (from 0): the slot's id, `Section` and its rank from 1. */
export const sectionQuestionIdOf = (slot: string, i: number): string => `${slot}Section${i + 1}`;

export { SECTIONS_VALUE_PREFIX, sectionKeysOf } from '../../kb/sectionTexts';

/** The id of a topic slot's question: the slot's id followed by `Topic`, unless `ids.choice` says otherwise. */
export const topicIdOf = (slot: string, o: Pick<TopicOptions, 'ids'>): string => o.ids?.choice ?? `${slot}Topic`;

/**
 * The topics the question offers: the nominated ones (SlotContext.nominated), best first as the
 * retriever gave them, each once, at most `cap`. A topic whose id is `none` or `unanswered` would be
 * one of the question's own labels, so it is never offered.
 */
export function offeredTopics(nominated: readonly Nomination[] | undefined, cap: number): Nomination[] {
  const seen = new Set<string>();
  const out: Nomination[] = [];
  for (const n of nominated ?? []) {
    if (out.length >= cap) break;
    if (n.topic === 'none' || n.topic === 'unanswered' || seen.has(n.topic)) continue;
    seen.add(n.topic);
    out.push(n);
  }
  return out;
}

/**
 * A topic slot's one question: which of the nominated topics does the caller ask about? Each label is
 * a topic's id, its criterion rendered from `criterion` with the title the retriever gave, then
 * `unanswered` (with `unanswered: retry`, the default: a question asked that none of them answers)
 * and `none`. With nothing nominated (no retrieval this turn, or nothing found) the slot asks nothing, so
 * a turn with no plausible topic costs nothing.
 */
export function topicQuestions(slot: string, o: TopicOptions, cap: number): (ctx: SlotContext) => QuestionMap {
  const id = topicIdOf(slot, o);
  const retry = o.unanswered === 'retry';
  const instructions = retry && o.text?.instructions === undefined ? UNANSWERED_DEFAULTS.instructions : TOPIC_PARTS.render('instructions', o.text, {});
  const none = retry && o.text?.none === undefined ? UNANSWERED_DEFAULTS.none : TOPIC_PARTS.render('none', o.text, {});
  const unanswered = TOPIC_PARTS.render('unanswered', o.text, {});
  return (ctx) => {
    const offered = offeredTopics(ctx.nominated, cap);
    const sections = retry ? (ctx.sections ?? []) : [];
    if (offered.length === 0 && sections.length === 0) return {};
    const questions: QuestionMap = {};
    // The sections of approved documents nominated beside the topics (kb.yaml documents): whether each
    // says what the caller asked, so a question no topic answers may be answered from them.
    sections.forEach((s, i) => {
      // The app's own wording (text.section) is a template too, unlike the type's other parts: the
      // question differs by section, and words taken as they are would show the model no section.
      const vars = { document: s.documentTitle, heading: s.heading, text: s.text };
      if (o.sections.ask === 'score') {
        const template = o.text?.sectionScore ?? TOPIC_PARTS.defs.sectionScore.template;
        questions[sectionQuestionIdOf(slot, i)] = { type: 'score', instructions: renderTemplate(template, vars, `the topic slot ${slot}'s text.sectionScore`), levels: SECTION_LEVEL_PARTS.map(([label, part]) => ({ label, description: TOPIC_PARTS.render(part, o.text, {}) })) };
        return;
      }
      const template = o.text?.section ?? TOPIC_PARTS.defs.section.template;
      questions[sectionQuestionIdOf(slot, i)] = { type: 'noul', instructions: renderTemplate(template, vars, `the topic slot ${slot}'s text.section`) };
    });
    // With sections and no topic offered (an app that answers from documents alone), the question is
    // still asked, with its two labels: whether the caller asked something none of them answers, or
    // asked nothing, so a question nothing answers hears the not-found reply.
    const criteria: Record<string, string> = {};
    for (const n of offered) criteria[n.topic] = renderCriterion(o.criterion, { title: n.title, topic: n.topic });
    if (retry) criteria.unanswered = unanswered;
    criteria.none = none;
    return { [id]: { type: 'choice', instructions, criteria }, ...questions };
  };
}
