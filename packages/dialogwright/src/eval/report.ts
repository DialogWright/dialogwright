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

/** The summary page: the figures over every run, then one row per persona. No transcript is in it. */
export function summaryMarkdown(records: readonly RunRecord[], info: ReportInfo): string {
  const all: RunSummary = summarize(records);
  const personas = [...new Set(records.map((r) => r.persona))];
  const lines: string[] = [
    `# Simulated callers on ${info.app}`,
    '',
    `${all.runs} calls over the chat wire, ${info.runsPerPersona} per persona planned. Caller: ${info.callerModel}. Judge: ${info.judgeModel}. Decision model: ${info.decisionClient}. Spent on caller and judge: ${usd(info.spentUsd)} of ${usd(info.budgetUsd)}${info.stoppedByBudget ? ' (stopped at the budget; the runs it had are kept)' : ''}.`,
    '',
    '| Measure | Value |',
    '| --- | --- |',
    `| Calls judged | ${all.judged} of ${all.runs} |`,
    `| Completed | ${pct(all.completedRate)} |`,
    `| Correct | ${pct(all.correctRate)} |`,
    `| Unsupported claims | ${all.unsupportedClaims} |`,
    `| Repeated questions per call | ${all.repeatedQuestionsPerCall.toFixed(2)} |`,
    `| First word, median | ${ms(all.firstWordMsMedian)} |`,
    `| First word, p90 | ${ms(all.firstWordMsP90)} |`,
    `| Agent cost per call | ${usd(all.agentCostPerCallUsd)} |`,
    '',
  ];
  if (Object.keys(all.failures).length > 0) {
    lines.push('Failures: ' + Object.entries(all.failures).map(([k, n]) => `${k} (${n})`).join(', ') + '.', '');
  }
  lines.push('| Persona | Calls | Completed | Correct | Unsupported claims | Repeated questions | First word, median |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const id of personas) {
    const s = summarize(records.filter((r) => r.persona === id));
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
