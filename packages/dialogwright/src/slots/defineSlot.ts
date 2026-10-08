import { Document, LineCounter } from 'yaml';
import { z, type ZodIssue } from 'zod';
import { clashMessage, declaredQuestionIdClashes } from '../core/questionIds';
import { closest, formatPath, keyPositionOf, positionOf, problemsOfIssues, type DataPath, type Problem } from '../define/problems';
import type { JsonSchema } from '../define/schema/json';
import { LISTEN_DESCRIPTION, LISTEN_OPTION, OFFER_AT_DESCRIPTION, OFFER_AT_OPTION, OFFER_DESCRIPTION, OFFER_OPTION, slotListenSchema, slotOfferAtSchema, slotOfferSchema } from '../define/schema/slots';
import { SLOT_LISTEN_VALUES, SLOT_OFFER_AT_VALUES } from '../core/slots/types';
import { BUILT_IN_SLOT_TYPES } from './registry';
import type { TopicCatalog } from '../kb/types';
import type { LibrarySlotSpec, SlotBuildEnv, SlotType, SlotTypes } from './types';
import { applySlotWording, markBuilt } from './wording';

/**
 * A slot from configuration: `defineSlot('note', { type: 'text', what: 'a note for the courier' })`.
 * The configuration is checked against its type's options schema, and anything wrong comes back
 * as problems in the app loader's format (`file:line:column  path  message  ->  fix`), each with a
 * fix; the slot is then built by the type and carries the type's name and its parsed options.
 */

/** Where a slot's configuration was written, so its problems point at the line. */
export interface SlotSource {
  /** The file, as problems name it ("slots.yaml"). */
  file: string;
  doc: Document;
  lines: LineCounter;
  /** The path to the slot's configuration in the file (`["note"]` for a slot keyed by its id at the top). */
  at: DataPath;
}

export interface BuildSlotOptions {
  /** The slot types to look the configuration's `type` up in. Default: the built-in ones. */
  types?: SlotTypes;
  /** Where the configuration was written. Absent: problems name `file` (default "(code)") and no line. */
  source?: SlotSource;
  file?: string;
  /**
   * The slot's wording by locale tag, as a locale's slots.yaml writes it (`{ es: { options: { north:
   * Norte } } }`): checked against the type's wording schema and given to the type's build
   * (./wording.ts). Absent: the slot says its values in its options' words in every locale.
   */
  wording?: Readonly<Record<string, unknown>>;
  /** Where each locale's wording was written, so its problems point at the line. */
  wordingSources?: Readonly<Record<string, SlotSource>>;
  /**
   * The app's knowledge topics (kb/catalog.ts topicCatalog), given to the type's build
   * (SlotBuildEnv.catalog): a `topic` slot says a topic by its title and knows the topics there are.
   * Absent: the slot is built with none.
   */
  catalog?: TopicCatalog;
}

/** What defineSlot builds a slot with beyond its configuration. */
export interface DefineSlotOptions {
  /** The app's knowledge topics (BuildSlotOptions.catalog). */
  catalog?: TopicCatalog;
}

export type BuildSlotResult = { ok: true; spec: LibrarySlotSpec } | { ok: false; problems: Problem[] };

/** A slot configuration that is not valid, with every problem found. */
export class SlotConfigError extends Error {
  readonly problems: readonly Problem[];

  constructor(id: string, problems: readonly Problem[]) {
    const count = `${problems.length} problem${problems.length === 1 ? '' : 's'}`;
    super(`the slot "${id}" is not valid (${count}):\n${problems.map((p) => `  ${formatLine(p)}`).join('\n')}`);
    this.name = 'SlotConfigError';
    this.problems = problems;
  }
}

/** Whether `error` is a SlotConfigError (by name, so a second copy of this module is recognized too). */
export function isSlotConfigError(error: unknown): error is SlotConfigError {
  return error instanceof Error && error.name === 'SlotConfigError' && Array.isArray((error as { problems?: unknown }).problems);
}

const formatLine = (p: Problem): string => `${p.line > 0 ? `${p.file}:${p.line}:${p.column}` : p.file}  ${p.path}  ${p.message}  ->  ${p.fix}`;

