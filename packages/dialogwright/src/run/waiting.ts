/**
 * The runner's side of tools that wait on a system (core/toolWait.ts): the core run again until no
 * call of the turn is still to reply, and, while the turn waits, the app's hold line and its thinking
 * sound (app.yaml `waiting`) handed to a channel that can say them before the turn has ended
 * (RunOptions.early). The design: docs/designs/2026-10-18-async-tools.md.
 */
import { performance } from 'node:perf_hooks';
import { sayAction, type Action } from '../channel/actions';
import type { SessionEvent } from '../channel/events';
import { appOf } from '../core/app/registry';
import type { Session } from '../core/session';
import { holdAfterMs, holdLineId, pendingTools, untilReplied, waitedCalls, waitingOf, type ToolMemo } from '../core/toolWait';
import { resolve, type TurnContext, type TurnError, type TurnResult } from '../core/turn';
import type { ScreenResult } from '../core/screen';
import type { AnswerMap } from '../jev/types';
import { promptSay, type RenderContext } from '../prompts/render';
import type { EarlyLines } from '../render/turn';
import type { WaitedRecord } from '../trace/types';

/** What the runner hands the waiting (RunOptions): where early lines go, how long lines take to play, and the clips. */
export interface WaitingChannel {
  readonly early?: EarlyLines;
  /** How long `actions` take to play, by the channel's estimate (RunOptions.playMs); absent, no sound is played. */
  readonly playMs?: (actions: readonly Action[]) => number;
  readonly render?: RenderContext | null;
}

/**
 * The turn's core, run until no call is still to reply (untilReplied): each pass from the same session,
 * with the turn's memo, waiting between passes for the calls the last one found running. A pass that throws
 * while a call is pending (a hook that read the null it was given) is provisional like any other; one
 * that throws with nothing pending fails the turn, as it always has. `waited` is null on a turn whose
 * every tool replied at once. `memo`: the calls a resolution of the same turn already made, for a turn
 * resolved again (an agent-mode turn whose model is asked again: run/turn.ts), so none is made twice; the
 * memo used is returned.
 */
export async function resolveWaiting(session: Session, event: SessionEvent, answers: AnswerMap | null, tc: TurnContext, error: TurnError | null, screen: ScreenResult | null, channel: WaitingChannel, timeoutMs: number, given?: ToolMemo): Promise<{ result: TurnResult; waited: WaitedRecord | null; memo: ToolMemo }> {
  let shown: WaitShow | null = null;
  try {
    const { value: result, memo, passes } = await untilReplied(
      (memo) => resolve(session, event, answers, { ...tc, toolMemo: memo }, error, screen),
      timeoutMs,
      (memo, provisional) => {
        shown = showWaiting(session, event, provisional, pendingTools(memo), channel);
      },
      given,
    );
    const calls = waitedCalls(memo);
    const show = shown as WaitShow | null;
    const waited: WaitedRecord | null = calls.length === 0 && show === null ? null : { calls, passes, ...(show?.record() ?? {}) };
    return { result, waited, memo };
  } finally {
    (shown as WaitShow | null)?.stop();
  }
}

/** What is said and played while a turn waits, from its first wait to its last reply. */
interface WaitShow {
  stop(): void;
  record(): Pick<WaitedRecord, 'hold' | 'sounds'>;
}

/**
 * The hold line, `afterMs` after the turn first waited, then the thinking sound once the line should
 * have played, one clip at a time. Through the channel's early lines: where there are none, the line
 * is recorded as due and not said, and no sound plays.
 */
