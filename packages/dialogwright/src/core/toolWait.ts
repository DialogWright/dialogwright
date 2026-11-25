/**
 * Tools that wait on a system (ToolDef.run returns a promise), with the core kept synchronous: the
 * turn's calls are kept in a memo (TurnContext.toolMemo), a call whose reply has not come makes its
 * pass provisional, and the runner (run/turn.ts) waits for the reply and runs the core again from
 * the same session, each call made once per turn however many passes it takes. The design:
 * docs/designs/2026-10-18-async-tools.md.
 */
import type { ToolCall } from '../gate/types';
import type { App, WaitingConfig } from './app/types';
import type { Effect } from './lifecycle';
import type { ToolRun } from './tools';

/** How long a call may take when the app does not say (app.yaml `waiting.timeoutMs`). */
export const TOOL_TIMEOUT_MS = 10_000;

/** The most passes a turn runs before it gives up (a hook that makes a call of its own each pass, without end). */
export const MAX_TOOL_PASSES = 32;

/** What a reply later than its time is, to the hook (as a tool that threw: its message never recorded). */
export class ToolLate extends Error {
  constructor(readonly tool: string, readonly ms: number) {
    super(`the tool ${tool} did not reply within ${ms} ms`);
    this.name = 'ToolLate';
  }
}

/** What `resolve` throws when a tool returns a promise on a turn no runner waits for (a unit test of the core). */
export const ASYNC_WITHOUT_RUNNER = 'a tool returned a promise on a turn with no runner to wait for it: run the turn with runTurn';

/** One call of the turn, as it stands. */
export type MemoRun =
  | { readonly state: 'running'; readonly tool: string; readonly startedAt: number; readonly settled: Promise<void> }
  | { readonly state: 'done'; readonly tool: string; readonly run: ToolRun; readonly effects: readonly Effect[]; readonly ms: number; readonly waited: boolean }
  | { readonly state: 'failed'; readonly tool: string; readonly error: unknown; readonly ms: number; readonly late: boolean; readonly waited: boolean };

/**
 * The turn's calls (TurnContext.toolMemo): each by its key (memoKey), in the order first made, and the
 * pass's own bookkeeping, reset at each pass (startPass): how many times it has made each key, and the
 * calls it found still running, which make it provisional.
 */
export interface ToolMemo {
  readonly runs: Map<string, MemoRun>;
  readonly seen: Map<string, number>;
  /** The keys of the calls this pass found running: a pass with any is provisional, its result never used. */
  pending: string[];
  /** How long a call may take, in ms. */
  readonly timeoutMs: number;
  /** The clock the calls are timed by. */
  readonly now: () => number;
}

export function newToolMemo(timeoutMs: number = TOOL_TIMEOUT_MS, now: () => number = () => performance.now()): ToolMemo {
  return { runs: new Map(), seen: new Map(), pending: [], timeoutMs, now };
}

/** A pass begins: no key made yet, nothing pending. */
export function startPass(memo: ToolMemo): void {
  memo.seen.clear();
  memo.pending = [];
}

/**
 * A call's key in the memo: its tool, its params (keys sorted), its purpose and the keyed code beside
 * it, and how many times the pass has made the same call before, so a call made twice in a turn is
 * two runs, as it would be with no memo.
 */
export function memoKey(memo: ToolMemo, call: ToolCall, code: string | undefined): string {
  const base = JSON.stringify([call.tool, sorted(call.params), call.purpose ?? null, code ?? null]);
  const n = memo.seen.get(base) ?? 0;
  memo.seen.set(base, n + 1);
  return `${base}#${n}`;
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sorted((value as Record<string, unknown>)[k])]));
  }
  return value;
}

function isThenable(x: unknown): x is PromiseLike<ToolRun> {
  return x !== null && typeof x === 'object' && typeof (x as { then?: unknown }).then === 'function';
}

/** What a call in the memo comes to for this pass: its reply, its failure (thrown again), or still running. */
export type MemoRead = { readonly run: ToolRun; readonly effects: readonly Effect[] } | { readonly pending: true };

/**
 * A call through the memo. A call already made this turn gets what it came to (a failure thrown again,
 * as the first pass saw it); a call still running makes the pass provisional. A call not yet made is
 * made (`start`, which runs the tool): a reply at once is kept and returned, a promise is kept running
 * and the pass made provisional. `answer` is a test's stand-in for the systems' reply (Tools.answers),
 * applied once, as the reply comes. `effects` are the side effects the tool queued as it ran (its own
 * TurnOut, ToolContext.out), read once it has replied and handed to every pass that reads the call.
 */
