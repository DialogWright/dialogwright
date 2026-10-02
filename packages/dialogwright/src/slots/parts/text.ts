import { z } from 'zod';
import { identifier, matching } from '../../define/schema/common';
import { checkTemplate, renderTemplate } from './template';

/**
 * The two option groups every library type that asks questions shares:
 *
 * - `text: { <part>: "..." }` replaces one of the type's text parts (a question's instructions, a
 *   criterion) with a literal string, said to the model exactly as written. A type's defaults are
 *   templates over its options and use neutral words; an app that needs its own wording, or must
 *   keep the words a recording was made with, writes them here.
 * - `ids: { <part>: "..." }` renames one of the type's questions. A question's id is otherwise the
 *   slot's id and the part's name (`note` and `given`: `noteGiven`), so two slots of one type never
 *   share an id; an app moving an existing slot onto the library keeps its old ids here.
 */

/** One text part of a type: its default template, the variables the template may use, and what the part is. */
export interface TextPartDef {
  template: string;
  vars: readonly string[];
  about: string;
}

/** A line of question text as an option gives it: one line, no control characters. */
export const questionText = () =>
  matching(
    /^[^\u0000-\u001f\u007f]*$/,
    'must be one line of text, without line breaks or control characters',
    'write it on one line, in quotes; a block scalar (| or >) ends the text with a line break the model would be sent',
  ).min(1, { error: 'must not be empty' });

/** A type's text parts: the `text` option's schema, and each part rendered from its template or taken from the option. */
export interface TextParts<P extends string> {
  names: readonly P[];
  defs: Readonly<Record<P, TextPartDef>>;
  /** The `text` option: a literal for any part, none required. */
  schema: z.ZodOptional<z.ZodObject<Record<P, z.ZodOptional<z.ZodString>>, z.core.$strict>>;
  /** The part: the option's literal when it gives one, else the default template filled from `vars`. */
  render(part: P, literals: Partial<Readonly<Record<P, string>>> | undefined, vars: Readonly<Record<string, string>>): string;
}

/**
 * Declares a type's text parts. Each template is checked against its variables here, so a type
 * whose default names a variable it never gives fails when it is defined, not on a call.
 */
export function textParts<P extends string>(type: string, defs: Readonly<Record<P, TextPartDef>>): TextParts<P> {
  const names = Object.keys(defs) as P[];
  for (const name of names) checkTemplate(defs[name].template, defs[name].vars, `the "${type}" type's default text for "${name}"`);
  const shape = Object.fromEntries(names.map((name) => [name, questionText().optional().describe(defs[name].about)])) as Record<P, z.ZodOptional<z.ZodString>>;
  const schema = z
    .strictObject(shape)
    .optional()
    .describe(`Text to say to the model in place of a default, word for word, by part: ${names.join(', ')}.`);
  return {
    names,
    defs,
    schema,
    render(part, literals, vars) {
      const literal = literals?.[part];
      if (literal !== undefined) return literal;
      const def = defs[part];
      const given = Object.fromEntries(def.vars.map((v) => [v, vars[v] ?? '']));
      return renderTemplate(def.template, given, `the "${type}" type's default text for "${part}"`);
    },
  };
}

/** A type's questions, by part: the `ids` option's schema, and each question's id. */
export interface QuestionParts<P extends string> {
  names: readonly P[];
  /** The `ids` option: a question id for any part, none required. */
  schema: z.ZodOptional<z.ZodObject<Record<P, z.ZodOptional<z.ZodString>>, z.core.$strict>>;
  /** The question's id: the option's, else the slot's id and the part's name (`note`, `given`: `noteGiven`). */
  id(slot: string, part: P, ids: Partial<Readonly<Record<P, string>>> | undefined): string;
}

/** Declares a type's questions by part, each with what it asks. */
export function questionParts<P extends string>(defs: Readonly<Record<P, string>>): QuestionParts<P> {
  const names = Object.keys(defs) as P[];
  const shape = Object.fromEntries(names.map((name) => [name, identifier().optional().describe(`The id of the question that asks ${defs[name]}.`)])) as Record<P, z.ZodOptional<z.ZodString>>;
  const schema = z
    .strictObject(shape)
    .optional()
    .describe(`Question ids in place of the defaults (the slot's id followed by the part: ${names.join(', ')}), to keep the ids an existing slot used.`);
  return {
    names,
    schema,
    id: (slot, part, ids) => ids?.[part] ?? `${slot}${part.charAt(0).toUpperCase()}${part.slice(1)}`,
  };
}
