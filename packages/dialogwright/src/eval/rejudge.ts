import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
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
import { hasVerdict, JUDGE_FAILED, judgeCall, notJudged, parseVerdict, type Judged } from './judge';
import { summarize } from './measures';
import { loadPersonas } from './personas';
import { judgedBy, JUDGE_INPUTS, readRunInfo, summaryMarkdown, withheldNames, writeJudgeInput, type RunRecord, type StoredRun } from './report';

/**
 * eval:rejudge: a run's stored calls (results.jsonl: each transcript with the actions the gate decided and
 * what came back, and the day it took place) judged again, under the judge's current rubric (the material
 * claims, judge.ts), with no call made again. Each results folder gets rejudged/results.jsonl and
 * rejudged/summary.md beside it; a comparison's folder (one results folder per candidate) also gets
 * rejudged/comparison.md, the table again. A verdict already given is kept, so a re-judge stopped by its
 * budget goes on where it stopped.
 *
 * With no judge model (the maintainer, 2026-11-11: judging simulated calls is development work, done by the
 * assistant in its own session): --inputs writes each call's judge input, exactly what the judge model would
 * be given, and --verdicts reads the verdicts given from them, a verdicts file of one line per call, each
 * held to the same shape as the judge model's (parseVerdict), into rejudged/ as a model's re-judge writes it.
 */

export const REJUDGE_USAGE = [
  'usage: dialogwright eval:rejudge <results dir> [--judge anthropic:<model> | --inputs | --verdicts <file.jsonl> [--judged-by <words>]] [--budget <usd>] [--parallel N] [--app <dir> --personas <file>] [--today YYYY-MM-DD] [--publish]',
  '  the calls stored in <results dir>/results.jsonl (or in each folder of a comparison) judged again under the material-claims rubric, with no call made again;',
  '  writes rejudged/results.jsonl and rejudged/summary.md beside each, and for a comparison rejudged/comparison.md, the table under the material-claims bar',
  '  --judge: a judge model (default anthropic:claude-sonnet-5-5; none is refused here: use --inputs, then --verdicts); --budget 10 (US dollars, for a judge model only; it stops, keeping what it judged, once spent: run it again to go on), --parallel 4',
  '  the budget is checked before each call is judged, so the spend may pass it by up to --parallel judgements already in flight',
  '  --inputs: no model; writes each call\'s judge input (exactly what the judge model is given: its instructions, the verdict\'s JSON schema and the call) into judge-inputs/<persona>-<run>.md beside results.jsonl, for judging by hand',
  '  --verdicts <file.jsonl>: no model; one line per call, {"persona": "<id>", "run": <n>, "folder": "<results folder, for a comparison>", "verdict": {...the verdict tool\'s arguments...}}, each held to the judge\'s own shape;',
  '    a line that fails is reported with its reason and what became of its call (a verdict already in rejudged/ kept, else none yet) (exit 1); --judged-by names who judged (default "by hand"), kept on each verdict it gives. A verdict already in rejudged/ is kept, with its own judge, unless a line gives the call another',
  '  a run that wrote no run.json (before the material-claims rubric) needs --app (its business information) and --personas, and --today where its calls have no day',
  '  --publish writes each rejudged/summary.md as a page to commit: no per-call notes, each material claim by its sentence alone, the personas\' names and phone numbers withheld',
  '  a judge whose price is not known is refused. The keys: from the environment, then the repository\'s .env; never printed. A judge model is refused in CI; --inputs and --verdicts ask no model and run anywhere.',
].join('\n');

export interface RejudgeIo extends EvalIo {
  /** The judge in place of the one its spec names (tests). */
  judge?: (spec: string) => ConverseModel;
}

const DEFAULT_JUDGE = 'anthropic:claude-sonnet-5-5';
const BY_HAND = 'by hand';
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
  return names.filter((name) => name !== OUT && name !== JUDGE_INPUTS).map((name) => join(dir, name)).filter((d) => existsSync(join(d, RESULTS)));
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

const keyOf = (r: Pick<RunRecord, 'persona' | 'run'>): string => `${r.persona}#${r.run}`;

interface Rejudged {
  records: RunRecord[];
  stoppedByBudget: boolean;
}

/**
 * A stored call with its new verdict, and who gave it (`by`: a judge model's id, or the words --judged-by
 * gave); a judge failure is the one failure that changes with it. With no `by`, the call keeps no judge of
 * this re-judge (a call never held, or one still waiting).
 */
