import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXAMPLES_MARKER, OPTIONS_MARKER, renderSlotPage, SLOT_DOCS_DIR, SLOTS_SRC, slotPages } from '../../scripts/slotDocs';
import { slotTypeJsonSchema } from './defineSlot';
import { BUILT_IN_SLOT_TYPES } from './registry';

/**
 * The slot docs pages (docs/slots/<type>.md) are generated from each type's README (the hand-written
 * source), its options schema and its examples. A page that was not regenerated after a change fails
 * here, as a stale JSON Schema does (define/schema/schema.test.ts).
 */

const TYPES = Object.keys(BUILT_IN_SLOT_TYPES);
const read = (file: string): string => readFileSync(file, 'utf8');
const REGENERATE = 'run `pnpm --filter dialogwright slot-docs` and commit the result';

describe('the slot docs pages', () => {
  it('are what the generator writes now', async () => {
    const pages = await slotPages();
    for (const [file, generated] of Object.entries(pages)) {
      expect(read(join(SLOT_DOCS_DIR, file)), `docs/slots/${file} is stale: ${REGENERATE}`).toBe(generated);
    }
  });

  it('exist for every built-in type, and for no type that is not one', () => {
    const files = readdirSync(SLOT_DOCS_DIR).filter((f) => f !== 'README.md').sort();
    expect(files, `a page per built-in type, and nothing else, in docs/slots/ (${REGENERATE})`).toEqual(TYPES.map((t) => `${t}.md`).sort());
  });

  it('name every option, every text part and every question id of the type', async () => {
    const pages = await slotPages();
    for (const type of Object.values(BUILT_IN_SLOT_TYPES)) {
      const page = pages[`${type.type}.md`]!;
      const schema = slotTypeJsonSchema(type) as { properties: Record<string, { properties?: Record<string, unknown> }> };
      for (const [option, s] of Object.entries(schema.properties)) {
        if (option === 'type') continue;
        expect(page, `${type.type}: the option ${option}`).toContain(`\`${option}\``);
        for (const part of Object.keys(s.properties ?? {})) expect(page, `${type.type}: ${option}.${part}`).toContain(`\`${option}.${part}\``);
      }
    }
  });

  it('are made from a README that says where the generated parts go', () => {
    for (const type of TYPES) {
      const readme = read(join(SLOTS_SRC, type, 'README.md'));
      expect(readme.split(OPTIONS_MARKER), `${type}/README.md needs the line ${OPTIONS_MARKER} once`).toHaveLength(2);
      expect(readme.split(EXAMPLES_MARKER), `${type}/README.md needs the line ${EXAMPLES_MARKER} once`).toHaveLength(2);
    }
    expect(() => renderSlotPage(BUILT_IN_SLOT_TYPES.text!, '# `text`\n\nNo markers.\n', [])).toThrow(OPTIONS_MARKER);
  });

  it('link every built-in type from the index, and say why each deferred type is deferred', () => {
    const index = read(join(SLOT_DOCS_DIR, 'README.md'));
    for (const type of TYPES) expect(index, `docs/slots/README.md needs a link to ${type}.md`).toContain(`(${type}.md)`);
    for (const deferred of ['otp', 'topic', 'time-slot']) expect(index, `docs/slots/README.md should list the deferred type ${deferred}`).toContain(`\`${deferred}\``);
  });
});
