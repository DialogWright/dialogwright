import { inCi } from '../define/ci';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { loadAppFolder, loadKnowledgeFolder } from '../define/load';
import { formatProblem } from '../define/problems';
import { approveDocument, approveOne, formatApproveResult, placeOf, statusLines, notAPerson, type KbPlace } from './approval';
import { bakeoff, formatResults, formatSweep, parseParaphrases, parseSectionParaphrases, sweepSections, sweep } from './bakeoff';
import { SectionRetriever, summarizableSections, summarizing } from './sections';
import { DEFAULT_SECTIONS_CAP } from './schema';
import { downloadModel, loadPinnedModel, modelDir, modelPresent, STATIC_MODELS, DEFAULT_EMBEDDER, type PinnedModel } from './embed/model';
import type { Embedder } from './embed/types';
import { DenseRetriever, HybridRetriever } from './hybrid';
import { KeywordRetriever } from './keyword';
import type { DocumentsEmbedder, KnowledgeBase, Retriever } from './types';
import { allIndexTexts, buildIndex, INDEX_DIR, parseIndex, sectionsIndexTexts } from './vectorIndex';
import type { IndexText } from './words';

/**
 * The knowledge base's retrieval commands (the `dialogwright` bin, define/cli.ts):
 *
 *   kb:model [id...]                                 download the pinned static models into the cache (./embed/model.ts)
 *   kb:index [dir...]                                write each knowledge base's vector index (./vectorIndex.ts)
 *   kb:bakeoff <dir> --paraphrases <file> [--sweep]  compare the retrievers on a paraphrase file (./bakeoff.ts)
 *   kb:approve <id...> --by "<name>" [--owner "<team>"] [--dir <app>] [--yes]
 *                                                    approve passages and drafts (./approval.ts), confirmed at a terminal
 *   kb:status [dir...]                               the passages by state, the drafts, and the fix for each (./approval.ts)
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
  /** The embedder for the sections' ONNX model (kb.yaml documents.embedder), in place of the package's (a test's). */
  onnxEmbedderFor?: (settings: DocumentsEmbedder) => Promise<Embedder>;
  /** Today, as an ISO date: the day an approval is recorded on. Default: today (UTC). */
  today?: () => string;
  /**
   * Asks the person at the terminal kb:approve's question, true for a yes (a test's, in place of
   * the terminal). Default: the question on stderr and the answer read from stdin, when stdin is a
   * terminal (`isTTY`); without one, kb:approve refuses unless given --yes.
   */
  confirm?: (question: string) => Promise<boolean>;
  /** Whether stdin is a terminal a person answers at. Default: process.stdin.isTTY. */
  isTTY?: boolean;
}

/** The question on stderr, the answer from stdin: yes for "y" or "yes", in any case; anything else is no. */
async function terminalConfirm(question: string): Promise<boolean> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
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
    const kb = found.kb;
    /** Writes one index file from `embedder` over `texts`, re-embedding only the texts it does not have. */
    const write = async (fileId: string, embedder: () => Promise<Embedder>, texts: readonly IndexText[]): Promise<void> => {
      const file = join(found.kbDir, INDEX_DIR, `${fileId}.json`);
      const shown = join(found.label, INDEX_DIR, `${fileId}.json`);
      try {
        const before = existsSync(file) ? readFileSync(file, 'utf8') : null;
        const previous = before === null ? null : parseIndex(before);
        const built = await buildIndex(kb, await embedder(), typeof previous === 'string' ? null : previous, texts);
        if (before === built.text) {
          io.out(`${shown}: up to date (${built.data.entries.length} entries, sha256 ${built.hash.slice(0, 12)})`);
          return;
        }
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, built.text);
        io.out(`${shown}: wrote ${built.data.entries.length} entries (${built.embedded} texts embedded, ${built.reused} kept), sha256 ${built.hash.slice(0, 12)}`);
      } catch (error) {
        io.err(`${found.label}: ${error instanceof Error ? error.message : String(error)}`);
        failed = true;
      }
    };
    const id = kb.settings.retrieval.embedder;
    if (id === undefined && kb.settings.documents?.embedder === undefined) io.out(`${found.label}: kb.yaml names no embedder, so retrieval is by keywords alone and there is nothing to index (add retrieval.embedder: ${DEFAULT_EMBEDDER} for hybrid retrieval)`);
    else if (id === undefined) io.out(`${found.label}: kb.yaml names no embedder for the topics, so they are found by their keywords alone`);
    else await write(id, () => (io.embedderFor ?? ((m: PinnedModel) => pinnedEmbedder(m, io)))(STATIC_MODELS[id]!), allIndexTexts(kb));
    // The sections' own model (documents.embedder): their index of their own.
    const own = kb.settings.documents?.embedder;
    if (own !== undefined && summarizing(kb)) {
      const onnx = await import('./onnx');
      await write(onnx.onnxIndexIdOf(own), () => (io.onnxEmbedderFor ?? ((s: DocumentsEmbedder) => onnx.OnnxEmbedder.create({ model: s.onnx, revision: s.revision, pooling: s.pooling, dtype: s.dtype, ...(kb.folder !== undefined ? { from: dirname(kb.folder) } : {}) })))(own), sectionsIndexTexts(kb));
    }
  }
  return failed ? 1 : 0;
}

