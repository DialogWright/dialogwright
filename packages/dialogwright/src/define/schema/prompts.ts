import { z } from 'zod';
import { identifier, text, unique } from './common';

/**
 * prompts.yaml: every line the agent says. Mirrors App.prompts.manifest. One file per locale:
 * prompts.yaml for the app's default locale, locale/<tag>/prompts.yaml for another.
 *
 * Every line is said word for word unless the app asks for it to be generated (generated wording,
 * design section 5): `mode: generative` on the line, or a form's `wording: generative` for the lines of
 * that form. A generated line is worded by a model for the moment, held to the fixed line's meaning
 * and data by checks, and the fixed `text` is said whenever a check fails or the model is slow. What
 * is regulated is the app designer's call: `prescribed: true` keeps a line word for word whatever a
 * form says, and `pnpm check` refuses `mode: generative` on it.
 */

/** The situations a generated line may be limited to (`when.situations`). */
export const RENDER_SITUATIONS = ['first-ask', 're-ask', 'after-correction', 'frustrated'] as const;
export type RenderSituation = (typeof RENDER_SITUATIONS)[number];

/** The channels a generated line may be limited to (`when.channels`). */
export const RENDER_CHANNELS = ['voice', 'chat'] as const;
export type RenderChannel = (typeof RENDER_CHANNELS)[number];

const when = z
  .strictObject({
    situations: unique(z.enum(RENDER_SITUATIONS), 'situation')
      .min(1, { error: 'must name at least one situation' })
      .optional()
      .describe(
        'The situations the line is generated in; in any other it is said word for word. first-ask: the line has not been said before on this call; re-ask: it has (asked again after a miss, a no or a change); ' +
          'after-correction: this turn the caller changed a value they had given, or said no to a read-back; frustrated: the caller has been frustrated on this call. Absent: every situation.',
      ),
    channels: unique(z.enum(RENDER_CHANNELS), 'channel')
      .min(1, { error: 'must name at least one channel' })
      .optional()
      .describe('The channels the line is generated on (voice: a call; chat: a web chat); on another it is said word for word. Absent: both.'),
  })
  .describe('Where a generated line is generated; everywhere else its fixed text is said. Both parts must hold.');

/** The most words a generated span may use when it does not say (a framed line's `generate.<span>.words`). */
export const DEFAULT_SPAN_WORDS = 25;

/** Whose person a framed line's span speaks in (`generate.<span>.speaks`): the caller's own (the default), or to the caller. */
export const SPAN_PERSPECTIVES = ['as-caller', 'to-caller'] as const;
export type SpanPerspective = (typeof SPAN_PERSPECTIVES)[number];

const span = z
  .strictObject({
    from: identifier()
      .optional()
      .describe(
        'The slot whose content the span is worded from (the message, the note): the caller\'s words, collected. The model is sent only this content, quoted, with the span\'s goal; the exact content is what is stored, and it fills the span word for word whenever the span is not generated or a check fails. Required in prompts.yaml; a locale gives a span only its goal.',
      ),
    goal: text().describe('What the span must say, for the model that words it ("Summarize the caller\'s message in one sentence, in their own terms."). In a locale\'s prompts.yaml: the span is generated in that locale only where its goal is given there.'),
    words: z
      .int({ error: 'must be a whole number' })
      .min(3, { error: 'must be at least 3' })
      .max(100, { error: 'must be at most 100' })
      .optional()
      .describe(`The most words the span may use; a longer one is not said (the exact content is). Default ${DEFAULT_SPAN_WORDS}.`),
    speaks: z
      .enum(SPAN_PERSPECTIVES)
      .optional()
      .describe(
        'Whose person the span speaks in. as-caller (the default): in the caller\'s own terms, as they said it ("call me back"), under a frame that gives their words ("{caller} left this message: {summary}"). ' +
          'to-caller: to the caller, about their own message, as a receptionist reads one back: their I, me, my, we and our said as you and your ("call you back"), and a name the span lists in `names` (who the message is for, {recipient}) put in place of a pronoun only where the message makes clear who is meant; under a frame that speaks to them ("{recipient} gets your message, in short: {summary}"), never one that says they "said" it. ' +
          'English only for now: in another language the span is worded as-caller. Read from prompts.yaml, for every locale.',
      ),
    names: unique(identifier(), 'variable')
      .min(1, { error: 'must name at least one variable' })
      .optional()
      .describe(
        'A to-caller span only (`speaks: to-caller`): the line\'s variables whose value the span may say in place of a pronoun of the message, where the message makes clear who is meant: each a `choice` slot of the line (who the message is for, as said, such as [recipient]). ' +
          'They are screened as the content is, sent to the model and to the drift check, and the only names the checks let the span say beside the content\'s. Never a `name` slot (the caller\'s own name is never put for a pronoun), an identity factor, a slot with a redact setting, or a choice whose options say a digit: `pnpm check` refuses each. Read from prompts.yaml, for every locale.',
      ),
  })
  .describe('One generated span of a fixed line.');

