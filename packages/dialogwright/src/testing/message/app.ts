import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANONYMOUS, defineApp, replyShape, type AppCode, type Completion, type CompletionContext, type Session, type ToolDef } from '../../index';
import type { CorpusSlotLabels } from '../../core/app/types';

/**
 * Example Office: a small, fictional line that takes a message for one of two people, written as an
 * app folder. It is the engine's fixture for generated wording (design section 5):
 *
 * - The message form's lines are generated (forms.yaml's `wording: generative`): a model words each
 *   question for the moment, held to its fixed line's data and meaning, the fixed line said whenever a
 *   check fails or the model is slow. A keypad instruction says `mode: fixed`.
 * - The read-back is generated from the message itself (prompts.yaml's `from: [message]`), as a
 *   secretary would read back a summary, the first time it is said (`when: first-ask`). The message is
 *   stored exactly as the caller said it; a caller who pushes back hears it word for word: asking to
 *   hear it again (`repeat_prompt`) replays the fixed line, and a read-back after a no is the fixed line.
 * - The greeting and the line said once the message is passed on are prescribed (`prescribed: true`):
 *   always word for word, whatever the form says. The policy card lists both kinds.
 *
 * All names and numbers are made up (the 555 range).
 */

/** The folder this app's YAML is in. */
export const MESSAGE_DIR = dirname(fileURLToPath(import.meta.url));

/** A message passed on. */
export interface Message {
  ref: string;
  recipient: string;
  caller: string;
  phone: string;
  /** Exactly as the caller said it. */
  message: string;
}

/** The app's systems for one call: the messages passed on so far, in memory. */
export class MessageSystems {
  readonly messages: Message[] = [];
}

/** The slots the write carries, in the order the confirmation hash is taken over. */
const WRITTEN = ['recipient', 'caller', 'phone', 'message'] as const;

export const TOOLS: Record<string, ToolDef> = {
  leaveMessage: {
    params: [...WRITTEN],
    idempotent: true,
    run(call, sys) {
      const systems = sys as MessageSystems;
      const ref = `M${101 + systems.messages.length}`;
      const p = call.params;
      systems.messages.push({ ref, recipient: p.recipient ?? '', caller: p.caller ?? '', phone: p.phone ?? '', message: p.message ?? '' });
      return { value: { ref }, summary: `message ${ref}`, ref };
    },
    // The reference is said to the caller: a reply whose reference is not one is never used.
    check: replyShape.object({ ref: replyShape.code() }),
  },
};

/** The values the write carries, read from the session: what the caller heard read back and said yes to, the message word for word. */
const messageParams = (s: Session): Record<string, string> => Object.fromEntries(WRITTEN.map((id) => [id, s.slots[id]?.value ?? '']));

/** The form is full and confirmed: pass the message on through the gate, and say so. */
function completeMessage(c: CompletionContext): Completion {
  const { s, acks } = c;
  s.confirmedHash = s.pendingHash;
  const { decision, value } = c.callTool({ tool: 'leaveMessage', params: messageParams(s) });
  s.confirmedHash = null;
  if (decision.verdict === 'BLOCK' && decision.reason === 'confirmation') return { kind: 'reconfirm', acks };
  if (decision.verdict !== 'ALLOW') return c.refusal(decision);
  s.pendingHash = null;
  const { ref } = value as { ref: string };
  return { kind: 'end', promptId: 'message_taken', vars: { caller: s.slots.caller?.display ?? '', recipient: s.slots.recipient?.display ?? '', ref }, acks };
}

/** A corpus line's name label, the caller's name as said. */
const nameOf = (l: CorpusSlotLabels): string | undefined => (typeof l.caller === 'string' ? l.caller : undefined);
/** A corpus line's number label: the span said and the digits it is. */
const phoneOf = (l: CorpusSlotLabels): { span: string; value: string } | undefined => {
  const p = l.phone as { span?: unknown; value?: unknown } | undefined;
  return typeof p?.span === 'string' && typeof p.value === 'string' ? { span: p.span, value: p.value } : undefined;
};

/** The app's TypeScript parts. */
export const messageCode: AppCode = {
  slots: {},
  tools: TOOLS,
  systems: () => ({ sys: new MessageSystems(), lookups: { ownerOf: () => null, scopeOf: () => [] } }),
  forms: {
    take_message: { confirmedParams: messageParams, complete: completeMessage },
  },
  testing: {
    // The fixture stub's answers from a corpus line's slot labels: the name and the number as spans
    // of the words, the recipient as a choice; the message is the line's own words (messageGiven).
    labeled: {
      spans: {
        callerSpan: { what: 'caller', span: (l) => nameOf(l) },
        phoneSpan: { what: 'phone', span: (l) => phoneOf(l)?.span },
      },
      choice: { recipient: (l) => (typeof l.recipient === 'string' ? l.recipient : undefined) },
      noul: {
        callerGiven: (l) => (nameOf(l) ? 0.92 : 0.05),
        phoneGiven: (l) => (phoneOf(l) ? 0.92 : 0.05),
        phoneComplete: (l) => (phoneOf(l) ? 0.9 : 0.1),
      },
    },
    heuristics: { intents: [['take_message', /\b(message|call me back|callback)\b/]] },
    seed: {
      caller: () => ANONYMOUS,
      placeholders: {
        recipient: { value: 'dana', display: 'Dana Reyes' },
        caller: { value: 'Morgan Lee', display: 'Morgan Lee' },
        phone: { value: '5555550142', display: '555 555 0142' },
        message: { value: 'please call me about the March invoice before Friday', display: 'please call me about the March invoice before Friday' },
      },
      anythingElse: () => ({ form: 'take_message' }),
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
      values: { recipient: 'dana', caller: 'Morgan Lee', phone: '5555550142', message: 'please call me about the March invoice before Friday' },
    }),
  },
};

/** The app: the folder joined with the code above. */
export const messageApp = defineApp(MESSAGE_DIR, messageCode);

/** The code parts under the name `dialogwright check` imports them by. */
export const code = messageCode;
