import { z } from 'zod';
import { NO_ACTION, type AgentAnswer } from './types';

/**
 * The shape the agent model answers in: its zod schema, which is what the engine accepts, and the
 * same shape as a JSON Schema for the request's `response_format` (`strict: true`: every object
 * closed, every field required, as Inception's and OpenAI's structured output take it). The action
 * is one of the app's, or `none`; where the form's fields are given, a value names one of them.
 */

/** The actions an answer may name: the app's, with `none` always among them, once. */
function actionNames(actions: readonly string[]): [string, ...string[]] {
  return [...new Set([...actions.filter((a) => a !== NO_ACTION), NO_ACTION])] as [string, ...string[]];
}

const nonEmpty = z.string().refine((s) => s.trim() !== '', { message: 'must not be empty' });

/** The zod schema of an answer naming one of `actions` (or `none`), and where `fields` is given, values of those fields only. */
export function agentAnswerSchema(actions: readonly string[], fields?: readonly string[]): z.ZodType<AgentAnswer> {
  const field = fields === undefined || fields.length === 0 ? nonEmpty : z.enum(fields as [string, ...string[]]);
  return z.strictObject({
    reply: z.string(),
    values: z.array(z.strictObject({ field, value: nonEmpty, words: nonEmpty })),
    action: z.enum(actionNames(actions)),
    fromFacts: z.boolean(),
  }) as z.ZodType<AgentAnswer>;
}

/** The JSON Schema of the same shape, for `response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } }`. */
export function agentJsonSchema(actions: readonly string[], fields?: readonly string[]): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['reply', 'values', 'action', 'fromFacts'],
    properties: {
      reply: { type: 'string', description: 'What the line says to the caller this turn.' },
      values: {
        type: 'array',
        description: 'The values understood from the caller this turn, new ones and corrections.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['field', 'value', 'words'],
          properties: {
            field: { type: 'string', ...(fields !== undefined && fields.length > 0 ? { enum: [...fields] } : {}) },
            value: { type: 'string' },
            words: { type: 'string', description: "The caller's own words the value came from, exactly as said." },
          },
        },
      },
      action: { type: 'string', enum: actionNames(actions) },
      fromFacts: { type: 'boolean', description: 'Whether the reply says something from the knowledge base.' },
    },
  };
}

/** The name the schema is sent under. */
export const AGENT_SCHEMA_NAME = 'agent_answer';

/** A model's text without the code fence some models put round JSON. */
function unfenced(raw: string): string {
  const m = /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/.exec(raw);
  return m !== null ? m[1]! : raw;
}

/**
 * The model's text read as an answer: JSON in the shape (agentAnswerSchema), or why not (`not JSON`,
 * or the first issue's path and message). Never the text itself in the reason.
 */
export function parseAgentAnswer(raw: string, actions: readonly string[], fields?: readonly string[]): { ok: true; answer: AgentAnswer } | { ok: false; detail: string } {
  let json: unknown;
  try {
    json = JSON.parse(unfenced(raw));
  } catch {
    return { ok: false, detail: 'the answer is not JSON' };
  }
  const parsed = agentAnswerSchema(actions, fields).safeParse(json);
  if (parsed.success) return { ok: true, answer: parsed.data };
  const issue = parsed.error.issues[0];
  return { ok: false, detail: `the answer is not the shape: ${issue === undefined ? 'invalid' : `${issue.path.join('.') || '(root)'}: ${issue.message}`}` };
}
