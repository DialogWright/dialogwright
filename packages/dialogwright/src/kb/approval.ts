import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { isMap, LineCounter, parseDocument, type Document } from 'yaml';
import { knowledgeUseProblems, knowledgeUseStateProblems } from '../define/knowledgeUse';
import { DEFAULT_LOCALE, loadAppFolder, loadKnowledgeFolder, parseKbFile, type LoadedConfig } from '../define/load';
import { closest, formatProblem, positionOf, type DataPath, type Problem } from '../define/problems';
import { PENDING_TOPICS_FILE, passageOf, sourceTextOf } from './folder';
import { collapseWhitespace } from './hash';
import { excerptProblems, NO_EXCERPT } from './excerpt';
import { APPROVALS_LOG, approvalLogged, logLineOf, parseApprovalLog, type ApprovalLogLine } from './log';
import { approveCommandFor, EDITED_WHAT, kbContentProblems, kbLinkProblems, kbStateProblems, type Locate } from './rules';
import { KB_FILE_ID, type KbPassageYaml, type KbPendingYaml } from './schema';
import type { KbPassage, KnowledgeBase } from './types';

/**
 * Approving passages, and seeing which wait (the `dialogwright` bin's kb:approve and kb:status,
 * through ./commands.ts):
 *
 *   kb:approve <id...> --by "<name>" [--owner "<team>"] [--dir <app>]
 *   kb:status [dir...]
 *
 * An approval is a person's: they read the answer against its source section and answer for it.
 * kb:approve records it in the passage (`approval: { owner, approvedBy, on, sourceHash, hash }`,
 * ./hash.ts) and appends one line to kb/approvals.jsonl, the log no one rewrites, with the source
 * section's text as approved (so a later review can show how the source changed since). It takes either
 *
 *  - a passage in kb/passages (or kb/locale/<tag>/passages) that is unapproved, stale (its source
 *    section changed) or edited since its approval: it is approved as it is now; or
 *  - a draft, kb/pending/<id>.yaml (the passage's fields without `approval`, and `drafted: { by,
 *    on, excerpt }`, ./schema.ts kbPendingSchema): it is checked, `drafted` is dropped, and it moves
 *    to kb/passages/<id>.yaml (kb/locale/<tag>/passages for a draft in another locale).
 *
 * It refuses, writing nothing for that id: a `--by` that names no person (an assistant, a tool);
 * an id that is no passage or draft; a passage that would fail `pnpm check` for anything but its
 * approval (its file, its topic and source, its applies and dates, an overlap with another passage,
 * a locale the app does not speak, an intent that says it); a draft with no `drafted.excerpt`, or one
 * not in its source section word for word, shorter than 4 words and 20 characters, or missing a
 * number its answer says (./excerpt.ts, as kb:draft and kb:review hold it); a knowledge base that
 * does not load. Edits keep the file's
 * comments and layout (the yaml library's Document). Each id is approved on its own, in the order
 * given, so one refused leaves the others as they are.
 */

export { APPROVALS_LOG, type ApprovalLogLine } from './log';

/**
 * The lines of a kb folder's approvals.jsonl, oldest first: none when there is no log. A line that
 * is not JSON, or lacks an id, a hash or a `from`, is passed over (./log.ts parseApprovalLog).
 */
export function readApprovalLog(kbDir: string): ApprovalLogLine[] {
  const file = join(kbDir, APPROVALS_LOG);
  if (!existsSync(file)) return [];
  return parseApprovalLog(readFileSync(file, 'utf8'));
}

/** A knowledge base on disk: its folder, the folder its files are named from, and how problems name it. */
export interface KbPlace {
  /** The kb folder. */
  kbDir: string;
  /** The app folder that holds it, or null for a knowledge base folder on its own. */
  appDir: string | null;
  /** How the command's output names the kb folder. */
  label: string;
}

