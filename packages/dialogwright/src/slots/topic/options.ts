import { z } from 'zod';
import { identifier } from '../../define/schema/common';
import { questionParts, questionText, textParts } from '../parts/text';
import { checkCriterion, CRITERION_FILTERS, CRITERION_VARS } from './criterion';

/**
 * The text parts of a `topic` slot: its one question and the criterion of its `none` label. Each
 * nominated topic's criterion is a template over the topic (`criterion`), an option of its own.
 */
export const TOPIC_PARTS = textParts('topic', {
  instructions: {
    template: 'Read asr.text. Which of these topics does the caller ask about? Choose none when they ask about none of them, or ask nothing.',
    vars: [],
    about: 'The question that asks which topic the caller asks about, sent to the model in place of the default.',
  },
  none: {
    template: 'Asks about none of these',
    vars: [],
    about: 'What the question\'s "none" label means: the caller asks about none of the topics offered.',
  },
});

/** The question of a `topic` slot: the slot's id followed by `Topic`, unless `ids.choice` says otherwise. */
export const TOPIC_QUESTIONS = questionParts({ choice: 'which topic the caller asks about' });

/** What each nominated topic's criterion says, unless `criterion` says otherwise. */
export const DEFAULT_CRITERION = 'Asks about {title|lower}';
/** How many nominated topics the question offers when neither `cap` nor the knowledge base says. */
export const DEFAULT_CAP = 8;
/** The most topics `cap` may offer. */
export const MAX_CAP = 20;
/** The invalid outcome's reason when the slot was asked for and no topic was chosen, unless `missReason` says otherwise. */
export const DEFAULT_MISS_REASON = 'no_topic';
/** The thresholds `fillAt` may name: how sure the model must be of its choice. */
export const FILL_AT = ['SLOT_CHOICE_FILL', 'SLOT_CHOICE_CONFIRM'] as const;
/** What the slot fills with: only a topic the question offered, or any topic the app's knowledge has. */
export const ACCEPT = ['nominated', 'catalog'] as const;

export const topicOptions = z
  .strictObject({
    criterion: questionText()
      .default(DEFAULT_CRITERION)
      .describe(
        `The criterion the model is given for each nominated topic. A template: {title} is the topic's title, {topic} its id, and {title|lower} the title in lower case. Nothing else is evaluated.`,
      ),
    cap: z
      .number()
      .int()
      .min(1)
      .max(MAX_CAP)
      .optional()
      .describe(`How many of the nominated topics the question offers, best first. Default: the knowledge base's retrieval cap (kb.yaml retrieval.cap), else ${DEFAULT_CAP}.`),
    accept: z
      .enum(ACCEPT)
      .default('nominated')
      .describe('What the slot fills with: `nominated`, only a topic the question offered on that turn; `catalog`, any topic the app\'s knowledge has (a recorded answer given against another turn\'s nominations can name one this turn did not offer).'),
    disambiguate: z
      .boolean()
      .default(true)
      .describe('Whether two topics the model cannot tell apart (the top two both topics the slot may fill, the top at SLOT_CHOICE_CONFIRM or above and the second within KB_TOPIC_MARGIN of it) make the slot ask which one (disambiguate_<slot>, with {a} and {b}). Off: the slot reads the model\'s pick alone.'),
    fillAt: z
      .enum(FILL_AT)
      .default('SLOT_CHOICE_FILL')
      .describe('The threshold the model\'s probability for the topic must reach for the slot to fill.'),
    missReason: identifier()
      .default(DEFAULT_MISS_REASON)
      .describe('The reason of the invalid outcome when the slot was asked for and the caller chose no topic (or the model was not sure enough). Not asked for, that is absent.'),
    text: TOPIC_PARTS.schema,
    ids: TOPIC_QUESTIONS.schema.describe('Question ids in place of the default: `ids.choice` is the question\'s id (default: the slot\'s id followed by "Topic"), to keep the id an existing slot used.'),
  })
  .superRefine((o, ctx) => {
    for (const problem of checkCriterion(o.criterion)) {
      ctx.addIssue({
        code: 'custom',
        path: ['criterion'],
        message: problem,
        params: { fix: `use ${CRITERION_VARS.map((v) => `{${v}}`).join(' or ')}, with or without a filter; the filters are ${Object.keys(CRITERION_FILTERS).join(', ')}` },
      });
    }
  });

export type TopicOptions = z.output<typeof topicOptions>;
