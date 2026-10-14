import { writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { inCi } from '../define/ci';
import { CassetteClient } from '../jev/cassette';
import { cassetteFileName, resolveJevProvider } from '../jev/provider';
import { SdkJevClient } from '../jev/sdkClient';
import type { JevClient } from '../jev/types';
import { loadHarnessEnv } from '../server/envFile';
import { DEFAULT_CASES_FILE, evaluateCases, formatJudgeEval, judgeEvalJson, judgeLatency, loadJudgeCases, type JudgeEvalReport } from '../render/judgeEval';

/**
 * `dialogwright render:judge-eval [--replay] [--cases <file>] [--out <file.md>] [--json]` (../render/judgeEval.ts):
 * the span drift judge measured against the span's shape checks on a set of labelled cases. Recording
 * (the default) asks the decision model, with the maintainer's own key, only what its cassette does not
 * have yet (`recorded/<model>.jsonl` beside the case file), and refuses in CI; `--replay` tables the
 * cassette alone, with no key. The settings are read as the regression reads them: the environment,
 * then the files ENV_FILE names (from where the command was run), else a `.env` there. Never prints a key.
 */

export const JUDGE_EVAL_USAGE = [
  'usage: dialogwright render:judge-eval [--replay] [--cases <file>] [--out <file.md>] [--json]',
  '  puts each case (a caller\'s message, a summary of it, labelled faithful or unfaithful) to the span\'s shape checks (full and core), the stub\'s judge and the real drift judge, and tables what each catches and wrongly refuses',
  '  --cases: a JSON Lines file of cases (default: the engine\'s, src/render/judgeCases/spans.jsonl); the judge\'s answers are kept in recorded/<model>.jsonl beside it',
  '  records what the cassette lacks with the decision model\'s key (TYPESAFE_API_KEY, or JEV_PROVIDER\'s; from the environment, ENV_FILE or a .env where it is run), refused in CI;',
  '  --replay: table the cassette alone, asking nothing; --out: also write the report as Markdown; --json: the results as JSON on stdout',
].join('\n');

export interface JudgeEvalIo {
  out(line: string): void;
  err(line: string): void;
  /** Where the command was run (pnpm's INIT_CWD): relative paths, and ENV_FILE's, are from there. */
  invokedFrom: string;
  /** The settings; default process.env with the settings file read into it. Given, nothing is read. */
  env?: Record<string, string | undefined>;
  /** Tests: the decision model that answers what the cassette lacks, in place of TypeSafe's client. */
  judge?: JevClient;
}

/** The judge's cassette for a case file: `recorded/<model>.jsonl` beside it. */
export const judgeCassettePath = (casesFile: string, model: string): string => join(dirname(casesFile), 'recorded', cassetteFileName(model));

/** Runs the measurement; returns the exit code (2: a command line it does not understand; 1: refused, a case file it cannot read, or a judge that could not answer every case). */
export async function judgeEvalCommand(argv: readonly string[], io: JudgeEvalIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: false,
      options: {
        replay: { type: 'boolean', default: false },
        cases: { type: 'string' },
        out: { type: 'string' },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (e) {
    io.err(`dialogwright render:judge-eval: ${e instanceof Error ? e.message : String(e)}\n${JUDGE_EVAL_USAGE}`);
    return 2;
  }
  const args = parsed.values;
  if (args.help) {
    io.err(JUDGE_EVAL_USAGE);
    return 0;
  }
  const replay = args.replay === true;
  const json = args.json === true;
  const say = json ? io.err : io.out;
  const casesFile = args.cases === undefined ? DEFAULT_CASES_FILE : resolve(io.invokedFrom, args.cases);
  const out = args.out === undefined ? null : resolve(io.invokedFrom, args.out);
  const shown = (path: string): string => {
    const near = relative(io.invokedFrom, path);
    return near === '' || near.startsWith('..') ? path : near;
  };

  const env = io.env ?? process.env;
  if (io.env === undefined) {
    try {
      const loaded = loadHarnessEnv(env, io.invokedFrom);
      if (loaded !== null) io.err(loaded);
    } catch (e) {
      io.err(`dialogwright render:judge-eval: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
  }
  if (!replay && inCi(env)) {
    io.err('dialogwright render:judge-eval: it does not record in CI: recording asks the decision model with your own key, on your machine; --replay tables what is recorded');
    return 1;
  }
  let jev;
  try {
    jev = resolveJevProvider(env, { needKey: !replay });
  } catch (e) {
    const m = /missing required environment variable (\S+)/.exec(e instanceof Error ? e.message : '');
    io.err(m !== null
      ? `dialogwright render:judge-eval: recording needs the decision model's key, ${m[1]}, in the environment or a settings file (ENV_FILE, or a .env where it is run); or table what is recorded with --replay`
      : `dialogwright render:judge-eval: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  let cases;
  try {
    cases = loadJudgeCases(casesFile);
  } catch (e) {
    io.err(`dialogwright render:judge-eval: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const cassette = judgeCassettePath(casesFile, jev.model);
  const answeredBy = { provider: jev.provider, model: jev.model, official: jev.official };
  // Only the requests sent to the judge are timed (a cassette hit is not): what a call would wait.
  const timings: number[] = [];
  const timed = (inner: JevClient): JevClient => ({
    ...(inner.answeredBy ? { answeredBy: inner.answeredBy } : {}),
    async ask(req) {
      const start = performance.now();
      const r = await inner.ask(req);
      timings.push(performance.now() - start);
      return r;
    },
  });
  const live = replay ? null : (io.judge ?? new SdkJevClient({ endpoint: jev, timeoutMs: 15_000 }));
  const judge = live === null
    ? new CassetteClient({ path: cassette, mode: 'replay', answeredBy })
    : new CassetteClient({ path: cassette, mode: 'record', answeredBy, inner: timed(live) });
  try {
    judge.preload();
  } catch (e) {
    io.err(`dialogwright render:judge-eval: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  // The key is never printed: any error text that carries it has it masked.
  const key = jev.apiKey;
  const redact = (s: string): string => (key !== null && key.length >= 4 ? s.split(key).join('***') : s);
  say(`${cases.length} cases from ${shown(casesFile)}; the judge ${jev.model} from ${jev.provider}, ${replay ? 'replayed from' : 'recording what is missing into'} ${shown(cassette)}`);
  // The connection opened before the first case, so the first request is not timed with its setup.
  if (live?.warm) await live.warm().catch(() => undefined);
  const results = await evaluateCases(cases, judge, { timeoutMs: 15_000, redact, progress: io.err });
  const latency = judgeLatency(timings);
  const report: JudgeEvalReport = { casesFile: shown(casesFile), model: jev.model, provider: jev.provider, replay, cassette: shown(cassette), results, ...(latency ? { latency } : {}) };
  const markdown = formatJudgeEval(report);
  if (json) io.out(judgeEvalJson(report));
  else {
    say('');
    for (const line of markdown) io.out(line);
  }
  if (out !== null) {
    writeFileSync(out, `${markdown.join('\n')}\n`);
    say(`written to ${shown(out)}`);
  }
  return results.every((r) => 'p' in r.judge) ? 0 : 1;
}
