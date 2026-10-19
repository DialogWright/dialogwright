import { z } from 'zod';
import { text, unique } from './common';
import { DRIFT_FIRE } from '../../render/checks';
import { RENDER_PROVIDERS } from '../../render/providers';

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
    figures: z
      .enum(['symbols', 'words'])
      .optional()
      .describe('How a generated line writes amounts, percentages and other numbers: "symbols", as figures with their symbols ($150, 20%, a 30-day supply), as documents write them, which a chat shows plainly and a voice reads aloud; "words", spelled out (150 dollars, 20 percent). Told to the model as the line\'s style. Default: none, the model\'s own choice.'),
    judge: z
      .strictObject({
        refuseAt: z
          .number({ error: 'must be a number' })
          .gt(0, { error: 'must be more than 0' })
          .max(1, { error: 'must be at most 1' })
          .optional()
          .describe(`The drift judge's probability that a wording is unfaithful (or does more than its goal) at or above which it is refused and the fixed text said. Default ${DRIFT_FIRE}. Lower is more cautious: more callers hear the fixed text. Higher is less cautious than the default: more of what the judge doubts is said (pnpm check warns, and the policy card says so). For a line that must never be worded by a model, mark it prescribed: true instead.`),
        documentsRefuseAt: z
          .number({ error: 'must be a number' })
          .gt(0, { error: 'must be more than 0' })
          .max(1, { error: 'must be at most 1' })
          .optional()
          .describe(`Where the documents drift judge refuses an answer worded from sections of approved documents (a span from: sections), in place of refuseAt for those answers alone: an app that holds its worded passages to a stricter cutoff may hold its answers from documents to another, measured on its own cases (pnpm render:judge-eval, speaks: documents). Default: refuseAt. Above ${DRIFT_FIRE}, less cautious than the default (pnpm check warns).`),
      })
      .optional()
      .describe('The drift judge, the decision model asked whether each generated line or span means what it was given (its meaning is the judge\'s; the checks by code hold its data and shape).'),
    model: z
      .strictObject({
        provider: z.enum(RENDER_PROVIDERS).describe('Where the model is reached: openrouter (any model OpenRouter serves) or anthropic.'),
        id: text()
          .optional()
          .describe('The model id, as the provider names it ("google/gemini-3.1-flash-lite-preview" on OpenRouter, "claude-haiku-5-5" on Anthropic). Default: the provider\'s default model (RENDER_MODEL\'s default).'),
      })
      .optional()
      .describe(
        'The model that words the app\'s generated lines, the author\'s choice (measured with render:bakeoff): what the server words with and the regression\'s recorded run replays, as RENDER_PROVIDER and RENDER_MODEL would name it. The environment overrides it: RENDER_PROVIDER naming another provider takes that one (with RENDER_MODEL or its default model), and RENDER_MODEL, read only with RENDER_PROVIDER set, names the model. The key is read from the environment only (OPENROUTER_API_KEY or ANTHROPIC_API_KEY), never from here; with RENDER_PROVIDER unset and the key unset the server says every line fixed, with a warning, and pnpm diagnose says so. Default: none, as before (the server generates only with RENDER_PROVIDER set, and a recorded run replays Anthropic\'s claude-haiku-5-5).',
      ),
  })
  .describe('style.yaml: how a generated line sounds. Only read when the app generates a line.');

export type StyleYaml = z.infer<typeof styleSchema>;
