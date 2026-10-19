import { DEFAULT_SECTIONS_CAP, defaultRetriever, defaultSectionRetriever, KeywordRetriever, loadAppFolder, type KbPlace, type KbTopic, type KnowledgeBase, type SectionRetriever } from 'dialogwright';
import { uncitedSections } from '../refresh/refresh';
import { collectGaps, GAP_KINDS, type CollectContext, type CollectStats, type Gap, type GapKind, type Near, type Unavailable } from './collect';
import { isStoreSpec, readTurns, storeTurns, traceFilesOf, type Turn } from './traces';

/**
 * The gap report: the gaps (./collect.ts) grouped by their nearest topic, ranked, each group with
 * samples of the callers' words, the fix for each kind it holds, and the source sections that read as
 * relevant and nothing cites yet (the keyword retriever over the sections' headings and text).
 *
 * Groups: by the topic retrieval nominated first; for words nothing was nominated for, by the topic
 * the keyword retriever scores best on them, else "no near topic"; for an unavailable resolution, by
 * the passage's own topic. Ranked by how many gaps, then how recently the latest happened, then the
 * topic id, so the same traces always give the same report.
 */

/** The group key of the words no topic is near. */
export const NO_NEAR_TOPIC = '~';
/** The group key of an app that answers from documents: questions no section offered came near answering. */
export const NO_NEAR_SECTION = '~section';
/** A section the model read at this or above for a question it did not answer is near it: worth a look. */
export const NEAR_SECTION = 0.3;
/** How far down the current retrieval of a gap's words the candidate sections are looked for (CandidateSection). */
export const CANDIDATE_CAP = 12;
/** How many candidate sections a group lists. */
export const CANDIDATES_SHOWN = 3;

/** A sample of what a caller said, and the turn it was said on. */
export interface Sample {
  kind: GapKind;
  words: string;
  ts: string;
  sessionId: string;
  turnIndex: number;
  reason?: Unavailable;
  /** Found nothing for in the documents (an app that answers from them). */
  documents?: true;
  /** The sections offered on the turn, best ranked first (a question found nothing for in the documents). */
  offered?: string[];
}

/**
 * A section of the documents that was not offered for a group's questions on their calls, that the app's
 * own section retriever ranks for their words now: the one a hint (kb/sections.yaml asks) may be wanting,
 * where the documents say what callers ask in words of their own.
 */
export interface CandidateSection {
  key: string;
  heading: string | null;
  /** Its best place in the retrieval of the group's words now (1 is first). */
  rank: number;
  /** Whether it is within what a call is offered now (kb.yaml documents.cap): the index already offers it. */
  offeredNow: boolean;
  /** How many of the group's questions rank it. */
  questions: number;
}

export type FixId = 'add-glossary' | 'add-section-asks' | 'check-candidates' | 'add-keywords' | 'write-passage' | 'draft-from-section' | 're-approve' | 'add-translation' | 'check-facts' | 'fix-topic' | 'fix-overlap' | 'check-tool';

/** What to do about one kind of gap in a group. */
export interface Fix {
  id: FixId;
  kind: GapKind;
  text: string;
  /** How many gaps of the group it answers. */
  count: number;
  /** The passage to approve again (`re-approve`). */
  passage?: string;
  /** The topics it is about. */
  topics?: string[];
  locale?: string;
}

/** A source section nothing cites that reads as relevant to a group. */
export interface DraftFrom {
  document: string;
  section: string;
  heading: string | null;
  score: number;
}

export interface GapGroup {
  /** The topic id; `~` for no near topic. */
  key: string;
  topic: string | null;
  /** The topic's title, when the knowledge base has the topic. */
  title: string | null;
  /** Whether the knowledge base has the topic (false: a topic of another app's, or one since removed). */
  known: boolean;
  near: Near;
  count: number;
  /** The day and time of the latest gap in it. */
  latest: string;
  kinds: Partial<Record<GapKind, number>>;
  reasons: Partial<Record<Unavailable, number>>;
  /** Gaps whose words are not shown (the turn carried a masked value). */
  withheld: number;
  samples: Sample[];
  fixes: Fix[];
  draftFrom: DraftFrom[];
  /**
   * A group of questions an app that answers from documents found nothing for, by the section offered
   * that came nearest (read at NEAR_SECTION or above; its best reading in the group), or none near
   * (`key` NO_NEAR_SECTION). Absent for every other group.
   */
  section?: { key: string; heading: string | null; read: number } | null;
  /** Sections not offered for the group's questions that the section retriever ranks for them now (reportFromTraces; withCandidates). */
  candidates?: CandidateSection[];
}

