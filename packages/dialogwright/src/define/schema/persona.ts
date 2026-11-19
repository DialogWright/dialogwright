import { z } from 'zod';
import { checkAlways, identifier, text } from './common';

/**
 * A persona file (app.yaml's `personas.files`, each a YAML file in the app folder): another way the
 * app's lines sound, picked for a call or chat by one of its call data values (app.yaml's
 * `personas.from`). Every part is optional, and what it does not name is the app's own: the words of
 * some of its fixed lines (prompts.yaml, by prompt id), the persona text and word budgets its generated
 * wording is given (style.yaml's), and the word budget of a generated span. What is done never changes
 * with a persona: the policy, the forms, the identity and the tools are the app's.
 */

/** A persona's value: as a chat page's option value or another call data value gives it. */
export const PERSONA_VALUE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** A persona file's path in the app folder: relative, with no "..", a .yaml file. */
export const PERSONA_FILE = /^(?![/\\])(?![A-Za-z]:)(?!(?:.*[/\\])?\.\.(?:[/\\]|$))[^\\]+\.ya?ml$/;

const budget = (max: number, what: string) =>
  z.int({ error: 'must be a whole number' }).min(3, { error: 'must be at least 3' }).max(max, { error: `must be at most ${max}` }).optional().describe(what);

const line = z
  .strictObject({
    text: text().optional().describe('The line\'s words for this persona, in place of prompts.yaml\'s `text`: said word for word (or, on a generated line, its fallback and what its wording is held to). It may name only the variables the app\'s own line names ({name}), and a framed line\'s every span. Absent: the app\'s text.'),
    variants: z
      .array(text(), { error: 'must be a list of the line\'s other wordings' })
      .min(1, { error: 'must give at least one wording' })
      .optional()
      .describe('The line\'s other wordings for this persona, said in turn, in place of the app\'s `variants`: only on a line said in turn (ack_intent, kb_not_found, kb_hold, kb_hold_more, a slot\'s own question), each with the variables of the line\'s text. Absent: the app\'s.'),
    chat: text().optional().describe('The line\'s words on a chat for this persona, formatted as prompts.yaml\'s `chat` is, in place of the app\'s. Not on a generated line, or one with variants. Absent: the app\'s.'),
  })
  .check(
    checkAlways((value, ctx) => {
      if (typeof value !== 'object' || value === null) return;
      const v = value as Record<string, unknown>;
      if (v.text === undefined && v.variants === undefined && v.chat === undefined) {
        ctx.addIssue({ code: 'custom', path: [], message: 'gives none of text, variants and chat, so it changes nothing', params: { fix: 'give the line\'s words for this persona (text), or delete the entry' } });
      }
    }),
  )
  .describe('One line\'s words for this persona: each part given replaces the app\'s, and every other part of the line (interruptible, generate, when, prescribed...) is the app\'s.');

export const personaSchema = z
  .strictObject({
    style: z
      .strictObject({
        persona: z
          .union([text(), z.array(text(), { error: 'must be a description, or a list of them' }).min(2, { error: 'must give two at least, or be one description' }).max(6, { error: 'has more than six' })])
          .optional()
          .describe('Who the agent sounds like for this persona, as the model that words a generated line is told it (and the judge, who is speaking), in place of style.yaml\'s `persona`. A list of two to six is said in turn, each turn of the call worded with the next.'),
        words: z
          .strictObject({
            voice: budget(200, 'The most words a generated line may use on a call, in place of style.yaml\'s.'),
            chat: budget(400, 'The most words a generated line may use in a chat, in place of style.yaml\'s.'),
          })
          .optional()
          .describe('The word budgets it names, each in place of style.yaml\'s; the others are the app\'s. A knowledge answer\'s budget is its span\'s (spans).'),
      })
      .optional()
      .describe('How this persona\'s generated wording sounds: what it names replaces style.yaml\'s. Only for an app that generates a line.'),
    spans: z
      .record(identifier(), z.record(identifier(), z.strictObject({ words: z.int({ error: 'must be a whole number' }).min(3, { error: 'must be at least 3' }).max(300, { error: 'must be at most 300' }).describe('The most words the span may use for this persona, in place of its own.') })), {
        error: 'must be a map from a prompt id to its spans, each with its words',
      })
      .optional()
      .describe('A generated span\'s word budget for this persona, by prompt id and span (prompts.yaml\'s `generate.<span>.words`): each a span the app generates.'),
    prompts: z
      .record(identifier(), line, { error: 'must be a map from prompt id to the line\'s words for this persona' })
      .optional()
      .describe('The lines this persona words its own way, by prompt id: each one of prompts.yaml\'s, never one marked prescribed: true. Every other line is the app\'s.'),
  })
  .describe('A persona: another way the app\'s lines sound, picked for a call or chat by app.yaml\'s personas.from. The default locale\'s lines only; what it does not name is the app\'s.');

export type PersonaYaml = z.infer<typeof personaSchema>;
