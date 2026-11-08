import { writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { AGENT_BAKEOFF_BUDGET_MS, AGENT_KEY_VARS, agentCassettePath, agentRequestOf, askedTurns, formatAgentBakeoff, formatAgentBakeoffMarkdown, liveAgentClient, parseAgentModelSpecs, printedTurn, recordedDirFor, runAgentBakeoff, variantsOf, warmedUp, type AgentBakeoffReport, type AgentModelSpec, type AgentVariant, type WarmUpSpent } from '../agent/bakeoff';
import { loadBakeoffCases, type BakeoffCases } from '../agent/bakeoffCases';
import { cassetteAgent } from '../agent/cassette';
import { agentMessages } from '../agent/prompt';
import type { AgentClient } from '../agent/types';
import { inCi } from '../define/ci';
import { REPO_ROOT } from '../define/home';
import type { RenderPrice } from '../render/types';
import { loadHarnessEnv } from '../server/envFile';
import { parsePrices } from './renderBakeoff';

/**
 * `dialogwright agent:bakeoff --cases <file> --models <entries> [--recorded <dir>] [--examples on|off|both]
 * [--repeat N] [--replay] [--judge-ms N] [--price <model>=<in>,<out>]... [--by-turn] [--print-prompt]
 * [--out <file.md>] [--json]` (../agent/bakeoff.ts): agent models compared on a cases file's calls. The
 * recordings go beside the cases (`<cases dir>/recorded/`) unless `--recorded` names a folder, so nothing is
 * written into the package. The keys are read from the environment, then the files ENV_FILE names (from
 * where the command was run), else the `.env` of the repository it runs from; never printed. Recording asks
 * each model with the author's own key and refuses in CI; `--replay` tables the cassettes alone, with no key.
 */

export const AGENT_BAKEOFF_USAGE = [
  'usage: dialogwright agent:bakeoff --cases <file> [--business <business.yaml>] --models <model>[,<model>...] [--recorded <dir>] [--examples on|off|both] [--repeat N] [--replay] [--judge-ms N] [--price <model>=<input>,<output>]... [--by-turn] [--print-prompt] [--out <file.md>] [--json]',
  '  --cases: the calls to measure on (YAML or JSON: each caller turn labelled, and the facts, the owner\'s sample replies and the forms, or the app\'s business.yaml they name; packages/dialogwright/src/agent/bakeoffCases.ts)',
  '  --business: the app\'s business.yaml, whose facts, persona, sample replies, forms and fixed lines the turns are sent (over the one the cases name)',
  '  --models: inception:<model>[:<effort>][:realtime] (effort: instant, low, medium, high; Inception\'s own API, INCEPTION_API_KEY)',
  '    or openrouter:<vendor/model>[:<thinking>][:<effort>] (OPENROUTER_API_KEY; with neither, no reasoning setting is sent); comma-separated or repeated',
  '  asks every caller turn of each model, one at a time, recording into <cases dir>/recorded/<model>.jsonl (or --recorded <dir>) with your own keys (refused in CI);',
  '    a turn already recorded is not asked again; --replay: table the cassettes alone, asking no model',
  '  --examples: the prompt with the owner\'s sample replies (on), without (off), or both (the default)',
  '  --repeat N: ask each turn N times (default 1), for steadier times; --judge-ms N: add the drift judge\'s time to each answer and hold it to the bar',
  '  --price: a model\'s price in US dollars per million tokens, where its provider gives no cost; --by-turn: each result\'s mistakes and the replies to read',
  '  --print-prompt: print what one turn sends (the first a person reads) and ask nothing; --out: also write the table as Markdown; --json: the results as JSON on stdout',
  '  the keys: from the environment, the files ENV_FILE names, or the repository\'s .env; never printed',
].join('\n');

export interface AgentBakeoffIo {
  out(line: string): void;
  err(line: string): void;
  /** Where the command was run (pnpm's INIT_CWD): `--cases`, `--recorded`, `--out` and ENV_FILE are from there. */
  invokedFrom: string;
  /** The settings; default process.env, with the settings file read into it. Given, nothing is read. */
  env?: Record<string, string | undefined>;
  /** Tests: the fetch the model clients use (a fake provider). */
  fetchFn?: typeof fetch;
  /** Tests: the folder whose .env is read, in place of the repository root. */
  envDir?: string;
}

/** Runs the comparison; returns the exit code (2: a command line it does not understand; 1: refused, a key missing, or cases it cannot read). */
export async function agentBakeoffCommand(argv: readonly string[], io: AgentBakeoffIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: false,
      options: {
        cases: { type: 'string' },
        business: { type: 'string' },
        recorded: { type: 'string' },
        models: { type: 'string', multiple: true, default: [] },
        examples: { type: 'string' },
        repeat: { type: 'string' },
        replay: { type: 'boolean', default: false },
        'judge-ms': { type: 'string' },
        price: { type: 'string', multiple: true, default: [] },
        'by-turn': { type: 'boolean', default: false },
        'print-prompt': { type: 'boolean', default: false },
        out: { type: 'string' },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (e) {
    io.err(`dialogwright agent:bakeoff: ${e instanceof Error ? e.message : String(e)}\n${AGENT_BAKEOFF_USAGE}`);
    return 2;
  }
  const args = parsed.values;
  if (args.help) {
    io.err(AGENT_BAKEOFF_USAGE);
    return 0;
  }
  const usage = (why: string): number => {
    io.err(`dialogwright agent:bakeoff: ${why}\n${AGENT_BAKEOFF_USAGE}`);
    return 2;
  };
  if (args.cases === undefined) return usage('name the cases to measure on with --cases <file>');
  let variants: AgentVariant[];
  let prices: Map<string, RenderPrice>;
  let repeat = 1;
  let judgeMs: number | undefined;
  try {
    variants = variantsOf(args.examples);
    prices = parsePrices(args.price ?? []);
    if (args.repeat !== undefined) repeat = wholeNumber('--repeat', args.repeat, 1, 50);
    if (args['judge-ms'] !== undefined) judgeMs = wholeNumber('--judge-ms', args['judge-ms'], 0, 10_000);
  } catch (e) {
    return usage(e instanceof Error ? e.message : String(e));
  }
  const casesFile = resolve(io.invokedFrom, args.cases);
  let cases: BakeoffCases;
  try {
    cases = loadBakeoffCases(casesFile, args.business !== undefined ? resolve(io.invokedFrom, args.business) : undefined);
  } catch (e) {
    io.err(`dialogwright agent:bakeoff: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  if (args['print-prompt']) {
    const { call, index } = printedTurn(cases);
    const { system, user } = agentMessages(askedTurns(cases, call, variants[0]!)[index]!.ctx);
    io.out(`${call.id}, turn ${index + 1} (${variants[0]}): the system message, then the user message\n\n${system}\n----- user -----\n\n${user}`);
    return 0;
  }

  let specs: AgentModelSpec[];
  try {
    specs = parseAgentModelSpecs(args.models ?? []);
  } catch (e) {
    return usage(e instanceof Error ? e.message : String(e));
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
      const loaded = loadHarnessEnv(env, io.envDir ?? REPO_ROOT);
      if (loaded !== null) io.err(loaded);
    } catch (e) {
      io.err(`dialogwright agent:bakeoff: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
  }
  if (!replay) {
    if (inCi(env)) {
      io.err('dialogwright agent:bakeoff: it does not record in CI: recording asks models with your own keys, on your machine; --replay tables what is recorded');
      return 1;
    }
    // Every key the recording needs, named at once (never a value).
    const missing = [...new Set(specs.map((s) => s.provider))].filter((p) => !env[AGENT_KEY_VARS[p]]?.trim()).map((p) => `  ${AGENT_KEY_VARS[p]} (${specs.filter((s) => s.provider === p).map((s) => s.entry).join(', ')})`);
    if (missing.length > 0) {
      io.err(['dialogwright agent:bakeoff: recording needs these keys, in the environment, a file ENV_FILE names, or the repository\'s .env:', ...missing, 'or table what is recorded already with --replay'].join('\n'));
      return 1;
    }
  }

  const dir = args.recorded !== undefined ? resolve(io.invokedFrom, args.recorded) : recordedDirFor(casesFile);
  const models: { entry: string; client: AgentClient }[] = [];
  const warmUps: { entry: string; client: { readonly spent: WarmUpSpent | null } }[] = [];
  try {
    for (const spec of specs) {
      const path = agentCassettePath(dir, spec);
      let client;
      if (replay) client = cassetteAgent(path, { model: spec.model, request: agentRequestOf(spec) });
      else {
        const price = prices.get(spec.entry) ?? prices.get(spec.model);
        const live = warmedUp(liveAgentClient(spec, env, io.fetchFn), price);
        warmUps.push({ entry: spec.entry, client: live });
        client = cassetteAgent(path, { record: live });
      }
      client.preload();
      say(`${spec.entry}: ${replay ? 'replayed from' : 'recording what is missing into'} ${shown(path)}`);
      models.push({ entry: spec.entry, client });
    }
  } catch (e) {
    io.err(`dialogwright agent:bakeoff: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  let report: AgentBakeoffReport;
  try {
    report = await runAgentBakeoff(models, { cases, variants, repeat, replay, budgetMs: AGENT_BAKEOFF_BUDGET_MS, prices, ...(judgeMs !== undefined ? { judgeMs } : {}), ...(replay ? {} : { progress: io.err }) });
  } catch (e) {
    io.err(`dialogwright agent:bakeoff: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  // The warm-ups are no turn of the cases: what they cost is said apart, never in the table.
  for (const w of warmUps) {
    const s = w.client.spent;
    if (s !== null) say(`${w.entry}: warm-up, 1 request before the first turn asked (not in the table): ${s.ms} ms, ${s.usage.inputTokens} / ${s.usage.outputTokens} tokens, ${s.costUsd === null ? 'no price' : `$${s.costUsd.toFixed(4)}`}`);
  }
  if (json) io.out(JSON.stringify(report, null, 2));
  else {
    say('');
    for (const line of formatAgentBakeoff(report, { byTurn: args['by-turn'] === true })) io.out(line);
  }
  if (args.out !== undefined) {
    const out = resolve(io.invokedFrom, args.out);
    writeFileSync(out, formatAgentBakeoffMarkdown(report));
    say(`written to ${shown(out)}`);
  }
  return 0;
}

function wholeNumber(flag: string, raw: string, min: number, max: number): number {
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || n < min || n > max) throw new Error(`${flag} must be a whole number from ${min} to ${max}, got "${raw}"`);
  return n;
}