export interface GapReport {
  /** The knowledge base, as the command names it. */
  kb: string;
  /** The first day read, when `--since` said. */
  since: string | null;
  traces: { files: number; turns: number; calls: number; from: string | null; to: string | null; skipped: number; retrievalFailed: number };
  gaps: number;
  byKind: Record<GapKind, number>;
  groups: GapGroup[];
  /**
   * How the candidate sections were found (withCandidates): the section retriever's id, and where its model
   * did not load, why (its candidates are then by keywords alone). Absent where none were looked for.
   */
  candidatesBy?: { retriever: string; failed?: string };
}

const norm = (words: string): string => words.replace(/\s+/g, ' ').trim().toLowerCase();

// ---------------------------------------------------------------------------------------------
// What the app tells us
// ---------------------------------------------------------------------------------------------

/** The app's topic slots and informational intents, from its folder's slots.yaml and intents.yaml when it has them (none otherwise). */
export function appHints(place: KbPlace): { topicSlots: Set<string>; informational: Set<string> } {
  const topicSlots = new Set<string>();
  const informational = new Set<string>();
  if (place.appDir === null) return { topicSlots, informational };
  const config = loadAppFolder(place.appDir).config;
  if (config === null) return { topicSlots, informational };
  for (const [id, slot] of Object.entries(config.slots ?? {})) if (slot.type === 'topic') topicSlots.add(id);
  for (const [id, intent] of Object.entries(config.intents.intents)) if (intent.kind === 'informational') informational.add(id);
  return { topicSlots, informational };
}

/** A keyword retriever over the sections of the knowledge base's sources: each section a "topic" whose words are its heading and its text. */
class SectionIndex {
  private readonly retriever: KeywordRetriever;
  private readonly by = new Map<string, { document: string; section: string; heading: string | null }>();

  constructor(
    private readonly locale: string,
    sections: readonly { document: string; section: string; heading: string | null; text: string }[],
  ) {
    const topics: Record<string, KbTopic> = {};
    sections.forEach((s, i) => {
      const id = `s${i}`;
      this.by.set(id, { document: s.document, section: s.section, heading: s.heading });
      topics[id] = { id, title: s.heading ?? s.section, keywords: [], asks: [s.text], risk: 'low', locales: {} };
    });
    this.retriever = new KeywordRetriever({ topics, defaultLocale: locale });
  }

  /**
   * The sections that read as relevant to `words`, best first, at most `limit`: those the keyword
   * retriever scores on the words, held to those that match at least MIN_SHARE of the words long
   * enough to carry meaning (four letters or more), so one word in common ("card") does not make a
   * section relevant to a long question.
   */
  relevant(words: string, limit: number): DraftFrom[] {
    const said = [...new Set(words.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4))];
    if (said.length === 0) return [];
    const matches = new Map<string, number>();
    for (const w of said) for (const hit of this.retriever.scores(w, this.locale)) matches.set(hit.topic, (matches.get(hit.topic) ?? 0) + 1);
    return this.retriever
      .scores(words, this.locale)
      .filter((s) => (matches.get(s.topic) ?? 0) / said.length >= MIN_SHARE)
      .slice(0, limit)
      .map((s) => ({ ...this.by.get(s.topic)!, score: s.score }));
  }
}

/** The share of a group's meaningful words a section must match to be listed as relevant. */
const MIN_SHARE = 0.3;

// ---------------------------------------------------------------------------------------------
// Fixes
// ---------------------------------------------------------------------------------------------

const quote = (s: string): string => JSON.stringify(s);

/** A section's heading, by its key (`<document>#<section>`), from the knowledge base's sources. */
function headingOf(kb: KnowledgeBase, key: string): string | null {
  const at = key.indexOf('#');
  if (at < 0) return null;
  return kb.sources[key.slice(0, at)]?.sections[key.slice(at + 1)]?.heading ?? null;
}

