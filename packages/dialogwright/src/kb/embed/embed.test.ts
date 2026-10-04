import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { safetensorsOf, syntheticEmbedder, syntheticParts, writeSyntheticModel } from '../__fixtures__/syntheticModel';
import { cosine, MemoryVectorIndex } from './memory';
import { downloadModel, loadPinnedModel, modelDir, modelPresent, ModelError, MODEL_DIR_ENV, POTION_BASE_8M, type PinnedModel } from './model';
import { filesHash, MAX_TOKENS, readSafetensors, sha256Hex, StaticEmbedder, STATIC_MODEL_FILES } from './static';
import { normalizeBert, preTokenizeBert, wordPieceConfigOf, wordPieceIds } from './wordpiece';

const temps: string[] = [];
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'dw-embed-'));
  temps.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** A vector's SHA-256, over its numbers as float64 little-endian: a golden of its exact bits. */
function vectorChecksum(v: Float64Array): string {
  const bytes = new Uint8Array(v.length * 8);
  const view = new DataView(bytes.buffer);
  v.forEach((x, i) => view.setFloat64(i * 8, x, true));
  return createHash('sha256').update(bytes).digest('hex');
}

const BERT = { lowercase: true, stripAccents: true, cleanText: true, handleChineseChars: true };

describe('the WordPiece tokenizer (BERT normalizer, pre-tokenizer and model)', () => {
  it('cleans, folds accents, lowercases character by character, and pads CJK ideographs', () => {
    expect(normalizeBert('Café\u0000 CRÈME\tbrûlée​!', BERT)).toBe('cafe creme brulee!');
    expect(normalizeBert('ΣΟΦΟΣ', BERT)).toBe('σοφοσ');
    expect(normalizeBert('日本', BERT)).toBe(' 日  本 ');
    expect(normalizeBert('Café', { ...BERT, stripAccents: false, lowercase: false })).toBe('Café');
  });

  it('splits on whitespace, and makes each punctuation character a word', () => {
    expect(preTokenizeBert("don't, stop!  ok $5")).toEqual(['don', "'", 't', ',', 'stop', '!', 'ok', '$', '5']);
    expect(preTokenizeBert('¿qué?')).toEqual(['¿', 'qué', '?']);
  });

  it('splits a word into the longest pieces the vocabulary has; a word it cannot split is the unknown token', () => {
    const config = wordPieceConfigOf(JSON.parse(syntheticParts().tokenizer));
    const id = (piece: string): number => config.vocab.get(piece)!;
    expect(wordPieceIds('Opening hours', config)).toEqual([id('open'), id('##ing'), id('hour'), id('##s')]);
    expect(wordPieceIds('renewal xyz', config)).toEqual([id('renew'), id('##al'), id('[UNK]')]);
    expect(wordPieceIds('a'.repeat(101), config)).toEqual([id('[UNK]')]);
  });

  it('refuses a tokenizer.json it does not reproduce', () => {
    expect(() => wordPieceConfigOf({ model: { type: 'BPE', vocab: {} } })).toThrow('not a WordPiece tokenizer');
    expect(() => wordPieceConfigOf({ model: { type: 'WordPiece', vocab: {} }, normalizer: { type: 'NFC' }, pre_tokenizer: { type: 'BertPreTokenizer' } })).toThrow('not BertNormalizer');
  });
});

describe('safetensors', () => {
  it('reads the embeddings tensor, and refuses anything else', () => {
    const e = readSafetensors(safetensorsOf(2, 3, [1, 2, 3, 4, 5, 6]));
    expect([e.rows, e.dim, Array.from(e.data)]).toEqual([2, 3, [1, 2, 3, 4, 5, 6]]);
    expect(() => readSafetensors(new Uint8Array(4))).toThrow('too short');
    expect(() => readSafetensors(safetensorsOf(1, 2, [1, 2], 'F16'))).toThrow('only F32');
    const cut = safetensorsOf(2, 3, [1, 2, 3, 4, 5, 6]);
    expect(() => readSafetensors(cut.subarray(0, cut.length - 4))).toThrow('do not fit');
  });
});

