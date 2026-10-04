import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import * as api from '../index';
import { loadKnowledgeFolder, parseKbFile } from '../define/load';
import { formsSchema, intentsSchema, promptsSchema } from '../define/schema';
import { excerptInSource, readApprovalLog } from './approval';
import { bakeoff, parseParaphrases } from './bakeoff';
import { sourceHashOf } from './hash';
import { defaultRetriever } from './hybrid';
import { kbStateProblems } from './rules';
import type { KbKind } from './schema';

/**
 * The knowledge base examples in the docs load, as the authoring guide's section 12 shows them. A
 * fenced YAML block whose first line is a comment naming a file of kb/ (`# kb/kb.yaml`,
 * `# kb/passages/opening-hours.yaml: why it is shown`) is read by the loader that reads that file,
 * against that file's schema; a ```jsonl block is the approvals log. The blocks of the guide's section
 * 12, the first for each path, are also put together into one kb/ folder (a library's: the files the
 * engine's own fixture has) and loaded as a knowledge base, which must have no problem, every passage
 * fresh (the hashes in the examples are the real ones), a log with a line for each passage's approval (check's rule), and
 * drafts whose excerpts are in their sections word for word. The form, intent and prompt blocks that
 * name their file (`# forms.yaml`) are held to its schema, the guide's test recipe's imports are the
 * root's exports, and its paraphrase file runs through the bake-off, so a doc example cannot drift
 * from what the engine accepts (as the slots and policy blocks cannot: slots/docBlocks.test.ts,
 * define/docPolicyBlocks.test.ts).
 */

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const read = (file: string): string => readFileSync(join(ROOT, file), 'utf8');

/** The markdown files whose kb examples an author copies. */
const FILES = ['docs/authoring-an-app.md', 'docs/design.md', 'README.md', 'CLAUDE.md', 'CONTRIBUTING.md', 'docs/slots/README.md', '.claude/skills/create-app/SKILL.md', '.claude/skills/create-app/patterns.md', '.claude/skills/create-app/worksheet.md'];

interface Block {
  where: string;
  lang: string;
  text: string;
  /** The file the first line names, from the app folder (`kb/passages/x.yaml`), or null. */
  path: string | null;
}

/** The path a block's first comment line names: `# kb/kb.yaml` or `# kb/kb.yaml, with an embedder` or `# forms.yaml: ...`. */
const pathOfFirstLine = (text: string): string | null => /^#\s+([A-Za-z0-9_./<>-]+\.(?:yaml|jsonl))\s*(?:[,:(].*)?$/.exec(text.split('\n')[0] ?? '')?.[1] ?? null;

function blocksOf(file: string, text: string = read(file), from = 0): Block[] {
  const out: Block[] = [];
  for (const m of text.matchAll(/^([ \t]*)```(ya?ml|jsonl|ts)\n([\s\S]*?)^[ \t]*```/gm)) {
    // A block in a list item is indented by its fence's own indent: take exactly that off each line.
    const indent = m[1]!;
    const body = m[3]!.split('\n').map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l)).join('\n');
    out.push({ where: `${file}:${from + text.slice(0, m.index).split('\n').length}`, lang: m[2]!, text: body, path: m[2] === 'ts' ? null : pathOfFirstLine(body) });
  }
  return out;
}

/** The guide's section 12, with the line it starts on. */
function section12(): { text: string; from: number } {
  const guide = read('docs/authoring-an-app.md');
  const at = guide.indexOf('\n## 12. The knowledge base');
  expect(at, 'the authoring guide has a section 12, "The knowledge base"').toBeGreaterThan(0);
  return { text: guide.slice(at), from: guide.slice(0, at).split('\n').length };
}

/** The kind of kb file a path names, or null when it is not one the loader knows. */
function kbKindOf(path: string): KbKind | 'rejected' | null {
  if (path === 'kb/kb.yaml') return 'kbSettings';
  if (path === 'kb/topics.yaml' || path === 'kb/pending/topics.yaml') return 'kbTopics';
  if (/^kb\/locale\/[^/]+\/topics\.yaml$/.test(path)) return 'kbLocaleTopics';
  if (/^kb\/passages\/[^/]+\.yaml$/.test(path) || /^kb\/locale\/[^/]+\/passages\/[^/]+\.yaml$/.test(path)) return 'kbPassage';
  if (/^kb\/sources\/[^/]+\.yaml$/.test(path)) return 'kbSource';
  if (/^kb\/pending\/[^/]+\.yaml$/.test(path)) return 'kbPending';
  if (/^kb\/rejected\/[^/]+\.yaml$/.test(path)) return 'rejected';
  return null;
}

