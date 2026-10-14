import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { App } from '../core/app/types';
import type { Thresholds } from '../core/thresholds';
import type { ScreenMode } from '../core/screen';
import type { CorpusEntry } from '../jev/corpus';
import { CassetteClient, CASSETTE_MISS, isCassetteMiss, loadCassette, requestKey, trimCassette } from '../jev/cassette';
import { cassetteFileName, type JevProvider } from '../jev/provider';
import { SdkJevClient } from '../jev/sdkClient';
import type { JevClient, JevRequest, JevResponse } from '../jev/types';
import { REGRESS_TODAY } from './baseline';
import { emptyRunAll, runAll, type RunAllResult } from './runAll';
import type { RunOptions, Scenario } from './runner';
import { redactRecordSlots } from '../trace/redact';
import type { TraceRecord } from '../trace/types';
import { loadRenderCassette, RenderCassette, renderCassettePath } from '../render/cassette';
import { emptyRenderTally, tallyRender, type RenderTally } from '../render/harness';
import {
  ModelRenderClient,
  RENDER_EFFORTS,
  RENDER_PROVIDERS,
  RENDER_THINKING_MODES,
  renderCassetteModel,
  refusedThinking,
  renderSettings,
  resolveRenderProvider,
  thinkingLabel,
  type RenderEffort,
  type RenderProvider,
  type RenderProviderName,
  type RenderThinkingMode,
} from '../render/providers';
import { DEFAULT_RENDER_PRICE, type Generation, type RenderClient, type RenderPrice, type RenderRequest } from '../render/types';
import type { RenderChannel } from '../core/app/types';

/**
 * The render models compared on an app's own lines (`render:bakeoff`): the app's corpus and scripted
 * calls run once for each model, that model wording every line the app generates, each run recorded
 * into the model's own render cassette (`<recorded>/render/<model>.jsonl`, the cassette a regression
 * replays: render/cassette.ts), so a comparison is kept and can be tabled again for nothing
 * (`--replay`). The table gives, for each model: the lines tried, said generated, and fallen back, by
 * reason (a request's failures by why); the wording's latency at the median and the 95th percentile,
 * and how many wordings would have run past the app's own RENDER_TIMEOUT_MS on a call; and the cost,
 * the wording's and the decision model's checks of it.
 *
 * What stays the same from model to model: the decision model's answers are the app's recording
 * (`--client recorded`'s cassette, only read), so every model words the same turns, and the drift
 * check is the same judge for all. Its answers about a model's wordings (and any turn the app's
 * recording lacks) are kept beside that model's render cassette (checksCassettePath), never in the
 * app's own recording, which a comparison leaves as it was. A recording run's budgets are generous
 * (GENEROUS_BUDGET_MS), so a slow model's wording is measured rather than cut off: what a call would
 * have dropped is the over-budget count, not a fallback. `--fresh` asks every line again into a file
 * beside the cassette, put over it only when the run completes with every line answered; the app's own
 * cassette is kept unless the author says to replace it (comparisonCassettePath). Recording is the author's step, with their own keys, on their
 * machine; the command refuses in CI, and no test records (tests use fakes).
 */

/** A model to compare, as `--models` names it: `<provider>:<model>[:<thinking>][:<effort>]` (`anthropic:claude-haiku-5-5`, `openrouter:openai/gpt-oss-120b:low`). */
export interface ModelSpec {
  /** As given. */
  readonly entry: string;
  readonly provider: RenderProviderName;
  readonly model: string;
  /** RENDER_THINKING for this model; absent, the model's own default (THINKING_BY_MODEL on Anthropic; reasoning off on OpenRouter, unless an effort is given). */
  readonly thinking?: RenderThinkingMode;
  /** RENDER_EFFORT for this model. */
  readonly effort?: RenderEffort;
}

/**
 * Reads `--models`: comma-separated entries, each `<provider>:<model>`, with the model's thinking and its
 * effort after it, either or both, in RENDER_THINKING's and RENDER_EFFORT's words (`:adaptive:low`,
 * `:low`). An OpenRouter id may itself hold a colon (`vendor/model:free`): only trailing words of that
 * vocabulary are read as the thinking and the effort. Throws, saying which entry is wrong.
 */
export function parseModelSpecs(list: readonly string[]): ModelSpec[] {
  const entries = list.flatMap((l) => l.split(',')).map((e) => e.trim()).filter((e) => e !== '');
  if (entries.length === 0) throw new Error('--models names no model: give one or more, comma-separated, as anthropic:<model> or openrouter:<vendor/model>');
  const out: ModelSpec[] = [];
  const vocabulary = `its thinking (${RENDER_THINKING_MODES.join(', ')}) and its effort (${RENDER_EFFORTS.join(', ')})`;
  for (const entry of entries) {
    const at = entry.indexOf(':');
    const provider = at === -1 ? '' : entry.slice(0, at);
    const rest = at === -1 ? '' : entry.slice(at + 1);
    if (!(RENDER_PROVIDERS as readonly string[]).includes(provider)) throw new Error(`"${entry}": start it with its provider, ${RENDER_PROVIDERS.map((p) => `${p}:`).join(' or ')} (anthropic:claude-haiku-5-5, openrouter:<vendor/model>)`);
    const parts = rest.split(':');
    const effort = parts.length > 1 && (RENDER_EFFORTS as readonly string[]).includes(parts.at(-1)!) ? (parts.pop() as RenderEffort) : undefined;
    const thinking = parts.length > 1 && (RENDER_THINKING_MODES as readonly string[]).includes(parts.at(-1)!) ? (parts.pop() as RenderThinkingMode) : undefined;
    const model = parts.join(':');
    if (model.trim() === '') throw new Error(`"${entry}": name the model after ${provider}:`);
    // An Anthropic id has no colon: anything after the model is its thinking and its effort, or a slip.
    if (provider === 'anthropic' && model.includes(':')) throw new Error(`"${entry}": after the model give ${vocabulary}, either or both, got "${model.slice(model.indexOf(':') + 1)}"`);
    out.push({ entry, provider: provider as RenderProviderName, model, ...(thinking !== undefined ? { thinking } : {}), ...(effort !== undefined ? { effort } : {}) });
  }
  const seen = new Set<string>();
  for (const s of out) {
    const id = `${s.provider}:${s.model}:${s.thinking ?? ''}:${s.effort ?? ''}`;
    if (seen.has(id)) throw new Error(`"${s.entry}" is named twice`);
    seen.add(id);
  }
  return out;
}

