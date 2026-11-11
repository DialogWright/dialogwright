import type { Judged } from './judge';
import type { SimCall } from './chatDriver';

export interface RunSummary {
  runs: number;
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
  const rate = (f: (r: RunResult) => boolean): number => (n === 0 ? 0 : results.filter(f).length / n);
  const firstWords = results.flatMap((r) => r.call.firstWordMs);
  const costs = results.map((r) => r.agentCostUsd).filter((c): c is number => c !== null);
  const failures: Record<string, number> = {};
  for (const r of results) for (const f of r.failures) failures[f] = (failures[f] ?? 0) + 1;
  return {
    runs: n,
    completedRate: rate((r) => r.judged.completed),
    correctRate: rate((r) => r.judged.correct),
    unsupportedClaims: results.reduce((s, r) => s + r.judged.unsupportedClaims.length, 0),
    repeatedQuestionsPerCall: n === 0 ? 0 : results.reduce((s, r) => s + r.judged.repeatedQuestions, 0) / n,
    firstWordMsMedian: percentile(firstWords, 0.5),
    firstWordMsP90: percentile(firstWords, 0.9),
    agentCostPerCallUsd: costs.length === 0 ? null : costs.reduce((s, c) => s + c, 0) / costs.length,
    failures,
  };
}
