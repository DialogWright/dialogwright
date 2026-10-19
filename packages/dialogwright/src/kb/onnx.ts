import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Embedder } from './embed/types';
import { packageDirOf, wasmRuntimeBeside, wasmTransformers } from './onnxWasm';

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
 *   const embedder = await OnnxEmbedder.create({ revision: '<the commit of the model repository, 40 hex>' });
 *   const built = await buildIndex(kb, embedder);
 *   const retriever = new HybridRetriever(kb, { embedder, vectors: built.data, floor: ONNX_DEFAULT_FLOOR, indexHash: built.hash });
 *
 * The model is fetched by the package into its own cache when `create` first runs (not while a call
 * is answered: create it when the app starts), at the revision given, which must be a commit (no
 * default: a branch moves under a committed index). Its identity in an index is its name, revision,
 * precision and pooling (`sha256` hashes those, not the files' bytes).
 */

/** The package it runs on. */
export const ONNX_PACKAGE = '@huggingface/transformers';

/** The model it loads when none is named. */
export const ONNX_DEFAULT_MODEL = 'Xenova/bge-small-en-v1.5';

/** A starting floor for bge-small's cosine similarities (its unrelated sentences sit higher than a static model's); sweep it with pnpm kb:bakeoff --sweep. */
export const ONNX_DEFAULT_FLOOR = 0.7;

/** How many texts are embedded at once. */
export const ONNX_BATCH = 64;

/** A model repository's commit, as a revision must be pinned: 40 hex characters. */
export const PINNED_REVISION = /^[0-9a-f]{40}$/;

/**
 * The ONNX package is not installed, or is installed (at `installedAt`) but did not load and nothing
 * beside it could run the model on WebAssembly: each said as it is, with its cause.
 */
export class OnnxUnavailableError extends Error {
  constructor(cause: unknown, installedAt?: string) {
    const why = cause instanceof Error ? cause.message : String(cause);
    super(installedAt === undefined
      ? `the ONNX embedder needs the optional package ${ONNX_PACKAGE}, which is not installed (${why}): run pnpm add ${ONNX_PACKAGE}, or use the static embedder (kb.yaml retrieval.embedder: potion-base-8M)`
      : `the ONNX embedder's package ${ONNX_PACKAGE} is installed (${installedAt}) but did not load, and its WebAssembly runtime (onnxruntime-web) is not beside it: ${why}`);
    this.name = 'OnnxUnavailableError';
  }
}

/** What this adapter reads of the package. */
interface TransformersModule {
  pipeline(task: 'feature-extraction', model: string, options?: Record<string, unknown>): Promise<(texts: string[], options: { pooling: 'cls' | 'mean'; normalize: boolean }) => Promise<{ tolist(): number[][] }>>;
  env?: { cacheDir?: string; allowRemoteModels?: boolean };
  /** `wasm` where the model runs on WebAssembly (kb/onnxWasm.ts); absent on the package itself. */
  runtime?: 'wasm';
  /** Why it runs on WebAssembly (`runtime: 'wasm'`), as the server's log says it. */
  whyWasm?: string;
  /** The package's folder, where it was found: the WebAssembly runtime is looked for beside it. */
  packageDir?: string;
}

/** Why the model runs on WebAssembly, where the package's native runtime does not import. */
const NO_NATIVE = 'its native runtime does not load on this machine';

/**
 * The package, imported on first use. Where it is installed but does not load (its native runtime,
 * onnxruntime-node, has no build for this machine: an Intel Mac), the same model on WebAssembly
 * (kb/onnxWasm.ts) where its runtime is beside it; an OnnxUnavailableError otherwise, saying whether the
 * package is missing or failed to load, and why.
 */
export async function loadTransformers(from?: string): Promise<TransformersModule> {
  // A variable specifier: the type checker and bundlers do not look for an optional package.
  const specifier: string = ONNX_PACKAGE;
  // Where the package is found: beside the engine, the app's own folder (`from`: the folder with app.yaml,
  // whose code the server already runs; never the kb/ folder inside it, which is data), then where the
  // process runs: an app installs the package, and an engine linked from elsewhere (a workspace, a link:
  // dependency, a host's server started in another folder) does not see the app's node_modules from where it is.
  let missing: unknown = null;
  let failed: { dir: string; error: unknown } | null = null;
  const bases = [import.meta.url, ...[...(from !== undefined ? [from] : []), process.cwd()].map((dir) => join(dir, 'package.json'))];
  for (const base of bases) {
    let resolved: string;
    try {
      resolved = createRequire(base).resolve(specifier);
    } catch (error) {
      missing ??= error;
      continue;
    }
    try {
      return { ...((await import(pathToFileURL(resolved).href)) as TransformersModule), packageDir: packageDirOf(resolved) };
    } catch (error) {
      failed ??= { dir: packageDirOf(resolved), error };
    }
  }
  if (failed !== null) {
    if (wasmRuntimeBeside(failed.dir)) return { ...wasmTransformers(failed.dir), runtime: 'wasm', whyWasm: NO_NATIVE, packageDir: failed.dir } as TransformersModule;
    throw new OnnxUnavailableError(failed.error, failed.dir);
  }
  throw new OnnxUnavailableError(missing);
}

/** The package environments an embedder turned remote models off in (OnnxEmbedderOptions.localOnly). */
const LOCAL_ONLY = new WeakSet<object>();

/** An error's first line, to say it in another's. */
const firstLine = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split('\n')[0]!;

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
  /**
   * The model repository's commit to load: 40 hex characters, required. A branch ("main") moves, and
   * a model that changed under a committed index would nominate other topics than the ones it was
   * built with, which changes recorded requests; so there is no default.
   */
  revision: string;
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
  /** The folder the package is found from after the engine's and before the process's: the app's own folder (never its kb/, which is data). */
  from?: string;
}