type Env = Record<string, string | undefined>;

/** The settings a model's run reads: the environment, with the render provider, model and thinking the entry names (and no other's). */
export function envForModel(spec: ModelSpec, env: Env): Env {
  const out: Env = { ...env, RENDER_PROVIDER: spec.provider, RENDER_MODEL: spec.model };
  delete out.RENDER_THINKING;
  delete out.RENDER_EFFORT;
  if (spec.thinking !== undefined) out.RENDER_THINKING = spec.thinking;
  if (spec.effort !== undefined) out.RENDER_EFFORT = spec.effort;
  return out;
}

/** The key variable each provider's recording needs (render/providers.ts). */
export const RENDER_KEY_VARS: Readonly<Record<RenderProviderName, string>> = { anthropic: 'ANTHROPIC_API_KEY', openrouter: 'OPENROUTER_API_KEY' };

/** The models whose price is known without `--price`: the default model's, on either provider (DEFAULT_RENDER_PRICE). */
export const PRICED_BY_DEFAULT: Readonly<Record<string, RenderPrice>> = { 'claude-haiku-5-5': DEFAULT_RENDER_PRICE, 'anthropic/claude-haiku-5.5': DEFAULT_RENDER_PRICE };

/** Reads `--price <model>=<input>,<output>` (US dollars per million tokens), each repeatable. Throws on a malformed one. */
export function parsePrices(values: readonly string[]): Map<string, RenderPrice> {
  const out = new Map<string, RenderPrice>(Object.entries(PRICED_BY_DEFAULT));
  for (const v of values) {
    const m = /^(.+)=([0-9.]+),([0-9.]+)$/.exec(v.trim());
    const input = m ? Number(m[2]) : NaN;
    const output = m ? Number(m[3]) : NaN;
    if (!m || !Number.isFinite(input) || !Number.isFinite(output)) throw new Error(`--price ${v}: give <model>=<input>,<output>, US dollars per million tokens (claude-sonnet-5-5=1,5)`);
    out.set(m[1]!, { input, output });
  }
  return out;
}

/**
 * The budgets a comparison words and checks a line within: long enough that a slow model's wording is
 * measured, not cut off (a line that still runs past it falls back as `timeout`). What a call would
 * have dropped is counted against the app's own budget instead (ModelResult.wording.overBudget).
 */
export const GENEROUS_BUDGET_MS = { voice: 30_000, chat: 30_000 } as const;

/** What a `--fresh` run records into, beside the model's cassette (`<cassette>.fresh`), until it is accepted. */
export const FRESH_SUFFIX = '.fresh';

/**
 * The comparison's own name for a model whose cassette is the app's (git tracks it, or it is the one the
 * app's regression replays): `<model>.bakeoff.jsonl`, beside it. A `--fresh` run of such a model is
 * recorded there unless `--replace-app-cassette` is given, and the bake-off tables it from then on.
 */
export function comparisonCassettePath(cassette: string): string {
  return cassette.replace(/\.jsonl$/, '.bakeoff.jsonl');
}

/**
 * While a fresh run records into `path`: on SIGINT or SIGTERM, the partial file is deleted (synchronously)
 * and the process exits, the model's cassette untouched. Returns the function that removes the handlers.
 */
export function guardFresh(path: string, exit: (code: number) => void = (code) => process.exit(code)): () => void {
  const on = (signal: NodeJS.Signals): void => {
    rmSync(path, { force: true });
    exit(signal === 'SIGINT' ? 130 : 143);
  };
  const int = (): void => on('SIGINT');
  const term = (): void => on('SIGTERM');
  process.once('SIGINT', int);
  process.once('SIGTERM', term);
  return () => {
    process.removeListener('SIGINT', int);
    process.removeListener('SIGTERM', term);
  };
}

/** Stop a model's run once this many lines were tried and every one failed as a request (`error`): a wrong id, a key it refuses. */
export const STOP_AFTER_ERRORS = 5;

/**
 * Where the decision model's answers about one render model's run are kept: its checks of that model's
 * wordings (the drift check, collected content screened again) and any turn the app's own recording
 * lacks, by the decision model: `<recorded>/render/checks/<render model>/<decision model>.jsonl`.
 */
export function checksCassettePath(recordedDir: string, renderModel: string, decisionModel: string): string {
  return join(recordedDir, 'render', 'checks', cassetteFileName(renderModel).replace(/\.jsonl$/, ''), cassetteFileName(decisionModel));
}

/** The app's own recording first; what it lacks, from (or, recording, into) the model's checks cassette. */
class LayeredDecision implements JevClient {
  readonly answeredBy?: JevClient['answeredBy'];

  constructor(private readonly main: JevClient, private readonly checks: JevClient) {
    const by = main.answeredBy ?? checks.answeredBy;
    if (by) this.answeredBy = by;
  }

