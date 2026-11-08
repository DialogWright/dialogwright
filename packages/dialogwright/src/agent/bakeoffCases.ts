import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { AgentActionChoice, AgentFacts, AgentField, AgentUtterance } from './types';
import { NO_ACTION } from './types';

/**
 * The cases `agent:bakeoff` measures agent models on (./bakeoff.ts), read from a file the author names
 * (`--cases <file>`, YAML or JSON): the business's facts, the owner's sample replies, the forms, and the
 * calls as scripted caller turns. Each caller turn is labelled with the values a correct answer holds
 * and the action it may propose; what the line said after it is scripted, so every model is asked the
 * same turns. The engine holds no case of its own: an app's cases are in its own fixtures, and the
 * engine's tests use an invented fixture (./fixture/).
 */

/** A text value's label: words it must hold, whole (case ignored), and how the line would hold it, for the turns after. */
export interface TextLabel {
  has: string[];
  as: string;
}

/** A value's label: the value (or any of several), or a text value's words. */
export type ValueLabel = string | readonly string[] | TextLabel;

export interface BakeoffTurn {
  /** What the caller says. */
  caller: string;
  /** Heard while the line was still speaking. */
  overLine?: boolean;
  /** The values a correct answer holds, by field: every one of them, each right. */
  values?: Readonly<Record<string, ValueLabel>>;
  /** Values an answer may hold without being wrong, by field (`*`: any value); given, each is still held to its label. */
  may?: Readonly<Record<string, ValueLabel | '*'>>;
  /** The action a correct answer proposes (or any of several); default `none`. */
  action?: string | readonly string[];
  /** A turn whose reply must say no number at all, in digits or in words (a price pushed for). */
  noFigure?: boolean;
  /** What the review reads the reply for, where the table cannot judge it: the replies are listed under it. */
  review?: string;
  /** What the line said after this turn: the next turn's history. */
  line: string;
}

export interface BakeoffCall {
  id: string;
  about: string;
  form: { name: string; about: string };
  fields: Omit<AgentField, 'value'>[];
  actions: AgentActionChoice[];
  caller: { account: string | null };
  channel: 'voice' | 'chat';
  today: string;
  /** The values collected before the first turn (a short call that starts mid-form). */
  collected?: Readonly<Record<string, string>>;
  /** What was said before the first turn: the greeting, and the conversation so far. */
  before: AgentUtterance[];
  turns: BakeoffTurn[];
}

/** A cases file, read: the facts and examples every turn is sent, and the calls with their forms resolved. */
export interface BakeoffCases {
  facts: AgentFacts;
  examples: string[];
  calls: BakeoffCall[];
}

const text = z.string().refine((s) => s.trim() !== '', { message: 'must not be empty' });
const textLabel = z.strictObject({ has: z.array(text).min(1), as: text });
const valueLabel = z.union([text, z.array(text).min(1), textLabel]);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date as YYYY-MM-DD');

const turnSchema = z.strictObject({
  caller: text,
  overLine: z.boolean().optional(),
  values: z.record(z.string(), valueLabel).optional(),
  may: z.record(z.string(), z.union([z.literal('*'), valueLabel])).optional(),
  action: z.union([text, z.array(text).min(1)]).optional(),
  noFigure: z.boolean().optional(),
  review: text.optional(),
  line: text,
});

/** The slot types an agent-mode field may be (an identity factor never is). */
const FIELD_TYPES = ['choice', 'date', 'digits', 'name', 'text'] as const;

const fieldSchema = z.strictObject({
  name: text,
  type: z.enum(FIELD_TYPES),
  about: text.optional(),
  options: z.array(text).min(1).optional(),
  required: z.boolean().default(true),
  redact: z.enum(['last4', 'mask', 'length']).optional(),
});

const formSchema = z.strictObject({
  about: text,
  fields: z.array(fieldSchema).min(1),
  actions: z.array(z.strictObject({ name: text, about: text })).default([]),
});

