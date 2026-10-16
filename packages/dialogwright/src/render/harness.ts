import type { App } from '../core/app/types';
import { defaultAppId, getApp } from '../core/app/registry';
import { recordedDir } from '../run/fixtures';
import type { TraceRecord } from '../trace/types';
import { generatesLines } from './config';
import { RenderCassette, renderCassettePath } from './cassette';
import { FakeRenderClient } from './fake';
import { appModelKeyMissing, appModelLabel, ModelRenderClient, renderCassetteModel, renderEnvOf, renderLines, renderSettings, resolveAppRenderProvider, resolveRenderProvider, type RenderProvider } from './providers';
import type { RenderFallback, Renderer } from './types';

/**
 * How a regression run words the lines an app generates (generated wording, design section 5), by its
 * client kind: on the stubs, the fake renderer (no model, the same words every time); `recorded`,
 * the render cassette of the model RENDER_PROVIDER and RENDER_MODEL name over the app's own
 * (style.yaml's `model`; with neither, Anthropic's default model), replayed, every check run again on
 * every line; `record` and `jev`, the model itself, `record` appending to the cassette (the
 * maintainer's step, with the author's own key; with the app's own model and its key unset, its
 * lines are said fixed, and the header says why). `--render fixed` says every line fixed; `--render
 * recorded` replays the render cassette on any client but the stubs, so the decision model can be
 * recorded again without asking the render model. Null for an
 * app that generates no line: the run is exactly as before.
 */
export function harnessRenderer(kind: string, app: App, recordedDir: string, opts: { render?: string; env?: Record<string, string | undefined> } = {}): { renderer: Renderer | null; header: string[] } {
  if (!generatesLines(app)) return { renderer: null, header: [] };
  const env = opts.env ?? process.env;
  if (opts.render === 'fixed') return { renderer: null, header: ['generated lines said fixed (--render fixed)'] };
  if (opts.render !== undefined && opts.render !== 'fixed' && opts.render !== 'recorded') throw new Error(`--render must be fixed or recorded, got "${opts.render}"`);
  const settings = renderSettings(env);
  // `--render recorded` replays the render cassette whatever the client: a recording of the decision
  // model after a change to its questions words the lines as they were recorded, with no render key
  // and no render model asked (a line the cassette does not hold is a miss, as on a recorded run).
  if (opts.render === 'recorded' && kind !== 'stub' && kind !== 'heuristic') {
    const p = replayedRenderProvider(app, env);
    const client = new RenderCassette({ path: renderCassettePath(recordedDir, renderCassetteModel(p)), mode: 'replay', model: p.model });
    client.preload();
    return { renderer: { client, share: settings.share, timeoutMs: settings.timeoutMs, checkTimeoutMs: settings.checkTimeoutMs, answerTimeoutMs: settings.answerTimeoutMs, price: settings.price }, header: [...renderLines(p, { replayed: true }), `render cassette ${client.path} (--render recorded)`] };
  }
  if (kind === 'stub' || kind === 'heuristic') {
    return { renderer: { client: new FakeRenderClient(), share: settings.share, timeoutMs: settings.timeoutMs, checkTimeoutMs: settings.checkTimeoutMs, answerTimeoutMs: settings.answerTimeoutMs, price: settings.price }, header: renderLines(null, { fake: true }) };
  }
  // The app's own model (style.yaml's `model`) under the environment's settings.
  const model = app.generated?.model;
  if (kind === 'recorded') {
    const p = replayedRenderProvider(app, env);
    const client = new RenderCassette({ path: renderCassettePath(recordedDir, renderCassetteModel(p)), mode: 'replay', model: p.model });
    client.preload();
    return { renderer: { client, share: settings.share, timeoutMs: settings.timeoutMs, checkTimeoutMs: settings.checkTimeoutMs, answerTimeoutMs: settings.answerTimeoutMs, price: settings.price }, header: [...renderLines(p, { replayed: true }), `render cassette ${client.path}`] };
  }
  const missing = appModelKeyMissing(env, model);
  // A run with the app's own model and no key says its lines fixed, as a server does, and says why.
  if (missing !== null) return { renderer: null, header: [`generated lines said fixed (${appModelLabel(model!)}, and ${missing} is unset)`] };
  const p = resolveAppRenderProvider(env, model);
  if (p === null) return { renderer: null, header: renderLines(null) };
  const live = new ModelRenderClient(p);
  const client = kind === 'record' ? new RenderCassette({ path: renderCassettePath(recordedDir, renderCassetteModel(p)), mode: 'record', model: p.model, inner: live }) : live;
  return { renderer: { client, share: settings.share, timeoutMs: settings.timeoutMs, checkTimeoutMs: settings.checkTimeoutMs, answerTimeoutMs: settings.answerTimeoutMs, price: settings.price }, header: [...renderLines(p), ...(client instanceof RenderCassette ? [`render cassette ${client.path}`] : [])] };
}

