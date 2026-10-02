import { z } from 'zod';
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

/** A JSON Schema as it is written to schemas/<kind>.schema.json: two-space indent and a final newline. */
export function serializeSchema(schema: JsonSchema): string {
  return `${JSON.stringify(schema, null, 2)}\n`;
}
