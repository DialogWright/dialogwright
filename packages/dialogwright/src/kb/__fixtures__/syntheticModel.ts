import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { StaticEmbedder, type StaticModelParts } from '../embed/static';

/**
 * A tiny Model2Vec model for tests, in the real format (config.json, tokenizer.json with a BERT
 * WordPiece tokenizer, model.safetensors with one float32 `embeddings` tensor), so the static
 * embedder's mechanics are tested without the real weights. Four dimensions, each a theme of the
 * library knowledge base (./kb): hours, cards, fees, and words of no theme.
 */

/** Each token's vector: [hours, card, fee, none]. */
const TOKENS: readonly (readonly [string, readonly [number, number, number, number]])[] = [
  ['[PAD]', [0, 0, 0, 0]],
  ['[UNK]', [0, 0, 0, 0]],
  // hours
  ['open', [1, 0, 0, 0.1]],
  ['hour', [0.9, 0, 0, 0.1]],
  ['time', [0.7, 0, 0.1, 0.2]],
  ['close', [0.8, 0, 0, 0.1]],
  ['today', [0.6, 0, 0, 0.3]],
  ['morning', [0.6, 0, 0, 0.2]],
  ['week', [0.5, 0.1, 0, 0.3]],
  ['sunday', [0.7, 0, 0, 0.1]],
  ['saturday', [0.7, 0, 0, 0.1]],
  ['when', [0.4, 0, 0, 0.5]],
  // cards
  ['card', [0, 1, 0, 0.1]],
  ['renew', [0, 0.9, 0, 0.1]],
  ['expire', [0, 0.8, 0.1, 0.1]],
  ['extend', [0, 0.7, 0, 0.2]],
  ['valid', [0, 0.6, 0, 0.2]],
  ['year', [0.1, 0.5, 0, 0.3]],
  ['new', [0, 0.4, 0, 0.4]],
  ['date', [0.2, 0.4, 0.2, 0.2]],
  // fees
  ['fee', [0, 0, 1, 0.1]],
  ['fine', [0, 0, 0.9, 0.1]],
  ['overdue', [0, 0, 0.9, 0.1]],
  ['owe', [0, 0, 0.8, 0.2]],
  ['charge', [0, 0, 0.8, 0.2]],
  ['pay', [0, 0.1, 0.7, 0.2]],
  ['penalty', [0, 0, 0.8, 0.1]],
  ['book', [0.1, 0.1, 0.5, 0.3]],
  ['return', [0.1, 0, 0.6, 0.3]],
  ['late', [0.4, 0, 0.7, 0.1]],
  // no theme
  ['the', [0, 0, 0, 1]],
  ['my', [0, 0.05, 0, 1]],
  ['i', [0, 0, 0, 1]],
  ['you', [0.05, 0, 0, 1]],
  ['a', [0, 0, 0, 1]],
  ['how', [0, 0, 0.05, 1]],
  ['do', [0, 0, 0, 1]],
  ['is', [0, 0, 0, 1]],
  ['what', [0, 0, 0, 1]],
  ['are', [0, 0, 0, 1]],
  ['much', [0, 0, 0.1, 0.9]],
  ['can', [0, 0, 0, 1]],
  ['it', [0, 0, 0, 1]],
  ['?', [0, 0, 0, 0.5]],
  ['.', [0, 0, 0, 0.5]],
  [',', [0, 0, 0, 0.5]],
  ['##s', [0, 0, 0, 0.2]],
  ['##d', [0, 0, 0, 0.2]],
  ['##ed', [0, 0, 0, 0.2]],
  ['##ing', [0, 0, 0, 0.2]],
  ['##al', [0, 0.1, 0, 0.2]],
];

/** The tokenizer.json of the synthetic model. */
export function syntheticTokenizer(): string {
  return JSON.stringify({
    version: '1.0',
    normalizer: { type: 'BertNormalizer', clean_text: true, handle_chinese_chars: true, strip_accents: null, lowercase: true },
    pre_tokenizer: { type: 'BertPreTokenizer' },
    model: { type: 'WordPiece', unk_token: '[UNK]', continuing_subword_prefix: '##', max_input_chars_per_word: 100, vocab: Object.fromEntries(TOKENS.map(([t], i) => [t, i])) },
  });
}

/** A safetensors file with one float32 tensor `embeddings` of `rows` x `dim` (the header padded to 8 bytes, as the format writes it). */
export function safetensorsOf(rows: number, dim: number, values: readonly number[], dtype = 'F32'): Uint8Array {
  let header = JSON.stringify({ embeddings: { dtype, shape: [rows, dim], data_offsets: [0, rows * dim * 4] } });
  while (header.length % 8 !== 0) header += ' ';
  const out = new Uint8Array(8 + header.length + rows * dim * 4);
  const view = new DataView(out.buffer);
  view.setBigUint64(0, BigInt(header.length), true);
  out.set(new TextEncoder().encode(header), 8);
  values.forEach((v, i) => view.setFloat32(8 + header.length + i * 4, v, true));
  return out;
}

/** The synthetic model's three files. */
export function syntheticParts(id = 'synthetic', revision = 'test'): StaticModelParts {
  return {
    id,
    revision,
    config: JSON.stringify({ model_type: 'model2vec', normalize: true }),
    tokenizer: syntheticTokenizer(),
    weights: safetensorsOf(TOKENS.length, 4, TOKENS.flatMap(([, v]) => [...v])),
  };
}

/** The synthetic model as an embedder. */
export const syntheticEmbedder = (id?: string): StaticEmbedder => new StaticEmbedder(syntheticParts(id));

/** Writes the synthetic model's files into `dir` (a model folder, as the cache holds one). */
export function writeSyntheticModel(dir: string): void {
  const parts = syntheticParts();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), parts.config);
  writeFileSync(join(dir, 'tokenizer.json'), parts.tokenizer);
  writeFileSync(join(dir, 'model.safetensors'), parts.weights);
}
