import type { TraceRecord } from '../../trace/types';

/**
 * Insights' figures for generated wording (design section 5, "measured, not assumed"): what a call of an
 * app that generates lines adds (RenderCallFacts, read from its trace), summed by the hour like every
 * other figure (RenderFigures, HourFigures.render), and said for the range (WordingInsights): the two
 * groups RENDER_SHARE serves, generated and fixed, side by side (containment, re-asks, frustration, call
 * length, cost), and each generated line's fallback rate and latency. Counts, durations and dollars
 * only; never a line's words. Absent for an app that generates nothing, and in figures written before.
 */

/** One generated line over a range: tried, said generated, fell back, and the time its rendering took (summed). */
export interface PromptRenderFigures {
  tried: number;
  generated: number;
  fellBack: number;
  ms: number;
}

/** What one call of an app that generates lines adds: its group, and what is compared between the groups. */
export interface RenderCallFacts {
  group: 'generated' | 'fixed';
  /** Questions asked again after an answer that did not fill them (as the struggles count them). */
  reasks: number;
  /** Turns the frustration gate found the caller frustrated on. */
  frustrated: number;
  /** What the generated lines cost. */
  costUsd: number;
  /** By prompt id. */
  prompts: Record<string, PromptRenderFigures>;
}

/** One group's figures: the calls, how they ended, and what they took. */
export interface GroupFigures {
  calls: number;
  ended: number;
  contained: number;
  reasks: number;
  /** Calls with at least one frustrated turn, and the frustrated turns. */
  frustratedCalls: number;
  frustratedTurns: number;
  /** Of the calls that ended, their lengths summed. */
  lengthMs: number;
  /** Every model's cost on the group's calls: the decision model's and the generated lines'. */
  costUsd: number;
}

/** An hour's (or a range's) generated-wording figures. */
export interface RenderFigures {
  groups: { generated: GroupFigures; fixed: GroupFigures };
  prompts: Record<string, PromptRenderFigures>;
  /** What the generated lines cost, both groups. */
  costUsd: number;
}

const emptyGroup = (): GroupFigures => ({ calls: 0, ended: 0, contained: 0, reasks: 0, frustratedCalls: 0, frustratedTurns: 0, lengthMs: 0, costUsd: 0 });
export const emptyRenderFigures = (): RenderFigures => ({ groups: { generated: emptyGroup(), fixed: emptyGroup() }, prompts: {}, costUsd: 0 });

const FRUSTRATED = new Set(['ack', 'offer', 'handoff']);

/**
 * What a call adds to the generated-wording figures, from its records as on disk; null for a call with no
 * render record (an app that generates nothing, or a run with no renderer). `reasks` is the call's
 * struggles' re-asks, counted as Insights counts them.
 */
export function renderFactsOf(records: readonly TraceRecord[], reasks: number): RenderCallFacts | null {
  const first = records.find((r) => r.render !== undefined);
  if (first === undefined) return null;
  const facts: RenderCallFacts = { group: first.render!.group, reasks, frustrated: 0, costUsd: 0, prompts: {} };
  for (const r of records) {
    if (r.outlivedHold === true) continue;
    if ((r.gates ?? []).some((g) => g.gate === 'frustration' && FRUSTRATED.has(g.outcome))) facts.frustrated += 1;
    if (r.render === undefined) continue;
    facts.costUsd += r.render.usage?.costUsd ?? 0;
    for (const l of r.render.lines) {
      if (l.skipped !== undefined) continue;
      const p = (facts.prompts[l.promptId] ??= { tried: 0, generated: 0, fellBack: 0, ms: 0 });
      p.tried += 1;
      if (l.mode === 'generated') p.generated += 1;
      // A span said unchanged (its wording was its content word for word) is no fallback.
      else if (l.unchanged !== true) p.fellBack += 1;
      p.ms += l.ms ?? 0;
    }
  }
  return facts;
}

function addPrompts(into: Record<string, PromptRenderFigures>, from: Record<string, PromptRenderFigures>): void {
  for (const [id, p] of Object.entries(from)) {
    const t = (into[id] ??= { tried: 0, generated: 0, fellBack: 0, ms: 0 });
    t.tried += p.tried; t.generated += p.generated; t.fellBack += p.fellBack; t.ms += p.ms;
  }
}

