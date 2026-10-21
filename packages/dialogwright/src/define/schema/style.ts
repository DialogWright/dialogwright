import { z } from 'zod';
import { checkAlways, identifier, text, unique } from './common';
import { ADDED_FIRE, DRIFT_ALONE_FIRE, DRIFT_FIRE } from '../../render/checks';
import { RENDER_EFFORTS, RENDER_PROVIDERS, RENDER_THINKING_MODES } from '../../render/providers';

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
        documentsAsk: z
          .enum(['drift', 'added', 'both'])
          .optional()
          .describe(`What the documents judge asks of an answer worded from sections of approved documents (a span from: sections). drift (the default): one yes-or-no, whether it says anything other than what the sections say for the question, refused at documentsRefuseAt (default refuseAt). added: one score, how much of what it tells the caller is something the sections do not say, refused where the probability that it adds anything is at documentsAddedAt or above (default ${ADDED_FIRE}). both: the two in one request, refused where both reach their cutoffs, or where the drift reading alone reaches documentsDriftAloneAt. Measured on a booklet's 132 labelled answers (pnpm render:judge-eval --documents-ask): drift refused 12 of 79 faithful and caught 42 of 53 unfaithful, added 4 and 42, both 1 and 41; live, drift and added each refuse faithful answers the other passes (cost answers to "is it covered?"; "yes, it is covered" where a section says benefits are available).`),
        documentsAddedAt: z
          .number({ error: 'must be a number' })
          .gt(0, { error: 'must be more than 0' })
          .max(1, { error: 'must be at most 1' })
          .optional()
          .describe(`With documentsAsk added or both: the probability that a wording adds something of its own at or above which the added reading refuses it. Default ${ADDED_FIRE}. Above it, less cautious (pnpm check warns).`),
        compareFigures: z
          .strictObject({
            question: text().describe('The question asked of each figure, with {figure} where it goes: "who pays {figure}?".'),
            options: z
              .record(identifier(), text())
              .describe('Its options by label, each a template with {figure}: caller: "The caller pays {figure}", other: "Someone else pays {figure}", unsaid: "It does not say who pays {figure}".'),
            unsaid: identifier().describe('The option that says nothing either way: a pick of it is never a mismatch.'),
            refuseAt: z
              .number({ error: 'must be a number' })
              .gt(0, { error: 'must be more than 0' })
              .max(1, { error: 'must be at most 1' })
              .optional()
              .describe('The probability of the wording\'s pick at or above which a mismatch refuses it. Default 0.5.'),
          })
          .check(checkAlways((value, ctx) => {
            const v = value as { options?: Record<string, unknown>; unsaid?: unknown };
            if (typeof v !== 'object' || v === null || typeof v.options !== 'object' || v.options === null) return;
            const labels = Object.keys(v.options);
            if (labels.length < 2) ctx.addIssue({ code: 'custom', path: ['options'], message: 'has fewer than two options', params: { fix: 'give two options at least, one of them the unsaid one' } });
            if (typeof v.unsaid === 'string' && !labels.includes(v.unsaid)) ctx.addIssue({ code: 'custom', path: ['unsaid'], message: `"${v.unsaid}" is not one of the options`, params: { fix: `name one of ${labels.join(', ')}` } });
          }))
          .optional()
          .describe('A question asked of each figure (an amount or a percentage) an answer from documents gives, and of each line of the sections that gives it, read apart with the same options; the wording is refused where its pick, other than unsaid, is at refuseAt or above and differs from every line\'s that says something. Off by default; the app\'s own question, as what a figure is about is the app\'s domain: on a booklet\'s 134 labelled answers, "who pays {figure}?" caught 3 of the 5 that turned who pays around and refused no faithful one (pnpm render:judge-eval --style <style.yaml>).'),
        documentsDriftAloneAt: z
          .number({ error: 'must be a number' })
          .gt(0, { error: 'must be more than 0' })
          .max(1, { error: 'must be at most 1' })
          .optional()
          .describe(`With documentsAsk both: the drift reading at or above which a wording is refused whatever the added reading says (a condition stretched or a figure moved adds nothing of its own). Default ${DRIFT_ALONE_FIRE}. Above it, less cautious (pnpm check warns).`),
      })
      .optional()
      .describe('The drift judge, the decision model asked whether each generated line or span means what it was given (its meaning is the judge\'s; the checks by code hold its data and shape).'),
    model: z
      .strictObject({
        provider: z.enum(RENDER_PROVIDERS).describe('Where the model is reached: openrouter (any model OpenRouter serves) or anthropic.'),
        id: text()
          .optional()
          .describe('The model id, as the provider names it ("google/gemini-3.5-flash-lite" on OpenRouter, "claude-haiku-5-5" on Anthropic). Default: the provider\'s default model (RENDER_MODEL\'s default).'),
        thinking: z
          .enum(RENDER_THINKING_MODES)
          .optional()
          .describe('How the model thinks while it words a line, as RENDER_THINKING says it, for this model only: disabled, adaptive, omit, or between-tools (Claude Sonnet 5.5 on anthropic). For a model whose endpoint refuses reasoning off (OpenRouter answers "Reasoning is mandatory"), adaptive with an effort. Sent only where this model is in force; RENDER_THINKING or RENDER_EFFORT in the environment is taken over both. Default: the model\'s own default (reasoning off on OpenRouter), as before.'),
        effort: z
          .enum(RENDER_EFFORTS)
          .optional()
          .describe('How hard it thinks, as RENDER_EFFORT says it: low, medium or high (not with thinking: disabled). Measure the choice with render:bakeoff (provider:model:thinking:effort): reasoning adds to every line\'s wait. Default: the model\'s own.'),
        temperature: z
          .number()
          .min(0)
          .max(2)
          .optional()
          .describe('How freely the model words a line, 0 to 2 (lower is closer to its likeliest wording), sent with every wording of the app\'s generated lines. Not on anthropic while the model thinks (thinking adaptive or omit): its API takes no temperature then. Default: none sent, the model\'s own.'),
        retryTemperature: z
          .number()
          .min(0)
          .max(2)
          .optional()
          .describe('The temperature of a knowledge answer\'s second wording, asked after its first was refused (a span\'s retry): lower keeps it closer to what the sections say. Default: temperature, else none sent.'),
      })
      .superRefine((m, ctx) => {
        if (m.thinking === 'disabled' && m.effort !== undefined) ctx.addIssue({ code: 'custom', path: ['effort'], message: 'effort asks for reasoning, which thinking: disabled turns off', params: { fix: 'remove effort, or set thinking: adaptive' } });
        if (m.thinking === 'between-tools' && m.provider !== 'anthropic') ctx.addIssue({ code: 'custom', path: ['thinking'], message: 'between-tools is Claude Sonnet 5.5\'s on anthropic', params: { fix: 'on openrouter use disabled, adaptive or omit' } });
        for (const key of ['temperature', 'retryTemperature'] as const) {
          if (m[key] !== undefined && m.provider === 'anthropic' && (m.thinking === 'adaptive' || m.thinking === 'omit')) ctx.addIssue({ code: 'custom', path: [key], message: `anthropic takes no ${key === 'temperature' ? 'temperature' : 'retryTemperature'} while the model thinks (thinking: ${m.thinking})`, params: { fix: `remove ${key}, or set thinking: disabled` } });
        }
      })
      .optional()
      .describe(
        'The model that words the app\'s generated lines, the author\'s choice (measured with render:bakeoff): what the server words with and the regression\'s recorded run replays, as RENDER_PROVIDER and RENDER_MODEL would name it. The environment overrides it: RENDER_PROVIDER naming another provider takes that one (with RENDER_MODEL or its default model), and RENDER_MODEL, read only with RENDER_PROVIDER set, names the model. The key is read from the environment only (OPENROUTER_API_KEY or ANTHROPIC_API_KEY), never from here; with RENDER_PROVIDER unset and the key unset the server says every line fixed, with a warning, and pnpm diagnose says so. Default: none, as before (the server generates only with RENDER_PROVIDER set, and a recorded run replays Anthropic\'s claude-haiku-5-5).',
      ),
  })
  .describe('style.yaml: how a generated line sounds. Only read when the app generates a line.');

export type StyleYaml = z.infer<typeof styleSchema>;