/** The kb folder at `dir`: an app folder with a kb/, or a kb folder itself; or why there is none. */
export function placeOf(dir: string, label: string): KbPlace | string {
  if (existsSync(join(dir, 'app.yaml')) && existsSync(join(dir, 'kb', 'kb.yaml'))) return { kbDir: join(dir, 'kb'), appDir: dir, label: join(label, 'kb') };
  if (existsSync(join(dir, 'kb.yaml'))) return { kbDir: dir, appDir: null, label };
  return `${label}: neither an app folder with a knowledge base (kb/kb.yaml) nor a knowledge base folder (kb.yaml)`;
}

interface Loaded {
  kb: KnowledgeBase | null;
  problems: Problem[];
  config: LoadedConfig | null;
  locate: Locate;
  /** The kb folder's name, as problems' paths start. */
  base: string;
}

function load(place: KbPlace): Loaded {
  const base = basename(place.kbDir);
  if (place.appDir !== null) {
    const loaded = loadAppFolder(place.appDir);
    return { kb: loaded.config?.knowledge ?? null, problems: loaded.problems, config: loaded.config, locate: loaded.locate, base };
  }
  const folder = loadKnowledgeFolder(place.kbDir, DEFAULT_LOCALE);
  return { kb: folder.kb, problems: folder.problems, config: null, locate: folder.locate, base };
}

/** The words a name for a person may not be made of only, and the words no person's name has. */
const NOT_A_PERSON_ONLY = new Set(['ai', 'a', 'an', 'the', 'my', 'model', 'system', 'auto', 'automated', 'automatic', 'automation', 'script', 'ci', 'machine', 'tool', 'robot', 'computer', 'drafter', 'pipeline', 'unknown', 'nobody', 'none', 'anonymous', 'n', 'test', 'tbd', 'todo', 'me', 'admin', 'root', 'user', 'name', 'your']);
const NOT_A_PERSON_ANY = new Set(['assistant', 'claude', 'chatgpt', 'gpt', 'llm', 'copilot', 'bot', 'chatbot', 'dialogwright', 'anthropic', 'openai']);

/**
 * Why `by` cannot be the approver (null when it can): it must name a person, who reviewed the
 * passage against its source and answers for it. An assistant, a model or a tool may draft a
 * passage; it never approves one. This refuses the obvious stand-ins; it cannot tell a real name.
 */
export function notAPerson(by: string): string | null {
  const name = by.trim();
  if (name === '') return '--by is empty: an approval records the person who approved the passage';
  if (/[<>]/.test(name)) return `--by "${name}" is a placeholder: write your own name in its place`;
  if (!/\p{L}/u.test(name)) return `--by "${name}" is not a person's name`;
  const words = name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w !== '');
  if (words.some((w) => NOT_A_PERSON_ANY.has(w)) || words.every((w) => NOT_A_PERSON_ONLY.has(w))) {
    return `--by "${name}" is not a person: an approval records the person who read the answer against its source and answers for it, and an assistant or a tool may draft a passage but never approve one`;
  }
  return null;
}

/** Whether a draft's excerpt is in its source section's text word for word (whitespace aside). */
export function excerptInSource(excerpt: string, sectionText: string): boolean {
  const quoted = collapseWhitespace(excerpt);
  return quoted !== '' && collapseWhitespace(sectionText).includes(quoted);
}

/** What kb:approve did with one id. */
export type ApproveResult =
  | { id: string; outcome: 'approved'; from: 'pending' | 'passage'; file: string; line: ApprovalLogLine; moved?: string }
  | { id: string; outcome: 'fresh'; file: string; approvedBy: string; on: string }
  | { id: string; outcome: 'refused'; reason: string; problems: string[] };

export interface ApproveOptions {
  by: string;
  owner?: string;
  /** The day the approval is recorded on, ISO. */
  today: string;
}

const LOCALE_TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** The yaml library's reading, as the loader reads the files (./define/load.ts), keeping comments. */
function parseForEdit(text: string): { doc: Document; lines: LineCounter } {
  const lines = new LineCounter();
  const doc = parseDocument(text, { version: '1.2', schema: 'core', uniqueKeys: true, prettyErrors: false, logLevel: 'error', lineCounter: lines, customTags: [] });
  return { doc, lines };
}