/** Adds one call to an hour's figures: its group's, and its lines'. `ending` is how it ended (null in progress); `lengthMs` and `costUsd` (every model's) are its row's. */
export function addRenderCall(into: RenderFigures, facts: RenderCallFacts, call: { ending: string | null; lengthMs: number; costUsd: number }): void {
  const g = into.groups[facts.group];
  g.calls += 1;
  if (call.ending !== null) {
    g.ended += 1;
    if (call.ending === 'handled') g.contained += 1;
    g.lengthMs += call.lengthMs;
  }
  g.reasks += facts.reasks;
  g.frustratedTurns += facts.frustrated;
  if (facts.frustrated > 0) g.frustratedCalls += 1;
  g.costUsd += call.costUsd;
  into.costUsd += facts.costUsd;
  addPrompts(into.prompts, facts.prompts);
}

/** Two figures added. */
export function sumRender(into: RenderFigures, from: RenderFigures): void {
  for (const k of ['generated', 'fixed'] as const) {
    const a = into.groups[k];
    const b = from.groups[k];
    for (const f of ['calls', 'ended', 'contained', 'reasks', 'frustratedCalls', 'frustratedTurns', 'lengthMs', 'costUsd'] as const) a[f] += b[f];
  }
  into.costUsd += from.costUsd;
  addPrompts(into.prompts, from.prompts);
}

const count = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isMap = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** An hour's generated-wording figures as a file holds them, every number checked; null for anything malformed. */
export function renderFiguresOf(raw: unknown): RenderFigures | null {
  if (!isMap(raw) || !isMap(raw.groups) || !isMap(raw.prompts) || !count(raw.costUsd)) return null;
  const out = emptyRenderFigures();
  for (const k of ['generated', 'fixed'] as const) {
    const g = (raw.groups as Record<string, unknown>)[k];
    if (!isMap(g)) return null;
    for (const f of ['calls', 'ended', 'contained', 'reasks', 'frustratedCalls', 'frustratedTurns', 'lengthMs', 'costUsd'] as const) {
      if (!count(g[f])) return null;
      out.groups[k][f] = g[f] as number;
    }
  }
  for (const [id, p] of Object.entries(raw.prompts as Record<string, unknown>)) {
    if (!isMap(p) || !count(p.tried) || !count(p.generated) || !count(p.fellBack) || !count(p.ms) || id.length > 120) return null;
    out.prompts[id] = { tried: p.tried, generated: p.generated, fellBack: p.fellBack, ms: p.ms };
  }
  out.costUsd = raw.costUsd;
  return out;
}

/** One group, said: what Insights shows side by side. Each rate null with nothing to count it over. */
export interface GroupInsight {
  calls: number;
  containment: number | null;
  /** Re-asks a call. */
  reasksPerCall: number | null;
  /** The share of calls with a frustrated turn. */
  frustratedShare: number | null;
  meanLengthMs: number | null;
  costPerCall: number | null;
}

/** Generated wording over a range: the two groups compared, each generated line's fallback rate and latency, and what the lines cost. */
export interface WordingInsights {
  generated: GroupInsight;
  fixed: GroupInsight;
  /** By prompt id, the most tried first. */
  prompts: { app: string | null; promptId: string; tried: number; generated: number; fallbackRate: number | null; meanMs: number | null }[];
  costUsd: number;
}

function groupInsight(g: GroupFigures): GroupInsight {
  return {
    calls: g.calls,
    containment: g.ended === 0 ? null : g.contained / g.ended,
    reasksPerCall: g.calls === 0 ? null : g.reasks / g.calls,
    frustratedShare: g.calls === 0 ? null : g.frustratedCalls / g.calls,
    meanLengthMs: g.ended === 0 ? null : Math.round(g.lengthMs / g.ended),
    costPerCall: g.calls === 0 ? null : g.costUsd / g.calls,
  };
}

/** The range's generated wording, each app's figures given with its name where there are several; null when no app's calls had any. */
export function wordingInsightsOf(apps: readonly { name: string | null; render: RenderFigures | undefined }[]): WordingInsights | null {
  const withRender = apps.filter((a) => a.render !== undefined);
  if (withRender.length === 0) return null;
  const all = emptyRenderFigures();
  for (const a of withRender) sumRender(all, a.render!);
  const prompts = withRender.flatMap((a) => Object.entries(a.render!.prompts).map(([promptId, p]) => ({
    app: a.name,
    promptId,
    tried: p.tried,
    generated: p.generated,
    fallbackRate: p.tried === 0 ? null : p.fellBack / p.tried,
    meanMs: p.tried === 0 ? null : Math.round(p.ms / p.tried),
  }))).sort((x, y) => y.tried - x.tried || x.promptId.localeCompare(y.promptId));
  return { generated: groupInsight(all.groups.generated), fixed: groupInsight(all.groups.fixed), prompts, costUsd: Math.round(all.costUsd * 1e6) / 1e6 };
}
