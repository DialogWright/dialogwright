import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  approvalLogged,
  approveOne,
  collapseWhitespace,
  formatApproveResult,
  inForceOn,
  logLineOf,
  notAPerson,
  parseKbFile,
  PENDING_TOPICS_FILE,
  readApprovalLog,
  sourceHashOf,
  type ApprovalLogLine,
  type KbPassage,
  type KbPendingYaml,
  type KbPlace,
  type KnowledgeBase,
} from 'dialogwright';
import { isMap, type Document } from 'yaml';
import { draftsIn, readProposedTopics, topicYamlOf, type DraftOnDisk } from '../draft/draft';
import type { Draft, ProposedTopic } from '../draft/drafter';
import { answerKey, draftProblems, TOPIC_ID } from '../draft/validate';
import { loadKb, readForEdit } from '../kbPlace';

/**
 * What kb:review shows and does, as functions the review page's server calls (./server.ts) and a
 * test can call directly. Every write goes through the same checks as the commands: an edit is
 * checked as kb:draft checks a draft (../draft/validate.ts), an approval is dialogwright's kb:approve
 * (approveOne: a person's name, the excerpt in its section word for word, everything pnpm check would
 * say), and a write that is then refused is undone, so a refusal leaves the files as they were.
 *
 * - Approve: a draft, or a withheld passage, as it is (kb:approve --by --owner).
 * - Edit then approve: the answer, applies and dates (and a draft's excerpt), checked, then approved.
 * - Reject: a draft moves to kb/rejected/<id>.yaml with `rejected: { by, on, reason }`, a record kept
 *   in the repository (kb:draft passes over the sections a rejected draft cites).
 * - Return to the drafts: a rejected draft moves back to kb/pending/<id>.yaml without its `rejected:`,
 *   to be reviewed again.
 * - A proposed topic (kb/pending/topics.yaml): accepted into topics.yaml (under its own id, or a new
 *   one, the drafts that name it following), or merged into a topic topics.yaml has (its drafts
 *   re-pointed, the proposal dropped).
 */

/**
 * A draft's or a passage's id, as the knowledge base names its files (dialogwright's KB_FILE_ID): a
 * letter or digit first, then letters, digits, underscores, hyphens and dots. No slash, so an id from
 * the review page's URL never names a file outside the folder it is looked for in.
 */
export const KB_FILE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** Why `id` cannot name a draft or a passage (null when it can). */
export function idProblem(id: string): string | null {
  return KB_FILE_ID.test(id) ? null : `"${id}" is not a draft or passage id (letters, digits, underscores, hyphens and dots, starting with a letter or digit)`;
}

/** Why `id` cannot name a topic (null when it can). */
function topicIdProblem(id: string): string | null {
  return TOPIC_ID.test(id) ? null : `"${id}" is not a topic id: letters, digits and underscores, starting with a letter`;
}

/** A path made real (its links followed) as far as it exists; the rest as it is written. */
function realOf(path: string): string {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    const parent = dirname(abs);
    return parent === abs ? abs : join(realOf(parent), abs.slice(parent.length + 1));
  }
}

/**
 * Whether `path` is a file of the knowledge base's `where`: kb/pending/<id>.yaml, kb/rejected/<id>.yaml,
 * or a passage (kb/passages/<id>.yaml, kb/locale/<tag>/passages/<id>.yaml). Checked on the path as
 * written and as it really is (a link followed), so neither `..` nor a link leads out of the folder.
 */
export function inKbFolder(place: KbPlace, path: string, where: 'pending' | 'rejected' | 'passage'): boolean {
  const shapes = { pending: [/^pending\/[^/]+\.yaml$/], rejected: [/^rejected\/[^/]+\.yaml$/], passage: [/^passages\/[^/]+\.yaml$/, /^locale\/[^/]+\/passages\/[^/]+\.yaml$/] }[where];
  const fits = (kbDir: string, p: string): boolean => {
    const posix = relative(kbDir, p).split(sep).join('/');
    return shapes.some((s) => s.test(posix)) && !posix.split('/').some((seg) => seg === '..' || seg === '.');
  };
  return fits(resolve(place.kbDir), resolve(path)) && fits(realOf(place.kbDir), realOf(path));
}