  async ask(req: JevRequest): Promise<JevResponse> {
    try {
      return await this.main.ask(req);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith(CASSETTE_MISS)) return this.checks.ask(req);
      throw e;
    }
  }
}

/** The decision model of a render model's run (LayeredDecision): the app's recording replayed, then the model's checks cassette. */
export interface DecisionModel {
  provider: JevProvider;
  /** The app's own recording of the decision model (`--client recorded`'s), only read. */
  main: string;
  /** Recording: the decision model itself, which answers what neither cassette has (default: TypeSafe's client, by the provider). */
  live?: JevClient;
  thresholds: Thresholds;
}

function decisionFor(d: DecisionModel, checks: string, replay: boolean): { client: JevClient; used: Set<string> } {
  const main = new CassetteClient({ path: d.main, mode: 'replay', answeredBy: { provider: d.provider.provider, model: d.provider.model, official: d.provider.official } });
  main.preload();
  const side = replay
    ? new CassetteClient({ path: checks, mode: 'replay' })
    : new CassetteClient({ path: checks, mode: 'record', inner: d.live ?? new SdkJevClient({ endpoint: d.provider, timeoutMs: d.thresholds.JEV_TIMEOUT_MS }) });
  side.preload();
  // What this run asked of the checks cassette: a completed recording keeps those answers alone (pruneChecks).
  const used = new Set<string>();
  const counted: JevClient = { ask: (req) => (used.add(requestKey(req)), side.ask(req)) };
  return { client: new LayeredDecision(main, counted), used };
}

/**
 * After a recording run that completed: the checks cassette keeps only the answers this run asked for,
 * so the answers about wordings a fresh run replaced do not pile up. Returns how many were dropped.
 */
function pruneChecks(path: string, used: ReadonlySet<string>): number {
  if (!existsSync(path)) return 0;
  const lines = loadCassette(path);
  const kept = trimCassette(lines, used);
  const dropped = lines.size - kept.length;
  if (dropped > 0) writeFileSync(path, kept.map((l) => `${JSON.stringify(l)}\n`).join(''));
  return dropped;
}

/** One line of the app (a prompt id, or a framed line's span), across a model's run. */
export interface LineBreakdown {
  promptId: string;
  span?: string;
  tried: number;
  generated: number;
  fellBack: Record<string, number>;
  /** Spans whose wording was their content word for word, said exactly (RenderLine.exactly): not a fallback. Absent when none. */
  exactly?: number;
  /** The most common fallback's first instance: a wording a check refused (scrubbed as the trace is), or a failed request's reason. */
  example?: { reason: string; text: string };
}

/** One model's results. */
export interface ModelResult {
  entry: string;
  /** The entry, with its thinking where it is not the model's default. */
  label: string;
  provider: RenderProviderName;
  model: string;
  /** How the model was asked to think (Anthropic only). */
  thinking?: string;
  /** Its render cassette. */
  cassette: string;
  /** The decision model's answers about its run that the app's recording lacks (checksCassettePath). */
  checks: string;
  /** `ran`; `not-recorded` (a replay with no cassette for it); `stopped` (every line tried failed as a request, STOP_AFTER_ERRORS); `refused` (its settings refused before any request: a thinking the model refuses). */
  status: 'ran' | 'not-recorded' | 'stopped' | 'refused';
  /** Why a stopped run stopped: its requests' failure. */
  stopped?: string;
  /** Why the entry could not be run at all: a thinking the model refuses (render/providers.ts refusedThinking), asked of no model. */
  refused?: string;
  tried: number;
  generated: number;
  /** Fallbacks by reason. */
  fellBack: Record<string, number>;
  /** Spans whose wording was their content word for word, said exactly (RenderLine.exactly): not a fallback. Absent when none. */
  exactly?: number;
  /** The `error` fallbacks by why the request failed. */
  errors: Record<string, number>;
  /** For each of those reasons, the API's own words the first time (the trace's `error.message`, scrubbed as the trace is), where it gave any. */
  errorMessages: Record<string, string>;
  /** Lines the app generates said fixed without being tried (`when`, a locale, the screen...). */
  untried: number;
  wording: {
    /** Distinct wordings with a measured latency (recorded from the model, now or in an earlier run). */
    measured: number;
    p50: number | null;
    p95: number | null;
    /** Of those, how many took longer than the app's RENDER_TIMEOUT_MS for their channel: on a call, a fixed line. */
    overBudget: number;
    /** Wordings (distinct requests) that ran past even the bake-off's own budget and never answered: counted as measured and over, at that budget, in the percentiles. */
    timedOut: number;
  };
  /** A `--fresh` run's outcome: `kept` (it replaced the cassette), or why it was not (the earlier cassette kept, the fresh one discarded). */
  fresh?: { kept: true } | { kept: false; why: string };
  /** A partial `<cassette>.fresh` an interrupted run left: deleted by a fresh run, otherwise only said. */
  leftover?: string;
  /** Answers about wordings no longer recorded, dropped from the checks cassette after a completed recording. */
  checksPruned?: number;
  /** True when this run replaced the app's own cassette (`--replace-app-cassette`): its drift checks are not in the app's recording. */
  replacedAppCassette?: boolean;
  cost: {
    /** The wordings' tokens, every request the run made (a replayed one counted as asked again). */
    renderTokens: { input: number; output: number };
    /** At the model's price; null when it is not known (`--price`). */
    renderUsd: number | null;
    /** The decision model's checks of the lines (the drift check, collected content screened again). */
    checkTokens: { input: number; output: number };
    checksUsd: number;
  };
  /** The decision model's cassette misses (a replay): turns it could not answer, and checks it could not ask (`drift-error`). */
  decisionMisses: { turns: number; checks: number };
  byLine: LineBreakdown[];
}