/** The fix for one gap (the same fix for gaps alike is one fix, counted). */
function fixesFor(g: Gap, kb: KnowledgeBase, hasFreshPassage: (topic: string) => boolean): Omit<Fix, 'count'>[] {
  const topic = g.topic;
  const name = (id: string): string => (Object.hasOwn(kb.topics, id) ? `${kb.topics[id]!.title} (${id})` : id);
  if (g.kind === 'close') {
    const topics = [g.topic!, g.other!];
    return [{ id: 'add-keywords', kind: 'close', topics, text: `Tell "${name(topics[0]!)}" and "${name(topics[1]!)}" apart: add the words that set each one apart to their keywords and asks in kb/topics.yaml (callers were asked which they meant).` }];
  }
  if (g.kind === 'none') {
    if (topic !== null && Object.hasOwn(kb.topics, topic) && hasFreshPassage(topic)) {
      return [{ id: 'add-keywords', kind: 'none', topics: [topic], text: `If topic "${name(topic)}" should answer these, add the way callers put it to its asks and keywords in kb/topics.yaml; if they ask something it does not cover, write a passage for what they ask.` }];
    }
    return [{ id: 'write-passage', kind: 'none', topics: topic !== null ? [topic] : [], text: topic !== null ? `Write a passage for topic "${name(topic)}": it is the nearest topic, and no approved passage answers it.` : 'Write a passage (and a topic) for what callers ask.' }];
  }
  if (g.kind === 'unmatched' && g.section !== undefined) {
    const read = g.section.read;
    if (read !== null && read >= NEAR_SECTION) {
      const heading = headingOf(kb, g.section.key);
      return [{ id: 'add-glossary', kind: 'unmatched', text: `The section "${heading ?? g.section.key}" (${g.section.key}) came nearest, read ${read.toFixed(2)}, under the bar it answers at (KB_SECTION_ANSWERS): if it answers what callers ask, the document says it in other words than theirs: a line in kb/glossary.yaml puts their words in its place for the model's reading, the wording and the judge (the document is approved again). If it does not answer it, the documents do not cover it.` }];
    }
    return [{ id: 'add-section-asks', kind: 'unmatched', text: `No section offered came near${read !== null ? ` (the best read ${read.toFixed(2)})` : ''}: if a section of the documents answers it, add the way callers put it to that section's asks in kb/sections.yaml so retrieval offers it (then pnpm kb:index); if none does, the documents do not cover it.` }];
  }
  if (g.kind === 'unmatched') {
    return [
      g.topic !== null
        ? { id: 'add-keywords', kind: 'unmatched', topics: [g.topic], text: `Topic "${name(g.topic)}" is the nearest by keywords but was not nominated: add the way callers put it to its asks and keywords in kb/topics.yaml, or write a passage for what they ask.` }
        : { id: 'write-passage', kind: 'unmatched', topics: [], text: 'No topic is near these words: write a topic and a passage for what callers ask, if the knowledge base should answer it.' },
    ];
  }
  switch (g.reason!) {
    case 'stale':
      return [{ id: 're-approve', kind: 'unavailable', ...(g.passage ? { passage: g.passage.id } : {}), topics: topic !== null ? [topic] : [], text: g.passage ? `Re-approve passage "${g.passage.id}": its source section changed, so callers are not given it (pnpm kb:review shows what changed).` : 'Re-approve the passage whose source changed (pnpm kb:review).' }];
    case 'not-in-force':
      return [{ id: 'write-passage', kind: 'unavailable', topics: topic !== null ? [topic] : [], text: topic !== null ? `Write a passage for topic "${name(topic)}" in force for these callers on the day (its effective dates and applies): none answers them.` : 'Write a passage in force for these callers on the day: none answers them.' }];
    case 'no-translation':
      return [{ id: 'add-translation', kind: 'unavailable', topics: topic !== null ? [topic] : [], ...(g.locale ? { locale: g.locale } : {}), text: `Add a translation of ${topic !== null ? `topic "${name(topic)}"'s passage` : 'the passage'}${g.locale ? ` for ${g.locale}` : ''} (kb/locale/<tag>/passages, translates: the default-locale passage), or its callers hear the unavailable line.` }];
    case 'no-facts':
      return [{ id: 'check-facts', kind: 'unavailable', topics: topic !== null ? [topic] : [], text: "The resolving tool could not read the caller's facts from the system of record: a data or tool problem, not a missing passage." }];
    case 'unknown-topic':
      return [{ id: 'fix-topic', kind: 'unavailable', topics: topic !== null ? [topic] : [], text: `The topic ${topic !== null ? quote(topic) : 'the slot gave'} is not in kb/topics.yaml: add it, or correct the topic slot.` }];
    case 'ambiguous':
      return [{ id: 'fix-overlap', kind: 'unavailable', topics: topic !== null ? [topic] : [], text: 'More than one passage answers these callers: narrow their applies or dates (pnpm check refuses this).' }];
    default:
      return [{ id: 'check-tool', kind: 'unavailable', topics: topic !== null ? [topic] : [], text: 'No answer was said and the trace does not say why: read the turn in the console, and check the resolving tool.' }];
  }
}

// ---------------------------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------------------------

export interface BuildOptions {
  kb: KnowledgeBase;
  place: KbPlace;
  /** The knowledge base as the command names it. */
  label: string;
  turns: readonly Turn[];
  skipped?: number;
  files?: number;
  /** Keep only turns on or after this day (ISO date). */
  since?: string;
  /** How many sample utterances each group shows. Default 3. */
  samples?: number;
  /** How many relevant uncited sections each group lists. Default 3. */
  sections?: number;
}

/** The report for the turns read from traces. */
export function buildReport(o: BuildOptions): GapReport {
  const { kb } = o;
  const turns = o.since === undefined ? o.turns : o.turns.filter((t) => t.ts.slice(0, 10) >= o.since!);
  const hints = appHints(o.place);
  const keyword = new KeywordRetriever(kb);
  const ctx: CollectContext = {
    topicSlots: hints.topicSlots,
    informational: hints.informational,
    nearest: (words, locale) => keyword.scores(words, locale ?? kb.defaultLocale)[0]?.topic ?? null,
    documents: kb.settings.documents?.summarize === 'on',
  };
  const { gaps, stats } = collectGaps(turns, ctx, o.skipped ?? 0);

  const freshTopics = new Set(Object.values(kb.passages).filter((p) => p.freshness === 'fresh').map((p) => p.topic));
  const uncited = uncitedSections(o.place, kb);
  const sectionIndex = new SectionIndex(
    kb.defaultLocale,
    uncited.flatMap((u) => u.sections.map((s) => ({ document: u.document, section: s, heading: kb.sources[u.document]?.sections[s]?.heading ?? null, text: kb.sources[u.document]?.sections[s]?.text ?? '' }))),
  );
  const sampleCount = o.samples ?? 3;
  const sectionCount = o.sections ?? 3;

  const by = new Map<string, Gap[]>();
  for (const g of gaps) {
    // A question the documents found nothing for: by the section that came nearest, or none near.
    const key = g.section !== undefined ? (g.section.read !== null && g.section.read >= NEAR_SECTION ? `section:${g.section.key}` : NO_NEAR_SECTION) : g.topic ?? NO_NEAR_TOPIC;
    const list = by.get(key);
    if (list) list.push(g);
    else by.set(key, [g]);
  }
  const groups: GapGroup[] = [];
  for (const [key, list] of by) groups.push(groupOf(key, list, kb, freshTopics, sectionIndex, sampleCount, sectionCount, uncited.length > 0));
  groups.sort((a, b) => b.count - a.count || (a.latest < b.latest ? 1 : a.latest > b.latest ? -1 : 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const byKind = Object.fromEntries(GAP_KINDS.map((k) => [k, gaps.filter((g) => g.kind === k).length])) as Record<GapKind, number>;
  return {
    kb: o.label,
    since: o.since ?? null,
    traces: { files: o.files ?? 0, turns: stats.turns, calls: stats.sessions, from: stats.from, to: stats.to, skipped: stats.skipped, retrievalFailed: stats.retrievalFailed },
    gaps: gaps.length,
    byKind,
    groups,
  };
}

function groupOf(
  key: string,
  list: Gap[],
  kb: KnowledgeBase,
  freshTopics: ReadonlySet<string>,
  sections: SectionIndex,
  sampleCount: number,
  sectionCount: number,
  anyUncited: boolean,
): GapGroup {
  const bySection = key === NO_NEAR_SECTION || key.startsWith('section:');
  const topic = key === NO_NEAR_TOPIC || bySection ? null : key;
  const known = topic !== null && Object.hasOwn(kb.topics, topic);
  const nearest = key.startsWith('section:') ? Math.max(...list.map((g) => g.section?.read ?? 0)) : 0;
  const section = !bySection ? undefined : key === NO_NEAR_SECTION ? null : { key: key.slice('section:'.length), heading: headingOf(kb, key.slice('section:'.length)), read: nearest };
  const kinds: GapGroup['kinds'] = {};
  const reasons: GapGroup['reasons'] = {};
  for (const g of list) {
    kinds[g.kind] = (kinds[g.kind] ?? 0) + 1;
    if (g.reason !== undefined) reasons[g.reason] = (reasons[g.reason] ?? 0) + 1;
  }
  // Newest first; the same words said again count once as a sample.
  const newest = [...list].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0) || b.turnIndex - a.turnIndex || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
  const samples: Sample[] = [];
  const seen = new Set<string>();
  for (const g of newest) {
    if (g.words === null || samples.length >= sampleCount) continue;
    const text = g.words.replace(/\s+/g, ' ').trim();
    if (text === '' || seen.has(norm(text))) continue;
    seen.add(norm(text));
    samples.push({ kind: g.kind, words: text, ts: g.ts, sessionId: g.sessionId, turnIndex: g.turnIndex, ...(g.reason ? { reason: g.reason } : {}), ...(g.section !== undefined ? { documents: true as const } : {}), ...(g.offered !== undefined ? { offered: g.offered } : {}) });
  }

  const fixes = new Map<string, Fix>();
  for (const g of list) {
    for (const f of fixesFor(g, kb, (t) => freshTopics.has(t))) {
      const id = [f.id, f.kind, f.passage ?? '', (f.topics ?? []).join(','), f.locale ?? ''].join('|');
      const had = fixes.get(id);
      if (had) had.count += 1;
      else fixes.set(id, { ...f, count: 1 });
    }
  }

  // The sections nothing cites that read as relevant: for the gaps a passage would fix (nothing answers, or nothing in force).
  // (Not for questions the documents found nothing for: the documents are answered from as they are.)
  const wanting = list.filter((g) => g.section === undefined && (g.kind === 'none' || g.kind === 'unmatched' || g.reason === 'not-in-force'));
  let draftFrom: DraftFrom[] = [];
  if (wanting.length > 0 && anyUncited) {
    const said = wanting.flatMap((g) => (g.words === null ? [] : [g.words])).join(' ');
    const title = known ? `${kb.topics[topic!]!.title} ${kb.topics[topic!]!.keywords.join(' ')}` : '';
    draftFrom = sections.relevant(`${title} ${said}`.trim(), sectionCount);
    if (draftFrom.length > 0) {
      const docs = [...new Set(draftFrom.map((d) => d.document))];
      const hint = known ? kb.topics[topic!]!.title : samples[0]?.words ?? '';
      fixes.set('draft-from-section', {
        id: 'draft-from-section',
        kind: wanting[0]!.kind,
        count: wanting.length,
        ...(topic !== null ? { topics: [topic] } : {}),
        text: `Draft from a source section that reads as relevant (below): pnpm kb:draft ${docs.map((d) => `--source ${d}`).join(' ')}${hint !== '' ? ` --topic-hint ${quote(hint)}` : ''}, then approve the draft in pnpm kb:review.`,
      });
    }
  }
  return {
    key,
    topic,
    title: known ? kb.topics[topic!]!.title : null,
    known,
    near: (['nominated', 'passage', 'keyword', 'none'] as const).find((x) => list.some((g) => g.near === x))!,
    count: list.length,
    latest: newest[0]!.ts,
    kinds,
    reasons,
    withheld: list.filter((g) => g.words === null).length,
    samples,
    fixes: [...fixes.values()].sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    draftFrom,
    ...(section !== undefined ? { section } : {}),
  };
}

/** Reads `files` and builds the report (the command's work; the review page's too). */
export function reportFromFiles(o: Omit<BuildOptions, 'turns' | 'skipped' | 'files'> & { traces: readonly string[]; cwd: string }): { report: GapReport; files: string[] } {
  const files = traceFilesOf(o.traces, o.cwd);
  const turns: Turn[] = [];
  let skipped = 0;
  for (const f of files) {
    const read = readTurns(f);
    turns.push(...read.turns);
    skipped += read.skipped;
  }
  const { traces: _t, cwd: _c, ...rest } = o;
  return { report: buildReport({ ...rest, turns, skipped, files: files.length }), files };
}

/**
 * The candidate sections of each group of questions found nothing for in the documents: each sample's words
 * retrieved by `retriever` (the app's own section retriever, looking CANDIDATE_CAP deep), the sections ranked
 * that were not offered on the sample's call, by how many of the group's questions rank them, then their best
 * place; with the fix that names them. The report as it was where the app does not answer from documents.
 */
export async function withCandidates(report: GapReport, kb: KnowledgeBase, retriever: SectionRetriever | null, failed?: string): Promise<GapReport> {
  if (retriever === null) return report;
  const offeredCap = kb.settings.documents?.cap ?? DEFAULT_SECTIONS_CAP;
  const groups = await Promise.all(report.groups.map(async (g): Promise<GapGroup> => {
    const asked = g.samples.filter((s) => s.documents === true && s.offered !== undefined);
    if (asked.length === 0) return g;
    const found = new Map<string, { rank: number; questions: number }>();
    for (const s of asked) {
      const ranked = await retriever.nominate({ text: s.words, locale: kb.defaultLocale, todayIso: '' });
      ranked.forEach((n, i) => {
        if (s.offered!.includes(n.topic)) return;
        const had = found.get(n.topic);
        found.set(n.topic, { rank: Math.min(had?.rank ?? Infinity, i + 1), questions: (had?.questions ?? 0) + 1 });
      });
    }
    const candidates = [...found]
      .sort((a, b) => b[1].questions - a[1].questions || a[1].rank - b[1].rank || (a[0] < b[0] ? -1 : 1))
      .slice(0, CANDIDATES_SHOWN)
      .map(([key, c]): CandidateSection => ({ key, heading: headingOf(kb, key), rank: c.rank, offeredNow: c.rank <= offeredCap, questions: c.questions }));
    if (candidates.length === 0) return g;
    const fix: Fix = {
      id: 'check-candidates',
      kind: 'unmatched',
      count: asked.length,
      text: `Sections not offered for these questions on their calls rank for them now (below): if one answers what callers ask, add their words to its asks or keywords in kb/sections.yaml (then pnpm kb:index), so retrieval offers it; one marked "offered now" the current index already offers. The fix below, for the section that was offered, would make it win where it may not answer.`,
    };
    return { ...g, candidates, fixes: [fix, ...g.fixes] };
  }));
  return { ...report, groups, candidatesBy: { retriever: retriever.id, ...(failed !== undefined ? { failed } : {}) } };
}

/** The app's own section retriever, looking CANDIDATE_CAP deep (null where the app does not answer from documents). */
export function candidateRetriever(kb: KnowledgeBase): SectionRetriever | null {
  return defaultSectionRetriever(kb, defaultRetriever(kb).retriever, { cap: CANDIDATE_CAP });
}

/**
 * reportFromFiles over files and trace stores alike: a `--traces` spec that is `s3://<bucket>/<prefix>`
 * (TRACE_STORE's) is read through the engine's one trace reader, every call's segments joined, its
 * keys from the S3_ variables in `env`. With no store named, the same report as reportFromFiles.
 */
export async function reportFromTraces(o: Omit<BuildOptions, 'turns' | 'skipped' | 'files'> & { traces: readonly string[]; cwd: string; env: NodeJS.ProcessEnv; fetch?: typeof fetch; sectionRetriever?: SectionRetriever | null }): Promise<{ report: GapReport; files: string[] }> {
  const { sectionRetriever, ...rest } = o;
  const found = await readReport(rest);
  // Only where some group has questions found nothing for in the documents: the retriever may load a model.
  if (!found.report.groups.some((g) => g.samples.some((s) => s.offered !== undefined))) return found;
  const retriever = sectionRetriever !== undefined ? sectionRetriever : candidateRetriever(o.kb);
  // A model that does not load leaves the keywords (as on a call): said in the report, with why.
  let failed: string | undefined;
  if (retriever !== null) await retriever.warm().catch((error: unknown) => (failed = error instanceof Error ? error.message : String(error)));
  return { ...found, report: await withCandidates(found.report, o.kb, retriever, failed) };
}

async function readReport(o: Omit<BuildOptions, 'turns' | 'skipped' | 'files'> & { traces: readonly string[]; cwd: string; env: NodeJS.ProcessEnv; fetch?: typeof fetch }): Promise<{ report: GapReport; files: string[] }> {
  const { env, fetch: fetchImpl, ...fileOptions } = o;
  if (!o.traces.some(isStoreSpec)) return reportFromFiles(fileOptions);
  const files = traceFilesOf(o.traces, o.cwd);
  const turns: Turn[] = [];
  let skipped = 0;
  for (const f of files) {
    const read = readTurns(f);
    turns.push(...read.turns);
    skipped += read.skipped;
  }
  const stored = await storeTurns(o.traces, env, fetchImpl);
  turns.push(...stored.turns);
  skipped += stored.skipped;
  const { traces: _t, cwd: _c, ...rest } = fileOptions;
  const all = [...files, ...stored.files];
  return { report: buildReport({ ...rest, turns, skipped, files: all.length }), files: all };
}

// ---------------------------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------------------------

const KIND_TEXT: Record<GapKind, string> = {
  none: 'answered none',
  unmatched: 'asked with no topic nominated',
  unavailable: 'unavailable',
  close: 'close call',
};

const REASON_TEXT: Record<Unavailable, string> = {
  stale: 'stale',
  'not-in-force': 'not in force',
  'no-translation': 'no translation',
  'no-facts': 'no facts',
  'unknown-topic': 'unknown topic',
  ambiguous: 'ambiguous',
  'no-answer': 'no answer',
};

/** `text` as a Markdown code span, safe for any characters in it (a longer fence than any run of backticks inside). */
export function codeSpan(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const runs = flat.match(/`+/g) ?? [];
  const fence = '`'.repeat(Math.max(0, ...runs.map((r) => r.length)) + 1);
  return flat.startsWith('`') || flat.endsWith('`') ? `${fence} ${flat} ${fence}` : `${fence}${flat}${fence}`;
}

const n = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

/** How a group's gaps divide, as words ("3 answered none, 2 unavailable (stale)"). */
export function kindsText(g: Pick<GapGroup, 'kinds' | 'reasons' | 'section'>): string {
  if (g.section !== undefined) return `${g.kinds.unmatched ?? 0} ${DOCUMENTS_TEXT}`;
  return GAP_KINDS.filter((k) => (g.kinds[k] ?? 0) > 0)
    .map((k) => {
      const reasons = k === 'unavailable' ? Object.entries(g.reasons).map(([r, c]) => `${REASON_TEXT[r as Unavailable]} ${c}`).join(', ') : '';
      return `${g.kinds[k]} ${KIND_TEXT[k]}${reasons !== '' ? ` (${reasons})` : ''}`;
    })
    .join(', ');
}

/** A sample's label: its kind, and for an unavailable one its reason. */
export const sampleLabel = (s: Pick<Sample, 'kind' | 'reason' | 'documents'>): string => (s.reason !== undefined ? `unavailable: ${REASON_TEXT[s.reason]}` : s.documents === true ? DOCUMENTS_TEXT : KIND_TEXT[s.kind]);

/** A question an app that answers from documents found nothing for, as a sample's and a group's label says it. */
const DOCUMENTS_TEXT = 'not found in the documents';

/** The group's heading text: the topic with its title, or "no near topic". */
export function groupName(g: Pick<GapGroup, 'topic' | 'title' | 'known' | 'section'>): string {
  if (g.section === null) return 'No section near';
  if (g.section !== undefined) return `Section: ${g.section.heading ?? g.section.key} (${g.section.key}), read up to ${g.section.read.toFixed(2)}`;
  if (g.topic === null) return 'No near topic';
  return g.title !== null ? `${g.title} (${g.topic})` : g.known ? g.topic : `${g.topic} (not a topic of this knowledge base)`;
}

/** The report as Markdown: a ranked list of groups, each with how its gaps divide, what callers said, the fix for each kind and the sections to draft from. */
export function formatMarkdown(r: GapReport): string[] {
  const t = r.traces;
  const lines: string[] = ['# Knowledge gaps', ''];
  lines.push(
    `${r.kb}: ${n(r.gaps, 'gap')} in ${n(r.groups.length, 'group')}, from ${n(t.turns, 'turn')} in ${n(t.calls, 'call')} (${n(t.files, 'trace file')}${t.from !== null ? `, ${t.from === t.to ? t.from : `${t.from} to ${t.to}`}` : ''}${r.since !== null ? `; since ${r.since}` : ''}).`,
  );
  // An app that answers from documents: its unmatched questions are ones it found nothing for in them.
  const documents = r.groups.some((g) => g.section !== undefined);
  const kinds = GAP_KINDS.filter((k) => r.byKind[k] > 0).map((k) => `${r.byKind[k]} ${k === 'unmatched' && documents ? DOCUMENTS_TEXT : KIND_TEXT[k]}`);
  if (kinds.length > 0) lines.push('', `By kind: ${kinds.join(', ')}.`);
  if (r.candidatesBy !== undefined) lines.push('', r.candidatesBy.failed === undefined ? `Candidate sections by ${r.candidatesBy.retriever}.` : `Candidate sections by keywords alone: the sections' model did not load (${r.candidatesBy.failed}).`);
  if (t.retrievalFailed > 0) lines.push('', `${n(t.retrievalFailed, 'turn')} nominated nothing because retrieval failed (an error, an invalid answer or too late): not counted as gaps; see the traces' retrieval.failed.`);
  if (t.skipped > 0) lines.push('', `${n(t.skipped, 'line')} of the traces were not read (not a current trace record).`);
  if (r.groups.length === 0) {
    lines.push('', t.turns === 0 ? 'No turns were read: nothing to rank.' : 'No gaps: every question the callers asked was answered from the knowledge base, or was not a question for it.');
    return lines;
  }
  r.groups.forEach((g, i) => {
    lines.push('', `## ${i + 1}. ${groupName(g)}: ${n(g.count, 'gap')}`, '');
    lines.push(`${kindsText(g)}. Latest ${g.latest.slice(0, 10)}.${g.near === 'keyword' ? ' (Nearest by keywords: retrieval nominated nothing.)' : ''}`);
    if (g.samples.length > 0) {
      lines.push('', 'Callers said:');
      for (const s of g.samples) lines.push(`- ${codeSpan(s.words)} (${sampleLabel(s)}, ${s.ts.slice(0, 10)})`);
    }
    if (g.withheld > 0) lines.push('', `${n(g.withheld, 'turn')} not shown: the caller gave a value the trace masks on ${g.withheld === 1 ? 'it' : 'them'}.`);
    lines.push('', 'Fix:');
    for (const f of g.fixes) lines.push(`- ${f.text}${f.count > 1 ? ` (${f.count})` : ''}`);
    if (g.candidates !== undefined && g.candidates.length > 0) {
      lines.push('', 'Sections not offered on these calls that rank for the questions now:');
      for (const c of g.candidates) lines.push(`- ${c.heading ?? c.key} (${c.key}): ${c.offeredNow ? 'offered now' : `ranks ${c.rank} now`}${c.questions > 1 ? `, for ${c.questions} questions` : ''}`);
    }
    if (g.draftFrom.length > 0) {
      lines.push('', 'Sections nothing cites that read as relevant:');
      for (const d of g.draftFrom) lines.push(`- ${d.document} / ${d.section}${d.heading !== null ? ` (${d.heading})` : ''}`);
    }
  });
  return lines;
}

/** The report as JSON, for tools. */
export function formatJson(r: GapReport): string {
  return JSON.stringify(r, null, 2);
}

export type { CollectStats };
