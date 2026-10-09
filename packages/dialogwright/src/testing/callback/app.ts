import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANONYMOUS, defineApp, type AppCode, type Completion, type CompletionContext, type Session, type ToolDef } from '../../index';
import type { CorpusSlotLabels } from '../../core/app/types';

/**
 * Example Callbacks: a small, fictional line that sets up a callback, written as an app folder. It is
 * the engine's fixture for a slot that offers the number the caller is calling from (a `digits`
 * slot's `callerNumber`, core/callerNumber.ts): when the form reaches the phone slot and the call came
 * with a number that fits it, the line asks whether that number is the best one to reach the caller
 * (`offer_phone`, by its last four digits) rather than asking for it. A yes fills the slot, a no asks
 * the slot's own question, and the summary reads the number back whole either way. All names and
 * numbers are made up (the 555 range).
 */

/** The folder this app's YAML is in. */
export const CALLBACK_DIR = dirname(fileURLToPath(import.meta.url));

/** A callback set up on a call. */
export interface Callback {
  ref: string;
  phone: string;
}

/** The app's systems for one call: the callbacks set up so far, in memory. */
export class CallbackSystems {
  readonly callbacks: Callback[] = [];
}

/** The slots the write carries, in the order the confirmation hash is taken over. */
const WRITTEN = ['caller', 'phone', 'reason'] as const;

export const TOOLS: Record<string, ToolDef> = {
  requestCallback: {
    params: [...WRITTEN],
    idempotent: true,
    run(call, sys) {
      const systems = sys as CallbackSystems;
      const ref = `C${101 + systems.callbacks.length}`;
      systems.callbacks.push({ ref, phone: call.params.phone ?? '' });
      return { value: { ref }, summary: `callback ${ref}`, ref };
    },
  },
};

/** The values the write carries, read from the session: what the caller heard read back and said yes to. */
const callbackParams = (s: Session): Record<string, string> => Object.fromEntries(WRITTEN.map((id) => [id, s.slots[id]?.value ?? '']));

/** The form is full and confirmed: set up the callback through the gate, and say so. */
function completeCallback(c: CompletionContext): Completion {
  const { s, acks } = c;
  s.confirmedHash = s.pendingHash;
  const { decision, value } = c.callTool({ tool: 'requestCallback', params: callbackParams(s) });
  s.confirmedHash = null;
  if (decision.verdict === 'BLOCK' && decision.reason === 'confirmation') return { kind: 'reconfirm', acks };
  if (decision.verdict !== 'ALLOW') return c.refusal(decision);
  s.pendingHash = null;
  const { ref } = value as { ref: string };
  return { kind: 'end', promptId: 'callback_booked', vars: { caller: s.slots.caller?.display ?? '', phone: s.slots.phone?.display ?? '', ref }, acks };
}

/** A corpus line's name label, the caller's name as said. */
const nameOf = (l: CorpusSlotLabels): string | undefined => (typeof l.caller === 'string' ? l.caller : undefined);
/** A corpus line's number label: the span said and the digits it is. */
const phoneOf = (l: CorpusSlotLabels): { span: string; value: string } | undefined => {
  const p = l.phone as { span?: unknown; value?: unknown } | undefined;
  return typeof p?.span === 'string' && typeof p.value === 'string' ? { span: p.span, value: p.value } : undefined;
};

/** The app's TypeScript parts. */
export const callbackCode: AppCode = {
  slots: {},
  tools: TOOLS,
  systems: () => ({ sys: new CallbackSystems(), lookups: { ownerOf: () => null, scopeOf: () => [] } }),
  forms: {
    request_callback: { confirmedParams: callbackParams, complete: completeCallback },
  },
  testing: {
    // The fixture stub's answers from a corpus line's slot labels: the name and the number as spans
    // of the words, the reason as a choice.
    labeled: {
      spans: {
        callerSpan: { what: 'caller', span: (l) => nameOf(l) },
        phoneSpan: { what: 'phone', span: (l) => phoneOf(l)?.span },
      },
      choice: { reason: (l) => (typeof l.reason === 'string' ? l.reason : undefined) },
      noul: {
        callerGiven: (l) => (nameOf(l) ? 0.92 : 0.05),
        phoneGiven: (l) => (phoneOf(l) ? 0.92 : 0.05),
        phoneComplete: (l) => (phoneOf(l) ? 0.9 : 0.1),
      },
    },
    heuristics: { intents: [['request_callback', /\b(call me back|callback|call back)\b/]] },
    seed: {
      caller: () => ANONYMOUS,
      placeholders: {
        caller: { value: 'Jordan Avery', display: 'Jordan Avery' },
        phone: { value: '5555550142', display: '555 555 0142' },
        reason: { value: 'order', display: 'an order' },
      },
      anythingElse: () => ({ form: 'request_callback' }),
    },
    policyMatrix: () => ({
      principals: {
        subject1: { kind: 'customer', level: 1, id: '55501234', first: 'Avery' },
        subject2: { kind: 'customer', level: 2, id: '55501234', first: 'Avery' },
        delegates: {},
        unlistedRole: { kind: 'staff', level: 2, id: 'S-1', first: 'Quinn', role: 'assistant' },
        roleless: { kind: 'staff', level: 2, id: 'S-2', first: 'Rowan' },
        otherParty: { kind: 'visitor', level: 2, id: 'V-1', first: 'Robin' },
      },
      records: {
        own: { subject: '55501234' },
        inScope: { subject: '55505678' },
        outOfScope: { subject: '55509012' },
        unknown: { subject: '55500000' },
      },
      values: { caller: 'Jordan Avery', phone: '5555550142', reason: 'order' },
    }),
  },
};

/** The app: the folder joined with the code above. */
export const callbackApp = defineApp(CALLBACK_DIR, callbackCode);

/** The code parts under the name `dialogwright check` imports them by. */
export const code = callbackCode;
