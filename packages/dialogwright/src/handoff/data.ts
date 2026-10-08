import type { App, HandoffData, HandoffSend, HandoffUnconfirmed, SlotId } from '../core/app/types';
import type { SlotSpec } from '../core/slots/types';
import { maskCollectedSlot } from '../trace/redact';

/**
 * What a transfer hands the channel of the collected slots (app.yaml `handoff.data`, HandoffData).
 * On a phone call it is the relay's `end` frame: the carrier holds it and posts it back on its
 * action callback, so it leaves the engine. The default keeps verification factors off the carrier:
 * an identity factor slot is omitted, a slot the app redacts goes masked as the trace masks it, and
 * any other slot goes as the handoff decision holds it (core/decision.ts handoff). A chat's
 * transfer sends no collected values at all (channel/chat/protocol.ts), whatever this says.
 */

/** The ways a slot can go, in the order the docs list them. */
export const HANDOFF_SEND_VALUES: readonly HandoffSend[] = ['omit', 'masked', 'as-is'];

/** What a transfer may do with a value the caller never confirmed (HandoffData.unconfirmed), in the order the docs list them. */
export const HANDOFF_UNCONFIRMED_VALUES: readonly HandoffUnconfirmed[] = ['send', 'mark', 'omit'];

/** The parts of an app this reads: its slots, its identity factors, and its handoff option. */
type HandoffApp = Pick<App, 'slots' | 'identity' | 'handoff'>;

function isFactor(app: Pick<App, 'identity'>, slot: SlotId): boolean {
  return app.identity?.factorSlots.includes(slot) ?? false;
}

/** How `slot` goes when the app says nothing of it: a factor omitted, a redacted slot masked, any other as it is. */
export function defaultHandoffSend(app: Pick<App, 'slots' | 'identity'>, slot: SlotId): HandoffSend {
  if (isFactor(app, slot)) return 'omit';
  return app.slots[slot]?.redact !== undefined ? 'masked' : 'as-is';
}

/** How `slot` goes into the handoff data: omitted when it is not one the option sends, else its own `send` or the default. */
export function handoffSendOf(app: HandoffApp, slot: SlotId): HandoffSend {
  if (!Object.hasOwn(app.slots, slot)) return 'omit';
  const data = app.handoff?.data;
  const which = data?.slots ?? 'all';
  if (which === 'none' || (which !== 'all' && !which.includes(slot))) return 'omit';
  const send = data?.send;
  return send !== undefined && Object.hasOwn(send, slot) ? send[slot]! : defaultHandoffSend(app, slot);
}

/**
 * The handoff data's slots, from what the handoff decision collected (HandoffDecision.slots): each
 * left out, masked or kept as handoffSendOf says. A name that is not one of the app's slots is left
 * out, and so, where the app says `unconfirmed: omit`, is each of `unconfirmed`
 * (HandoffDecision.unconfirmed), the values the caller never confirmed.
 */