/** Who is reviewing: a person's name, and the team that owns the content. */
export interface Reviewer {
  by: string;
  owner: string;
}

/** The outcome of an action: done, with what was done, or refused, with why (nothing written). */
export type ActionResult = { ok: true; message: string } | { ok: false; message: string; problems: string[] };

const refused = (message: string, problems: string[] = []): ActionResult => ({ ok: false, message, problems });

/** The kb folder's name ("kb"), as messages name its files. */
const baseOf = (place: KbPlace): string => place.kbDir.split(/[\\/]/).pop()!;

/** Why `reviewer` cannot approve or reject (null when they can). */
export function reviewerProblem(reviewer: Reviewer | null): string | null {
  if (!reviewer) return 'say who is reviewing first: your name and your team';
  const person = notAPerson(reviewer.by);
  if (person !== null) return person.replace(/^--by /, 'the name ');
  if (collapseWhitespace(reviewer.owner) === '') return 'name the team that owns the content';
  return null;
}

// ---------------------------------------------------------------------------------------------
// What waits for review
// ---------------------------------------------------------------------------------------------

/**
 * A passage a person must approve (again), and why: withheld from callers until they do (its source
 * changed or is gone, it was edited, it was never approved), or fresh but approved outside kb:approve
 * (`unlogged`: its approval has no line in kb/approvals.jsonl, so no one is on record for it and
 * pnpm check refuses it).
 */
export interface Withheld {
  passage: KbPassage;
  why: 'source-changed' | 'source-gone' | 'edited' | 'unapproved' | 'unlogged';
}

/** Everything that waits for review. */
export interface ReviewState {
  kb: KnowledgeBase | null;
  /** Why the knowledge base does not load, when it does not. */
  problems: string[];
  drafts: DraftOnDisk[];
  withheld: Withheld[];
  proposed: ProposedTopic[];
  /** Why kb/pending/topics.yaml does not read, when it does not. */
  proposedProblems: string[];
}

export function reviewState(place: KbPlace): ReviewState {
  const base = baseOf(place);
  const loaded = loadKb(place);
  const drafts = draftsIn(place.kbDir, 'pending', base);
  let proposed: ProposedTopic[] = [];
  let proposedProblems: string[] = [];
  try {
    proposed = Object.values(readProposedTopics(place.kbDir, base));
  } catch (error) {
    proposedProblems = [error instanceof Error ? error.message : String(error), ...((error as { problems?: string[] }).problems ?? [])];
  }
  const withheld: Withheld[] = [];
  for (const p of Object.values(loaded.kb?.passages ?? {})) {
    if (p.freshness === 'fresh') {
      if (approvalLogged(loaded.kb!, p) === false) withheld.push({ passage: p, why: 'unlogged' });
      continue;
    }
    withheld.push({ passage: p, why: p.freshness === 'source-changed' ? (p.current.sourceHash === null ? 'source-gone' : 'source-changed') : p.freshness });
  }
  return { kb: loaded.kb, problems: loaded.problems, drafts, withheld, proposed, proposedProblems };
}

/**
 * The section's text as it was when the passage was last approved, from kb/approvals.jsonl as
 * dialogwright reads it (readApprovalLog: lines that do not parse are passed over), null when no
 * approval kept it. A line's text is taken only when it hashes to the approval's sourceHash: the
 * log is a file anyone can edit, and the diff the reviewer reads must be of what was approved.
 */
export function approvedSectionText(place: KbPlace, passage: KbPassage): string | null {
  if (!passage.approval) return null;
  const { sourceHash } = passage.approval;
  let found: string | null = null;
  for (const l of readApprovalLog(place.kbDir)) {
    if (l.id === passage.id && l.sourceHash === sourceHash && typeof l.sourceText === 'string' && sourceHashOf(l.sourceText) === sourceHash) found = l.sourceText;
  }
  return found;
}

