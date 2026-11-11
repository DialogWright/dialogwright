import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import { getApp, registerApp, registerConverseApp, registeredConverseApps } from '../core/app/registry';
import { isConverseApp } from '../converse/app';
import { importApp, type HostedApp } from '../server/host';
import { costUsd } from '../converse/model/price';
import { resolveConverseModel } from '../converse/model/resolve';
import type { ConverseModel } from '../converse/model/types';
import { inCi } from '../define/ci';
import { loadFolderApp } from '../define/pageCommand';
import { REPO_ROOT } from '../define/home';
import { fakeTextProvider } from '../texts/record';
import { readEnvFile } from '../server/envFile';
import { startEvalServer, type EvalModel, type EvalServer, type EvalStyle } from './server';
import { defaultTimeZone } from '../core/localDate';
import { Budget } from './budget';
import { modelCaller } from './caller';
import { driveChat, type SimCall } from './chatDriver';
import { actionsOfCall, agentCostOfCall, JUDGE_FAILED, judgeCall, modelUseOfCall, type Judged } from './judge';
import { summarize, type RunSummary } from './measures';
import { isCooperative, loadPersonas, type Persona } from './personas';
import { appendResult, withheldNames, writeRunInfo, writeSummary, type RunRecord } from './report';
import { MODEL_EFFORTS, type ModelEffort } from '../converse/model/types';
import { OPENERS, type Opener } from '../converse/business/schema';

/**
 * The app of a folder, registered for the server this process starts: a converse app (app.yaml's mode:
 * converse), the ConverseApp its module exports for app.yaml's id, served as a host of one (its audit and
 * traces in folders of its own, which the readers below walk); else the App its module exports, as a
 * server of one serves it.
 */
export async function registerFolderApp(dir: string): Promise<HostedApp> {
  const yaml = parse(readFileSync(join(dir, 'app.yaml'), 'utf8')) as { id?: unknown; mode?: unknown } | null;
  if (yaml?.mode === 'converse') {
    if (typeof yaml.id !== 'string') throw new Error(`${dir}/app.yaml names no id`);
    const app = await importApp(dir, yaml.id);
    if (!isConverseApp(app)) throw new Error(`${dir}: app.yaml says mode: converse, but its module exports the scripted app "${app.id}"`);
    if (!registeredConverseApps().some((a) => a.id === app.id)) registerConverseApp(app);
    return app;
  }
  const app = await loadFolderApp(dir);
  try {
    return getApp(app.id);
  } catch {
    registerApp(app);
    return app;
  }
}

export const EVAL_USAGE = [
  'usage: dialogwright eval <app dir> --personas <file> [--runs N] [--caller anthropic:<model>] [--judge anthropic:<model>] [--model <provider>:<model>] [--effort minimal|low|medium|high|none] [--opener acknowledge] [--budget <usd>] [--out <dir>] [--port N] [--parallel N] [--allow-unpriced] [--stub-decision] [--publish]',
  '  starts the app\'s server in this process (a temporary audit and trace folder, no text sent) and drives each persona --runs times over the chat wire,',
  '  a model playing the caller and a model judging the call; writes results.jsonl and summary.md into --out (default eval-results/<timestamp>/) and prints the summary',
  '  writes run.json beside them too (the business text and the personas the calls were judged against), so the calls can be judged again with no call made (dialogwright eval:rejudge)',
  '  defaults: --runs 5, --caller anthropic:claude-haiku-5-5, --judge anthropic:claude-sonnet-5-5 (a cheaper one with --judge), --budget 5 (US dollars, the caller, the judge and the line\'s own model; the run stops, keeping what it has, once it is spent; it is checked before each call, so the spend may pass it by up to --parallel calls already in flight)',
  '  a converse app: --model asks that model in place of agent.yaml\'s, at --effort (default agent.yaml\'s; none sends none), and --opener asks for that opener in place of agent.yaml\'s persona.opener; each model request runs to its end (up to 30 s) so its true time is recorded, and the timeouts are worked out from it',
  '  a caller, judge or line model whose price is not known is refused, since the budget would under-count it, unless --allow-unpriced',
  '  the decision model (TYPESAFE_API_KEY) is required, as on a real line; --stub-decision runs with the heuristic stub instead, and the summary says so',
  '  --publish writes summary.md as a page to commit: no per-call notes, each material claim by its sentence alone, the personas\' names and phone numbers withheld (results.jsonl keeps every verdict whole)',
  '  the keys: from the environment, then the app\'s .env, then the repository\'s .env; never printed. Refused in CI.',
].join('\n');

