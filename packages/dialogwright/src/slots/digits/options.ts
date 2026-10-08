import { z } from 'zod';
import { repeatsARepeat } from '../parts/pattern';
import { identifier } from '../../define/schema/common';
import { questionParts, questionText, textParts } from '../parts/text';
import { alwaysConfirmText } from '../parts/readBack';

/**
 * The text parts of a `digits` slot: its three questions and the span question's "none" label, as
 * templates over `{article}` ("a", "an") and `{noun}` ("account", "library card"). The wording is a
 * known-good one: the wording an identifier slot was recorded with, with its noun taken out.
 */
export const DIGITS_PARTS = textParts('digits', {
  given: {
    template: 'Read asr.text. Does the caller state {article} {noun} number, either as digits or as spoken number words?',
    vars: ['article', 'noun'],
    about: 'The yes-or-no question that asks whether the caller states the number at all.',
  },
  span: {
    template:
      'Read asr.text. Which of these spans is the {noun} the caller states? Choose the span that covers the whole number as spoken, including number words like forty-four or three hundred fifty-five and modifiers like double or triple. Do not include words that are not part of the number. Choose none if no span is {article} {noun}.',
    vars: ['article', 'noun'],
    about: 'The question that asks which span of the caller\'s words is the number. Its choices are the spans the engine finds, and none.',
  },
  none: {
    template: 'No span of asr.text is {article} {noun}',
    vars: ['article', 'noun'],
    about: 'What the span question\'s "none" choice means.',
  },
  complete: {
    template: 'Read asr.text. If the caller states {article} {noun}, do they finish saying the whole number rather than trailing off?',
    vars: ['article', 'noun'],
    about: 'The yes-or-no question that asks whether the caller said the whole number.',
  },
});

/** The questions of a `digits` slot, by part. */
export const DIGITS_QUESTIONS = questionParts({
  given: 'whether the caller states the number',
  span: 'which span of the caller\'s words is the number',
  complete: 'whether the caller said the whole number',
});

/** The thresholds a `minConfidence` may name, and `none` for no floor. */
export const MIN_CONFIDENCE = ['none', 'SLOT_DETECT', 'SLOT_CHOICE_CONFIRM', 'SLOT_CHOICE_FILL'] as const;

const validMask = (source: string): boolean => {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
};

