import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';
import type { SlotExample } from '../types';

/**
 * A type's examples.yaml: a list of example configurations, each with starter utterances (the
 * words, the model's answers to the slot's questions, the outcome expected) and, for a type with a
 * keypad rung, keys. The docs show them and the conformance kit runs them.
 */

const probabilities = z.record(z.string(), z.number());
const answer = z.union([
  z.strictObject({ noul: z.number() }),
  z.strictObject({ choice: probabilities }),
  z.strictObject({ score: probabilities }),
]);
const partial = z.record(z.string(), z.union([z.string(), z.number()])).and(z.object({ kind: z.string() }));

const utterance = z.strictObject({
  text: z.string(),
  answers: z.record(z.string(), answer).optional(),
  context: z
    .strictObject({
      prompted: z.boolean().optional(),
      current: z.string().nullable().optional(),
      locale: z.string().optional(),
      window: partial.nullable().optional(),
      todayIso: z.string().optional(),
      records: z.array(z.unknown()).optional(),
    })
    .optional(),
  expect: z.strictObject({
    kind: z.enum(['absent', 'filled', 'disambiguate', 'window', 'invalid', 'help']),
    value: z.string().optional(),
    display: z.string().optional(),
    confirm: z.enum(['none', 'implicit']).optional(),
    reason: z.string().optional(),
    retryPromptId: z.string().optional(),
    promptId: z.string().optional(),
  }),
});

export const slotExamplesSchema = z.array(
  z.strictObject({
    name: z.string().min(1),
    about: z.string().optional(),
    slot: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/),
    config: z.record(z.string(), z.unknown()),
    utterances: z.array(utterance).min(1),
    keypad: z.array(z.strictObject({ digits: z.string(), expect: z.strictObject({ value: z.string(), display: z.string().optional() }).nullable() })).optional(),
  }),
);

/** Parses an examples.yaml's text; throws with the file's name and the first problem when it is malformed. */
export function parseSlotExamples(text: string, file = 'examples.yaml'): SlotExample[] {
  const result = slotExamplesSchema.safeParse(parse(text));
  if (!result.success) {
    const issue = result.error.issues[0]!;
    throw new Error(`${file}: ${issue.path.join('.') || '(file)'} ${issue.message}`);
  }
  const names = new Set<string>();
  for (const example of result.data) {
    if (names.has(example.name)) throw new Error(`${file}: two examples are named "${example.name}"`);
    names.add(example.name);
  }
  return result.data as SlotExample[];
}

/**
 * A getter for a type's examples, read from `url` (its examples.yaml, `new URL('./examples.yaml',
 * import.meta.url)`) the first time it is called, so importing a type reads no file.
 */
export function examplesFrom(url: URL): () => readonly SlotExample[] {
  let cached: readonly SlotExample[] | undefined;
  return () => (cached ??= parseSlotExamples(readFileSync(fileURLToPath(url), 'utf8'), fileURLToPath(url)));
}
