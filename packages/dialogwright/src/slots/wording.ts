import { Document, LineCounter } from 'yaml';
import { z, type ZodIssue } from 'zod';
import { formatPath, keyPositionOf, problemsOfIssues, type DataPath, type Problem } from '../define/problems';
import type { JsonSchema } from '../define/schema/json';
import { canonicalJson } from '../jev/cassette';
import type { SlotSource } from './defineSlot';
import type { LibrarySlotSpec, SlotBuildEnv, SlotType, SlotTypes } from './types';

/**
 * A library slot's wording by locale: the words it says its values with in a locale other than the
 * default (a choice option's `say`, a text slot's stand-in), from `locale/<tag>/slots.yaml`. Each
 * type says what may be given (SlotType.wording); the slot is built again with the wording, and its
 * type reads the session's locale's entry when it fills and displays (parts/locale.ts wordingFor).
 * The questions never change: the model reads them as written, in every locale.
 *
 * locale/es/slots.yaml:
 *
 *   branch:
 *     options:
 *       north: Norte
 *       riverside: { say: Ribera }
 *   note:
 *     say: su nota
 */

/** The file a locale's slot wording is in, in the app folder. */
export const localeSlotsFile = (tag: string): string => `locale/${tag}/slots.yaml`;

export interface WordingInput {
  /** The slot as built from its options, with its type's name and parsed options. */
  spec: LibrarySlotSpec;
  /** The types to find the slot's type in. */
  types: SlotTypes;
  /** What each locale gives for the slot, by locale tag, as written (each locale's slots.yaml entry). */
  raw: Readonly<Record<string, unknown>>;
  /** Where each locale's entry was written, so a problem points at its line. Absent: the problems name the file and no line. */
  sources?: Readonly<Record<string, SlotSource>>;
}

export type WordingResult = { ok: true; spec: LibrarySlotSpec } | { ok: false; problems: Problem[] };

/**
 * The slots exactly as a library type built them (buildSlot, applySlotWording). A copy with a field
 * replaced in code (`{ ...slot, dtmf }`) is not one: built again from its options, it would lose the
 * change, so it takes no wording.
 */
const AS_BUILT = new WeakMap<object, SlotBuildEnv | undefined>();

/** Marks a slot as exactly what its type built (buildSlot calls this), with what the app gave its build, to build it again with. */
export function markBuilt<T extends object>(spec: T, env?: SlotBuildEnv): T {
  AS_BUILT.set(spec, env);
  return spec;
}

/** Whether a slot was built by a library type (it carries the type's name and its parsed options). */
export function isLibrarySlot(spec: unknown): spec is LibrarySlotSpec {
  if (typeof spec !== 'object' || spec === null) return false;
  const s = spec as { type?: unknown; config?: unknown };
  return typeof s.type === 'string' && typeof s.config === 'object' && s.config !== null;
}

/**
 * The slot built again with its wording by locale, or every problem with the wording: a type that
 * takes none, a key it does not know (an option the slot does not have), a value of the wrong kind.
 * Each problem is in its locale's file (`locale/<tag>/slots.yaml`) at the line when `sources` has it.
 */