export class OnnxEmbedder implements Embedder {
  readonly id: string;
  readonly revision: string;
  readonly sha256: string;
  readonly dim: number;
  /** Where the model runs: the package's native runtime, or WebAssembly where that does not load or cannot load the model. */
  readonly runtime: 'native' | 'wasm';
  /** Why it runs on WebAssembly (`runtime: 'wasm'`): the native runtime does not load here, or could not load the model (offline, say). */
  readonly whyWasm?: string;
  private readonly extract: (texts: string[], options: { pooling: 'cls' | 'mean'; normalize: boolean }) => Promise<{ tolist(): number[][] }>;
  private readonly pooling: 'cls' | 'mean';

  private constructor(fields: { id: string; revision: string; sha256: string; dim: number; pooling: 'cls' | 'mean'; runtime: 'native' | 'wasm'; whyWasm?: string; extract: OnnxEmbedder['extract'] }) {
    this.runtime = fields.runtime;
    if (fields.whyWasm !== undefined) this.whyWasm = fields.whyWasm;
    this.id = fields.id;
    this.revision = fields.revision;
    this.sha256 = fields.sha256;
    this.dim = fields.dim;
    this.pooling = fields.pooling;
    this.extract = fields.extract;
  }

  /** Loads the model (fetching it into the package's cache the first time, unless localOnly). */
  static async create(options: OnnxEmbedderOptions): Promise<OnnxEmbedder> {
    const revision = options?.revision;
    if (typeof revision !== 'string' || !PINNED_REVISION.test(revision)) {
      throw new Error(`the ONNX embedder needs a pinned revision: the commit of the model's repository to load (40 hex characters), not ${revision === undefined ? 'none' : JSON.stringify(revision)}; a branch such as "main" moves, and an index built by one model would be read by another`);
    }
    let mod = await loadTransformers(options.from);
    const model = options.model ?? ONNX_DEFAULT_MODEL;
    const dtype = options.dtype ?? 'fp32';
    const pooling = options.pooling ?? 'cls';
    const load = async (m: TransformersModule, cacheDir: string | undefined) => {
      if (m.env) {
        if (cacheDir !== undefined) m.env.cacheDir = cacheDir;
        // The package's environment is shared by every embedder in the process: local-only is this one's,
        // so one that turned it off turns it back on for the next that does not ask for it.
        if (options.localOnly) {
          m.env.allowRemoteModels = false;
          LOCAL_ONLY.add(m.env);
        } else if (LOCAL_ONLY.has(m.env)) {
          m.env.allowRemoteModels = true;
          LOCAL_ONLY.delete(m.env);
        }
      }
      const extract = await m.pipeline('feature-extraction', model, { revision, dtype });
      const probe = (await extract(['dimension probe'], { pooling, normalize: true })).tolist();
      const dim = probe[0]?.length ?? 0;
      if (dim === 0) throw new Error(`the model ${model} gave an empty vector`);
      return { extract, dim };
    };
    let loaded: Awaited<ReturnType<typeof load>>;
    try {
      loaded = await load(mod, options.cacheDir);
    } catch (native) {
      // The native runtime imported but could not load or run the model: offline, where the package checks
      // the model repository before reading its cache, or a tokenizer it built empty. The same files from the
      // cache on WebAssembly, where its runtime is beside the package; the native runtime's error otherwise.
      if (mod.runtime === 'wasm' || mod.packageDir === undefined || !wasmRuntimeBeside(mod.packageDir)) throw native;
      const cacheDir = options.cacheDir ?? mod.env?.cacheDir;
      const wasm: TransformersModule = { ...wasmTransformers(mod.packageDir), runtime: 'wasm', whyWasm: `its native runtime could not load the model (${firstLine(native)})`, packageDir: mod.packageDir };
      try {
        loaded = await load(wasm, cacheDir);
      } catch (error) {
        throw new Error(`the ONNX model ${model} did not load on its native runtime (${firstLine(native)}), nor on WebAssembly (${firstLine(error)})`);
      }
      mod = wasm;
    }
    const sha256 = onnxSha256(model, revision, dtype, pooling);
    return new OnnxEmbedder({ id: options.id ?? `onnx:${model}`, revision, sha256, dim: loaded.dim, pooling, runtime: mod.runtime ?? 'native', ...(mod.whyWasm !== undefined ? { whyWasm: mod.whyWasm } : {}), extract: loaded.extract });
  }