/**
 * The slot `id` built from `config` (its `type` and that type's options), or throws a
 * SlotConfigError listing every problem. `types` adds an app's own types (registerSlotType).
 */
export function defineSlot(id: string, config: unknown, types: SlotTypes = BUILT_IN_SLOT_TYPES, options: DefineSlotOptions = {}): LibrarySlotSpec {
  const result = buildSlot(id, config, { types, ...(options.catalog !== undefined ? { catalog: options.catalog } : {}) });
  if (!result.ok) throw new SlotConfigError(id, result.problems);
  return result.spec;
}

const SLOT_ID = /^[A-Za-z][A-Za-z0-9_]*$/;
const isPlainObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** defineSlot without the throw: the slot, or every problem with its configuration. */
export function buildSlot(id: string, config: unknown, options: BuildSlotOptions = {}): BuildSlotResult {
  const types = options.types ?? BUILT_IN_SLOT_TYPES;
  const src = options.source ?? unlocated(id, config, options.file ?? '(code)');
  const located = options.source !== undefined;
  const at = src.at;
  const place = (p: Problem): Problem => (located ? p : { ...p, line: 0, column: 0 });
  const problem = (path: DataPath, message: string, fix: string, onKey = false): Problem =>
    place({
      file: src.file,
      ...(onKey ? keyPositionOf(src.doc, src.lines, [...at, ...path]) : positionOf(src.doc, src.lines, [...at, ...path])),
      path: formatPath([...at, ...path]),
      message,
      fix,
    });
  const names = Object.keys(types);
  const oneOf = names.map((n) => `"${n}"`).join(', ');

  if (!SLOT_ID.test(id)) {
    return fail(problem([], `the slot id "${id}" is not valid: it must start with a letter and use only letters, digits and underscores`, 'rename the slot using only letters, digits and underscores, starting with a letter', true));
  }
  if (!isPlainObject(config)) {
    return fail(problem([], `the slot "${id}" must be a map with a "type" and that type's options`, `write it as indented "key: value" lines, starting with "type:" (one of ${oneOf})`));
  }
  const name = config.type;
  if (name === undefined) {
    return fail(problem([], `required key "type" is missing under ${formatPath(at)}`, `add "type:" with one of ${oneOf}`));
  }
  if (typeof name !== 'string' || !Object.hasOwn(types, name)) {
    const guess = typeof name === 'string' ? closest(name, names) : undefined;
    return fail(
      problem(['type'], `"type" is ${JSON.stringify(name)}, which is not a slot type here; the types are ${oneOf}`, guess ? `change it to "${guess}"` : `use one of ${oneOf}, or register the type and pass it to defineSlot`),
    );
  }
  const type = types[name]!;
  // `listen`, `offer` and `offerAt` are every slot's, read here beside `type`; the rest are the type's own options.
  const { type: _type, [LISTEN_OPTION]: listen, [OFFER_OPTION]: offer, [OFFER_AT_OPTION]: offerAt, ...rest } = config;
  const parsed = type.options.safeParse(rest);
  const heard = listen === undefined ? null : slotListenSchema.safeParse(listen);
  const offered = offer === undefined ? null : slotOfferSchema.safeParse(offer);
  const offeredAt = offerAt === undefined ? null : slotOfferAtSchema.safeParse(offerAt);
  if (!parsed.success || heard?.success === false || offered?.success === false || offeredAt?.success === false) {
    const raw = [
      ...(parsed.success ? [] : parsed.error.issues),
      ...(heard === null || heard.success ? [] : heard.error.issues.map((issue) => ({ ...issue, path: [LISTEN_OPTION, ...issue.path] }))),
      ...(offered === null || offered.success ? [] : offered.error.issues.map((issue) => ({ ...issue, path: [OFFER_OPTION, ...issue.path] }))),
      ...(offeredAt === null || offeredAt.success ? [] : offeredAt.error.issues.map((issue) => ({ ...issue, path: [OFFER_AT_OPTION, ...issue.path] }))),
    ];
    const issues = raw.map((issue) => ({ ...issue, path: [...at, ...issue.path] }) as ZodIssue);
    const problems = problemsOfIssues(issues, { file: src.file, doc: src.doc, lines: src.lines, value: src.doc.toJS(), schema: nest(at, schemaOf(type)) });
    return { ok: false, problems: problems.map(place) };
  }

  const env: SlotBuildEnv | undefined = options.catalog !== undefined ? { catalog: options.catalog } : undefined;
  const built = env === undefined ? type.build(id, parsed.data) : type.build(id, parsed.data, undefined, env);
  if (built.id !== id) throw new Error(`the "${name}" type built a slot with the id "${built.id}" for the slot "${id}"`);
  if (!Array.isArray(built.questionIds) || !Array.isArray(built.prompts)) {
    throw new Error(`the "${name}" type built the slot "${id}" without questionIds and prompts; a library type declares both`);
  }
  const ids = isPlainObject(rest.ids) ? rest.ids : {};
  const clashes = declaredQuestionIdClashes({ [id]: built }).map((clash) => {
    const part = Object.keys(ids).find((p) => ids[p] === clash.id);
    return part !== undefined
      ? problem(['ids', part], clashMessage(clash), `give the "${part}" question another id`)
      : problem([], clashMessage(clash), 'rename the slot, or give the question another id under "ids"', true);
  });
  if (clashes.length > 0) return { ok: false, problems: clashes };

  const spec: LibrarySlotSpec = markBuilt({ ...built, type: name, config: Object.freeze(parsed.data), ...(heard?.success ? { listen: heard.data } : {}), ...(offered?.success ? { offer: offered.data } : {}), ...(offeredAt?.success ? { offerAt: offeredAt.data } : {}) }, env);
  if (options.wording === undefined || Object.keys(options.wording).length === 0) return { ok: true, spec };
  return applySlotWording({ spec, types, raw: options.wording, ...(options.wordingSources ? { sources: options.wordingSources } : {}) });
}