describe('the static embedder (a synthetic Model2Vec model)', () => {
  const embedder = syntheticEmbedder();

  it('is the mean of the tokens\' rows, normalized, in float64', () => {
    // when [0.4,0,0,0.5] + are [0,0,0,1] + you [0.05,0,0,1] + open [1,0,0,0.1] + ? [0,0,0,0.5], over 5, normalized.
    const v = embedder.embedOne('When are you open?');
    const f = (x: number): number => Math.fround(x);
    const mean = [(f(0.4) + 0 + f(0.05) + 1 + 0) / 5, 0, 0, (f(0.5) + 1 + 1 + f(0.1) + f(0.5)) / 5];
    const norm = Math.sqrt(mean[0]! ** 2 + mean[3]! ** 2) + 1e-32;
    expect(Array.from(v)).toEqual(mean.map((x) => x / norm));
    expect(v).toBeInstanceOf(Float64Array);
  });

  it('drops the unknown token, reads at most MAX_TOKENS, and gives the zero vector for a text with no known word', () => {
    expect(embedder.tokenIds('open xyzzy')).toEqual(embedder.tokenIds('open'));
    expect(embedder.tokenIds('open '.repeat(MAX_TOKENS + 10))).toHaveLength(MAX_TOKENS);
    expect(Array.from(embedder.embedOne('xyzzy plugh'))).toEqual([0, 0, 0, 0]);
    expect(Array.from(embedder.embedOne(''))).toEqual([0, 0, 0, 0]);
  });

  it('gives the same bits every time, on every machine: a golden checksum of one sentence\'s vector', () => {
    const v = embedder.embedOne('When are you open?');
    expect(vectorChecksum(v)).toBe('c2e1b37513030cede2d0e9318c74e82e1020bc2ed229fb9971da3138898023c5');
    expect(vectorChecksum(syntheticEmbedder().embedOne('When are you open?'))).toBe(vectorChecksum(v));
    expect(embedder.embed(['open', 'card']).map((x) => Array.from(x))).toEqual([Array.from(embedder.embedOne('open')), Array.from(embedder.embedOne('card'))]);
  });

  it('is identified by its files\' hashes', () => {
    const parts = syntheticParts();
    expect(embedder.sha256).toBe(filesHash({ 'config.json': sha256Hex(parts.config), 'model.safetensors': sha256Hex(parts.weights), 'tokenizer.json': sha256Hex(parts.tokenizer) }));
    expect(embedder.dim).toBe(4);
    expect(new StaticEmbedder({ ...parts, config: JSON.stringify({ normalize: false }) }).sha256).not.toBe(embedder.sha256);
  });

  it('reads a model folder, and refuses a tokenizer whose ids pass the weights\' rows', () => {
    const dir = temp();
    writeSyntheticModel(dir);
    expect(vectorChecksum(StaticEmbedder.fromDir(dir, { id: 'synthetic' }).embedOne('When are you open?'))).toBe(vectorChecksum(embedder.embedOne('When are you open?')));
    expect(() => new StaticEmbedder({ ...syntheticParts(), weights: safetensorsOf(2, 4, Array(8).fill(0)) })).toThrow('past the 2 rows');
  });
});

describe('the in-memory vector index', () => {
  const v = (...xs: number[]): Float32Array => Float32Array.from(xs);
  const entry = (topic: string, vector: Float32Array) => ({ topic, locale: 'en-US', field: 'ask' as const, contentHash: '0'.repeat(64), vector });

  it('scores each topic by its closest text, keeps those at the floor, best first, ties by topic id, at most the limit', () => {
    const index = new MemoryVectorIndex(2, [entry('b', v(1, 0)), entry('a', v(1, 0)), entry('c', v(0, 1)), entry('c', v(0.6, 0.8))]);
    const q = Float64Array.from([1, 0]);
    expect(index.search({ vector: q, limit: 10, floor: 0 })).toEqual([{ topic: 'a', score: 1 }, { topic: 'b', score: 1 }, { topic: 'c', score: 0.6 }]);
    expect(index.search({ vector: q, limit: 2, floor: 0 })).toEqual([{ topic: 'a', score: 1 }, { topic: 'b', score: 1 }]);
    expect(index.search({ vector: q, limit: 10, floor: 0.7 })).toEqual([{ topic: 'a', score: 1 }, { topic: 'b', score: 1 }]);
    expect(index.search({ vector: Float64Array.from([0, 0]), limit: 10, floor: 0 })).toEqual([]);
    expect(() => index.search({ vector: Float64Array.from([1]), limit: 1, floor: 0 })).toThrow('1 numbers');
    expect(() => new MemoryVectorIndex(3, [entry('a', v(1, 0))])).toThrow('has 2 numbers');
    expect(cosine(Float64Array.from([1, 1]), v(0, 0))).toBe(0);
  });
});