export function applySlotWording(input: WordingInput): WordingResult {
  const { spec, types, raw } = input;
  const id = spec.id;
  const type = Object.hasOwn(types, spec.type) ? types[spec.type]! : undefined;
  const problems: Problem[] = [];
  const tags = Object.keys(raw);
  const sourceOf = (tag: string): SlotSource => input.sources?.[tag] ?? unlocated(id, raw[tag], localeSlotsFile(tag));
  const place = (tag: string, p: Problem): Problem => (input.sources?.[tag] ? p : { ...p, line: 0, column: 0 });
  const problem = (tag: string, path: DataPath, message: string, fix: string): Problem => {
    const src = sourceOf(tag);
    return place(tag, { file: src.file, ...keyPositionOf(src.doc, src.lines, [...src.at, ...path]), path: formatPath([...src.at, ...path]), message, fix });
  };

  if (type === undefined) {
    return { ok: false, problems: tags.map((tag) => problem(tag, [], `the slot "${id}" has the type "${spec.type}", which is not a slot type here, so its wording cannot be read`, 'register the type (registerSlotType) and pass it in the code\'s slotTypes')) };
  }
  if (!AS_BUILT.has(spec)) {
    return {
      ok: false,
      problems: tags.map((tag) =>
        problem(
          tag,
          [],
          `the slot "${id}" was built by the "${spec.type}" type and then changed in code (a copy with a field replaced), so ${localeSlotsFile(tag)} cannot give its wording: built again with it from its options, the slot would lose the change`,
          `build the slot with defineSlot (or in slots.yaml) and use it as built, or delete "${id}" from ${localeSlotsFile(tag)} and have the code's slot say its value by its locale`,
        ),
      ),
    };
  }
  if (type.wording === undefined) {
    return {
      ok: false,
      problems: tags.map((tag) =>
        problem(tag, [], `the slot "${id}" is a "${spec.type}" slot, which has no wording to give per locale: it says its values the same way in every locale, or formats them by locale itself`, `delete "${id}" from ${localeSlotsFile(tag)}`),
      ),
    };
  }
  const schema = type.wording(spec.config);
  const wording: Record<string, unknown> = {};
  for (const tag of tags) {
    const parsed = schema.safeParse(raw[tag]);
    if (parsed.success) {
      wording[tag] = parsed.data;
      continue;
    }
    const src = sourceOf(tag);
    const issues = parsed.error.issues.map((issue) => ({ ...issue, path: [...src.at, ...issue.path] }) as ZodIssue);
    problems.push(...problemsOfIssues(issues, { file: src.file, doc: src.doc, lines: src.lines, value: src.doc.toJS(), schema: nest(src.at, wordingJsonSchema(schema)) }).map((p) => place(tag, p)));
  }
  if (problems.length > 0) return { ok: false, problems };
  // The same slot with the same wording is built once, so two builds of one folder give the same App.
  const key = canonicalJson(wording);
  const cached = BUILT.get(spec)?.get(key);
  if (cached !== undefined && cached.type === type) return { ok: true, spec: cached.spec };
  const env = AS_BUILT.get(spec);
  const built = env === undefined ? type.build(id, spec.config, Object.freeze(wording)) : type.build(id, spec.config, Object.freeze(wording), env);
  // Where the slot listens is not the type's to build: it is carried over from the slot as built.
  const worded: LibrarySlotSpec = { ...built, type: spec.type, config: spec.config, wording: Object.freeze(wording), ...(spec.listen !== undefined ? { listen: spec.listen } : {}) };
  if (!BUILT.has(spec)) BUILT.set(spec, new Map());
  BUILT.get(spec)!.set(key, { type, spec: markBuilt(worded, env) });
  return { ok: true, spec: worded };
}

/** Each slot built again with a wording, by the slot as first built and the wording's canonical JSON. */
const BUILT = new WeakMap<LibrarySlotSpec, Map<string, { type: SlotType<any, any>; spec: LibrarySlotSpec }>>();

/** A source for wording given as an object: the entry as a document with no lines. */
function unlocated(id: string, value: unknown, file: string): SlotSource {
  return { file, doc: new Document({ [id]: value }), lines: new LineCounter(), at: [id] };
}

/** A wording schema as JSON Schema (draft-07, the input side), for a problem's list of the keys there are. */
function wordingJsonSchema(schema: z.ZodType): JsonSchema {
  try {
    return z.toJSONSchema(schema, { io: 'input', target: 'draft-7', unrepresentable: 'any' }) as JsonSchema;
  } catch {
    return { type: 'object' };
  }
}

/** `schema` placed at `at` inside maps of any keys, so a path from the file's root reaches it. */
function nest(at: DataPath, schema: JsonSchema): JsonSchema {
  return [...at].reverse().reduce<JsonSchema>((inner) => ({ type: 'object', additionalProperties: inner }), schema);
}

/** A type's general wording shape as JSON Schema, for the published locale slots schema; null for a type that takes none. */
export function slotTypeWordingJsonSchema(type: SlotType<any, any>): JsonSchema | null {
  if (type.wording === undefined) return null;
  const { $schema: _schema, ...rest } = wordingJsonSchema(type.wording());
  return rest;
}

/** Where a key of a locale's slots.yaml is, for a problem with the key itself. */
export function wordingKeyProblem(src: { file: string; doc: Document; lines: LineCounter } | undefined, file: string, path: DataPath, message: string, fix: string): Problem {
  const at = src ? keyPositionOf(src.doc, src.lines, path) : { line: 0, column: 0 };
  return { file, ...at, path: formatPath(path), message, fix };
}
