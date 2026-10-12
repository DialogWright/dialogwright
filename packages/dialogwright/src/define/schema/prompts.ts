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
        'true: the app accepts that this generated line, a read-back, may summarize a value named in `from` that a `confirmed` rule holds the caller to (the caller confirms the value kept, word for word, after hearing a summary of it). Required for such a line; the policy card says so on the action.',
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
