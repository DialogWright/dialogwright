export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  /** label -> short description, or null for self-describing labels */
  criteria: Record<string, string | null>;
}

export interface ScoreLevel {
  label: string;
  description: string;
}

export interface ScoreQuestion {
  type: 'score';
  instructions: string;
  /** ordered from lowest to highest; index 0 is level 1 */
  levels: ScoreLevel[];
}

export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: { true?: string; false?: string };
}

export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;
export type QuestionMap = Record<string, Question>;

export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: 'score';
  /** expected level, 1-based, may be fractional */
  score: number;
  /** keyed by level label, not level number */
  probabilities: Record<string, number>;
  confidence: number;
}

export interface NoulAnswer {
  type: 'noul';
  noul: number;
}

export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;
export type AnswerMap = Record<string, Answer>;

export type AnswerSource = 'jev' | 'stub:fixture' | 'stub:heuristic' | 'replay' | 'recorded';

export interface JevUsage {
  inputTokens: number;
  outputTokens: number;
  estimated: boolean;
}

export interface JevRequest {
  state: JsonValue;
  questions: QuestionMap;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface JevResponse {
  answers: AnswerMap;
  model: string;
  usage: JevUsage;
  latencyMs: number;
  source: AnswerSource;
}

/**
 * What answers a client's asks (jev/provider.ts): the provider, the model id it is sent, and whether
 * it is TypeSafe's Jev, whose probabilities the thresholds were measured on. Written to the trace's
 * session start (TraceRecord.answeredBy).
 */
export interface AnsweredBy {
  provider: string;
  model: string;
  official: boolean;
}

export interface JevClient {
  ask(req: JevRequest): Promise<JevResponse>;
  /** The model behind a live or recorded client; a stub, which asks no model, has none. */
  readonly answeredBy?: AnsweredBy;
  /**
   * Open the connection to the model ahead of the first ask, so a call's first turn does not pay
   * for TCP and TLS setup. Best effort: it resolves whether or not the connection opened, and a
   * client with nothing to warm leaves it out. `connections` is how many requests a turn sends at
   * once (core/screen.ts requestsPerTurn): one, unless the injection screen is asked separately.
   */
  warm?(connections?: number): Promise<void>;
}

export class JevClientError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'JevClientError';
  }
}

export interface Ranked {
  label: string;
  p: number;
}

export function rankProbabilities(probabilities: Record<string, number>): Ranked[] {
  return Object.entries(probabilities)
    .map(([label, p]) => ({ label, p }))
    .sort((a, b) => b.p - a.p);
}

export function topMargin(probabilities: Record<string, number>): number {
  const ranked = rankProbabilities(probabilities);
  const first = ranked[0]?.p ?? 0;
  const second = ranked[1]?.p;
  return second === undefined ? 1 : first - second;
}

export function isChoice(a: Answer | undefined): a is ChoiceAnswer {
  return a?.type === 'choice';
}
export function isScore(a: Answer | undefined): a is ScoreAnswer {
  return a?.type === 'score';
}
export function isNoul(a: Answer | undefined): a is NoulAnswer {
  return a?.type === 'noul';
}

/** Read a noul value or return 0 when the answer is missing or the wrong type. */
export function noulValue(answers: AnswerMap, id: string): number {
  const a = answers[id];
  return isNoul(a) ? a.noul : 0;
}

/** Estimate tokens for stubs: JSON length over four. */
export function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}
