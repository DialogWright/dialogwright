import { createHash } from 'node:crypto';
import type { Embedder, EmbedderInfo, TopicField, VectorEntry } from './embed/types';
import { indexTexts, type IndexText, type RetrievalKb } from './words';

/**
 * A knowledge base's vector index: kb/.index/<embedder id>.json, written by `pnpm kb:index` and
 * committed with the knowledge base, so a call never embeds a topic, only the caller's words.
 *
 *   {
 *     "embedder": { "id": "potion-base-8M", "revision": "<commit>", "sha256": "<files' hash>", "dim": 256 },
 *     "entries": [
 *       { "topic": "opening_hours", "locale": "en-US", "field": "title", "contentHash": "<sha256>", "vector": "<base64>" },
 *       ...
 *     ]
 *   }
 *
 * One entry per text a caller's question should match: each topic's title, keywords and example
 * questions, in every locale it has wording in (./words.ts indexTexts), in that order. Not the
 * answers. `contentHash` is the SHA-256 of the text (whitespace collapsed); `vector` is its vector as
 * float32, little-endian, base64. The bytes are deterministic: the same knowledge base and embedder
 * give the same file, byte for byte, on any machine (the static embedder is bit-deterministic), so a
 * rebuild with nothing changed changes nothing, and `kb:index` re-embeds only the texts whose hash
 * is new. `pnpm check` reports an entry that is missing or no longer matches (kb/rules.ts), and the
 * file's SHA-256 is the retriever's indexHash, recorded with every nomination (trace.retrieval).
 */

/** The folder of a knowledge base its indexes are in (hidden, so the loader's layout rules skip it). */
export const INDEX_DIR = '.index';

/** The largest index file read. */
export const MAX_INDEX_BYTES = 64 * 1024 * 1024;

/** The command that writes the index, as fixes name it. */
export const INDEX_COMMAND = 'pnpm kb:index';

/** An index file's path from the app folder (`base` is the kb folder's, "kb"). */
export const indexFileOf = (base: string, embedderId: string): string => `${base}/${INDEX_DIR}/${embedderId}.json`;

/** A vector index as read: the embedder that wrote it, and its entries with their vectors. */
export interface KbIndexData {
  readonly embedder: EmbedderInfo;
  readonly entries: readonly VectorEntry[];
}

/** What reading kb/.index/<id>.json found (KnowledgeBase.index): the index with its file's hash, that it is missing, or why it is not one. */
export type KbIndexRead =
  | { readonly file: string; readonly hash: string; readonly data: KbIndexData }
  | { readonly file: string; readonly missing: true }
  | { readonly file: string; readonly invalid: string };

/** A vector as float32 little-endian bytes, base64. */
export function encodeVector(vector: ArrayLike<number>): string {
  const bytes = new Uint8Array(vector.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < vector.length; i++) view.setFloat32(i * 4, vector[i]!, true);
  return Buffer.from(bytes).toString('base64');
}

/** A base64 vector back as float32; null when it is not `dim` floats. */
export function decodeVector(text: string, dim: number): Float32Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null;
  const bytes = Buffer.from(text, 'base64');
  if (bytes.length !== dim * 4) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    out[i] = view.getFloat32(i * 4, true);
    if (!Number.isFinite(out[i]!)) return null;
  }
  return out;
}

const FIELDS: ReadonlySet<string> = new Set<TopicField>(['title', 'keyword', 'ask']);
const HEX64 = /^[0-9a-f]{64}$/;

/** An index file's text, parsed and checked: the index, or what is wrong with it. */
export function parseIndex(text: string): KbIndexData | string {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return 'it is not JSON';
  }
  const o = json as { embedder?: Record<string, unknown>; entries?: unknown };
  const e = o?.embedder;
  if (typeof e !== 'object' || e === null) return 'it has no "embedder"';
  const { id, revision, sha256, dim } = e;
  if (typeof id !== 'string' || typeof revision !== 'string' || typeof sha256 !== 'string' || !HEX64.test(sha256) || typeof dim !== 'number' || !Number.isInteger(dim) || dim <= 0 || dim > 8192) {
    return 'its "embedder" is not { id, revision, sha256, dim }';
  }
  if (!Array.isArray(o.entries)) return 'it has no "entries" list';
  const entries: VectorEntry[] = [];
  for (const [i, raw] of (o.entries as unknown[]).entries()) {
    const r = raw as Record<string, unknown>;
    if (typeof r !== 'object' || r === null || typeof r.topic !== 'string' || typeof r.locale !== 'string' || typeof r.field !== 'string' || !FIELDS.has(r.field) || typeof r.contentHash !== 'string' || !HEX64.test(r.contentHash) || typeof r.vector !== 'string') {
      return `its entry ${i} is not { topic, locale, field, contentHash, vector }`;
    }
    const vector = decodeVector(r.vector, dim);
    if (!vector) return `its entry ${i}'s vector is not ${dim} float32 numbers in base64`;
    entries.push({ topic: r.topic, locale: r.locale, field: r.field as TopicField, contentHash: r.contentHash, vector });
  }
  return { embedder: { id, revision, sha256, dim }, entries };
}

