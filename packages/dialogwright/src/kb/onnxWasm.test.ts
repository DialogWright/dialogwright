import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OnnxEmbedder, OnnxUnavailableError, loadTransformers, onnxAvailable } from './onnx';
import { packageDirOf, wasmRuntimeBeside, wasmTransformers } from './onnxWasm';

// A folder with fakes of the three packages: the embedder's package, whose import fails (as its native
// runtime does on a machine it has no build for), the WebAssembly runtime and the tokenizer. The runtime's
// "model" gives token j of text b the vector (id, 2·id): its [CLS] token's is (101, 202), and a mean shows
// whether padding was counted. Each fake records what it was given on globalThis, by its folder.
const MODEL = 'Example/tiny-embedder';
const REVISION = 'a'.repeat(40);

const FAKE_ORT = `
const record = (globalThis.__fakeOrt ??= {})[__dirname] = { feeds: [], models: [] };
exports.env = { wasm: {} };
exports.Tensor = class { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } };
exports.InferenceSession = { async create(model, options) {
  record.models.push({ bytes: Buffer.from(model).toString(), options, env: { ...exports.env.wasm } });
  return {
    inputNames: ['input_ids', 'attention_mask', 'token_type_ids'],
    outputNames: ['last_hidden_state'],
    async run(feeds) {
      record.feeds.push(feeds);
      const [batch, seq] = feeds.input_ids.dims;
      const data = new Float32Array(batch * seq * 2);
      for (let i = 0; i < batch * seq; i++) { const id = Number(feeds.input_ids.data[i]); data[i * 2] = id; data[i * 2 + 1] = 2 * id; }
      return { last_hidden_state: { data, dims: [batch, seq, 2] } };
    },
  };
} };
`;

const FAKE_TOKENIZERS = `
exports.Tokenizer = class {
  constructor(tokenizer, config) { this.vocab = tokenizer.vocab; this.config = config; }
  encode(text, options = {}) {
    const ids = text.split(/\\s+/).filter(Boolean).map((w) => this.vocab[w] ?? w.length);
    return { ids: options.add_special_tokens === false ? ids : [101, ...ids, 102] };
  }
};
`;

let root: string;
let pkg: string;
let cache: string;

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** The embedder's package as it fails: its import (no native runtime for the machine), building the pipeline (offline), or its first embedding (a tokenizer built empty). */
type NativeFault = 'import' | 'offline' | 'empty-tokenizer';
const NATIVE: Record<NativeFault, string> = {
  import: "throw new Error('no native runtime for this machine');",
  offline: "exports.env = {}; exports.pipeline = async () => { throw new Error('fetch failed: getaddrinfo ENOTFOUND huggingface.co'); };",
  'empty-tokenizer': "exports.env = {}; exports.pipeline = async () => async () => { throw new TypeError('this.tokenizer is not a function'); };",
};

function fakeFolder({ runtime = true, native = 'import' }: { runtime?: boolean; native?: NativeFault } = {}): void {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'dialogwright-onnx-wasm-')));
  write(join(root, 'package.json'), '{"name":"app","private":true}');
  pkg = join(root, 'node_modules', '@huggingface', 'transformers');
  write(join(pkg, 'package.json'), '{"name":"@huggingface/transformers","main":"index.js"}');
  write(join(pkg, 'index.js'), NATIVE[native]);
  if (runtime) {
    const ort = join(root, 'node_modules', 'onnxruntime-web');
    write(join(ort, 'package.json'), '{"name":"onnxruntime-web","main":"dist/ort.node.js"}');
    write(join(ort, 'dist', 'ort.node.js'), FAKE_ORT);
    const tok = join(root, 'node_modules', '@huggingface', 'tokenizers');
    write(join(tok, 'package.json'), '{"name":"@huggingface/tokenizers","main":"index.js"}');
    write(join(tok, 'index.js'), FAKE_TOKENIZERS);
  }
  cache = join(pkg, '.cache', MODEL, REVISION);
  write(join(cache, 'tokenizer.json'), JSON.stringify({ vocab: { '[PAD]': 7 } }));
  write(join(cache, 'tokenizer_config.json'), JSON.stringify({ pad_token: '[PAD]', model_max_length: 6 }));
  write(join(cache, 'onnx', 'model.onnx'), 'fp32 weights');
  write(join(cache, 'onnx', 'model_quantized.onnx'), 'q8 weights');
}

