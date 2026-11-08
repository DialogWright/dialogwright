import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { agentMessages } from './prompt';
import { parseAgentAnswer } from './schema';
import type { AgentClient, AgentContext, AgentResult } from './types';

/**
 * The agent model's answers recorded and replayed, as the decision model's and the render model's are:
 * one JSON Lines file per model, each line keyed by a hash of the messages the model was sent
 * (agentMessages), holding the model's text as given. A replay parses that text again, so a change to
 * the answer's schema is felt on replay as it would be live. A turn the model did not answer within its
 * budget is recorded as a timeout, since that is what was measured; a failed request (an API error, a
 * key refused) is never recorded, so it is asked again. The same messages asked more than once (the
 * bake-off's `--repeat`) take the recorded lines in turn. Recording is the author's step, with their own
 * key; no test and no CI run records.
 */

export interface AgentCassetteLine {
  v: 1;
  key: string;
  model: string;
  /** The model's text as given (valid or not). */
  raw?: string;
  /** A turn with no text: a timeout. */
  failed?: { reason: 'timeout'; detail: string };
  ms: number;
  usage?: { inputTokens: number; outputTokens: number };
  costUsd?: number;
  recordedAt: string;
}

/** The key the messages of `ctx` are recorded under. */
export function agentKey(ctx: AgentContext): string {
  const { system, user } = agentMessages(ctx);
  return createHash('sha256').update(system).update('\u0000').update(user).digest('hex').slice(0, 32);
}

/** A cassette's lines by key, in the order recorded. A missing file is an empty cassette. */
export function loadAgentCassette(path: string): Map<string, AgentCassetteLine[]> {
  const out = new Map<string, AgentCassetteLine[]>();
  if (!existsSync(path)) return out;
  readFileSync(path, 'utf8').split('\n').forEach((text, i) => {
    if (text.trim() === '') return;
    let l: Partial<AgentCassetteLine> | null;
    try {
      l = JSON.parse(text) as Partial<AgentCassetteLine> | null;
    } catch {
      throw new Error(`agent cassette ${path} line ${i + 1}: not JSON; the file is append-only, delete this line and record again`);
    }
    if (!l || l.v !== 1 || typeof l.key !== 'string' || typeof l.model !== 'string' || typeof l.ms !== 'number' || (typeof l.raw !== 'string' && l.failed?.reason !== 'timeout')) {
      throw new Error(`agent cassette ${path} line ${i + 1}: expected v:1 with key, model, ms and raw or failed; the file is append-only, delete this line and record again`);
    }
    const lines = out.get(l.key) ?? [];
    lines.push(l as AgentCassetteLine);
    out.set(l.key, lines);
  });
  return out;
}

export interface AgentCassetteOptions {
  /** Record what the cassette lacks by asking this client (the author's own key); absent, a replay. */
  record?: AgentClient;
  /** The model the cassette is of, for a run's header; default the recording client's. */
  model?: string;
  now?: () => number;
}

/** What a recorded line replays as, its text parsed for this turn's actions and fields. */
function replayed(line: AgentCassetteLine, ctx: AgentContext): AgentResult {
  const paid = { ...(line.usage !== undefined ? { usage: { ...line.usage } } : {}), ...(line.costUsd !== undefined ? { costUsd: line.costUsd } : {}) };
  if (line.raw === undefined) return { ok: false, reason: 'timeout', detail: line.failed?.detail ?? 'timeout (recorded)', ms: line.ms, ...paid };
  const parsed = parseAgentAnswer(line.raw, ctx.actions.map((a) => a.name), ctx.fields.map((f) => f.name));
  return parsed.ok ? { ok: true, answer: parsed.answer, ms: line.ms, raw: line.raw, ...paid } : { ok: false, reason: 'invalid', detail: parsed.detail, ms: line.ms, raw: line.raw, ...paid };
}

/** The detail of a replay's miss. */
export const AGENT_CASSETTE_MISS = 'cassette miss';

/**
 * Replays the answers recorded at `path`; with `record`, asks that client what the cassette lacks and
 * appends it. A replay's miss is `{ ok: false, reason: 'error', detail: 'cassette miss' }`.
 */
export function cassetteAgent(path: string, opts: AgentCassetteOptions = {}): AgentClient & { readonly path: string; preload(): void } {
  let lines: Map<string, AgentCassetteLine[]> | null = null;
  const asked = new Map<string, number>();
  const load = (): Map<string, AgentCassetteLine[]> => (lines ??= loadAgentCassette(path));
  return {
    path,
    get model(): string {
      return opts.model ?? opts.record?.model ?? 'cassette';
    },
    preload(): void {
      load();
    },
    async answer(ctx: AgentContext, timeoutMs: number): Promise<AgentResult> {
      const key = agentKey(ctx);
      const n = asked.get(key) ?? 0;
      asked.set(key, n + 1);
      const recorded = load().get(key) ?? [];
      const hit = recorded[n] ?? (opts.record === undefined ? recorded.at(-1) : undefined);
      if (hit !== undefined) return replayed(hit, ctx);
      if (opts.record === undefined) return { ok: false, reason: 'error', detail: AGENT_CASSETTE_MISS, ms: 0 };
      const r = await opts.record.answer(ctx, timeoutMs);
      // A request that failed (no text, and not for want of time) is asked again next time.
      if (r.raw === undefined && (r.ok || r.reason !== 'timeout')) return r;
      const line: AgentCassetteLine = {
        v: 1, key, model: opts.record.model,
        ...(r.raw !== undefined ? { raw: r.raw } : { failed: { reason: 'timeout' as const, detail: r.ok ? '' : r.detail } }),
        ms: r.ms,
        ...(r.usage !== undefined ? { usage: { inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens } } : {}),
        ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}),
        recordedAt: new Date((opts.now ?? Date.now)()).toISOString(),
      };
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify(line)}\n`);
      load().set(key, [...recorded, line]);
      return r;
    },
  };
}
