import { z } from 'zod';
import { identifier, text } from './common';

/**
 * prompts.yaml: every line the agent says. Mirrors App.prompts.manifest. One file per locale:
 * prompts.yaml for the app's default locale, locale/<tag>/prompts.yaml for another.
 */

const prompt = z
  .strictObject({
    text: text().describe('The words said. Variables go in braces ({first}); the engine fills them. Approved wording: the agent says exactly this and never composes its own.'),
    interruptible: z.boolean({ error: 'must be true or false' }).describe('Whether the caller may talk over the line (barge-in). false for lines that must be heard whole, such as a keypad instruction or a legal statement.'),
    mode: z
      .literal('fixed')
      .default('fixed')
      .describe('How the line is produced. fixed: the text above, word for word; the only mode there is for now (generated wording is not available). Default "fixed".'),
  })
  .describe('One line the agent says.');

export const promptsSchema = z
  .strictObject({
    prompts: z.record(identifier(), prompt, { error: 'must be a map from prompt id to its line' }).describe('Every prompt, by id.'),
  })
  .describe('prompts.yaml: the lines the agent says, for one locale.');

export type PromptsYaml = z.infer<typeof promptsSchema>;
export type PromptYaml = PromptsYaml['prompts'][string];