/** A render client that remembers what it was asked (each request's key, line and channel) and what the wordings it got cost. */
class WatchedRenderClient implements RenderClient {
  readonly asked = new Map<string, { promptId: string; span?: string; channel: RenderChannel }>();
  readonly tokens = { input: 0, output: 0 };
  /** Requests the turn stopped waiting for (its budget ran out, and it aborted them) that never answered. */
  readonly pastBudget = new Set<string>();

  constructor(private readonly inner: RenderClient) {}

  get model(): string {
    return this.inner.model;
  }

  async generate(req: RenderRequest, signal: AbortSignal): Promise<Generation> {
    this.asked.set(req.key, { promptId: req.promptId, ...(req.span !== undefined ? { span: req.span } : {}), channel: req.act.channel });
    let g: Generation;
    try {
      g = await this.inner.generate(req, signal);
    } catch (e) {
      // Aborted because the turn's budget ran out: a wording past the budget, not a failed request.
      if (signal.aborted) this.pastBudget.add(req.key);
      throw e;
    }
    this.tokens.input += g.usage.inputTokens;
    this.tokens.output += g.usage.outputTokens;
    return g;
  }
}

/** The decision model as the drift check asks it: what its checks cost, and how many missed its cassette. */
class WatchedChecks implements JevClient {
  readonly tokens = { input: 0, output: 0 };
  misses = 0;

  constructor(private readonly inner: JevClient) {
    if (inner.answeredBy) this.answeredBy = inner.answeredBy;
  }

  readonly answeredBy?: JevClient['answeredBy'];

  async ask(req: JevRequest): Promise<JevResponse> {
    try {
      const r = await this.inner.ask(req);
      this.tokens.input += r.usage.inputTokens;
      this.tokens.output += r.usage.outputTokens;
      return r;
    } catch (e) {
      if (e instanceof Error && e.message.startsWith(CASSETTE_MISS)) this.misses += 1;
      throw e;
    }
  }
}

/** The value at fraction `q` of `xs`, by rank (as the regression's summary takes it). */
function quantile(xs: readonly number[], q: number): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
}

class StopModel extends Error {}

/** The decision model failing three turns running: it stops the whole comparison (the models run so far are still tabled). */
export class DecisionFailed extends Error {}

/** A run's lines, one by one, from its records scrubbed as the trace scrubs them: by prompt id and span, most fallbacks first. */
export function lineBreakdown(records: readonly TraceRecord[], app: App): LineBreakdown[] {
  const by = new Map<string, LineBreakdown & { examples: Record<string, string> }>();
  for (const raw of records) {
    if (raw.render === undefined) continue;
    const record = redactRecordSlots(raw, 'length', app);
    for (const line of record.render?.lines ?? []) {
      if (line.skipped !== undefined) continue;
      const id = `${line.promptId}\u0000${line.span ?? ''}`;
      let b = by.get(id);
      if (b === undefined) {
        b = { promptId: line.promptId, ...(line.span !== undefined ? { span: line.span } : {}), tried: 0, generated: 0, fellBack: {}, examples: {} };
        by.set(id, b);
      }
      b.tried += 1;
      if (line.mode === 'generated') b.generated += 1;
      else if (line.exactly === true) b.exactly = (b.exactly ?? 0) + 1;
      else if (line.fallback !== undefined) {
        b.fellBack[line.fallback] = (b.fellBack[line.fallback] ?? 0) + 1;
        const text = line.refused ?? (line.error !== undefined ? `${line.error.reason}${line.error.message !== undefined ? `: ${line.error.message}` : ''}` : undefined);
        if (text !== undefined && b.examples[line.fallback] === undefined) b.examples[line.fallback] = text;
      }
    }
  }
  const fell = (b: LineBreakdown): number => Object.values(b.fellBack).reduce((a, n) => a + n, 0);
  return [...by.values()]
    .map(({ examples, ...b }) => {
      const top = Object.entries(b.fellBack).sort(([r1, a], [r2, c]) => c - a || r1.localeCompare(r2)).find(([r]) => examples[r] !== undefined)?.[0];
      return top === undefined ? b : { ...b, example: { reason: top, text: examples[top]! } };
    })
    .sort((a, b) => fell(b) - fell(a) || a.promptId.localeCompare(b.promptId) || (a.span ?? '').localeCompare(b.span ?? ''));
}

/** The API's own words for each reason a request failed, the first time it gave any, from the records scrubbed as the trace scrubs them. */
export function errorMessagesOf(records: readonly TraceRecord[], app: App): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of records) {
    if (!(raw.render?.lines ?? []).some((l) => l.error?.message !== undefined)) continue;
    for (const line of redactRecordSlots(raw, 'length', app).render?.lines ?? []) {
      if (line.error?.message !== undefined && out[line.error.reason] === undefined) out[line.error.reason] = line.error.message;
    }
  }
  return out;
}

