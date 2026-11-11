import { priceOf, type ModelPrice } from '../converse/model/price';
import { MODEL_EFFORTS, type ModelEffort } from '../converse/model/types';
import type { Budget } from './budget';
import type { RunSummary } from './measures';

/**
 * The model comparison (docs/designs/2026-11-11-agent-runtime.md, "Model choice" and "Decided by the
 * maintainer"): candidates run cheapest first on the same simulated callers, each held to the bars; once one
 * clears them, the dearer ones are not run just to compare. The expensive group runs only when nothing cheaper
 * cleared, or as a short quality reference when asked and the budget left clearly covers it. The budget counts
 * the caller, the judge and each candidate, and a candidate whose price is not known is refused.
 */

/** The bars a candidate must clear, every one of them. */
export interface Bars {
  /** The first sentence of a reply, the median (ms). */
  firstWordMsMedian: number;
  /** The first sentence at the 95th percentile (ms): the slow turns too. */
  firstWordMsP95: number;
  /** The share of turns that timed out, or would have at the line's own timeout. */
  timeoutRate: number;
  /** The share of cooperative calls whose task was done correctly (completed and correct; personas.ts isCooperative). */
  correctRate: number;
  /** Unsupported material claims (a price, a time, a policy that commits the business, a thing said to be done), in all: benign ones are not counted (judge.ts). */
  unsupportedClaims: number;
}

/** The maintainer's bars (2026-11-11). */
export const DEFAULT_BARS: Bars = { firstWordMsMedian: 1200, firstWordMsP95: 2500, timeoutRate: 0.01, correctRate: 0.95, unsupportedClaims: 0 };

export interface Miss {
  bar: keyof Bars;
  /** The candidate's figure; null where it has none (no turn timed, no cooperative call judged). */
  value: number | null;
  limit: number;
  /** How far past the bar, in words. */
  by: string;
}

const percent = (x: number): string => `${(x * 100).toFixed(1)} points`;

/** The bars a summary misses, each with how far. */
export function missed(s: RunSummary, bars: Bars): Miss[] {
  const out: Miss[] = [];
  const over = (bar: keyof Bars, value: number | null, limit: number, by: (d: number) => string): void => {
    if (value === null) out.push({ bar, value, limit, by: 'not measured' });
    else if (value > limit) out.push({ bar, value, limit, by: by(value - limit) });
  };
  over('firstWordMsMedian', s.firstWordMsMedian, bars.firstWordMsMedian, (d) => `${Math.round(d)} ms over`);
  over('firstWordMsP95', s.firstWordMsP95, bars.firstWordMsP95, (d) => `${Math.round(d)} ms over`);
  over('timeoutRate', s.timeoutRate, bars.timeoutRate, (d) => `${percent(d)} over`);
  if (s.cooperativeJudged === 0) out.push({ bar: 'correctRate', value: null, limit: bars.correctRate, by: 'not measured' });
  else if (s.cooperativeCorrectRate < bars.correctRate) out.push({ bar: 'correctRate', value: s.cooperativeCorrectRate, limit: bars.correctRate, by: `${percent(bars.correctRate - s.cooperativeCorrectRate)} under` });
  over('unsupportedClaims', s.unsupportedClaims, bars.unsupportedClaims, (d) => `${d} over`);
  return out;
}

/** Whether a summary clears every bar. */
export function clears(s: RunSummary, bars: Bars): boolean {
  return missed(s, bars).length === 0;
}

/** A candidate as a command line names it: `<provider>:<model>[#<effort>]`, `#none` for no effort sent. */
export interface Candidate {
  model: string;
  effort?: ModelEffort | null;
}

export function parseCandidate(spec: string): Candidate {
  const hash = spec.indexOf('#');
  if (hash < 0) return { model: spec };
  const effort = spec.slice(hash + 1);
  if (effort !== 'none' && !(MODEL_EFFORTS as readonly string[]).includes(effort)) throw new Error(`candidate "${spec}": the effort after # is one of ${MODEL_EFFORTS.join(', ')} or none`);
  return { model: spec.slice(0, hash), effort: effort === 'none' ? null : (effort as ModelEffort) };
}

