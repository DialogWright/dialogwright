import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { routesSchema } from './schema';

/**
 * Every routes.yaml block in the docs and the create-app skill (a fenced ```yaml block whose first line
 * names the file, `# routes.yaml`) is read by the schema that reads the real file, so an example cannot
 * drift from what the loader accepts, as the app.yaml and policy blocks cannot.
 */

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

function docFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules') continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.md')) out.push(path);
    }
  };
  walk(join(ROOT, 'docs'));
  walk(join(ROOT, 'apps'));
  walk(join(ROOT, '.claude', 'skills'));
  for (const file of ['README.md', 'CONTRIBUTING.md', 'CLAUDE.md']) out.push(join(ROOT, file));
  return out;
}

/** Each `# routes.yaml` block, with where it starts. */
function blocksOf(file: string): { where: string; value: unknown }[] {
  const text = readFileSync(file, 'utf8');
  const out: { where: string; value: unknown }[] = [];
  for (const m of text.matchAll(/```ya?ml\n([\s\S]*?)```/g)) {
    if (!/^#\s+routes\.yaml\b/.test(m[1]!.split('\n')[0] ?? '')) continue;
    out.push({ where: `${relative(ROOT, file)}:${text.slice(0, m.index).split('\n').length}`, value: parse(m[1]!) });
  }
  return out;
}

describe('the routes.yaml in the docs', () => {
  const blocks = docFiles().flatMap(blocksOf);

  it('is found in the authoring guide and the create-app skill', () => {
    expect(blocks.some((b) => b.where.startsWith('docs/guide/02-the-files-one-by-one.md:'))).toBe(true);
    expect(blocks.some((b) => b.where.startsWith('.claude/skills/create-app/'))).toBe(true);
  });

  it('reads, every block of it, as written', () => {
    const failed = blocks.flatMap((b) => {
      const r = routesSchema.safeParse(b.value);
      return r.success ? [] : r.error.issues.map((i) => `${b.where}: ${i.path.join('.')}: ${i.message}`);
    });
    expect(failed).toEqual([]);
  });

  it('would fail a block that is wrong (the check has teeth)', () => {
    expect(routesSchema.safeParse({ start: [{ when: { hours: 'closed' }, then: 'end' }] }).success).toBe(false);
  });
});
