import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunResult, RunSummary } from './measures';
import { summarize } from './measures';
import { MATERIAL_KINDS, type AuditedAction } from './judge';
import type { Persona } from './personas';

const JUDGE_FAILED_NOTE = 'judge failed';

export interface RunRecord extends RunResult {
  /** The actions the judge was given (the gate's decisions and what came back), kept as the evidence. */
  actions: AuditedAction[];
  persona: string;
  run: number;
  /** The day the call took place, where the business is, as the judge was told it: kept so the call can be judged again (eval:rejudge). */
  today?: string;
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
  /** The persona's opener the run asked for (agent.yaml persona.opener), where it asked for one. */
  opener?: string;
  /** The verdicts were given again from the stored transcripts (eval:rejudge): the spend is the judge's alone. */
  rejudged?: boolean;
  /**
   * A page to commit: no per-call notes (they retell the call), each material claim by its sentence alone (the
   * judge's reason may carry the caller's details), and each word of `withheld` (the personas' names) as [name].
   */
  published?: { withheld: readonly string[] };
}

/**
 * What a run's calls were judged against, kept beside results.jsonl as run.json so they can be judged again
 * (eval:rejudge) with no call made again: the business text, the personas, and the run's own settings.
 */
export interface StoredRun {
  app: string;
  /** The business information the judge holds the line to, as the run read it. */
  business: string;
  personas: Persona[];
  callerModel: string;
  decisionClient: string;
  runsPerPersona: number;
  lineModel?: string;
  timeoutMs?: number;
  opener?: string;
}

export const RUN_FILE = 'run.json';

export function writeRunInfo(outDir: string, run: StoredRun): void {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, RUN_FILE), JSON.stringify(run, null, 2) + '\n');
}

/** A results folder's run.json; null where the run wrote none (before 2026-11-11's Task 12). */
export function readRunInfo(dir: string): StoredRun | null {
  const file = join(dir, RUN_FILE);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as StoredRun) : null;
}

/** Appends one run to results.jsonl (the whole call, for the author's own reading). */
export function appendResult(outDir: string, r: RunRecord): void {
  mkdirSync(outDir, { recursive: true });
  appendFileSync(join(outDir, 'results.jsonl'), JSON.stringify(r) + '\n');
}

const pct = (x: number): string => `${Math.round(x * 100)}%`;
const ms = (x: number): string => `${Math.round(x)} ms`;
/**
 * Numbers of seven digits or more, and phone numbers, are left out of a page that is committed: digits joined by a
 * space of any kind (a non-breaking one among them), a dot, a bracket or any hyphen or dash (a model writes
 * U+2011, the non-breaking hyphen); an area code in brackets goes with its brackets.
 */
export const scrubNumbers = (t: string): string => t.replace(/(?:\+|\()?\d(?:(?:\)\s?|[\s().\-\u2010-\u2015])?\d){6,}/g, '[number]');
const usd = (x: number | null): string => (x === null ? 'unknown' : `$${x.toFixed(4)}`);
const pctOrNone = (x: number | null): string => (x === null ? 'not timed' : `${(x * 100).toFixed(1)}%`);
const seconds = (ms: string): string => `${Number(ms) / 1000} s`;

/** The summary page: the figures over every run, then one row per persona. No transcript is in it. */
export function summaryMarkdown(records: readonly RunRecord[], info: ReportInfo): string {
  const text = pageOf(records, info);
  if (info.published === undefined) return text;
  const withheld = [...info.published.withheld].filter((w) => w.trim() !== '').sort((a, b) => b.length - a.length);
  return withheld.reduce((t, w) => t.replace(new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), '[name]'), text);
}

function pageOf(records: readonly RunRecord[], info: ReportInfo): string {
  const timing = info.timeoutMs !== undefined ? { timeoutMs: info.timeoutMs } : {};
  const all: RunSummary = summarize(records, timing);
  const personas = [...new Set(records.map((r) => r.persona))];
  const lines: string[] = [
    `# Simulated callers on ${info.app}`,
    '',
    `${all.runs} calls over the chat wire, ${info.runsPerPersona} per persona planned.${info.lineModel !== undefined ? ` Line: ${info.lineModel}.` : ''}${info.opener !== undefined ? ` Opener: ${info.opener}.` : ''} Caller: ${info.callerModel}. Judge: ${info.judgeModel}. Decision model: ${info.decisionClient}. Spent: ${usd(info.spentUsd)} of ${usd(info.budgetUsd)}${info.stoppedByBudget ? ' (stopped at the budget; the runs it had are kept)' : ''}.`,
    ...(info.rejudged ? ['', `Re-judged by ${info.judgeModel} from the stored transcripts, actions and results, under the material-claims rubric: no call was made again, and the spend is the judge's alone. The latencies, timeouts and costs are the original run's.`] : []),
    '',
    '| Measure | Value |',
    '| --- | --- |',
    `| Calls judged | ${all.judged} of ${all.runs} |`,
    `| Completed | ${pct(all.completedRate)} |`,
    `| Correct | ${pct(all.correctRate)} |`,
    `| Cooperative calls done correctly | ${pct(all.cooperativeCorrectRate)} of ${all.cooperativeJudged} |`,
    `| Unsupported material claims (${MATERIAL_KINDS.join(' / ')}) | ${all.unsupportedClaims} (${MATERIAL_KINDS.map((k) => all.materialByKind[k]).join(' / ')}) |`,
    `| Benign claims (not counted) | ${all.benignClaims} |`,
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
  lines.push('| Persona | Calls | Completed | Correct | Material claims | Benign claims | Repeated questions | First sentence, median |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const id of personas) {
    const s = summarize(records.filter((r) => r.persona === id), timing);
    lines.push(`| ${id} | ${s.runs} | ${pct(s.completedRate)} | ${pct(s.correctRate)} | ${s.unsupportedClaims} | ${s.benignClaims} | ${s.repeatedQuestionsPerCall.toFixed(1)} | ${ms(s.firstWordMsMedian)} |`);
  }
  lines.push('');
  const noted = records.filter((r) => r.judged.notes !== '' && !r.judged.notes.startsWith(JUDGE_FAILED_NOTE) && (!r.judged.completed || !r.judged.correct || r.judged.unsupportedClaims.length > 0));
  if (noted.length > 0 && info.published === undefined) {
    lines.push('## What the judge noted on calls that fell short', '');
    for (const r of noted) lines.push(`- ${r.persona} (run ${r.run + 1}): ${scrubNumbers(r.judged.notes)}${r.judged.unsupportedClaims.length > 0 ? ` Unsupported: ${scrubNumbers(r.judged.unsupportedClaims.join('; '))}.` : ''}`);
    lines.push('');
  }
  const judged = records.filter((r) => !r.judged.notes.startsWith(JUDGE_FAILED_NOTE));
  if (judged.some((r) => (r.judged.materialClaims ?? []).length > 0)) {
    lines.push('## Material claims by kind', '');
    for (const kind of MATERIAL_KINDS) {
      const of = judged.flatMap((r) => (r.judged.materialClaims ?? []).filter((c) => c.kind === kind).map((c) => ({ r, c })));
      if (of.length === 0) continue;
      lines.push(`### ${kind}`, '');
      for (const { r, c } of of) lines.push(`- ${r.persona} (run ${r.run + 1}): "${scrubNumbers(c.said)}"${c.why !== '' && info.published === undefined ? ` ${scrubNumbers(c.why)}` : ''}`);
      lines.push('');
    }
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
