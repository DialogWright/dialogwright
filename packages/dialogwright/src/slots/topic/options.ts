import { z } from 'zod';
import { identifier } from '../../define/schema/common';
import { questionParts, questionText, textParts } from '../parts/text';
import { checkTemplate } from '../parts/template';
import { checkCriterion, CRITERION_FILTERS, CRITERION_VARS } from './criterion';
import { alwaysConfirmText } from '../parts/readBack';

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
  section: {
    // "Would this section answer the caller's question?", the maintainer's decision (2026-10-18): it read
    // as the old "Does this section say what the caller asks about?" at a call's start, and far steadier
    // after a long answer was just read out (the booklet's 152 questions: 121 right where the old read 73;
    // the handbook's 88 after a coverage answer: 82 where it read 70), with no more wrong sections.
    template: "Read asr.text. Would this section of the {document} answer the caller's question? {heading}: {text}",
    vars: ['document', 'heading', 'text'],
    about: 'With answers from documents (kb.yaml documents), the yes-or-no asked of each nominated section beside the topic question: {document} is its document\'s title, {heading} its heading, {text} its text. Unlike the other parts, an app\'s own wording is a template over the same three, filled for each section, so it shows the model the section: write {heading}: {text} where the section goes.',
  },
  sectionEarlier: {
    template: "Read asr.text and earlierQuestion, the caller's earlier question on this call. Would this section of the {document} answer the caller's question, read with their earlier one where it continues it? {heading}: {text}",
    vars: ['document', 'heading', 'text'],
    about: 'With follow-ups (kb.yaml documents.followUps) and an earlier question on the call, the yes-or-no asked of each nominated section in place of `section`: the same, read with the caller\'s earlier question (the turn state\'s earlierQuestion). A template over {document}, {heading} and {text}, as `section` is.',
  },
  sectionScore: {
    template: 'Read asr.text. How much of what the caller asks does this section of the {document} answer? {heading}: {text}',
    vars: ['document', 'heading', 'text'],
    about: 'With `sections: { ask: score }`, the score asked of each nominated section in place of the yes-or-no (`section`): how much of what the caller asks it answers, by the levels below. A template over {document}, {heading} and {text}, as `section` is.',
  },
  sectionNone: { template: 'Says nothing about what the caller asks', vars: [], about: 'The score\'s lowest level, `none`.' },
  sectionLittle: { template: 'Is about the same thing but does not answer what the caller asks', vars: [], about: 'The score\'s level `little`.' },
  sectionPartly: { template: 'Answers part of what the caller asks', vars: [], about: 'The score\'s level `partly`.' },
  sectionMostly: { template: 'Answers what the caller asks, but for a detail', vars: [], about: 'The score\'s level `mostly`.' },
  sectionCompletely: { template: 'Answers everything the caller asks', vars: [], about: 'The score\'s highest level, `completely`.' },
  unanswered: {
    template: 'Asks about something none of these answers',
    vars: [],
    about: 'What the question\'s "unanswered" label means, with `unanswered: retry`: the caller asks a question none of the topics offered answers.',
  },
});

/**
 * With `unanswered: retry`, the question's instructions and its `none` label where `text` gives none:
 * none is a turn that asks nothing, and a question asked that no topic answers is `unanswered`.
 */
export const UNANSWERED_DEFAULTS = {
  instructions: 'Read asr.text. Which of these topics does the caller ask about? Choose unanswered when they ask about something none of them answers, and none when they say nothing about what they want to know (saying only that they have a question is none).',
  none: 'Says nothing about what they want to know',
} as const;

/** What a question that no topic answers leads to, said on a turn the slot was not asked: its miss line, or its question as before. */
export const UNANSWERED = ['retry', 'ask'] as const;

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
    unanswered: z
      .enum(UNANSWERED)
      .default('retry')
      .describe('What a question no topic answers leads to when the slot was not asked for (the turn that asks it opens the form, say). `retry` (the default, the maintainer\'s decision of 2026-10-17): the question has an `unanswered` label beside `none`, and a question read as unanswered is the slot\'s miss: when the form comes to the slot (at once, or after the identity it needs) the caller hears `ask_<slot>_retry` (which says nothing answers that, and what can be asked) and an attempt is counted, rather than the question as if nothing had been asked. `ask`: no such label, and the slot\'s question is asked, as before.'),
    sections: z
      .strictObject({
        ask: z.enum(['yes-no', 'score']).default('yes-no').describe('How each nominated section of an approved document is asked of: `yes-no` (the default), whether it says what the caller asks about; `score`, how much of what the caller asks it answers (none, little, partly, mostly, completely), so a section that is only about the same thing is told from one that answers it.'),
        from: z.enum(['partly', 'mostly', 'completely']).default('mostly').describe('With `ask: score`, the level from which a section answers: the probability the model gives it of this level or above is held to KB_SECTION_ANSWERS. Default mostly.'),
      })
      .default({ ask: 'yes-no', from: 'mostly' })
      .describe('With answers from documents (kb.yaml documents): how the slot asks whether each nominated section answers the caller.'),
    notFound: z
      .strictObject({
        counts: z.boolean({ error: 'must be true or false' }).default(false).describe('Whether a question nothing answers counts as a try on the slot\'s ladder (attempts, onMaxAttempts). false (the default, the maintainer\'s decision of 2026-10-17): the knowledge base lacked it, the caller did not fail, so they may ask as often as they like; true: three in a row (attempts) end as any slot\'s misses do. A turn that says nothing about what the caller wants (none) counts either way.'),
        remind: z.int({ error: 'must be a whole number' }).min(1, { error: 'must be at least 1' }).max(10, { error: 'must be at most 10' }).default(2).describe('After how many not-found replies in a row without it the guide to what can be asked (kb_guide) is said again; it is said the first time a call hears one. Default 2.'),
      })
      .default({ counts: false, remind: 2 })
      .describe('With `unanswered: retry`, the reply to a question none of the topics (or the sections of approved documents) answers: where the app has kb_not_found, that line in turn through its variants, then kb_guide where it is due, then the slot\'s question; else the slot\'s retry line, as before.'),
    confirm: z
      .enum(['summary', 'always'])
      .optional()
      .describe(`"summary" (the default): a topic is neither acknowledged nor read back on its own; the form's final confirm covers it. ${alwaysConfirmText('the topic', false)}`),
    text: TOPIC_PARTS.schema,
    ids: TOPIC_QUESTIONS.schema.describe('Question ids in place of the default: `ids.choice` is the question\'s id (default: the slot\'s id followed by "Topic"), to keep the id an existing slot used.'),
  })
  .superRefine((o, ctx) => {
    for (const part of ['section', 'sectionScore'] as const) {
      const template = o.text?.[part];
      if (template === undefined) continue;
      try {
        checkTemplate(template, TOPIC_PARTS.defs[part].vars, `text.${part}`);
      } catch (e) {
        ctx.addIssue({ code: 'custom', path: ['text', part], message: (e as Error).message, params: { fix: 'write {document}, {heading} and {text} where the document\'s title, the section\'s heading and its text go, and no other {name}' } });
      }
    }
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

/** A section score's levels, lowest first, as the question names them. */
export const SECTION_LEVELS = ['none', 'little', 'partly', 'mostly', 'completely'] as const;