/** An index's file text: fixed key order, one entry per line, a final line feed. */
export function serializeIndex(data: KbIndexData): string {
  const { id, revision, sha256, dim } = data.embedder;
  const lines = data.entries.map((e) => `    ${JSON.stringify({ topic: e.topic, locale: e.locale, field: e.field, contentHash: e.contentHash, vector: encodeVector(e.vector) })}`);
  return `{\n  "embedder": ${JSON.stringify({ id, revision, sha256, dim })},\n  "entries": [\n${lines.join(',\n')}${lines.length > 0 ? '\n' : ''}  ]\n}\n`;
}

/** The SHA-256 of an index file's text: the retriever's indexHash. */
export const indexHashOf = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** Whether an index was written by this embedder (same id, revision, files and dimensions). */
export function sameEmbedder(a: EmbedderInfo, b: EmbedderInfo): boolean {
  return a.id === b.id && a.revision === b.revision && a.sha256 === b.sha256 && a.dim === b.dim;
}

/** What building an index did: the index, its file text, and how many texts were embedded and how many vectors kept from the last one. */
export interface BuiltIndex {
  readonly data: KbIndexData;
  readonly text: string;
  readonly hash: string;
  readonly embedded: number;
  readonly reused: number;
}

/**
 * Builds a knowledge base's index with `embedder`. A text whose hash `previous` (the index there
 * now) already has a vector for, from the same embedder, keeps that vector; only the others are
 * embedded. The vectors are stored as float32.
 */
export async function buildIndex(kb: RetrievalKb, embedder: Embedder, previous?: KbIndexData | null): Promise<BuiltIndex> {
  const texts = indexTexts(kb);
  const known = new Map<string, Float32Array>();
  if (previous && sameEmbedder(previous.embedder, embedder)) for (const e of previous.entries) known.set(e.contentHash, e.vector);
  const todo = [...new Map(texts.filter((t) => !known.has(t.contentHash)).map((t) => [t.contentHash, t.text])).entries()];
  const vectors = todo.length > 0 ? await embedder.embed(todo.map(([, text]) => text)) : [];
  if (vectors.length !== todo.length) throw new Error(`the embedder ${embedder.id} gave ${vectors.length} vectors for ${todo.length} texts`);
  const fresh = new Map<string, Float32Array>();
  todo.forEach(([hash], i) => {
    const v = vectors[i]!;
    if (v.length !== embedder.dim) throw new Error(`the embedder ${embedder.id} gave a vector of ${v.length} numbers, not ${embedder.dim}`);
    fresh.set(hash, Float32Array.from(v));
  });
  const entries = texts.map((t: IndexText): VectorEntry => ({ topic: t.topic, locale: t.locale, field: t.field, contentHash: t.contentHash, vector: known.get(t.contentHash) ?? fresh.get(t.contentHash)! }));
  const data: KbIndexData = { embedder: { id: embedder.id, revision: embedder.revision, sha256: embedder.sha256, dim: embedder.dim }, entries };
  const text = serializeIndex(data);
  return { data, text, hash: indexHashOf(text), embedded: todo.length, reused: texts.length - texts.filter((t) => fresh.has(t.contentHash)).length };
}

/** What an index lacks for a knowledge base: the texts with no vector, and the entries no text has any more. */
export function indexDrift(kb: RetrievalKb, data: KbIndexData): { missing: IndexText[]; stale: VectorEntry[] } {
  const texts = indexTexts(kb);
  const key = (e: { topic: string; locale: string; field: string; contentHash: string }): string => `${e.topic}\u0000${e.locale}\u0000${e.field}\u0000${e.contentHash}`;
  const have = new Set(data.entries.map(key));
  const want = new Set(texts.map(key));
  return { missing: texts.filter((t) => !have.has(key(t))), stale: data.entries.filter((e) => !want.has(key(e))) };
}
