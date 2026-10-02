import { z } from 'zod';
import { questionParts, questionText, textParts } from '../parts/text';

/** The text parts of a `text` slot: its one question, as a template over the options. */
export const TEXT_PARTS = textParts('text', {
  given: {
    template: 'Read asr.text. Does the caller give {what}? A request alone is not {what}.{instructions}',
    vars: ['what', 'instructions'],
    about: 'The yes-or-no question that asks whether the caller gives the text, word for word.',
  },
});

/** The questions of a `text` slot, by part. */
export const TEXT_QUESTIONS = questionParts({ given: 'whether the caller gives the text' });

/** The most of the caller's words a text slot keeps, unless maxLength says otherwise. */
export const DEFAULT_MAX_LENGTH = 500;
/** What a line says in place of the words, unless `say` says otherwise. */
export const DEFAULT_SAY = 'your description';

export const textOptions = z
  .strictObject({
    what: questionText()
      .optional()
      .describe('What the caller gives, as a noun phrase the default question names ("a description of the problem"). Needed unless text.given gives the question in its own words.'),
    instructions: questionText()
      .optional()
      .describe('More guidance for the model, added after the default question ("Count it even when it comes with a request.").'),
    maxLength: z.number().int().min(1).default(DEFAULT_MAX_LENGTH).describe('The most characters of the caller\'s words the value keeps; the rest is cut off.'),
    say: questionText()
      .nullable()
      .default(DEFAULT_SAY)
      .describe('The display: what a line, the console and the model\'s turn state show in place of the words ("your note"). null: the words themselves.'),
    keep: z
      .enum(['first', 'first-unless-prompted'])
      .default('first-unless-prompted')
      .describe('When a value is on file: "first-unless-prompted" replaces it only when the slot was just asked for; "first" never does. A correction at the summary replaces it either way.'),
    redact: z
      .enum(['length', 'none'])
      .default('length')
      .describe('"length": the words leave the turn (the trace, a tool call\'s param) as their length only, and the display is kept. "none": as they are.'),
    text: TEXT_PARTS.schema,
    ids: TEXT_QUESTIONS.schema,
  })
  .superRefine((o, ctx) => {
    const literal = o.text?.given !== undefined;
    if (!literal && o.what === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [],
        message: 'a text slot needs "what" (what the caller gives, which the default question names) or text.given (the question in its own words)',
        params: { fix: 'add "what:" with a noun phrase, such as "a note for the courier"' },
      });
    }
    for (const key of ['what', 'instructions'] as const) {
      if (literal && o[key] !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `"${key}" is not used, since text.given replaces the whole question`,
          params: { fix: `delete "${key}", or write its words into text.given` },
        });
      }
    }
    if (o.say === null && o.redact === 'length') {
      ctx.addIssue({
        code: 'custom',
        path: ['say'],
        message: 'say is null, so the display is the caller\'s words, which redact: length keeps out of the trace',
        params: { fix: 'give "say" a stand-in such as "your note", or set redact: none' },
      });
    }
  });

export type TextOptions = z.output<typeof textOptions>;
