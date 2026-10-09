import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { withParentKey } from '../testing/docBlocks';
import { formsSchema } from './schema';

/**
 * Every forms.yaml block in the docs and the create-app skill is read by the schema that reads the
 * real file, so a doc example of a form (its checks, `next`, an internal form) cannot drift from what
 * the loader accepts, as the policy, identity, app, intents and slots blocks cannot
 * (docPolicyBlocks.test.ts, docAppBlocks.test.ts, slots/docBlocks.test.ts). A fenced ```yaml block is
 * a forms.yaml when its one key is `forms`, or a piece of one under `# forms.yaml, under forms:`. A
 * block that elides a part with `[...]` shows a shape, not a file, and is left out.
 */

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/** The markdown files whose examples an author copies: the docs, the apps' pages, the root's pages and the create-app skill's. */
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

interface Block {
  where: string;
  value: unknown;
}

const isMap = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Each fenced YAML block that is a forms.yaml (or a piece of one), with where it starts. */
function blocksOf(file: string): Block[] {
  const text = readFileSync(file, 'utf8');
  const out: Block[] = [];
  for (const m of text.matchAll(/^([ \t]*)```ya?ml\n([\s\S]*?)^[ \t]*```/gm)) {
    const indent = m[1]!;
    const raw = m[2]!.split('\n').map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l)).join('\n');
    if (raw.includes('[...]')) continue;
    let value: unknown;
    try {
      value = parse(withParentKey(raw));
    } catch {
      continue;
    }
    if (!isMap(value) || Object.keys(value).length !== 1 || !('forms' in value)) continue;
    out.push({ where: `${relative(ROOT, file)}:${text.slice(0, m.index).split('\n').length}`, value });
  }
  return out;
}

/** What the schema says is wrong with a block, one line each: its path and the message. */
function problemsOfBlock(value: unknown): string[] {
  const result = formsSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}

describe('the forms.yaml in the docs and the skill', () => {
  const blocks = docFiles().flatMap(blocksOf);

  it('is found in the authoring guide and the create-app skill', () => {
    const files = new Set(blocks.map((b) => b.where.split(':')[0]));
    for (const file of ['docs/authoring-an-app.md', '.claude/skills/create-app/patterns.md']) expect(files, file).toContain(file);
    expect(blocks.length).toBeGreaterThanOrEqual(10);
  });

  it('reads, every block of it, as written', () => {
    const failed = blocks.flatMap((b) => problemsOfBlock(b.value).map((p) => `${b.where}: ${p}`));
    expect(failed).toEqual([]);
  });

  it('would fail a block that is wrong (the check has teeth)', () => {
    expect(problemsOfBlock({ forms: { f: { slots: [], summaryPromptId: null, hooks: ['complete'], nxt: 'g' } } }).length).toBeGreaterThan(0);
    expect(problemsOfBlock({ forms: { f: { slots: [], summaryPromptId: null, checks: [{ action: 'c', with: ['x'], on: { r: { then: 'stop' } } }] } } }).length).toBeGreaterThan(0);
  });
});
