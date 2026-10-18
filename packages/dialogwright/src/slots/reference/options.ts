import { z } from 'zod';
import { questionParts, questionText, textParts } from '../parts/text';
import { alwaysConfirmText } from '../parts/readBack';

/**
 * The text parts of a `reference` slot: its two questions and the span question's "none" label, as
 * templates over `{article}` ("a", "an") and `{noun}` ("booking code", "order reference").
 */
export const REFERENCE_PARTS = textParts('reference', {
  given: {
    // Measured with the decision model, 2026-10-18 (five asks each): a code typed whole read 0.42 to 0.51
    // under the earlier wording ("...typed or spoken one at a time, by letter names..."), 0.89 to 0.96
    // under this one; words that give no code stayed at or under 0.12.
    template: 'Read asr.text. Does the caller state {article} {noun} (letters and numbers, written together or spelled out)?',
    vars: ['article', 'noun'],
    about: 'The yes-or-no question that asks whether the caller states the reference at all.',
  },
  span: {
    template: 'Read asr.text. Which of these spans is the {noun} the caller states? Choose the span that covers the whole of it as said, and nothing else. Choose none if no span is {article} {noun}.',
    vars: ['article', 'noun'],
    about: 'The question that asks which span of the caller\'s words is the reference. Its choices are the spans the engine reads as one, and none.',
  },
  none: {
    template: 'No span of asr.text is {article} {noun}',
    vars: ['article', 'noun'],
    about: 'What the span question\'s "none" choice means.',
  },
});

/** The questions of a `reference` slot, by part. */
export const REFERENCE_QUESTIONS = questionParts({
  given: 'whether the caller states the reference',
  span: 'which span of the caller\'s words is the reference',
});

/** Every letter and digit: a reference's characters unless `alphabet` says. */
export const DEFAULT_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** The longest reference a slot may take. */
export const MAX_REFERENCE_LENGTH = 20;

export const referenceOptions = z
  .strictObject({
    noun: questionText()
      .optional()
      .describe('What the reference is, as a noun ("booking code", "order reference"). The default questions say "a <noun>". Needed unless text gives every question in its own words.'),
    article: questionText()
      .optional()
      .describe('The word before the noun in the default questions. Default: "an" when the noun starts with a vowel, otherwise "a".'),
    length: z.number().int().min(1).max(MAX_REFERENCE_LENGTH).describe('How many characters the reference has.'),
    alphabet: z
      .string()
      .regex(/^[A-Z0-9]+$/, 'alphabet is capital letters and digits only, such as "ABCDEFGHJKMNPQRSTUVWXYZ23456789"')
      .default(DEFAULT_ALPHABET)
      .describe('The characters a reference may hold, capital letters and digits. Where it leaves out one of a pair that sound or look alike (O and 0, I and 1), a word said for either is read as the one it holds ("oh" is 0 when it has no O). Default: every letter and digit.'),
    confirm: z
      .enum(['summary', 'always'])
      .default('summary')
      .describe(`"summary": the reference is neither acknowledged nor read back on its own; the form's final confirm covers it. ${alwaysConfirmText('a reference')}`),
    redact: z
      .enum(['last4', 'length', 'none'])
      .default('length')
      .describe('How the value is masked wherever it leaves the turn (the trace, the console, the audit, a tool call\'s param of the same name): "length" (only how many characters, "<6 chars>": a short reference\'s last four would show most of it), "last4" ("...4QX7") or "none".'),
    handoff: z
      .enum(['last4', 'verified', 'display'])
      .default('display')
      .describe('What a transfer to a person hands over: its "display" in full, its "last4", or only whether the caller was "verified". app.yaml\'s handoff.data then says whether it goes, and how: by default an identity factor is left out and a redacted value masked.'),
    text: REFERENCE_PARTS.schema,
    ids: REFERENCE_QUESTIONS.schema,
  })
  .superRefine((o, ctx) => {
    const literal = REFERENCE_PARTS.names.every((part) => o.text?.[part] !== undefined);
    if (!literal && o.noun === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [],
        message: 'a reference slot needs "noun" (what the reference is, which the default questions name) or text for each of given, span and none',
        params: { fix: 'add "noun:" with a word or two, such as "booking code"' },
      });
    }
    if (new Set(o.alphabet).size !== o.alphabet.length) {
      ctx.addIssue({ code: 'custom', path: ['alphabet'], message: 'alphabet names a character twice', params: { fix: 'write each character once' } });
    }
  });

export type ReferenceOptions = z.output<typeof referenceOptions>;