export function throughMemo(memo: ToolMemo, key: string, tool: string, start: () => ToolRun | PromiseLike<ToolRun>, answer: (ran: ToolRun) => ToolRun, effects: () => readonly Effect[]): MemoRead {
  const had = memo.runs.get(key);
  if (had !== undefined) return readRun(memo, key, had);
  const startedAt = memo.now();
  let ran: ToolRun | PromiseLike<ToolRun>;
  try {
    ran = start();
  } catch (err) {
    memo.runs.set(key, { state: 'failed', tool, error: err, ms: memo.now() - startedAt, late: false, waited: false });
    throw err;
  }
  if (!isThenable(ran)) {
    const run = answer(ran);
    const queued = [...effects()];
    memo.runs.set(key, { state: 'done', tool, run, effects: queued, ms: memo.now() - startedAt, waited: false });
    return { run, effects: queued };
  }
  // The request has started: its reply is kept when it comes, or its failure, or the time it ran out.
  const reply = Promise.resolve(ran);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'late'>((res) => {
    timer = setTimeout(() => res('late'), memo.timeoutMs);
  });
  const settled = Promise.race([reply.then((run) => ({ run }), (error: unknown) => ({ error })), late]).then((got) => {
    clearTimeout(timer);
    const ms = memo.now() - startedAt;
    if (got === 'late') memo.runs.set(key, { state: 'failed', tool, error: new ToolLate(tool, memo.timeoutMs), ms, late: true, waited: true });
    else if ('error' in got) memo.runs.set(key, { state: 'failed', tool, error: got.error, ms, late: false, waited: true });
    else {
      try {
        memo.runs.set(key, { state: 'done', tool, run: answer(got.run), effects: [...effects()], ms, waited: true });
      } catch (error) {
        memo.runs.set(key, { state: 'failed', tool, error, ms, late: false, waited: true });
      }
    }
  });
  // A late reply that rejects afterwards is no unhandled rejection: it was already counted as late.
  reply.catch(() => undefined);
  memo.runs.set(key, { state: 'running', tool, startedAt, settled });
  memo.pending.push(key);
  return { pending: true };
}

function readRun(memo: ToolMemo, key: string, run: MemoRun): MemoRead {
  if (run.state === 'done') return { run: run.run, effects: run.effects };
  if (run.state === 'failed') throw run.error;
  memo.pending.push(key);
  return { pending: true };
}

/** Whether this pass found a call still running: its result is provisional, and no later call of it runs a tool. */
export function passPending(memo: ToolMemo | undefined): boolean {
  return memo !== undefined && memo.pending.length > 0;
}

/** The calls this pass found running, settled (each kept as its reply, its failure, or late). */
export function settledPending(memo: ToolMemo): Promise<void> {
  const waits: Promise<void>[] = [];
  for (const key of memo.pending) {
    const run = memo.runs.get(key);
    if (run?.state === 'running') waits.push(run.settled);
  }
  return Promise.all(waits).then(() => undefined);
}

/** The tools this pass is waiting on, by name, in the order they were made. */
export function pendingTools(memo: ToolMemo): string[] {
  return memo.pending.map((key) => memo.runs.get(key)?.tool).filter((t): t is string => t !== undefined);
}

/** What the trace keeps of a call that waited: its tool, how long it took, and what it came to. */
export interface WaitedCall {
  readonly tool: string;
  readonly ms: number;
  readonly outcome: 'replied' | 'failed' | 'late';
}

/** The calls of the turn that returned a promise, in the order they were made. */
export function waitedCalls(memo: ToolMemo): WaitedCall[] {
  const out: WaitedCall[] = [];
  for (const run of memo.runs.values()) {
    if (run.state === 'running' || !run.waited) continue;
    out.push({ tool: run.tool, ms: Math.round(run.ms), outcome: run.state === 'done' ? 'replied' : run.late ? 'late' : 'failed' });
  }
  return out;
}

/** The app's waiting settings (App.waiting), none where it has none. */
export function waitingOf(app: App): WaitingConfig {
  return app.waiting ?? {};
}

/** How long a turn waits on its tools before its hold line, on a channel with speech or without. */
export function holdAfterMs(app: App, speech: boolean): number {
  const after = waitingOf(app).afterMs;
  if (after === undefined) return 0;
  if (typeof after === 'number') return after;
  return (speech ? after.voice : after.chat) ?? 0;
}

/**
 * The line said while a turn waits: the first waiting tool's own (ToolDef.waiting.line), else the
 * app's (`waiting.line`); at the call's start, the app's `waiting.start` only. Null where there is none.
 */
export function holdLineId(app: App, tools: readonly string[], atStart: boolean): string | null {
  const w = waitingOf(app);
  if (atStart) return w.start ?? null;
  for (const tool of tools) {
    const own = app.tools[tool]?.waiting?.line;
    if (own !== undefined) return own;
  }
  return w.line ?? null;
}

/**
 * `run`, made again with the same memo until no call it made is still to reply: for synchronous code
 * that calls tools outside a turn (the harness seeding a corpus entry's state). `run` must start from
 * the same state each time (a fresh copy of the session), as a turn's passes do. `onWait` is told, once,
 * of the first wait.
 */
export async function untilReplied<T>(run: (memo: ToolMemo) => T, timeoutMs: number = TOOL_TIMEOUT_MS, onWait?: (memo: ToolMemo, provisional: T | null) => void): Promise<{ value: T; memo: ToolMemo; passes: number }> {
  const memo = newToolMemo(timeoutMs);
  for (let pass = 1; ; pass++) {
    startPass(memo);
    let value: T | null = null;
    let threw = false;
    try {
      value = run(memo);
    } catch (err) {
      if (!passPending(memo)) throw err;
      threw = true;
    }
    if (!passPending(memo)) return { value: value as T, memo, passes: pass };
    if (pass >= MAX_TOOL_PASSES) throw new Error(`waited on tools ${pass} times and was still waiting: code that makes a new call on every pass?`);
    if (pass === 1) onWait?.(memo, threw ? null : value);
    await settledPending(memo);
  }
}
