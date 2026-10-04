import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { z } from 'zod';
import { appSchema, intentsSchema } from './schema';

/**
 * Every app.yaml and intents.yaml block in the docs is read by the schema that reads the real file, so
 * a doc example (the phone's languages and voices, a language-switch intent) cannot drift from what
 * the loader accepts, as the policy, identity, slots and kb blocks cannot (docPolicyBlocks.test.ts,
 * slots/docBlocks.test.ts, kb/docBlocks.test.ts).
 *
 * A fenced ```yaml block is an app.yaml when its keys are app.yaml's and one is app.yaml's alone (not
 * `prompts`, which prompts.yaml has too, or `wording`, which policy.yaml has), or when its first line
 * names the file (`# app.yaml`); it is an intents.yaml when it has `intents`. A block that shows both
 * is split by its keys. A piece of an app.yaml with no `id` is given one, and an intents example is
 * read inside the library fixture's intents.yaml (which has the control intents and the menu), so a
 * fragment is checked as a fragment.
 */

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/** The markdown files whose examples an author copies: the repository's docs, READMEs and CONTRIBUTING. */
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
  walk(join(ROOT, 'packages/widget'));
  for (const file of ['README.md', 'CONTRIBUTING.md', 'CLAUDE.md']) out.push(join(ROOT, file));
  return out;
}

type Kind = 'app' | 'intents';

interface Block {
  kind: Kind;
  where: string;
  value: Record<string, unknown>;
}

const isMap = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const APP_KEYS = Object.keys(appSchema.shape);
const INTENTS_KEYS = Object.keys(intentsSchema.shape);

/** The file a block's first comment line names (`# app.yaml`, `# intents.yaml: why`), or null. */
const named = (text: string): string | null => /^#\s+([A-Za-z0-9_./<>-]+\.yaml)\b/.exec(text.split('\n')[0] ?? '')?.[1] ?? null;

/** app.yaml's keys that no other file has: `prompts` is prompts.yaml's too, and `wording` policy.yaml's. */
const APP_ONLY = APP_KEYS.filter((k) => k !== 'prompts' && k !== 'wording');

/**
 * The app.yaml and intents.yaml pieces of a block. A block may show both files (the guide's `unsure`
 * example does, each under its own comment), so its keys are split between them; a block with a key
 * neither file has, or that names another file, is another file's.
 */
function piecesOf(text: string, value: unknown): { kind: Kind; value: Record<string, unknown> }[] {
  if (!isMap(value)) return [];
  const file = named(text);
  if (file !== null && file !== 'app.yaml' && file !== 'intents.yaml') return [];
  const keys = Object.keys(value);
  if (keys.length === 0 || !keys.every((k) => APP_KEYS.includes(k) || INTENTS_KEYS.includes(k))) return [];
  const pick = (from: readonly string[]) => Object.fromEntries(keys.filter((k) => from.includes(k)).map((k) => [k, value[k]]));
  const out: { kind: Kind; value: Record<string, unknown> }[] = [];
  if (keys.includes('intents')) out.push({ kind: 'intents', value: pick(INTENTS_KEYS) });
  if (keys.some((k) => APP_ONLY.includes(k)) || (file === 'app.yaml' && keys.some((k) => APP_KEYS.includes(k)))) out.push({ kind: 'app', value: pick(APP_KEYS) });
  return out;
}

/** Each fenced YAML block's app.yaml and intents.yaml pieces, with where the block starts. */
function blocksOf(file: string): Block[] {
  const text = readFileSync(file, 'utf8');
  const out: Block[] = [];
  for (const m of text.matchAll(/```ya?ml\n([\s\S]*?)```/g)) {
    let value: unknown;
    try {
      value = parse(m[1]!);
    } catch {
      continue;
    }
    const where = `${relative(ROOT, file)}:${text.slice(0, m.index).split('\n').length}`;
    for (const piece of piecesOf(m[1]!, value)) out.push({ ...piece, where });
  }
  return out;
}

/** The library fixture's intents.yaml: an intents example shows only the intents it is about, and is read in that file, which has the control intents and the menu. */
const FIXTURE_INTENTS = parse(readFileSync(join(ROOT, 'packages/dialogwright/src/define/fixture/intents.yaml'), 'utf8')) as { intents: Record<string, unknown> };

/** What the file's schema says is wrong with a block, one line each: its path and the message. */
export function problemsOfBlock(block: Pick<Block, 'kind' | 'value'>): string[] {
  const schema: z.ZodType = block.kind === 'app' ? appSchema : intentsSchema;
  const value = block.kind === 'app'
    ? ('id' in block.value ? block.value : { id: 'doc-example', ...block.value })
    : { ...FIXTURE_INTENTS, ...block.value, intents: { ...FIXTURE_INTENTS.intents, ...(isMap(block.value.intents) ? block.value.intents : {}) } };
  const result = schema.safeParse(value);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}

describe('the app.yaml and intents.yaml in the docs', () => {
  const blocks = docFiles().flatMap(blocksOf);
  const guide = (kind: Kind) => blocks.filter((b) => b.kind === kind && b.where.startsWith('docs/authoring-an-app.md:'));

  it('is found in the authoring guide, the phone\'s languages and a language switch among them', () => {
    expect(guide('app').length).toBeGreaterThanOrEqual(2);
    expect(guide('intents').length).toBeGreaterThanOrEqual(2);
    const voice = guide('app').find((b) => isMap(b.value.voice) && isMap(b.value.voice.locales));
    expect(voice, 'a voice.locales block').toBeDefined();
    const locales = (voice!.value.voice as { locales: Record<string, { voices?: Record<string, unknown> }> }).locales;
    // A Twilio voice with its own provider is shown, as well as a name alone.
    expect(Object.values(locales).some((l) => isMap(l.voices?.twilio))).toBe(true);
    expect(guide('intents').some((b) => isMap(b.value.intents) && Object.values(b.value.intents).some((i) => isMap(i) && typeof i.locale === 'string'))).toBe(true);
  });

  it('reads, every block of it, as written', () => {
    const failed = blocks.flatMap((b) => problemsOfBlock(b).map((p) => `${b.where}: ${p}`));
    expect(failed).toEqual([]);
  });

  it('would fail a block that is wrong (the check has teeth)', () => {
    expect(problemsOfBlock({ kind: 'app', value: { voice: { locales: { es: { voices: { twilio: { voice: 'es-US-Neural2-A', provider: 'Gogle' } } } } } } }).length).toBeGreaterThan(0);
    expect(problemsOfBlock({ kind: 'app', value: { voice: { numbers: { '555-0142': 'es' } } } }).length).toBeGreaterThan(0);
    expect(problemsOfBlock({ kind: 'intents', value: { intents: { spanish: { kind: 'informational', label: 'x', criteria: 'x', locale: 'not a tag' } } } }).length).toBeGreaterThan(0);
  });
});
