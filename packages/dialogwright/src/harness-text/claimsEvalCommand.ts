import { writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { formatClaimsEval, askVariant, latencyOf, loadCases, loadLabels, loadVariant, measure, type ClaimsEvalReport, type ClaimsVariant, type VariantAnswers } from '../converse/claimsEval';
import { inCi } from '../define/ci';
import { CassetteClient } from '../jev/cassette';
import { resolveJevProvider } from '../jev/provider';
import { SdkJevClient } from '../jev/sdkClient';
import type { JevClient } from '../jev/types';
import { loadHarnessEnv } from '../server/envFile';

/**
 * `dialogwright converse:claims-eval --cases <claims-cases.jsonl>... --labels <labels.jsonl> --variant <module.ts>... [--replay] [--out <file.md>] [--json] [--timeout-ms N]`
 * (../converse/claimsEval.ts): question sets for the check after speaking measured on replies a person
 * labelled. Recording (the default) asks the decision model, with the author's own key, only what the
 * cassette beside the labels file does not have yet, and refuses in CI; `--replay` reads the cassette alone,
 * with no key. Never prints a key.
 */

export const CLAIMS_EVAL_USAGE = [
  'usage: dialogwright converse:claims-eval --cases <claims-cases.jsonl>... --labels <labels.jsonl> --variant <module.ts>... [--replay] [--out <file.md>] [--json] [--timeout-ms N]',
  '  --cases: the claims-cases.jsonl of one or more evaluations (dialogwright eval --claims-cases); a case\'s id is prefixed with its file\'s folder name (<folder>/<id>), and the labels use the prefixed ids',
  '  --labels: one line per labelled reply: {"id", "wrong": boolean, "severity": 0-4, "kinds": [..], "gap": boolean, "why"}; a case with no label is skipped and counted',
  '  --variant: a module whose default export is { name, questions, rules: { <rule>: { target: "wrong" | "gap", score(answers) => number | null } } } (src/converse/claimsVariants/current.ts is the check as it runs)',
  '  asks the decision model once per case and variant (TYPESAFE_API_KEY, or JEV_PROVIDER\'s; from the environment, ENV_FILE or a .env where it is run), four at a time, into the cassette beside the labels (<labels>.jev.jsonl), so a rule can be changed and scored again with no new request; refused in CI',
  '  --replay: read the cassette alone, asking nothing; --out: also write the report as Markdown; --json: the figures as JSON on stdout; --timeout-ms: how long each request may take (default 30000)',
].join('\n');

export interface ClaimsEvalIo {
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
export const claimsCassettePath = (labelsFile: string): string => `${labelsFile.replace(/\.jsonl$/, '')}.jev.jsonl`;

/** Runs the measurement; returns the exit code (2: a command line it does not understand; 1: refused, a file it cannot read, or a request the cassette could not answer). */
export async function claimsEvalCommand(argv: readonly string[], io: ClaimsEvalIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: false,
      options: {
        cases: { type: 'string', multiple: true },
        labels: { type: 'string' },
        variant: { type: 'string', multiple: true },
        replay: { type: 'boolean', default: false },
        out: { type: 'string' },
        json: { type: 'boolean', default: false },
        'timeout-ms': { type: 'string', default: '30000' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (e) {
    io.err(`dialogwright converse:claims-eval: ${e instanceof Error ? e.message : String(e)}\n${CLAIMS_EVAL_USAGE}`);
    return 2;
  }
  const args = parsed.values;
  if (args.help) {
    io.err(CLAIMS_EVAL_USAGE);
    return 0;
  }
  const timeoutMs = Number(args['timeout-ms']);
  if (!args.cases?.length || args.labels === undefined || !args.variant?.length || !(timeoutMs > 0)) {
    io.err(`dialogwright converse:claims-eval: give --cases, --labels and --variant (and a --timeout-ms above 0)\n${CLAIMS_EVAL_USAGE}`);
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
      io.err(`dialogwright converse:claims-eval: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
  }
  if (!replay && inCi(env)) {
    io.err('dialogwright converse:claims-eval: it does not record in CI: recording asks the decision model with your own key, on your machine; --replay reads what is recorded');
    return 1;
  }
  let jev;
  try {
    jev = resolveJevProvider(env, { needKey: !replay });
  } catch (e) {
    const m = /missing required environment variable (\S+)/.exec(e instanceof Error ? e.message : '');
    io.err(m !== null
      ? `dialogwright converse:claims-eval: recording needs the decision model's key, ${m[1]}, in the environment or a settings file (ENV_FILE, or a .env where it is run); or read what is recorded with --replay`
      : `dialogwright converse:claims-eval: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const labelsFile = resolve(io.invokedFrom, args.labels);
  let cases;
  let labels;
  const variants: ClaimsVariant[] = [];
  try {
    cases = loadCases(args.cases.map((f) => resolve(io.invokedFrom, f)));
    labels = loadLabels(labelsFile);
    for (const v of args.variant) variants.push(await loadVariant(resolve(io.invokedFrom, v)));
    const names = variants.map((v) => v.name);
    if (new Set(names).size !== names.length) throw new Error(`the variants' names must differ: ${names.join(', ')}`);
  } catch (e) {
    io.err(`dialogwright converse:claims-eval: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const cassette = claimsCassettePath(labelsFile);
  const answeredBy = { provider: jev.provider, model: jev.model, official: jev.official };
  // Only the requests sent to the model are timed (a cassette hit is not): what a call would wait.
  let timings: number[] = [];
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
    io.err(`dialogwright converse:claims-eval: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  // Only labelled cases are asked.
  const asked = cases.filter((c) => labels.has(c.id));
  say(`${cases.length} cases (${asked.length} labelled), ${variants.length} variants; the model ${jev.model} from ${jev.provider}, ${replay ? 'replayed from' : 'recording what is missing into'} ${shown(cassette)}`);
  if (live?.warm) await live.warm().catch(() => undefined);
  const answered: Array<{ variant: ClaimsVariant; answers: VariantAnswers }> = [];
  const latency: ClaimsEvalReport['latency'] = [];
  for (const variant of variants) {
    timings = [];
    const answers = await askVariant(client, variant, asked, { timeoutMs, progress: (done, of) => { if (done === of || done % 10 === 0) io.err(`${variant.name}: ${done}/${of}`); } });
    answered.push({ variant, answers });
    const l = latencyOf(variant.name, timings);
    if (l !== null) latency.push(l);
  }
  const report = measure(cases, labels, answered, latency);
  const markdown = formatClaimsEval(report);
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
  // A case the model did not answer is unread in the report; the exit code says so.
  const unanswered = [...answered].reduce((n, a) => n + [...a.answers.values()].filter((x) => x === null).length, 0);
  return unanswered === 0 ? 0 : 1;
}
