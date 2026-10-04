import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  APPROVALS_LOG,
  approveOne,
  collapseWhitespace,
  formatApproveResult,
  notAPerson,
  parseKbFile,
  PENDING_TOPICS_FILE,
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
 * - A proposed topic (kb/pending/topics.yaml): accepted into topics.yaml (under its own id, or a new
 *   one, the drafts that name it following), or merged into a topic topics.yaml has (its drafts
 *   re-pointed, the proposal dropped).
 */

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

/** A passage withheld from callers until a person approves it again, and why. */
export interface Withheld {
  passage: KbPassage;
  why: 'source-changed' | 'source-gone' | 'edited' | 'unapproved';
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
    if (p.freshness === 'fresh') continue;
    withheld.push({ passage: p, why: p.freshness === 'source-changed' ? (p.current.sourceHash === null ? 'source-gone' : 'source-changed') : p.freshness });
  }
  return { kb: loaded.kb, problems: loaded.problems, drafts, withheld, proposed, proposedProblems };
}

/** The section's text as it was when the passage was last approved, from kb/approvals.jsonl (null when no approval kept it). */
export function approvedSectionText(place: KbPlace, passage: KbPassage): string | null {
  if (!passage.approval) return null;
  const file = join(place.kbDir, APPROVALS_LOG);
  if (!existsSync(file)) return null;
  let found: string | null = null;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const l = JSON.parse(line) as Partial<ApprovalLogLine>;
      if (l.id === passage.id && l.sourceHash === passage.approval.sourceHash && typeof l.sourceText === 'string') found = l.sourceText;
    } catch {
      // a line that does not parse is passed over
    }
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
// Approving
// ---------------------------------------------------------------------------------------------

/** Approves a draft or a passage as it is, through kb:approve's own function. */
export function approve(place: KbPlace, id: string, reviewer: Reviewer | null, today: string): ActionResult {
  const who = reviewerProblem(reviewer);
  if (who !== null) return refused(who);
  const state = reviewState(place);
  const draft = state.drafts.find((d) => d.id === id);
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
export function editAndApprove(place: KbPlace, id: string, edits: Edits, reviewer: Reviewer | null, today: string): ActionResult {
  const who = reviewerProblem(reviewer);
  if (who !== null) return refused(who);
  const state = reviewState(place);
  if (!state.kb) return refused('the knowledge base does not load: fix it first', state.problems);
  const base = baseOf(place);
  const draft = state.drafts.find((d) => d.id === id);
  const passage = Object.hasOwn(state.kb.passages, id) ? state.kb.passages[id]! : undefined;
  if (!draft && !passage) return refused(`there is no draft or passage "${id}"`);
  const path = draft ? join(place.kbDir, 'pending', `${id}.yaml`) : join(dirname(place.kbDir), passage!.file);
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

/** Moves a draft to kb/rejected/<id>.yaml with who rejected it, when and why. */
export function reject(place: KbPlace, id: string, reason: string, reviewer: Reviewer | null, today: string): ActionResult {
  const who = reviewerProblem(reviewer);
  if (who !== null) return refused(who);
  const why = collapseWhitespace(reason);
  if (why === '') return refused('say why the draft is rejected: the reason is kept with it');
  const base = baseOf(place);
  const from = join(place.kbDir, 'pending', `${id}.yaml`);
  if (`${id}.yaml` === PENDING_TOPICS_FILE || !existsSync(from)) return refused(`there is no draft "${id}" in ${base}/pending`);
  const doc = readForEdit(from)!;
  doc.set('rejected', doc.createNode({ by: reviewer!.by.trim(), on: today, reason: why }));
  const dir = join(place.kbDir, 'rejected');
  mkdirSync(dir, { recursive: true });
  let name = id;
  for (let n = 2; existsSync(join(dir, `${name}.yaml`)); n += 1) name = `${id}-${n}`;
  writeFileSync(join(dir, `${name}.yaml`), doc.toString({ lineWidth: 0 }));
  unlinkSync(from);
  return { ok: true, message: `${id}: rejected by ${reviewer!.by.trim()} (${why}); moved to ${base}/rejected/${name}.yaml` };
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

/** Accepts a proposed topic into topics.yaml, under its own id or `as` (the drafts that name it following). */
export function acceptTopic(place: KbPlace, id: string, reviewer: Reviewer | null, as?: string): ActionResult {
  const who = reviewerProblem(reviewer);
  if (who !== null) return refused(who);
  const base = baseOf(place);
  const state = reviewState(place);
  if (!state.kb) return refused('the knowledge base does not load: fix it first', state.problems);
  const proposal = state.proposed.find((t) => t.id === id);
  if (!proposal) return refused(`"${id}" is not a topic proposed in ${base}/pending/${PENDING_TOPICS_FILE}`);
  const target = (as ?? id).trim();
  if (!TOPIC_ID.test(target)) return refused(`"${target}" is not a topic id: letters, digits and underscores, starting with a letter`);
  if (Object.hasOwn(state.kb.topics, target)) return refused(`${base}/topics.yaml already has the topic "${target}": merge the proposal into it instead`);

  const topicsPath = join(place.kbDir, 'topics.yaml');
  const topicsBefore = readFileSync(topicsPath, 'utf8');
  const doc = readForEdit(topicsPath)!;
  const yaml = topicYamlOf(proposal);
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
  return settle(place, files, `accepted the topic "${target}" ("${proposal.title}") into ${base}/topics.yaml${target !== id ? ` (proposed as "${id}"; its drafts follow)` : ''}`);
}

/** Merges a proposed topic into one topics.yaml has: its drafts re-pointed, the proposal dropped. */
export function mergeTopic(place: KbPlace, id: string, into: string, reviewer: Reviewer | null): ActionResult {
  const who = reviewerProblem(reviewer);
  if (who !== null) return refused(who);
  const base = baseOf(place);
  const state = reviewState(place);
  if (!state.kb) return refused('the knowledge base does not load: fix it first', state.problems);
  if (!state.proposed.some((t) => t.id === id)) return refused(`"${id}" is not a topic proposed in ${base}/pending/${PENDING_TOPICS_FILE}`);
  if (!Object.hasOwn(state.kb.topics, into)) return refused(`"${into}" is not a topic in ${base}/topics.yaml`);
  const files: { path: string; before: string | null }[] = [{ path: join(place.kbDir, 'pending', PENDING_TOPICS_FILE), before: dropProposal(place, id) }, ...repoint(place, id, into)];
  return settle(place, files, `merged the proposed topic "${id}" into "${into}"; its drafts now answer "${into}"`);
}