const fail = (p: Problem): BuildSlotResult => ({ ok: false, problems: [p] });

/** A source for a configuration given in code: the configuration as a document with no lines. */
function unlocated(id: string, config: unknown, file: string): SlotSource {
  return { file, doc: new Document({ [id]: config }), lines: new LineCounter(), at: [id] };
}

/** Each type's JSON Schema, with `type` added: what an unknown key's fix lists the known keys from. */
const SCHEMAS = new WeakMap<SlotType<any, any>, JsonSchema>();

function schemaOf(type: SlotType<any, any>): JsonSchema {
  let schema = SCHEMAS.get(type);
  if (schema) return schema;
  try {
    schema = z.toJSONSchema(type.options, { io: 'input', target: 'draft-7', unrepresentable: 'any' }) as JsonSchema;
  } catch {
    schema = { type: 'object' };
  }
  const properties = {
    type: { type: 'string', const: type.type, description: 'The slot type.' },
    ...((schema.properties as object | undefined) ?? {}),
    [LISTEN_OPTION]: { type: 'string', enum: [...SLOT_LISTEN_VALUES], default: 'up-front', description: LISTEN_DESCRIPTION },
    [OFFER_OPTION]: { type: 'string', enum: ['facts'], description: OFFER_DESCRIPTION },
    [OFFER_AT_OPTION]: { type: 'string', enum: [...SLOT_OFFER_AT_VALUES], default: 'slot', description: OFFER_AT_DESCRIPTION },
  };
  schema = { ...schema, properties };
  SCHEMAS.set(type, schema);
  return schema;
}

/** `schema` placed at `at` inside maps of any keys, so a path from the file's root reaches it. */
function nest(at: DataPath, schema: JsonSchema): JsonSchema {
  return [...at].reverse().reduce<JsonSchema>((inner) => ({ type: 'object', additionalProperties: inner }), schema);
}

/** A type's options as a JSON Schema (draft-07, the input side), for its docs page and an editor. */
export function slotTypeJsonSchema(type: SlotType<any, any>): JsonSchema {
  return schemaOf(type);
}