/** One evaluation the comparison asks for: a candidate, at a number of runs per persona. */
export interface CandidateRun extends Candidate {
  runs: number;
}

/** What one candidate's evaluation came to. */
export interface RunOutcome {
  summary: RunSummary;
  planned: number;
  stoppedByBudget: boolean;
}

export interface CandidateResult extends Candidate {
  /** Null where it was not run. */
  summary: RunSummary | null;
  /** Why it was not run. */
  skipped?: string;
  /** It cleared every bar (a run stopped by the budget never does: it is not whole). */
  cleared?: boolean;
  /** The run stopped when the budget was spent. */
  stoppedByBudget?: boolean;
  /** Run as a short quality reference, after a cheaper model cleared. */
  reference?: boolean;
  /** What its run spent: the caller, the judge and the candidate. */
  spentUsd?: number;
  price: ModelPrice | null;
}

const CLEARED = 'a cheaper model cleared the bars';
const SPENT = 'the budget was spent';

/**
 * Runs the candidates cheapest first, then the expensive group as the stop rule allows. `run` evaluates one
 * candidate against the shared budget (the CLI's is runEval); `personas` is how many personas a run has,
 * for a reference run's estimate.
 */
export async function compareModels(o: {
  candidates: string[];
  expensive?: string[];
  runs: number;
  personas: number;
  budget: Budget;
  bars: Bars;
  stopWhenClear: boolean;
  /** Run the expensive group as a short reference once a cheaper one cleared, at this many runs per persona, if the budget left exceeds its estimate. */
  reference?: { runs: number };
  run: (c: CandidateRun, budget: Budget) => Promise<RunOutcome>;
}): Promise<CandidateResult[]> {
  const results: CandidateResult[] = [];
  let cleared = false;
  let spent = false;
  /** What a call cost the caller and the judge, from the runs so far (their spend less the candidate's own). */
  const callerJudgePerCall = (): number => {
    const per = results.filter((r) => r.summary !== null && r.summary.runs > 0 && r.spentUsd !== undefined).map((r) => r.spentUsd! / r.summary!.runs - (r.summary!.agentCostPerCallUsd ?? 0));
    return per.length === 0 ? 0 : Math.max(...per);
  };
  /** The most tokens per call a candidate used so far: the estimate's own. */
  const tokensPerCall = (): { inputTokens: number; outputTokens: number } => {
    const t = results.flatMap((r) => (r.summary?.agentTokensPerCall ? [r.summary.agentTokensPerCall] : []));
    return { inputTokens: Math.max(0, ...t.map((x) => x.inputTokens)), outputTokens: Math.max(0, ...t.map((x) => x.outputTokens)) };
  };
  const one = async (spec: string, group: 'cheap' | 'expensive'): Promise<void> => {
    const c = parseCandidate(spec);
    const price = priceOf(c.model);
    const skip = (why: string): void => void results.push({ ...c, summary: null, skipped: why, price });
    if (spent || o.budget.exceeded()) return skip(SPENT);
    if (price === null) return skip(`no price is known for ${c.model}, so the budget would under-count it: add its price (converse/model/price.ts)`);
    let runs = o.runs;
    let reference = false;
    if (cleared && (o.stopWhenClear || group === 'expensive')) {
      if (group === 'cheap' || o.reference === undefined) return skip(CLEARED);
      runs = o.reference.runs;
      const t = tokensPerCall();
      const estimate = runs * o.personas * (callerJudgePerCall() + (t.inputTokens * price.input + t.outputTokens * price.output) / 1_000_000);
      if (o.budget.left() <= estimate) return skip(`the budget left ($${o.budget.left().toFixed(2)}) is less than a reference run's estimate ($${estimate.toFixed(2)})`);
      reference = true;
    }
    const before = o.budget.spent();
    const out = await o.run({ ...c, runs }, o.budget);
    const ok = !out.stoppedByBudget && clears(out.summary, o.bars);
    results.push({ ...c, summary: out.summary, cleared: ok, spentUsd: o.budget.spent() - before, price, ...(out.stoppedByBudget ? { stoppedByBudget: true } : {}), ...(reference ? { reference: true } : {}) });
    if (out.stoppedByBudget) spent = true;
    if (ok && !reference) cleared = true;
  };
  for (const spec of o.candidates) await one(spec, 'cheap');
  for (const spec of o.expensive ?? []) await one(spec, 'expensive');
  return results;
}