/** A draft on disk as a Draft, to check. */
function asDraft(d: KbPendingYaml): Draft {
  return {
    topic: d.topic,
    answer: d.answer,
    excerpt: d.drafted.excerpt ?? '',
    section: d.source.section,
    ...(d.applies ? { applies: d.applies as Draft['applies'] } : {}),
    effective: d.effective,
  };
}

/** The answers of the drafts waiting, to the draft's id. */
function pendingAnswers(drafts: readonly DraftOnDisk[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const d of drafts) if (d.draft) out.set(answerKey(d.draft.answer), d.id);
  return out;
}

/** Why a draft cannot be approved as it is: its checks (as kb:draft's), and a topic still only proposed. */
export function draftReviewProblems(place: KbPlace, state: ReviewState, d: DraftOnDisk): string[] {
  if (!d.draft) return [`${d.file} does not read as a draft`];
  if (!state.kb) return [];
  const proposed = Object.fromEntries(state.proposed.map((t) => [t.id, t]));
  const problems = draftProblems(asDraft(d.draft), { kb: state.kb, document: d.draft.source.document, proposed, pendingAnswers: pendingAnswers(state.drafts), base: baseOf(place), self: d.id });
  if (!Object.hasOwn(state.kb.topics, d.draft.topic) && Object.hasOwn(proposed, d.draft.topic)) problems.push(`its topic "${d.draft.topic}" is only proposed: accept it (or merge it into a topic) first`);
  return problems;
}

// ---------------------------------------------------------------------------------------------
// What the knowledge base holds
// ---------------------------------------------------------------------------------------------

/**
 * Where a passage stands today: withheld from callers (why, as the list of what waits says), or
 * approved, fresh and logged, and then in force today, not yet in force, or expired (dialogwright's
 * inForceOn, the day as the call resolves it).
 */
export type Standing = Withheld['why'] | 'in-force' | 'not-yet' | 'expired';

export function standingOf(state: ReviewState, passage: KbPassage, today: string): Standing {
  const w = state.withheld.find((x) => x.passage.id === passage.id);
  if (w) return w.why;
  if (inForceOn(passage, today)) return 'in-force';
  return today < passage.effective.from ? 'not-yet' : 'expired';
}

/**
 * The line of kb/approvals.jsonl that records a passage's approval: the last with its id and its
 * approval's hash, as dialogwright reads the log (readApprovalLog); null when it has no approval or no
 * line records it. `log` is the log read once, for a list of passages.
 */
export function approvalLineOf(place: KbPlace, passage: KbPassage, log: readonly ApprovalLogLine[] = readApprovalLog(place.kbDir)): ApprovalLogLine | null {
  return logLineOf(log, passage.id, passage.approval?.hash);
}

/** A passage as the Knowledge base tab shows it: where it stands today, and the log's line of its approval. */
export interface HeldPassage {
  passage: KbPassage;
  standing: Standing;
  line: ApprovalLogLine | null;
}

/** Every passage of the knowledge base (by id), with where it stands today and its approval's line; the log read once. */
export function heldPassages(place: KbPlace, state: ReviewState, today: string): HeldPassage[] {
  const log = readApprovalLog(place.kbDir);
  return Object.values(state.kb?.passages ?? {}).map((passage) => ({ passage, standing: standingOf(state, passage, today), line: approvalLineOf(place, passage, log) }));
}

/** A rejected draft: kb/rejected/<id>.yaml read as a draft, and who rejected it, when and why (null when its `rejected:` does not read). */
export interface RejectedDraft extends DraftOnDisk {
  rejected: { by: string; on: string; reason: string } | null;
}

/** The drafts in kb/rejected, oldest name first, each with its rejection. */
export function rejectedDrafts(place: KbPlace): RejectedDraft[] {
  return draftsIn(place.kbDir, 'rejected', baseOf(place)).map((d) => {
    const path = join(place.kbDir, 'rejected', `${d.id}.yaml`);
    const block = (inKbFolder(place, path, 'rejected') ? readForEdit(path)?.toJS() : null) as { rejected?: Record<string, unknown> } | null;
    const r = block?.rejected;
    const text = (v: unknown): string => (typeof v === 'string' ? v : v instanceof Date ? v.toISOString().slice(0, 10) : '');
    return { ...d, rejected: r && typeof r === 'object' ? { by: text(r.by), on: text(r.on), reason: text(r.reason) } : null };
  });
}

