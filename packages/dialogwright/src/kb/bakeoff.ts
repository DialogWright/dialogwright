import { performance } from 'node:perf_hooks';
import { parse } from 'yaml';
import { fuse, type DenseRetriever } from './hybrid';
import type { KeywordRetriever } from './keyword';
import type { Retriever } from './types';
import type { RetrievalKb } from './words';

/**
 * The retrieval bake-off (`pnpm kb:bakeoff`): how well each retriever nominates the right topic for
 * what callers say, offline, on a paraphrase file. Retrieval caps and floors change what the model
 * is asked, so they are chosen here, on paraphrases, not by re-recording calls.
 *
 * A paraphrase file (fixtures/kb/paraphrases.yaml, or beside a knowledge base) maps each topic id to
 * things a caller says about it in other words than the topic's own, and `none:` to things a caller
 * says that no topic answers:
 *
 *   opening_hours:
 *     - What time do you close tonight?
 *   none:
 *     - Where do I park?
 *
 * For each retriever it reports recall at the cap (the share of a topic's paraphrases whose
 * nominations include it), per topic and overall; the share with it first; the mean number of
 * candidates per paraphrase, and per `none` line (every one there is a question asked for nothing);
 * and the time per nomination. The sweep (`--sweep`) recomputes the hybrid's and the dense
 * retriever's nominations for each floor and cap from one pass of scores, and prints recall against
 * mean candidates, so a floor and cap are picked by what they cost.
 */

/** A paraphrase file, read. */
export interface Paraphrases {
  /** Each topic's paraphrases, in the file's order. */
  readonly topics: Readonly<Record<string, readonly string[]>>;
  /** Lines no topic answers. */
  readonly none: readonly string[];
}

/** Reads a paraphrase file's text; throws, saying what is wrong, when it is not one, or names a topic the knowledge base does not have. */
export function parseParaphrases(text: string, kb: RetrievalKb): Paraphrases {
  const data = parse(text) as unknown;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('a paraphrase file is a map from topic id (or none) to a list of lines');
  const topics: Record<string, string[]> = {};
  let none: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || v.trim() === '')) throw new Error(`"${key}" is not a list of lines`);
    if (key === 'none') none = value as string[];
    else if (!Object.hasOwn(kb.topics, key)) throw new Error(`"${key}" is not a topic of the knowledge base (its topics: ${Object.keys(kb.topics).join(', ')})`);
    else topics[key] = value as string[];
  }
  return { topics, none };
}

/** One retriever's results. */
export interface BakeoffResult {
  readonly retriever: string;
  /** Per topic: how many of its paraphrases nominated it, nominated it first, and how many there are. */
  readonly perTopic: Readonly<Record<string, { readonly hits: number; readonly first: number; readonly total: number }>>;
  /** Recall at the cap over every topic paraphrase. */
  readonly recall: number;
  /** The share of topic paraphrases with their topic nominated first. */
  readonly top1: number;
  /** Mean nominations per topic paraphrase. */
  readonly meanCandidates: number;
  /** Mean nominations per `none` line. */
  readonly noneCandidates: number;
  /** Milliseconds per nomination: mean and 95th percentile (after one warm-up pass). */
  readonly meanMs: number;
  readonly p95Ms: number;
}

