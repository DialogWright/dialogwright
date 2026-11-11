import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunResult, RunSummary } from './measures';
import { summarize } from './measures';
import { countsAgainstBar, handJudgeText, hasVerdict, MATERIAL_KINDS, NOT_JUDGED, type AuditedAction, type Claim } from './judge';
import type { Persona } from './personas';

export interface RunRecord extends RunResult {
  /** The actions the judge was given (the gate's decisions and what came back), kept as the evidence. */
  actions: AuditedAction[];
  persona: string;
  run: number;
  /** The day the call took place, where the business is, as the judge was told it: kept so the call can be judged again (eval:rejudge). */
  today?: string;
  /** Who gave the verdict, where it was given again (eval:rejudge): a judge model's id, or the words --judged-by gave ("by hand"). */
  judgedBy?: string;
}

export interface ReportInfo {
  app: string;
  callerModel: string;
  /** The decision model client the server ran with: the real one, or the stub. */
  decisionClient: string;
  judgeModel: string;
  runsPerPersona: number;
  spentUsd: number;
  /** The budget the run was given; null where no model was asked (verdicts given by hand), so none was needed. */
  budgetUsd: number | null;
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
   * A page to commit (`--publish`): no per-call notes (they retell the call), each material claim by its sentence
   * alone (the judge's reason may carry the caller's details), each word of `withheld` (the personas' names, by
   * withheldNames) as [name], no em dash, and PUBLISHED_LIMIT last among the limits.
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

/** The folder of the judge's inputs, beside results.jsonl: one file per call, for judging by hand. */
export const JUDGE_INPUTS = 'judge-inputs';

/**
 * Writes a call's judge input, `judge-inputs/<persona>-<run>.md` in `outDir`: exactly what the judge model
 * would be given (judge.ts handJudgeText). `folder`: the results folder's name, where it is one of a
 * comparison's, for the verdict line to name. A call never held has nothing to judge, and gets none.
 */
export function writeJudgeInput(outDir: string, r: RunRecord, business: string, persona: Persona, o: { today?: string; folder?: string } = {}): boolean {
  if (r.call.turns.length === 0) return false;
  const today = r.today ?? o.today;
  mkdirSync(join(outDir, JUDGE_INPUTS), { recursive: true });
  writeFileSync(join(outDir, JUDGE_INPUTS, `${r.persona}-${r.run}.md`), handJudgeText(business, persona, r.call, r.actions, { persona: r.persona, run: r.run, ...(today !== undefined ? { today } : {}), ...(o.folder !== undefined ? { folder: o.folder } : {}) }));
  return true;
}

/** "by hand" as it is; a model's id as "by <id>": how a page says who judged it again. */
export const judgedBy = (judge: string): string => (/^by\b/.test(judge) ? judge : `by ${judge}`);

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

/** What a page to commit says of itself, last among its limits. */
export const PUBLISHED_LIMIT = 'A page to commit: each material claim by its sentence alone, with no per-call notes; names and phone numbers withheld.';

/**
 * The names a page to commit withholds: each persona's name (a truth whose key says name), whole and by its
 * first word. A last name alone is kept: an invented one is often a word the business uses too ("Example").
 */
export function withheldNames(personas: readonly Persona[]): string[] {
  const names = personas.flatMap((p) => Object.entries(p.truth).filter(([k]) => /name/i.test(k)).map(([, v]) => v.trim()));
  return [...new Set(names.flatMap((n) => [n, n.split(/\s+/)[0]!]))].filter((n) => n !== '');
}

/**
 * A page made fit to commit: each word of `withheld` as [name], and an em dash (a model writes them; the
 * repository's pages have none) as a comma.
 */
export function publishedText(text: string, withheld: readonly string[]): string {
  const names = [...withheld].filter((w) => w.trim() !== '').sort((a, b) => b.length - a.length);
  const named = names.reduce((t, w) => t.replace(new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), '[name]'), text);
  return named.replace(/\s*\u2014\s*/g, ', ');
}

/** The summary page: the figures over every run, then one row per persona. No transcript is in it. */
export function summaryMarkdown(records: readonly RunRecord[], info: ReportInfo): string {
  const text = pageOf(records, info);
  return info.published === undefined ? text : publishedText(text, info.published.withheld);
}

