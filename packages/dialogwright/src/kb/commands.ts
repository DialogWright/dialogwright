import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { loadAppFolder, loadKnowledgeFolder } from '../define/load';
import { formatProblem } from '../define/problems';
import { downloadModel, loadPinnedModel, modelDir, modelPresent, STATIC_MODELS, DEFAULT_EMBEDDER, type PinnedModel } from './embed/model';
import type { Embedder } from './embed/types';
import type { KnowledgeBase } from './types';
import { buildIndex, INDEX_DIR, parseIndex } from './vectorIndex';

/**
 * The knowledge base's retrieval commands (the `dialogwright` bin, define/cli.ts):
 *
 *   kb:model [id...]                                 download the pinned static models into the cache (./embed/model.ts)
 *   kb:index [dir...]                                write each knowledge base's vector index (./vectorIndex.ts)
 *
 * A `dir` is an app folder with a kb/, or a knowledge base folder itself (one with kb.yaml). With
 * no dir, kb:index indexes every app folder found as `check` finds them. Exit codes: 0 done, 1 a
 * problem (said on stderr), 2 a command line not understood.
 */

export interface KbIo {
  out(line: string): void;
  err(line: string): void;
  /** Where relative paths are from. */
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** The embedder for a pinned model, in place of the cache's (a test's). */
  embedderFor?: (model: PinnedModel) => Promise<Embedder>;
}

/** A knowledge base folder found from a dir: the folder, how problems name it, and the knowledge base (or the problems loading it). */
interface Found {
  kbDir: string;
  label: string;
  kb: KnowledgeBase | null;
  problems: string[];
}

/** The knowledge base at `dir`: an app folder's kb/ (read with the app's default locale), or a kb folder itself. */
function findKb(dir: string, label: string, locale: string | undefined): Found {
  if (existsSync(join(dir, 'kb.yaml'))) {
    const folder = loadKnowledgeFolder(dir, locale);
    return { kbDir: dir, label, kb: folder.kb, problems: folder.problems.map((p) => formatProblem({ ...p, file: join(label, relative(folder.base, p.file) || '.') })) };
  }
  if (!existsSync(join(dir, 'kb', 'kb.yaml'))) return { kbDir: dir, label, kb: null, problems: [`${label}: neither a knowledge base folder (kb.yaml) nor an app folder with one (kb/kb.yaml)`] };
  const loaded = loadAppFolder(dir);
  return { kbDir: join(dir, 'kb'), label: join(label, 'kb'), kb: loaded.config?.knowledge ?? null, problems: loaded.config ? [] : loaded.problems.map((p) => formatProblem({ ...p, file: join(label, p.file) })) };
}

/** Options of the form `--name value`; the rest are positional. Null when an option lacks its value or is not one of `known`. */
function parseArgs(args: readonly string[], known: { values: readonly string[]; flags: readonly string[] }): { positional: string[]; values: Record<string, string>; flags: Set<string> } | string {
  const positional: string[] = [];
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (known.flags.includes(a)) flags.add(a);
    else if (known.values.includes(a)) {
      const v = args[i + 1];
      if (v === undefined || v.startsWith('--')) return `${a} needs a value`;
      values[a] = v;
      i += 1;
    } else if (a.startsWith('-')) return `${a} is not an option`;
    else positional.push(a);
  }
  return { positional, values, flags };
}

/** The pinned model kb.yaml names, loaded from the cache, downloaded first when it is not there. */
async function pinnedEmbedder(model: PinnedModel, io: KbIo): Promise<Embedder> {
  const env = io.env ?? process.env;
  if (!modelPresent(model, env)) {
    io.out(`${model.id} is not in the cache (${modelDir(model, env)}): downloading it`);
    await downloadModel(model, { env, log: io.out });
  }
  return loadPinnedModel(model, env);
}

/** `kb:model [id...]`: downloads the pinned models (all, or those named) into the cache. */
export async function kbModelCommand(args: readonly string[], io: KbIo): Promise<number> {
  const parsed = parseArgs(args, { values: [], flags: [] });
  if (typeof parsed === 'string') {
    io.err(`dialogwright kb:model: ${parsed}`);
    return 2;
  }
  const ids = parsed.positional.length > 0 ? parsed.positional : Object.keys(STATIC_MODELS);
  const env = io.env ?? process.env;
  for (const id of ids) {
    const model = Object.hasOwn(STATIC_MODELS, id) ? STATIC_MODELS[id]! : undefined;
    if (!model) {
      io.err(`dialogwright kb:model: "${id}" is not a model the engine has (it has ${Object.keys(STATIC_MODELS).join(', ')})`);
      return 1;
    }
    try {
      const { dir, downloaded } = await downloadModel(model, { env, log: io.out });
      loadPinnedModel(model, env);
      io.out(`${model.id} (${model.repo}@${model.revision}, ${model.license}): ${downloaded.length === 0 ? 'already in the cache' : `downloaded ${downloaded.join(', ')}`}, verified, in ${dir}`);
    } catch (error) {
      io.err(`dialogwright kb:model: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }
  return 0;
}

/** `kb:index [dir...] [--locale tag]`: writes each knowledge base's index for the embedder its kb.yaml names, re-embedding only new texts. */
export async function kbIndexCommand(args: readonly string[], io: KbIo, discover: () => string[]): Promise<number> {
  const parsed = parseArgs(args, { values: ['--locale'], flags: [] });
  if (typeof parsed === 'string') {
    io.err(`dialogwright kb:index: ${parsed}`);
    return 2;
  }
  const dirs = parsed.positional.length > 0 ? parsed.positional.map((d) => resolve(io.cwd, d)) : discover().filter((d) => existsSync(join(d, 'kb', 'kb.yaml')));
  if (dirs.length === 0) {
    io.out('no knowledge base found: no app folder has a kb/kb.yaml');
    return 0;
  }
  let failed = false;
  for (const dir of dirs) {
    const found = findKb(dir, relative(io.cwd, dir) || '.', parsed.values['--locale']);
    if (!found.kb) {
      for (const line of found.problems) io.err(line);
      failed = true;
      continue;
    }
    const id = found.kb.settings.retrieval.embedder;
    if (id === undefined) {
      io.out(`${found.label}: kb.yaml names no embedder, so retrieval is by keywords alone and there is nothing to index (add retrieval.embedder: ${DEFAULT_EMBEDDER} for hybrid retrieval)`);
      continue;
    }
    const model = STATIC_MODELS[id]!;
    const file = join(found.kbDir, INDEX_DIR, `${id}.json`);
    const shown = join(found.label, INDEX_DIR, `${id}.json`);
    try {
      const embedder = await (io.embedderFor ?? ((m: PinnedModel) => pinnedEmbedder(m, io)))(model);
      const before = existsSync(file) ? readFileSync(file, 'utf8') : null;
      const previous = before === null ? null : parseIndex(before);
      const built = await buildIndex(found.kb, embedder, typeof previous === 'string' ? null : previous);
      if (before === built.text) {
        io.out(`${shown}: up to date (${built.data.entries.length} entries, sha256 ${built.hash.slice(0, 12)})`);
        continue;
      }
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, built.text);
      io.out(`${shown}: wrote ${built.data.entries.length} entries (${built.embedded} texts embedded, ${built.reused} kept), sha256 ${built.hash.slice(0, 12)}`);
    } catch (error) {
      io.err(`${found.label}: ${error instanceof Error ? error.message : String(error)}`);
      failed = true;
    }
  }
  return failed ? 1 : 0;
}
