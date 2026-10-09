import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { defineSlots } from './defineSlots';
import { BUILT_IN_SLOT_TYPES } from './registry';

/**
 * Every slots YAML block in the docs builds: a fenced ```yaml block whose entries have a `type` is a
 * slots.yaml (or a piece of one), and each of its library slots must build as written (a `code`
 * slot is the app's, so it is left out). So a doc example cannot drift from the types' options.
 */

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/** The markdown files whose examples an author copies: the repository's docs, its READMEs and CONTRIBUTING, each type's README, and the create-app skill's pages. */
function docFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.md')) out.push(path);
    }
  };
  walk(join(ROOT, 'docs'));
  walk(join(ROOT, '.claude', 'skills'));
  for (const file of ['README.md', 'CONTRIBUTING.md', 'packages/dialogwright/src/slots/README.md']) out.push(join(ROOT, file));
  for (const type of Object.keys(BUILT_IN_SLOT_TYPES)) out.push(join(ROOT, 'packages/dialogwright/src/slots', type, 'README.md'));
  return out;
}

interface Block {
  where: string;
  slots: Record<string, unknown>;
}

/** Each fenced YAML block that is a map of slots, with where it starts. */
function slotBlocks(file: string): Block[] {
  const text = readFileSync(file, 'utf8');
  const out: Block[] = [];
  for (const m of text.matchAll(/```ya?ml\n([\s\S]*?)```/g)) {
    let value: unknown;
    try {
      value = parse(m[1]!);
    } catch {
      continue;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const entries = Object.entries(value).filter(([, c]) => typeof c === 'object' && c !== null && typeof (c as { type?: unknown }).type === 'string');
    if (entries.length === 0) continue;
    const line = text.slice(0, m.index).split('\n').length;
    out.push({ where: `${relative(ROOT, file)}:${line}`, slots: Object.fromEntries(entries.filter(([, c]) => (c as { type: string }).type !== 'code')) });
  }
  return out;
}

describe('the slots YAML in the docs', () => {
  const blocks = docFiles().flatMap(slotBlocks);

  it('is found in the guides, the design, the library\'s READMEs and every type\'s page', () => {
    const files = new Set(blocks.map((b) => b.where.split(':')[0]));
    expect(blocks.length).toBeGreaterThan(30);
    for (const file of ['docs/design.md', 'docs/authoring-an-app.md', 'docs/slots/README.md', 'packages/dialogwright/src/slots/choice/README.md', 'docs/slots/choice.md', '.claude/skills/create-app/patterns.md']) expect(files, file).toContain(file);
  });

  it('builds, every block of it, as written', () => {
    const failed: string[] = [];
    for (const block of blocks) {
      try {
        defineSlots(block.slots, {});
      } catch (e) {
        failed.push(`${block.where}: ${(e as Error).message}`);
      }
    }
    expect(failed).toEqual([]);
  });
});
