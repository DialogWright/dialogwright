import type { App } from '../core/app/types';
import { recordedValue, scrubberFor, type RecordingApp, type Scrub } from '../audit/recording';
import type { ToolCall } from '../gate/types';
import type { ActionSpec } from './business/schema';

/**
 * What a converse call records, turn by turn (docs/designs/2026-11-11-agent-runtime.md, "Settled after
 * the builder's review" item 1): one trace record per turn of the caller, and each action's params as the
 * business's `audit` says (agent.yaml actions.<name>.audit: last4, mask, length, secret or keep; mask
 * where it says nothing), in the trace and the audit alike.
 */

/** ran: allowed and done; failed: allowed, and the action threw; confirmed: run after the caller's yes. */
export type ConverseToolOutcome = 'ran' | 'failed' | 'refused' | 'readBack' | 'confirmed' | 'notConfirmed' | 'invalid';

/** One request to the model, timed: to its first event of any kind, and to its end (its time while it ran, whatever stopped it). */
export interface ModelRequestTime {
  firstMs: number | null;
  ms: number;
  error?: string;
}

export interface ConverseTraceRecord {
  v: 3;
  kind: 'converse';
  sessionId: string;
  turnIndex: number;
  ts: string;
  /** What the caller said; null for the call's start and for the caller leaving. */
  said: string | null;
  /** What the line said, each reply and fixed line whole. */
  replies: string[];
  /** Each action called, its params as recorded. */
  tools: { name: string; args: Record<string, string>; outcome: ConverseToolOutcome; reason?: string }[];
  /**
   * The model's requests of the turn: their time, the first text's time from the turn's start, usage and cost
   * summed over them; and each request on its own (`requests`): ms to its first event (null: none came), ms to
   * its end, and how it failed where it did.
   */
  model: { id: string; ms: number; firstTextMs: number | null; usage: { inputTokens: number; outputTokens: number }; costUsd: number | null; error?: string; retried?: boolean; requests?: ModelRequestTime[] };
  /** The read-back said, or answered, this turn: the decision model's reading of the answer and whether it confirmed. */
  readBack?: { text: string; yes?: number; no?: number; confirmed?: boolean };
  /** Written by a server after it let the call go to another (trace/store.ts): late, kept apart. */
  outlivedHold?: true;
}

/** An action as the shared recording reads it: no slots, and each param recorded as its `audit` says (mask by default). */
export function recordingOf(spec: ActionSpec | undefined): RecordingApp {
  const audit: Record<string, NonNullable<ActionSpec['audit']>[string]> = {};
  for (const name of Object.keys(spec?.params ?? {})) audit[name] = spec?.audit?.[name] ?? 'mask';
  return { slots: {} as App['slots'], policy: { audit } };
}

/** The call's params as recorded: each masked as its action's `audit` says, a secret left out; a param the action does not take (or an action the business does not have) masked. */
export function recordedArgs(spec: ActionSpec | undefined, params: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    const raw = typeof v === 'string' ? v : JSON.stringify(v) ?? '';
    const how = spec !== undefined && Object.hasOwn(spec.params, k) ? spec.audit?.[k] ?? 'mask' : 'mask';
    const shown = recordedValue(how, raw);
    if (shown !== null) out[k] = shown;
  }
  return out;
}

/** The scrub of free text recorded beside a call (a rule's line, a reason): each raw masked value replaced by its recorded form. */
export function scrubOf(spec: ActionSpec | undefined, call: ToolCall): Scrub {
  return scrubberFor(recordingOf(spec), call) ?? ((t) => t);
}

/**
 * What to mask in what the line said with a call's values in it (a read-back, a reply): each param
 * recorded masked or never, paired with its recorded form, both as it is and as the read-back says it
 * (`shown`: a slot's label, a day, "ending in 0142"). The pairs of a turn's calls make one scrub
 * (scrubberOfValues), so the longest value is masked first.
 */
export function saidPairs(spec: ActionSpec | undefined, call: ToolCall, shown: Record<string, string>): [string, string][] {
  const pairs: [string, string][] = [];
  for (const [k, v] of Object.entries(call.params)) {
    const how = spec !== undefined && Object.hasOwn(spec.params, k) ? spec.audit?.[k] ?? 'mask' : 'mask';
    if (how === 'keep' || v === '') continue;
    const recorded = recordedValue(how, v) ?? '•';
    for (const form of [shown[k], v]) if (form !== undefined && form !== '' && form !== recorded) pairs.push([form, recorded]);
  }
  return pairs;
}
