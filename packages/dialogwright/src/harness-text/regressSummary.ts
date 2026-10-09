import type { TraceRecord, TraceSource } from '../trace/types';
import { CASSETTE_MISS, isCassetteMiss } from '../jev/cassette';
import { percentile } from './metrics';
import { SCREEN_UNANSWERED } from '../core/screen';

export interface RegressSummaryInput {
  corpusTotal: number;
  corpusMatching: number;
  scenarioTotal: number;
  scenarioPassing: number;
  scenarioMatching: number;
  /** known-gap corpus entries (CorpusEntry.knownGap) the run tolerates, and how many of them drifted; omitted for a run that tolerates none */
  knownGaps?: { total: number; drifted: number };
  /** every turn the run made; only answered turns count toward cost and latency */
  records: Pick<TraceRecord, 'source' | 'timing' | 'usage' | 'error' | 'screen'>[];
}

// Turns that never produced an answer. Inverted (rather than an allow-list of answered
// sources) so a new AnswerSource is counted in by default instead of silently dropped.
const UNANSWERED = new Set<TraceSource>(['none', 'error', 'dtmf']);

/** The block printed after a regression diff: label agreement, then cost and latency of the requests the run made. */
export function formatRegressSummary(i: RegressSummaryInput): string {
  const answered = i.records.filter((r) => !UNANSWERED.has(r.source));
  const sources = new Set(answered.map((r) => r.source));
  const tag = sources.size === 1 && sources.has('recorded') ? '   [replayed]' : sources.size > 1 ? '   [mixed]' : '';
  const lines = [
    `corpus     ${String(i.corpusMatching).padStart(3)}/${i.corpusTotal} outcomes match expected`,
    `scenarios  ${String(i.scenarioPassing).padStart(3)}/${i.scenarioTotal} pass expectation,  ${i.scenarioMatching}/${i.scenarioTotal} match expected`,
  ];
  if (i.knownGaps && i.knownGaps.total > 0) lines.push(`known gaps ${String(i.knownGaps.drifted).padStart(3)}/${i.knownGaps.total} drifted (allowed)`);
  // Estimated usage (the heuristic stub) is priced by the trace writer but isn't a real
  // cost, so it's excluded here rather than gated on the client kind.
  const priced = answered.filter((r) => !r.usage.estimated);
  if (priced.length > 0) {
    const cost = priced.reduce((s, r) => s + r.usage.costUsd, 0);
    const tokens = priced.reduce((s, r) => s + r.usage.inputTokens, 0);
    lines.push(`cost usd   ${cost.toFixed(4)}  (${priced.length} requests, ${String(tokens).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} input tokens)${tag}`);
  }
  if (answered.length > 0) {
    const latencies = answered.map((r) => r.timing.askMs);
    lines.push(`ask latency ms p50 ${percentile(latencies, 50).toFixed(1)}  p95 ${percentile(latencies, 95).toFixed(1)}`);
  }
  const misses = i.records.filter(isCassetteMiss).length;
  if (misses > 0) lines.push(`cassette misses ${misses}`);
  const clientErrors = i.records.filter((r) => r.source === 'error' && r.error && !r.error.message.startsWith(CASSETTE_MISS));
  if (clientErrors.length > 0) lines.push(`client errors ${clientErrors.length} (first: ${clientErrors[0]!.error!.message})`);
  // The screen fails open, so a turn it never read looks answered; this line is where that shows.
  // Its cassette misses are counted with the others above. An inline screen's failed request is
  // perception's, already counted as a client error above; its answer missing from a response that
  // did come back (SCREEN_UNANSWERED) is the screen's own, and counted here.
  const screenErrors = i.records.filter((r) => r.screen?.error && (!r.screen.inline || r.screen.error === SCREEN_UNANSWERED) && !r.screen.error.startsWith(CASSETTE_MISS));
  if (screenErrors.length > 0) lines.push(`screen errors ${screenErrors.length} (first: ${screenErrors[0]!.screen!.error})`);
  return lines.join('\n');
}

export interface TriageInput {
  /** corpus ids that differ from the baseline in a way no known gap allows (regressDiff.ts differingIds) */
  corpusDiffering: readonly string[];
  /** scripted calls that miss their own expectation */
  scenariosFailing: readonly string[];
  /** scripted calls that differ from the baseline in a way `cosmeticDrift` does not allow, failing or not */
  scenariosDiffering: readonly string[];
  records: Pick<TraceRecord, 'source' | 'error' | 'screen'>[];
}

const counted = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * The last line of a run against a model or its cassette: how many things need a decision, so triage
 * does not mean reading the diff by hand. A failing scripted call is counted once, as failing; the
 * calls that pass their expectation but still differ from the baseline (without `cosmeticDrift`) are
 * counted on their own.
 */
export function formatTriage(i: TriageInput): string {
  const failing = new Set(i.scenariosFailing);
  const drifting = i.scenariosDiffering.filter((id) => !failing.has(id)).length;
  const misses = i.records.filter(isCassetteMiss).length;
  return [
    `to triage: ${counted(i.corpusDiffering.length, 'untagged corpus difference', 'untagged corpus differences')}`,
    counted(failing.size, 'failing scripted call', 'failing scripted calls'),
    counted(drifting, 'passing scripted call that differs from the baseline', 'passing scripted calls that differ from the baseline'),
    counted(misses, 'cassette miss', 'cassette misses'),
  ].join(', ');
}