  async embed(texts: readonly string[]): Promise<Float64Array[]> {
    // In batches: one batch of every text is padded to its longest, and slows a large index many times over.
    const out: Float64Array[] = [];
    for (let i = 0; i < texts.length; i += ONNX_BATCH) {
      const rows = (await this.extract(texts.slice(i, i + ONNX_BATCH), { pooling: this.pooling, normalize: true })).tolist();
      out.push(...rows.map((r) => Float64Array.from(r)));
    }
    return out;
  }
}

/** An ONNX model's identity in an index (EmbedderInfo.sha256): its name, revision, precision and pooling. */
export function onnxSha256(model: string, revision: string, dtype: string, pooling: string): string {
  return createHash('sha256').update(`${model}\n${revision}\n${dtype}\n${pooling}\n`).digest('hex');
}

/** The settings of an ONNX model as kb.yaml's documents.embedder gives them. */
export interface OnnxModelSettings {
  readonly onnx: string;
  readonly revision: string;
  readonly pooling: 'cls' | 'mean';
  readonly dtype: 'fp32' | 'fp16' | 'q8';
}

/** The embedder id an ONNX model has in an index and the trace: "onnx:<model>". */
export const onnxIdOf = (s: OnnxModelSettings): string => `onnx:${s.onnx}`;

/** The id its index file is named by (kb/.index/<id>.json): "onnx-<model>", in characters a file name takes. */
export const onnxIndexIdOf = (s: OnnxModelSettings): string => `onnx-${s.onnx.toLowerCase().replace(/[^a-z0-9._-]+/g, '-')}`;

/**
 * An ONNX embedder that loads its model on first use (or when `warm` is called, as an app does when
 * its server starts), with the identity and dimension its index says, so it can be built where an
 * app is defined (without waiting) and read an index written by `kb:index` with the same model.
 */
export class LazyOnnxEmbedder implements Embedder {
  readonly id: string;
  readonly revision: string;
  readonly sha256: string;
  readonly dim: number;
  private loading: Promise<OnnxEmbedder> | null = null;

  constructor(
    private readonly settings: OnnxModelSettings,
    dim: number,
    private readonly from?: string,
    private readonly create: (options: OnnxEmbedderOptions) => Promise<OnnxEmbedder> = (o) => OnnxEmbedder.create(o),
  ) {
    this.id = onnxIdOf(settings);
    this.revision = settings.revision;
    this.sha256 = onnxSha256(settings.onnx, settings.revision, settings.dtype, settings.pooling);
    this.dim = dim;
  }

  /** Loads the model now (once). */
  warm(): Promise<OnnxEmbedder> {
    this.loading ??= this.create({ model: this.settings.onnx, revision: this.settings.revision, pooling: this.settings.pooling, dtype: this.settings.dtype, id: this.id, ...(this.from !== undefined ? { from: this.from } : {}) });
    return this.loading;
  }

  async embed(texts: readonly string[]): Promise<Float64Array[]> {
    return (await this.warm()).embed(texts);
  }
}