type Recorded = { feeds: Array<Record<string, { data: BigInt64Array; dims: number[] }>>; models: Array<{ bytes: string; options: unknown; env: Record<string, unknown> }> };
const recorded = (): Recorded => (globalThis as unknown as { __fakeOrt: Record<string, Recorded> }).__fakeOrt[join(root, 'node_modules', 'onnxruntime-web', 'dist')]!;
const ids = (t: { data: BigInt64Array }): number[] => Array.from(t.data, Number);

describe('the ONNX embedder on WebAssembly (kb/onnxWasm)', async () => {
  // Where the real package can be imported from here (a developer's own install), the loader finds it first.
  const nativeHere = await onnxAvailable();

  beforeEach(() => fakeFolder());
  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(root, { recursive: true, force: true });
  });

  it('finds the runtime and the tokenizer beside the package, and the package from its entry', () => {
    expect(wasmRuntimeBeside(pkg)).toBe(true);
    expect(packageDirOf(join(pkg, 'index.js'))).toBe(pkg);
    rmSync(root, { recursive: true, force: true });
    fakeFolder({ runtime: false });
    expect(wasmRuntimeBeside(pkg)).toBe(false);
  });

  it('runs the cached model on one thread, its tokens padded with the pad token and each text pooled from its [CLS] token', async () => {
    const extract = await wasmTransformers(pkg).pipeline('feature-extraction', MODEL, { revision: REVISION, dtype: 'fp32' });
    const out = (await extract(['ab cde', 'f'], { pooling: 'cls', normalize: true })).tolist();
    const [model] = recorded().models;
    expect(model!.bytes).toBe('fp32 weights');
    expect(model!.options).toEqual({ executionProviders: ['wasm'] });
    expect(model!.env.numThreads).toBe(1);
    expect(model!.env.wasmPaths).toBe(`${join(root, 'node_modules', 'onnxruntime-web', 'dist')}/`);
    const [feeds] = recorded().feeds;
    expect(feeds!.input_ids!.dims).toEqual([2, 4]);
    expect(ids(feeds!.input_ids!)).toEqual([101, 2, 3, 102, 101, 1, 102, 7]);
    expect(ids(feeds!.attention_mask!)).toEqual([1, 1, 1, 1, 1, 1, 1, 0]);
    expect(ids(feeds!.token_type_ids!)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    for (const row of out) {
      expect(row[0]).toBeCloseTo(1 / Math.sqrt(5), 6);
      expect(row[1]).toBeCloseTo(2 / Math.sqrt(5), 6);
    }
  });

  it('means a text over its own tokens, never the padding, and keeps a long text to the model\'s length with its separator last', async () => {
    const extract = await wasmTransformers(pkg).pipeline('feature-extraction', MODEL, { revision: REVISION });
    const [short, long] = (await extract(['ab', 'a bb ccc dddd eeeee ffffff'], { pooling: 'mean', normalize: false })).tolist();
    expect(short).toEqual([(101 + 2 + 102) / 3, (2 * (101 + 2 + 102)) / 3]);
    const [feeds] = recorded().feeds;
    expect(ids(feeds!.input_ids!).slice(6)).toEqual([101, 1, 2, 3, 4, 102]);
    expect(long![0]).toBeCloseTo((101 + 1 + 2 + 3 + 4 + 102) / 6, 6);
  });

  it('reads the weights of the precision asked, and refuses one it has no file for', async () => {
    const t = wasmTransformers(pkg);
    const extract = await t.pipeline('feature-extraction', MODEL, { revision: REVISION, dtype: 'q8' });
    await extract(['a'], { pooling: 'cls', normalize: true });
    expect(recorded().models[0]!.bytes).toBe('q8 weights');
    await expect(t.pipeline('feature-extraction', MODEL, { revision: REVISION, dtype: 'int4' })).rejects.toThrow('reads fp32, fp16 or q8 weights, not int4');
  });

  it('with remote models off, says which file is not in the cache; otherwise fetches it at the pinned revision into the cache', async () => {
    rmSync(join(cache, 'tokenizer.json'));
    const t = wasmTransformers(pkg);
    t.env.allowRemoteModels = false;
    await expect(t.pipeline('feature-extraction', MODEL, { revision: REVISION })).rejects.toThrow(`the model file tokenizer.json of ${MODEL} at ${REVISION} is not in the cache`);
    const fetched: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      fetched.push(url);
      return new Response(JSON.stringify({ vocab: { '[PAD]': 7 } }));
    });
    t.env.allowRemoteModels = true;
    await t.pipeline('feature-extraction', MODEL, { revision: REVISION });
    expect(fetched).toEqual([`https://huggingface.co/${MODEL}/resolve/${REVISION}/tokenizer.json`]);
    expect(existsSync(join(cache, 'tokenizer.json'))).toBe(true);
  });

  it('reads the cache the embedder is given', async () => {
    const t = wasmTransformers(pkg);
    const elsewhere = join(root, 'models');
    t.env.cacheDir = elsewhere;
    t.env.allowRemoteModels = false;
    await expect(t.pipeline('feature-extraction', MODEL, { revision: REVISION })).rejects.toThrow(`(${join(elsewhere, MODEL, REVISION)})`);
  });

  it.skipIf(nativeHere)('is what the loader falls back to where the package is installed and does not load, and the embedder says so', async () => {
    const mod = await loadTransformers(root);
    expect(mod.runtime).toBe('wasm');
    const embedder = await OnnxEmbedder.create({ model: MODEL, revision: REVISION, from: root, localOnly: true });
    expect(embedder.runtime).toBe('wasm');
    expect(embedder.whyWasm).toBe('its native runtime does not load on this machine');
    expect(embedder.dim).toBe(2);
    const [v] = await embedder.embed(['When are you open?']);
    expect(Math.hypot(...v!)).toBeCloseTo(1, 6);
  });

  it.skipIf(nativeHere)('without the runtime beside it, says the package is installed and did not load, and why', async () => {
    rmSync(root, { recursive: true, force: true });
    fakeFolder({ runtime: false });
    const error = await loadTransformers(root).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OnnxUnavailableError);
    expect((error as Error).message).toContain(`is installed (${pkg}) but did not load`);
    expect((error as Error).message).toContain('no native runtime for this machine');
    expect((error as Error).message).not.toContain('pnpm add');
  });


  for (const fault of ['offline', 'empty-tokenizer'] as const) {
    it.skipIf(nativeHere)(`where the native runtime imports but cannot load the model (${fault}), loads it from the cache on WebAssembly, and says why`, async () => {
      rmSync(root, { recursive: true, force: true });
      fakeFolder({ native: fault });
      expect((await loadTransformers(root)).runtime).toBeUndefined();
      const embedder = await OnnxEmbedder.create({ model: MODEL, revision: REVISION, from: root });
      expect(embedder.runtime).toBe('wasm');
      expect(embedder.whyWasm).toBe(`its native runtime could not load the model (${fault === 'offline' ? 'fetch failed: getaddrinfo ENOTFOUND huggingface.co' : 'this.tokenizer is not a function'})`);
      const [v] = await embedder.embed(['When are you open?']);
      expect(Math.hypot(...v!)).toBeCloseTo(1, 6);
    });
  }

  it.skipIf(nativeHere)('where neither loads the model, says both; with no runtime beside it, the native runtime\'s own error', async () => {
    rmSync(root, { recursive: true, force: true });
    fakeFolder({ native: 'offline' });
    rmSync(join(cache, 'onnx', 'model.onnx'));
    await expect(OnnxEmbedder.create({ model: MODEL, revision: REVISION, from: root, localOnly: true })).rejects.toThrow(
      `the ONNX model ${MODEL} did not load on its native runtime (fetch failed: getaddrinfo ENOTFOUND huggingface.co), nor on WebAssembly (the model file onnx/model.onnx of ${MODEL} at ${REVISION} is not in the cache`,
    );
    rmSync(root, { recursive: true, force: true });
    fakeFolder({ native: 'empty-tokenizer', runtime: false });
    await expect(OnnxEmbedder.create({ model: MODEL, revision: REVISION, from: root })).rejects.toThrow('this.tokenizer is not a function');
  });
});