export interface EvalIo {
  out(line: string): void;
  err(line: string): void;
  /** Where the command was run (pnpm's INIT_CWD): the folder, the personas file and --out are from there. */
  invokedFrom: string;
  /** The settings; default process.env with the app's and the repository's .env read under it. Given, nothing is read. */
  env?: Record<string, string | undefined>;
}

const DEFAULT_CALLER = 'anthropic:claude-haiku-5-5';
const DEFAULT_JUDGE = 'anthropic:claude-sonnet-5-5';
const CHAT_ORIGIN = 'https://eval.example.com';
const MAX_TURNS = 14;
/** How long the harness waits for the line's reply: past the model's own (eval) time, asked twice, and a turn's rounds. */
const TURN_TIMEOUT_MS = 90_000;

const failedJudgement = (notes: string): Judged => ({ completed: false, correct: false, unsupportedClaims: [], honestWhenAsked: null, repeatedQuestions: 0, notes });

export function envOf(io: Pick<EvalIo, 'env'>, appDir: string): Record<string, string | undefined> {
  if (io.env) return { ...io.env };
  const read = (file: string): Record<string, string> => (existsSync(file) ? readEnvFile(file) : {});
  return { ...read(join(REPO_ROOT, '.env')), ...read(join(appDir, '.env')), ...process.env };
}

/** What one evaluation runs: an app, its personas, the models that play and judge, and where it writes. */
export interface EvalRun {
  appDir: string;
  app: HostedApp;
  personas: Persona[];
  runs: number;
  parallel: number;
  port: number;
  /** The settings the app's server runs with (its keys among them). */
  env: Record<string, string | undefined>;
  callerModel: ConverseModel;
  judgeModel: ConverseModel;
  decision: 'jev' | 'stub';
  /** What is spent: the caller, the judge and the line's own model. Shared across runs (eval:compare). */
  spend: Budget;
  outDir: string;
  /** A converse app's model in place of agent.yaml's (eval:compare). */
  model?: EvalModel;
  /** A converse app's persona style in place of agent.yaml's (eval --opener). */
  style?: EvalStyle;
  /** summary.md as a page to commit (--publish): no per-call notes, the personas' names withheld. */
  publish?: boolean;
}

export interface EvalOutcome {
  records: RunRecord[];
  planned: number;
  stoppedByBudget: boolean;
  summary: RunSummary;
  /** The summary page, as written to summary.md. */
  text: string;
}

/** The business the judge holds the line to: an agent-mode app's business.yaml, or a converse app's agent.yaml. */
export function businessTextOf(appDir: string): string {
  const file = [join(appDir, 'business.yaml'), join(appDir, 'agent.yaml')].find((f) => existsSync(f));
  return file !== undefined ? readFileSync(file, 'utf8') : '(this app has no business.yaml or agent.yaml: judge by what its own answers say)';
}

/** The line's own model of a run: the one it names, or a converse app's agent.yaml's; null for a scripted app. */
export function lineModelOf(app: HostedApp, model?: EvalModel): string | null {
  return model?.default ?? (isConverseApp(app) ? app.business.model.default : null);
}

/**
 * Runs the evaluation: each persona `runs` times over the chat wire, a model playing the caller and a model
 * judging each call, until the plan is done or the budget is spent (the calls it has are kept); writes
 * results.jsonl and summary.md into `outDir`. Throws when the app's server does not start.
 */
