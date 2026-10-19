import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * The ONNX embedder on WebAssembly, for a machine `@huggingface/transformers`' native runtime
 * (onnxruntime-node) has no build for (an Intel Mac: its 1.30 ships Apple silicon, Linux and Windows
 * only), where the package's Node build cannot even be imported. It runs the same model file through
 * `onnxruntime-web` (its WebAssembly runtime, any CPU) and tokenizes with `@huggingface/tokenizers`, the
 * tokenizer transformers.js itself uses; both are dependencies of the package, found beside it, so nothing
 * more is installed. It reads the model from the package's own cache (the files transformers.js fetched:
 * `<cache>/<model>/<revision>/tokenizer.json`, `tokenizer_config.json`, `onnx/model.onnx`), fetching any
 * missing from the model's repository at the pinned revision unless remote models are off. Same model,
 * same revision, same tokens, same pooling: its vectors are the native runtime's to within a float's last
 * bits, so an index built either way is read by the other (its identity, onnxSha256, is the same).
 * Slower than the native runtime; a question's embedding takes a few tens of milliseconds.
 */

/** The weights' file in the repository's onnx/ folder, by precision, as transformers.js names them. */
const MODEL_FILE: Readonly<Record<string, string>> = { fp32: 'model.onnx', fp16: 'model_fp16.onnx', q8: 'model_quantized.onnx' };
/** The longest a text's tokens are kept, where the tokenizer's config gives no other. */
const MAX_TOKENS = 512;

type Tensor = { data: Float32Array; dims: readonly number[] };
interface OrtModule {
  env: { wasm: { numThreads?: number; wasmPaths?: string | Record<string, string> } };
  Tensor: new (type: 'int64', data: BigInt64Array, dims: readonly number[]) => unknown;
  InferenceSession: {
    create(model: Uint8Array, options: { executionProviders: string[] }): Promise<{
      inputNames: readonly string[];
      outputNames: readonly string[];
      run(feeds: Record<string, unknown>): Promise<Record<string, Tensor>>;
    }>;
  };
}
interface TokenizersModule {
  Tokenizer: new (tokenizer: object, config: object) => { encode(text: string, options?: { add_special_tokens?: boolean }): { ids: number[] } };
}

/** What the embedder reads of a package (OnnxEmbedder): its environment, and a feature-extraction pipeline. */
export interface WasmTransformers {
  env: { cacheDir?: string; allowRemoteModels?: boolean };
  pipeline(task: 'feature-extraction', model: string, options?: Record<string, unknown>): Promise<(texts: string[], options: { pooling: 'cls' | 'mean'; normalize: boolean }) => Promise<{ tolist(): number[][] }>>;
}

/** Whether the WebAssembly runtime and the tokenizer can be found beside the package in `packageDir`. */
export function wasmRuntimeBeside(packageDir: string): boolean {
  const req = createRequire(join(packageDir, 'package.json'));
  try {
    req.resolve('onnxruntime-web');
    req.resolve('@huggingface/tokenizers');
    return true;
  } catch {
    return false;
  }
}

/** The package's folder, from the file its main entry resolves to: the nearest folder above it with a package.json. */
export function packageDirOf(entry: string): string {
  let dir = dirname(entry);
  while (!existsSync(join(dir, 'package.json')) && dirname(dir) !== dir) dir = dirname(dir);
  return dir;
}

/** The embedder's package on WebAssembly: the runtime and the tokenizer beside `packageDir`, its cache in `packageDir/.cache` unless set. */
export function wasmTransformers(packageDir: string): WasmTransformers {
  const req = createRequire(join(packageDir, 'package.json'));
  const env: WasmTransformers['env'] = { cacheDir: join(packageDir, '.cache') };
  return {
    env,
    async pipeline(_task, model, options = {}) {
      const revision = String(options.revision ?? 'main');
      const dtype = String(options.dtype ?? 'fp32');
      const file = MODEL_FILE[dtype];
      if (file === undefined) throw new Error(`the ONNX embedder on WebAssembly reads fp32, fp16 or q8 weights, not ${dtype}`);
      const dir = join(env.cacheDir ?? join(packageDir, '.cache'), model, revision);
      const read = async (path: string): Promise<Uint8Array> => {
        const local = join(dir, path);
        if (existsSync(local)) return readFileSync(local);
        if (env.allowRemoteModels === false) throw new Error(`the model file ${path} of ${model} at ${revision} is not in the cache (${dir}), and remote models are off`);
        const res = await fetch(`https://huggingface.co/${model}/resolve/${revision}/${path}`);
        if (!res.ok) throw new Error(`fetching ${path} of ${model} at ${revision} answered ${res.status}`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        mkdirSync(dirname(local), { recursive: true });
        writeFileSync(local, bytes);
        return bytes;
      };
      const json = async (path: string): Promise<Record<string, unknown>> => JSON.parse(new TextDecoder().decode(await read(path))) as Record<string, unknown>;
      const ort = req('onnxruntime-web') as OrtModule;
      // One thread: the server answers one caller's question at a time per turn, and threads need workers.
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.wasmPaths = `${dirname(req.resolve('onnxruntime-web'))}/`;
      const { Tokenizer } = req('@huggingface/tokenizers') as TokenizersModule;
      const config = await json('tokenizer_config.json');
      const tokenizer = new Tokenizer(await json('tokenizer.json'), config);
      const session = await ort.InferenceSession.create(await read(`onnx/${file}`), { executionProviders: ['wasm'] });
      const maxTokens = Math.min(typeof config.model_max_length === 'number' ? config.model_max_length : MAX_TOKENS, MAX_TOKENS);
      const padId = tokenizer.encode(String(config.pad_token ?? '[PAD]'), { add_special_tokens: false }).ids[0] ?? 0;
      return async (texts, { pooling, normalize }) => {
        // Each text's tokens (its special tokens added, as transformers.js adds them), kept to the model's
        // length with its last token (the separator) last, then padded to the longest of the batch.
        const encoded = texts.map((t) => {
          const ids = tokenizer.encode(t).ids;
          return ids.length <= maxTokens ? ids : [...ids.slice(0, maxTokens - 1), ids[ids.length - 1]!];
        });
        const width = Math.max(1, ...encoded.map((ids) => ids.length));
        const flat = (fill: (ids: number[], j: number) => number): BigInt64Array => BigInt64Array.from(encoded.flatMap((ids) => Array.from({ length: width }, (_, j) => BigInt(fill(ids, j)))));
        const dims = [texts.length, width];
        const feeds: Record<string, unknown> = {
          input_ids: new ort.Tensor('int64', flat((ids, j) => ids[j] ?? padId), dims),
          attention_mask: new ort.Tensor('int64', flat((ids, j) => (j < ids.length ? 1 : 0)), dims),
        };
        if (session.inputNames.includes('token_type_ids')) feeds.token_type_ids = new ort.Tensor('int64', flat(() => 0), dims);
        const out = (await session.run(feeds))[session.outputNames[0]!]!;
        const [, seq, hidden] = out.dims as [number, number, number];
        const rows = encoded.map((ids, b) => {
          const at = (j: number, k: number): number => out.data[(b * seq + j) * hidden + k]!;
          const row = Array.from({ length: hidden }, (_, k) => {
            if (pooling === 'cls') return at(0, k);
            let sum = 0;
            for (let j = 0; j < ids.length; j++) sum += at(j, k);
            return sum / ids.length;
          });
          if (!normalize) return row;
          const norm = Math.hypot(...row) || 1;
          return row.map((v) => v / norm);
        });
        return { tolist: () => rows };
      };
    },
  };
}
