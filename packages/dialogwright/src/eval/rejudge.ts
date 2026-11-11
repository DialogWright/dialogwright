import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import { agentBusinessProblems } from '../converse/business/load';
import { costUsd, priceOf } from '../converse/model/price';
import { resolveConverseModel } from '../converse/model/resolve';
import type { ConverseModel } from '../converse/model/types';
import { inCi } from '../define/ci';
import { Budget } from './budget';
import { businessTextOf, effortArg, envOf, type EvalIo } from './cli';
import { clears, compareMarkdown, DEFAULT_BARS, type CandidateResult } from './compare';
import { JUDGE_FAILED, judgeCall } from './judge';
import { summarize } from './measures';
import { loadPersonas } from './personas';
import { readRunInfo, summaryMarkdown, type RunRecord, type StoredRun } from './report';

/**
 * eval:rejudge: a run's stored calls (results.jsonl: each transcript with the actions the gate decided and
 * what came back, and the day it took place) judged again, under the judge's current rubric (the material
 * claims, judge.ts), with no call made again. Each results folder gets rejudged/results.jsonl and
 * rejudged/summary.md beside it; a comparison's folder (one results folder per candidate) also gets
 * rejudged/comparison.md, the table again. A verdict already given is kept, so a re-judge stopped by its
 * budget goes on where it stopped.
 */

export const REJUDGE_USAGE = [
  'usage: dialogwright eval:rejudge <results dir> [--judge anthropic:<model>] [--budget <usd>] [--parallel N] [--app <dir> --personas <file>] [--today YYYY-MM-DD]',
  '  the calls stored in <results dir>/results.jsonl (or in each folder of a comparison) judged again under the material-claims rubric, with no call made again;',
  '  writes rejudged/results.jsonl and rejudged/summary.md beside each, and for a comparison rejudged/comparison.md, the table under the material-claims bar',
  '  defaults: --judge anthropic:claude-sonnet-5-5, --budget 10 (US dollars; it stops, keeping what it judged, once spent: run it again to go on), --parallel 4',
  '  the budget is checked before each call is judged, so the spend may pass it by up to --parallel judgements already in flight',
  '  a run that wrote no run.json (before the material-claims rubric) needs --app (its business information) and --personas, and --today where its calls have no day',
  '  a judge whose price is not known is refused. The keys: from the environment, then the repository\'s .env; never printed. Refused in CI.',
].join('\n');

export interface RejudgeIo extends EvalIo {
  /** The judge in place of the one its spec names (tests). */
  judge?: (spec: string) => ConverseModel;
}

const DEFAULT_JUDGE = 'anthropic:claude-sonnet-5-5';
const RESULTS = 'results.jsonl';
const OUT = 'rejudged';

const readJsonl = (file: string): RunRecord[] => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as RunRecord) : []);

/** The results folders under `dir`: itself when it holds results.jsonl, else each folder in it that does. */
function resultFolders(dir: string): string[] {
  if (existsSync(join(dir, RESULTS))) return [dir];
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return [];
  }
  return names.filter((name) => name !== OUT).map((name) => join(dir, name)).filter((d) => existsSync(join(d, RESULTS)));
}

/** The words a summary.md of the run printed for its line, caller and decision model (a run with no run.json). */
function headerOf(dir: string): Partial<StoredRun> {
  const file = join(dir, 'summary.md');
  if (!existsSync(file)) return {};
  const m = /Line: (.+?)\. Caller: (.+?)\. Judge: .+?\. Decision model: (.+?)\. Spent/.exec(readFileSync(file, 'utf8'));
  return m ? { lineModel: m[1]!, callerModel: m[2]!, decisionClient: m[3]! } : {};
}