export async function runEval(o: EvalRun): Promise<EvalOutcome> {
  const { app, appDir, env, spend } = o;
  const work = mkdtempSync(join(tmpdir(), 'dialogwright-eval-'));
  // Texts go to a fake sender: the real texting path runs (and is audited), and nothing is sent.
  const serverEnv: Record<string, string | undefined> = { ...env };
  Object.assign(serverEnv, {
    PUBLIC_HOST: 'localhost', VOICE_PROVIDERS: 'none', CHAT: 'on', CHAT_ALLOWED_ORIGINS: CHAT_ORIGIN, PORT: String(o.port),
    AUDIO_DIR: work, DASHBOARD: 'off', JEV_CLIENT: o.decision,
    TEXT_FROM: '+15555550100', TWILIO_ACCOUNT_SID: `AC${'0'.repeat(32)}`, TWILIO_AUTH_TOKEN: 'eval-not-a-token',
  });
  // A converse app: a server of its own for each call, on the app made fresh (eval/server.ts); a scripted app: one server for the run.
  const perCall = isConverseApp(app);
  const serverFor = (): Promise<EvalServer> => startEvalServer(app, perCall ? { ...serverEnv, PORT: '0' } : serverEnv, { work, textProvider: fakeTextProvider(), ...(o.model !== undefined ? { model: o.model } : {}), ...(o.style !== undefined ? { style: o.style } : {}) });
  let shared: EvalServer | null = null;
  try {
    if (!perCall) shared = await serverFor();
    else await (await serverFor()).close();
  } catch (e) {
    rmSync(work, { recursive: true, force: true });
    throw new Error(`the app's server did not start: ${e instanceof Error ? e.message : String(e)}`);
  }
  // The day the judge reads the line's dates against: today, where the business is (a converse app's agent.yaml time zone, else the server's).
  const zone = (isConverseApp(app) ? app.business.business.timezone : undefined) ?? env.TIMEZONE ?? (defaultTimeZone() || 'UTC');
  const todayWords = (): string => new Intl.DateTimeFormat('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: zone }).format(new Date());
  const businessText = businessTextOf(appDir);
  // The timeouts are read against the line's own model time (agent.yaml's), never the eval's long one.
  const timeoutMs = isConverseApp(app) ? app.business.model.timeoutMs : undefined;
  const lineModel = lineModelOf(app, o.model);
  const lineWords = lineModel === null ? undefined : `${lineModel}${o.model?.effort === null ? ' (no effort sent)' : o.model?.effort ? ` (effort ${o.model.effort})` : ''}`;
  const decisionClient = o.decision === 'jev' ? 'the real decision model (Jev)' : 'the heuristic stub';
  writeRunInfo(o.outDir, {
    app: app.id, business: businessText, personas: o.personas, callerModel: o.callerModel.id, decisionClient, runsPerPersona: o.runs,
    ...(lineWords !== undefined ? { lineModel: lineWords } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}), ...(o.style?.opener !== undefined ? { opener: o.style.opener } : {}),
  });
  const caller = modelCaller(o.callerModel, spend);
  const records: RunRecord[] = [];
  const plan = o.personas.flatMap((p) => Array.from({ length: o.runs }, (_, run) => ({ p, run })));
  let nextJob = 0;
  let stoppedByBudget = false;
  const oneCall = async (p: Persona, run: number): Promise<RunRecord> => {
    const failures: string[] = [];
    let call: SimCall = { persona: p.id, turns: [], ended: 'line', firstWordMs: [] };
    let server: EvalServer | null = shared;
    try {
      server ??= await serverFor();
      call = await driveChat({ url: server.url, persona: p, caller, maxTurns: MAX_TURNS, timeoutMs: TURN_TIMEOUT_MS, origin: CHAT_ORIGIN });
    } catch (e) {
      failures.push(`call failed: ${e instanceof Error ? e.message.slice(0, 120) : 'error'}`);
    } finally {
      // A call's own server closes once it is done, its records flushed for the reading below.
      if (server !== null && server !== shared) await server.close();
    }
    const auditDir = server?.auditDir ?? join(work, 'none');
    const traceDir = server?.traceDir ?? join(work, 'none');
    if (call.ended === 'turns') failures.push('turn limit');
    if (call.turns.length > 0 && call.turns.every((t) => t.who === 'caller')) failures.push('the line never spoke');
    const callId = call.callId ?? '';
    const actions = callId === '' ? [] : actionsOfCall(auditDir, callId);
    const today = todayWords();
    const judged = call.turns.length === 0 ? failedJudgement('no call was held') : await judgeCall(o.judgeModel, spend, businessText, p, call, actions, { today });
    if (judged.notes.startsWith(JUDGE_FAILED)) failures.push(JUDGE_FAILED);
    const agentCostUsd = callId === '' ? null : agentCostOfCall(traceDir, callId);
    // The line's own model is spent too: its cost, priced in its traces, counts toward the budget.
    if (agentCostUsd !== null) spend.addUsd(agentCostUsd);
    const use = callId === '' ? { turns: [], tokens: null } : modelUseOfCall(traceDir, callId);
    return { persona: p.id, run, today, call, judged, actions, agentCostUsd, failures, cooperative: isCooperative(p), turns: use.turns, agentTokens: use.tokens };
  };
  const worker = async (): Promise<void> => {
    for (;;) {
      if (spend.exceeded()) {
        stoppedByBudget = true;
        return;
      }
      const job = plan[nextJob++];
      if (job === undefined) return;
      const r = await oneCall(job.p, job.run);
      records.push(r);
      appendResult(o.outDir, r);
    }
  };
  try {
    await Promise.all(Array.from({ length: o.parallel }, worker));
  } finally {
    await shared?.close();
    rmSync(work, { recursive: true, force: true });
  }
  const limits = [
    'A chat carries a caller number only where the persona names one (callingFrom): a converse app takes it from the chat\'s context on the harness\'s own server (never a deployed setting); any other persona who would be recognized by the number they call from can only name who they are.',
    ...(perCall ? ['Each call ran on a server of its own, on the app made fresh: no call saw what another booked.'] : ['Every call ran on one server, so a later call sees what earlier ones booked.']),
    ...(timeoutMs !== undefined ? [`Each model request ran to its end (up to 30 s) and its true time was recorded; the timeouts are the turns that would have reached the line's own ${timeoutMs} ms (no first event within half of it, or not done within it), worked out from those times.`] : []),
    'The first sentence is timed from the caller\'s words being sent to the first sentence of the reply arriving over the chat (its say_delta): no speech, no network to a phone.',
    'A reply is every line the server says until 2 s pass with none (the chat wire has no end-of-turn marker), so a filler followed by an answer slower than that is split across two caller turns.',
    'The caller and the judge are models: the judge\'s reading is a judgement, not a guarantee.',
    ...(stoppedByBudget ? [`The run stopped when the budget was spent, after ${records.length} of ${plan.length} planned calls.`] : []),
  ];
  const text = writeSummary(o.outDir, records, {
    app: app.id, callerModel: o.callerModel.id, decisionClient, judgeModel: o.judgeModel.id,
    runsPerPersona: o.runs, spentUsd: spend.spent(), budgetUsd: spend.limit(), stoppedByBudget, limits,
    ...(lineWords !== undefined ? { lineModel: lineWords } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(o.style?.opener !== undefined ? { opener: o.style.opener } : {}),
    ...(o.publish === true ? { published: { withheld: withheldNames(o.personas) } } : {}),
  });
  return { records, planned: plan.length, stoppedByBudget, summary: summarize(records, timeoutMs !== undefined ? { timeoutMs } : {}), text };
}

/** An effort as a command line names it: one of MODEL_EFFORTS, or none (null: none sent). */
export function effortArg(v: string): ModelEffort | null | undefined {
  if (v === 'none') return null;
  return (MODEL_EFFORTS as readonly string[]).includes(v) ? (v as ModelEffort) : undefined;
}

/** Runs the evaluation; returns the exit code (2: a command line it does not understand, or CI; 1: a failure before any call). */
export async function evalCommand(argv: readonly string[], io: EvalIo): Promise<number> {
  const given = io.env ?? process.env;
  if (inCi(given)) {
    io.err('dialogwright eval: refused in CI (CI is set): the evaluation asks real models with your own keys, so it is a person\'s step');
    return 2;
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        personas: { type: 'string' },
        runs: { type: 'string', default: '5' },
        caller: { type: 'string', default: DEFAULT_CALLER },
        judge: { type: 'string', default: DEFAULT_JUDGE },
        model: { type: 'string' },
        effort: { type: 'string' },
        opener: { type: 'string' },
        budget: { type: 'string', default: '5' },
        out: { type: 'string' },
        port: { type: 'string', default: '0' },
        parallel: { type: 'string', default: '1' },
        'allow-unpriced': { type: 'boolean', default: false },
        'stub-decision': { type: 'boolean', default: false },
        publish: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (e) {
    io.err(`dialogwright eval: ${e instanceof Error ? e.message : String(e)}\n${EVAL_USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.out(EVAL_USAGE);
    return 0;
  }
  const whole = (name: string, v: string, min: number): number | null => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min) {
      io.err(`dialogwright eval: --${name} must be a whole number of at least ${min}\n${EVAL_USAGE}`);
      return null;
    }
    return n;
  };
  const runs = whole('runs', values.runs!, 1);
  const port = whole('port', values.port!, 0);
  const parallel = whole('parallel', values.parallel!, 1);
  const budgetUsd = Number(values.budget);
  if (runs === null || port === null || parallel === null) return 2;
  if (!(budgetUsd > 0)) {
    io.err(`dialogwright eval: --budget must be a number of US dollars above 0\n${EVAL_USAGE}`);
    return 2;
  }
  if (positionals.length !== 1 || values.personas === undefined) {
    io.err(`dialogwright eval: give the app folder and --personas <file>\n${EVAL_USAGE}`);
    return 2;
  }
  const effort = values.effort === undefined ? undefined : effortArg(values.effort);
  if (values.effort !== undefined && effort === undefined) {
    io.err(`dialogwright eval: --effort is one of ${MODEL_EFFORTS.join(', ')} or none\n${EVAL_USAGE}`);
    return 2;
  }
  if (values.opener !== undefined && !(OPENERS as readonly string[]).includes(values.opener)) {
    io.err(`dialogwright eval: --opener is one of ${OPENERS.join(', ')}\n${EVAL_USAGE}`);
    return 2;
  }
  const opener = values.opener as Opener | undefined;
  if (values.effort !== undefined && values.model === undefined) {
    io.err(`dialogwright eval: --effort goes with --model\n${EVAL_USAGE}`);
    return 2;
  }
  for (const [flag, spec] of [['caller', values.caller!], ['judge', values.judge!], ...(values.model !== undefined ? [['line', values.model] as const] : [])] as const) {
    if (costUsd(spec, { inputTokens: 1, outputTokens: 1 }) === null && !values['allow-unpriced']) {
      io.err(`dialogwright eval: no price is known for the ${flag} model ${spec}, so the budget would under-count it: add its price (converse/model/price.ts) or pass --allow-unpriced`);
      return 2;
    }
  }
  const appDir = resolve(io.invokedFrom, positionals[0]!);
  if (!existsSync(join(appDir, 'app.yaml'))) {
    io.err(`dialogwright eval: ${positionals[0]} is not an app folder (it has no app.yaml)\n${EVAL_USAGE}`);
    return 2;
  }
  let personas: Persona[];
  try {
    personas = loadPersonas(resolve(io.invokedFrom, values.personas));
  } catch (e) {
    io.err(`dialogwright eval: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const env = envOf(io, appDir);
  let callerModel: ConverseModel;
  let judgeModel: ConverseModel;
  try {
    callerModel = resolveConverseModel(values.caller!, env);
    judgeModel = resolveConverseModel(values.judge!, env);
    if (values.model !== undefined) resolveConverseModel(values.model, env);
  } catch (e) {
    io.err(`dialogwright eval: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  let app: HostedApp;
  try {
    app = await registerFolderApp(appDir);
  } catch (e) {
    io.err(`dialogwright eval: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  if ((values.model !== undefined || opener !== undefined) && !isConverseApp(app)) {
    io.err('dialogwright eval: --model and --opener are for a converse app (app.yaml mode: converse), whose agent.yaml names its model and persona');
    return 2;
  }
  const own = lineModelOf(app);
  if (values.model === undefined && own !== null && costUsd(own, { inputTokens: 1, outputTokens: 1 }) === null && !values['allow-unpriced']) {
    io.err(`dialogwright eval: no price is known for the line's model ${own}, so the budget would under-count it: add its price (converse/model/price.ts) or pass --allow-unpriced`);
    return 2;
  }
  const decision = values['stub-decision'] ? 'stub' : 'jev';
  if (decision === 'jev' && !env.TYPESAFE_API_KEY) {
    io.err('dialogwright eval: TYPESAFE_API_KEY is unset, so the decision model would not be the real one: set it, or pass --stub-decision to run with the stub (the summary says which ran)');
    return 1;
  }
  const outDir = resolve(io.invokedFrom, values.out ?? join('eval-results', new Date().toISOString().replace(/[:.]/g, '-')));
  const spend = new Budget(budgetUsd, (l) => io.err(l));
  let outcome: EvalOutcome;
  try {
    outcome = await runEval({
      appDir, app, personas, runs, parallel, port, env, callerModel, judgeModel, decision, spend, outDir,
      ...(values.model !== undefined ? { model: { default: values.model, ...(effort !== undefined ? { effort } : {}) } } : {}),
      ...(opener !== undefined ? { style: { opener } } : {}),
      ...(values.publish ? { publish: true } : {}),
    });
  } catch (e) {
    io.err(`dialogwright eval: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  io.out(outcome.text);
  io.out(`results: ${outDir}`);
  return 0;
}
