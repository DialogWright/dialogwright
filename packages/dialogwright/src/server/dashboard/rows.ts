/**
 * The types of the console's lists (view.js callRow, and what the Live list's feed and the Calls page
 * send). Types only: kept in a TypeScript module, so the declarations of the server's modules that use
 * them (live.ts, calls.ts) name this file, which the build emits, rather than view.js.
 */

/** A call's status in the Live list. */
export type CallStatus = 'on-track' | 'second-try' | 'frustrated' | 'transferring' | 'with-person' | 'ended';

/** How a call ended, as the Calls page and the Live list say it. */
export interface CallEnding {
  /** handled (the agent finished it), person (handed off), hangup (the caller hung up or left a chat), error. */
  kind: 'handled' | 'person' | 'hangup' | 'error';
  text: string;
  /** For `person`: the handoff reason's code. */
  reason?: string | null;
  /** For `hangup`: the task and step the call was on ("Book an appointment · date of birth"), or the greeting. */
  where?: string;
}

/** One call as the console's lists show it (callRow): only what was asked and counts, never a value a caller gave. */
export interface CallRow {
  callSid: string | null;
  /** The call's app on a server of several apps (call_started.app); null on a server of one. */
  app: string | null;
  /** The caller as masked (`…0110`), or how a chat names itself (`web chat`). */
  from: string;
  /** Who is chatting, as the console's header already says it; null on a voice call. */
  caller: string | null;
  channel: string;
  /** The carrier a voice call came in on; null for a chat. */
  provider: string | null;
  startedAt: number | null;
  lastAt: number | null;
  /** When the call ended; null while it is in progress. */
  endedAt: number | null;
  turns: number;
  /** The task the call is on (its form and its label), or nulls between tasks. */
  task: { form: string | null; label: string | null };
  /** The step in plain words: the slot being asked (its console label), or what is being confirmed. */
  step: string | null;
  /** Every task the call worked on, by form id and label. */
  tasks: { id: string; label: string }[];
  status: CallStatus;
  /** Whether the frustration gate fired on any turn of the call. */
  frustrated: boolean;
  handoffReason: string | null;
  ending: CallEnding | null;
  /** The decision model's cost of the call so far, from its records' usage. */
  costUsd: number;
}
