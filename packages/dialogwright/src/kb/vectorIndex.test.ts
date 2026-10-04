import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FIXTURES, libraryKb } from './__fixtures__/library';
import { syntheticEmbedder } from './__fixtures__/syntheticModel';
import { kbIndexCommand } from './commands';
import { POTION_BASE_8M } from './embed/model';
import type { Embedder } from './embed/types';
import type { KnowledgeBase } from './types';
import { buildIndex, decodeVector, encodeVector, indexDrift, parseIndex, serializeIndex } from './vectorIndex';

/**
 * The vector index file (kb/.index/<embedder>.json) and `kb:index`, with the synthetic model
 * (./__fixtures__/syntheticModel.ts) in place of the real weights: its encoding, its fixed shape,
 * that rebuilding it gives the same bytes, and that a rebuild embeds only the texts that changed.
 */

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'dw-index-'));
  scratch.push(dir);
  return dir;
};

describe('the index file (kb/.index/<embedder>.json)', () => {
  it('stores each vector as float32 little-endian base64', () => {
    const v = [0.25, -1, 3.5, 1e-7];
    expect(Array.from(decodeVector(encodeVector(v), 4)!)).toEqual(v.map(Math.fround));
    expect(decodeVector(encodeVector(v), 3)).toBeNull();
    expect(decodeVector('not base64!', 4)).toBeNull();
  });

  it('is deterministic: building it twice gives the same bytes, and a rebuild re-embeds only the texts that changed', async () => {
    const embedder = syntheticEmbedder();
    const calls: number[] = [];
    const counting: Embedder = { id: embedder.id, revision: embedder.revision, sha256: embedder.sha256, dim: embedder.dim, embed: (texts) => (calls.push(texts.length), embedder.embed(texts)) };
    const first = await buildIndex(libraryKb(), counting);
    const second = await buildIndex(libraryKb(), counting);
    expect(second.text).toBe(first.text);
    expect(second.hash).toBe(first.hash);
    expect(first.hash).toBe('f0d544c24c540a76caea9bd7340499ef5a29918fcaa3b88dd608b2c85e0dbef2');
    expect([first.embedded, first.reused]).toEqual([25, 0]);
    const again = await buildIndex(libraryKb(), counting, parseIndex(first.text) as Exclude<ReturnType<typeof parseIndex>, string>);
    expect([again.embedded, again.reused, again.text === first.text]).toEqual([0, 25, true]);
    // One keyword changed: one text embedded, the rest kept.
    const k = libraryKb();
    const edited: KnowledgeBase = { ...k, topics: { ...k.topics, late_fees: { ...k.topics.late_fees!, keywords: ['late fee', 'overdue', 'fines'] } } };
    calls.length = 0;
    const partial = await buildIndex(edited, counting, first.data);
    expect([partial.embedded, partial.reused, calls]).toEqual([1, 24, [1]]);
    expect(indexDrift(edited, first.data).missing.map((t) => t.text)).toEqual(['fines']);
    expect(indexDrift(edited, partial.data)).toEqual({ missing: [], stale: [] });
    // A different embedder's vectors are not reused.
    const other = await buildIndex(libraryKb(), { ...counting, sha256: '1'.repeat(64) }, first.data);
    expect(other.embedded).toBe(25);
  });

  it('has a fixed shape, one entry per line, and refuses what is not one', async () => {
    const built = await buildIndex(libraryKb(), syntheticEmbedder());
    const text = built.text.split('\n');
    expect(text[0]).toBe('{');
    expect(text[1]).toBe(`  "embedder": {"id":"synthetic","revision":"test","sha256":"${syntheticEmbedder().sha256}","dim":4},`);
    expect(text[3]).toMatch(/^ {4}\{"topic":"card_renewal","locale":"en-US","field":"title","contentHash":"[0-9a-f]{64}","vector":"[A-Za-z0-9+/=]+"\},$/);
    expect(serializeIndex(parseIndex(built.text) as Exclude<ReturnType<typeof parseIndex>, string>)).toBe(built.text);
    expect(parseIndex('{')).toBe('it is not JSON');
    expect(parseIndex(built.text.replace('"field":"title"', '"field":"answer"'))).toBe('its entry 0 is not { topic, locale, field, contentHash, vector }');
    expect(serializeIndex({ embedder: built.data.embedder, entries: [] })).toBe(`{\n  "embedder": ${JSON.stringify(built.data.embedder)},\n  "entries": [\n  ]\n}\n`);
  });
});

describe('kb:index', () => {
  it('writes the index of the embedder kb.yaml names, then finds it up to date, and re-embeds only what changed', async () => {
    const dir = temp();
    cpSync(join(FIXTURES, 'kb'), dir, { recursive: true });
    writeFileSync(join(dir, 'kb.yaml'), readFileSync(join(dir, 'kb.yaml'), 'utf8').replace('  cap: 8', '  cap: 8\n  embedder: potion-base-8M'));
    const synthetic = syntheticEmbedder();
    // A stand-in that calls itself the pinned model, so no weights are needed.
    const lookalike: Embedder = { id: POTION_BASE_8M.id, revision: POTION_BASE_8M.revision, sha256: POTION_BASE_8M.sha256, dim: 4, embed: (t) => synthetic.embed(t) };
    const out: string[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => out.push(`ERR ${l}`), cwd: dirname(dir), embedderFor: async () => lookalike };
    expect(await kbIndexCommand([dir], io, () => [])).toBe(0);
    const file = join(dir, '.index', 'potion-base-8M.json');
    const first = readFileSync(file, 'utf8');
    expect(out.pop()).toMatch(/\.index\/potion-base-8M\.json: wrote 25 entries \(25 texts embedded, 0 kept\), sha256 [0-9a-f]{12}$/);
    expect(await kbIndexCommand([dir], io, () => [])).toBe(0);
    expect(out.pop()).toMatch(/: up to date \(25 entries, sha256 [0-9a-f]{12}\)$/);
    expect(readFileSync(file, 'utf8')).toBe(first);
    writeFileSync(join(dir, 'topics.yaml'), readFileSync(join(dir, 'topics.yaml'), 'utf8').replace('[late fee, overdue, fine]', '[late fee, overdue, fines]'));
    expect(await kbIndexCommand([dir], io, () => [])).toBe(0);
    expect(out.pop()).toMatch(/wrote 25 entries \(1 texts embedded, 24 kept\)/);
  });

  it('says there is nothing to index without an embedder, and finds no knowledge base where there is none', async () => {
    const out: string[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => out.push(`ERR ${l}`), cwd: FIXTURES };
    expect(await kbIndexCommand(['kb'], io, () => [])).toBe(0);
    expect(out.pop()).toBe('kb: kb.yaml names no embedder, so retrieval is by keywords alone and there is nothing to index (add retrieval.embedder: potion-base-8M for hybrid retrieval)');
    expect(existsSync(join(FIXTURES, 'kb', '.index'))).toBe(false);
    expect(await kbIndexCommand([], io, () => [])).toBe(0);
    expect(out.pop()).toBe('no knowledge base found: no app folder has a kb/kb.yaml');
    const empty = temp();
    expect(await kbIndexCommand([empty], { ...io, cwd: empty }, () => [])).toBe(1);
    expect(out.pop()).toBe('ERR .: neither a knowledge base folder (kb.yaml) nor an app folder with one (kb/kb.yaml)');
  });
});
