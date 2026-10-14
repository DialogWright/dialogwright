import { existsSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { getApp, registerApp } from '../core/app/registry';
import type { App } from '../core/app/types';
import { parseScreenMode } from '../core/screen';
import { appFolderAt } from '../define/appFolder';
import { packageRootOf } from '../define/check';
import { loadFolderApp } from '../define/pageCommand';
import { loadScenarios } from './runner';
import { loadCorpus } from '../jev/corpus';
import { cassetteFileName, resolveJevProvider } from '../jev/provider';
import type { JevClient } from '../jev/types';
import { buildThresholds } from '../run/client';
import { defaultCorpusFile, recordedDir, scenariosDir } from '../run/fixtures';
import { loadHarnessEnv } from '../server/envFile';
import { bakeoffJson, formatBakeoff, formatBakeoffMarkdown, parseModelSpecs, parsePrices, providerOf, RENDER_KEY_VARS, runModel, type BakeoffReport, type ModelResult } from './renderBakeoff';
import { generatesLines } from '../render/config';
import { renderSettings, renderLines } from '../render/providers';

/**
 * `dialogwright render:bakeoff [dir] --models <entries> [--replay] [--by-line] [--price <model>=<in>,<out>]...
 * [--screen inline|separate] [--out <file.md>] [--json]` (./renderBakeoff.ts): the render models
 * compared on the app folder's own lines. The folder is any app folder (app.yaml and the module that
 * exports its App, as `regress` finds it), an engine fixture's among them: the run happens in the app's
 * package (the nearest folder above it with a package.json), where app.yaml's `fixtures.dir` is read
 * from, and the settings are read as the regression reads them (ENV_FILE, else the `.env` there).
 * Importing the module runs it: never run this on a folder whose code you would not run.
 */

export const BAKEOFF_USAGE = [
  'usage: dialogwright render:bakeoff [dir] --models <model>[,<model>...] [--replay | --fresh] [--by-line] [--price <model>=<input>,<output>]... [--screen inline|separate] [--out <file.md>] [--json]',
  '  dir: the app folder (one with app.yaml); with none, the folder it is run in, or the nearest above it with an app.yaml',
  '  --models: <provider>:<model>[:<thinking>][:<effort>], anthropic or openrouter, comma-separated or repeated',
  '    (anthropic:claude-haiku-5-5, anthropic:claude-haiku-5-5:adaptive:low, openrouter:openai/gpt-oss-120b:low); thinking: disabled, between-tools, adaptive, omit; effort: low, medium, high',
  '  records each model into fixtures/recorded/render/<model>.jsonl with your own keys (refused in CI), then tables them; --replay: table the cassettes alone, asking no model',
  '  --fresh: ask every line again, each model\'s cassette moved aside for its run: replaced when the run completes, put back when it is stopped or fails',
  '  --by-line: each model\'s lines, most fallbacks first, with a wording a check refused; --price: a model\'s price in US dollars per million tokens (the default model\'s is known)',
  '  --out: also write the table as Markdown; --json: the results as JSON on stdout',
].join('\n');

export interface BakeoffIo {
  out(line: string): void;
  err(line: string): void;
  /** Where the command was run (pnpm's INIT_CWD), which a relative folder is from. */
  invokedFrom: string;
  /** The settings; default process.env, with the app's settings file read into it. Given, nothing is read. */
  env?: Record<string, string | undefined>;
  /** Moves the process into the app's package. Default: process.chdir. */
  chdir?(dir: string): void;
  /** Tests: the fetch the model clients use (a fake provider). */
  fetchFn?: typeof fetch;
  /** Tests: the decision model that answers what the app's recording lacks when recording (a stub), in place of TypeSafe's client. */
  decisionModel?: JevClient;
  /** Tests: where the recordings are, in place of the app's. */
  recordedDir?: string;
}

/** Whether `CI` is set the way CI services set it (any value but empty, 0 or false). */
function inCi(env: Record<string, string | undefined>): boolean {
  const v = env.CI?.trim().toLowerCase();
  return v !== undefined && v !== '' && v !== '0' && v !== 'false';
}

/** Runs the comparison; returns the exit code (2: a command line it does not understand; 1: refused, or nothing to compare). */
export async function bakeoffCommand(argv: readonly string[], io: BakeoffIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        models: { type: 'string', multiple: true, default: [] },
        replay: { type: 'boolean', default: false },
        fresh: { type: 'boolean', default: false },
        'by-line': { type: 'boolean', default: false },
        price: { type: 'string', multiple: true, default: [] },
        screen: { type: 'string' },
        out: { type: 'string' },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (e) {
    io.err(`dialogwright render:bakeoff: ${e instanceof Error ? e.message : String(e)}\n${BAKEOFF_USAGE}`);
    return 2;
  }
  const { values: args, positionals } = parsed;
  if (args.help) {
    io.err(BAKEOFF_USAGE);
    return 0;
  }
  if (positionals.length > 1) {
    io.err(`dialogwright render:bakeoff: give one app folder at most\n${BAKEOFF_USAGE}`);
    return 2;
  }
  let specs;
  let prices;
  let screen;
  try {
    specs = parseModelSpecs(args.models ?? []);
    prices = parsePrices(args.price ?? []);
    screen = parseScreenMode(args.screen, '--screen');
  } catch (e) {
    io.err(`dialogwright render:bakeoff: ${e instanceof Error ? e.message : String(e)}\n${BAKEOFF_USAGE}`);
    return 2;
  }
  const replay = args.replay === true;
  const fresh = args.fresh === true;
  if (fresh && replay) {
    io.err(`dialogwright render:bakeoff: --fresh records every line again; --replay records nothing: give one\n${BAKEOFF_USAGE}`);
    return 2;
  }
  const byLine = args['by-line'] === true;
  const json = args.json === true;
  // With --json, stdout is the JSON alone: the rest goes to stderr.
  const say = json ? io.err : io.out;

  let dir: string | null;
  if (positionals[0] !== undefined) {
    dir = resolve(io.invokedFrom, positionals[0]);
    if (!existsSync(join(dir, 'app.yaml'))) {
      io.err(`dialogwright render:bakeoff: ${positionals[0]} is not an app folder (it has no app.yaml)\n${BAKEOFF_USAGE}`);
      return 2;
    }
  } else {
    dir = appFolderAt(io.invokedFrom);
    if (dir === null) {
      io.err(`dialogwright render:bakeoff: ${io.invokedFrom} is not in an app folder (no app.yaml here or above): name the folder\n${BAKEOFF_USAGE}`);
      return 2;
    }
  }
  const out = args.out === undefined ? null : resolve(io.invokedFrom, args.out);

  const env = io.env ?? process.env;
  let app: App;
  try {
    app = await loadFolderApp(dir);
  } catch (e) {
    io.err(`dialogwright render:bakeoff: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  if (!generatesLines(app)) {
    io.err(`dialogwright render:bakeoff: ${app.id} generates no line (prompts.yaml's mode: generative, a form's wording: generative): there is nothing to compare`);
    return 1;
  }
  try {
    getApp(app.id);
  } catch {
    registerApp(app);
  }
  // The app's commands run in its package, where app.yaml's fixtures.dir is read from (and its .env is).
  (io.chdir ?? ((to: string) => process.chdir(to)))(packageRootOf(dir));
  if (io.env === undefined) {
    try {
      const loaded = loadHarnessEnv(env);
      if (loaded !== null) io.err(loaded);
    } catch (e) {
      io.err(`dialogwright render:bakeoff: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
  }

  if (!replay) {
    if (inCi(env)) {
      io.err('dialogwright render:bakeoff: it does not record in CI: recording asks models with your own keys, on your machine; --replay tables what is recorded');
      return 1;
    }
    // Every key the recording needs, named at once (never a value): the decision model's for the drift checks, each provider's for its models.
    const missing: string[] = [];
    try {
      resolveJevProvider(env, { needKey: true });
    } catch (e) {
      const m = /missing required environment variable (\S+)/.exec(e instanceof Error ? e.message : '');
      if (m === null) {
        io.err(`dialogwright render:bakeoff: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }
      missing.push(`${m[1]} (the decision model: its drift checks of every line)`);
    }
    for (const provider of [...new Set(specs.map((s) => s.provider))]) {
      const v = RENDER_KEY_VARS[provider];
      if (!env[v]?.trim()) missing.push(`${v} (${specs.filter((s) => s.provider === provider).map((s) => s.entry).join(', ')})`);
    }
    if (missing.length > 0) {
      io.err(['dialogwright render:bakeoff: recording needs these keys, in the environment or the app\'s settings file (ENV_FILE, or its .env):', ...missing.map((m) => `  ${m}`), 'or table what is recorded already with --replay'].join('\n'));
      return 1;
    }
  }

  let report: BakeoffReport;
  try {
    // A recording waits for the decision model as long as a recording regression is told to (the create-app skill's 15 s).
    const thresholds = buildThresholds(replay ? [] : ['JEV_TIMEOUT_MS=15000']);
    const jev = resolveJevProvider(env, { needKey: !replay });
    const recorded = resolve(io.recordedDir ?? recordedDir(app));
    // Paths as seen from where the command was run.
    const shown = (path: string): string => {
      const near = relative(io.invokedFrom, path);
      return near === '' || near.startsWith('..') ? path : near;
    };
    const decisionCassette = join(recorded, cassetteFileName(jev.model));
    const decision = { provider: jev, main: decisionCassette, thresholds, ...(io.decisionModel !== undefined ? { live: io.decisionModel } : {}) };
    const corpus = loadCorpus(defaultCorpusFile(app), app);
    const scenarios = loadScenarios(scenariosDir(app));
    const budget = renderSettings(env).timeoutMs;
    say(`${app.id}: ${corpus.length} corpus lines and ${scenarios.length} scripted calls; the decision model ${jev.model} from ${jev.provider}, its answers replayed from the app's recording (${shown(decisionCassette)}${existsSync(decisionCassette) ? '' : ', not found'})`);
    const models: ModelResult[] = [];
    for (const spec of specs) {
      try {
        for (const line of renderLines(providerOf(spec, { env, replay }), { replayed: replay })) say(line);
      } catch {
        // A model whose settings are refused is reported in its row; the run goes on.
      }
      const result = await runModel(spec, {
        app, recordedDir: recorded, decision, replay, fresh, env, thresholds, screen, corpus, scenarios, prices,
        ...(io.fetchFn !== undefined ? { fetchFn: io.fetchFn } : {}),
        progress: io.err,
      });
      models.push(result.status === 'refused' ? result : { ...result, cassette: shown(result.cassette), checks: shown(result.checks) });
    }
    report = { app: app.id, decisionModel: jev.model, replay, budgetMs: budget, corpus: corpus.length, scenarios: scenarios.length, models };
  } catch (e) {
    io.err(`dialogwright render:bakeoff: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  if (json) io.out(bakeoffJson(report, { byLine }));
  else {
    say('');
    for (const line of formatBakeoff(report, { byLine })) io.out(line);
  }
  if (out !== null) {
    writeFileSync(out, formatBakeoffMarkdown(report, { byLine }));
    say(`written to ${out}`);
  }
  return 0;
}