const mean = (xs: readonly number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

/** Runs one retriever over every line of the file, in `locale`, on `todayIso`. */
export async function bakeoff(retriever: Retriever, paraphrases: Paraphrases, locale: string, todayIso: string, name: string = retriever.id): Promise<BakeoffResult> {
  const lines = [...Object.entries(paraphrases.topics).flatMap(([topic, said]) => said.map((text) => ({ topic, text }))), ...paraphrases.none.map((text) => ({ topic: null as string | null, text }))];
  for (const { text } of lines) await retriever.nominate({ text, locale, todayIso });
  const perTopic: Record<string, { hits: number; first: number; total: number }> = {};
  const candidates: number[] = [];
  const noneCandidates: number[] = [];
  const ms: number[] = [];
  for (const { topic, text } of lines) {
    const t0 = performance.now();
    const nominated = await retriever.nominate({ text, locale, todayIso });
    ms.push(performance.now() - t0);
    if (topic === null) {
      noneCandidates.push(nominated.length);
      continue;
    }
    candidates.push(nominated.length);
    const row = (perTopic[topic] ??= { hits: 0, first: 0, total: 0 });
    row.total += 1;
    if (nominated.some((n) => n.topic === topic)) row.hits += 1;
    if (nominated[0]?.topic === topic) row.first += 1;
  }
  const rows = Object.values(perTopic);
  const total = rows.reduce((n, r) => n + r.total, 0);
  const sorted = [...ms].sort((a, b) => a - b);
  return {
    retriever: name,
    perTopic,
    recall: total === 0 ? 0 : rows.reduce((n, r) => n + r.hits, 0) / total,
    top1: total === 0 ? 0 : rows.reduce((n, r) => n + r.first, 0) / total,
    meanCandidates: mean(candidates),
    noneCandidates: mean(noneCandidates),
    meanMs: mean(ms),
    p95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0,
  };
}

/** One point of the sweep. */
export interface SweepPoint {
  readonly retriever: 'hybrid' | 'dense';
  readonly floor: number;
  readonly cap: number;
  readonly recall: number;
  readonly meanCandidates: number;
  readonly noneCandidates: number;
}

/** The floors and caps a sweep tries by default. */
export const SWEEP_FLOORS: readonly number[] = Array.from({ length: 17 }, (_, i) => Math.round(i * 5) / 100);
export const SWEEP_CAPS: readonly number[] = [1, 2, 3, 4, 6, 8];

/**
 * The hybrid's and the dense retriever's recall and candidates at every floor and cap, from one pass
 * of scores: the keyword scores and every dense hit at floor 0 for each line, then the floor and cap
 * applied (and the two rankings fused, for the hybrid) offline.
 */
export async function sweep(
  keyword: KeywordRetriever,
  dense: DenseRetriever,
  paraphrases: Paraphrases,
  locale: string,
  floors: readonly number[] = SWEEP_FLOORS,
  caps: readonly number[] = SWEEP_CAPS,
): Promise<SweepPoint[]> {
  const lines = [...Object.entries(paraphrases.topics).flatMap(([topic, said]) => said.map((text) => ({ topic: topic as string | null, text }))), ...paraphrases.none.map((text) => ({ topic: null as string | null, text }))];
  const scored = [];
  for (const { topic, text } of lines) {
    const vector = await dense.embedQuery(text);
    scored.push({ topic, kw: keyword.scores(text, locale), dense: await dense.hitsFor(vector, locale, 0) });
  }
  const out: SweepPoint[] = [];
  for (const kind of ['hybrid', 'dense'] as const) {
    for (const floor of floors) {
      for (const cap of caps) {
        const topical: number[] = [];
        const nones: number[] = [];
        let hits = 0;
        let total = 0;
        for (const s of scored) {
          const above = s.dense.filter((h) => h.score >= floor);
          const nominated = kind === 'hybrid' ? fuse(s.kw, above, cap, (t) => t) : above.slice(0, cap);
          if (s.topic === null) {
            nones.push(nominated.length);
            continue;
          }
          topical.push(nominated.length);
          total += 1;
          if (nominated.some((n) => n.topic === s.topic)) hits += 1;
        }
        out.push({ retriever: kind, floor, cap, recall: total === 0 ? 0 : hits / total, meanCandidates: mean(topical), noneCandidates: mean(nones) });
      }
    }
  }
  return out;
}

/** A result as report lines: a row per retriever, then each topic's hits per retriever (retrievers numbered as in the first table). */
export function formatResults(results: readonly BakeoffResult[]): string[] {
  const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
  const width = Math.max(9, ...results.map((r) => r.retriever.length + 4));
  const lines = [`${'retriever'.padEnd(width)}  recall@cap   top-1  candidates  on none  ms mean  ms p95`];
  results.forEach((r, i) => {
    lines.push(`${`${i + 1}. ${r.retriever}`.padEnd(width)}  ${pct(r.recall).padStart(10)}  ${pct(r.top1).padStart(6)}  ${r.meanCandidates.toFixed(2).padStart(10)}  ${r.noneCandidates.toFixed(2).padStart(7)}  ${r.meanMs.toFixed(3).padStart(7)}  ${r.p95Ms.toFixed(3).padStart(6)}`);
  });
  const topics = [...new Set(results.flatMap((r) => Object.keys(r.perTopic)))];
  const tw = Math.max(5, ...topics.map((t) => t.length));
  lines.push('', `${'topic'.padEnd(tw)}  ${results.map((_, i) => `${i + 1}.`.padStart(7)).join('')}   (hits / paraphrases)`);
  for (const t of topics) lines.push(`${t.padEnd(tw)}  ${results.map((r) => `${r.perTopic[t]?.hits ?? 0}/${r.perTopic[t]?.total ?? 0}`.padStart(7)).join('')}`);
  return lines;
}

/** A sweep as report lines: one table per retriever, a row per floor, a column per cap, each "recall / candidates (on none)". */
export function formatSweep(points: readonly SweepPoint[]): string[] {
  const lines: string[] = [];
  for (const kind of ['hybrid', 'dense'] as const) {
    const mine = points.filter((p) => p.retriever === kind);
    const caps = [...new Set(mine.map((p) => p.cap))];
    const floors = [...new Set(mine.map((p) => p.floor))];
    lines.push(`${kind}: recall / mean candidates (on none), by floor and cap`, `floor  ${caps.map((c) => `cap ${c}`.padStart(22)).join('')}`);
    for (const f of floors) {
      lines.push(`${f.toFixed(2).padEnd(5)}  ${caps.map((c) => {
        const p = mine.find((q) => q.floor === f && q.cap === c)!;
        return `${(p.recall * 100).toFixed(0)}% / ${p.meanCandidates.toFixed(2)} (${p.noneCandidates.toFixed(2)})`.padStart(22);
      }).join('')}`);
    }
    lines.push('');
  }
  return lines;
}