/** What a model's run needs besides the model: the app, its fixtures, the decision model, and how. */
export interface BakeoffRun {
  /** The app, registered as the default (the harness reads it so). */
  app: App;
  /** Where the app's recordings are (its fixtures' `recorded`): the render cassettes go to its `render/`. */
  recordedDir: string;
  /** The decision model: the app's recording, and (recording) the model that answers what it lacks. */
  decision: DecisionModel;
  /** True: table from the cassettes alone, asking no model. */
  replay: boolean;
  /** The budget a recording words and checks each line within (tests: a short one); default GENEROUS_BUDGET_MS. */
  recordBudgetMs?: number;
  /**
   * Recording only: ask every line again, recorded into `<cassette>.fresh` (the cassette never moved),
   * renamed over it only when the run completes with no `error` or `timeout` fallback.
   */
  fresh?: boolean;
  /** With `fresh`: a model whose cassette is the app's (isAppCassette) is replaced too, rather than recorded under its comparison name. */
  replaceAppCassette?: boolean;
  /** Whether a cassette is the app's own: git tracks it, or the app's regression replays it. Default: none is. */
  isAppCassette?: (path: string) => boolean;
  /** The settings (the keys among them, never printed); RENDER_TIMEOUT_MS is the call's budget the latency is held to. */
  env: Env;
  thresholds: Thresholds;
  screen?: ScreenMode;
  corpus: CorpusEntry[];
  scenarios: Scenario[];
  prices: ReadonlyMap<string, RenderPrice>;
  /** The fetch the model clients use (tests: a fake provider). */
  fetchFn?: typeof fetch;
  /** Progress, on a recording run (stderr). */
  progress?: (line: string) => void;
}

/** The provider a model's entry resolves to (its key required when recording). */
export function providerOf(spec: ModelSpec, run: Pick<BakeoffRun, 'env' | 'replay'>): RenderProvider {
  return resolveRenderProvider(envForModel(spec, run.env), { needKey: !run.replay })!;
}

/** A model's entry that could not be run: its settings refused before any request. */
function refusedResult(spec: ModelSpec, refused: string): ModelResult {
  return {
    entry: spec.entry, label: spec.entry, provider: spec.provider, model: spec.model, cassette: '', checks: '', status: 'refused', refused,
    tried: 0, generated: 0, fellBack: {}, errors: {}, errorMessages: {}, untried: 0,
    wording: { measured: 0, p50: null, p95: null, overBudget: 0, timedOut: 0 },
    cost: { renderTokens: { input: 0, output: 0 }, renderUsd: null, checkTokens: { input: 0, output: 0 }, checksUsd: 0 },
    decisionMisses: { turns: 0, checks: 0 },
    byLine: [],
  };
}

