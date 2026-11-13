import type { App } from '../core/app/types';
import { recordedValue, scrubberFor, type RecordingApp, type Scrub } from '../audit/recording';
import type { ToolCall } from '../gate/types';
import type { ActionSpec } from './business/schema';
import type { RouteOutcome } from './journeys';

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
  /** The request was the check after speaking's correction, not the reply the caller waited for. */
  correction?: true;
  /**
   * The wait before this request, after the one before it was refused for the provider's rate limit (turn.ts
   * `round`): not in `ms`, but within the same round's time as it (the model's `timeoutMs` bounds the two).
   */
  waitedMs?: number;
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
   * its end, and how it failed where it did. `rateLimited`: how many of the turn's answers (the reply's and a
   * correction's alike) were the provider's refusal for its rate limit, each asked again after a wait while
   * half the model's time was left (turn.ts `round`); absent where none was. `rateLimitedMs`: the time spent
   * waiting before those asks again, summed over the turn: apart from `ms`, which is the requests' own time
   * (each request's wait is also its `waitedMs`).
   */
  model: { id: string; ms: number; firstTextMs: number | null; usage: { inputTokens: number; outputTokens: number }; costUsd: number | null; error?: string; retried?: boolean; rateLimited?: number; rateLimitedMs?: number; requests?: ModelRequestTime[] };
  /** The read-back said, or answered, this turn: the decision model's reading of the answer and whether it confirmed. */
  readBack?: { text: string; yes?: number; no?: number; confirmed?: boolean };
  /**
   * The check after speaking (docs/designs/2026-11-11-claims-check.md), where the turn's reply was read: the
   * decision model's readings (null each where the check was unread: the model failed or was late), the
   * readings at or over their bars (agent.yaml `checks.claims`), the reading's time, whether the model was
   * asked to correct the reply, and how many of `replies`, at their end, are its correction. A correction
   * that failed (the model erred, was late, or kept calling actions) said nothing more and counted no failure
   * of the call: `correctionFailed`, with how it failed (`correctionError`); `model.error` and
   * `model.retried` stay the reply's own. A correction the model declined (asked, it answered with nothing at
   * all, having found its reply right after all): `corrected` true, `correction` 0, `declined`, and no failure.
   * A reply read as wrong while a read-back waited for the caller's yes: `carried`, its note kept for the next
   * message the model is sent (`corrected` false here; the record of the turn that sends it says `carriedNote`).
   */
  check?: { contradicted: number | null; notDone: number | null; gap: number | null; flagged: ('contradicted' | 'notDone' | 'gap')[]; ms: number; corrected: boolean; correction: number; correctionFailed?: true; correctionError?: string; declined?: true; carried?: true };
  /**
   * The check after speaking's note carried from an earlier turn (whose `check` says `carried`) went with this
   * turn's message to the model, after the caller's words or what came of the read-back. This turn's reply is
   * that note's answer, and is read on its own as usual (`check`).
   */
  carriedNote?: true;
  /**
   * The model answered the message carrying that note with nothing at all (taking the note's "say nothing of
   * it" for its whole answer): the note was taken out of the conversation and the model asked once more
   * without it, its answer taken as any is (an empty one a failure). The empty request is kept in
   * `model.requests` with no error.
   */
  carriedNoteDropped?: true;
  /**
   * How the caller's turn was routed among the journeys (docs/designs/2026-11-12-journeys.md, "Routing"), on a
   * business with journeys and a turn of the caller's that was routed (not a yes that ran its read-back): the
   * journey before and after (null: the root), the outcome, the decision model's probabilities for each `task`
   * option (null: no reading) and its `drops` and `again` readings where it gave them, its time, whether it
   * answered nothing within routing.timeoutMs (`timedOut`: the turn carried on), the older paused journey a
   * switch dropped, and whether the turn's first round was asked again for the route (`restarted`). A call
   * that starts in a journey (its `start`) has a route on its start turn too: from the root to that journey,
   * `start`, with no reading (`task` null) and `ms` 0, as nothing was asked. Routing that threw is a carry with
   * no reading. `unclear`: the line could not follow the turn (the design's "Amendment (2026-11-13)"), the count
   * of such turns in a row with it; absent on a turn that was not unclear.
   */
  route?: { from: string | null; to: string | null; outcome: RouteOutcome; task: Record<string, number> | null; drops?: number; again?: number; ms: number; timedOut?: true; droppedPaused?: string; restarted?: true; unclear?: number };
  /**
   * The runtime ended the call on this turn of its own accord: `unclear`, the third unclear turn in a row, on which
   * the line said lines.unclear and the call ended as end_call ends it (the state's `ended` is `closing`).
   */
  ended?: 'unclear';
  /** A journey the turn's confirmed action completed: it is in its after phase from this turn on. */
  journeyEnded?: { journey: string; how: 'done' };
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