function pageOf(records: readonly RunRecord[], info: ReportInfo): string {
  const timing = info.timeoutMs !== undefined ? { timeoutMs: info.timeoutMs } : {};
  const all: RunSummary = summarize(records, timing);
  const personas = [...new Set(records.map((r) => r.persona))];
  const waiting = records.filter((r) => r.judged.notes === NOT_JUDGED).length;
  const lines: string[] = [
    `# Simulated callers on ${info.app}`,
    '',
    `${all.runs} calls over the chat wire, ${info.runsPerPersona} per persona planned.${info.lineModel !== undefined ? ` Line: ${info.lineModel}.` : ''}${info.opener !== undefined ? ` Opener: ${info.opener}.` : ''} Caller: ${info.callerModel}. Judge: ${info.judgeModel}. Decision model: ${info.decisionClient}. Spent: ${usd(info.spentUsd)}${info.budgetUsd === null ? ' (no model was asked)' : ` of ${usd(info.budgetUsd)}`}${info.stoppedByBudget ? ' (stopped at the budget; the runs it had are kept)' : ''}.`,
    ...(info.rejudged ? ['', `Re-judged ${judgedBy(info.judgeModel)} from the stored transcripts, actions and results, under the material-claims rubric: no call was made again, and the spend is the judge's alone. The latencies, timeouts and costs are the original run's.`] : []),
    ...(waiting > 0 ? ['', `${waiting} of ${all.runs} calls wait for verdicts: each one's judge input is in ${JUDGE_INPUTS}/ (dialogwright eval:rejudge <results dir> --inputs writes them again), and dialogwright eval:rejudge <results dir> --verdicts <file> gives the verdicts. The figures below are over the calls judged.`] : []),
    '',
    '| Measure | Value |',
    '| --- | --- |',
    `| Calls judged | ${all.judged} of ${all.runs} |`,
    `| Completed${all.endedBySimulation > 0 ? ` (over the ${all.judged - all.endedBySimulation} judged calls the simulation did not end)` : ''} | ${pct(all.completedRate)} |`,
    ...(all.endedBySimulation > 0 ? [`| Calls ended by the simulation (the caller's model gave no reply twice; out of the completed and cooperative rates, in the honesty counts) | ${all.endedBySimulation} |`] : []),
    `| Correct | ${pct(all.correctRate)} |`,
    `| Cooperative calls done correctly | ${pct(all.cooperativeCorrectRate)} of ${all.cooperativeJudged} |`,
    `| Contradicted material claims, what the bar counts (${MATERIAL_KINDS.join(' / ')}) | ${all.unsupportedClaims} (${MATERIAL_KINDS.map((k) => all.materialByKind[k]).join(' / ')}) |`,
    `| Gaps in the business information (${MATERIAL_KINDS.join(' / ')}) | ${all.gapClaims} (${MATERIAL_KINDS.map((k) => all.gapsByKind[k]).join(' / ')}) |`,
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
    // The check after speaking, where the run's traces have it (a run before it has none).
    // Of the replies read as wrong at the bar, each is corrected, declined, carried, failed or left (mode record,
    // or not acted on), so the five add up to it.
    ...(all.repliesChecked > 0 ? [`| Replies the check after speaking read as wrong at its bar: corrected on the call / declined by the model / carried to the next message / correction failed / left | ${all.repliesWrong} of ${all.repliesChecked - all.checksUnread} read (${all.checksUnread} could not be read): ${all.repliesCorrected} / ${all.repliesDeclined} / ${all.repliesCarried} / ${all.repliesFailed} / ${Math.max(0, all.repliesWrong - all.repliesCorrected - all.repliesDeclined - all.repliesCarried - all.repliesFailed)} |`] : []),
    '',
  ];
  if (Object.keys(all.failures).length > 0) {
    lines.push('Failures: ' + Object.entries(all.failures).map(([k, n]) => `${k} (${n})`).join(', ') + '.', '');
  }
  lines.push('| Persona | Calls | Completed | Correct | Contradicted claims | Gaps | Benign claims | Repeated questions | First sentence, median |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const id of personas) {
    const s = summarize(records.filter((r) => r.persona === id), timing);
    // The rates are over the persona's judged calls: a call waiting for its verdict (or whose judge failed) is not one that fell short.
    const calls = s.judged < s.runs ? `${s.judged} of ${s.runs} judged` : `${s.runs}`;
    const rate = (x: number): string => (s.judged === 0 ? '–' : pct(x));
    const completed = s.judged - s.endedBySimulation === 0 ? '–' : pct(s.completedRate);
    lines.push(`| ${id} | ${calls} | ${completed} | ${rate(s.correctRate)} | ${s.unsupportedClaims} | ${s.gapClaims} | ${s.benignClaims} | ${s.repeatedQuestionsPerCall.toFixed(1)} | ${ms(s.firstWordMsMedian)} |`);
  }
  lines.push('');
  const judged = records.filter((r) => hasVerdict(r.judged));
  const noted = judged.filter((r) => r.judged.notes !== '' && (!r.judged.completed || !r.judged.correct || r.judged.unsupportedClaims.length > 0));
  if (noted.length > 0 && info.published === undefined) {
    lines.push('## What the judge noted on calls that fell short', '');
    for (const r of noted) lines.push(`- ${r.persona} (run ${r.run + 1}): ${scrubNumbers(r.judged.notes)}${r.judged.unsupportedClaims.length > 0 ? ` Contradicted: ${scrubNumbers(r.judged.unsupportedClaims.join('; '))}.` : ''}`);
    lines.push('');
  }
  // Each claim by its sentence under its kind (with the judge's reason, but on a page to commit).
  const claimsByKind = (heading: string, intro: string, which: (c: Claim) => boolean): void => {
    if (!judged.some((r) => (r.judged.materialClaims ?? []).some(which))) return;
    lines.push(heading, '', intro, '');
    for (const kind of MATERIAL_KINDS) {
      const of = judged.flatMap((r) => (r.judged.materialClaims ?? []).filter((c) => c.kind === kind && which(c)).map((c) => ({ r, c })));
      if (of.length === 0) continue;
      lines.push(`### ${kind}`, '');
      for (const { r, c } of of) lines.push(`- ${r.persona} (run ${r.run + 1}): "${scrubNumbers(c.said)}"${c.why !== '' && info.published === undefined ? ` ${scrubNumbers(c.why)}` : ''}`);
      lines.push('');
    }
  };
  claimsByKind('## Contradicted material claims by kind', 'What the business information, or the call\'s own actions and results, say otherwise of: what the bar counts.', countsAgainstBar);
  claimsByKind('## Gaps in the business information, by kind', 'What the line answered where the business information says nothing: answers for the business\'s owner to give. Not counted against the bar.', (c) => !countsAgainstBar(c));
  const limits = info.published === undefined || info.limits.includes(PUBLISHED_LIMIT) ? info.limits : [...info.limits, PUBLISHED_LIMIT];
  if (limits.length > 0) lines.push('## Limits of this run', '', ...limits.map((l) => `- ${l}`), '');
  return lines.join('\n');
}

export function writeSummary(outDir: string, records: readonly RunRecord[], info: ReportInfo): string {
  const text = summaryMarkdown(records, info);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'summary.md'), text);
  return text;
}
