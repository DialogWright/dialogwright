import { z } from 'zod';
import { matching } from '../../define/schema/common';
import { questionParts, textParts } from '../parts/text';

/**
 * The text parts of a `name` slot: its two questions (does the caller give their own name, which
 * span of their words is it), the yes-or-no question's two criteria and the span question's "none"
 * label. The defaults are neutral; the first three are the wording a recorded app used, with the
 * one clause that named its own domain taken out. `{slot}` is the slot's id, which the span question
 * names so the model knows which value a correction replaces.
 */
export const NAME_PARTS = textParts('name', {
  given: {
    template: 'Read asr.text. Does the caller state their own name, first name alone or first and last?',
    vars: [],
    about: 'The yes-or-no question that asks whether the caller gives their own name at all.',
  },
  givenTrue: {
    template:
      'The caller gives their own name, as in my name is Anna Petrov, this is Sam, or Priya Raghunathan, including a correction to their own name just read back to them, as in no, it\'s Sam Lee',
    vars: [],
    about: 'What a yes to the first question means (its "true" criterion).',
  },
  givenFalse: {
    template: 'No personal name, or a name that is not the caller\'s, such as the name of someone they are talking about',
    vars: [],
    about: 'What a no to the first question means (its "false" criterion).',
  },
  span: {
    template:
      'Read asr.text. Which of these spans is the caller\'s own full name as they say it, first and last when both are given? Do not include words such as my name is or this is, and do not choose anyone else\'s name. When `slots.{slot}` is already set and the caller gives a different name for themselves, as in no, it\'s Sam Lee, choose that span. A single word can be the whole name, as in Prince. Choose none if no span is the caller\'s name.',
    vars: ['slot'],
    about: 'The question that asks which span of the caller\'s words is their name. Its choices are the word spans the engine finds, less the ones `exclude` withholds, and none.',
  },
  spanNone: {
    template: 'No span of asr.text is the caller\'s name, as when the caller only agrees, refuses, or names something other than themselves',
    vars: [],
    about: 'What the span question\'s "none" choice means.',
  },
});

/** The questions of a `name` slot, by part. */
export const NAME_QUESTIONS = questionParts({
  given: 'whether the caller states their own name',
  span: 'which span of the caller\'s words is their name',
});

/** One word of the `exclude` list: what a span's words are compared with, so letters and digits only. */
const excludedWord = () =>
  matching(
    /^[A-Za-z0-9]+$/,
    'must be a single word of letters and digits, as a span\'s words are',
    'write one word per entry, without spaces or punctuation ("dr", not "Dr." or "dr smith"); list each word of a longer name on its own',
  );

export const nameOptions = z.strictObject({
  exclude: z
    .array(excludedWord())
    .default([])
    .describe(
      'Words that never belong to the caller\'s name: a span holding any of them is not offered to the model, and one answered anyway is refused. For the titles and names of people who are discussed on the call but are not the caller (a doctor, a technician). Compared in lower case, word by word. A caller who shares one of the words cannot give their name by voice, so list only what is needed. Default: none.',
    ),
  redact: z
    .enum(['none', 'mask'])
    .default('none')
    .describe('How the value is masked wherever it leaves the turn (the trace, a tool call\'s param of the same name): "mask" ("•") or "none", kept as it is.'),
  handoff: z
    .enum(['display', 'verified'])
    .default('display')
    .describe('What a transfer to a person hands over: the name as its "display", or only whether the caller was "verified", never the name. app.yaml\'s handoff.data then says whether it goes, and how: by default an identity factor is left out and a redacted value masked.'),
  text: NAME_PARTS.schema,
  ids: NAME_QUESTIONS.schema,
});

export type NameOptions = z.output<typeof nameOptions>;
