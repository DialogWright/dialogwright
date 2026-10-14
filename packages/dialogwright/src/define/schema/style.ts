import { z } from 'zod';
import { text, unique } from './common';
import { DRIFT_FIRE } from '../../render/checks';

/**
 * style.yaml (optional): how a generated line sounds (generated wording, design section 5). Read only
 * for an app with a line generated (prompts.yaml's `mode: generative`, or a form's `wording:
 * generative`); an app whose lines are all fixed never reads it. Every value goes to the model as the
 * line's style, and the word budget and the phrases to avoid are also checked on every generated line
 * before anyone hears it.
 */

/** The most words a generated line may use on each channel when style.yaml does not say. */
export const DEFAULT_WORDS = { voice: 25, chat: 40 } as const;

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
    judge: z
      .strictObject({
        refuseAt: z
          .number({ error: 'must be a number' })
          .gt(0, { error: 'must be more than 0' })
          .max(1, { error: 'must be at most 1' })
          .optional()
          .describe(`The drift judge's probability that a wording is unfaithful (or does more than its goal) at or above which it is refused and the fixed text said. Default ${DRIFT_FIRE}. Lower is more cautious: more callers hear the fixed text. Higher is less cautious than the default: more of what the judge doubts is said (pnpm check warns, and the policy card says so). For a line that must never be worded by a model, mark it prescribed: true instead.`),
      })
      .optional()
      .describe('The drift judge, the decision model asked whether each generated line or span means what it was given (its meaning is the judge\'s; the checks by code hold its data and shape).'),
  })
  .describe('style.yaml: how a generated line sounds. Only read when the app generates a line.');

export type StyleYaml = z.infer<typeof styleSchema>;
