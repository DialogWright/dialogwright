import { slotSpecOf } from './app/lookup';
import type { App, FormId, Outcome, SlotId } from './app/types';
import type { SlotSpec } from './slots/types';
import type { Ack } from './fia';
import type { Thresholds } from './thresholds';

/**
 * A slot's retries (design 2026-10-09-per-slot-retries): how many failed answers it takes
 * (SlotSpec.attempts), and what follows when it runs out (SlotSpec.onMaxAttempts).
 */

/** How many failed answers `slot` takes before its outcome: its own `attempts`, else the run's MAX_ATTEMPTS. */
export function attemptsOf(app: App, slot: SlotId, t: Thresholds): number {
  return slotSpecOf(app, slot).attempts ?? t.MAX_ATTEMPTS;
}

/** Whether the app has the line `id` (its prompts.yaml; a locale without it says the default's). */
function hasLine(app: App, id: string): boolean {
  return Object.hasOwn(app.prompts.manifest, id);
}

/**
 * The line a missed answer re-asks `slot` with at its `k`th failure: `ask_<slot>_retry<k>` where the
 * app has it, else `ask_<slot>_retry`, the line every asked slot has.
 */
export function retryLineOf(app: App, slot: SlotId, k: number): string {
  const numbered = `ask_${slot}_retry${k}`;
  return hasLine(app, numbered) ? numbered : `ask_${slot}_retry`;
}

/**
 * The line a silence re-asks `slot` with at its `k`th failure, said as the whole turn:
 * `ask_<slot>_noinput<k>` where the app has it, else `ask_<slot>_noinput`; null where it has neither,
 * and the engine says the no-input line and the question as it always has.
 */
export function noInputLineOf(app: App, slot: SlotId, k: number): string | null {
  const numbered = `ask_${slot}_noinput${k}`;
  if (hasLine(app, numbered)) return numbered;
  const plain = `ask_${slot}_noinput`;
  return hasLine(app, plain) ? plain : null;
}

/** The handoff reason a slot that runs out goes to a person with, unless its outcome names another. */
export const MAX_ATTEMPTS_REASON = 'max-attempts';

/** A slot's onMaxAttempts as an Outcome: `handoff` (the default) and `skip` written out. */
export function slotOutcomeOf(spec: Pick<SlotSpec, 'onMaxAttempts'>): Outcome {
  const o = spec.onMaxAttempts;
  if (o === undefined || o === 'handoff') return { then: 'handoff' };
  if (o === 'skip') return { then: 'skip' };
  return o;
}

/** Whether a slot uses its own retries (SlotSpec.attempts or onMaxAttempts): only then is its running out recorded (TurnOut.exhausted). */
export function hasOwnRetries(spec: Pick<SlotSpec, 'attempts' | 'onMaxAttempts'>): boolean {
  return spec.attempts !== undefined || spec.onMaxAttempts !== undefined;
}

/**
 * An outcome as it acts (core/turn.ts actOn), its line placed: `acks` are the turn's acks with the
 * outcome's `say` last, except for `end`, whose line is `line`, said last of all as the call's end.
 */
export type Ending =
  | { then: 'end'; acks: Ack[]; line: Ack }
  | { then: 'anything-else'; acks: Ack[] }
  | { then: 'handoff'; reason: string; acks: Ack[] }
  | { then: 'form'; form: FormId; acks: Ack[] }
  | { then: 'skip'; acks: Ack[] };

/**
 * How `outcome` acts after `acks`: its `say` rendered with `vars` (the form's slot displays), and a
 * handoff's reason its own, else `reason` (a check's, the gate's; a slot's, max-attempts).
 */
export function endingOf(outcome: Outcome, acks: Ack[], vars: Record<string, string>, reason: string): Ending {
  const said: Ack[] = outcome.say === undefined ? [] : [{ promptId: outcome.say, vars }];
  switch (outcome.then) {
    case 'end':
      return { then: 'end', acks, line: said[0]! };
    case 'anything-else':
      return { then: 'anything-else', acks: [...acks, ...said] };
    case 'handoff':
      return { then: 'handoff', reason: outcome.reason ?? reason, acks: [...acks, ...said] };
    case 'form':
      return { then: 'form', form: outcome.form, acks: [...acks, ...said] };
    case 'skip':
      return { then: 'skip', acks: [...acks, ...said] };
  }
}

/** What the trace records of a slot that ran out (TraceRecord.slotExhausted, the slot_exhausted event). */
export interface SlotExhausted {
  readonly slot: SlotId;
  /** The failures it took, the last included. */
  readonly attempts: number;
  /** What followed (its onMaxAttempts' then). */
  readonly outcome: Outcome['then'];
}
