import type { SessionEvent } from '../channel/events';
import type { App } from '../core/app/types';
import type { Session } from '../core/session';
import type { TurnResult } from '../core/turn';
import { runTurn, type Arrival, type RunOptions, type TurnRun } from './turn';

/**
 * A caller who had not finished (App.voice.continueWithinMs).
 *
 * A recognizer that ends a prompt at a short pause hands the engine half an answer as a final prompt:
 * asked for an address, a caller says "at", "22", "Alder Street." with two short breaths, and each is
 * a final prompt. The engine answers "at" with a re-ask, and the caller, still talking, talks over it
 * at once: the carrier reports an interrupt a few hundred milliseconds into the re-ask, at most. No
 * caller answers a line that fast: an interrupt that early is the caller who had not finished, not a
 * reply to the agent's words. So when the reply to a final prompt is cut off within `withinMs` of
 * starting, the next final prompt continues the one before it: the words are joined (the fragments
 * so far and the new prompt, single spaces) and the turn runs as if the joined words had been the
 * prompt, on the session as it was before the first fragment's turn. The re-asks the caller talked
 * over are undone, and none is said again; the joined turn says what it decides.
 *
 * Only a turn that spoke and did nothing else is undone (undoable): a turn that went through the
 * gate, handed work to a service, switched the language, ended the call or was quarantined has done
 * something no session can take back, so the prompt after it is a turn of its own, as today. A key
 * pressed, a no-input silence, or any other event in between ends joining, and so does an interrupt
 * after `withinMs`, which is an ordinary barge-in. With the relay's barge-in off no interrupt comes, so a
 * carrier that reports the caller speaking stands in for it: speech that starts within `withinMs` of the
 * reply going out, and goes on into the next final prompt, is told here as `resumed` (server/adapter.ts). At most CONTINUE_MAX_FRAGMENTS prompts are joined,
 * and never past the wire's text limit.
 *
 * The engine's, not a carrier's: it reads the core's events, and the voice server and the frame-log
 * replay (harness-text/replay.ts) run every turn of a call through one Continuation, in the order the
 * turns ran, so a replayed call joins where the live call did. The joined turn's trace record says
 * which prompts it joined (TraceRecord.joined); each fragment's own turn is in the trace before it.
 * The state lives with the call in memory: a server restarted mid-answer runs the next prompt alone.
 */

/** voice.continueWithinMs when the app does not set it. */
export const DEFAULT_CONTINUE_WITHIN_MS = 300;
/** The largest voice.continueWithinMs an app may set: past two seconds, an interrupt can be a reply. */
export const MAX_CONTINUE_WITHIN_MS = 2000;
/** The most final prompts one turn joins. */
export const CONTINUE_MAX_FRAGMENTS = 3;
/** The longest joined words: as long as the relay wire takes one prompt (channel/relay/wire.ts MAX_TEXT_LENGTH). */
export const CONTINUE_MAX_CHARS = 4000;

/** The app's window for a reply cut off by a caller who had not finished; 0 turns joining off. */
export function continueWithinMsOf(app: Pick<App, 'voice'>): number {
  return app.voice?.continueWithinMs ?? DEFAULT_CONTINUE_WITHIN_MS;
}

/**
 * Whether a turn only spoke, so that undoing it leaves nothing done: a prompt or a repeat, said with
 * nothing but say actions, with no gate decision, no side effect, no quarantine, and the call neither
 * ended nor waiting on a service.
 */
export function undoable(result: TurnResult): boolean {
  const { decision, actions, session } = result;
  return (decision.kind === 'prompt' || decision.kind === 'replay')
    && actions.length > 0 && actions.every((a) => a.type === 'say')
    && result.gateEvents.length === 0 && result.effects.length === 0 && !result.quarantined
    && !session.ended && session.pendingService === null;
}

/** A turn as a Continuation ran it: `joined` is the prompts its words joined, in order, or null for a turn of its own. */
export type ContinuedRun = TurnRun & { joined: readonly string[] | null };

type State =
  | { kind: 'idle' }
  /** A final prompt's turn spoke, and only spoke: `base` is the session before the first fragment's turn. */
  | { kind: 'replied'; base: Session; fragments: readonly string[] }
  /** ... and the caller talked over the reply within the window: the next final prompt continues. */
  | { kind: 'cut'; base: Session; fragments: readonly string[] };

const IDLE: State = { kind: 'idle' };

export class Continuation {
  private state: State = IDLE;

  /** `withinMs`: voice.continueWithinMs, for the call's whole life; 0 never joins. */
  constructor(readonly withinMs: number) {}

  /**
   * The caller came back in `afterMs` after the reply to their last final prompt went out, and the prompt
   * about to run is more of that speech (server/adapter.ts takeResumed, on a carrier that reports the
   * caller speaking; replay reads it from the frame log's `callerResumed`): taken as an interrupt within
   * the window is, so that prompt continues the one before it. Not a turn: no event reaches the core, and
   * nothing changes unless the last turn was a reply to a final prompt that only spoke.
   */
  resumed(afterMs: number): void {
    const state = this.state;
    if ((state.kind === 'replied' || state.kind === 'cut') && afterMs <= this.withinMs) {
      this.state = { kind: 'cut', base: state.base, fragments: state.fragments };
    }
  }

  /** Forget any fragments: what a key the server drops, or a reconnect, calls (neither is a turn). */
  reset(): void {
    this.state = IDLE;
  }

  /**
   * Run one turn of the call (runTurn), joined to the fragments before it when the caller had not
   * finished. Every turn of the call goes through here, in order; a turn that throws ends joining.
   */
  async run(session: Session, event: SessionEvent, opts: RunOptions, arrival?: Arrival): Promise<ContinuedRun> {
    const state = this.state;
    this.state = IDLE;
    if (event.type === 'user.speech' && event.final) {
      if (state.kind === 'cut' && arrival?.duringService !== true) {
        const fragments = [...state.fragments, event.text];
        const text = fragments.map((f) => f.trim()).filter(Boolean).join(' ');
        if (fragments.length <= CONTINUE_MAX_FRAGMENTS && text.length <= CONTINUE_MAX_CHARS) {
          // The session before the first fragment, with the turn count as it is now: a turn number is
          // never given twice (the trace, a service request's idempotency key).
          const base: Session = { ...state.base, turnIndex: session.turnIndex };
          const run = await runTurn(base, { ...event, text }, opts, arrival, fragments);
          if (undoable(run.result)) this.state = { kind: 'replied', base: state.base, fragments };
          return { ...run, joined: fragments };
        }
      }
      const run = await runTurn(session, event, opts, arrival);
      if (this.withinMs > 0 && undoable(run.result)) this.state = { kind: 'replied', base: session, fragments: [event.text] };
      return { ...run, joined: null };
    }
    const run = await runTurn(session, event, opts, arrival);
    if (event.type === 'user.interrupt' && (state.kind === 'replied' || state.kind === 'cut') && event.afterMs <= this.withinMs) {
      this.state = { kind: 'cut', base: state.base, fragments: state.fragments };
    } else if (event.type === 'user.speech') {
      // A partial (only a harness hands one to a turn) holds: the final prompt is still to come.
      this.state = state;
    }
    return { ...run, joined: null };
  }
}
