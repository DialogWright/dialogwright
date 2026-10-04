import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { filesHash, sha256Hex, StaticEmbedder, STATIC_MODEL_FILES } from './static';

/**
 * The static models the engine knows, each pinned: the exact revision of its repository and the
 * SHA-256 of every file it reads. `pnpm kb:model` downloads them once into a cache folder, and a file
 * whose hash is not the pinned one is refused, at download and every time it is loaded. Nothing is
 * ever downloaded while a call is answered: the retriever reads the cache, and an app whose model
 * is not there retrieves by keywords alone (kb/hybrid.ts defaultRetriever).
 *
 * The cache folder is ~/.cache/dialogwright/models/<revision>, or $DIALOGWRIGHT_MODEL_DIR/<revision>
 * when that is set. The weights are not vendored into the repository (30 MB), and their licence (MIT)
 * travels with the download, from the model's own repository.
 */
export interface PinnedModel {
  /** Its id, as kb.yaml's retrieval.embedder names it. */
  readonly id: string;
  /** Its Hugging Face repository. */
  readonly repo: string;
  /** The repository's commit the files are read at. */
  readonly revision: string;
  /** Each file's SHA-256. */
  readonly files: Readonly<Record<(typeof STATIC_MODEL_FILES)[number], string>>;
  /** Its files' combined hash (static.ts filesHash): what an index records as `embedder.sha256`. */
  readonly sha256: string;
  readonly dim: number;
  /** The similarity below which a dense hit is not nominated, when kb.yaml gives no floor (from the bake-off, kb/bakeoff.ts). */
  readonly floor: number;
  /** The licence of its weights. */
  readonly license: string;
}

const POTION_FILES = {
  'config.json': '2a6ac0e9aaa356a68a5688070db78fc3a464fefe85d2f06a1905ce3718687553',
  'model.safetensors': 'f65d0f325faadc1e121c319e2faa41170d3fa07d8c89abd48ca5358d9a223de2',
  'tokenizer.json': 'e67e803f624fb4d67dea1c730d06e1067e1b14d830e2c2202569e3ef0f70bb50',
} as const;

/** potion-base-8M (MinishLab, MIT): 256 dimensions, a 29,528-token English WordPiece vocabulary, normalized vectors. */
export const POTION_BASE_8M: PinnedModel = Object.freeze({
  id: 'potion-base-8M',
  repo: 'minishlab/potion-base-8M',
  revision: 'bf8b056651a2c21b8d2565580b8569da283cab23',
  files: POTION_FILES,
  sha256: filesHash(POTION_FILES),
  dim: 256,
  floor: 0.3,
  license: 'MIT',
});

/** The static models by id. */
export const STATIC_MODELS: Readonly<Record<string, PinnedModel>> = Object.freeze({ [POTION_BASE_8M.id]: POTION_BASE_8M });

/** The engine's default embedder. */
export const DEFAULT_EMBEDDER = POTION_BASE_8M.id;

/** The environment variable that moves the model cache. */
export const MODEL_DIR_ENV = 'DIALOGWRIGHT_MODEL_DIR';

/** The folder the models' folders are in. */
export function modelRoot(env: NodeJS.ProcessEnv = process.env): string {
  const set = env[MODEL_DIR_ENV];
  return set !== undefined && set.trim() !== '' ? set : join(homedir(), '.cache', 'dialogwright', 'models');
}

/** The folder a pinned model's files are in. */
export function modelDir(model: PinnedModel, env: NodeJS.ProcessEnv = process.env): string {
  return join(modelRoot(env), model.revision);
}

/** Whether every file of the model is in the cache (not whether they are right: loading checks that). */
export function modelPresent(model: PinnedModel, env: NodeJS.ProcessEnv = process.env): boolean {
  const dir = modelDir(model, env);
  return STATIC_MODEL_FILES.every((f) => existsSync(join(dir, f)));
}

/** A model that is not in the cache, or whose files are not the pinned ones. */
export class ModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelError';
  }
}

/** The command that downloads the pinned models, as messages name it. */
export const MODEL_COMMAND = 'pnpm kb:model';

/** Loads a pinned model from the cache, each file checked against its pinned SHA-256. Throws a ModelError when one is missing or differs. */
export function loadPinnedModel(model: PinnedModel, env: NodeJS.ProcessEnv = process.env): StaticEmbedder {
  const dir = modelDir(model, env);
  const read: Record<string, Buffer> = {};
  for (const file of STATIC_MODEL_FILES) {
    const path = join(dir, file);
    if (!existsSync(path)) throw new ModelError(`the embedder ${model.id} is not in the cache (${path} is missing): run ${MODEL_COMMAND}`);
    const bytes = readFileSync(path);
    const got = sha256Hex(bytes);
    if (got !== model.files[file]) throw new ModelError(`${path} has the SHA-256 ${got}, not the pinned ${model.files[file]}: delete ${dir} and run ${MODEL_COMMAND}`);
    read[file] = bytes;
  }
  return new StaticEmbedder({ id: model.id, revision: model.revision, config: read['config.json']!.toString('utf8'), tokenizer: read['tokenizer.json']!.toString('utf8'), weights: read['model.safetensors']! });
}

/** The URL a pinned model's file is downloaded from: its repository at the pinned revision. */
export const fileUrl = (model: PinnedModel, file: string): string => `https://huggingface.co/${model.repo}/resolve/${model.revision}/${file}`;

export interface DownloadOptions {
  env?: NodeJS.ProcessEnv;
  /** The fetch to use. Default: the global one. */
  fetch?: typeof fetch;
  log?: (line: string) => void;
  /** How many times a file is tried. Default 3. */
  attempts?: number;
}

/**
 * Downloads a pinned model's files into the cache, each checked against its SHA-256 before it is
 * moved into place (a partial or different file is never left where loading would find it). A file
 * already there with the right hash is kept. Throws a ModelError when a file cannot be had with its
 * pinned hash.
 */
export async function downloadModel(model: PinnedModel, options: DownloadOptions = {}): Promise<{ dir: string; downloaded: string[] }> {
  const env = options.env ?? process.env;
  const get = options.fetch ?? fetch;
  const log = options.log ?? (() => {});
  const attempts = options.attempts ?? 3;
  const dir = modelDir(model, env);
  mkdirSync(dir, { recursive: true });
  const downloaded: string[] = [];
  for (const file of STATIC_MODEL_FILES) {
    const path = join(dir, file);
    const want = model.files[file];
    if (existsSync(path) && sha256Hex(readFileSync(path)) === want) continue;
    let last = '';
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const part = `${path}.part`;
      try {
        log(`downloading ${model.repo}@${model.revision.slice(0, 12)} ${file}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
        const response = await get(fileUrl(model, file));
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
        const hash = createHash('sha256');
        const out = createWriteStream(part);
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          hash.update(value);
          if (!out.write(value)) await new Promise<void>((resolve) => out.once('drain', () => resolve()));
        }
        await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
        const got = hash.digest('hex');
        if (got !== want) throw new Error(`its SHA-256 is ${got}, not the pinned ${want}`);
        renameSync(part, path);
        downloaded.push(file);
        last = '';
        break;
      } catch (error) {
        rmSync(part, { force: true });
        last = error instanceof Error ? error.message : String(error);
        log(`${file}: ${last}`);
      }
    }
    if (last !== '') throw new ModelError(`could not download ${file} of ${model.repo}@${model.revision}: ${last}`);
  }
  return { dir, downloaded };
}
