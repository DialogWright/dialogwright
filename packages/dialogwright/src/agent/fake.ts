import type { AgentAnswer, AgentClient, AgentContext, AgentFailure, AgentResult } from './types';

/**
 * An agent client that asks no model (the engine's tests, an app's stub regression, the bake-off's
 * own test): a script answers each turn from its context. The script may answer with a failure
 * instead (`{ fail: 'timeout' | 'invalid' | 'error' }`), so a test can make an agent that is slow,
 * malformed or down. `ms` is the time it reports, without waiting; `delayMs` makes it wait for real.
 */

/** A scripted failure. */
export interface FakeAgentFailure {
  fail: AgentFailure;
  detail?: string;
  /** An `invalid` answer cut off at the token limit (AgentResult.cutOff). */
  cutOff?: true;
}

export interface FakeAgentOptions {
  /** The time each answer reports, ms (a number, or one per turn and attempt); default 0. Nothing waits for it. */
  ms?: number | ((ctx: AgentContext, attempt: number) => number);
  /** How long each answer really takes, ms; default none. */
  delayMs?: number;
  /** The tokens each answer reports; default none. */
  usage?: { inputTokens: number; outputTokens: number };
}

/** The model id a fake reports. */
export const FAKE_AGENT_MODEL = 'fake-agent';

/**
 * `script` is given the turn's context and the attempt (1, or 2 for the same request asked again after an
 * answer not in its shape: AgentRunner.retry).
 */
export function fakeAgent(script: (ctx: AgentContext, attempt: number) => AgentAnswer | FakeAgentFailure, opts: FakeAgentOptions = {}): AgentClient {
  return {
    model: FAKE_AGENT_MODEL,
    async answer(ctx: AgentContext, timeoutMs: number, attempt = 1): Promise<AgentResult> {
      if (opts.delayMs !== undefined && opts.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(opts.delayMs!, timeoutMs)));
        if (opts.delayMs > timeoutMs) return { ok: false, reason: 'timeout', detail: `fake agent: no answer within ${timeoutMs} ms`, ms: timeoutMs };
      }
      const ms = typeof opts.ms === 'function' ? opts.ms(ctx, attempt) : (opts.ms ?? opts.delayMs ?? 0);
      const usage = opts.usage !== undefined ? { usage: { ...opts.usage } } : {};
      const out = script(ctx, attempt);
      if ('fail' in out) return { ok: false, reason: out.fail, detail: out.detail ?? `fake agent: ${out.fail}`, ms, ...usage, ...(out.cutOff === true ? { cutOff: true as const } : {}) };
      return { ok: true, answer: out, ms, raw: JSON.stringify(out), ...usage };
    },
  };
}