/** Runs the app's corpus and scripted calls with one model wording its lines (or its cassette replaying them), and tables what came of it. */
export async function runModel(spec: ModelSpec, run: BakeoffRun): Promise<ModelResult> {
  let p: RenderProvider;
  try {
    p = providerOf(spec, run);
  } catch (e) {
    // A thinking the model refuses (renderThinkingOf, as the server refuses it at start): reported for this model, asked of none.
    const why = spec.provider === 'anthropic' && spec.thinking !== undefined ? refusedThinking(spec.model, spec.thinking) : null;
    const refused = why !== null ? `thinking ${spec.thinking} is refused by ${spec.model}: ${why}; leave it out of the entry for the model's own` : e instanceof Error ? e.message : String(e);
    return refusedResult(spec, refused);
  }
  const own = renderCassettePath(run.recordedDir, renderCassetteModel(p));
  const comparison = comparisonCassettePath(own);
  const appOwn = run.isAppCassette?.(own) ?? false;
  const fresh = !run.replay && run.fresh === true;
  // The cassette tabled (and recorded into): the comparison's own name where a fresh run of the app's cassette made one.
  const cassette = fresh ? (appOwn && run.replaceAppCassette !== true ? comparison : own) : existsSync(comparison) ? comparison : own;
  const checksPath = checksCassettePath(run.recordedDir, renderCassetteModel(p), run.decision.provider.model);
  const label = `${spec.provider}:${spec.model}${p.thinking?.overridden ? ` (${thinkingLabel(p.thinking)})` : ''}`;
  const price = run.prices.get(p.model) ?? null;
  const base = { entry: spec.entry, label, provider: p.provider, model: p.model, ...(p.thinking !== undefined ? { thinking: thinkingLabel(p.thinking) } : {}), cassette, checks: checksPath };
  // A partial fresh recording an interrupted run left: said first, whatever this run does.
  const partial = `${cassette}${FRESH_SUFFIX}`;
  const leftover = existsSync(partial) ? { leftover: partial } : {};
  const empty = (): Omit<ModelResult, keyof typeof base | 'status'> => ({
    tried: 0, generated: 0, fellBack: {}, errors: {}, errorMessages: {}, untried: 0,
    wording: { measured: 0, p50: null, p95: null, overBudget: 0, timedOut: 0 },
    cost: { renderTokens: { input: 0, output: 0 }, renderUsd: price === null ? null : 0, checkTokens: { input: 0, output: 0 }, checksUsd: 0 },
    decisionMisses: { turns: 0, checks: 0 },
    byLine: [],
    ...leftover,
  });
  if (run.replay && !existsSync(cassette)) return { ...base, status: 'not-recorded', ...empty() };

  // --fresh: recorded beside the cassette, started empty, so every line is asked (and timed); the cassette is never moved.
  const intoFresh = fresh;
  const recordPath = intoFresh ? partial : cassette;
  if (intoFresh) rmSync(partial, { force: true });
  const unguard = intoFresh ? guardFresh(partial) : () => {};
  const generous = run.recordBudgetMs ?? GENEROUS_BUDGET_MS.voice;
  let used: ReadonlySet<string> = new Set();
  const measured = async (): Promise<ModelResult> => {
    const recording = new RenderCassette(run.replay
      ? { path: recordPath, mode: 'replay', model: p.model }
      : { path: recordPath, mode: 'record', model: p.model, inner: new ModelRenderClient(p, run.fetchFn), budgetMs: generous });
    recording.preload();
    const client = new WatchedRenderClient(recording);
    const decision = decisionFor(run.decision, checksPath, run.replay);
    const checks = new WatchedChecks(decision.client);
    used = decision.used;
    const opts: RunOptions = {
      client: decision.client,
      thresholds: run.thresholds,
      todayIso: REGRESS_TODAY,
      now: () => 0,
      ...(run.screen !== undefined ? { screen: run.screen } : {}),
      renderer: { client, share: 100, timeoutMs: { voice: generous, chat: generous }, checkTimeoutMs: { voice: generous, chat: generous }, price: price ?? DEFAULT_RENDER_PRICE, drift: checks },
    };

    // A model whose every line fails as a request (a wrong id, a key it refuses) is stopped early.
    const running = emptyRenderTally();
    // The decision model failing three turns running (a key it refuses, a timeout) stops the comparison, as it stops a recording regression.
    let decisionErrors = 0;
    const watch = (records: readonly TraceRecord[]): void => {
      for (const r of records) {
        tallyRender(running, r);
        const failed = r.source === 'error' && r.error !== null && !isCassetteMiss(r);
        decisionErrors = failed ? decisionErrors + 1 : 0;
        if (decisionErrors >= 3) throw new DecisionFailed(`the decision model failed 3 turns running: ${r.error!.message}`);
      }
      const failed = running.fellBack.error ?? 0;
      if (running.tried >= STOP_AFTER_ERRORS && failed === running.tried) {
        const why = Object.entries(running.errors).sort(([, a], [, b]) => b - a)[0]?.[0] ?? 'unknown';
        throw new StopModel(why);
      }
    };
    const into: RunAllResult = emptyRunAll();
    let stopped: string | undefined;
    try {
      await runAll(run.corpus, run.scenarios, opts, {
        onCorpus: (done, total, _entry, record) => {
          watch([record]);
          if (!run.replay && done % 25 === 0) run.progress?.(`  ${label}: corpus ${done}/${total}`);
        },
        onScenario: (done, total, scenario, records) => {
          watch(records);
          if (!run.replay) run.progress?.(`  ${label}: scenario ${done}/${total} ${scenario.id}`);
        },
      }, into);
    } catch (e) {
      if (!(e instanceof StopModel)) throw e;
      stopped = e.message;
    }

    const tally: RenderTally = emptyRenderTally();
    for (const r of into.records) tallyRender(tally, r);
    // The wording's latency: each distinct request's, as the bake-off recorded it (only it writes latencyMs),
    // now or in an earlier run; a line that ran past even the bake-off's budget counts at that budget.
    const lines = loadRenderCassette(recordPath);
    const budget = renderSettings(run.env).timeoutMs;
    const ms: number[] = [];
    let overBudget = 0;
    for (const [key, asked] of client.asked) {
      const took = lines.get(key)?.latencyMs;
      if (took === undefined) continue;
      ms.push(took);
      if (took > budget[asked.channel]) overBudget += 1;
    }
    // A request the turn gave up on that never answered ran past even the bake-off's budget: counted at it.
    let timedOut = 0;
    for (const key of client.pastBudget) {
      if (lines.get(key)?.latencyMs !== undefined || !client.asked.has(key)) continue;
      timedOut += 1;
      ms.push(generous);
      overBudget += 1;
    }
    const renderTokens = { ...client.tokens };
    return {
      ...base,
      status: stopped !== undefined ? 'stopped' : 'ran',
      ...(stopped !== undefined ? { stopped } : {}),
      tried: tally.tried,
      generated: tally.generated,
      ...(tally.exactly > 0 ? { exactly: tally.exactly } : {}),
      fellBack: Object.fromEntries(Object.entries(tally.fellBack).filter(([, n]) => (n ?? 0) > 0)) as Record<string, number>,
      errors: tally.errors,
      errorMessages: errorMessagesOf(into.records, run.app),
      untried: tally.skipped,
      wording: { measured: ms.length, p50: quantile(ms, 0.5), p95: quantile(ms, 0.95), overBudget, timedOut },
      cost: {
        renderTokens,
        renderUsd: price === null ? null : (renderTokens.input * price.input + renderTokens.output * price.output) / 1_000_000,
        checkTokens: { ...checks.tokens },
        // The decision model is priced on its input, as the trace prices it (JEV_PRICE_PER_MTOK).
        checksUsd: (checks.tokens.input * run.thresholds.JEV_PRICE_PER_MTOK) / 1_000_000,
      },
      decisionMisses: { turns: into.records.filter((r) => isCassetteMiss(r)).length, checks: checks.misses },
      byLine: lineBreakdown(into.records, run.app),
      ...leftover,
    };
  };
  let result: ModelResult;
  try {
    result = await measured();
  } catch (e) {
    // The model's cassette was never moved: only the partial fresh one goes.
    if (intoFresh) rmSync(partial, { force: true });
    throw e;
  } finally {
    unguard();
  }
  if (intoFresh) {
    // Accepted only when it completed with every line answered: no request failed, none ran out of time.
    const failed = ['error', 'timeout'].filter((r) => (result.fellBack[r] ?? 0) > 0).map((r) => `${r} ${result.fellBack[r]}`);
    const why = result.status === 'stopped' ? `stopped (${result.stopped})` : failed.length > 0 ? failed.join(', ') : null;
    if (why === null) {
      renameSync(partial, cassette);
      result = { ...result, fresh: { kept: true }, ...(cassette === own && appOwn ? { replacedAppCassette: true } : {}) };
    } else {
      rmSync(partial, { force: true });
      result = { ...result, fresh: { kept: false, why } };
    }
  }
  // A recording that completed (and, fresh, was kept) keeps only the checks it asked for.
  if (!run.replay && result.status === 'ran' && (!intoFresh || result.fresh?.kept === true)) {
    const checksPruned = pruneChecks(checksPath, used);
    if (checksPruned > 0) result = { ...result, checksPruned };
  }
  return result;
}

