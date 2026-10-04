import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { endianness } from 'node:os';
import { join } from 'node:path';
import type { Embedder } from './types';
import { wordPieceConfigOf, wordPieceIds, type WordPieceConfig } from './wordpiece';

/**
 * A static embedder: a Model2Vec model (https://github.com/MinishLab/model2vec), whose vector for a
 * text is the mean of its tokens' vectors, normalized. No neural network runs: a text's vector is a
 * table lookup per token and an average, about a tenth of a millisecond, in TypeScript with no
 * native dependency. It is bit-deterministic: tokens are read in the text's order, summed in
 * float64 in that order and in index order within a vector, and divided once, so every machine
 * computes the same bits (IEEE 754 doubles, Math.sqrt correctly rounded).
 *
 * A model is three files in one folder: config.json (`normalize`), tokenizer.json (a BERT WordPiece
 * tokenizer, ./wordpiece.ts) and model.safetensors (one float32 tensor `embeddings`, a row per
 * token id). The engine's pinned model, potion-base-8M, is read from the cache (./model.ts); a
 * test builds its own tiny one. Weights are only ever read from disk here: nothing is downloaded.
 *
 * As Model2Vec does: special tokens are not added, the unknown token is dropped, at most
 * MAX_TOKENS tokens are read, and a text with no known token has the zero vector.
 */

/** The files a static model's folder has. */
export const STATIC_MODEL_FILES = ['config.json', 'model.safetensors', 'tokenizer.json'] as const;

/** The most tokens of a text that are averaged (Model2Vec's default). */
export const MAX_TOKENS = 512;

/** SHA-256 hex of bytes. */
export const sha256Hex = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

/** An embedder's hash over its files' hashes: `<file>:<sha256>` lines, sorted by file, each ending in a line feed. */
export function filesHash(files: Readonly<Record<string, string>>): string {
  return sha256Hex(Object.keys(files).sort().map((f) => `${f}:${files[f]}\n`).join(''));
}

/** The one tensor a Model2Vec safetensors file holds: [vocabulary size, dimensions], float32. */
export interface Embeddings {
  readonly rows: number;
  readonly dim: number;
  readonly data: Float32Array;
}

/** Reads a safetensors file's `embeddings` tensor (float32, two dimensions). Throws on anything else. */
export function readSafetensors(bytes: Uint8Array): Embeddings {
  if (bytes.length < 8) throw new Error('model.safetensors is too short to be a safetensors file');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = Number(view.getBigUint64(0, true));
  if (!Number.isSafeInteger(headerLength) || 8 + headerLength > bytes.length) throw new Error('model.safetensors has a header longer than the file');
  let header: Record<string, { dtype?: string; shape?: number[]; data_offsets?: [number, number] }>;
  try {
    header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(8, 8 + headerLength))) as typeof header;
  } catch {
    throw new Error('model.safetensors has a header that is not JSON');
  }
  const tensor = header.embeddings;
  if (!tensor) throw new Error('model.safetensors has no "embeddings" tensor');
  if (tensor.dtype !== 'F32') throw new Error(`model.safetensors' embeddings are ${tensor.dtype ?? 'of no type'}; only F32 is read`);
  const [rows, dim] = tensor.shape ?? [];
  if (tensor.shape?.length !== 2 || !Number.isInteger(rows) || !Number.isInteger(dim) || rows! <= 0 || dim! <= 0) throw new Error('model.safetensors\' embeddings are not a two-dimensional tensor');
  const [start, end] = tensor.data_offsets ?? [0, -1];
  const base = 8 + headerLength;
  if (end - start !== rows! * dim! * 4 || base + end > bytes.length) throw new Error('model.safetensors\' embeddings do not fit their shape');
  if (endianness() !== 'LE') throw new Error('reading model.safetensors needs a little-endian machine');
  // A copy, aligned, so the file's bytes can be let go.
  const data = new Float32Array(rows! * dim!);
  new Uint8Array(data.buffer).set(bytes.subarray(base + start, base + end));
  return { rows: rows!, dim: dim!, data };
}

/** What a static embedder is built from: its files' contents, and who it is. */
export interface StaticModelParts {
  readonly id: string;
  readonly revision: string;
  /** config.json's text. */
  readonly config: string;
  /** tokenizer.json's text. */
  readonly tokenizer: string;
  /** model.safetensors' bytes. */
  readonly weights: Uint8Array;
}

export class StaticEmbedder implements Embedder {
  readonly id: string;
  readonly revision: string;
  readonly sha256: string;
  readonly dim: number;
  readonly normalize: boolean;
  private readonly tokenizer: WordPieceConfig;
  private readonly embeddings: Embeddings;

  constructor(parts: StaticModelParts) {
    let config: { normalize?: unknown };
    let tokenizerJson: unknown;
    try {
      config = JSON.parse(parts.config) as typeof config;
    } catch {
      throw new Error('config.json is not JSON');
    }
    try {
      tokenizerJson = JSON.parse(parts.tokenizer);
    } catch {
      throw new Error('tokenizer.json is not JSON');
    }
    this.id = parts.id;
    this.revision = parts.revision;
    this.sha256 = filesHash({ 'config.json': sha256Hex(parts.config), 'model.safetensors': sha256Hex(parts.weights), 'tokenizer.json': sha256Hex(parts.tokenizer) });
    this.normalize = config.normalize === true;
    this.tokenizer = wordPieceConfigOf(tokenizerJson);
    this.embeddings = readSafetensors(parts.weights);
    this.dim = this.embeddings.dim;
    for (const [piece, id] of this.tokenizer.vocab) {
      if (id >= this.embeddings.rows) throw new Error(`tokenizer.json gives "${piece}" the id ${id}, past the ${this.embeddings.rows} rows of model.safetensors`);
    }
  }

  /** A static model read from a folder of its three files (STATIC_MODEL_FILES). */
  static fromDir(dir: string, info: { id: string; revision?: string }): StaticEmbedder {
    return new StaticEmbedder({
      id: info.id,
      revision: info.revision ?? 'local',
      config: readFileSync(join(dir, 'config.json'), 'utf8'),
      tokenizer: readFileSync(join(dir, 'tokenizer.json'), 'utf8'),
      weights: readFileSync(join(dir, 'model.safetensors')),
    });
  }

  /** The token ids a text is averaged over: its WordPiece ids, the unknown token dropped, at most MAX_TOKENS. */
  tokenIds(text: string): number[] {
    const unk = this.tokenizer.vocab.get(this.tokenizer.unkToken);
    return wordPieceIds(text, this.tokenizer).filter((id) => id !== unk).slice(0, MAX_TOKENS);
  }

  /** One text's vector, in float64: the mean of its tokens' rows, divided by its length (plus 1e-32, as Model2Vec does) when the model normalizes. */
  embedOne(text: string): Float64Array {
    const { dim, data } = this.embeddings;
    const out = new Float64Array(dim);
    const ids = this.tokenIds(text);
    if (ids.length === 0) return out;
    for (const id of ids) {
      const row = id * dim;
      for (let j = 0; j < dim; j++) out[j]! += data[row + j]!;
    }
    for (let j = 0; j < dim; j++) out[j]! /= ids.length;
    if (this.normalize) {
      let ss = 0;
      for (let j = 0; j < dim; j++) ss += out[j]! * out[j]!;
      const norm = Math.sqrt(ss) + 1e-32;
      for (let j = 0; j < dim; j++) out[j]! /= norm;
    }
    return out;
  }

  embed(texts: readonly string[]): Float64Array[] {
    return texts.map((t) => this.embedOne(t));
  }
}