function showWaiting(session: Session, event: SessionEvent, provisional: TurnResult | null, tools: readonly string[], channel: WaitingChannel): WaitShow {
  const app = appOf(session);
  const speech = session.caps.speech;
  const t0 = performance.now();
  const lineId = holdLineId(app, tools, event.type === 'session.start');
  const soundId = waitingOf(app).sound;
  const soundFile = speech && soundId !== undefined ? channel.render?.clips.get(soundId) : undefined;
  const sound = soundFile !== undefined && channel.render ? sayAction([{ audio: channel.render.audioBase + soundFile }], false) : null;
  // What the channel's early lines read of the turn: its session and decision. A pass that threw has no
  // result of its own; the session as the turn found it says nothing is decided yet.
  const result: TurnResult = provisional ?? ({ session, decision: { kind: 'ignore' }, actions: [], rows: [], gateEvents: [], effects: [], audit: [], kb: null, screen: null, quarantined: false, turnState: null, verdict: null, fillEvents: [] } as unknown as TurnResult);
  let hold: { promptId: string; atMs: number; said: boolean } | undefined;
  let sounds = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const say = (lines: Action[]): boolean => {
    try {
      return channel.early !== undefined && channel.early(lines, { ...result, actions: lines });
    } catch {
      return false;
    }
  };
  const playSound = (): void => {
    if (stopped || sound === null || channel.playMs === undefined) return;
    if (!say([sound])) return;
    sounds += 1;
    timer = setTimeout(playSound, Math.max(1, channel.playMs([sound])));
  };
  const due = (): void => {
    if (stopped) return;
    if (lineId !== null) {
      const line = promptSay(app, lineId, {}, false, channel.render ?? null, session.locale, undefined, { shown: !session.caps.speech });
      const said = say([line]);
      hold = { promptId: lineId, atMs: Math.round(performance.now() - t0), said };
      if (said && sound !== null && channel.playMs !== undefined) timer = setTimeout(playSound, Math.max(1, channel.playMs([line])));
      return;
    }
    playSound();
  };
  if (lineId !== null || sound !== null) {
    const after = holdAfterMs(app, speech);
    if (after === 0) due();
    else timer = setTimeout(due, after);
  }
  return {
    stop: () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
    record: () => ({ ...(hold !== undefined ? { hold } : {}), ...(sounds > 0 ? { sounds } : {}) }),
  };
}

/**
 * The line said while the agent model is slow on a call (business.yaml's `waiting`, AgentApp.waiting; the
 * agent-mode design, call 60): `afterMs` after `startedAt` (when the model was first asked), with its answer
 * not in, the next of `lines` after the one this call said last (Session.agent.waitLine), said at once through
 * the channel's early lines, as the hold line of a tool that waits is (showWaiting): one at most a turn. The
 * channel says the turn's own lines after it, once it has played. Where the channel has no early lines (a
 * test's harness, a chat), the line is recorded as due and not said. Stopped once the answer is in.
 */
export interface AgentFiller {
  stop(): void;
  /** The line due, its index among the lines, when (ms from the model first asked), and whether the channel said it; null where none came due. */
  record(): { promptId: string; index: number; atMs: number; said: boolean } | null;
}

export function agentFiller(session: Session, waiting: { afterMs: number; lines: readonly string[] }, channel: WaitingChannel, startedAt: number): AgentFiller {
  const app = appOf(session);
  const last = session.agent?.waitLine;
  const index = last === undefined ? 0 : (last + 1) % waiting.lines.length;
  const lineId = waiting.lines[index]!;
  let said: { promptId: string; index: number; atMs: number; said: boolean } | null = null;
  let stopped = false;
  const due = (): void => {
    if (stopped) return;
    const line = promptSay(app, lineId, {}, false, channel.render ?? null, session.locale, undefined, { shown: false });
    // What the channel's early lines read of the turn: nothing decided yet (as showWaiting's pass that threw).
    const result = { session, decision: { kind: 'ignore' }, actions: [line], rows: [], gateEvents: [], effects: [], audit: [], kb: null, screen: null, quarantined: false, turnState: null, verdict: null, fillEvents: [] } as unknown as TurnResult;
    let ok = false;
    try {
      ok = channel.early !== undefined && channel.early([line], result);
    } catch {
      ok = false;
    }
    said = { promptId: lineId, index, atMs: Math.round(performance.now() - startedAt), said: ok };
  };
  const timer = setTimeout(due, Math.max(0, waiting.afterMs - (performance.now() - startedAt)));
  return {
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
    record: () => said,
  };
}

