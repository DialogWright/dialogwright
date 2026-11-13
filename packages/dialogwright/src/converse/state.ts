import { defaultTimeZone } from '../core/localDate';
import type { Seen } from './actions';
import type { AgentBusiness } from './business/schema';
import type { PendingReadBack } from './confirm';
import type { ModelMessage } from './model/types';

/**
 * What a converse call keeps between turns (docs/designs/2026-11-11-agent-runtime.md, "The conversation
 * loop"): the conversation as the model is sent it, the read-back waiting for the caller's answer, what
 * each lookup returned on this call, the failed turns and each action's refusals, and what is known of
 * the caller. It is plain data, so a session store can save it and a restart resume the call.
 */
export interface ConverseState {
  kind: 'converse';
  v: 1;
  appId: string;
  callId: string;
  channel: 'chat' | 'voice';
  /** The conversation: the caller's words, the replies and fixed lines said, the tool calls and their results. */
  messages: ModelMessage[];
  /** A change read back and waiting for the caller's yes, or null. */
  pending: PendingReadBack | null;
  /** Each lookup's latest results on this call, by its name. */
  seen: Seen;
  /** Turns the model failed (an error, a timeout, an empty reply) that ended with the recovery line. */
  failures: number;
  /** The gate's refusals on this call, by action. */
  refusals: Record<string, number>;
  /** The number the caller is calling from (whole: only tools get it whole) and the account it is recognised as. */
  caller: { number?: string; account?: string | null };
  /** The next turn's index in the trace. */
  turnIndex: number;
  /**
   * The check after speaking's note for a reply read as wrong while a read-back waited for the caller's yes
   * (docs/designs/2026-11-11-claims-check.md): it could not be sent then, so it goes with the next message the
   * model is sent, after that message's own content, and is taken out of here once sent. Absent (as in a state
   * saved before it was kept): no note waits. A call that ends first drops it.
   */
  carriedNote?: string;
  /**
   * The changes that ran on this call, in order: each with its read-back as the caller confirmed it and what it
   * and its follow-ons returned, the line's own record of what has been done, told to the model on every
   * request. Absent (as in a state saved before it was kept): none ran.
   */
  done?: DoneChange[];
  /**
   * Where the call is among the business's journeys. Absent: the app has no journeys, or the state was saved
   * before them (a field not in the shape loads as absent).
   */
  journey?: JourneyState;
  /** How the call ended: the closing line, a handoff to a person, or the caller left. Absent while it goes on. */
  ended?: 'closing' | 'handoff' | 'left';
}

/** Where a call is among the journeys: the one the turn is in (null: the root), its phase, the one set aside and those done. */
export interface JourneyState {
  /** The journey the turn is in, or null at the root. */
  active: string | null;
  /** after: its completing action ran; its information stays, its changes are withdrawn. */
  phase: 'working' | 'after';
  /** Set aside by a switch; at most one. */
  paused: string | null;
  /** Journeys whose completing action ran on this call, in order. */
  done: string[];
  /** Turns in a row the line could not follow (docs/designs/2026-11-12-journeys.md, "Amendment (2026-11-13)"). Absent: none. */
  unclear?: number;
}

/** A change that ran on the call: its action, its read-back as said and confirmed, and what it and each follow-on returned (`<action>: <result>`). */
export interface DoneChange {
  action: string;
  readBack: string;
  results: string[];
}

export function newConverseState(o: { appId: string; callId: string; channel: 'chat' | 'voice'; callerNumber?: string; account?: string | null }): ConverseState {
  return {
    kind: 'converse',
    v: 1,
    appId: o.appId,
    callId: o.callId,
    channel: o.channel,
    messages: [],
    pending: null,
    seen: {},
    failures: 0,
    refusals: {},
    caller: { ...(o.callerNumber !== undefined ? { number: o.callerNumber } : {}), account: o.account ?? null },
    turnIndex: 0,
  };
}

/**
 * The one zone a converse call's dates are in: the business's (agent.yaml `business.timezone`), else the
 * server's, else UTC. The day the arguments are checked against, the gate's today, the prompt's date and
 * the calendar's today all come from it.
 */
export function businessZone(b: AgentBusiness): string {
  return b.business.timezone ?? (defaultTimeZone() || 'UTC');
}