const all = FILES.flatMap((f) => blocksOf(f));
const kbBlocks = all.filter((b) => b.lang !== 'ts' && b.path?.startsWith('kb/') && b.path !== 'kb/approvals.jsonl');

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe('the knowledge base files in the docs', () => {
  it('are in the authoring guide, one of each kind of file', () => {
    const kinds = new Set(blocksOf('docs/authoring-an-app.md', section12().text, section12().from).filter((b) => b.path !== null).map((b) => (b.path === 'kb/approvals.jsonl' ? 'log' : kbKindOf(b.path!))));
    for (const kind of ['kbSettings', 'kbTopics', 'kbLocaleTopics', 'kbPassage', 'kbSource', 'kbPending', 'rejected']) expect(kinds, kind).toContain(kind);
    expect(blocksOf('docs/authoring-an-app.md', section12().text, section12().from).some((b) => b.lang === 'jsonl')).toBe(true);
  });

  it('read, every block, as the file they name', () => {
    const failed: string[] = [];
    for (const b of kbBlocks) {
      const kind = kbKindOf(b.path!);
      if (kind === null) {
        failed.push(`${b.where}: ${b.path} is not a file of the knowledge base`);
        continue;
      }
      let text = b.text;
      let as: KbKind;
      if (kind === 'rejected') {
        const data = parse(text) as Record<string, unknown>;
        const rejected = data.rejected as Record<string, unknown> | undefined;
        if (!rejected || typeof rejected.by !== 'string' || typeof rejected.on !== 'string' || typeof rejected.reason !== 'string') failed.push(`${b.where}: a rejected draft says who (by), when (on) and why (reason)`);
        delete data.rejected;
        text = JSON.stringify(data);
        as = 'kbPending';
      } else as = kind;
      for (const p of parseKbFile(b.path!, as, text).problems) failed.push(`${b.where}: ${p.path} ${p.message} -> ${p.fix}`);
    }
    expect(failed).toEqual([]);
  });

  it('would fail a block that is wrong (the check has teeth)', () => {
    expect(parseKbFile('kb/kb.yaml', 'kbSettings', 'action: findPassage\nretreival: { cap: 8 }\n').problems.length).toBeGreaterThan(0);
    expect(parseKbFile('kb/passages/x.yaml', 'kbPassage', 'id: x\ntopic: t\nversion: "1"\neffective: { from: 2026-01-01 }\nsource: { document: d, section: "1" }\nanswer: Hello {name}.\nextra: 1\n').problems.length).toBeGreaterThan(0);
  });
});

describe('the guide\'s example knowledge base', () => {
  const { text, from } = section12();
  const blocks = blocksOf('docs/authoring-an-app.md', text, from);
  const dir = mkdtempSync(join(tmpdir(), 'dialogwright-doc-kb-'));
  scratch.push(dir);
  const kbDir = join(dir, 'kb');
  const written = new Set<string>();
  for (const b of blocks) {
    if (b.path === null || !b.path.startsWith('kb/') || written.has(b.path)) continue;
    written.add(b.path);
    mkdirSync(dirname(join(dir, b.path)), { recursive: true });
    writeFileSync(join(dir, b.path), b.text);
  }
  const log = blocks.find((b) => b.lang === 'jsonl');
  if (log) writeFileSync(join(kbDir, 'approvals.jsonl'), log.text);
  const loaded = loadKnowledgeFolder(kbDir);

  it('loads with no problem', () => {
    expect(loaded.problems.map((p) => `${p.file}: ${p.message}`)).toEqual([]);
    expect(loaded.kb).not.toBeNull();
    expect(Object.keys(loaded.kb!.topics).sort()).toEqual(['late_fees', 'opening_hours']);
    expect(Object.keys(loaded.kb!.passages).sort()).toEqual(['late-fees-adult', 'late-fees-junior', 'opening-hours', 'opening-hours-es']);
  });

  it('has every passage approved, with the hashes it has now', () => {
    for (const p of Object.values(loaded.kb!.passages)) expect(p.freshness, p.id).toBe('fresh');
  });

  it('has an approvals log whose lines are the passages\' approvals, and whose source text is the one approved', () => {
    const lines = readApprovalLog(kbDir);
    // One line for each passage: check holds every approval to a line of its id and hash.
    expect(lines.map((l) => l.id).sort()).toEqual(Object.keys(loaded.kb!.passages).sort());
    expect(kbStateProblems(loaded.kb!, '2026-10-03', loaded.locate).map((p) => `${p.file}: ${p.message}`)).toEqual([]);
    for (const line of lines) {
      const passage = loaded.kb!.passages[line.id]!;
      expect(passage, line.id).toBeDefined();
      expect(line.hash).toBe(passage.approval!.hash);
      expect(line.sourceHash).toBe(passage.approval!.sourceHash);
      if (line.sourceText !== undefined) expect(sourceHashOf(line.sourceText)).toBe(line.sourceHash);
    }
  });

  it('has drafts whose excerpts are in their sections word for word', () => {
    const drafts = blocks.filter((b) => b.path !== null && /^kb\/(pending|rejected)\/(?!topics)/.test(b.path));
    expect(drafts.length).toBeGreaterThanOrEqual(2);
    for (const b of drafts) {
      const draft = parse(b.text) as { source: { document: string; section: string }; drafted: { excerpt: string } };
      const section = loaded.kb!.sources[draft.source.document]?.sections[draft.source.section];
      expect(section, b.where).toBeDefined();
      expect(excerptInSource(draft.drafted.excerpt, section!.text), b.where).toBe(true);
    }
  });

  it('is found by the engine\'s retriever, on the guide\'s own paraphrases (its recall test)', async () => {
    const file = blocks.find((b) => b.path === 'fixtures/kb/paraphrases.yaml');
    expect(file, 'the guide shows a paraphrase file').toBeDefined();
    const paraphrases = parseParaphrases(file!.text, loaded.kb!);
    const result = await bakeoff(defaultRetriever(loaded.kb!).retriever, paraphrases, 'en-US', '2026-10-03');
    expect(result.recall).toBeGreaterThanOrEqual(0.9);
    expect(result.noneCandidates).toBeLessThanOrEqual(2);
  });
});