/** A run with no run.json, from the app's folder and the personas file. */
function runFromFlags(dir: string, appDir: string, personasFile: string): StoredRun {
  const yaml = parse(readFileSync(join(appDir, 'app.yaml'), 'utf8')) as { id?: unknown } | null;
  const agentFile = join(appDir, 'agent.yaml');
  const timeoutMs = existsSync(agentFile) ? agentBusinessProblems(readFileSync(agentFile, 'utf8')).value?.model.timeoutMs : undefined;
  const personas = loadPersonas(personasFile);
  const header = headerOf(dir);
  return {
    app: typeof yaml?.id === 'string' ? yaml.id : 'unknown', business: businessTextOf(appDir), personas,
    callerModel: header.callerModel ?? 'as in the original run', decisionClient: header.decisionClient ?? 'as in the original run',
    runsPerPersona: Math.max(1, ...readJsonl(join(dir, RESULTS)).map((r) => r.run + 1)),
    ...(header.lineModel !== undefined ? { lineModel: header.lineModel } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

/** A day as the judge is told it (YYYY-MM-DD to "Wednesday, November 11, 2026"). */
function dayWords(iso: string): string {
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T12:00:00Z`));
}

const keyOf = (r: RunRecord): string => `${r.persona}#${r.run}`;

interface Rejudged {
  records: RunRecord[];
  stoppedByBudget: boolean;
}

/** Judges one results folder's calls again: those with no verdict yet in rejudged/results.jsonl. */
async function rejudgeFolder(dir: string, run: StoredRun, judge: ConverseModel, budget: Budget, parallel: number, today: string | undefined): Promise<Rejudged> {
  const stored = readJsonl(join(dir, RESULTS));
  const outDir = join(dir, OUT);
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, RESULTS);
  // A verdict the judge gave is kept; a failed one is asked again.
  const kept = new Map(readJsonl(outFile).filter((r) => !r.judged.notes.startsWith(JUDGE_FAILED)).map((r) => [keyOf(r), r]));
  writeFileSync(outFile, [...kept.values()].map((r) => JSON.stringify(r) + '\n').join(''));
  const personas = new Map(run.personas.map((p) => [p.id, p]));
  const todo = stored.filter((r) => !kept.has(keyOf(r)));
  const done: RunRecord[] = [];
  let next = 0;
  let stoppedByBudget = false;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (budget.exceeded()) {
        stoppedByBudget = true;
        return;
      }
      const r = todo[next++];
      if (r === undefined) return;
      const persona = personas.get(r.persona)!;
      // A call that was never held has nothing to judge: its verdict stands.
      const judged = r.call.turns.length === 0 ? r.judged : await judgeCall(judge, budget, run.business, persona, r.call, r.actions, { today: (r.today ?? today)! });
      const again: RunRecord = { ...r, judged, failures: [...r.failures.filter((f) => f !== JUDGE_FAILED), ...(judged.notes.startsWith(JUDGE_FAILED) ? [JUDGE_FAILED] : [])] };
      done.push(again);
      writeFileSync(outFile, JSON.stringify(again) + '\n', { flag: 'a' });
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));
  const order = new Map(stored.map((r, i) => [keyOf(r), i]));
  const records = [...kept.values(), ...done].sort((a, b) => (order.get(keyOf(a)) ?? 0) - (order.get(keyOf(b)) ?? 0));
  return { records, stoppedByBudget: stoppedByBudget || records.length < stored.length };
}

/** A line's model as a summary names it ("inception:mercury-3 (effort minimal)") as a candidate. */
function candidateOf(line: string | undefined): { model: string; effort?: CandidateResult['effort'] } {
  const m = /^(\S+)(?: \((?:effort (\w+)|(no effort sent))\))?$/.exec(line ?? '');
  if (m === null) return { model: line ?? 'unknown' };
  if (m[3] !== undefined) return { model: m[1]!, effort: null };
  const effort = m[2] !== undefined ? effortArg(m[2]) : undefined;
  return { model: m[1]!, ...(effort !== undefined ? { effort } : {}) };
}

/** Re-judges stored runs; returns the exit code (2: a command line it does not understand, or CI; 1: a failure before any judgement). */
export async function rejudgeCommand(argv: readonly string[], io: RejudgeIo): Promise<number> {
  if (inCi(io.env ?? process.env)) {
    io.err('dialogwright eval:rejudge: refused in CI (CI is set): it asks a real model with your own key, so it is a person\'s step');
    return 2;
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        judge: { type: 'string', default: DEFAULT_JUDGE },
        budget: { type: 'string', default: '10' },
        parallel: { type: 'string', default: '4' },
        app: { type: 'string' },
        personas: { type: 'string' },
        today: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (e) {
    io.err(`dialogwright eval:rejudge: ${e instanceof Error ? e.message : String(e)}\n${REJUDGE_USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.out(REJUDGE_USAGE);
    return 0;
  }
  const budgetUsd = Number(values.budget);
  const parallel = Number(values.parallel);
  if (positionals.length !== 1 || !(budgetUsd > 0) || !Number.isInteger(parallel) || parallel < 1) {
    io.err(`dialogwright eval:rejudge: give the results folder, a --budget above 0 and a whole --parallel of at least 1\n${REJUDGE_USAGE}`);
    return 2;
  }
  if (values.today !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(values.today)) {
    io.err(`dialogwright eval:rejudge: --today is a date, YYYY-MM-DD\n${REJUDGE_USAGE}`);
    return 2;
  }
  const spec = values.judge!;
  if (costUsd(spec, { inputTokens: 1, outputTokens: 1 }) === null) {
    io.err(`dialogwright eval:rejudge: no price is known for the judge model ${spec}, so the budget would under-count it: add its price (converse/model/price.ts)`);
    return 2;
  }
  const root = resolve(io.invokedFrom, positionals[0]!);
  const folders = resultFolders(root);
  if (folders.length === 0) {
    io.err(`dialogwright eval:rejudge: ${positionals[0]} holds no ${RESULTS}, nor any folder that does`);
    return 2;
  }
  const today = values.today !== undefined ? dayWords(values.today) : undefined;
  const runs = new Map<string, StoredRun>();
  for (const dir of folders) {
    let run = readRunInfo(dir);
    if (run === null) {
      if (values.app === undefined || values.personas === undefined) {
        io.err(`dialogwright eval:rejudge: ${dir} has no run.json: give --app <dir> and --personas <file> (the app's business information and the personas its calls were made with)`);
        return 2;
      }
      try {
        run = runFromFlags(dir, resolve(io.invokedFrom, values.app), resolve(io.invokedFrom, values.personas));
      } catch (e) {
        io.err(`dialogwright eval:rejudge: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }
    }
    const records = readJsonl(join(dir, RESULTS));
    const unknown = records.find((r) => !run.personas.some((p) => p.id === r.persona));
    if (unknown !== undefined) {
      io.err(`dialogwright eval:rejudge: ${dir}: the persona "${unknown.persona}" is not among the run's personas`);
      return 1;
    }
    if (today === undefined && records.some((r) => r.today === undefined && r.call.turns.length > 0)) {
      io.err(`dialogwright eval:rejudge: ${dir}: its calls do not say the day they took place: give --today YYYY-MM-DD, the day where the business is`);
      return 2;
    }
    runs.set(dir, run);
  }
  let judge: ConverseModel;
  try {
    judge = io.judge?.(spec) ?? resolveConverseModel(spec, envOf(io, root));
  } catch (e) {
    io.err(`dialogwright eval:rejudge: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const budget = new Budget(budgetUsd, (l) => io.err(l));
  const candidates: CandidateResult[] = [];
  for (const dir of folders) {
    const run = runs.get(dir)!;
    const before = budget.spent();
    io.out(`re-judging ${dir} with ${spec}; spent so far $${budget.spent().toFixed(2)} of $${budgetUsd.toFixed(2)}`);
    const out = await rejudgeFolder(dir, run, judge, budget, parallel, today);
    const timing = run.timeoutMs !== undefined ? { timeoutMs: run.timeoutMs } : {};
    const limits = [
      'The verdicts were given again from the stored calls: the latencies, timeouts and costs are the original run\'s, and the caller\'s words are the ones the original run heard.',
      'The judge is a model: its reading is a judgement, not a guarantee.',
      ...(out.stoppedByBudget ? [`The re-judge stopped when the budget was spent, with ${out.records.length} calls judged: run it again to go on.`] : []),
    ];
    const text = summaryMarkdown(out.records, {
      app: run.app, callerModel: run.callerModel, judgeModel: judge.id, decisionClient: run.decisionClient, runsPerPersona: run.runsPerPersona,
      spentUsd: budget.spent() - before, budgetUsd, stoppedByBudget: out.stoppedByBudget, limits, rejudged: true,
      ...(run.lineModel !== undefined ? { lineModel: run.lineModel } : {}), ...(run.timeoutMs !== undefined ? { timeoutMs: run.timeoutMs } : {}), ...(run.opener !== undefined ? { opener: run.opener } : {}),
    });
    writeFileSync(join(dir, OUT, 'summary.md'), text);
    const c = candidateOf(run.lineModel);
    const summary = summarize(out.records, timing);
    candidates.push({ ...c, summary, price: priceOf(c.model), cleared: !out.stoppedByBudget && clears(summary, DEFAULT_BARS), ...(out.stoppedByBudget ? { stoppedByBudget: true } : {}) });
  }
  if (folders.length > 1 || folders[0] !== root) {
    // A comparison: its table again, in the order the original table gave the candidates.
    const original = existsSync(join(root, 'comparison.md')) ? readFileSync(join(root, 'comparison.md'), 'utf8') : '';
    const at = (c: CandidateResult): number => {
      const i = original.indexOf(`| ${c.model}`);
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    candidates.sort((a, b) => at(a) - at(b));
    const runsPerPersona = Math.max(...[...runs.values()].map((r) => r.runsPerPersona));
    const table = compareMarkdown(candidates, {
      app: [...runs.values()][0]!.app, bars: DEFAULT_BARS, spentUsd: budget.spent(), budgetUsd, runsPerPersona,
      note: `Re-judged by ${judge.id} from the stored calls under the material-claims rubric: the spend is the judge's alone, no call was made again, and the latencies, timeouts and agent costs are the original runs'.`,
    });
    mkdirSync(join(root, OUT), { recursive: true });
    writeFileSync(join(root, OUT, 'comparison.md'), table);
    io.out(table);
  } else {
    io.out(readFileSync(join(root, OUT, 'summary.md'), 'utf8'));
  }
  io.out(`spent $${budget.spent().toFixed(4)} of $${budgetUsd.toFixed(2)}`);
  return 0;
}