/**
 * The render model a recorded regression of `app` replays (`regress --client recorded`): RENDER_PROVIDER
 * and RENDER_MODEL over the model the app names (style.yaml's `model`), and with neither Anthropic's
 * default model. No key is needed: a replay sends nothing. Throws on a setting the server would refuse.
 */
export function replayedRenderProvider(app: App, env: Record<string, string | undefined> = process.env): RenderProvider {
  return resolveRenderProvider({ RENDER_PROVIDER: 'anthropic', ...renderEnvOf(env, app.generated?.model) }, { needKey: false })!;
}

/** The render cassette a recorded regression of `app` replays (replayedRenderProvider): what `render:bakeoff` keeps as the app's own. */
export function replayedRenderCassette(app: App, recordedDir: string, env: Record<string, string | undefined> = process.env): string {
  return renderCassettePath(recordedDir, renderCassetteModel(replayedRenderProvider(app, env)));
}

/**
 * The renderer an app's own test runs its scripted calls with, the one its stub regression uses
 * (harnessRenderer on the stub: the fake renderer, RENDER_SHARE and the budgets read from the
 * environment as `regress` reads them), so a call that passes `regress` passes its tests: a line said
 * generated, or in its frame for the exact words (`exactText`), is said the same in both. Null for an
 * app that generates no line (pass it as RunOptions.renderer all the same: the run is as before).
 * `app`: the default registered app's, unless given.
 */
export function stubRenderer(app: App = getApp(defaultAppId()), env: Record<string, string | undefined> = process.env): Renderer | null {
  return harnessRenderer('stub', app, recordedDir(app), { env }).renderer;
}

/** What a run's generated lines came to: how many were tried, said generated, and fell back, by reason. */
export interface RenderTally {
  tried: number;
  generated: number;
  /** Spans whose wording was their content word for word, said unchanged (RenderLine.unchanged): tried, neither generated nor a fallback. */
  unchanged: number;
  fellBack: Partial<Record<RenderFallback, number>>;
  /** Lines the app generates that were said fixed without being tried (RENDER_SHARE, `when`, a locale, the screen). */
  skipped: number;
  costUsd: number;
  /** The lines that fell back as `error`, by why the request failed (RenderLine.error.reason). */
  errors: Record<string, number>;
  /** How long each line tried took, its wording and its checks, ms: the run's latency per line. */
  ms: number[];
}

export function emptyRenderTally(): RenderTally {
  return { tried: 0, generated: 0, unchanged: 0, fellBack: {}, skipped: 0, costUsd: 0, errors: {}, ms: [] };
}

/** Adds a trace record's generated lines to `tally`. */
export function tallyRender(tally: RenderTally, record: TraceRecord): void {
  for (const line of record.render?.lines ?? []) {
    if (line.skipped !== undefined) {
      tally.skipped += 1;
      continue;
    }
    tally.tried += 1;
    if (line.ms !== undefined) tally.ms.push(line.ms);
    if (line.mode === 'generated') tally.generated += 1;
    else if (line.unchanged === true) tally.unchanged += 1;
    else if (line.fallback !== undefined) tally.fellBack[line.fallback] = (tally.fellBack[line.fallback] ?? 0) + 1;
    if (line.fallback === 'error') {
      const why = line.error?.reason ?? 'unknown';
      tally.errors[why] = (tally.errors[why] ?? 0) + 1;
    }
  }
  tally.costUsd += record.render?.usage?.costUsd ?? 0;
}

/** The value at fraction `q` of `xs`, by rank. */
function quantile(xs: readonly number[], q: number): number {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
}

/**
 * The run's line about its generated lines: tried, said generated, the fallback rate and its reasons
 * (a request's failures by why: `error 36 (anthropic: HTTP 400 invalid_request_error)`), and how long a
 * line tried took, its wording and its checks (p50 and p95, ms; a replay's wording takes none).
 */
export function formatRenderTally(t: RenderTally): string {
  const fell = Object.values(t.fellBack).reduce((a, b) => a + (b ?? 0), 0);
  const rate = t.tried === 0 ? 0 : (100 * fell) / t.tried;
  const why = Object.entries(t.errors).sort(([a, x], [b, y]) => y - x || a.localeCompare(b));
  const errors = why.length === 0 ? '' : ` (${why.length === 1 ? why[0]![0] : why.map(([r, n]) => `${r} ${n}`).join('; ')})`;
  const reasons = Object.entries(t.fellBack).sort(([a], [b]) => a.localeCompare(b)).map(([r, n]) => `${r} ${n}${r === 'error' ? errors : ''}`).join(', ');
  const latency = t.ms.length > 0 ? `; latency ms p50 ${quantile(t.ms, 0.5).toFixed(0)} p95 ${quantile(t.ms, 0.95).toFixed(0)}` : '';
  return `generated lines  ${t.tried} tried, ${t.generated} said generated, ${t.unchanged > 0 ? `${t.unchanged} said unchanged (the wording was the words themselves), ` : ''}${fell} fell back (${rate.toFixed(1)}%)${reasons ? `: ${reasons}` : ''}${t.skipped > 0 ? `; ${t.skipped} said fixed untried` : ''}${latency}`;
}