const withVerdict = (r: RunRecord, judged: Judged, by?: string): RunRecord => {
  const { judgedBy: _, ...rest } = r;
  return { ...rest, judged, failures: [...r.failures.filter((f) => f !== JUDGE_FAILED), ...(judged.notes.startsWith(JUDGE_FAILED) ? [JUDGE_FAILED] : [])], ...(by !== undefined ? { judgedBy: by } : {}) };
};

/** What a verdict kept from an earlier re-judge written before each verdict named its judge is called. */
const EARLIER_JUDGE = 'an earlier re-judge';

/**
 * Who judged a folder's calls, as a page names them: the one judge's name as it is, or each judge by
 * judgedBy ("by hand and by anthropic:..."), in the order their calls come. `current`: this re-judge's.
 */
function judgesOf(records: readonly RunRecord[], current: string): string {
  const names = [...new Set(records.filter((r) => hasVerdict(r.judged)).map((r) => r.judgedBy ?? EARLIER_JUDGE))];
  if (names.length === 0) return current;
  return names.length === 1 ? names[0]! : names.map(judgedBy).join(' and ');
}

/** The verdicts already in a folder's rejudged/results.jsonl: those given, not a failed one nor one still waiting. */
const keptVerdicts = (outFile: string): Map<string, RunRecord> => new Map(readJsonl(outFile).filter((r) => hasVerdict(r.judged)).map((r) => [keyOf(r), r]));

/** Judges one results folder's calls again: those with no verdict yet in rejudged/results.jsonl. */
async function rejudgeFolder(dir: string, run: StoredRun, judge: ConverseModel, budget: Budget, parallel: number, today: string | undefined): Promise<Rejudged> {
  const stored = readJsonl(join(dir, RESULTS));
  const outDir = join(dir, OUT);
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, RESULTS);
  // A verdict the judge gave is kept; a failed one, or one still waiting, is asked again.
  const kept = keptVerdicts(outFile);
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
      const held = r.call.turns.length > 0;
      const judged = held ? await judgeCall(judge, budget, run.business, persona, r.call, r.actions, { today: (r.today ?? today)! }) : r.judged;
      const again = withVerdict(r, judged, held ? judge.id : undefined);
      done.push(again);
      writeFileSync(outFile, JSON.stringify(again) + '\n', { flag: 'a' });
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));
  const order = new Map(stored.map((r, i) => [keyOf(r), i]));
  const records = [...kept.values(), ...done].sort((a, b) => (order.get(keyOf(a)) ?? 0) - (order.get(keyOf(b)) ?? 0));
  return { records, stoppedByBudget: stoppedByBudget || records.length < stored.length };
}

/**
 * One results folder's calls with the verdicts a verdicts file gave (`given`, by persona and run): a call it
 * gives none keeps a verdict already in rejudged/, else waits for one (a call never held keeps its own, as a
 * model's re-judge leaves it). Written whole, in the stored order.
 */
function verdictsFolder(dir: string, given: ReadonlyMap<string, Judged>, by: string): Rejudged {
  const stored = readJsonl(join(dir, RESULTS));
  const outDir = join(dir, OUT);
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, RESULTS);
  const kept = keptVerdicts(outFile);
  const records = stored.map((r) => {
    const v = given.get(keyOf(r));
    if (v !== undefined) return withVerdict(r, v, by);
    return kept.get(keyOf(r)) ?? withVerdict(r, r.call.turns.length === 0 ? r.judged : notJudged());
  });
  writeFileSync(outFile, records.map((r) => JSON.stringify(r) + '\n').join(''));
  return { records, stoppedByBudget: false };
}

/** A verdicts line that failed: its reason, and the call it names where it names one it could find. */
interface FailedLine {
  text: string;
  call?: { dir: string; key: string };
}

/**
 * A verdicts file read against the results folders: each line's verdict by folder, then persona and run, and
 * each line that fails with its reason. A line names its folder (the folder's own name) where `folders` are a
 * comparison's.
 */
