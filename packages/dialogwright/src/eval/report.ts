import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunResult, RunSummary } from './measures';
import { summarize } from './measures';
import type { AuditedAction } from './judge';

const JUDGE_FAILED_NOTE = 'judge failed';

export interface RunRecord extends RunResult {
  /** The actions the judge was given (the gate's decisions and what came back), kept as the evidence. */
  actions: AuditedAction[];
  persona: string;
  run: number;
}

export interface ReportInfo {
  app: string;
  callerModel: string;
  /** The decision model client the server ran with: the real one, or the stub. */
  decisionClient: string;
  judgeModel: string;
  runsPerPersona: number;
  spentUsd: number;
  budgetUsd: number;
  stoppedByBudget: boolean;
  /** Plain sentences on what the run could not measure or did differently; printed under the table. */
  limits: string[];
  /** The line's own model (a converse app's), as the run asked it. */
  lineModel?: string;
  /** The line's own model time (agent.yaml model.timeoutMs), which the timeout rate is read against. */
  timeoutMs?: number;
}

/** Appends one run to results.jsonl (the whole call, for the author's own reading). */
export function appendResult(outDir: string, r: RunRecord): void {
  mkdirSync(outDir, { recursive: true });
  appendFileSync(join(outDir, 'results.jsonl'), JSON.stringify(r) + '\n');
}

const pct = (x: number): string => `${Math.round(x * 100)}%`;
const ms = (x: number): string => `${Math.round(x)} ms`;
/** Numbers of seven digits or more, and phone numbers, are left out of a page that is committed. */
export const scrubNumbers = (t: string): string => t.replace(/\+?\d(?:[\s().-]?\d){6,}/g, '[number]');
const usd = (x: number | null): string => (x === null ? 'unknown' : `$${x.toFixed(4)}`);
const pctOrNone = (x: number | null): string => (x === null ? 'not timed' : `${(x * 100).toFixed(1)}%`);
const seconds = (ms: string): string => `${Number(ms) / 1000} s`;

/** The summary page: the figures over every run, then one row per persona. No transcript is in it. */
export function summaryMarkdown(records: readonly RunRecord[], info: ReportInfo): string {
  const timing = info.timeoutMs !== undefined ? { timeoutMs: info.timeoutMs } : {};
  const all: RunSummary = summarize(records, timing);
  const personas = [...new Set(records.map((r) => r.persona))];
  const lines: string[] = [
    `# Simulated callers on ${info.app}`,
    '',
    `${all.runs} calls over the chat wire, ${info.runsPerPersona} per persona planned.${info.lineModel !== undefined ? ` Line: ${info.lineModel}.` : ''} Caller: ${info.callerModel}. Judge: ${info.judgeModel}. Decision model: ${info.decisionClient}. Spent: ${usd(info.spentUsd)} of ${usd(info.budgetUsd)}${info.stoppedByBudget ? ' (stopped at the budget; the runs it had are kept)' : ''}.`,
    '',
    '| Measure | Value |',
    '| --- | --- |',
    `| Calls judged | ${all.judged} of ${all.runs} |`,
    `| Completed | ${pct(all.completedRate)} |`,
    `| Correct | ${pct(all.correctRate)} |`,
    `| Cooperative calls done correctly | ${pct(all.cooperativeCorrectRate)} of ${all.cooperativeJudged} |`,
    `| Unsupported claims | ${all.unsupportedClaims} |`,
    `| Repeated questions per call | ${all.repeatedQuestionsPerCall.toFixed(2)} |`,
    `| First sentence, median | ${ms(all.firstWordMsMedian)} |`,
    `| First sentence, p90 | ${ms(all.firstWordMsP90)} |`,
    `| First sentence, p95 | ${ms(all.firstWordMsP95)} |`,
    `| First sentence, p99 | ${ms(all.firstWordMsP99)} |`,
    `| Timeouts${info.timeoutMs !== undefined ? ` (at the line's ${info.timeoutMs} ms)` : ''} | ${pctOrNone(all.timeoutRate)} of ${all.modelTurns} turns |`,
    ...(all.modelTurns > 0 ? [`| Would time out at ${Object.keys(all.wouldTimeout).map(seconds).join(' / ')} | ${Object.values(all.wouldTimeout).map((x) => pctOrNone(x)).join(' / ')} |`] : []),
    `| Agent cost per call | ${usd(all.agentCostPerCallUsd)} |`,
    ...(all.agentTokensPerCall !== null ? [`| Agent tokens per call (in / out) | ${Math.round(all.agentTokensPerCall.inputTokens)} / ${Math.round(all.agentTokensPerCall.outputTokens)} |`] : []),
    '',
  ];
  if (Object.keys(all.failures).length > 0) {
    lines.push('Failures: ' + Object.entries(all.failures).map(([k, n]) => `${k} (${n})`).join(', ') + '.', '');
  }
  lines.push('| Persona | Calls | Completed | Correct | Unsupported claims | Repeated questions | First sentence, median |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const id of personas) {
    const s = summarize(records.filter((r) => r.persona === id), timing);
    lines.push(`| ${id} | ${s.runs} | ${pct(s.completedRate)} | ${pct(s.correctRate)} | ${s.unsupportedClaims} | ${s.repeatedQuestionsPerCall.toFixed(1)} | ${ms(s.firstWordMsMedian)} |`);
  }
  lines.push('');
  const noted = records.filter((r) => r.judged.notes !== '' && !r.judged.notes.startsWith(JUDGE_FAILED_NOTE) && (!r.judged.completed || !r.judged.correct || r.judged.unsupportedClaims.length > 0));
  if (noted.length > 0) {
    lines.push('## What the judge noted on calls that fell short', '');
    for (const r of noted) lines.push(`- ${r.persona} (run ${r.run + 1}): ${scrubNumbers(r.judged.notes)}${r.judged.unsupportedClaims.length > 0 ? ` Unsupported: ${scrubNumbers(r.judged.unsupportedClaims.join('; '))}.` : ''}`);
    lines.push('');
  }
  if (info.limits.length > 0) lines.push('## Limits of this run', '', ...info.limits.map((l) => `- ${l}`), '');
  return lines.join('\n');
}

export function writeSummary(outDir: string, records: readonly RunRecord[], info: ReportInfo): string {
  const text = summaryMarkdown(records, info);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'summary.md'), text);
  return text;
}