const prompt = z
  .strictObject({
    text: text().describe('The words said. Variables go in braces ({first}); the engine fills them. Said exactly as written unless the line is generated, and then the fallback and the meaning a generated wording is held to.'),
    interruptible: z.boolean({ error: 'must be true or false' }).describe('Whether the caller may talk over the line (barge-in). false for lines that must be heard whole, such as a keypad instruction or a legal statement.'),
    mode: z
      .enum(['fixed', 'generative'])
      .optional()
      .describe(
        'How the line is produced. fixed: the text above, word for word. generative: worded by a model for the moment (it needs a `goal`), under checks that hold it to this line\'s data and meaning, with the text above said whenever a check fails or the model is slow. ' +
          'Absent: fixed, unless its form says `wording: generative`; `mode: fixed` keeps a line of such a form fixed.',
      ),
    goal: text()
      .optional()
      .describe('What a generated line must do, for the model that words it ("Ask when the outage started; briefly acknowledge what they just said."). Required with mode: generative. In a locale\'s prompts.yaml: the line is generated in that locale only where its goal is given there.'),
    prescribed: z
      .literal(true, { error: 'must be true, or left out' })
      .optional()
      .describe('true: the line is prescribed (regulated, legal or otherwise fixed by the app designer) and is always said word for word: never generated, whatever its form says; `pnpm check` refuses mode: generative on it. The policy card lists it.'),
    when: when.optional(),
    acknowledge: z
      .boolean({ error: 'must be true or false' })
      .optional()
      .describe(
        'Whether the generated wording of this line may begin by acknowledging what the caller just said ("Thanks.", "Got it."). false: the model only rewords the fixed line, and is told so. Default true; a line\'s own setting wins over its form\'s (forms.yaml\'s `acknowledge`). Only with a generated line; never on a framed line (a span acknowledges nothing).',
      ),
    from: unique(identifier(), 'variable')
      .min(1, { error: 'must name at least one variable' })
      .optional()
      .describe(
        'Generated from collected content: the line\'s variables (its {names}) that hold content the call collected (a message, a note) and the model may summarize rather than repeat word for word. The exact content is always kept and is what is stored; the fixed text, which reads it word for word, is the fallback, and a caller who asks to hear it again hears it. Only with a generated line.',
      ),
    summarizesConfirmed: z
      .literal(true, { error: 'must be true, or left out' })
      .optional()
      .describe(
        'true: the app accepts that this generated line, a read-back, may summarize a value named in `from` (or in a span\'s `from`) that a `confirmed` rule holds the caller to (the caller confirms the value kept, word for word, after hearing a summary of it). Required for such a line; the policy card says so on the action.',
      ),
    generate: z
      .record(identifier(), span, { error: 'must be a map from a variable of the line to its span' })
      .refine((m) => Object.keys(m).length > 0, { error: 'must name at least one span' })
      .optional()
      .describe(
        'A fixed line with generated spans (the framed form): each key is one of the line\'s {variables}, worded by a model from the content its `from` names; every other word of the line is the app\'s fixed text, never sent to a model and never changed. The frame says whose words the span gives ("{caller} called and left this message: {summary}"), so attribution is by design. ' +
          'A span that is not generated, or fails a check, is the exact content, word for word. Not with `mode` or a line\'s own `goal` or `from`.',
      ),
    exactText: text()
      .optional()
      .describe(
        'A framed line only (`generate`): the frame said when every span is its exact content, word for word (no model set up, a check that fails, a slow model, a read-back after a no, a repeat, a reading `when` leaves fixed); `text` is then the frame said with a generated span. ' +
          'For a frame whose words are true of a summary only ("called and said, in short, {summary}"), the exact words get a frame of their own ("called and said: {summary}"). It names the same variables as `text`. Absent: `text` is said either way. In a locale\'s prompts.yaml: that locale\'s own, needed there where prompts.yaml gives one.',
      ),
  })
  .describe('One line the agent says.');

export const promptsSchema = z
  .strictObject({
    prompts: z.record(identifier(), prompt, { error: 'must be a map from prompt id to its line' }).describe('Every prompt, by id.'),
  })
  .describe('prompts.yaml: the lines the agent says, for one locale.');

export type PromptsYaml = z.infer<typeof promptsSchema>;
export type PromptYaml = PromptsYaml['prompts'][string];
