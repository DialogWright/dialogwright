import { z } from 'zod';
import { slotTypeJsonSchema } from '../../slots/defineSlot';
import { BUILT_IN_SLOT_TYPES } from '../../slots/registry';
import type { SlotTypes } from '../../slots/types';
import { CODE_SLOT_TYPE } from './slots';
import { FILE_KINDS, SCHEMAS, type FileKind } from './index';

/** A JSON Schema document, as zod generates it. */
export type JsonSchema = Record<string, unknown>;

/**
 * The JSON Schema for one kind of file. Generated from the input side (what an author writes), so a
 * field with a default is optional; draft-07 because the editors' YAML language servers read it best.
 */
export function jsonSchemaFor(kind: FileKind): JsonSchema {
  const generated = z.toJSONSchema(SCHEMAS[kind], { io: 'input', target: 'draft-7' }) as JsonSchema;
  return { ...generated, title: `DialogWright ${kind}.yaml` };
}

/** Every kind's JSON Schema, keyed by kind. */
export function jsonSchemas(): Record<FileKind, JsonSchema> {
  return Object.fromEntries(FILE_KINDS.map((kind) => [kind, jsonSchemaFor(kind)])) as Record<FileKind, JsonSchema>;
}

/**
 * slots.yaml's JSON Schema: a map of slot ids to one of the types' schemas, each requiring its `type`
 * (a discriminated union, so an editor offers the options of the type the author wrote), and
 * `{ type: code }`. The committed schema (schemas/slots.schema.json) has the built-in types; an app
 * that registers its own types can generate one with them (`slotsJsonSchema(registerSlotType(...))`).
 */
export function slotsJsonSchema(types: SlotTypes = BUILT_IN_SLOT_TYPES): JsonSchema {
  const branch = (type: SlotTypes[string]): JsonSchema => {
    const { $schema: _schema, ...rest } = slotTypeJsonSchema(type);
    const described = typeof rest.description === 'string' || !type.describe ? rest : { ...rest, description: type.describe.summary };
    return { ...described, required: ['type', ...(((rest.required as string[] | undefined) ?? []).filter((key) => key !== 'type'))] };
  };
  const code: JsonSchema = {
    type: 'object',
    properties: { type: { type: 'string', const: CODE_SLOT_TYPE, description: 'The slot is written in code: code.slots.<id>.' } },
    required: ['type'],
    additionalProperties: false,
    description: 'A slot the app\'s code writes (code.slots.<id>), listed here so slots.yaml names every slot and sets their order.',
  };
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'DialogWright slots.yaml',
    description: 'The app\'s slots by id, in the order they are filled and acknowledged. Lists every slot the app has: a library type with its options, or { type: code } for a slot the code writes.',
    type: 'object',
    propertyNames: { pattern: '^[A-Za-z][A-Za-z0-9_]*$' },
    additionalProperties: { oneOf: [...Object.values(types).map(branch), code] },
  };
}

/** A JSON Schema as it is written to schemas/<kind>.schema.json: two-space indent and a final newline. */
export function serializeSchema(schema: JsonSchema): string {
  return `${JSON.stringify(schema, null, 2)}\n`;
}
