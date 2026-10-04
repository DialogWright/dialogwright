import { createHash } from 'node:crypto';
import type { Embedder } from './embed/types';

/**
 * An optional embedder that runs an ONNX sentence-embedding model (by default bge-small-en-v1.5)
 * through `@huggingface/transformers`, for an app that wants a contextual model beside its
 * keywords. It is imported as `dialogwright/kb/onnx`, and its package is an optional peer
 * dependency: install it yourself (`pnpm add @huggingface/transformers`); without it, `create`
 * throws an OnnxUnavailableError that says so. The engine never needs it.
 *
 * It is not the default, for two reasons the bake-off (kb/bakeoff.ts) weighs against its recall:
 * it is a native runtime of some hundred megabytes, and its vectors can differ in the last bits
 * from one CPU to another, which moves a topic near the floor in or out of the nominations and so
 * changes a recorded request. Retrieval rounds scores to a millionth (kb/score.ts), which absorbs
 * most of that, not all. Use it through HybridRetriever (kb/hybrid.ts) with an index built by it:
 *
 *   const embedder = await OnnxEmbedder.create();
 *   const built = await buildIndex(kb, embedder);
 *   const retriever = new HybridRetriever(kb, { embedder, vectors: built.data, floor: ONNX_DEFAULT_FLOOR, indexHash: built.hash });
 *
 * The model is fetched by the package into its own cache when `create` first runs (not while a call
 * is answered: create it when the app starts). Its identity in an index is its name, revision,
 * precision and pooling (`sha256` hashes those, not the files' bytes).
 */

/** The package it runs on. */
export const ONNX_PACKAGE = '@huggingface/transformers';

/** The model it loads when none is named. */
export const ONNX_DEFAULT_MODEL = 'Xenova/bge-small-en-v1.5';

/** A starting floor for bge-small's cosine similarities (its unrelated sentences sit higher than a static model's); sweep it with pnpm kb:bakeoff --sweep. */
export const ONNX_DEFAULT_FLOOR = 0.7;

/** The ONNX package is not installed (or did not load). */
export class OnnxUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`the ONNX embedder needs the optional package ${ONNX_PACKAGE}, which is not installed (${cause instanceof Error ? cause.message : String(cause)}): run pnpm add ${ONNX_PACKAGE}, or use the static embedder (kb.yaml retrieval.embedder: potion-base-8M)`);
    this.name = 'OnnxUnavailableError';
  }
}

/** What this adapter reads of the package. */
interface TransformersModule {
  pipeline(task: 'feature-extraction', model: string, options?: Record<string, unknown>): Promise<(texts: string[], options: { pooling: 'cls' | 'mean'; normalize: boolean }) => Promise<{ tolist(): number[][] }>>;
  env?: { cacheDir?: string; allowRemoteModels?: boolean };
}

/** The package, imported on first use; an OnnxUnavailableError when it is not there. */
export async function loadTransformers(): Promise<TransformersModule> {
  // A variable specifier: the type checker and bundlers do not look for an optional package.
  const specifier: string = ONNX_PACKAGE;
  try {
    return (await import(specifier)) as TransformersModule;
  } catch (error) {
    throw new OnnxUnavailableError(error);
  }
}

/** Whether the package can be imported here. */
export async function onnxAvailable(): Promise<boolean> {
  try {
    await loadTransformers();
    return true;
  } catch {
    return false;
  }
}

export interface OnnxEmbedderOptions {
  /** The model's Hugging Face id. Default ONNX_DEFAULT_MODEL. */
  model?: string;
  /** Its revision (pin a commit for a reproducible index). Default "main". */
  revision?: string;
  /** The weights' precision. Default fp32. */
  dtype?: 'fp32' | 'fp16' | 'q8';
  /** How token vectors become one: the [CLS] token's (bge) or their mean. Default cls. */
  pooling?: 'cls' | 'mean';
  /** Its id in an index and the trace. Default "onnx:<model>". */
  id?: string;
  /** Where the package caches models. Default: its own. */
  cacheDir?: string;
  /** Only a model already in the cache; never fetch. Default false. */
  localOnly?: boolean;
}

export class OnnxEmbedder implements Embedder {
  readonly id: string;
  readonly revision: string;
  readonly sha256: string;
  readonly dim: number;
  private readonly extract: (texts: string[], options: { pooling: 'cls' | 'mean'; normalize: boolean }) => Promise<{ tolist(): number[][] }>;
  private readonly pooling: 'cls' | 'mean';

  private constructor(fields: { id: string; revision: string; sha256: string; dim: number; pooling: 'cls' | 'mean'; extract: OnnxEmbedder['extract'] }) {
    this.id = fields.id;
    this.revision = fields.revision;
    this.sha256 = fields.sha256;
    this.dim = fields.dim;
    this.pooling = fields.pooling;
    this.extract = fields.extract;
  }

  /** Loads the model (fetching it into the package's cache the first time, unless localOnly). */
  static async create(options: OnnxEmbedderOptions = {}): Promise<OnnxEmbedder> {
    const mod = await loadTransformers();
    const model = options.model ?? ONNX_DEFAULT_MODEL;
    const revision = options.revision ?? 'main';
    const dtype = options.dtype ?? 'fp32';
    const pooling = options.pooling ?? 'cls';
    if (mod.env) {
      if (options.cacheDir !== undefined) mod.env.cacheDir = options.cacheDir;
      if (options.localOnly) mod.env.allowRemoteModels = false;
    }
    const extract = await mod.pipeline('feature-extraction', model, { revision, dtype });
    const probe = (await extract(['dimension probe'], { pooling, normalize: true })).tolist();
    const dim = probe[0]?.length ?? 0;
    if (dim === 0) throw new Error(`the model ${model} gave an empty vector`);
    const sha256 = createHash('sha256').update(`${model}\n${revision}\n${dtype}\n${pooling}\n`).digest('hex');
    return new OnnxEmbedder({ id: options.id ?? `onnx:${model}`, revision, sha256, dim, pooling, extract });
  }

  async embed(texts: readonly string[]): Promise<Float64Array[]> {
    if (texts.length === 0) return [];
    const rows = (await this.extract([...texts], { pooling: this.pooling, normalize: true })).tolist();
    return rows.map((r) => Float64Array.from(r));
  }
}
