import { z } from 'zod';
import { localeTag } from '../../define/schema/common';
import { questionParts, questionText, textParts } from '../parts/text';
import { MAX_PICK_CANDIDATES, MAX_PICK_SPLITS, MIN_TAIL_WORDS } from './pick';

/**
 * The text parts of a `text` slot, as templates over the options: its yes-or-no question, and with
 * `pick` the question that asks which part of the words is the value and the criterion of its
 * `none` label (their `{what}` is `pick.what`).
 */
export const TEXT_PARTS = textParts('text', {
  given: {
    template: 'Read asr.text. Does the caller give {what}? A request alone is not {what}.{instructions}',
    vars: ['what', 'instructions'],
    about: 'The yes-or-no question that asks whether the caller gives the text, word for word.',
  },
  pick: {
    template: 'Read asr.text. Which of these parts of the caller\'s words is the whole of {what}, with nothing else in it?',
    vars: ['what'],
    about: 'With `pick`: the question that asks which of the candidate parts is the value; {what} is pick.what.',
  },
  pickNone: {
    template: 'None of these is {what}',
    vars: ['what'],
    about: 'With `pick`: what the pick question\'s "none" label means, which keeps the whole words; {what} is pick.what.',
  },
});

/** The questions of a `text` slot, by part: `given`, and `pick` with the option. */
export const TEXT_QUESTIONS = questionParts({ given: 'whether the caller gives the text', pick: 'which part of the caller\'s words is the value (with `pick`)' });

/** A joining word or preposition a slot gives for a language: a word or a phrase, on one line. */
const pickWord = () => questionText().regex(/[\p{L}\p{N}]/u, { error: 'must hold a word' });
const pickWordList = (what: string) => z.array(pickWord()).min(1).optional().describe(what);

/** The `pick` option. */
const pickOption = z
  .strictObject({
    what: questionText().describe('What the value is, as a noun phrase the pick question names ("the street address").'),
    words: z
      .record(
        localeTag(),
        z
          .strictObject({
            joiners: pickWordList('Words or phrases that join two clauses, where the words are split ("et", "parce que"). Replaces the built-in list of the language.'),
            prepositions: pickWordList('Words or phrases after which a clause\'s tail is offered too ("au", "près de"). Replaces the built-in list of the language.'),
          })
          .describe('The words of one language: either list left out is the built-in one.'),
      )
      .optional()
      .describe('The joining words and prepositions by language tag ("fr", or "fr-CA" for one region, whose missing list is the language\'s), for a language with no built-in list or to replace one. Built in: English ("and", "but", "so", "because"; "at", "on", "in", "near", "by", "for"), also read with no locale, and Spanish ("y", "e", "pero", "porque", "así que"; "en", "cerca de", "junto a"). A language with neither splits at punctuation only.'),
  })
  .describe(
    `Pick the value out of the words. Code splits the caller's words into candidate parts (clauses, split at punctuation and at joining words, and each clause's tail after a preposition; then two clauses side by side joined as said, and that join's tails; at most ${MAX_PICK_SPLITS} of these; then the tails from each word of a clause or a join to its end, of ${MIN_TAIL_WORDS} words or more, the shortest kept, so a value after any lead-in can be chosen; each verbatim, at most ${MAX_PICK_CANDIDATES} in all), and a second question (\`ids.pick\`, default \`<slot>Pick\`) asks which of them is \`pick.what\`, by letter, or none of these. The value is the part chosen, as said; none, a choice below SLOT_DETECT, or words that make one candidate keep the whole words. Default: off, the value is the whole words and only the one question is asked.`,
  );

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
    pick: pickOption.optional(),
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
    if (o.pick === undefined) {
      for (const [group, part] of [['text', 'pick'], ['text', 'pickNone'], ['ids', 'pick']] as const) {
        if (o[group]?.[part as 'pick'] === undefined) continue;
        ctx.addIssue({
          code: 'custom',
          path: [group, part],
          message: `${group}.${part} is not used without "pick"`,
          params: { fix: `add "pick: { what: ... }", or delete ${group}.${part}` },
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

/**
 * What a locale's slots.yaml may give for a text slot: its stand-in in that locale (`say: su nota`).
 * The words themselves are the caller's, in whatever language they spoke. A slot whose display is
 * the words (`say: null`) has no stand-in to give.
 */
export function textWording(o?: Pick<TextOptions, 'say'>) {
  const say = questionText().describe('The stand-in in this locale: what a line, the console and the model\'s turn state show in place of the words ("su nota").');
  if (o !== undefined && o.say === null) {
    return z.strictObject({}).describe('A text slot whose display is the caller\'s own words (say: null) has no stand-in to give per locale.');
  }
  return z.strictObject({ say: say.optional() }).describe('A text slot\'s wording in this locale.');
}

/** A text slot's wording in one locale, as parsed. */
export interface TextWording {
  say?: string;
}