function readVerdicts(file: string, folders: readonly string[], comparison: boolean): { given: Map<string, Map<string, Judged>>; problems: FailedLine[] } {
  const given = new Map(folders.map((d) => [d, new Map<string, Judged>()]));
  const stored = new Map(folders.map((d) => [d, new Map(readJsonl(join(d, RESULTS)).map((r) => [keyOf(r), r]))]));
  const byName = new Map(folders.map((d) => [basename(d), d]));
  const problems: FailedLine[] = [];
  const fail = (text: string, call?: FailedLine['call']): void => void problems.push({ text, ...(call !== undefined ? { call } : {}) });
  readFileSync(file, 'utf8').split('\n').forEach((text, i) => {
    if (text.trim() === '') return;
    const at = `line ${i + 1}`;
    let line: unknown;
    try {
      line = JSON.parse(text);
    } catch {
      line = null;
    }
    if (line === null || typeof line !== 'object' || Array.isArray(line)) return void fail(`${at}: not a JSON object`);
    const { persona, run, folder, verdict } = line as Record<string, unknown>;
    if (typeof persona !== 'string' || typeof run !== 'number' || !Number.isInteger(run) || verdict === null || typeof verdict !== 'object' || Array.isArray(verdict)) {
      return void fail(`${at}: give "persona" (its id), "run" (a whole number, as the judge input names it) and "verdict" (the verdict tool's arguments)`);
    }
    if (folder !== undefined && typeof folder !== 'string') return void fail(`${at}: "folder" is the name of a results folder`);
    if (comparison && folder === undefined) return void fail(`${at}: name the folder (one of ${[...byName.keys()].join(', ')}): this is a comparison`);
    const dir = folder === undefined ? folders[0]! : byName.get(folder);
    if (dir === undefined) return void fail(`${at}: no results folder "${folder}" (one of ${[...byName.keys()].join(', ')})`);
    const call = stored.get(dir)!.get(keyOf({ persona, run }));
    const where = comparison ? ` in ${basename(dir)}` : '';
    if (call === undefined) return void fail(`${at}: no call of the persona "${persona.slice(0, 40)}", run ${run}${where}`);
    const label = `${at} (${persona}, run ${run}${where})`;
    if (call.call.turns.length === 0) return void fail(`${label}: that call was never held, so there is nothing to judge`);
    if (given.get(dir)!.has(keyOf(call))) return void fail(`${label}: a second verdict for the same call (the first is taken)`);
    const v = parseVerdict(verdict as Record<string, unknown>);
    if (typeof v === 'string') return void fail(`${label}: ${v}`, { dir, key: keyOf(call) });
    given.get(dir)!.set(keyOf(call), v);
  });
  return { given, problems };
}

/** A line's model as a summary names it ("inception:mercury-3 (effort minimal)") as a candidate. */
function candidateOf(line: string | undefined): { model: string; effort?: CandidateResult['effort'] } {
  const m = /^(\S+)(?: \((?:effort (\w+)|(no effort sent))\))?$/.exec(line ?? '');
  if (m === null) return { model: line ?? 'unknown' };
  if (m[3] !== undefined) return { model: m[1]!, effort: null };
  const effort = m[2] !== undefined ? effortArg(m[2]) : undefined;
  return { model: m[1]!, ...(effort !== undefined ? { effort } : {}) };
}

/**
 * Re-judges stored runs, or writes their judge inputs (--inputs), or reads verdicts given by hand
 * (--verdicts); returns the exit code (2: a command line it does not understand, or a judge model in CI;
 * 1: a failure before any judgement, or a verdicts line that failed).
 */