/** `kb:bakeoff <dir> --paraphrases <file> [--sweep] [--locale tag] [--today date] [--onnx-revision commit]`: each retriever's recall, candidates and latency (onnx only with its package and a pinned revision). */
/** kb:bakeoff --sections: the section retriever, by keywords and by meaning, on paraphrases of sections; every document's sections, approved or not. */
async function sectionsBakeoff(dirArg: string, file: string, doSweep: boolean, todayArg: string | undefined, io: KbIo): Promise<number> {
  const found = findKb(resolve(io.cwd, dirArg), dirArg, undefined);
  if (!found.kb) {
    for (const line of found.problems) io.err(line);
    return 1;
  }
  const kb = found.kb;
  if (!summarizing(kb)) {
    io.err('dialogwright kb:bakeoff: --sections measures the sections of documents, and this knowledge base summarizes none: set documents: { summarize: on } in kb.yaml');
    return 1;
  }
  const keys = summarizableSections(kb, { approved: false }).map((s) => s.key);
  let paraphrases;
  try {
    paraphrases = parseSectionParaphrases(readFileSync(resolve(io.cwd, file), 'utf8'), keys);
  } catch (error) {
    io.err(`dialogwright kb:bakeoff: ${file}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const locale = kb.defaultLocale;
  const today = todayArg ?? new Date().toISOString().slice(0, 10);
  const cap = kb.settings.documents?.cap ?? DEFAULT_SECTIONS_CAP;
  const counted = Object.values(paraphrases.topics).reduce((n, l) => n + l.length, 0);
  io.out(`${found.label}: ${keys.length} sections that may be summarized (approved or not), cap ${cap}; ${counted} paraphrases of ${Object.keys(paraphrases.topics).length} sections and ${paraphrases.none.length} lines about none`);
  const runs: { name: string; retriever: SectionRetriever }[] = [{ name: 'keyword', retriever: new SectionRetriever(kb, { all: true, cap }) }];
  const env = io.env ?? process.env;
  const own = kb.settings.documents?.embedder;
  let modelId: string;
  if (own !== undefined) {
    // The sections' own model (documents.embedder), as the app finds them with it.
    const onnx = await import('./onnx');
    modelId = own.onnx;
    try {
      const embedder = await (io.onnxEmbedderFor ?? ((s: DocumentsEmbedder) => onnx.OnnxEmbedder.create({ model: s.onnx, revision: s.revision, pooling: s.pooling, dtype: s.dtype, ...(kb.folder !== undefined ? { from: dirname(kb.folder) } : {}) })))(own);
      const built = await buildIndex(kb, embedder, null, sectionsIndexTexts(kb));
      const floor = kb.settings.documents?.floor ?? onnx.ONNX_DEFAULT_FLOOR;
      runs.push({ name: `hybrid (${own.onnx}, floor ${floor})`, retriever: new SectionRetriever(kb, { all: true, cap, dense: { embedder, vectors: built.data, floor } }) });
      runs.push({ name: `dense (${own.onnx}, floor ${floor})`, retriever: new SectionRetriever(kb, { all: true, cap, dense: { embedder, vectors: built.data, floor }, keywords: false }) });
    } catch (error) {
      io.out(`${own.onnx}: skipped, ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    const model = STATIC_MODELS[kb.settings.retrieval.embedder ?? DEFAULT_EMBEDDER]!;
    modelId = model.id;
    if (modelPresent(model, env)) {
      const embedder = loadPinnedModel(model, env);
      const built = await buildIndex(kb, embedder);
      const floor = kb.settings.documents?.floor ?? kb.settings.retrieval.floor ?? model.floor;
      runs.push({ name: `hybrid (${model.id}, floor ${floor})`, retriever: new SectionRetriever(kb, { all: true, cap, dense: { embedder, vectors: built.data, floor } }) });
      runs.push({ name: `dense (${model.id}, floor ${floor})`, retriever: new SectionRetriever(kb, { all: true, cap, dense: { embedder, vectors: built.data, floor }, keywords: false }) });
    } else io.out(`hybrid: skipped, ${model.id} is not in the cache (run pnpm kb:model)`);
  }
  const results = [];
  for (const run of runs) results.push(await bakeoff(run.retriever, paraphrases, locale, today, run.name));
  io.out('');
  for (const line of formatResults(results)) io.out(line);
  const hybrid = runs[1]?.retriever;
  if (doSweep && hybrid) {
    io.out('');
    io.out(`sweep of sections with ${modelId} (hybrid: keyword hits always count, the floor applies to hits by meaning; dense: by meaning alone):`);
    for (const line of formatSweep(await sweepSections(hybrid, paraphrases, locale))) io.out(line);
  }
  return 0;
}

export async function kbBakeoffCommand(args: readonly string[], io: KbIo): Promise<number> {
  const parsed = parseArgs(args, { values: ['--paraphrases', '--sections', '--locale', '--today', '--onnx-revision'], flags: ['--sweep'] });
  if (typeof parsed === 'string' || parsed.positional.length !== 1 || (parsed.values['--paraphrases'] === undefined) === (parsed.values['--sections'] === undefined)) {
    io.err(`dialogwright kb:bakeoff: ${typeof parsed === 'string' ? parsed : 'give one knowledge base (an app folder, or a kb folder) and either --paraphrases <file> (topics) or --sections <file> (the sections of documents)'}\nusage: dialogwright kb:bakeoff <dir> --paraphrases <file> [--sweep] [--locale tag] [--today YYYY-MM-DD] [--onnx-revision <commit>]\n       dialogwright kb:bakeoff <dir> --sections <file> [--sweep] [--today YYYY-MM-DD]   (kb.yaml documents: summarize on; every document's sections, approved or not)`);
    return 2;
  }
  if (parsed.values['--sections'] !== undefined) return sectionsBakeoff(parsed.positional[0]!, parsed.values['--sections'], parsed.flags.has('--sweep'), parsed.values['--today'], io);
  const dir = resolve(io.cwd, parsed.positional[0]!);
  const found = findKb(dir, parsed.positional[0]!, undefined);
  if (!found.kb) {
    for (const line of found.problems) io.err(line);
    return 1;
  }
  const kb = found.kb;
  let paraphrases;
  try {
    paraphrases = parseParaphrases(readFileSync(resolve(io.cwd, parsed.values['--paraphrases']!), 'utf8'), kb);
  } catch (error) {
    io.err(`dialogwright kb:bakeoff: ${parsed.values['--paraphrases']}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const locale = parsed.values['--locale'] ?? kb.defaultLocale;
  const today = parsed.values['--today'] ?? new Date().toISOString().slice(0, 10);
  const cap = kb.settings.retrieval.cap;
  const counted = Object.values(paraphrases.topics).reduce((n, l) => n + l.length, 0);
  io.out(`${found.label}: ${Object.keys(kb.topics).length} topics, cap ${cap}; ${counted} paraphrases of ${Object.keys(paraphrases.topics).length} topics and ${paraphrases.none.length} lines about none, in ${locale}`);

  const keyword = new KeywordRetriever(kb, { cap });
  const runs: { name: string; retriever: Retriever }[] = [{ name: 'keyword', retriever: keyword }];
  const dense: { name: string; dense: DenseRetriever }[] = [];
  const env = io.env ?? process.env;
  const model = STATIC_MODELS[kb.settings.retrieval.embedder ?? DEFAULT_EMBEDDER]!;
  if (modelPresent(model, env)) {
    const embedder = loadPinnedModel(model, env);
    const built = await buildIndex(kb, embedder);
    const floor = kb.settings.retrieval.floor ?? model.floor;
    const d = new DenseRetriever(kb, { embedder, vectors: built.data, floor, cap });
    runs.push({ name: `static (${model.id}, floor ${floor})`, retriever: d }, { name: `hybrid (${model.id})`, retriever: new HybridRetriever(kb, { embedder, vectors: built.data, floor, cap, keyword }) });
    dense.push({ name: model.id, dense: d });
  } else io.out(`static, hybrid: skipped, ${model.id} is not in the cache (run pnpm kb:model)`);
  try {
    const onnx = await import('./onnx');
    const revision = parsed.values['--onnx-revision'];
    if (!(await onnx.onnxAvailable())) io.out(`onnx: skipped, ${onnx.ONNX_PACKAGE} is not installed`);
    else if (revision === undefined) io.out(`onnx: skipped, no --onnx-revision (the commit of ${onnx.ONNX_DEFAULT_MODEL} to load: a model is always pinned)`);
    else {
      const embedder = await onnx.OnnxEmbedder.create({ revision });
      const built = await buildIndex(kb, embedder);
      const d = new DenseRetriever(kb, { embedder, vectors: built.data, floor: onnx.ONNX_DEFAULT_FLOOR, cap });
      runs.push({ name: `onnx (floor ${onnx.ONNX_DEFAULT_FLOOR})`, retriever: d }, { name: 'onnx hybrid', retriever: new HybridRetriever(kb, { embedder, vectors: built.data, floor: onnx.ONNX_DEFAULT_FLOOR, cap, keyword }) });
      dense.push({ name: embedder.id, dense: d });
    }
  } catch (error) {
    io.out(`onnx: skipped (${error instanceof Error ? error.message : String(error)})`);
  }

  const results = [];
  for (const run of runs) results.push(await bakeoff(run.retriever, paraphrases, locale, today, run.name));
  io.out('');
  for (const line of formatResults(results)) io.out(line);
  if (parsed.flags.has('--sweep')) {
    for (const d of dense) {
      io.out('');
      io.out(`sweep with ${d.name} (keyword hits always count; the floor applies to dense hits):`);
      for (const line of formatSweep(await sweep(keyword, d.dense, paraphrases, locale))) io.out(line);
    }
  }
  return 0;
}

/** The knowledge bases a kb command means when it is given no folder: the working directory's, else every app folder's with a kb/. */
function placesFrom(io: KbIo, discover: () => string[]): KbPlace[] | string {
  const here = placeOf(io.cwd, '.');
  if (typeof here !== 'string') return [here];
  const places = discover().map((d) => placeOf(d, relative(io.cwd, d) || '.')).filter((p): p is KbPlace => typeof p !== 'string');
  return places.length > 0 ? places : 'no knowledge base found: the working directory is not an app folder with a kb/, and no app folder has a kb/kb.yaml';
}

const APPROVE_USAGE = 'usage: dialogwright kb:approve <id...> --by "<your name>" [--owner "<team>"] [--dir <app folder>] [--yes]\n       dialogwright kb:approve --document <doc...> --by "<your name>" [--owner "<team>"] [--dir <app folder>] [--yes]   (a source document approved for summarizing: kb.yaml documents)';

/**
 * `kb:approve <id...> --by "<name>" [--owner "<team>"] [--dir <app>] [--yes]`: approves each passage
 * or draft (./approval.ts), saying what it did with each. An approval is a person's, so before it
 * writes anything it asks the person at the terminal to confirm, once per run: the ids, the
 * approver and the team, and that they read each answer against its source section (a yes is "y"
 * or "yes"). Without a terminal (stdin is not one: a script, a pipe, an assistant's shell) it
 * refuses, unless `--yes` confirms on the command line; `--yes` is refused in CI (`CI` set), where
 * no person is at the command, and like every run it is refused for a `--by` that names no person.
 * Exit 0 when each is approved (or already was), 1 when any is refused or the confirmation is not a
 * yes (nothing written), 2 for a command line not understood (no id, no --by, a --by that names no
 * person, --yes in CI, no terminal and no --yes).
 */
export async function kbApproveCommand(args: readonly string[], io: KbIo, discover: () => string[]): Promise<number> {
  const parsed = parseArgs(args, { values: ['--by', '--owner', '--dir'], flags: ['--yes', '--document'] });
  const documents = typeof parsed !== 'string' && parsed.flags.has('--document');
  if (typeof parsed === 'string' || parsed.positional.length === 0 || parsed.values['--by'] === undefined) {
    io.err(`dialogwright kb:approve: ${typeof parsed === 'string' ? parsed : parsed.positional.length === 0 ? (documents ? 'name the documents to approve for summarizing, by their file id in kb/sources' : 'name the passages or drafts to approve, by id') : `--by is required: the name of the person who ${documents ? 'read the documents and approves them for summarizing' : 'reviewed the passages against their sources and approves them'}`}\n${APPROVE_USAGE}`);
    return 2;
  }
  const by = parsed.values['--by'];
  const why = notAPerson(by);
  if (why) {
    io.err(`dialogwright kb:approve: ${why}\n${APPROVE_USAGE}`);
    return 2;
  }
  const yes = parsed.flags.has('--yes');
  if (yes && inCi(io.env ?? process.env)) {
    io.err('dialogwright kb:approve: --yes is refused in CI (CI is set): an approval is a person\'s, confirmed by them at their own terminal, and no person is at a CI job\'s command');
    return 2;
  }
  const confirm = yes ? null : io.confirm ?? ((io.isTTY ?? process.stdin.isTTY === true) ? terminalConfirm : null);
  if (!yes && confirm === null) {
    io.err('dialogwright kb:approve: stdin is not a terminal, so no one can confirm the approval: run it at your own terminal, or confirm on the command line with --yes (refused in CI)');
    return 2;
  }
  let place: KbPlace;
  if (parsed.values['--dir'] !== undefined) {
    const found = placeOf(resolve(io.cwd, parsed.values['--dir']), parsed.values['--dir']);
    if (typeof found === 'string') {
      io.err(`dialogwright kb:approve: ${found}`);
      return 1;
    }
    place = found;
  } else {
    const found = placesFrom(io, discover);
    if (typeof found === 'string' || found.length > 1) {
      io.err(`dialogwright kb:approve: ${typeof found === 'string' ? found : `several app folders have a knowledge base (${found.map((p) => dirname(p.label)).join(', ')}): say which with --dir`}`);
      return 1;
    }
    place = found[0]!;
  }
  const owner = parsed.values['--owner'];
  if (confirm !== null) {
    const ids = parsed.positional;
    const question = documents
      ? `Approve ${ids.length === 1 ? `the document ${ids[0]}` : `${ids.length} documents (${ids.join(', ')})`} in ${place.label} for summarizing, as ${by.trim()}${owner !== undefined ? ` for ${owner.trim()}` : ''}? You have read ${ids.length === 1 ? 'it' : 'each'} whole: callers may hear answers worded from ${ids.length === 1 ? 'its' : 'their'} sections, and you answer for what ${ids.length === 1 ? 'it says' : 'they say'}. [y/N] `
      : `Approve ${ids.length === 1 ? ids[0] : `${ids.length} passages (${ids.join(', ')})`} in ${place.label} as ${by.trim()}${owner !== undefined ? ` for ${owner.trim()}` : ''}? You have read ${ids.length === 1 ? 'its answer' : 'each answer'} against its source section and answer for it. [y/N] `;
    if (!(await confirm(question))) {
      io.err('dialogwright kb:approve: not confirmed: nothing approved, nothing written');
      return 1;
    }
  }
  const today = (io.today ?? (() => new Date().toISOString().slice(0, 10)))();
  let refused = false;
  for (const id of parsed.positional) {
    const options = { by, ...(owner !== undefined ? { owner } : {}), today };
    const result = documents ? approveDocument(place, id, options) : approveOne(place, id, options);
    const lines = formatApproveResult(result, place.label);
    if (result.outcome === 'refused') {
      refused = true;
      for (const line of lines) io.err(line);
    } else for (const line of lines) io.out(line);
  }
  return refused ? 1 : 0;
}

/** `kb:status [dir...]`: each knowledge base's passages by state, its drafts, and the fix for each. Exit 0, or 1 when one does not load. */
export function kbStatusCommand(args: readonly string[], io: KbIo, discover: () => string[]): number {
  const parsed = parseArgs(args, { values: [], flags: [] });
  if (typeof parsed === 'string') {
    io.err(`dialogwright kb:status: ${parsed}\nusage: dialogwright kb:status [dir...]`);
    return 2;
  }
  let places: KbPlace[];
  if (parsed.positional.length > 0) {
    places = [];
    for (const d of parsed.positional) {
      const found = placeOf(resolve(io.cwd, d), d);
      if (typeof found === 'string') {
        io.err(`dialogwright kb:status: ${found}`);
        return 1;
      }
      places.push(found);
    }
  } else {
    const found = placesFrom(io, discover);
    if (typeof found === 'string') {
      io.out(found);
      return 0;
    }
    places = found;
  }
  let ok = true;
  places.forEach((place, i) => {
    if (i > 0) io.out('');
    const status = statusLines(place);
    ok &&= status.ok;
    for (const line of status.lines) (status.ok ? io.out : io.err)(line);
  });
  return ok ? 0 : 1;
}