/** What a comparison prints and writes: the app, the decision model, the budgets the latency is held to, and each model's results. */
export interface BakeoffReport {
  app: string;
  /** The decision model, whose answers (and drift checks) are the same for every model. */
  decisionModel: string;
  replay: boolean;
  /** The app's own RENDER_TIMEOUT_MS: what a wording gets on a call, and in a chat. */
  budgetMs: { voice: number; chat: number };
  corpus: number;
  scenarios: number;
  models: ModelResult[];
  /** The budget the recordings were made within (the bake-off's own, GENEROUS_BUDGET_MS): a wording past it is a `timeout`. */
  recordBudgetMs: number;
  /** Why the comparison stopped before its last model (the decision model failing): the models before it are tabled. */
  aborted?: string;
}

const seconds = (ms: number): string => (ms >= 1000 ? `${ms / 1000} s` : `${ms} ms`);
const pct = (n: number, of: number): string => (of === 0 ? '' : ` (${((100 * n) / of).toFixed(0)}%)`);
const usd = (n: number | null): string => (n === null ? 'no price' : `$${n.toFixed(4)}`);
const sum = (r: Record<string, number>): number => Object.values(r).reduce((a, n) => a + n, 0);

/** Why a model's lines fell back, each reason with its count, a request's failures by why: `drift 10, error 3 (anthropic: HTTP 404 not_found_error)`. */
export function reasonsOf(m: Pick<ModelResult, 'fellBack' | 'errors'>): string {
  const why = Object.entries(m.errors).sort(([a, x], [b, y]) => y - x || a.localeCompare(b));
  const errors = why.length === 0 ? '' : ` (${why.length === 1 ? why[0]![0] : why.map(([r, n]) => `${r} ${n}`).join('; ')})`;
  return Object.entries(m.fellBack).sort(([a, x], [b, y]) => y - x || a.localeCompare(b)).map(([r, n]) => `${r} ${n}${r === 'error' ? errors : ''}`).join(', ');
}

/** A model's row, cell by cell, under TABLE_HEAD. */
function row(m: ModelResult, r: Pick<BakeoffReport, 'recordBudgetMs'>): string[] {
  if (m.status === 'not-recorded' || m.status === 'refused') return [m.label, '-', '-', '-', m.status === 'refused' ? 'refused' : 'not recorded', '-', '-', '-', '-'];
  const fell = sum(m.fellBack);
  const latency = m.wording.p50 === null ? 'not measured' : `${m.wording.p50.toFixed(0)} / ${m.wording.p95!.toFixed(0)}`;
  const over = m.wording.measured === 0 ? '-' : `${m.wording.overBudget} of ${m.wording.measured}${m.wording.timedOut > 0 ? ` (${m.wording.timedOut} past ${seconds(r.recordBudgetMs)})` : ''}`;
  const why = [reasonsOf(m), (m.exactly ?? 0) > 0 ? `said exactly ${m.exactly}` : ''].filter((w) => w !== '').join('; ');
  return [m.label, String(m.tried), `${m.generated}${pct(m.generated, m.tried)}`, `${fell}${pct(fell, m.tried)}`, why || '-', latency, over, usd(m.cost.renderUsd), usd(m.cost.checksUsd)];
}

const TABLE_HEAD = ['model', 'tried', 'said generated', 'fell back', 'why', 'wording ms p50 / p95', 'over the call budget', 'cost: wording', 'cost: checks'];

/** The notes under the table: a model not recorded, one stopped, a cassette the decision model missed, a price not given. */
function notes(r: BakeoffReport): string[] {
  const out: string[] = r.aborted !== undefined ? [`the comparison stopped: ${r.aborted}; the models before it are tabled`] : [];
  for (const m of r.models) {
    if (m.leftover !== undefined) out.push(`${m.label}: an interrupted --fresh run left ${m.leftover} (partial, never tabled)${m.fresh !== undefined ? '; this fresh run replaced it' : '; delete it'}`);
    if (m.status === 'not-recorded') out.push(`${m.label}: not recorded (no ${m.cassette}); run without --replay to record it`);
    if (m.status === 'refused') out.push(`${m.label}: refused, nothing asked: ${m.refused}`);
    if (m.status === 'stopped') out.push(`${m.label}: stopped after ${m.tried} lines, every one a failed request: ${m.stopped}${m.stopped !== undefined && m.errorMessages[m.stopped] !== undefined ? ` (${m.errorMessages[m.stopped]})` : ''}`);
    // Why the requests failed, in the API's own words (each reason once): a stopped run's is on its line above.
    for (const [reason, message] of Object.entries(m.errorMessages)) if (!(m.status === 'stopped' && reason === m.stopped)) out.push(`${m.label}: error ${reason}: ${message}`);
    if (m.fresh?.kept === true) out.push(`${m.label}: --fresh: every line asked again, recorded into ${m.cassette}`);
    if (m.fresh?.kept === false) out.push(`${m.label}: --fresh: not kept (${m.fresh.why}): ${m.cassette} is as it was, the fresh recording discarded; the table is the fresh run's`);
    if (m.replacedAppCassette === true) out.push(`${m.label}: replaced the app's own cassette: the app's recording has no drift checks of the new wordings, so regress --client recorded falls back on them (drift-error) until the owner records again (regress --client record)`);
    if (m.checksPruned !== undefined) out.push(`${m.label}: ${m.checksPruned} checks of wordings no longer recorded dropped from ${m.checks}`);
    if (m.wording.timedOut > 0) out.push(`${m.label}: ${m.wording.timedOut} wordings ran past the bake-off's own ${seconds(r.recordBudgetMs)} (timeout): counted over the call budget, and at ${seconds(r.recordBudgetMs)} in the percentiles`);
    if (m.untried > 0) out.push(`${m.label}: ${m.untried} lines said fixed untried (their when, locale or the screen)`);
    if (m.decisionMisses.turns + m.decisionMisses.checks > 0) out.push(`${m.label}: the decision model's recording missed ${m.decisionMisses.turns} turns and ${m.decisionMisses.checks} checks (drift-error); record without --replay`);
    if (m.status !== 'not-recorded' && m.status !== 'refused' && m.cost.renderUsd === null && m.cost.renderTokens.input + m.cost.renderTokens.output > 0) out.push(`${m.label}: wording ${m.cost.renderTokens.input} input and ${m.cost.renderTokens.output} output tokens, no price given (--price ${m.model}=<input>,<output>)`);
  }
  return out;
}