// ---------------------------------------------------------------------------------------------
// What the reviewer saw
// ---------------------------------------------------------------------------------------------

/** What a form changes: a draft, a passage, a proposed topic, or a rejected draft. */
export type SeenKind = 'draft' | 'passage' | 'topic' | 'rejected';

/**
 * A hash of what the review page shows of a draft, a passage, a proposed topic or a rejected draft: the
 * draft's, the passage's or the rejected draft's file as it is on disk with its source section's text
 * now, or the proposed topic as kb/pending/topics.yaml has it. Every form that changes one carries the hash of what the reviewer
 * opened, and the change is refused when it no longer matches: what they saw is what they approve.
 * Null when there is no such draft, passage or topic.
 */
export function seenOf(place: KbPlace, state: ReviewState, kind: SeenKind, id: string): string | null {
  const hash = (...parts: (string | Buffer)[]): string => {
    const h = createHash('sha256').update(kind);
    for (const part of parts) h.update('\u0000').update(part);
    return h.digest('base64url');
  };
  const sectionText = (document: string, section: string): string => {
    const source = state.kb && Object.hasOwn(state.kb.sources, document) ? state.kb.sources[document]! : undefined;
    return source && Object.hasOwn(source.sections, section) ? source.sections[section]!.text : '';
  };
  if (kind === 'draft') {
    const d = state.drafts.find((x) => x.id === id);
    const path = join(place.kbDir, 'pending', `${id}.yaml`);
    if (!d || idProblem(id) !== null || !inKbFolder(place, path, 'pending') || !existsSync(path)) return null;
    return hash(readFileSync(path), d.draft ? sectionText(d.draft.source.document, d.draft.source.section) : '');
  }
  if (kind === 'passage') {
    const p = state.kb && Object.hasOwn(state.kb.passages, id) ? state.kb.passages[id]! : undefined;
    if (!p) return null;
    const path = join(dirname(place.kbDir), p.file);
    if (!inKbFolder(place, path, 'passage') || !existsSync(path)) return null;
    return hash(readFileSync(path), sectionText(p.source.document, p.source.section));
  }
  if (kind === 'rejected') {
    const path = join(place.kbDir, 'rejected', `${id}.yaml`);
    if (idProblem(id) !== null || !inKbFolder(place, path, 'rejected') || !existsSync(path)) return null;
    const r = rejectedDrafts(place).find((x) => x.id === id);
    return hash(readFileSync(path), r?.draft ? sectionText(r.draft.source.document, r.draft.source.section) : '');
  }
  const t = state.proposed.find((x) => x.id === id);
  return t ? hash(JSON.stringify([t.id, topicYamlOf(t)])) : null;
}

/** Why a change cannot be made to what the reviewer opened (null when it is as they saw it). */
function changedSince(place: KbPlace, state: ReviewState, kind: SeenKind, id: string, seen: string | undefined): string | null {
  if (seen === undefined) return null;
  const now = seenOf(place, state, kind, id);
  return now !== null && now === seen ? null : `${id} changed since you opened it: reload the page and review it again`;
}

// ---------------------------------------------------------------------------------------------
// Approving
// ---------------------------------------------------------------------------------------------

/**
 * Approves a draft or a passage as it is, through kb:approve's own function. `seen` (the review page's
 * form gives it) is the hash of what the reviewer opened (seenOf): refused when it changed since.
 */
