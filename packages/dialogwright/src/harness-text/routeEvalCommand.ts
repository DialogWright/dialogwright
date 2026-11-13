import { writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { readAgentBusiness } from '../converse/business/load';
import { askRoutes, formatRouteEval, ROUTE_DEFINITIONS, latencyOf, loadRouteCalls, loadRouteLabels, routeCaseSet, scoreRoutes } from '../converse/routeEval';
import { inCi } from '../define/ci';
import { CassetteClient } from '../jev/cassette';
import { resolveJevProvider } from '../jev/provider';
import { SdkJevClient } from '../jev/sdkClient';
import type { JevClient } from '../jev/types';
import { loadHarnessEnv } from '../server/envFile';

/**
 * `dialogwright converse:route-eval <app dir> --calls <results.jsonl>... --labels <labels.jsonl> [--personas <file>] [--replay] [--out <file.md>] [--json] [--timeout-ms N]`
 * (../converse/routeEval.ts): how well the decision model routes a converse app's journeys, on caller turns a
 * person labelled. Recording (the default) asks the decision model, with the author's own key, only what the
 * cassette beside the labels file does not have yet, and refuses in CI; `--replay` reads the cassette alone,
 * with no key. Never prints a key.
 */

export const ROUTE_EVAL_USAGE = [
  'usage: dialogwright converse:route-eval <app dir> --calls <results.jsonl>... --labels <labels.jsonl> [--personas <file>] [--replay] [--out <file.md>] [--json] [--timeout-ms N]',
  '  <app dir>: the converse app (its agent.yaml gives the journeys and routing.switchAt)',
  '  --calls: the results.jsonl of one or more evaluations (dialogwright eval); a call\'s id is <folder of the file>/<persona>-<run>',
  '  --personas: the personas file of those evaluations; a call whose persona has callingFrom is a recognised account (open to the journeys for accounts), any other is not',
  '  --labels: one line per labelled caller turn: {"id": <call id>, "turn": <caller turn, 0-based>, "task": <journey id or "none">, "drops"?: true, "again"?: true, "confirms"?: <action>}; a turn labelled confirms is a yes to a read-back, never routed, and runs that action; a turn or call with no label is skipped and counted',
  ...ROUTE_DEFINITIONS.map((l) => `  ${l}`),
  '  a label whose task is neither a journey of the app nor "none" is listed by id in the report, and its call is skipped from that turn on',
  '  latency is measured on the recording run only; a --replay report has none',
  '  asks the decision model once per labelled turn (TYPESAFE_API_KEY, or JEV_PROVIDER\'s; from the environment, ENV_FILE or a .env where it is run), four at a time, into the cassette beside the labels (<labels>.jev.jsonl), asking only what it lacks; refused in CI',
  '  --replay: read the cassette alone, asking nothing; --out: also write the report as Markdown; --json: the figures as JSON on stdout; --timeout-ms: how long each request may take (default 30000)',
].join('\n');

export interface RouteEvalIo {
  out(line: string): void;
  err(line: string): void;
  /** Where the command was run (pnpm's INIT_CWD): relative paths, and ENV_FILE's, are from there. */
  invokedFrom: string;
  /** The settings; default process.env with the settings file read into it. Given, nothing is read. */
  env?: Record<string, string | undefined>;
  /** Tests: the decision model that answers what the cassette lacks, in place of TypeSafe's client. */
  judge?: JevClient;
}

/** The cassette beside a labels file: `<labels without .jsonl>.jev.jsonl`. */
export const routeCassettePath = (labelsFile: string): string => `${labelsFile.replace(/\.jsonl$/, '')}.jev.jsonl`;

const BARS = [0.4, 0.5, 0.6, 0.7, 0.8] as const;

/** Runs the measurement; returns the exit code (2: a command line it does not understand; 1: refused, a file it cannot read, or a turn the cassette could not answer). */
export async function routeEvalCommand(argv: readonly string[], io: RouteEvalIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        calls: { type: 'string', multiple: true },
        labels: { type: 'string' },
        personas: { type: 'string' },
        replay: { type: 'boolean', default: false },
        out: { type: 'string' },
        json: { type: 'boolean', default: false },
        'timeout-ms': { type: 'string', default: '30000' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (e) {
    io.err(`dialogwright converse:route-eval: ${e instanceof Error ? e.message : String(e)}\n${ROUTE_EVAL_USAGE}`);
    return 2;
  }
  const args = parsed.values;
  if (args.help) {
    io.err(ROUTE_EVAL_USAGE);
    return 0;
  }
  const timeoutMs = Number(args['timeout-ms']);
  if (parsed.positionals.length !== 1 || !args.calls?.length || args.labels === undefined || !(timeoutMs > 0)) {
    io.err(`dialogwright converse:route-eval: give an app folder, --calls and --labels (and a --timeout-ms above 0)\n${ROUTE_EVAL_USAGE}`);
    return 2;
  }
  const replay = args.replay === true;
  const json = args.json === true;
  const say = json ? io.err : io.out;
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
      io.err(`dialogwright converse:route-eval: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
  }
  if (!replay && inCi(env)) {
    io.err('dialogwright converse:route-eval: it does not record in CI: recording asks the decision model with your own key, on your machine; --replay reads what is recorded');
    return 1;
  }
  let jev;
  try {
    jev = resolveJevProvider(env, { needKey: !replay });
  } catch (e) {
    const m = /missing required environment variable (\S+)/.exec(e instanceof Error ? e.message : '');
    io.err(m !== null
      ? `dialogwright converse:route-eval: recording needs the decision model's key, ${m[1]}, in the environment or a settings file (ENV_FILE, or a .env where it is run); or read what is recorded with --replay`
      : `dialogwright converse:route-eval: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const labelsFile = resolve(io.invokedFrom, args.labels);
  let business;
  let set;
  try {
    business = readAgentBusiness(resolve(io.invokedFrom, parsed.positionals[0]!));
    if (business.journeys === undefined || Object.keys(business.journeys).length === 0) throw new Error('the app has no journeys to route');
    const calls = loadRouteCalls(args.calls.map((f) => resolve(io.invokedFrom, f)), args.personas === undefined ? undefined : resolve(io.invokedFrom, args.personas));
    set = routeCaseSet(business, calls, loadRouteLabels(labelsFile));
  } catch (e) {
    io.err(`dialogwright converse:route-eval: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const cassette = routeCassettePath(labelsFile);
  const answeredBy = { provider: jev.provider, model: jev.model, official: jev.official };
  // Only the requests sent to the model are timed (a cassette hit is not): what a call would wait.
  const timings: number[] = [];
  const timed = (inner: JevClient): JevClient => ({
    ...(inner.answeredBy ? { answeredBy: inner.answeredBy } : {}),
    async ask(req) {
      const start = performance.now();
      try {
        return await inner.ask(req);
      } finally {
        timings.push(performance.now() - start);
      }
    },
  });
  const live = replay ? null : (io.judge ?? new SdkJevClient({ endpoint: jev, timeoutMs }));
  const client = live === null
    ? new CassetteClient({ path: cassette, mode: 'replay', answeredBy })
    : new CassetteClient({ path: cassette, mode: 'record', answeredBy, inner: timed(live) });
  try {
    client.preload();
  } catch (e) {
    io.err(`dialogwright converse:route-eval: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  say(`${set.cases.length} labelled caller turns; the model ${jev.model} from ${jev.provider}, ${replay ? 'replayed from' : 'recording what is missing into'} ${shown(cassette)}`);
  if (live?.warm) await live.warm().catch(() => undefined);
  const answers = await askRoutes(client, set.cases, { timeoutMs, progress: (done, of) => { if (done === of || done % 10 === 0) io.err(`${done}/${of}`); } });
  const report = {
    ...scoreRoutes(business, set.cases, answers, BARS),
    unlabelledTurns: set.unlabelledTurns,
    unlabelledCalls: set.unlabelledCalls,
    orphanLabels: set.orphanLabels,
    unknownTasks: set.unknownTasks,
    latency: latencyOf(timings),
  };
  const markdown = formatRouteEval(report);
  if (json) io.out(JSON.stringify(report, null, 2));
  else {
    say('');
    for (const line of markdown) io.out(line);
  }
  if (args.out !== undefined) {
    const out = resolve(io.invokedFrom, args.out);
    writeFileSync(out, `${markdown.join('\n')}\n`);
    say(`written to ${shown(out)}`);
  }
  return report.unanswered === 0 ? 0 : 1;
}
