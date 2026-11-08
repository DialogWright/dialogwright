import type { TraceRecord } from '../../trace/types';

/**
 * The agent model's figures (an app in agent mode, core/agentTurn.ts): its turns, the turns it gave no
 * answer on (a timeout, an answer not in its shape, an error), and its replies held to the facts
 * (render/agentLine.ts), with those replaced by their fixed line, by why. Counts only: no words of a call.
 */
export interface AgentFigures {
  /** Turns whose words the agent model was asked about and the turn read (its answer used, or none came). */
  turns: number;
  /** Of them, the turns no answer came on: the fixed line said in its place. */
  failed: number;
  /** Replies the turn said, each held to the facts. */
  replies: number;
  /** Of them, the replies replaced by their fixed line: a check failed, the judge refused it, or it was not read in time. */
  fellBack: number;
  /** The fallbacks by why: a reply's check or judge (`foreign`, `drift`, ...), an answer that never came by `answer:<why>` (`answer:timeout`). */
  reasons: Record<string, number>;
}

/** No figures. */
export const emptyAgentFigures = (): AgentFigures => ({ turns: 0, failed: 0, replies: 0, fellBack: 0, reasons: {} });

/** What one call's records add (null for a call with no agent turn: every call of an app not in agent mode). */
export function agentFactsOf(records: readonly TraceRecord[]): AgentFigures | null {
  let f: AgentFigures | null = null;
  for (const r of records) {
    const a = r.agent;
    if (a === undefined || r.outlivedHold === true || a.use === 'dropped') continue;
    f ??= emptyAgentFigures();
    f.turns += 1;
    if (a.use === 'failed' && a.fallback !== undefined) {
      f.failed += 1;
      const why = `answer:${a.fallback}`;
      f.reasons[why] = (f.reasons[why] ?? 0) + 1;
    }
    const line = a.line;
    if (line === undefined) continue;
    f.replies += 1;
    if (line.mode !== 'fixed') continue;
    f.fellBack += 1;
    const why = line.fallback ?? line.skipped ?? 'fixed';
    f.reasons[why] = (f.reasons[why] ?? 0) + 1;
  }
  return f;
}

/** Two figures added, into the first. */
export function addAgent(into: AgentFigures, from: AgentFigures): void {
  into.turns += from.turns;
  into.failed += from.failed;
  into.replies += from.replies;
  into.fellBack += from.fellBack;
  for (const [k, n] of Object.entries(from.reasons)) into.reasons[k] = (into.reasons[k] ?? 0) + n;
}

const count = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** The figures as a file holds them, every number a count; null for anything else. */
export function agentFiguresOf(raw: unknown): AgentFigures | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!count(r.turns) || !count(r.failed) || !count(r.replies) || !count(r.fellBack)) return null;
  const reasons = r.reasons;
  if (typeof reasons !== 'object' || reasons === null || Array.isArray(reasons) || !Object.entries(reasons).every(([k, n]) => k.length <= 40 && count(n))) return null;
  return { turns: r.turns, failed: r.failed, replies: r.replies, fellBack: r.fellBack, reasons: { ...(reasons as Record<string, number>) } };
}

/** Why an agent reply or answer fell back, in a few words (the console's Insights). */
const REASON_WORDS: Readonly<Record<string, string>> = {
  foreign: 'a number, amount, date or web address the facts do not hold',
  drift: 'the judge refused it',
  'drift-error': 'the judge gave no reading',
  timeout: 'the judge was too slow',
  format: 'markup, a line break or too long',
  question: 'more than one question',
  shape: 'a piece of the answer\'s shape in it',
  words: 'over its word budget',
  avoid: 'a phrase to avoid',
  screen: 'the words were flagged or unread',
  'answer:timeout': 'no answer in time',
  'answer:invalid': 'an answer not in its shape',
  'answer:error': 'the agent model failed',
};

/** The agent's figures for Insights: the counts, and the fallbacks by why in words, the most first. */
export interface AgentInsights {
  turns: number;
  failed: number;
  replies: number;
  fellBack: number;
  reasons: { key: string; label: string; n: number }[];
}

export function agentInsightsOf(f: AgentFigures | undefined): AgentInsights | null {
  if (f === undefined || f.turns === 0) return null;
  return {
    turns: f.turns, failed: f.failed, replies: f.replies, fellBack: f.fellBack,
    reasons: Object.entries(f.reasons).map(([key, n]) => ({ key, label: REASON_WORDS[key] ?? key, n })).sort((a, b) => b.n - a.n || a.key.localeCompare(b.key)),
  };
}