export function approve(place: KbPlace, id: string, reviewer: Reviewer | null, today: string, seen?: string): ActionResult {
  const bad = idProblem(id);
  if (bad !== null) return refused(bad);
  const who = reviewerProblem(reviewer);
  if (who !== null) return refused(who);
  const state = reviewState(place);
  const draft = state.drafts.find((d) => d.id === id);
  const stale = changedSince(place, state, draft ? 'draft' : 'passage', id, seen);
  if (stale !== null) return refused(stale);
  if (draft) {
    const problems = draftReviewProblems(place, state, draft);
    if (problems.length > 0) return refused(`${id} cannot be approved as it is`, problems);
  }
  // A passage approved before keeps its owner; a draft, or a passage never approved, takes the reviewer's team.
  const keepsOwner = !draft && state.kb !== null && Object.hasOwn(state.kb.passages, id) && state.kb.passages[id]!.approval !== undefined;
  const result = approveOne(place, id, { by: reviewer!.by.trim(), ...(keepsOwner ? {} : { owner: reviewer!.owner.trim() }), today });
  const lines = formatApproveResult(result, place.label);
  if (result.outcome === 'refused') return refused(lines[0]!, lines.slice(1).map((l) => l.trim()));
  return { ok: true, message: lines.join(' ') };
}

/** What a reviewer may edit before approving. */
export interface Edits {
  answer: string;
  /** For each fact, its values; empty: every caller. */
  applies?: Record<string, string[]>;
  effective: { from: string; to?: string };
  /** A draft's excerpt (a passage has none). */
  excerpt?: string;
}

/** Writes `edits` into a passage or draft document: the answer, applies, dates and (for a draft) the excerpt. */
function applyEdits(doc: Document, edits: Edits, draft: boolean): void {
  doc.set('answer', collapseWhitespace(edits.answer));
  const applies = Object.fromEntries(Object.entries(edits.applies ?? {}).filter(([, v]) => v.length > 0).map(([k, v]) => [k, v.length === 1 ? v[0]! : v]));
  if (Object.keys(applies).length > 0) doc.set('applies', doc.createNode(applies));
  else doc.delete('applies');
  doc.set('effective', doc.createNode(edits.effective.to ? { from: edits.effective.from, to: edits.effective.to } : { from: edits.effective.from }));
  if (draft && edits.excerpt !== undefined) doc.setIn(['drafted', 'excerpt'], collapseWhitespace(edits.excerpt));
}

/** Edits a draft or a withheld passage, checks the edit as a draft is checked, and approves it; undone if refused. */
export function editAndApprove(place: KbPlace, id: string, edits: Edits, reviewer: Reviewer | null, today: string, seen?: string): ActionResult {
  const bad = idProblem(id);
  if (bad !== null) return refused(bad);
  const who = reviewerProblem(reviewer);
  if (who !== null) return refused(who);
  const state = reviewState(place);
  if (!state.kb) return refused('the knowledge base does not load: fix it first', state.problems);
  const base = baseOf(place);
  const draft = state.drafts.find((d) => d.id === id);
  const passage = Object.hasOwn(state.kb.passages, id) ? state.kb.passages[id]! : undefined;
  if (!draft && !passage) return refused(`there is no draft or passage "${id}"`);
  const stale = changedSince(place, state, draft ? 'draft' : 'passage', id, seen);
  if (stale !== null) return refused(stale);
  const path = draft ? join(place.kbDir, 'pending', `${id}.yaml`) : join(dirname(place.kbDir), passage!.file);
  if (!inKbFolder(place, path, draft ? 'pending' : 'passage')) return refused(`${id}'s file is not in ${base}/${draft ? 'pending' : 'passages'}`);
  const before = readFileSync(path, 'utf8');
  const doc = readForEdit(path)!;
  if (draft && !draft.draft) return refused(`${draft.file} does not read as a draft`);

  // The edit is checked as a draft is: its excerpt (a draft's) in the section, its length, no braces, its applies and dates, no repeat.
  const topic = draft ? draft.draft!.topic : passage!.topic;
  const document = draft ? draft.draft!.source.document : passage!.source.document;
  const section = draft ? draft.draft!.source.section : passage!.source.section;
  const excerpt = draft ? (edits.excerpt ?? draft.draft!.drafted.excerpt ?? '') : null;
  const candidate: Draft = { topic, answer: edits.answer, excerpt: excerpt ?? '', section, ...(edits.applies ? { applies: edits.applies } : {}), effective: edits.effective };
  const proposed = Object.fromEntries(state.proposed.map((t) => [t.id, t]));
  let problems = draftProblems(candidate, { kb: { ...state.kb, passages: Object.fromEntries(Object.entries(state.kb.passages).filter(([k]) => k !== id)) }, document, proposed, pendingAnswers: pendingAnswers(state.drafts), base, self: id });
  if (excerpt === null) problems = problems.filter((p) => !p.startsWith('its excerpt'));
  if (problems.length > 0) return refused(`the edit to ${id} was not saved`, problems);

  applyEdits(doc, edits, draft !== undefined);
  writeFileSync(path, doc.toString({ lineWidth: 0 }));
  const result = approve(place, id, reviewer, today);
  if (!result.ok) {
    writeFileSync(path, before);
    return refused(`the edit to ${id} was not kept: ${result.message}`, result.problems);
  }
  return { ok: true, message: `edited, then ${result.message}` };
}

