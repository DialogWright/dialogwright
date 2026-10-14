import { z } from 'zod';
import { text, unique } from './common';

/**
 * style.yaml (optional): how a generated line sounds (generated wording, design section 5). Read only
 * for an app with a line generated (prompts.yaml's `mode: generative`, or a form's `wording:
 * generative`); an app whose lines are all fixed never reads it. Every value goes to the model as the
 * line's style, and the word budget and the phrases to avoid are also checked on every generated line
 * before anyone hears it.
 */

/** The most words a generated line may use on each channel when style.yaml does not say. */
export const DEFAULT_WORDS = { voice: 25, chat: 40 } as const;

/**
 * How strictly a framed line's span is checked by its words (`checks`, here for the app and in
 * prompts.yaml for a line or a span): `standard`, the checks of values, shape and voice, with who does
 * what to whom and what was left out the drift check's; `strict`, every check besides.
 */
export const CHECK_LEVELS = ['standard', 'strict'] as const;
export type CheckLevel = (typeof CHECK_LEVELS)[number];

/** What `checks` says, for style.yaml and prompts.yaml alike. */
export const CHECKS_DESCRIPTION =
  'How strictly a framed line\'s span (prompts.yaml\'s `generate`) is checked by its words before anyone hears it. standard (the default): the checks of values, shape and voice (no question, no other recipient, a negation of the content kept, the word budget, the phrases to avoid, no figure or name the content does not have, no I, we or you the content does not use, a span spoken to the caller never saying I or we, no he or she of another gender), and the drift check, the decision model\'s judgement, for the rest: who does what to whom, a "no" or a condition left out. ' +
  'strict: every check besides, by its words: a clause of the content that says "no" or sets a condition left out (omitted), and, for a span spoken to the caller, persons swapped, the message\'s own "you" taken for the caller, a "your" for no "my" (person); conservative, so it refuses more good summaries (the caller hears their exact words), for a regulated line or an owner who wants every guard. ' +
  'A whole generated line\'s checks are the same at both levels. The policy card says which each span runs.';

export const styleSchema = z
  .strictObject({
    persona: text()
      .optional()
      .describe('Who the agent sounds like, for the model ("a calm, plain-spoken service agent"). Default: a calm, plain-spoken agent.'),
    words: z
      .strictObject({
        voice: z.int({ error: 'must be a whole number' }).min(3, { error: 'must be at least 3' }).max(200, { error: 'must be at most 200' }).optional().describe(`The most words a generated line may use on a call. Default ${DEFAULT_WORDS.voice}.`),
        chat: z.int({ error: 'must be a whole number' }).min(3, { error: 'must be at least 3' }).max(400, { error: 'must be at most 400' }).optional().describe(`The most words a generated line may use in a chat. Default ${DEFAULT_WORDS.chat}.`),
      })
      .optional()
      .describe('The word budget of a generated line, per channel: a longer one is not said (its fixed line is).'),
    avoid: unique(text(), 'phrase')
      .optional()
      .describe('Phrases a generated line must not use ("unfortunately", "I apologize for the inconvenience"): told to the model, and a line that uses one anyway is not said (its fixed line is). Compared without regard to case.'),
    checks: z
      .enum(CHECK_LEVELS)
      .optional()
      .describe(`${CHECKS_DESCRIPTION} Here, for every span of the app; a line's or a span's own (prompts.yaml) wins.`),
  })
  .describe('style.yaml: how a generated line sounds. Only read when the app generates a line.');

export type StyleYaml = z.infer<typeof styleSchema>;
