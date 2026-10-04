import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatProblem, parseKbFile, PENDING_TOPICS_FILE, type KbPendingYaml, type KbPlace, type KbSourceDocument, type KbTopicsYaml, type KnowledgeBase } from 'dialogwright';
import { isMap } from 'yaml';
import { loadKb, readForEdit, yamlFile, yamlIds } from '../kbPlace';
import { slugOf } from '../sections';
import { DraftError, type Draft, type Drafter, type ProposedTopic, type TopicSummary } from './drafter';
import { answerKey, draftProblems, topicIdOf, type DraftContext } from './validate';

/**
 * `kb:draft`'s work: give each source document's sections that no passage, draft or rejected draft
 * cites yet to a drafter, check every draft it returns (./validate.ts), and write the ones that pass
 * to kb/pending/<id>.yaml with `drafted: { by, on, excerpt }`. A topic a draft proposes goes to
 * kb/pending/topics.yaml, never to topics.yaml: a reviewer accepts it there (kb:review). Drafts that
 * fail a check are reported with their reasons and not written. Nothing written here is ever said:
 * a draft is said only after a person approves it.
 */

/** A topic as kb/pending/topics.yaml (and topics.yaml) holds it. */
type TopicYaml = KbTopicsYaml[string];

export interface DraftOptions {
  place: KbPlace;
  drafter: Drafter;
  /** Today, as an ISO date: `drafted.on`, and the default `effective.from`. */
  today: string;
  /** The source documents to draft from, by id. Default: every one. */
  sources?: readonly string[];
  /** What the author wants drafted, in their words. */
  topicHints?: readonly string[];
  /** Give the drafter every section, not only those nothing cites yet. */
  allSections?: boolean;
  /** Check and report, but write nothing. */
  dryRun?: boolean;
}

/** One draft written. */
export interface WrittenDraft {
  id: string;
  /** From the app folder's parent of kb: `kb/pending/<id>.yaml`. */
  file: string;
  topic: string;
  /** Whether its topic is one it proposes (in kb/pending/topics.yaml). */
  proposed: boolean;
  document: string;
  section: string;
}

/** One draft refused, with why. */
export interface RejectedDraft {
  document: string;
  section: string;
  topic: string;
  answer: string;
  reasons: string[];
}

export interface DraftReport {
  drafter: string;
  /** Each source document: how many sections it was given, how many were passed over as cited, and the drafter's error when it failed. */
  documents: { id: string; given: number; cited: number; error?: string }[];
  written: WrittenDraft[];
  rejected: RejectedDraft[];
  /** The topics this run proposed (added to kb/pending/topics.yaml). */
  proposed: ProposedTopic[];
}

/** A problem that stops kb:draft before it drafts (the knowledge base does not load, a source that is not there). */
export class DraftCommandError extends Error {
  constructor(
    message: string,
    readonly problems: readonly string[] = [],
  ) {
    super(message);
  }
}

/** The topics kb/pending/topics.yaml proposes, by id (none when there is no file). */
export function readProposedTopics(kbDir: string, base: string): Record<string, ProposedTopic> {
  const path = join(kbDir, 'pending', PENDING_TOPICS_FILE);
  const doc = readForEdit(path);
  if (doc === null) return {};
  const parsed = parseKbFile(`${base}/pending/${PENDING_TOPICS_FILE}`, 'kbTopics', readFileSync(path, 'utf8'));
  if (parsed.problems.length > 0) throw new DraftCommandError(`${base}/pending/${PENDING_TOPICS_FILE} does not read as topics`, parsed.problems.map(formatProblem));
  const out: Record<string, ProposedTopic> = {};
  for (const [id, t] of Object.entries(parsed.data as KbTopicsYaml)) out[id] = { id, title: t.title, ...(t.keywords ? { keywords: t.keywords } : {}), ...(t.asks ? { asks: t.asks } : {}) };
  return out;
}

/** A draft in kb/pending (or kb/rejected), as far as drafting needs it. */
export interface DraftOnDisk {
  id: string;
  file: string;
  draft: KbPendingYaml | null;
}

/** The drafts in a folder of the knowledge base (pending/ or rejected/), each read as a draft (null when it does not read as one). */
export function draftsIn(kbDir: string, folder: 'pending' | 'rejected', base: string): DraftOnDisk[] {
  const dir = join(kbDir, folder);
  return yamlIds(dir, folder === 'pending' ? [PENDING_TOPICS_FILE] : []).map((id) => {
    const file = `${base}/${folder}/${id}.yaml`;
    let text = readFileSync(join(dir, `${id}.yaml`), 'utf8');
    if (folder === 'rejected') {
      // A rejected draft carries `rejected:` beside the draft's fields: it is read without it.
      const doc = readForEdit(join(dir, `${id}.yaml`))!;
      doc.delete('rejected');
      text = doc.toString();
    }
    const parsed = parseKbFile(file, 'kbPending', text);
    return { id, file, draft: parsed.problems.length === 0 ? (parsed.data as KbPendingYaml) : null };
  });
}

