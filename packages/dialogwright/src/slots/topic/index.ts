import type { SlotPrompt } from '../../core/slots/types';
import { examplesFrom } from '../parts/examples';
import { readBackOf, readBackPrompts } from '../parts/readBack';
import { defineSlotType } from '../slotType';
import type { SlotType } from '../types';
import { topicDisplay } from './display';
import { topicFill } from './fill';
import { DEFAULT_CAP, topicOptions, type TopicOptions } from './options';
import { topicIdOf, topicQuestions } from './questions';

export {
  topicOptions, TOPIC_PARTS, TOPIC_QUESTIONS, ACCEPT, DEFAULT_CAP, DEFAULT_CRITERION, DEFAULT_MISS_REASON, FILL_AT, MAX_CAP,
} from './options';
export type { TopicOptions } from './options';
export { topicDisplay } from './display';
export { offeredTopics, topicIdOf } from './questions';
export { CRITERION_FILTERS, CRITERION_VARS, renderCriterion } from './criterion';

const examples = examplesFrom(new URL('./examples.yaml', import.meta.url));

/** The lines a topic slot may lead to, beyond ask_<slot> and ask_<slot>_retry. */
function promptsOf(id: string, o: TopicOptions): SlotPrompt[] {
  const disambiguate: SlotPrompt[] = o.disambiguate ? [{ id: `disambiguate_${id}`, why: 'the caller could mean either of two topics and is asked which', vars: ['a', 'b'] }] : [];
  return [...disambiguate, ...readBackPrompts(id, o.confirm ?? 'summary')];
}

/**
 * `topic`: which of the knowledge base's topics the caller asks about. The app's retriever nominates
 * a few topics for the caller's words before the turn is planned (SlotContext.nominated; the slot
 * opts in with `nominates`), and the question offers those alone, so a turn that nominates nothing
 * asks nothing. The slot fills with the topic's id and says it by its title, from the app's topics
 * it is built with (SlotBuildEnv.catalog). See README.md beside this file.
 */
export const topicType: SlotType<TopicOptions> = defineSlotType<TopicOptions>({
  type: 'topic',
  options: topicOptions,
  build(id, o, _wording, env) {
    const catalog = env?.catalog;
    const cap = o.cap ?? catalog?.cap ?? DEFAULT_CAP;
    const questionId = topicIdOf(id, o);
    const display = topicDisplay(catalog);
    return {
      id,
      // Never acknowledged: the final summary reads it back, or, with `confirm: always`, its own read-back.
      ...readBackOf(o.confirm ?? 'summary'),
      nominates: true,
      questionIds: [questionId],
      prompts: promptsOf(id, o),
      thresholds: [o.fillAt],
      questions: topicQuestions(id, o, cap),
      fill: topicFill(o, questionId, cap, catalog, display),
      display,
    };
  },
  get examples() {
    return examples();
  },
  describe: {
    summary: 'Which of the knowledge base\'s topics the caller asks about, from the few retrieval nominates for their words.',
    notes: 'The retriever, not the model, narrows the topics: the question offers only what it nominated on that turn, so a turn with no plausible topic asks nothing and costs nothing. The model chooses one of those or none; the value is always a topic id, never words the model wrote. What the topic answers is the app\'s to resolve and say (an approved passage), not the slot\'s.',
  },
});
