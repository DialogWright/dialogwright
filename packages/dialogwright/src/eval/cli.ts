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
import { loadConfig } from '../server/config';
import { readEnvFile } from '../server/envFile';
import { startServer } from '../server/index';
import { Budget } from './budget';
import { modelCaller } from './caller';
import { driveChat, type SimCall } from './chatDriver';
import { actionsOfCall, agentCostOfCall, JUDGE_FAILED, judgeCall, type Judged } from './judge';
import { loadPersonas, type Persona } from './personas';
import { appendResult, writeSummary, type RunRecord } from './report';

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
  'usage: dialogwright eval <app dir> --personas <file> [--runs N] [--caller anthropic:<model>] [--judge anthropic:<model>] [--budget <usd>] [--out <dir>] [--port N] [--parallel N] [--allow-unpriced] [--stub-decision]',
  '  starts the app\'s server in this process (a temporary audit and trace folder, no text sent) and drives each persona --runs times over the chat wire,',
  '  a model playing the caller and a model judging the call; writes results.jsonl and summary.md into --out (default eval-results/<timestamp>/) and prints the summary',
  '  defaults: --runs 5, --caller anthropic:claude-haiku-5-5, --judge anthropic:claude-haiku-5-5, --budget 5 (US dollars; the run stops, keeping what it has, once it is spent)',
  '  a caller or judge model whose price is not known is refused, since the budget would under-count it, unless --allow-unpriced',
  '  the decision model (TYPESAFE_API_KEY) is required, as on a real line; --stub-decision runs with the heuristic stub instead, and the summary says so',
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
const DEFAULT_JUDGE = 'anthropic:claude-haiku-5-5';
const CHAT_ORIGIN = 'https://eval.example.com';
const MAX_TURNS = 14;
const TURN_TIMEOUT_MS = 30_000;

const failedJudgement = (notes: string): Judged => ({ completed: false, correct: false, unsupportedClaims: [], honestWhenAsked: null, repeatedQuestions: 0, notes });

function envOf(io: EvalIo, appDir: string): Record<string, string | undefined> {
  if (io.env) return { ...io.env };
  const read = (file: string): Record<string, string> => (existsSync(file) ? readEnvFile(file) : {});
  return { ...read(join(REPO_ROOT, '.env')), ...read(join(appDir, '.env')), ...process.env };
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
        budget: { type: 'string', default: '5' },
        out: { type: 'string' },
        port: { type: 'string', default: '0' },
        parallel: { type: 'string', default: '1' },
        'allow-unpriced': { type: 'boolean', default: false },
        'stub-decision': { type: 'boolean', default: false },
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
  for (const [flag, spec] of [['caller', values.caller!], ['judge', values.judge!]] as const) {
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
  const decision = values['stub-decision'] ? 'stub' : 'jev';
  if (decision === 'jev' && !env.TYPESAFE_API_KEY) {
    io.err('dialogwright eval: TYPESAFE_API_KEY is unset, so the decision model would not be the real one: set it, or pass --stub-decision to run with the stub (the summary says which ran)');
    return 1;
  }
  const outDir = resolve(io.invokedFrom, values.out ?? join('eval-results', new Date().toISOString().replace(/[:.]/g, '-')));
  const work = mkdtempSync(join(tmpdir(), 'dialogwright-eval-'));
  const auditDir = join(work, 'audit');
  const traceDir = join(work, 'traces');
  // Texts go to a fake sender: the real texting path runs (and is audited), and nothing is sent.
  const serverEnv: Record<string, string | undefined> = { ...env };
  Object.assign(serverEnv, {
    PUBLIC_HOST: 'localhost', VOICE_PROVIDERS: 'none', CHAT: 'on', CHAT_ALLOWED_ORIGINS: CHAT_ORIGIN, PORT: String(port),
    TRACE_DIR: traceDir, AUDIT_DIR: auditDir, AUDIO_DIR: work, DASHBOARD: 'off', JEV_CLIENT: decision,
    TEXT_FROM: '+15555550100', TWILIO_ACCOUNT_SID: `AC${'0'.repeat(32)}`, TWILIO_AUTH_TOKEN: 'eval-not-a-token',
  });
  let running;
  try {
    running = await startServer(loadConfig(serverEnv), { host: '127.0.0.1', log: () => {}, env: serverEnv, textProvider: fakeTextProvider() });
  } catch (e) {
    rmSync(work, { recursive: true, force: true });
    io.err(`dialogwright eval: the app's server did not start: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  // The business the judge holds the line to: an agent-mode app's business.yaml, or a converse app's agent.yaml.
  const businessFile = [join(appDir, 'business.yaml'), join(appDir, 'agent.yaml')].find((f) => existsSync(f));
  const businessText = businessFile !== undefined ? readFileSync(businessFile, 'utf8') : '(this app has no business.yaml or agent.yaml: judge by what its own answers say)';
  const spend = new Budget(budgetUsd, (l) => io.err(l));
  const caller = modelCaller(callerModel, spend);
  const url = `ws://127.0.0.1:${running.port}/chat`;
  const records: RunRecord[] = [];
  const plan = personas.flatMap((p) => Array.from({ length: runs }, (_, run) => ({ p, run })));
  let nextJob = 0;
  let stoppedByBudget = false;
  const oneCall = async (p: Persona, run: number): Promise<RunRecord> => {
    const failures: string[] = [];
    let call: SimCall = { persona: p.id, turns: [], ended: 'line', firstWordMs: [] };
    try {
      call = await driveChat({ url, persona: p, caller, maxTurns: MAX_TURNS, timeoutMs: TURN_TIMEOUT_MS, origin: CHAT_ORIGIN });
    } catch (e) {
      failures.push(`call failed: ${e instanceof Error ? e.message.slice(0, 120) : 'error'}`);
    }
    if (call.ended === 'turns') failures.push('turn limit');
    if (call.turns.length > 0 && call.turns.every((t) => t.who === 'caller')) failures.push('the line never spoke');
    const callId = call.callId ?? '';
    const actions = callId === '' ? [] : actionsOfCall(auditDir, callId);
    const judged = call.turns.length === 0 ? failedJudgement('no call was held') : await judgeCall(judgeModel, spend, businessText, p, call, actions);
    if (judged.notes.startsWith(JUDGE_FAILED)) failures.push(JUDGE_FAILED);
    return { persona: p.id, run, call, judged, actions, agentCostUsd: callId === '' ? null : agentCostOfCall(traceDir, callId), failures };
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
      appendResult(outDir, r);
    }
  };
  try {
    await Promise.all(Array.from({ length: parallel }, worker));
  } finally {
    await running.close();
    rmSync(work, { recursive: true, force: true });
  }
  const limits = [
    'The chat carries no caller number, so a persona who would be recognized by the number they call from can only name who they are; a booking that needs the number recognized is not reachable here.',
    'A reply is every line the server says until 2 s pass with none (the chat wire has no end-of-turn marker), so a filler followed by an answer slower than that is split across two caller turns.',
    'The caller and the judge are models: the judge\'s reading is a judgement, not a guarantee.',
    ...(stoppedByBudget ? [`The run stopped when the budget was spent, after ${records.length} of ${plan.length} planned calls.`] : []),
  ];
  const text = writeSummary(outDir, records, { app: app.id, callerModel: callerModel.id, decisionClient: decision === 'jev' ? 'the real decision model (Jev)' : 'the heuristic stub', judgeModel: judgeModel.id, runsPerPersona: runs, spentUsd: spend.spent(), budgetUsd, stoppedByBudget, limits });
  io.out(text);
  io.out(`results: ${outDir}`);
  return 0;
}
