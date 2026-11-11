import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

/**
 * A simulated caller's persona: what they want, what is true of them, how they speak, and what the call
 * should come to. The model that plays the caller is given the persona and nothing of the business, so a
 * run measures what the line does with a person who knows only what they would know.
 */
const text = z.string().trim().min(1);

export const personaSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, { error: 'lowercase letters, digits and hyphens, starting with a letter' }).describe('A short name for the persona, used in results.'),
  goal: text.describe('What the caller wants from the call, in their own terms.'),
  truth: z.record(z.string(), text).describe('What is true of the caller and what they will say when asked (name, vehicle, damage, a number...), by short key. The caller states only these facts.'),
  manner: text.describe('How the caller speaks: terse, rambling, impatient, polite...'),
  expects: z.enum(['request', 'booking', 'callback', 'answer', 'none']).describe('What the call should come to: a request or booking taken, a callback note left, a question answered, or nothing done.'),
  adversarial: text.optional().describe('What the caller tries that they should not get (a free job, the line ignoring its instructions...).'),
  asksIfHuman: z.boolean().optional().describe('The caller asks, at some point, whether they are talking to a person.'),
});
export type Persona = z.infer<typeof personaSchema>;

export const personasFileSchema = z.strictObject({ personas: z.array(z.unknown()).min(1) });

/** The personas file's JSON Schema (schemas/personas.schema.json). */
export function personasJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(z.strictObject({ personas: z.array(personaSchema).min(1) }), { io: 'input', target: 'draft-7' }) as Record<string, unknown>;
  return { ...schema, title: 'DialogWright personas.yaml' };
}

/** The personas of a YAML file, each checked; a persona that is wrong is named by its id. */
export function loadPersonas(file: string): Persona[] {
  const doc: unknown = parse(readFileSync(file, 'utf8'));
  const top = personasFileSchema.safeParse(doc);
  if (!top.success) throw new Error(`${file}: a personas file is { personas: [...] } with at least one persona`);
  const seen = new Set<string>();
  return top.data.personas.map((raw, i) => {
    const named = typeof raw === 'object' && raw !== null && typeof (raw as { id?: unknown }).id === 'string' ? (raw as { id: string }).id : `#${i + 1}`;
    const r = personaSchema.safeParse(raw);
    if (!r.success) {
      const issue = r.error.issues[0]!;
      throw new Error(`${file}: persona ${named}: ${issue.path.join('.') || 'persona'} ${issue.message}`);
    }
    if (seen.has(r.data.id)) throw new Error(`${file}: persona ${named}: id is used twice`);
    seen.add(r.data.id);
    return r.data;
  });
}