/** The topics a drafter is shown: the knowledge base's, then those proposed. */
function topicSummaries(kb: KnowledgeBase, proposed: Readonly<Record<string, ProposedTopic>>): TopicSummary[] {
  return [
    ...Object.values(kb.topics).map((t) => ({ id: t.id, title: t.title, keywords: t.keywords, asks: t.asks })),
    ...Object.values(proposed)
      .filter((t) => !Object.hasOwn(kb.topics, t.id))
      .map((t) => ({ id: t.id, title: t.title, keywords: t.keywords ?? [], asks: t.asks ?? [] })),
  ];
}

/** A draft's id: its topic (hyphens for underscores), then the applies values it answers; made distinct from `taken`. */
export function draftIdFor(draft: Draft, taken: Set<string>): string {
  const values = Object.keys(draft.applies ?? {})
    .sort()
    .flatMap((fact) => {
      const v = draft.applies![fact]!;
      return typeof v === 'string' ? [v] : [...v].sort();
    });
  const base = slugOf([topicIdOf(draft).replace(/_/g, '-'), ...values].join('-'), 'draft');
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

/** The draft as kb/pending/<id>.yaml holds it. */
export function pendingOf(draft: Draft, id: string, document: string, drafted: { by: string; on: string }): KbPendingYaml {
  const applies = draft.applies && Object.keys(draft.applies).length > 0 ? draft.applies : undefined;
  return {
    id,
    topic: topicIdOf(draft),
    version: `${drafted.on.slice(0, 4)}.1`,
    ...(applies ? { applies } : {}),
    effective: draft.effective ? { from: draft.effective.from, ...(draft.effective.to !== undefined ? { to: draft.effective.to } : {}) } : { from: drafted.on },
    source: { document, section: draft.section },
    answer: draft.answer.replace(/\s+/g, ' ').trim(),
    drafted: { by: drafted.by, on: drafted.on, excerpt: draft.excerpt.replace(/\s+/g, ' ').trim() },
  } as KbPendingYaml;
}

/** A proposed topic as topics.yaml holds it. */
export function topicYamlOf(t: ProposedTopic): TopicYaml {
  return { title: t.title.trim(), ...(t.keywords && t.keywords.length > 0 ? { keywords: [...new Set(t.keywords)] } : {}), ...(t.asks && t.asks.length > 0 ? { asks: [...new Set(t.asks)] } : {}) } as TopicYaml;
}

/** Adds topics to kb/pending/topics.yaml (made with its schema comment when it is not there), keeping what it has. */
export function addProposedTopics(kbDir: string, topics: readonly ProposedTopic[]): void {
  if (topics.length === 0) return;
  const dir = join(kbDir, 'pending');
  const path = join(dir, PENDING_TOPICS_FILE);
  mkdirSync(dir, { recursive: true });
  const doc = readForEdit(path);
  if (doc === null || !isMap(doc.contents)) {
    writeFileSync(path, yamlFile(Object.fromEntries(topics.map((t) => [t.id, topicYamlOf(t)])), dir, 'kb-topics'));
    return;
  }
  for (const t of topics) if (!doc.has(t.id)) doc.set(t.id, doc.createNode(topicYamlOf(t)));
  writeFileSync(path, doc.toString({ lineWidth: 0 }));
}

/** Drafts passages from the sources (see the file's comment). */
export async function draftKb(options: DraftOptions): Promise<DraftReport> {
  const { place, drafter, today } = options;
  const loaded = loadKb(place);
  if (!loaded.kb) throw new DraftCommandError(`${place.label}: the knowledge base does not load, so nothing can be drafted against it; fix these first`, loaded.problems);
  const kb = loaded.kb;
  const base = place.kbDir.split(/[\\/]/).pop()!;

  const allIds = Object.keys(kb.sources);
  const wanted = options.sources && options.sources.length > 0 ? [...new Set(options.sources)] : allIds;
  const missing = wanted.filter((id) => !Object.hasOwn(kb.sources, id));
  if (missing.length > 0) throw new DraftCommandError(`${missing.map((m) => `"${m}"`).join(', ')} ${missing.length === 1 ? 'is not a source document' : 'are not source documents'} in ${base}/sources (it has ${allIds.length > 0 ? allIds.join(', ') : 'none: run pnpm kb:ingest first'})`);

  // What is already drafted or cited: its sections are passed over (unless --all), its ids taken, its answers not repeated.
  const pending = draftsIn(place.kbDir, 'pending', base);
  const rejected = draftsIn(place.kbDir, 'rejected', base);
  const proposed: Record<string, ProposedTopic> = readProposedTopics(place.kbDir, base);
  const cited = new Set<string>();
  const key = (document: string, section: string): string => `${document}\u0000${section}`;
  for (const p of Object.values(kb.passages)) cited.add(key(p.source.document, p.source.section));
  for (const d of [...pending, ...rejected]) if (d.draft) cited.add(key(d.draft.source.document, d.draft.source.section));
  const pendingAnswers = new Map<string, string>();
  for (const d of pending) if (d.draft) pendingAnswers.set(answerKey(d.draft.answer), d.id);
  const taken = new Set<string>([...Object.keys(kb.passages), ...pending.map((d) => d.id), PENDING_TOPICS_FILE.slice(0, -'.yaml'.length)]);

  const report: DraftReport = { drafter: drafter.id, documents: [], written: [], rejected: [], proposed: [] };
  const writes: { id: string; yaml: string }[] = [];

  for (const docId of [...wanted].sort()) {
    const source = kb.sources[docId]!;
    const sectionIds = Object.keys(source.sections);
    const given = options.allSections ? sectionIds : sectionIds.filter((s) => !cited.has(key(docId, s)));
    const entry: DraftReport['documents'][number] = { id: docId, given: given.length, cited: sectionIds.length - given.length };
    report.documents.push(entry);
    if (given.length === 0) continue;
    const request: KbSourceDocument = { ...source, sections: Object.fromEntries(given.map((s) => [s, source.sections[s]!])) };
    let drafts: Draft[];
    try {
      drafts = await drafter.draft({ source: request, existingTopics: topicSummaries(kb, proposed), locale: kb.defaultLocale, maxAnswerChars: kb.settings.maxAnswerChars, applies: kb.settings.applies, topicHints: options.topicHints ?? [] });
    } catch (error) {
      if (!(error instanceof DraftError)) throw error;
      entry.error = error.message;
      continue;
    }
    for (const draft of drafts) {
      const ctx: DraftContext = { kb, document: docId, proposed, pendingAnswers, base };
      const reasons = draftProblems(draft, ctx);
      const topic = topicIdOf(draft);
      if (reasons.length > 0) {
        report.rejected.push({ document: docId, section: String(draft.section), topic, answer: String(draft.answer), reasons });
        continue;
      }
      const isNew = !Object.hasOwn(kb.topics, topic);
      if (isNew && typeof draft.topic !== 'string' && !Object.hasOwn(proposed, topic)) {
        proposed[topic] = draft.topic;
        report.proposed.push(draft.topic);
      }
      const id = draftIdFor(draft, taken);
      const yaml = pendingOf(draft, id, docId, { by: drafter.id, on: today });
      const file = `${base}/pending/${id}.yaml`;
      const text = yamlFile(yaml, join(place.kbDir, 'pending'), 'kb-pending');
      const parsed = parseKbFile(file, 'kbPending', text);
      if (parsed.problems.length > 0) {
        taken.delete(id);
        report.rejected.push({ document: docId, section: draft.section, topic, answer: draft.answer, reasons: parsed.problems.map(formatProblem) });
        continue;
      }
      pendingAnswers.set(answerKey(draft.answer), id);
      writes.push({ id, yaml: text });
      report.written.push({ id, file, topic, proposed: isNew, document: docId, section: draft.section });
    }
  }

  if (!options.dryRun) {
    if (writes.length > 0) mkdirSync(join(place.kbDir, 'pending'), { recursive: true });
    for (const w of writes) writeFileSync(join(place.kbDir, 'pending', `${w.id}.yaml`), w.yaml);
    addProposedTopics(place.kbDir, report.proposed);
  }
  return report;
}

/** The report as lines for a person. */
export function formatDraftReport(report: DraftReport, labels: { kb: string; dryRun?: boolean }): string[] {
  const n = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;
  const given = report.documents.reduce((s, d) => s + d.given, 0);
  const cited = report.documents.reduce((s, d) => s + d.cited, 0);
  const verb = labels.dryRun ? 'would write' : 'wrote';
  const lines = [
    `kb:draft with ${report.drafter}: ${n(report.documents.length, 'source document')}, ${n(given, 'section')} drafted from${cited > 0 ? ` (${cited} already cited, passed over)` : ''}: ${n(report.written.length, 'draft')} ${labels.dryRun ? 'would be ' : ''}written to ${labels.kb}/pending, ${report.rejected.length} refused${report.proposed.length > 0 ? `, ${n(report.proposed.length, 'topic')} proposed` : ''}${labels.dryRun ? ' (a dry run: nothing written)' : ''}`,
  ];
  for (const d of report.documents) if (d.error !== undefined) lines.push(`  failed   ${d.id}: ${d.error}`);
  for (const w of report.written) lines.push(`  ${verb.padEnd(9)}${w.file}  ${w.topic}${w.proposed ? ' (a proposed topic)' : ''}  from ${w.document} section "${w.section}"`);
  for (const r of report.rejected) {
    lines.push(`  refused  ${r.document} section "${r.section}" (${r.topic}): ${r.reasons[0]}`);
    for (const reason of r.reasons.slice(1)) lines.push(`           ${reason}`);
  }
  for (const t of report.proposed) lines.push(`  proposed ${t.id} "${t.title}" in ${labels.kb}/pending/${PENDING_TOPICS_FILE}`);
  if (report.written.length > 0) lines.push('next: pnpm kb:review to approve, edit or reject each draft; nothing pending is ever said');
  return lines;
}
