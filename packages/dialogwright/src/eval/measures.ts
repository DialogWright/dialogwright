import { JUDGE_FAILED, MATERIAL_KINDS, type Judged, type MaterialKind } from './judge';
import type { SimCall } from './chatDriver';
import type { ModelRequestTime } from '../converse/trace';

/** The timeouts a run's true latencies are read against (ms): what each would have done on a live line. */
export const WOULD_TIMEOUT_MS = [1800, 3000, 4000, 6000] as const;

export interface RunSummary {
  runs: number;
  /** The calls the judge gave a verdict on; the rates are over these. */
  judged: number;
  completedRate: number;
  correctRate: number;
  /** The cooperative calls the judge gave a verdict on (personas.ts isCooperative). */
  cooperativeJudged: number;
  /** Of those, the share whose task was done correctly: completed and correct. */
  cooperativeCorrectRate: number;
  /** The unsupported material claims (a price, a time, a policy, a thing said to be done): what the honesty bar counts. */
  unsupportedClaims: number;
  /** Those by kind (a verdict given before the rubric has none). */
  materialByKind: Record<MaterialKind, number>;
  /** What else the line said that nothing supports but that commits the business to nothing; not counted against the bar. */
  benignClaims: number;
  repeatedQuestionsPerCall: number;
  /** The first sentence of each reply, ms from the caller's words (chat: its first say_delta). */
  firstWordMsMedian: number;
  firstWordMsP90: number;
  firstWordMsP95: number;
  firstWordMsP99: number;
  /** The caller's turns whose model requests were timed (the converse runtime's traces). */
  modelTurns: number;
  /**
   * Of those turns, the share that timed out on the run, or would have at the line's own timeout (`timeoutMs`)
   * by their true time; null where no turn was timed.
   */
  timeoutRate: number | null;
  /** By each of WOULD_TIMEOUT_MS: the share of timed turns that would have reached that timeout. */
  wouldTimeout: Record<string, number>;
  agentCostPerCallUsd: number | null;
  /** The agent model's tokens per call, where they are known. */
  agentTokensPerCall: { inputTokens: number; outputTokens: number } | null;
  failures: Record<string, number>;
}

/** One caller turn's requests to the model, each with its true time. */
export interface TurnTiming {
  requests: ModelRequestTime[];
}

export interface RunResult {
  call: SimCall;
  judged: Judged;
  agentCostUsd: number | null;
  failures: string[];
  /** The persona is a cooperative one (personas.ts isCooperative): its call counts toward the task done correctly. */
  cooperative?: boolean;
  /** Each caller turn's model requests, from the traces. */
  turns?: TurnTiming[];
  agentTokens?: { inputTokens: number; outputTokens: number } | null;
}

/** The value at a fraction of the sorted values, by the nearest rank (0 for none). */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
}

/**
 * Whether a request would have reached a timeout of `ms` on a live line, by its true time: the runtime stops a
 * request with no first event within half its time (and asks again with the rest), and one not done within it.
 */
export function wouldTimeOut(r: ModelRequestTime, ms: number): boolean {
  const began = r.firstMs ?? (r.ms > ms / 2 ? Infinity : 0);
  return began > ms / 2 || r.ms > ms;
}

const timedOut = (r: ModelRequestTime): boolean => r.error?.startsWith('timeout') === true;

/** The measures of a run. `timeoutMs`: the line's own model timeout (agent.yaml model.timeoutMs), for the timeout rate. */
export function summarize(results: readonly RunResult[], o: { timeoutMs?: number } = {}): RunSummary {
  const n = results.length;
  // A judge that failed gave no verdict: its calls are out of the rates, not counted as failures of the line.
  const verdicts = results.filter((r) => !r.judged.notes.startsWith(JUDGE_FAILED));
  const rate = (f: (r: RunResult) => boolean): number => (verdicts.length === 0 ? 0 : verdicts.filter(f).length / verdicts.length);
  const cooperative = verdicts.filter((r) => r.cooperative === true);
  const firstWords = results.flatMap((r) => r.call.firstWordMs);
  const costs = results.map((r) => r.agentCostUsd).filter((c): c is number => c !== null);
  const tokens = results.map((r) => r.agentTokens).filter((t): t is { inputTokens: number; outputTokens: number } => t !== undefined && t !== null);
  const turns = results.flatMap((r) => r.turns ?? []).filter((t) => t.requests.length > 0);
  const share = (f: (t: TurnTiming) => boolean): number => (turns.length === 0 ? 0 : turns.filter(f).length / turns.length);
  const failures: Record<string, number> = {};
  for (const r of results) for (const f of r.failures) failures[f] = (failures[f] ?? 0) + 1;
  return {
    runs: n,
    judged: verdicts.length,
    completedRate: rate((r) => r.judged.completed),
    correctRate: rate((r) => r.judged.correct),
    cooperativeJudged: cooperative.length,
    cooperativeCorrectRate: cooperative.length === 0 ? 0 : cooperative.filter((r) => r.judged.completed && r.judged.correct).length / cooperative.length,
    unsupportedClaims: verdicts.reduce((s, r) => s + r.judged.unsupportedClaims.length, 0),
    materialByKind: Object.fromEntries(MATERIAL_KINDS.map((k) => [k, verdicts.reduce((s, r) => s + (r.judged.materialClaims ?? []).filter((c) => c.kind === k).length, 0)])) as Record<MaterialKind, number>,
    benignClaims: verdicts.reduce((s, r) => s + (r.judged.benignClaims ?? []).length, 0),
    repeatedQuestionsPerCall: verdicts.length === 0 ? 0 : verdicts.reduce((s, r) => s + r.judged.repeatedQuestions, 0) / verdicts.length,
    firstWordMsMedian: percentile(firstWords, 0.5),
    firstWordMsP90: percentile(firstWords, 0.9),
    firstWordMsP95: percentile(firstWords, 0.95),
    firstWordMsP99: percentile(firstWords, 0.99),
    modelTurns: turns.length,
    timeoutRate: turns.length === 0 ? null : share((t) => t.requests.some((r) => timedOut(r) || (o.timeoutMs !== undefined && wouldTimeOut(r, o.timeoutMs)))),
    wouldTimeout: Object.fromEntries(WOULD_TIMEOUT_MS.map((ms) => [String(ms), share((t) => t.requests.some((r) => wouldTimeOut(r, ms)))])),
    agentCostPerCallUsd: costs.length === 0 ? null : costs.reduce((s, c) => s + c, 0) / costs.length,
    agentTokensPerCall: tokens.length === 0 ? null : { inputTokens: tokens.reduce((s, t) => s + t.inputTokens, 0) / tokens.length, outputTokens: tokens.reduce((s, t) => s + t.outputTokens, 0) / tokens.length },
    failures,
  };
}
