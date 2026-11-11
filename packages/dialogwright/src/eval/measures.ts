import { JUDGE_FAILED, type Judged } from './judge';
import type { SimCall } from './chatDriver';

export interface RunSummary {
  runs: number;
  /** The calls the judge gave a verdict on; the rates are over these. */
  judged: number;
  completedRate: number;
  correctRate: number;
  unsupportedClaims: number;
  repeatedQuestionsPerCall: number;
  firstWordMsMedian: number;
  firstWordMsP90: number;
  agentCostPerCallUsd: number | null;
  failures: Record<string, number>;
}

export interface RunResult {
  call: SimCall;
  judged: Judged;
  agentCostUsd: number | null;
  failures: string[];
}

/** The value at a fraction of the sorted values, by the nearest rank (0 for none). */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
}

export function summarize(results: readonly RunResult[]): RunSummary {
  const n = results.length;
  // A judge that failed gave no verdict: its calls are out of the rates, not counted as failures of the line.
  const verdicts = results.filter((r) => !r.judged.notes.startsWith(JUDGE_FAILED));
  const rate = (f: (r: RunResult) => boolean): number => (verdicts.length === 0 ? 0 : verdicts.filter(f).length / verdicts.length);
  const firstWords = results.flatMap((r) => r.call.firstWordMs);
  const costs = results.map((r) => r.agentCostUsd).filter((c): c is number => c !== null);
  const failures: Record<string, number> = {};
  for (const r of results) for (const f of r.failures) failures[f] = (failures[f] ?? 0) + 1;
  return {
    runs: n,
    judged: verdicts.length,
    completedRate: rate((r) => r.judged.completed),
    correctRate: rate((r) => r.judged.correct),
    unsupportedClaims: verdicts.reduce((s, r) => s + r.judged.unsupportedClaims.length, 0),
    repeatedQuestionsPerCall: verdicts.length === 0 ? 0 : verdicts.reduce((s, r) => s + r.judged.repeatedQuestions, 0) / verdicts.length,
    firstWordMsMedian: percentile(firstWords, 0.5),
    firstWordMsP90: percentile(firstWords, 0.9),
    agentCostPerCallUsd: costs.length === 0 ? null : costs.reduce((s, c) => s + c, 0) / costs.length,
    failures,
  };
}
