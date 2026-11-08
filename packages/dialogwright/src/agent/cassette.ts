import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalJson } from '../jev/cassette';
import { agentMessages } from './prompt';
import { parseAgentAnswer } from './schema';
import type { AgentClient, AgentContext, AgentFailure, AgentRequest, AgentResult } from './types';

/**
 * The agent model's answers recorded and replayed, as the decision model's and the render model's are:
 * one JSON Lines file per model, each line keyed by a hash of everything the request sends but the key
 * (its body: the messages, the schema, the temperature, the token limit, the effort, realtime and the
 * provider's parameters; AgentRequest), holding the model's text as given. A replay parses that text
 * again, so a change to the answer's schema is felt on replay as it would be live, and holds it to the
 * turn's budget: an answer recorded slower than the budget replays as a timeout.
 *
 * Every attempt is a line: an answer (its text), a timeout (measured), an answer with no text (invalid),
 * or a failed request (an API or network error, its detail made safe, never the key). A failed request
 * is asked again when recording, and replayed as it failed only where no answer was recorded after it,
 * so a recording and its replay table alike. The same request asked more than once (the bake-off's
 * `--repeat`) takes the recorded answers in turn; asked more often than they were recorded, a replay is
 * a miss, unless `repeatLast`. A regression's cassette (`oneAnswer`) answers every asking of a request as
 * first recorded. Recording is the author's step, with their own key; no test and no CI run
 * records.
 */

export interface AgentCassetteLine {
  v: 1;
  key: string;
  model: string;
  /** The model's text as given (valid or not). */
  raw?: string;
  /** An attempt with no text: a timeout, an answer with no message, or a failed request. */
  failed?: { reason: AgentFailure; detail: string };
  ms: number;
  usage?: { inputTokens: number; outputTokens: number };
  costUsd?: number;
  recordedAt: string;
}

/**
 * The key a turn is recorded under: the hash of the request's body (everything sent but the key), or for
 * a client that sends none (a fake), of the messages. Throws where the turn cannot be put into a request.
 */
export function agentKey(ctx: AgentContext, request?: AgentRequest): string {
  const sent = request !== undefined ? canonicalJson(request.body(ctx)) : (({ system, user }) => `${system}\u0000${user}`)(agentMessages(ctx));
  return createHash('sha256').update(sent).digest('hex').slice(0, 32);
}

const FAILURES: readonly string[] = ['timeout', 'invalid', 'error'];

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
    const failed = typeof l?.failed?.reason === 'string' && FAILURES.includes(l.failed.reason) && typeof l.failed.detail === 'string';
    if (!l || l.v !== 1 || typeof l.key !== 'string' || typeof l.model !== 'string' || typeof l.ms !== 'number' || (typeof l.raw !== 'string' && !failed)) {
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
  /** The request the turns are keyed by, for a replay (with no client to ask); default the recording client's. */
  request?: AgentRequest;
  /** The model the cassette is of, for a run's header and its price; default the recording client's, else the model its lines were recorded from. */
  model?: string;
  /** A replay asked a request more often than it was recorded says its last answer again, rather than miss. */
  repeatLast?: boolean;
  /**
   * Every asking of a request takes the answer first recorded for it, as the decision model's cassette
   * does, and a recording asks only a request with none: a regression's (harness-text/agentScript.ts). Its
   * calls are replayed whole and alone alike (a call that repeats another's turns, `--scenario <id>`, the
   * adversarial suite's variants of a call), and a variant asking what its clean call asked hears what the
   * clean call heard. Absent, the bake-off's: a request asked again takes the next answer recorded (`--repeat`).
   */
  oneAnswer?: boolean;
  now?: () => number;
}

const isFailedRequest = (l: AgentCassetteLine): boolean => l.failed?.reason === 'error';

/** What a recorded line replays as, its text parsed for this turn's actions and fields, within the turn's budget. */
function replayed(line: AgentCassetteLine, ctx: AgentContext, timeoutMs: number): AgentResult {
  const paid = { ...(line.usage !== undefined ? { usage: { ...line.usage } } : {}), ...(line.costUsd !== undefined ? { costUsd: line.costUsd } : {}) };
  if (line.raw === undefined) return { ok: false, reason: line.failed?.reason ?? 'timeout', detail: line.failed?.detail ?? 'timeout (recorded)', ms: line.ms, ...paid };
  if (line.ms > timeoutMs) return { ok: false, reason: 'timeout', detail: `no answer within ${timeoutMs} ms (recorded at ${line.ms} ms)`, ms: timeoutMs, ...paid };
  const parsed = parseAgentAnswer(line.raw, ctx.actions.map((a) => a.name), ctx.fields.map((f) => f.name), ctx.lines);
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
  const request = opts.request ?? opts.record?.request;
  return {
    path,
    ...(request !== undefined ? { request } : {}),
    get model(): string {
      return opts.model ?? opts.record?.model ?? load().values().next().value?.[0]?.model ?? 'cassette';
    },
    preload(): void {
      load();
    },
    async answer(ctx: AgentContext, timeoutMs: number): Promise<AgentResult> {
      let key: string;
      try {
        key = agentKey(ctx, request);
      } catch (e) {
        return { ok: false, reason: 'error', detail: `the turn could not be put into a request (${e instanceof Error ? e.name : 'error'})`, ms: 0 };
      }
      const n = opts.oneAnswer === true ? 0 : (asked.get(key) ?? 0);
      asked.set(key, n + 1);
      const recorded = load().get(key) ?? [];
      const answers = recorded.filter((l) => !isFailedRequest(l));
      if (answers[n] !== undefined) return replayed(answers[n], ctx, timeoutMs);
      if (opts.record === undefined) {
        // The failed requests after the last answer: what this request came to when it was last asked.
        let lastAnswer = -1;
        recorded.forEach((l, i) => {
          if (!isFailedRequest(l)) lastAnswer = i;
        });
        const failedSince = recorded.slice(lastAnswer + 1);
        const failed = failedSince[n - answers.length];
        if (failed !== undefined) return replayed(failed, ctx, timeoutMs);
        if (opts.repeatLast === true && answers.length > 0) return replayed(answers.at(-1)!, ctx, timeoutMs);
        return { ok: false, reason: 'error', detail: AGENT_CASSETTE_MISS, ms: 0 };
      }
      const r = await opts.record.answer(ctx, timeoutMs);
      const text = r.raw ?? (r.ok ? JSON.stringify(r.answer) : undefined);
      const line: AgentCassetteLine = {
        v: 1, key, model: opts.record.model,
        ...(text !== undefined ? { raw: text } : { failed: { reason: r.ok ? 'error' : r.reason, detail: r.ok ? '' : r.detail } }),
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