describe('the pinned models and their cache', () => {
  it('pins potion-base-8M by revision and SHA-256, and caches it under the revision (DIALOGWRIGHT_MODEL_DIR moves the cache)', () => {
    expect(POTION_BASE_8M.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.keys(POTION_BASE_8M.files).sort()).toEqual([...STATIC_MODEL_FILES]);
    expect(POTION_BASE_8M.sha256).toBe(filesHash(POTION_BASE_8M.files));
    expect(modelDir(POTION_BASE_8M, { [MODEL_DIR_ENV]: '/models' })).toBe(join('/models', POTION_BASE_8M.revision));
    expect(modelDir(POTION_BASE_8M, {})).toContain(join('.cache', 'dialogwright', 'models'));
  });

  it('refuses a model that is not in the cache, or whose file is not the pinned one', () => {
    const env = { [MODEL_DIR_ENV]: temp() };
    expect(modelPresent(POTION_BASE_8M, env)).toBe(false);
    expect(() => loadPinnedModel(POTION_BASE_8M, env)).toThrow(/is not in the cache .* run pnpm kb:model/);
    writeSyntheticModel(modelDir(POTION_BASE_8M, env));
    expect(modelPresent(POTION_BASE_8M, env)).toBe(true);
    expect(() => loadPinnedModel(POTION_BASE_8M, env)).toThrow(ModelError);
    expect(() => loadPinnedModel(POTION_BASE_8M, env)).toThrow('not the pinned');
  });

  /** A model pinned to the synthetic files, so downloading can be tested with a fake fetch. */
  const parts = syntheticParts();
  const bytesOf: Record<string, Uint8Array> = { 'config.json': new TextEncoder().encode(parts.config), 'tokenizer.json': new TextEncoder().encode(parts.tokenizer), 'model.safetensors': parts.weights };
  const files = { 'config.json': sha256Hex(bytesOf['config.json']!), 'model.safetensors': sha256Hex(bytesOf['model.safetensors']!), 'tokenizer.json': sha256Hex(bytesOf['tokenizer.json']!) };
  const pinned: PinnedModel = { id: 'synthetic', repo: 'example/synthetic', revision: 'a'.repeat(40), files, sha256: filesHash(files), dim: 4, floor: 0.5, license: 'MIT' };
  const fakeFetch = (serve: (file: string) => Uint8Array | null, calls: string[]): typeof fetch =>
    (async (url: string | URL | Request) => {
      const u = String(url);
      calls.push(u);
      const body = serve(u.slice(u.lastIndexOf('/') + 1));
      return body ? new Response(body as BodyInit) : new Response('no', { status: 404 });
    }) as typeof fetch;

  it('downloads each file at the pinned revision, checks its SHA-256, and keeps a file already there', async () => {
    const env = { [MODEL_DIR_ENV]: temp() };
    const calls: string[] = [];
    const first = await downloadModel(pinned, { env, fetch: fakeFetch((f) => bytesOf[f] ?? null, calls) });
    expect(first.downloaded).toEqual(['config.json', 'model.safetensors', 'tokenizer.json']);
    expect(calls[0]).toBe(`https://huggingface.co/example/synthetic/resolve/${'a'.repeat(40)}/config.json`);
    expect(loadPinnedModel(pinned, env).sha256).toBe(pinned.sha256);
    const again = await downloadModel(pinned, { env, fetch: fakeFetch(() => null, calls) });
    expect(again.downloaded).toEqual([]);
  });

  it('refuses a download whose SHA-256 is not the pinned one, and leaves nothing where loading would find it', async () => {
    const env = { [MODEL_DIR_ENV]: temp() };
    const calls: string[] = [];
    await expect(downloadModel(pinned, { env, attempts: 2, fetch: fakeFetch(() => new Uint8Array([1, 2, 3]), calls) })).rejects.toThrow(/could not download config.json .* not the pinned/);
    expect(calls).toHaveLength(2);
    expect(readdirSync(modelDir(pinned, env))).toEqual([]);
    await expect(downloadModel(pinned, { env, attempts: 1, fetch: fakeFetch(() => null, []) })).rejects.toThrow('HTTP 404');
  });
});

/**
 * The real model, when it is in the cache (pnpm kb:model); skipped otherwise, unless
 * DIALOGWRIGHT_REQUIRE_MODEL is set (CI sets it after restoring the cache), when its absence fails.
 */
const REAL = modelPresent(POTION_BASE_8M) || process.env.DIALOGWRIGHT_REQUIRE_MODEL === '1';

describe.skipIf(!REAL)('potion-base-8M itself (from the cache)', () => {
  it('loads with its pinned hashes, tokenizes as Model2Vec does, and its vectors are bit-identical on every machine', () => {
    const model = loadPinnedModel(POTION_BASE_8M);
    expect([model.id, model.dim, model.sha256]).toEqual(['potion-base-8M', 256, POTION_BASE_8M.sha256]);
    // The token ids Model2Vec 0.7.0 (Python, the Rust tokenizers library) gives these sentences.
    expect(model.tokenIds('When are you open?')).toEqual([1049, 1030, 1023, 1336, 35]);
    expect(model.tokenIds('¿A qué hora abren?')).toEqual([100, 43, 9867, 6576, 1533, 10119, 6395, 35]);
    const v = model.embedOne('When are you open?');
    expect(Math.abs(Math.hypot(...v) - 1)).toBeLessThan(1e-12);
    expect(vectorChecksum(v)).toBe('8f1e2dcd0b681553461a6caeba10fda1b6de88ead89be126eec13a43f86d194b');
    const near = cosine(v, Float32Array.from(model.embedOne('What are your opening hours?')));
    const far = cosine(v, Float32Array.from(model.embedOne('How much is the late fee?')));
    expect(near).toBeGreaterThan(far);
  });
});