export const digitsOptions = z
  .strictObject({
    noun: questionText()
      .optional()
      .describe('What the number identifies, as a noun without "number" ("account", "library card", "parcel tracking"). The default questions say "a <noun> number". Needed unless text gives every question in its own words.'),
    article: questionText()
      .optional()
      .describe('The word before the noun in the default questions. Default: "an" when the noun starts with a vowel, otherwise "a".'),
    length: z.number().int().min(1).max(40).optional().describe('How many digits the number has. Gives the default mask (exactly this many digits) and the length of the keypad rung. Needed unless mask is given.'),
    mask: z
      .string()
      .min(1)
      .optional()
      .describe('A regular expression (its source, no slashes) the whole of the digits must match: it is anchored at both ends, so "5\\d{7}" and "^5\\d{7}$" both mean eight digits starting with 5. With `length` too, the digits must also be that many. Default: exactly `length` digits. A number that fails it is "invalid" with the reason "mask" (with only `length`, the reason is "length"). A group that repeats a repeat, such as (\\d+)+, is refused.'),
    keypad: z.boolean().default(false).describe('Whether the caller can key the number on the keypad, `length` digits at a time. Needs `length`, and an ask_<slot>_dtmf line.'),
    group: z
      .array(z.number().int().min(1))
      .min(1)
      .optional()
      .describe('How the number is said back, in groups of these sizes ([4, 4]: "5550 7788"). The last group takes any digits left over. Default: all digits together.'),
    confirm: z
      .enum(['summary', 'by-confidence', 'always'])
      .default('summary')
      .describe(`"summary": a spoken number is neither acknowledged nor read back on its own; the form's final confirm covers it. "by-confidence": it is acknowledged (ack_<slot>) when \`readBack\` says so. ${alwaysConfirmText('a spoken number')}`),
    readBack: z
      .enum(['implicit', 'below-fill', 'none'])
      .default('implicit')
      .describe('What a filled number asks for: "implicit" (always), "below-fill" (only when the model is less sure of the span than SLOT_CHOICE_FILL), "none" (never). With `confirm: by-confidence`, "implicit" is what makes ack_<slot> be said.'),
    minConfidence: z
      .enum(MIN_CONFIDENCE)
      .default('none')
      .describe('A floor on how sure the model must be of the span: below this threshold the number is "invalid" (reason "low_confidence"). "none": no floor.'),
    lengthRetryPromptId: identifier()
      .optional()
      .describe('The prompt that re-asks, in place of the generic ask_<slot>_retry, when what the caller said is not a number of the right shape ("A card number has eight digits.").'),
    redact: z.enum(['last4', 'none']).default('last4').describe('How the value is masked wherever it leaves the turn (the trace, a tool call\'s param of the same name): "last4" ("...0417") or "none".'),
    callerNumber: z
      .strictObject({
        countryCode: z
          .string()
          .regex(/^\d{1,3}$/, 'countryCode is one to three digits, such as "1"')
          .describe('The country calling code the carrier writes before the number ("1" for +1). A number in international form (+15555550142, as carriers send it) must begin with it, and it is taken off; one from any other country is no number for the slot. A number with no + has it taken off when what is left has the slot\'s `length`.'),
        onNo: z
          .enum(['ask', 'skip'])
          .default('ask')
          .describe('What a no to the offer does: "ask" (default) asks ask_<slot>, with no attempt counted; "skip" leaves the slot empty and the form goes on (an offer to text, say, where a no means no text). The end of the offer\'s retry ladder (no answer) does the same. A number said with the no fills the slot as said either way.'),
        ifNone: z
          .enum(['ask', 'skip'])
          .default('ask')
          .describe('What a call with no number to offer does (a chat, a withheld number, one that does not fit, or one the app\'s callerOffer hook refuses): "ask" (default) asks ask_<slot> as always; "skip" leaves the slot empty and the form goes on.'),
      })
      .optional()
      .describe('Offer the number the caller is calling from: when the form would ask this slot and the call has a number that fits it (its `countryCode`, `length` and `mask`), the line asks offer_<slot> ("Is the number you\'re calling from, ending in {last4}, the best one to reach you?") in place of ask_<slot>, and a yes fills the slot with that number. A no asks ask_<slot>, with no attempt counted, and a number said instead fills as said. A chat, or a call with the number withheld, is asked ask_<slot> as always. Never on an identity factor: a caller ID can be forged.'),
    handoff: z
      .enum(['last4', 'verified', 'display'])
      .default('last4')
      .describe('What a transfer to a person hands over: its "last4", only whether the caller was "verified", or its "display" in full. app.yaml\'s handoff.data then says whether it goes, and how: by default an identity factor is left out and a redacted value masked.'),
    text: DIGITS_PARTS.schema,
    ids: DIGITS_QUESTIONS.schema,
  })
  .superRefine((o, ctx) => {
    const literal = DIGITS_PARTS.names.every((part) => o.text?.[part] !== undefined);
    if (!literal && o.noun === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [],
        message: 'a digits slot needs "noun" (what the number identifies, which the default questions name) or text for each of given, span, none and complete',
        params: { fix: 'add "noun:" with a word or two, such as "account" or "library card"' },
      });
    }
    for (const key of ['noun', 'article'] as const) {
      if (literal && o[key] !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `"${key}" is not used, since text gives every question in its own words`,
          params: { fix: `delete "${key}", or write its words into the text` },
        });
      }
    }
    if (o.length === undefined && o.mask === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [],
        message: 'a digits slot needs "length" (how many digits) or "mask" (a pattern the digits must match)',
        params: { fix: 'add "length:" with a number such as 8' },
      });
    }
    if (o.mask !== undefined && !validMask(o.mask)) {
      ctx.addIssue({
        code: 'custom',
        path: ['mask'],
        message: `"mask" is not a regular expression: ${JSON.stringify(o.mask)}`,
        params: { fix: 'write the pattern\'s source without slashes, such as "^\\d{8}$"' },
      });
    }
    if (o.mask !== undefined && validMask(o.mask) && repeatsARepeat(o.mask)) {
      ctx.addIssue({
        code: 'custom',
        path: ['mask'],
        message: `"mask" repeats a group that itself repeats (as (\\d+)+ does), which can take minutes to refuse a number that almost matches: ${JSON.stringify(o.mask)}`,
        params: { fix: 'write it without the repeat inside the repeat, such as "\\d+5" for "(\\d+)+5"' },
      });
    }
    if (o.keypad && o.length === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['keypad'],
        message: 'keypad is true, but the keypad needs to know how many digits to wait for',
        params: { fix: 'add "length:" with the number of digits' },
      });
    }
    if (o.group !== undefined && o.length !== undefined) {
      const sum = o.group.reduce((a, b) => a + b, 0);
      if (sum !== o.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['group'],
          message: `group adds up to ${sum} digits, but length is ${o.length}`,
          params: { fix: `change the groups so they add up to ${o.length}` },
        });
      }
    }
    if (o.readBack !== 'implicit' && o.confirm === 'summary') {
      ctx.addIssue({
        code: 'custom',
        path: ['readBack'],
        message: `readBack "${o.readBack}" has no effect with confirm "summary", which neither acknowledges nor reads back a spoken number`,
        params: { fix: 'set confirm: by-confidence, or delete readBack' },
      });
    }
    if (o.readBack !== 'implicit' && o.confirm === 'always') {
      ctx.addIssue({
        code: 'custom',
        path: ['readBack'],
        message: `readBack "${o.readBack}" has no effect with confirm "always", which reads every spoken number back for a yes`,
        params: { fix: 'set confirm: by-confidence, or delete readBack' },
      });
    }
  });

export type DigitsOptions = z.output<typeof digitsOptions>;