/** Writes `approval` into the passage's document: the fields of an approval already there replaced in place, else a new approval at the end. */
function setApproval(doc: Document, approval: NonNullable<KbPassage['approval']>): void {
  const value = { owner: approval.owner, approvedBy: approval.approvedBy, on: approval.on, sourceHash: approval.sourceHash, hash: approval.hash };
  const existing = doc.get('approval', true);
  if (isMap(existing)) {
    for (const [key, v] of Object.entries(value)) existing.set(key, v);
  } else {
    doc.set('approval', doc.createNode(value));
  }
}

/** The ids of the passages and drafts a knowledge base folder has on disk, for a near-miss hint. */
function idsOnDisk(kbDir: string): string[] {
  const ids: string[] = [];
  const yamlIn = (dir: string, skip?: string): void => {
    try {
      for (const name of readdirSync(dir)) if (name.endsWith('.yaml') && name !== skip) ids.push(name.slice(0, -'.yaml'.length));
    } catch {
      // a folder that is not there has none
    }
  };
  yamlIn(join(kbDir, 'passages'));
  yamlIn(join(kbDir, 'pending'), PENDING_TOPICS_FILE);
  for (const tag of localeDirs(kbDir)) yamlIn(join(kbDir, 'locale', tag, 'passages'));
  return ids;
}