const callSchema = z.strictObject({
  id: text,
  about: text,
  form: text,
  caller: z.strictObject({ account: z.string().nullable() }).default({ account: null }),
  channel: z.enum(['voice', 'chat']).default('voice'),
  today: isoDate,
  collected: z.record(z.string(), text).optional(),
  before: z.array(z.strictObject({ who: z.enum(['caller', 'line']), text })).default([]),
  turns: z.array(turnSchema).min(1),
});

/** The shape of a cases file. */
export const bakeoffCasesSchema = z.strictObject({
  facts: z.strictObject({
    name: text,
    voice: text,
    says: z.array(text).default([]),
    background: z.array(text).default([]),
    fixed: z.record(z.string(), text).default({}),
  }),
  examples: z.array(text).default([]),
  forms: z.record(z.string(), formSchema),
  calls: z.array(callSchema).min(1),
});

/**
 * A cases file's content checked and resolved: its shape, then each call's form, every label's field
 * and action, and each id once. Throws, naming where (`calls.1.turns.0.values.day`) and what is wrong.
 */
export function parseBakeoffCases(content: unknown, where = 'the cases'): BakeoffCases {
  const parsed = bakeoffCasesSchema.safeParse(content);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new Error(`${where}: ${issue.path.join('.') || '(root)'}: ${issue.message}`);
  }
  const c = parsed.data;
  const problems: string[] = [];
  const ids = new Set<string>();
  const calls: BakeoffCall[] = c.calls.map((call, i): BakeoffCall | null => {
    const at = `calls.${i} (${call.id})`;
    if (ids.has(call.id)) problems.push(`${at}: the id ${call.id} is used twice`);
    ids.add(call.id);
    const form = c.forms[call.form];
    if (form === undefined) {
      problems.push(`${at}: form ${call.form} is not one of the forms (${Object.keys(c.forms).join(', ')})`);
      return null;
    }
    const names = new Set(form.fields.map((f) => f.name));
    if (names.size !== form.fields.length) problems.push(`forms.${call.form}: a field is named twice`);
    const actions = new Set([...form.actions.map((a) => a.name), NO_ACTION]);
    for (const field of Object.keys(call.collected ?? {})) if (!names.has(field)) problems.push(`${at}.collected.${field}: no such field in form ${call.form}`);
    call.turns.forEach((t, j) => {
      for (const field of [...Object.keys(t.values ?? {}), ...Object.keys(t.may ?? {})]) if (!names.has(field)) problems.push(`${at}.turns.${j}: ${field} is no field of form ${call.form}`);
      for (const a of t.action === undefined ? [] : typeof t.action === 'string' ? [t.action] : t.action) if (!actions.has(a)) problems.push(`${at}.turns.${j}.action: ${a} is not one of the form's actions (${[...actions].join(', ')})`);
    });
    return {
      id: call.id,
      about: call.about,
      form: { name: call.form, about: form.about },
      fields: form.fields.map((f) => ({ name: f.name, type: f.type, required: f.required, ...(f.about !== undefined ? { about: f.about } : {}), ...(f.options !== undefined ? { options: f.options } : {}), ...(f.redact !== undefined ? { redact: f.redact } : {}) })),
      actions: form.actions,
      caller: call.caller,
      channel: call.channel,
      today: call.today,
      ...(call.collected !== undefined ? { collected: call.collected } : {}),
      before: call.before,
      turns: call.turns as BakeoffTurn[],
    };
  }).filter((x): x is BakeoffCall => x !== null);
  if (problems.length > 0) throw new Error(`${where}: ${problems.join('; ')}`);
  return { facts: c.facts, examples: c.examples, calls };
}

/** Reads a cases file (YAML, or JSON, which YAML reads too). Throws, naming the file, when it cannot be read or is wrong. */
export function loadBakeoffCases(path: string): BakeoffCases {
  let content: unknown;
  try {
    content = parseYaml(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return parseBakeoffCases(content, path);
}