// ---------------------------------------------------------------------------------------------
// Rejecting
// ---------------------------------------------------------------------------------------------

/** Moves a draft to kb/rejected/<id>.yaml with who rejected it, when and why (refused when it changed since `seen`). */
export function reject(place: KbPlace, id: string, reason: string, reviewer: Reviewer | null, today: string, seen?: string): ActionResult {
  const bad = idProblem(id);
  if (bad !== null) return refused(bad);
  const who = reviewerProblem(reviewer);
  if (who !== null) return refused(who);
  const why = collapseWhitespace(reason);
  if (why === '') return refused('say why the draft is rejected: the reason is kept with it');
  const base = baseOf(place);
  const from = join(place.kbDir, 'pending', `${id}.yaml`);
  if (`${id}.yaml` === PENDING_TOPICS_FILE || !inKbFolder(place, from, 'pending') || !existsSync(from)) return refused(`there is no draft "${id}" in ${base}/pending`);
  if (seen !== undefined) {
    const stale = changedSince(place, reviewState(place), 'draft', id, seen);
    if (stale !== null) return refused(stale);
  }
  const doc = readForEdit(from)!;
  doc.set('rejected', doc.createNode({ by: reviewer!.by.trim(), on: today, reason: why }));
  const dir = join(place.kbDir, 'rejected');
  mkdirSync(dir, { recursive: true });
  let name = id;
  for (let n = 2; existsSync(join(dir, `${name}.yaml`)); n += 1) name = `${id}-${n}`;
  if (!inKbFolder(place, join(dir, `${name}.yaml`), 'rejected')) return refused(`${base}/rejected is not a folder of the knowledge base`);
  writeFileSync(join(dir, `${name}.yaml`), doc.toString({ lineWidth: 0 }));
  unlinkSync(from);
  return { ok: true, message: `${id}: rejected by ${reviewer!.by.trim()} (${why}); moved to ${base}/rejected/${name}.yaml` };
}

/**
 * Moves a rejected draft back to kb/pending/<id>.yaml without its `rejected:`, the rest of its file as
 * it is, to be reviewed again (refused when it changed since `seen`, or a draft of that id waits).
 * A draft's id is its file name: one renamed when it was rejected (a second rejection of the same id)
 * takes its file's name.
 */