export async function rejudgeCommand(argv: readonly string[], io: RejudgeIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        judge: { type: 'string' },
        inputs: { type: 'boolean', default: false },
        verdicts: { type: 'string' },
        'judged-by': { type: 'string', default: BY_HAND },
        budget: { type: 'string', default: '10' },
        parallel: { type: 'string', default: '4' },
        app: { type: 'string' },
        personas: { type: 'string' },
        today: { type: 'string' },
        publish: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (e) {
    io.err(`dialogwright eval:rejudge: ${e instanceof Error ? e.message : String(e)}\n${REJUDGE_USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const modes = [values.inputs, values.verdicts !== undefined, values.judge !== undefined].filter(Boolean).length;
  const mode: 'model' | 'inputs' | 'verdicts' = values.inputs ? 'inputs' : values.verdicts !== undefined ? 'verdicts' : 'model';
  // Only a judge model is a person's step: the inputs and the verdicts ask no model.
  if (mode === 'model' && inCi(io.env ?? process.env)) {
    io.err('dialogwright eval:rejudge: refused in CI (CI is set): it asks a real model with your own key, so it is a person\'s step (--inputs and --verdicts ask none)');
    return 2;
  }
  if (values.help) {
    io.out(REJUDGE_USAGE);
    return 0;
  }
  if (modes > 1) {
    io.err(`dialogwright eval:rejudge: give one of --inputs, --verdicts and --judge\n${REJUDGE_USAGE}`);
    return 2;
  }
  if (values.judge?.trim() === 'none') {
    io.err('dialogwright eval:rejudge: --judge none asks no judge model, so there is nothing to re-judge with: write each call\'s judge input with --inputs, then give the verdicts with --verdicts <file.jsonl>');
    return 2;
  }
  // Only a judge model spends: the inputs and the verdicts need no budget, and none is checked.
  const budgetUsd = mode === 'model' ? Number(values.budget) : 0;
  const parallel = Number(values.parallel);
  if (positionals.length !== 1 || (mode === 'model' && !(budgetUsd > 0)) || !Number.isInteger(parallel) || parallel < 1) {
    io.err(`dialogwright eval:rejudge: give the results folder, ${mode === 'model' ? 'a --budget above 0 ' : ''}and a whole --parallel of at least 1\n${REJUDGE_USAGE}`);
    return 2;
  }
  if (values.today !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(values.today)) {
    io.err(`dialogwright eval:rejudge: --today is a date, YYYY-MM-DD\n${REJUDGE_USAGE}`);
    return 2;
  }
  const spec = values.judge ?? DEFAULT_JUDGE;
  if (mode === 'model' && costUsd(spec, { inputTokens: 1, outputTokens: 1 }) === null) {
    io.err(`dialogwright eval:rejudge: no price is known for the judge model ${spec}, so the budget would under-count it: add its price (converse/model/price.ts)`);
    return 2;
  }
  const root = resolve(io.invokedFrom, positionals[0]!);
  const folders = resultFolders(root);
  if (folders.length === 0) {
    io.err(`dialogwright eval:rejudge: ${positionals[0]} holds no ${RESULTS}, nor any folder that does`);
    return 2;
  }
  const comparison = folders.length > 1 || folders[0] !== root;
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
    if (today === undefined && mode !== 'verdicts' && records.some((r) => r.today === undefined && r.call.turns.length > 0)) {
      io.err(`dialogwright eval:rejudge: ${dir}: its calls do not say the day they took place: give --today YYYY-MM-DD, the day where the business is`);
      return 2;
    }
    runs.set(dir, run);
  }

  if (mode === 'inputs') {
    for (const dir of folders) {
      const run = runs.get(dir)!;
      const personas = new Map(run.personas.map((p) => [p.id, p]));
      let n = 0;
      for (const r of readJsonl(join(dir, RESULTS))) {
        if (writeJudgeInput(dir, r, run.business, personas.get(r.persona)!, { ...(today !== undefined ? { today } : {}), ...(comparison ? { folder: basename(dir) } : {}) })) n++;
      }
      io.out(`wrote ${n} judge inputs into ${join(dir, JUDGE_INPUTS)}/`);
    }
    io.out(`give the verdicts as one line per call (each judge input names its line), then: dialogwright eval:rejudge ${positionals[0]} --verdicts <file.jsonl>`);
    return 0;
  }

  const outcomes = new Map<string, Rejudged & { spentUsd: number }>();
  let judgeName: string;
  let failedLines = 0;
  /** Of the failed lines' calls, those left with no verdict. */
  let waiting = 0;
  const budget = new Budget(budgetUsd, (l) => io.err(l));
  if (mode === 'verdicts') {
    judgeName = values['judged-by']!.trim() || BY_HAND;
    const file = resolve(io.invokedFrom, values.verdicts!);
    if (!existsSync(file)) {
      io.err(`dialogwright eval:rejudge: ${values.verdicts} is not a file`);
      return 2;
    }
    const { given, problems } = readVerdicts(file, folders, comparison);
    // What became of each failed line's call: another line's verdict, an earlier one rejudged/ keeps, or none yet.
    const kept = new Map(folders.map((d) => [d, keptVerdicts(join(d, OUT, RESULTS))]));
    for (const p of problems) {
      const fate = p.call === undefined ? '' : given.get(p.call.dir)!.has(p.call.key) ? ': the call takes the verdict another line gives it' : kept.get(p.call.dir)!.has(p.call.key) ? ': the call kept its earlier verdict' : ': the call waits for a verdict';
      if (p.call !== undefined && !given.get(p.call.dir)!.has(p.call.key) && !kept.get(p.call.dir)!.has(p.call.key)) waiting += 1;
      io.err(`dialogwright eval:rejudge: ${values.verdicts} ${p.text}${fate}`);
    }
    failedLines = problems.length;
    for (const dir of folders) outcomes.set(dir, { ...verdictsFolder(dir, given.get(dir)!, judgeName), spentUsd: 0 });
  } else {
    let judge: ConverseModel;
    try {
      judge = io.judge?.(spec) ?? resolveConverseModel(spec, envOf(io, root));
    } catch (e) {
      io.err(`dialogwright eval:rejudge: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
    judgeName = judge.id;
    for (const dir of folders) {
      const before = budget.spent();
      io.out(`re-judging ${dir} with ${spec}; spent so far $${budget.spent().toFixed(2)} of $${budgetUsd.toFixed(2)}`);
      const out = await rejudgeFolder(dir, runs.get(dir)!, judge, budget, parallel, today);
      outcomes.set(dir, { ...out, spentUsd: budget.spent() - before });
    }
  }

  const candidates: CandidateResult[] = [];
  for (const dir of folders) {
    const run = runs.get(dir)!;
    const out = outcomes.get(dir)!;
    const timing = run.timeoutMs !== undefined ? { timeoutMs: run.timeoutMs } : {};
    const limits = [
      'The verdicts were given again from the stored calls: the latencies, timeouts and costs are the original run\'s, and the caller\'s words are the ones the original run heard.',
      mode === 'verdicts'
        ? `The verdicts were given ${judgedBy(judgeName)} from each call's judge input (exactly what the judge model is given), and read from a verdicts file in the judge's own shape: a reading, not a guarantee.`
        : 'The judge is a model: its reading is a judgement, not a guarantee.',
      ...(out.stoppedByBudget ? [`The re-judge stopped when the budget was spent, with ${out.records.length} calls judged: run it again to go on.`] : []),
    ];
    const text = summaryMarkdown(out.records, {
      app: run.app, callerModel: run.callerModel, judgeModel: judgesOf(out.records, judgeName), decisionClient: run.decisionClient, runsPerPersona: run.runsPerPersona,
      spentUsd: out.spentUsd, budgetUsd: mode === 'model' ? budgetUsd : null, stoppedByBudget: out.stoppedByBudget, limits, rejudged: true,
      ...(run.lineModel !== undefined ? { lineModel: run.lineModel } : {}), ...(run.timeoutMs !== undefined ? { timeoutMs: run.timeoutMs } : {}), ...(run.opener !== undefined ? { opener: run.opener } : {}),
      ...(values.publish ? { published: { withheld: withheldNames(run.personas) } } : {}),
    });
    writeFileSync(join(dir, OUT, 'summary.md'), text);
    const c = candidateOf(run.lineModel);
    const summary = summarize(out.records, timing);
    candidates.push({ ...c, summary, price: priceOf(c.model), cleared: !out.stoppedByBudget && clears(summary, DEFAULT_BARS), ...(out.stoppedByBudget ? { stoppedByBudget: true } : {}) });
  }
  if (comparison) {
    // A comparison: its table again, in the order the original table gave the candidates.
    const original = existsSync(join(root, 'comparison.md')) ? readFileSync(join(root, 'comparison.md'), 'utf8') : '';
    const at = (c: CandidateResult): number => {
      const i = original.indexOf(`| ${c.model}`);
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    candidates.sort((a, b) => at(a) - at(b));
    const runsPerPersona = Math.max(...[...runs.values()].map((r) => r.runsPerPersona));
    const table = compareMarkdown(candidates, {
      app: [...runs.values()][0]!.app, bars: DEFAULT_BARS, spentUsd: budget.spent(), budgetUsd: mode === 'model' ? budgetUsd : null, runsPerPersona,
      note: `Re-judged ${judgedBy(judgesOf([...outcomes.values()].flatMap((o) => o.records), judgeName))} from the stored calls under the material-claims rubric: the spend is the judge's alone, no call was made again, and the latencies, timeouts and agent costs are the original runs'.`,
    });
    mkdirSync(join(root, OUT), { recursive: true });
    writeFileSync(join(root, OUT, 'comparison.md'), table);
    io.out(table);
  } else {
    io.out(readFileSync(join(root, OUT, 'summary.md'), 'utf8'));
  }
  if (mode === 'model') io.out(`spent $${budget.spent().toFixed(4)} of $${budgetUsd.toFixed(2)}`);
  if (failedLines > 0) {
    io.err(`dialogwright eval:rejudge: ${failedLines} line${failedLines === 1 ? '' : 's'} of ${values.verdicts} failed${waiting > 0 ? `: ${waiting} call${waiting === 1 ? '' : 's'} with no verdict wait${waiting === 1 ? 's' : ''} for one` : ''}`);
    return 1;
  }
  return 0;
}