/** The comparison as text: a header, one row per model, its notes, and with `byLine` each model's lines, most fallbacks first. */
export function formatBakeoff(r: BakeoffReport, opts: { byLine?: boolean } = {}): string[] {
  const rows = [TABLE_HEAD, ...r.models.map((m) => row(m, r))];
  const widths = TABLE_HEAD.map((_, i) => Math.max(...rows.map((c) => c[i]!.length)));
  const out = [
    `generated lines of ${r.app}: ${r.corpus} corpus lines and ${r.scenarios} scripted calls, each model in turn${r.replay ? ', replayed from its render cassette' : ''}`,
    `the decision model ${r.decisionModel} answers every turn from the app's recording and judges every line (the same drift check for each model)`,
    `the call budget: RENDER_TIMEOUT_MS ${budgetText(r.budgetMs)}; wordings are measured only when recorded`,
    '',
    ...rows.map((c) => c.map((cell, i) => cell.padEnd(widths[i]!)).join('  ').trimEnd()),
  ];
  const n = notes(r);
  if (n.length > 0) out.push('', ...n);
  if (opts.byLine) for (const m of r.models) out.push(...byLineText(m));
  return out;
}

function budgetText(b: BakeoffReport['budgetMs']): string {
  return b.voice === b.chat ? `${b.voice} ms` : `${b.voice} ms on a call, ${b.chat} ms in a chat`;
}

function lineName(l: LineBreakdown): string {
  return l.span !== undefined ? `${l.promptId}.${l.span}` : l.promptId;
}

function byLineText(m: ModelResult): string[] {
  if (m.status === 'not-recorded' || m.byLine.length === 0) return [];
  const width = Math.max(...m.byLine.map((l) => lineName(l).length));
  return ['', `${m.label}, by line (most fallbacks first):`, ...m.byLine.map((l) => {
    const fell = sum(l.fellBack);
    const why = fell === 0 ? '' : `: ${Object.entries(l.fellBack).sort(([a, x], [b, y]) => y - x || a.localeCompare(b)).map(([k, v]) => `${k} ${v}`).join(', ')}`;
    const e = l.example === undefined ? '' : `  e.g. ${l.example.reason}: "${l.example.text}"`;
    return `  ${lineName(l).padEnd(width)}  ${l.tried} tried, ${l.generated} generated, ${(l.exactly ?? 0) > 0 ? `${l.exactly} said exactly, ` : ''}${fell} fell back${why}${e}`;
  })];
}

/** A cell for a Markdown table: one line, its pipes escaped. */
const md = (s: string): string => s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');

/** The comparison as a Markdown page (`--out`): the same table, its notes, and with `byLine` each model's lines. */
export function formatBakeoffMarkdown(r: BakeoffReport, opts: { byLine?: boolean } = {}): string {
  const out = [
    `# Render models compared on ${r.app}`,
    '',
    `${r.corpus} corpus lines and ${r.scenarios} scripted calls, each model in turn${r.replay ? ', replayed from its render cassette' : ''}. The decision model ${r.decisionModel} answers every turn from the app's recording and judges every line: the same drift check for each model. The call budget: RENDER_TIMEOUT_MS ${budgetText(r.budgetMs)}; wordings are measured only when recorded.`,
    '',
    `| ${TABLE_HEAD.join(' | ')} |`,
    `| ${TABLE_HEAD.map(() => '---').join(' | ')} |`,
    ...r.models.map((m) => `| ${row(m, r).map(md).join(' | ')} |`),
  ];
  const n = notes(r);
  if (n.length > 0) out.push('', ...n.map((l) => `- ${md(l)}`));
  if (opts.byLine) {
    for (const m of r.models) {
      if (m.status === 'not-recorded' || m.byLine.length === 0) continue;
      out.push('', `## ${md(m.label)}, by line`, '', '| line | tried | generated | fell back | an example |', '| --- | --- | --- | --- | --- |');
      for (const l of m.byLine) {
        const fell = sum(l.fellBack);
        const why = fell === 0 ? '0' : `${fell}: ${Object.entries(l.fellBack).sort(([a, x], [b, y]) => y - x || a.localeCompare(b)).map(([k, v]) => `${k} ${v}`).join(', ')}`;
        out.push(`| ${md(lineName(l))} | ${l.tried} | ${l.generated} | ${md(why)} | ${l.example === undefined ? '' : md(`${l.example.reason}: "${l.example.text}"`)} |`);
      }
    }
  }
  return `${out.join('\n')}\n`;
}

/** The comparison as JSON (`--json`): the report, each model's lines left out unless `byLine`. */
export function bakeoffJson(r: BakeoffReport, opts: { byLine?: boolean } = {}): string {
  const report = opts.byLine ? r : { ...r, models: r.models.map(({ byLine: _, ...m }) => m) };
  return JSON.stringify(report, null, 2);
}