export function returnToDrafts(place: KbPlace, id: string, reviewer: Reviewer | null, seen?: string): ActionResult {
  const bad = idProblem(id);
  if (bad !== null) return refused(bad);
  const who = reviewerProblem(reviewer);
  if (who !== null) return refused(who);
  const base = baseOf(place);
  const from = join(place.kbDir, 'rejected', `${id}.yaml`);
  if (!inKbFolder(place, from, 'rejected') || !existsSync(from)) return refused(`there is no rejected draft "${id}" in ${base}/rejected`);
  if (seen !== undefined) {
    const stale = changedSince(place, reviewState(place), 'rejected', id, seen);
    if (stale !== null) return refused(stale);
  }
  const dir = join(place.kbDir, 'pending');
  const to = join(dir, `${id}.yaml`);
  if (`${id}.yaml` === PENDING_TOPICS_FILE || !inKbFolder(place, to, 'pending')) return refused(`${base}/pending/${id}.yaml is not a draft's place in the knowledge base`);
  if (existsSync(to)) return refused(`a draft "${id}" already waits in ${base}/pending: approve or reject it first`);
  const doc = readForEdit(from)!;
  const was = rejectedDrafts(place).find((r) => r.id === id)?.rejected;
  doc.delete('rejected');
  const renamed = doc.get('id') !== id;
  if (renamed) doc.set('id', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(to, doc.toString({ lineWidth: 0 }));
  unlinkSync(from);
  const why = was ? ` (it was rejected by ${was.by} on ${was.on}: ${was.reason})` : '';
  return { ok: true, message: `${id}: returned to the drafts by ${reviewer!.by.trim()}${why}; moved to ${base}/pending/${id}.yaml${renamed ? ', its id set to its file name' : ''}` };
}

// ---------------------------------------------------------------------------------------------
// Proposed topics
// ---------------------------------------------------------------------------------------------

/** Points every draft in kb/pending that names topic `from` at `to`. Returns the files changed, with their text before. */
function repoint(place: KbPlace, from: string, to: string): { path: string; before: string }[] {
  const changed: { path: string; before: string }[] = [];
  for (const d of draftsIn(place.kbDir, 'pending', baseOf(place))) {
    if (d.draft?.topic !== from) continue;
    const path = join(place.kbDir, 'pending', `${d.id}.yaml`);
    const before = readFileSync(path, 'utf8');
    const doc = readForEdit(path)!;
    doc.set('topic', to);
    writeFileSync(path, doc.toString({ lineWidth: 0 }));
    changed.push({ path, before });
  }
  return changed;
}

/** kb/pending/topics.yaml without `id` (deleted when it has no topic left). Returns its text before. */
function dropProposal(place: KbPlace, id: string): string {
  const path = join(place.kbDir, 'pending', PENDING_TOPICS_FILE);
  const before = readFileSync(path, 'utf8');
  const doc = readForEdit(path)!;
  doc.delete(id);
  if (isMap(doc.contents) && doc.contents.items.length === 0) unlinkSync(path);
  else writeFileSync(path, doc.toString({ lineWidth: 0 }));
  return before;
}

/** Restores files to their text before (a refused change undone). */
function restore(files: readonly { path: string; before: string | null }[]): void {
  for (const f of files) {
    if (f.before === null) {
      if (existsSync(f.path)) unlinkSync(f.path);
    } else writeFileSync(f.path, f.before);
  }
}

/** After a change to the topics: the knowledge base still loads, or the change is undone. */
function settle(place: KbPlace, files: readonly { path: string; before: string | null }[], done: string): ActionResult {
  const after = loadKb(place);
  if (!after.kb) {
    restore(files);
    return refused('the change was not kept: the knowledge base would not load', after.problems);
  }
  const embedder = after.kb.settings.retrieval.embedder;
  return { ok: true, message: embedder !== undefined ? `${done}; the topics changed, so run pnpm kb:index before pnpm check` : done };
}

/** How a proposed topic is accepted: under another id (`as`), with its title as the reviewer wrote it, and the hash of what they opened (`seen`). */
export interface AcceptOptions {
  as?: string;
  /** Its title, as the reviewer edited it: callers hear it (the topic question offers it). Default: the proposal's. */
  title?: string;
  seen?: string;
}

/** The longest a topic's title may be: a few words, said in a question. */
export const MAX_TOPIC_TITLE_CHARS = 80;

/** Why `title` cannot be a topic's title (null when it can). */
export function topicTitleProblem(title: string): string | null {
  const t = collapseWhitespace(title);
  if (t === '') return 'give the topic a title: callers hear it when they are asked which topic they mean';
  if (t.length > MAX_TOPIC_TITLE_CHARS) return `the title is ${t.length} characters, over ${MAX_TOPIC_TITLE_CHARS}: a topic's title is a few words, said in a question`;
  if (/[{}]/.test(t)) return 'the title has a brace: it is said to callers as it is written, with no variables';
  return null;
}

/** Accepts a proposed topic into topics.yaml, under its own id or `as` (the drafts that name it following). */
export function acceptTopic(place: KbPlace, id: string, reviewer: Reviewer | null, options: AcceptOptions = {}): ActionResult {
  const { as, seen } = options;
  if (options.title !== undefined) {
    const problem = topicTitleProblem(options.title);
    if (problem !== null) return refused(problem);
  }
  const bad = topicIdProblem(id);
  if (bad !== null) return refused(bad);
  const who = reviewerProblem(reviewer);
  if (who !== null) return refused(who);
  const base = baseOf(place);
  const state = reviewState(place);
  if (!state.kb) return refused('the knowledge base does not load: fix it first', state.problems);
  const proposal = state.proposed.find((t) => t.id === id);
  if (!proposal) return refused(`"${id}" is not a topic proposed in ${base}/pending/${PENDING_TOPICS_FILE}`);
  const stale = changedSince(place, state, 'topic', id, seen);
  if (stale !== null) return refused(stale);
  const target = (as ?? id).trim();
  if (!TOPIC_ID.test(target)) return refused(`"${target}" is not a topic id: letters, digits and underscores, starting with a letter`);
  if (Object.hasOwn(state.kb.topics, target)) return refused(`${base}/topics.yaml already has the topic "${target}": merge the proposal into it instead`);

  const topicsPath = join(place.kbDir, 'topics.yaml');
  const topicsBefore = readFileSync(topicsPath, 'utf8');
  const doc = readForEdit(topicsPath)!;
  const accepted = options.title !== undefined ? { ...proposal, title: collapseWhitespace(options.title) } : proposal;
  const yaml = topicYamlOf(accepted);
  if (isMap(doc.contents)) {
    doc.contents.flow = false;
    doc.set(target, doc.createNode(yaml));
  } else {
    doc.contents = doc.createNode({ [target]: yaml }) as never;
  }
  const check = parseKbFile(`${base}/topics.yaml`, 'kbTopics', doc.toString({ lineWidth: 0 }));
  if (check.problems.length > 0) return refused(`the topic "${target}" would not read in ${base}/topics.yaml`, check.problems.map((p) => p.message));
  writeFileSync(topicsPath, doc.toString({ lineWidth: 0 }));
  const files: { path: string; before: string | null }[] = [{ path: topicsPath, before: topicsBefore }];
  const pendingTopics = join(place.kbDir, 'pending', PENDING_TOPICS_FILE);
  files.push({ path: pendingTopics, before: dropProposal(place, id) });
  if (target !== id) files.push(...repoint(place, id, target));
  const retitled = accepted.title !== proposal.title.trim() ? `, retitled from "${proposal.title.trim()}"` : '';
  return settle(place, files, `accepted the topic "${target}" ("${accepted.title}"${retitled}) into ${base}/topics.yaml${target !== id ? ` (proposed as "${id}"; its drafts follow)` : ''}`);
}

/** Merges a proposed topic into one topics.yaml has: its drafts re-pointed, the proposal dropped. */
export function mergeTopic(place: KbPlace, id: string, into: string, reviewer: Reviewer | null, seen?: string): ActionResult {
  const bad = topicIdProblem(id) ?? topicIdProblem(into);
  if (bad !== null) return refused(bad);
  const who = reviewerProblem(reviewer);
  if (who !== null) return refused(who);
  const base = baseOf(place);
  const state = reviewState(place);
  if (!state.kb) return refused('the knowledge base does not load: fix it first', state.problems);
  if (!state.proposed.some((t) => t.id === id)) return refused(`"${id}" is not a topic proposed in ${base}/pending/${PENDING_TOPICS_FILE}`);
  const stale = changedSince(place, state, 'topic', id, seen);
  if (stale !== null) return refused(stale);
  if (!Object.hasOwn(state.kb.topics, into)) return refused(`"${into}" is not a topic in ${base}/topics.yaml`);
  const files: { path: string; before: string | null }[] = [{ path: join(place.kbDir, 'pending', PENDING_TOPICS_FILE), before: dropProposal(place, id) }, ...repoint(place, id, into)];
  return settle(place, files, `merged the proposed topic "${id}" into "${into}"; its drafts now answer "${into}"`);
}
