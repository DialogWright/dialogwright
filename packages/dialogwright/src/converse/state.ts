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
  /** How the call ended: the closing line, a handoff to a person, or the caller left. Absent while it goes on. */
  ended?: 'closing' | 'handoff' | 'left';
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
