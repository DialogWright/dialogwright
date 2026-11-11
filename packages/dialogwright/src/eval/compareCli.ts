import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isConverseApp } from '../converse/app';
import { costUsd } from '../converse/model/price';
import { resolveConverseModel } from '../converse/model/resolve';
import type { ConverseModel } from '../converse/model/types';
import { inCi } from '../define/ci';
import type { HostedApp } from '../server/host';
import { Budget } from './budget';
import { envOf, NO_JUDGE, registerFolderApp, runEval, type EvalIo } from './cli';
import { compareMarkdown, compareModels, DEFAULT_BARS, parseCandidate, type CandidateResult } from './compare';
import { loadPersonas, type Persona } from './personas';

export const COMPARE_USAGE = [
  'usage: dialogwright eval:compare <app dir> --personas <file> --candidates <model>[#<effort>],... [--expensive <model>[#<effort>],...] [--runs N] [--budget <usd>] [--reference] [--reference-runs N] [--caller anthropic:<model>] [--judge anthropic:<model> | none] [--parallel N] [--out <dir>] [--stub-decision] [--publish]',
  '  a converse app\'s models compared on its simulated callers (pnpm eval for each), cheapest first: --candidates in the order given, then --expensive only if none cleared the bars',
  `  the bars: first sentence median <= ${DEFAULT_BARS.firstWordMsMedian} ms, p95 <= ${DEFAULT_BARS.firstWordMsP95} ms; timeouts <= ${DEFAULT_BARS.timeoutRate * 100}% of turns; cooperative calls done correctly >= ${DEFAULT_BARS.correctRate * 100}%; contradicted material claims (a price, a time, a policy that commits the business, a thing said to be done, that the business information or the call\'s own actions and results say otherwise of) <= ${DEFAULT_BARS.unsupportedClaims}; gaps in the business information are listed beside them, not counted`,
  '  once one clears every bar the rest are not run; --reference runs the expensive group at --reference-runs (default 1) per persona if the budget left exceeds its estimate',
  '  #<effort> after a model: minimal, low, medium, high, or none (none sent); without it, agent.yaml\'s. An OpenRouter model may pin its hosts: openrouter:<vendor>/<model>@<host>',
  '  defaults: --runs 5, --caller anthropic:claude-haiku-5-5, --judge anthropic:claude-sonnet-5-5, --budget 45 (US dollars for the caller, the judge and every candidate, shared; the comparison stops once it is spent), --parallel 1',
  '  a candidate whose price is not known (converse/model/price.ts) is skipped, since the budget would under-count it',
  '  --judge none: no judge model is asked; each call waits for its verdict with its judge input beside it (<out>/<model>/judge-inputs/), so no candidate can clear before it is judged and every candidate runs, within the budget; dialogwright eval:rejudge <out> --verdicts <file> then gives the verdicts and the table',
  '  writes each candidate\'s results into <out>/<model>/ and the table into <out>/comparison.md; --publish writes each candidate\'s summary.md as a page to commit (no per-call notes, names and numbers withheld). Refused in CI.',
].join('\n');

const slug = (model: string): string => model.replace(/[^A-Za-z0-9.-]+/g, '_');