export function handoffDataSlots(app: HandoffApp, collected: Readonly<Record<string, string>>, unconfirmed: readonly SlotId[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  const omitted = app.handoff?.data?.unconfirmed === 'omit' ? new Set(unconfirmed) : null;
  for (const [slot, value] of Object.entries(collected)) {
    const send = handoffSendOf(app, slot);
    if (send === 'omit' || omitted?.has(slot) === true) continue;
    out[slot] = send === 'masked' ? maskCollectedSlot(app, slot, value) : value;
  }
  return out;
}

/**
 * The values the handoff data names as never confirmed (the end frame's `unconfirmed`): with
 * `unconfirmed: mark`, those of `unconfirmed` that the data sends (`sent`, handoffDataSlots), in their
 * order. Undefined with any other setting, so the frame is as it was.
 */
export function handoffDataUnconfirmed(app: Pick<App, 'handoff'>, sent: Readonly<Record<string, string>>, unconfirmed: readonly SlotId[] | undefined): SlotId[] | undefined {
  if (app.handoff?.data?.unconfirmed !== 'mark' || unconfirmed === undefined) return undefined;
  return unconfirmed.filter((slot) => Object.hasOwn(sent, slot));
}

/** One thing wrong with an app's handoff data option, at its path under `handoff.data`. */
export interface HandoffDataProblem {
  readonly path: readonly (string | number)[];
  readonly message: string;
  readonly fix: string;
  /** The slot named that is not one of the app's, so a folder's check can give its own fix. */
  readonly unknownSlot?: string;
}

/** A slot `masked` can mask: one the app redacts, or one whose own handoff setting is last4 or verified. */
function maskable(spec: Pick<SlotSpec, 'redact' | 'handoff'> | undefined): boolean {
  return spec?.redact !== undefined || spec?.handoff === 'last4' || spec?.handoff === 'verified';
}

/**
 * Everything wrong with an app's handoff data option (`check` for a folder, validateApp for an app
 * built in code): a slot that is not one, a way of sending that is not one of the three, a slot
 * listed twice, a listed slot the option would still leave out (an identity factor with no `send`,
 * or one sent `omit`), a `send` for a slot that is never sent, and `masked` for a slot with nothing
 * to mask it by, which would send it in the clear. `slots` are the app's, `factors` its identity
 * factor slots.
 */
export function handoffDataProblems(
  data: HandoffData | undefined,
  slots: Readonly<Record<SlotId, Pick<SlotSpec, 'redact' | 'handoff'> | undefined>>,
  factors: readonly SlotId[],
): HandoffDataProblem[] {
  if (data === undefined) return [];
  const problems: HandoffDataProblem[] = [];
  const add = (path: readonly (string | number)[], message: string, fix: string, unknownSlot?: string): void => {
    problems.push(unknownSlot === undefined ? { path, message, fix } : { path, message, fix, unknownSlot });
  };
  const known = (slot: string): boolean => Object.hasOwn(slots, slot);
  const which = data.slots;
  const listed = Array.isArray(which) ? (which as readonly SlotId[]) : null;
  if (which !== undefined && which !== 'all' && which !== 'none' && listed === null) {
    add(['slots'], `${JSON.stringify(which)} is not "all", "none" or a list of slots`, 'write all (the default), none, or a list of slot ids');
  }
  if (data.unconfirmed !== undefined && !HANDOFF_UNCONFIRMED_VALUES.includes(data.unconfirmed)) {
    add(['unconfirmed'], `${JSON.stringify(data.unconfirmed)} is not one of ${HANDOFF_UNCONFIRMED_VALUES.map((v) => `"${v}"`).join(', ')}`, 'write send (the default), mark or omit');
  }
  const send = data.send ?? {};
  listed?.forEach((slot, i) => {
    if (!known(slot)) return add(['slots', i], `slot "${slot}" is not defined`, 'name one of the app\'s slots, or take it out', slot);
    if (listed.indexOf(slot) !== i) return add(['slots', i], `slot "${slot}" is listed twice`, 'take out the second');
    if (Object.hasOwn(send, slot)) return;
    if (factors.includes(slot)) {
      add(['slots', i], `the slot "${slot}" is listed, but as an identity factor it is omitted unless send says how it goes`, `say how under send ("${slot}: masked", or as-is to send it in the clear), or take it out of slots`);
    }
  });
  for (const [slot, how] of Object.entries(send)) {
    if (!known(slot)) {
      add(['send', slot], `slot "${slot}" is not defined`, 'name one of the app\'s slots, or delete it', slot);
      continue;
    }
    if (!HANDOFF_SEND_VALUES.includes(how)) {
      add(['send', slot], `${JSON.stringify(how)} is not one of ${HANDOFF_SEND_VALUES.map((v) => `"${v}"`).join(', ')}`, 'write omit, masked or as-is');
      continue;
    }
    if (which === 'none') {
      add(['send', slot], `the slot "${slot}" is never sent, since slots is none`, `delete "${slot}" from send, or list the slots to send`);
      continue;
    }
    if (listed !== null && !listed.includes(slot)) {
      add(['send', slot], `the slot "${slot}" is never sent, since slots does not list it`, `add "${slot}" to slots, or delete it from send`);
      continue;
    }
    if (listed !== null && how === 'omit') {
      add(['send', slot], `the slot "${slot}" is listed, but send omits it`, `take "${slot}" out of slots, or say masked or as-is`);
      continue;
    }
    if (how === 'masked' && !maskable(slots[slot])) {
      add(['send', slot], `the slot "${slot}" has no redact setting (or handoff: last4 or verified), so masked would send it as it is`, `give the slot a redact setting, or write as-is to send it in the clear`);
    }
  }
  return problems;
}
