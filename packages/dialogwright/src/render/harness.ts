import type { App } from '../core/app/types';
import { defaultAppId, getApp } from '../core/app/registry';
import { recordedDir } from '../run/fixtures';
import type { TraceRecord } from '../trace/types';
import { generatesLines } from './config';
import { RenderCassette, renderCassettePath } from './cassette';
import { FakeRenderClient } from './fake';
import { ModelRenderClient, renderCassetteModel, renderLines, renderSettings, resolveRenderProvider } from './providers';
import type { RenderFallback, Renderer } from './types';

/**
 * How a regression run words the lines an app generates (generated wording, design section 5), by its
 * client kind: on the stubs, the fake renderer (no model, the same words every time); `recorded`,
 * the render cassette of the model RENDER_PROVIDER and RENDER_MODEL name (default Anthropic's
 * default model), replayed, every check run again on every line; `record` and `jev`, the model itself,
 * `record` appending to the cassette (the maintainer's step, with the author's own key). `--render
 * fixed` says every line fixed. Null for an app that generates no line: the run is exactly as before.
 */
export function harnessRenderer(kind: string, app: App, recordedDir: string, opts: { render?: string; env?: Record<string, string | undefined> } = {}): { renderer: Renderer | null; header: string[] } {
  if (!generatesLines(app)) return { renderer: null, header: [] };
  const env = opts.env ?? process.env;
  if (opts.render === 'fixed') return { renderer: null, header: ['generated lines said fixed (--render fixed)'] };
  if (opts.render !== undefined && opts.render !== 'fixed') throw new Error(`--render must be fixed, got "${opts.render}"`);
  const settings = renderSettings(env);
  if (kind === 'stub' || kind === 'heuristic') {
    return { renderer: { client: new FakeRenderClient(), share: settings.share, timeoutMs: settings.timeoutMs, checkTimeoutMs: settings.checkTimeoutMs, price: settings.price }, header: renderLines(null, { fake: true }) };
  }
  if (kind === 'recorded') {
    const p = resolveRenderProvider({ RENDER_PROVIDER: 'anthropic', ...env }, { needKey: false })!;
    const client = new RenderCassette({ path: renderCassettePath(recordedDir, renderCassetteModel(p)), mode: 'replay', model: p.model });
    client.preload();
    return { renderer: { client, share: settings.share, timeoutMs: settings.timeoutMs, checkTimeoutMs: settings.checkTimeoutMs, price: settings.price }, header: [...renderLines(p, { replayed: true }), `render cassette ${client.path}`] };
  }
  const p = resolveRenderProvider(env);
  if (p === null) return { renderer: null, header: renderLines(null) };
  const live = new ModelRenderClient(p);
  const client = kind === 'record' ? new RenderCassette({ path: renderCassettePath(recordedDir, renderCassetteModel(p)), mode: 'record', model: p.model, inner: live }) : live;
  return { renderer: { client, share: settings.share, timeoutMs: settings.timeoutMs, checkTimeoutMs: settings.checkTimeoutMs, price: settings.price }, header: [...renderLines(p), ...(client instanceof RenderCassette ? [`render cassette ${client.path}`] : [])] };
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
  /** Spans whose wording was their content word for word, said exactly (RenderLine.exactly): tried, neither generated nor a fallback. */
  exactly: number;
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
  return { tried: 0, generated: 0, exactly: 0, fellBack: {}, skipped: 0, costUsd: 0, errors: {}, ms: [] };
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
    else if (line.exactly === true) tally.exactly += 1;
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
  return `generated lines  ${t.tried} tried, ${t.generated} said generated, ${t.exactly > 0 ? `${t.exactly} said exactly (the wording was the words themselves), ` : ''}${fell} fell back (${rate.toFixed(1)}%)${reasons ? `: ${reasons}` : ''}${t.skipped > 0 ? `; ${t.skipped} said fixed untried` : ''}${latency}`;
}