const ms = (x: number): string => `${Math.round(x)}`;
const pct = (x: number | null): string => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const usd = (x: number | null | undefined): string => (x === null || x === undefined ? 'n/a' : `$${x.toFixed(4)}`);
const BAR_WORDS: Record<keyof Bars, string> = {
  firstWordMsMedian: 'first sentence median',
  firstWordMsP95: 'first sentence p95',
  timeoutRate: 'timeouts',
  correctRate: 'cooperative calls done correctly',
  unsupportedClaims: 'unsupported material claims',
};

/** The comparison as a page: one row per candidate (every measure, its cost per call, the price used and where it was read), the bars missed, the stop point and the spend. */
export function compareMarkdown(results: readonly CandidateResult[], info: { app: string; bars: Bars; spentUsd: number; budgetUsd: number; runsPerPersona: number; note?: string }): string {
  const b = info.bars;
  const name = (r: CandidateResult): string => `${r.model}${r.effort === null ? ' (no effort sent)' : r.effort ? ` (${r.effort})` : ''}${r.reference ? ' (reference)' : ''}`;
  const lines = [
    `# The model comparison on ${info.app}`,
    '',
    `Bars: first sentence median ≤ ${b.firstWordMsMedian} ms; p95 ≤ ${b.firstWordMsP95} ms; timeouts ≤ ${pct(b.timeoutRate)} of turns; cooperative calls done correctly ≥ ${pct(b.correctRate)}; unsupported material claims ≤ ${b.unsupportedClaims}. ${info.runsPerPersona} runs per persona. Spent: $${info.spentUsd.toFixed(2)} of $${info.budgetUsd.toFixed(2)}.`,
    '',
    ...(info.note !== undefined ? [info.note, ''] : []),
    '| Candidate | Calls | Cooperative done correctly | Completed | Correct | Unsupported material claims (benign beside them) | First sentence median / p90 / p95 / p99 (ms) | Timeouts | Would time out at 1.8 / 3 / 4 / 6 s | Agent cost per call | Run cost per call | Price in / out per M | Price source | Bars missed |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of results) {
    const s = r.summary;
    if (s === null) {
      lines.push(`| ${name(r)} | skipped: ${r.skipped ?? 'not run'} | | | | | | | | | | ${r.price ? `$${r.price.input} / $${r.price.output}` : 'unknown'} | ${r.price?.source ?? ''} | |`);
      continue;
    }
    const miss = missed(s, b);
    const missWords = r.stoppedByBudget ? 'stopped by the budget (not whole)' : miss.length === 0 ? 'none: clears' : miss.map((m) => `${BAR_WORDS[m.bar]} ${m.by}`).join('; ');
    const would = ['1800', '3000', '4000', '6000'].map((k) => pct(s.wouldTimeout[k] ?? null)).join(' / ');
    lines.push(`| ${name(r)} | ${s.runs} | ${pct(s.cooperativeCorrectRate)} of ${s.cooperativeJudged} | ${pct(s.completedRate)} | ${pct(s.correctRate)} | ${s.unsupportedClaims} (${s.benignClaims} benign) | ${ms(s.firstWordMsMedian)} / ${ms(s.firstWordMsP90)} / ${ms(s.firstWordMsP95)} / ${ms(s.firstWordMsP99)} | ${pct(s.timeoutRate)} of ${s.modelTurns} | ${would} | ${usd(s.agentCostPerCallUsd)} | ${usd(r.spentUsd !== undefined && s.runs > 0 ? r.spentUsd / s.runs : null)} | ${r.price ? `$${r.price.input} / $${r.price.output}` : 'unknown'} | ${r.price?.source ?? ''} | ${missWords} |`);
  }
  const winner = results.find((r) => r.cleared && !r.reference);
  const stop = winner ? `Stopped at ${winner.model}: the first to clear every bar.` : results.some((r) => r.stoppedByBudget) ? 'Stopped when the budget was spent.' : 'No candidate cleared every bar.';
  lines.push('', stop, '');
  return lines.join('\n');
}