describe('the other examples of section 12', () => {
  const { text, from } = section12();
  const blocks = blocksOf('docs/authoring-an-app.md', text, from);

  it('hold forms, intents and prompts to their schemas', () => {
    const schemas = { 'forms.yaml': formsSchema, 'intents.yaml': intentsSchema, 'prompts.yaml': promptsSchema } as const;
    const seen = new Set<string>();
    const failed: string[] = [];
    for (const b of blocks) {
      if (b.path === null || !Object.hasOwn(schemas, b.path)) continue;
      seen.add(b.path);
      let data: unknown = parse(b.text);
      // An intents example shows only the intents it is about: put them in the library's file, which has the control intents and the menu.
      if (b.path === 'intents.yaml') {
        const fixture = parse(read('packages/dialogwright/src/define/fixture/intents.yaml')) as { intents: Record<string, unknown> };
        data = { ...fixture, intents: { ...fixture.intents, ...(data as { intents: Record<string, unknown> }).intents } };
      }
      const result = schemas[b.path as keyof typeof schemas].safeParse(data);
      if (!result.success) failed.push(`${b.where}: ${result.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    }
    expect([...seen].sort()).toEqual(['forms.yaml', 'intents.yaml', 'prompts.yaml']);
    expect(failed).toEqual([]);
  });

  it('use only what the root exports', () => {
    const exported = new Set(Object.keys(api));
    const missing: string[] = [];
    for (const b of blocks.filter((x) => x.lang === 'ts')) {
      for (const m of b.text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'dialogwright'/g)) {
        for (const name of m[1]!.split(',').map((n) => n.trim()).filter(Boolean)) if (!exported.has(name)) missing.push(`${b.where}: ${name}`);
      }
    }
    expect(missing).toEqual([]);
    expect(blocks.some((b) => b.lang === 'ts' && b.text.includes('bakeoff('))).toBe(true);
    expect(blocks.some((b) => b.lang === 'ts' && b.text.includes('kbAnswerTool('))).toBe(true);
    for (const name of ['kbAnswerTool', 'kbCompletion', 'bakeoff', 'defaultRetriever', 'loadKnowledgeFolder', 'parseParaphrases']) expect(exported, name).toContain(name);
  });
});

describe('where the docs say the knowledge base is', () => {
  it('has the guide\'s section 12 in its contents, and the other docs name its commands', () => {
    const guide = read('docs/authoring-an-app.md');
    expect(guide).toContain('12. [The knowledge base](#12-the-knowledge-base)');
    for (const file of ['README.md', 'llms.txt', 'CLAUDE.md']) {
      const doc = read(file);
      for (const command of ['kb:ingest', 'kb:draft', 'kb:review', 'kb:approve']) expect(doc, `${file} ${command}`).toContain(command);
    }
  });
});
