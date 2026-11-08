import { z } from 'zod';
import { safeErrorText } from '../render/providers';
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

/** The fields, refused when one is named twice (a form's fields are distinct). */
function fieldNames(fields: readonly string[] | undefined): readonly string[] | undefined {
  if (fields === undefined) return undefined;
  const twice = fields.find((f, i) => fields.indexOf(f) !== i);
  if (twice !== undefined) throw new Error(`the agent's fields name "${twice}" twice`);
  return fields;
}

const nonEmpty = z.string().refine((s) => s.trim() !== '', { message: 'must not be empty' });

/** The fixed lines an answer may name in place of its reply, with `none` always among them, once; none at all where the turn offers no line. */
function lineNames(lines: readonly string[] | undefined): [string, ...string[]] | null {
  const named = [...new Set((lines ?? []).filter((l) => l !== NO_ACTION))];
  return named.length === 0 ? null : [named[0]!, ...named.slice(1), NO_ACTION];
}

/**
 * The zod schema of an answer naming one of `actions` (or `none`), and where `fields` is given, values of
 * those fields only; where `lines` names any, with `fixedLine`, one of them or `none` (AgentAnswer.fixedLine).
 */
export function agentAnswerSchema(actions: readonly string[], fields?: readonly string[], lines?: readonly string[]): z.ZodType<AgentAnswer> {
  const names = fieldNames(fields);
  const field = names === undefined || names.length === 0 ? nonEmpty : z.enum(names as [string, ...string[]]);
  const fixed = lineNames(lines);
  return z.strictObject({
    reply: z.string(),
    values: z.array(z.strictObject({ field, value: nonEmpty, words: nonEmpty })),
    action: z.enum(actionNames(actions)),
    fromFacts: z.boolean(),
    ...(fixed !== null ? { fixedLine: z.enum(fixed) } : {}),
  }) as z.ZodType<AgentAnswer>;
}

/** The JSON Schema of the same shape, for `response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } }`. */
export function agentJsonSchema(actions: readonly string[], fields?: readonly string[], lines?: readonly string[]): Record<string, unknown> {
  const names = fieldNames(fields);
  const fixed = lineNames(lines);
  return {
    type: 'object',
    additionalProperties: false,
    required: ['reply', 'values', 'action', 'fromFacts', ...(fixed !== null ? ['fixedLine'] : [])],
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
            field: { type: 'string', ...(names !== undefined && names.length > 0 ? { enum: [...names] } : {}) },
            value: { type: 'string', minLength: 1 },
            words: { type: 'string', minLength: 1, description: "The caller's own words the value came from, exactly as said." },
          },
        },
      },
      action: { type: 'string', enum: actionNames(actions) },
      fromFacts: { type: 'boolean', description: 'Whether the reply says something from the knowledge base.' },
      ...(fixed !== null ? { fixedLine: { type: 'string', enum: fixed, description: 'A fixed line that answers the caller, said in its own words in place of the reply; none where no fixed line does.' } } : {}),
    },
  };
}

/** The name the schema is sent under. */
export const AGENT_SCHEMA_NAME = 'agent_answer';

/** A model's text without the code fence some models put round JSON (```json, ```JSON or bare). */
function unfenced(raw: string): string {
  const m = /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/i.exec(raw);
  return m !== null ? m[1]! : raw;
}

/**
 * The keys of the shape: a path names only these (or an index); any other key, which the model chose, is `?`.
 * A reply that runs one of them into its words is a piece of the shape said (render/agentLine.ts shapeLeak).
 */
export const AGENT_SHAPE_KEYS: ReadonlySet<string> = new Set(['reply', 'values', 'action', 'fromFacts', 'fixedLine', 'field', 'value', 'words']);
const SHAPE_KEYS = AGENT_SHAPE_KEYS;

/**
 * The model's text read as an answer: JSON in the shape (agentAnswerSchema), or why not (`not JSON`,
 * or the first issue's path and kind). Never the text itself in the reason, nor a key the model chose:
 * the path names the shape's own keys only, an unknown key is said as such, and what is left passes
 * safeErrorText.
 */
export function parseAgentAnswer(raw: string, actions: readonly string[], fields?: readonly string[], lines?: readonly string[]): { ok: true; answer: AgentAnswer } | { ok: false; detail: string } {
  let json: unknown;
  try {
    json = JSON.parse(unfenced(raw));
  } catch {
    return { ok: false, detail: 'the answer is not JSON' };
  }
  const parsed = agentAnswerSchema(actions, fields, lines).safeParse(json);
  if (parsed.success) return { ok: true, answer: parsed.data };
  const issue = parsed.error.issues[0];
  if (issue === undefined) return { ok: false, detail: 'the answer is not the shape' };
  const path = issue.path.map((p) => (typeof p === 'number' ? String(p) : typeof p === 'string' && SHAPE_KEYS.has(p) ? p : '?')).join('.') || '(root)';
  const why = issue.code === 'unrecognized_keys' ? 'a key the shape does not have' : safeErrorText(issue.message, '');
  return { ok: false, detail: `the answer is not the shape: ${path}: ${why}` };
}