/** Runs the comparison; returns the exit code (2: a command line it does not understand, or CI; 1: a failure before any call). */
export async function compareCommand(argv: readonly string[], io: EvalIo): Promise<number> {
  if (inCi(io.env ?? process.env)) {
    io.err('dialogwright eval:compare: refused in CI (CI is set): it asks real models with your own keys, so it is a person\'s step');
    return 2;
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        personas: { type: 'string' },
        candidates: { type: 'string' },
        expensive: { type: 'string', default: '' },
        runs: { type: 'string', default: '5' },
        budget: { type: 'string', default: '45' },
        reference: { type: 'boolean', default: false },
        'reference-runs': { type: 'string', default: '1' },
        caller: { type: 'string', default: 'anthropic:claude-haiku-5-5' },
        judge: { type: 'string', default: 'anthropic:claude-sonnet-5-5' },
        parallel: { type: 'string', default: '1' },
        out: { type: 'string' },
        'stub-decision': { type: 'boolean', default: false },
        publish: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (e) {
    io.err(`dialogwright eval:compare: ${e instanceof Error ? e.message : String(e)}\n${COMPARE_USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.out(COMPARE_USAGE);
    return 0;
  }
  const list = (v: string | undefined): string[] => (v ?? '').split(',').map((x) => x.trim()).filter((x) => x !== '');
  const candidates = list(values.candidates);
  const expensive = list(values.expensive);
  const whole = (v: string, min: number): number | null => (Number.isInteger(Number(v)) && Number(v) >= min ? Number(v) : null);
  const runs = whole(values.runs!, 1);
  const referenceRuns = whole(values['reference-runs']!, 1);
  const parallel = whole(values.parallel!, 1);
  const budgetUsd = Number(values.budget);
  if (positionals.length !== 1 || values.personas === undefined || candidates.length === 0 || runs === null || referenceRuns === null || parallel === null || !(budgetUsd > 0)) {
    io.err(`dialogwright eval:compare: give the app folder, --personas <file> and --candidates, with whole numbers for --runs, --reference-runs and --parallel and a --budget above 0\n${COMPARE_USAGE}`);
    return 2;
  }
  try {
    [...candidates, ...expensive].forEach(parseCandidate);
  } catch (e) {
    io.err(`dialogwright eval:compare: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  const noJudge = values.judge === NO_JUDGE;
  for (const [flag, spec] of [['caller', values.caller!], ...(noJudge ? [] : [['judge', values.judge!] as const])] as const) {
    if (costUsd(spec, { inputTokens: 1, outputTokens: 1 }) === null) {
      io.err(`dialogwright eval:compare: no price is known for the ${flag} model ${spec}, so the budget would under-count it: add its price (converse/model/price.ts)`);
      return 2;
    }
  }
  const appDir = resolve(io.invokedFrom, positionals[0]!);
  if (!existsSync(join(appDir, 'app.yaml'))) {
    io.err(`dialogwright eval:compare: ${positionals[0]} is not an app folder (it has no app.yaml)`);
    return 2;
  }
  let personas: Persona[];
  let app: HostedApp;
  let callerModel: ConverseModel;
  let judgeModel: ConverseModel | null;
  const env = envOf(io, appDir);
  try {
    personas = loadPersonas(resolve(io.invokedFrom, values.personas));
    callerModel = resolveConverseModel(values.caller!, env);
    judgeModel = noJudge ? null : resolveConverseModel(values.judge!, env);
    app = await registerFolderApp(appDir);
  } catch (e) {
    io.err(`dialogwright eval:compare: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  if (!isConverseApp(app)) {
    io.err('dialogwright eval:compare: the comparison is for a converse app (app.yaml mode: converse), whose agent.yaml names its model');
    return 2;
  }
  // Every candidate's key, before anything is spent: a missing one stops the comparison here, never halfway.
  try {
    for (const spec of [...candidates, ...expensive]) resolveConverseModel(parseCandidate(spec).model, env);
  } catch (e) {
    io.err(`dialogwright eval:compare: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const decision = values['stub-decision'] ? 'stub' : 'jev';
  if (decision === 'jev' && !env.TYPESAFE_API_KEY) {
    io.err('dialogwright eval:compare: TYPESAFE_API_KEY is unset, so the decision model would not be the real one: set it, or pass --stub-decision');
    return 1;
  }
  const outDir = resolve(io.invokedFrom, values.out ?? join('eval-results', `compare-${new Date().toISOString().replace(/[:.]/g, '-')}`));
  const budget = new Budget(budgetUsd, (l) => io.err(l));
  let results: CandidateResult[];
  try {
    results = await compareModels({
      candidates, expensive, runs, personas: personas.length, budget, bars: DEFAULT_BARS, stopWhenClear: true,
      ...(values.reference ? { reference: { runs: referenceRuns } } : {}),
      run: async (c, spend) => {
        io.out(`running ${c.model}${c.effort === null ? ' (no effort)' : c.effort ? ` (${c.effort})` : ''}: ${c.runs} per persona; spent so far $${spend.spent().toFixed(2)} of $${budgetUsd.toFixed(2)}`);
        const out = await runEval({
          appDir, app, personas, runs: c.runs, parallel, port: 0, env, callerModel, judgeModel, decision, spend, outDir: join(outDir, slug(c.model)), comparisonFolder: slug(c.model),
          model: { default: c.model, ...(c.effort !== undefined ? { effort: c.effort } : {}) },
          ...(values.publish ? { publish: true } : {}),
        });
        return { summary: out.summary, planned: out.planned, stoppedByBudget: out.stoppedByBudget };
      },
    });
  } catch (e) {
    io.err(`dialogwright eval:compare: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const text = compareMarkdown(results, { app: app.id, bars: DEFAULT_BARS, spentUsd: budget.spent(), budgetUsd, runsPerPersona: runs });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'comparison.md'), text);
  io.out(text);
  io.out(`results: ${outDir}`);
  return 0;
}
