import type { App } from '../core/app/types';
import type { TraceRecord } from '../trace/types';
import { generatesLines } from './config';
import { RenderCassette, renderCassettePath } from './cassette';
import { FakeRenderClient } from './fake';
import { ModelRenderClient, renderLines, renderSettings, resolveRenderProvider } from './providers';
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
    const client = new RenderCassette({ path: renderCassettePath(recordedDir, p.model), mode: 'replay', model: p.model });
    client.preload();
    return { renderer: { client, share: settings.share, timeoutMs: settings.timeoutMs, checkTimeoutMs: settings.checkTimeoutMs, price: settings.price }, header: [...renderLines(p, { replayed: true }), `render cassette ${client.path}`] };
  }
  const p = resolveRenderProvider(env);
  if (p === null) return { renderer: null, header: renderLines(null) };
  const live = new ModelRenderClient(p);
  const client = kind === 'record' ? new RenderCassette({ path: renderCassettePath(recordedDir, p.model), mode: 'record', model: p.model, inner: live }) : live;
  return { renderer: { client, share: settings.share, timeoutMs: settings.timeoutMs, checkTimeoutMs: settings.checkTimeoutMs, price: settings.price }, header: renderLines(p) };
}

/** What a run's generated lines came to: how many were tried, said generated, and fell back, by reason. */
export interface RenderTally {
  tried: number;
  generated: number;
  fellBack: Partial<Record<RenderFallback, number>>;
  /** Lines the app generates that were said fixed without being tried (RENDER_SHARE, `when`, a locale, the screen). */
  skipped: number;
  costUsd: number;
}

export function emptyRenderTally(): RenderTally {
  return { tried: 0, generated: 0, fellBack: {}, skipped: 0, costUsd: 0 };
}

/** Adds a trace record's generated lines to `tally`. */
export function tallyRender(tally: RenderTally, record: TraceRecord): void {
  for (const line of record.render?.lines ?? []) {
    if (line.skipped !== undefined) {
      tally.skipped += 1;
      continue;
    }
    tally.tried += 1;
    if (line.mode === 'generated') tally.generated += 1;
    else if (line.fallback !== undefined) tally.fellBack[line.fallback] = (tally.fellBack[line.fallback] ?? 0) + 1;
  }
  tally.costUsd += record.render?.usage?.costUsd ?? 0;
}

/** The run's line about its generated lines: tried, said generated, the fallback rate and its reasons. */
export function formatRenderTally(t: RenderTally): string {
  const fell = Object.values(t.fellBack).reduce((a, b) => a + (b ?? 0), 0);
  const rate = t.tried === 0 ? 0 : (100 * fell) / t.tried;
  const reasons = Object.entries(t.fellBack).sort(([a], [b]) => a.localeCompare(b)).map(([r, n]) => `${r} ${n}`).join(', ');
  return `generated lines  ${t.tried} tried, ${t.generated} said generated, ${fell} fell back (${rate.toFixed(1)}%)${reasons ? `: ${reasons}` : ''}${t.skipped > 0 ? `; ${t.skipped} said fixed untried` : ''}`;
}