function localeDirs(kbDir: string): string[] {
  try {
    return readdirSync(join(kbDir, 'locale'), { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

/** The problems among `problems` that are about this passage: in its file, naming it, or about its locale. */
function about(problems: readonly Problem[], passage: { id: string; file: string; locale: string }, base: string): Problem[] {
  const localeDir = `${base}/locale/${passage.locale}`;
  return problems.filter((p) => p.file === passage.file || p.message.includes(`"${passage.id}"`) || p.file === localeDir);
}

/** What `pnpm check` would say about the passage once approved: the knowledge base with `candidate` in place, the rules run, those about it kept. */
function checkCandidate(loaded: Loaded, kb: KnowledgeBase, candidate: KbPassage, today: string, locate: Locate): Problem[] {
  const passages = Object.fromEntries(Object.entries({ ...kb.passages, [candidate.id]: candidate }).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  // The approval's line, as kb:approve appends it once the passage is written.
  const log = kb.approvalLog;
  const approvalLog = log !== undefined && 'lines' in log && candidate.approval ? { ...log, lines: [...log.lines, { id: candidate.id, hash: candidate.approval.hash, from: 'passage' }] } : log;
  const next: KnowledgeBase = { ...kb, passages, ...(approvalLog ? { approvalLog } : {}) };
  const problems = [...kbContentProblems(next, locate, loaded.base), ...kbStateProblems(next, today, locate, loaded.base)];
  if (loaded.config) {
    const config: LoadedConfig = { ...loaded.config, knowledge: next };
    problems.push(...kbLinkProblems(next, { actions: new Set(Object.keys(config.policy.actions)), locales: Object.keys(config.prompts) }, locate, loaded.base));
    problems.push(...knowledgeUseProblems(config, locate), ...knowledgeUseStateProblems(config, locate));
  }
  return about(problems, candidate, loaded.base);
}

/** A refusal because the knowledge base does not load: the problems about this id, or how many there are elsewhere. */
function notLoaded(id: string, loaded: Loaded, files: readonly string[]): ApproveResult {
  const mine = loaded.problems.filter((p) => files.includes(p.file) || p.message.includes(`"${id}"`));
  if (mine.length > 0) return { id, outcome: 'refused', reason: 'it would fail pnpm check: fix these first', problems: mine.map(formatProblem) };
  const n = loaded.problems.length;
  return { id, outcome: 'refused', reason: `the knowledge base does not load (${n} problem${n === 1 ? '' : 's'} elsewhere): fix ${n === 1 ? 'it' : 'them'} first; pnpm check lists ${n === 1 ? 'it' : 'them'}`, problems: [] };
}

/**
 * Appends one approval to kb/approvals.jsonl, on a line of its own (after a last line someone left
 * without its newline). The one writer of the log's lines: kb:approve's, and kb:review's when a person
 * confirms an approval a migration carried over.
 */
export function appendApprovalLog(kbDir: string, line: ApprovalLogLine): void {
  const file = join(kbDir, APPROVALS_LOG);
  let lead = '';
  if (existsSync(file) && statSync(file).size > 0 && !readFileSync(file, 'utf8').endsWith('\n')) lead = '\n';
  appendFileSync(file, `${lead}${JSON.stringify(line)}\n`);
}

/** Approves one passage or draft (see the module comment). Writes nothing when it refuses. */
export function approveOne(place: KbPlace, id: string, options: ApproveOptions): ApproveResult {
  if (!KB_FILE_ID.test(id)) return { id, outcome: 'refused', reason: `"${id}" is not a passage id (letters, digits, underscores, hyphens and dots, starting with a letter or digit)`, problems: [] };
  const loaded = load(place);
  const root = dirname(place.kbDir);
  const base = loaded.base;
  const passageFiles = [`${base}/passages/${id}.yaml`, ...localeDirs(place.kbDir).map((tag) => `${base}/locale/${tag}/passages/${id}.yaml`)].filter((f) => existsSync(join(root, f)));
  const pendingFile = `${base}/pending/${id}.yaml`;
  // pending/topics.yaml holds proposed topics, never a draft.
  const pending = `${id}.yaml` !== PENDING_TOPICS_FILE && existsSync(join(root, pendingFile));
  if (passageFiles.length > 0 && pending) {
    return { id, outcome: 'refused', reason: `both ${passageFiles[0]} and the draft ${pendingFile} have the id "${id}": approving the draft would replace the passage`, problems: ['rename the draft (its file and its id) to a new id, or delete it'] };
  }
  if (passageFiles.length === 0 && !pending) {
    const near = closest(id, idsOnDisk(place.kbDir));
    return { id, outcome: 'refused', reason: `there is no passage or draft "${id}" (${base}/passages, ${base}/locale/<tag>/passages, ${base}/pending)${near ? `; did you mean "${near}"?` : ''}`, problems: [] };
  }
  const by = options.by.trim();
  const owner = options.owner?.trim();
  if (owner !== undefined && owner === '') return { id, outcome: 'refused', reason: '--owner is empty: name the team that owns the content', problems: [] };
  const given: ApproveOptions = { today: options.today, by, ...(owner !== undefined ? { owner } : {}) };
  return pending ? approveDraft(place, loaded, id, pendingFile, given) : approvePassage(place, loaded, id, passageFiles[0]!, given);
}

/** A passage already in passages/: approved as it is now. */
function approvePassage(place: KbPlace, loaded: Loaded, id: string, file: string, options: ApproveOptions): ApproveResult {
  if (!loaded.kb) return notLoaded(id, loaded, [file]);
  const kb = loaded.kb;
  const passage = Object.hasOwn(kb.passages, id) ? kb.passages[id]! : undefined;
  if (!passage) return { id, outcome: 'refused', reason: `${file} did not load as a passage`, problems: [] };
  // Fresh and in the log: nothing to do. Fresh but not in the log, it was approved outside kb:approve
  // (by hand, or copied), and check refuses it: approving it records a person's approval of it now.
  if (passage.freshness === 'fresh' && approvalLogged(kb, passage) !== false) return { id, outcome: 'fresh', file, approvedBy: passage.approval!.approvedBy, on: passage.approval!.on };
  const owner = options.owner ?? passage.approval?.owner;
  if (owner === undefined) return { id, outcome: 'refused', reason: `"${id}" has never been approved, so it has no owner yet: give the team that owns its content with --owner "<team>"`, problems: [] };
  if (passage.current.sourceHash === null) return { id, outcome: 'refused', reason: `its source section is missing (${loaded.base}/sources/${passage.source.document}.yaml, section "${passage.source.section}")`, problems: [] };
  const approval = { owner, approvedBy: options.by, on: options.today, sourceHash: passage.current.sourceHash, hash: passage.current.hash };
  const problems = checkCandidate(loaded, kb, { ...passage, approval, freshness: 'fresh' }, options.today, loaded.locate);
  if (problems.length > 0) return { id, outcome: 'refused', reason: 'it would fail pnpm check: fix these first', problems: problems.map(formatProblem) };

  const path = join(dirname(place.kbDir), file);
  const before = readFileSync(path, 'utf8');
  const { doc } = parseForEdit(before);
  setApproval(doc, approval);
  writeFileSync(path, doc.toString({ lineWidth: 0 }));
  const after = load(place).kb?.passages[id];
  if (after?.freshness !== 'fresh') {
    writeFileSync(path, before);
    return { id, outcome: 'refused', reason: `the approval written to ${file} did not read back as fresh (${after?.freshness ?? 'not loaded'}), so the file is as it was`, problems: [] };
  }
  const line: ApprovalLogLine = { id, version: passage.version, approvedBy: options.by, owner, on: options.today, sourceHash: approval.sourceHash, hash: approval.hash, from: 'passage', sourceText: sourceTextOf(kb.sources, passage.source)! };
  appendApprovalLog(place.kbDir, line);
  return { id, outcome: 'approved', from: 'passage', file, line };
}

/** A draft in pending/: checked as the passage it would be, then moved into passages/ with its approval. */
function approveDraft(place: KbPlace, loaded: Loaded, id: string, pendingFile: string, options: ApproveOptions): ApproveResult {
  const root = dirname(place.kbDir);
  const base = loaded.base;
  const text = readFileSync(join(root, pendingFile), 'utf8');
  const parsed = parseKbFile(pendingFile, 'kbPending', text);
  if (parsed.problems.length > 0) return { id, outcome: 'refused', reason: `${pendingFile} is not a draft passage`, problems: parsed.problems.map(formatProblem) };
  const draft = parsed.data as KbPendingYaml;
  if (draft.id !== id) return { id, outcome: 'refused', reason: `${pendingFile} has the id "${draft.id}"; a draft's id is its file name`, problems: [`write "id: ${id}", or rename the file to ${draft.id}.yaml`] };
  if (!loaded.kb) return notLoaded(id, loaded, [pendingFile]);
  const kb = loaded.kb;
  if (options.owner === undefined) return { id, outcome: 'refused', reason: `"${id}" is a draft, so it has no owner yet: give the team that owns its content with --owner "<team>"`, problems: [] };

  // Where it goes: the default locale's passages, or its locale's.
  let folder = `${base}/passages`;
  let locale = kb.defaultLocale;
  if (draft.locale !== undefined && draft.locale.toLowerCase() !== kb.defaultLocale.toLowerCase()) {
    const existing = localeDirs(place.kbDir).find((tag) => tag.toLowerCase() === draft.locale!.toLowerCase());
    locale = existing ?? draft.locale;
    if (!LOCALE_TAG.test(locale)) return { id, outcome: 'refused', reason: `the draft's locale "${draft.locale}" is not a language tag like "es" or "pt-BR"`, problems: [] };
    folder = `${base}/locale/${locale}/passages`;
  }
  const target = `${folder}/${id}.yaml`;

  // The excerpt the drafter quoted is in the section, word for word.
  const excerpt = draft.drafted.excerpt;
  const sectionText = sourceTextOf(kb.sources, draft.source);
  // A draft is held to the words of its source it quotes: it has them (./excerpt.ts).
  if (excerpt === undefined || collapseWhitespace(excerpt) === '') return { id, outcome: 'refused', reason: NO_EXCERPT, problems: [] };
  if (sectionText !== null && !excerptInSource(excerpt, sectionText)) {
    return {
      id,
      outcome: 'refused',
      reason: `its excerpt is not in ${base}/sources/${draft.source.document}.yaml section "${draft.source.section}" word for word, so the answer cannot be held to its source`,
      problems: ['quote the section exactly in drafted.excerpt (or correct source.section), then review the answer against it again'],
    };
  }
  // Long enough to hold the answer to, and saying every number the answer says.
  const weak = excerptProblems(excerpt, draft.answer);
  if (weak.length > 0) return { id, outcome: 'refused', reason: 'its excerpt cannot hold its answer to its source', problems: weak };

  const { drafted: _drafted, ...fields } = draft;
  const yaml: KbPassageYaml = fields;
  const unapproved = passageOf(yaml, locale, target, kb.topics, kb.sources, kb.defaultLocale);
  const { doc, lines } = parseForEdit(text);
  // The draft's problems are said in the draft's file, at their place in it.
  const locate: Locate = (file: string, path: DataPath) => (file === target ? positionOf(doc, lines, path) : loaded.locate(file, path));
  const approval = { owner: options.owner, approvedBy: options.by, on: options.today, sourceHash: unapproved.current.sourceHash ?? '', hash: unapproved.current.hash };
  const problems = checkCandidate(loaded, kb, { ...unapproved, approval, freshness: 'fresh' }, options.today, locate).map((p) => (p.file === target ? { ...p, file: pendingFile } : p));
  if (problems.length > 0) return { id, outcome: 'refused', reason: 'it would fail pnpm check: fix these first', problems: problems.map(formatProblem) };

  doc.delete('drafted');
  setApproval(doc, approval);
  const targetPath = join(root, target);
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, schemaComment(doc.toString({ lineWidth: 0 }), folder !== `${base}/passages`));
  unlinkSync(join(root, pendingFile));
  const after = load(place).kb?.passages[id];
  if (after?.freshness !== 'fresh') {
    unlinkSync(targetPath);
    writeFileSync(join(root, pendingFile), text);
    return { id, outcome: 'refused', reason: `the passage written to ${target} did not read back as fresh (${after?.freshness ?? 'not loaded'}), so it was taken out again and the draft left as it was`, problems: [] };
  }
  const line: ApprovalLogLine = { id, version: draft.version, approvedBy: options.by, owner: options.owner, on: options.today, sourceHash: approval.sourceHash, hash: approval.hash, from: 'pending', sourceText: sectionText ?? '' };
  appendApprovalLog(place.kbDir, line);
  return { id, outcome: 'approved', from: 'pending', file: target, line, moved: pendingFile };
}

/**
 * A moved draft's text with its editor schema comment (`# yaml-language-server: $schema=...`) naming
 * the passage's schema, two folders further up for a locale's passages (kb/locale/<tag>/passages).
 */
function schemaComment(text: string, deeper: boolean): string {
  return text.replace(/^(#[^\n]*\$schema=)(\S*?)kb-pending\.schema\.json/m, (_m, key: string, path: string) => `${key}${deeper && !/^[a-z]+:|^\//.test(path) ? `../../${path}` : path}kb-passage.schema.json`);
}

/** One result as kb:approve says it. */
export function formatApproveResult(r: ApproveResult, label: string): string[] {
  if (r.outcome === 'fresh') return [`${r.id}: already approved and fresh (by ${r.approvedBy} on ${r.on}): nothing written`];
  if (r.outcome === 'refused') return [`${r.id}: refused: ${r.reason}`, ...r.problems.map((p) => `  ${p}`)];
  const l = r.line;
  const what = r.moved ? `moved the draft ${r.moved} to ${r.file}` : `wrote the approval to ${r.file}`;
  return [`${r.id}: approved (version ${l.version}) by ${l.approvedBy} for ${l.owner} on ${l.on}: ${what}; sourceHash ${l.sourceHash.slice(0, 12)}, hash ${l.hash.slice(0, 12)}; logged in ${join(label, APPROVALS_LOG)}`];
}

// ---------------------------------------------------------------------------------------------
// kb:status
// ---------------------------------------------------------------------------------------------

/** A draft as kb:status lists it. */
export interface PendingDraft {
  id: string;
  file: string;
  draft: KbPendingYaml | null;
  /** Why it cannot be approved as it is: its problems, or its excerpt not in the source. */
  problems: string[];
}

/** The drafts in a kb folder's pending/, each read and checked as kb:approve would read it. */
export function pendingDrafts(place: KbPlace, kb: KnowledgeBase | null): PendingDraft[] {
  const base = basename(place.kbDir);
  let names: string[];
  try {
    names = readdirSync(join(place.kbDir, 'pending')).filter((n) => n.endsWith('.yaml') && !n.startsWith('.') && n !== PENDING_TOPICS_FILE).sort();
  } catch {
    return [];
  }
  return names.map((name) => {
    const id = name.slice(0, -'.yaml'.length);
    const file = `${base}/pending/${name}`;
    const parsed = parseKbFile(file, 'kbPending', readFileSync(join(place.kbDir, 'pending', name), 'utf8'));
    if (parsed.problems.length > 0) return { id, file, draft: null, problems: parsed.problems.map(formatProblem) };
    const draft = parsed.data as KbPendingYaml;
    const problems: string[] = [];
    if (draft.id !== id) problems.push(`its id is "${draft.id}", not its file name`);
    const section = kb ? sourceTextOf(kb.sources, draft.source) : null;
    if (kb && section === null) problems.push(`its source, ${base}/sources/${draft.source.document}.yaml section "${draft.source.section}", is not there`);
    if (draft.drafted.excerpt !== undefined && section !== null && !excerptInSource(draft.drafted.excerpt, section)) problems.push(`its excerpt is not in ${base}/sources/${draft.source.document}.yaml section "${draft.source.section}" word for word`);
    problems.push(...excerptProblems(draft.drafted.excerpt, draft.answer));
    return { id, file, draft, problems };
  });
}

/** A topic proposed by a draft (kb/pending/topics.yaml), as kb:status lists it. */
export interface ProposedTopic {
  id: string;
  /** Its title, or null when the file does not read as topics. */
  title: string | null;
  problems: string[];
}

/** The topics proposed in a kb folder's pending/topics.yaml (none when there is no such file). */
export function proposedTopics(place: KbPlace): ProposedTopic[] {
  const base = basename(place.kbDir);
  const path = join(place.kbDir, 'pending', PENDING_TOPICS_FILE);
  if (!existsSync(path)) return [];
  const file = `${base}/pending/${PENDING_TOPICS_FILE}`;
  const parsed = parseKbFile(file, 'kbTopics', readFileSync(path, 'utf8'));
  if (parsed.problems.length > 0) return [{ id: file, title: null, problems: parsed.problems.map(formatProblem) }];
  return Object.entries(parsed.data as Record<string, { title: string }>).map(([id, t]) => ({ id, title: t.title, problems: [] }));
}

/** kb:status's report of one knowledge base: the passages by state, the drafts, and the fix for each. */
export function statusLines(place: KbPlace): { lines: string[]; ok: boolean } {
  const loaded = load(place);
  const lines: string[] = [];
  if (!loaded.kb) {
    lines.push(`${place.label}: the knowledge base does not load, so its passages' state cannot be read:`);
    for (const p of loaded.problems) lines.push(`  ${formatProblem(p)}`);
    return { lines, ok: false };
  }
  const kb = loaded.kb;
  const base = loaded.base;
  const all = Object.values(kb.passages);
  const of = (state: KbPassage['freshness']): KbPassage[] => all.filter((p) => p.freshness === state);
  // A fresh passage whose approval is not in the log was approved outside kb:approve: check refuses it.
  const outside = of('fresh').filter((p) => approvalLogged(kb, p) === false);
  const fresh = of('fresh').filter((p) => !outside.includes(p));
  const changed = of('source-changed');
  const edited = of('edited');
  const unapproved = of('unapproved');
  const drafts = pendingDrafts(place, kb);
  const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
  lines.push(`${place.label}: ${count(all.length, 'passage')} (${fresh.length} approved and fresh, ${changed.length + edited.length} stale, ${unapproved.length} unapproved${outside.length > 0 ? `, ${outside.length} approved outside kb:approve` : ''}), ${count(drafts.length, 'pending draft')}`);
  const head = (title: string, n: number): void => {
    if (n > 0) lines.push(`${title} (${n}):`);
  };
  const where = (p: KbPassage): string => `${base}/sources/${p.source.document}.yaml section "${p.source.section}"`;
  head('approved and fresh', fresh.length);
  const log = readApprovalLog(place.kbDir);
  for (const p of fresh) {
    // An approval a migration carried over is marked, so the people who own the content can confirm it.
    const line = logLineOf(log, p.id, p.approval?.hash);
    const migrated = line?.from === 'migration' ? `  (migrated${line.note !== undefined ? `: ${line.note}` : ''})` : '';
    lines.push(`  ${p.id}  ${p.version}  ${p.topic}  approved by ${p.approval!.approvedBy} (${p.approval!.owner}) on ${p.approval!.on}${migrated}`);
  }
  head(`approved outside kb:approve, not in ${base}/${APPROVALS_LOG}: pnpm check refuses`, outside.length);
  for (const p of outside) {
    lines.push(`  ${p.id}  ${p.version}  ${p.topic}  its approval (by ${p.approval!.approvedBy} on ${p.approval!.on}) was written by hand or copied with its file, so no one is on record for it`);
    lines.push(`    -> review it against ${where(p)}, then ${approveCommandFor(p.id)}`);
  }
  head('stale, its source changed: withheld', changed.length);
  for (const p of changed) {
    lines.push(`  ${p.id}  ${p.version}  ${p.topic}  ${p.current.sourceHash === null ? `${where(p)} is gone` : `${where(p)} changed`} since ${p.approval!.approvedBy} approved it on ${p.approval!.on}`);
    lines.push(`    -> read the answer against the section's text now; correct the answer if the source says something else, then ${approveCommandFor(p.id)}`);
  }
  head('stale, edited after approval: withheld', edited.length);
  for (const p of edited) {
    lines.push(`  ${p.id}  ${p.version}  ${p.topic}  ${EDITED_WHAT} changed since ${p.approval!.approvedBy} approved it on ${p.approval!.on} (the source is as approved)`);
    lines.push(`    -> review the edit against ${where(p)} (git diff ${p.file}), then ${approveCommandFor(p.id)}`);
  }
  head('unapproved: never said', unapproved.length);
  for (const p of unapproved) {
    lines.push(`  ${p.id}  ${p.version}  ${p.topic}  never approved`);
    lines.push(`    -> review it against ${where(p)}, then ${approveCommandFor(p.id)} --owner "<team>"`);
  }
  head('pending drafts: never said', drafts.length);
  for (const d of drafts) {
    const about = d.draft ? `  ${d.draft.topic}  drafted by ${d.draft.drafted.by} on ${d.draft.drafted.on} from ${base}/sources/${d.draft.source.document}.yaml section "${d.draft.source.section}"` : '';
    lines.push(`  ${d.id}${about}`);
    if (d.problems.length > 0) {
      for (const p of d.problems) lines.push(`    ! ${p}`);
      lines.push(`    -> correct the draft in ${d.file}, then review it`);
    } else {
      lines.push(`    -> review it against its source, then ${approveCommandFor(d.id)} --owner "<team>"`);
    }
  }
  const proposed = proposedTopics(place);
  head('proposed topics, not yet in topics.yaml', proposed.length);
  for (const t of proposed) {
    lines.push(`  ${t.id}${t.title !== null ? `  "${t.title}"` : ''}`);
    for (const p of t.problems) lines.push(`    ! ${p}`);
  }
  if (proposed.length > 0) lines.push(`    -> accept, rename or merge each in pnpm kb:review (${base}/pending/${PENDING_TOPICS_FILE}); a draft of a proposed topic is approved after its topic`);
  if (outside.length + changed.length + edited.length + unapproved.length + drafts.length + proposed.length === 0) lines.push('every passage is approved and fresh, and nothing waits for review');
  else lines.push('pnpm check fails while a passage is stale or unapproved; a draft is never said until it is approved');
  return { lines, ok: true };
}
