import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import { E164 } from '../core/numberLocales';

/**
 * A simulated caller's persona: what they want, what is true of them, how they speak, and what the call
 * should come to. The model that plays the caller is given the persona and nothing of the business, so a
 * run measures what the line does with a person who knows only what they would know.
 */
const text = z.string().trim().min(1);

export const personaSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, { error: 'lowercase letters, digits and hyphens, starting with a letter' }).describe('A short name for the persona, used in results.'),
  goal: text.describe('What the caller wants from the call, in their own terms.'),
  truth: z.record(z.string(), text).describe('What is true of the caller and what they will say when asked (their name, the item, the details of the matter, a number...), by short key. The caller states only these facts.'),
  manner: text.describe('How the caller speaks: terse, rambling, impatient, polite...'),
  expects: z.enum(['request', 'booking', 'callback', 'transfer', 'answer', 'none']).describe('What the call should come to: a request or booking taken, a callback note left, the call put through to a person (on the voice path, an agent app with transfer.number), a question answered, or nothing done.'),
  adversarial: text.optional().describe('What the caller tries that they should not get (a free job, the line ignoring its instructions...).'),
  asksIfHuman: z.boolean().optional().describe('The caller asks, at some point, whether they are talking to a person.'),
  callingFrom: z.string().regex(E164, { error: 'must be an E.164 number like +15555550142' }).optional().describe('The number the caller calls from (E.164): the chat names it in its start\'s context (callerNumber), which an app whose app.yaml says chat.callerNumberFromContext takes as the number calling, so a caller recognised by their number can be simulated. Absent, the chat names none (on the voice path, the call comes from a 555 number of the harness\'s own).'),
  voice: z
    .strictObject({
      interrupts: z.boolean().default(false).describe('The caller cuts in on long replies: on a reply of more than 30 words, once 40% of its words have played.'),
      fragments: z.boolean().default(false).describe('The caller\'s longer turns (more than 8 words) reach the line in two parts, as a recognizer that ended a turn early.'),
      silentOnce: z.boolean().optional().describe('Once, after their first turn, the caller says nothing when the line hands them the turn, and waits for the line to answer the silence (agent.yaml\'s silence wait) before going on.'),
    })
    .optional()
    .describe('How the caller behaves on the voice path (pnpm eval --channel voice): the caller cuts in on long replies; the caller\'s longer turns reach the line in two parts, as a recognizer that ended a turn early. Ignored over the chat wire.'),
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

/**
 * A cooperative persona: one who wants something done (a request, a booking, a callback or to be put through) and tries nothing
 * they should not get (no `adversarial`). Their calls are the ones the bar of the task done correctly is over;
 * a question answered, nothing to be done, or a caller pushing the line are measured by the other figures.
 */
export function isCooperative(p: Persona): boolean {
  return p.adversarial === undefined && (p.expects === 'request' || p.expects === 'booking' || p.expects === 'callback' || p.expects === 'transfer');
}
