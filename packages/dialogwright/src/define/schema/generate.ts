/**
 * Writes the JSON Schemas to packages/dialogwright/schemas/<kind>.schema.json.
 * Run with `pnpm --filter dialogwright schemas`; a test fails when the committed files are stale.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jsonSchemas, kbJsonSchemas, localeSlotsJsonSchema, serializeSchema, slotsJsonSchema } from './json';

/** Where the JSON Schemas are committed. */
export const SCHEMAS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'schemas');

function main(): void {
  mkdirSync(SCHEMAS_DIR, { recursive: true });
  for (const [kind, schema] of Object.entries({ ...jsonSchemas(), slots: slotsJsonSchema(), 'locale-slots': localeSlotsJsonSchema(), ...kbJsonSchemas() })) {
    const file = join(SCHEMAS_DIR, `${kind}.schema.json`);
    writeFileSync(file, serializeSchema(schema));
    console.log(`wrote ${file}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
