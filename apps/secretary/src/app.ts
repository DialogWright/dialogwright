import { fileURLToPath } from 'node:url';
import {
  ANONYMOUS, defineApp, handoff, replyShape,
  type AppCode, type Completion, type CompletionContext, type Session, type ToolDef,
} from 'dialogwright';
import { INBOX_OF } from './data';

/**
 * Example Front Desk, built from its folder: the phone answered for a small, fictional design studio
 * when no one can pick up. The YAML next to this src/ folder holds what is data (what a caller can ask
 * for, the message form, every line the caller hears, the gate's rules); this file holds what runs:
 * the one tool, which delivers a message to the studio's inbox, and the hooks of the two forms.
 *
 * What it teaches, beside the clinic: a framed line. The read-back of the message
 * (prompts.yaml's confirm_take_message) is fixed and says whose words follow; only the summary of the
 * caller's message inside it is generated, from the message alone. Nothing here sees the summary: the
 * slot keeps the message as the caller said it, the caller's yes arms exactly what the slots hold, and
 * the tool is sent the message word for word, whatever the summary said.
 *
 * Policy is never in a tool: the gate decides, from policy.yaml, whether a tool may run.
 * `dialogwright check` imports this module and checks the folder against `code`.
 */

/** The app's folder: the one with app.yaml, above this src/. */
export const APP_DIR = fileURLToPath(new URL('..', import.meta.url));

/** A message delivered to the studio's inbox. */
export interface Message {
  ref: string;
  /** The inbox it went to (data.ts). */
  inbox: string;
  recipient: string;
  caller: string;
  phone: string;
  /** Exactly as the caller said it. */
  message: string;
}

/**
 * The app's systems for one call (App.systems builds a fresh one per call). Here they are a stub: a
 * fake inbox, the messages delivered so far, held in memory, with the write keys it has seen. Replace
 * this with a client for the real inbox (an email or a ticket system), and keep the tests on a stub
 * like this one.
 */
export class Systems {
  readonly inbox: Message[] = [];
  /** The write key of each message delivered, so a repeat of the same write is not delivered twice. */
  readonly delivered = new Map<string, string>();
}

/** The slots the write carries, in the order the confirmation hash is taken over (policy.yaml's `confirmed`). */
const WRITTEN = ['recipient', 'caller', 'phone', 'message'] as const;

/** Every tool, by name; each has an action in policy.yaml, and policy.yaml names no other. */
export const TOOLS: Record<string, ToolDef> = {
  // A write: the message delivered to the inbox of the person it is for. The gate has already checked
  // that the caller said yes to exactly these values (the `confirmed` rule in policy.yaml).
  leaveMessage: {
    // The params its calls carry: the policy's `audit` says how each is recorded (policy.yaml).
    params: [...WRITTEN],
    // A repeat of the same write (a call resumed after a restart says yes again) is not delivered twice:
    // the inbox keeps the key and answers a repeat with the first delivery's reference.
    idempotent: true,
    run(call, sys, { idempotencyKey }) {
      const systems = sys as Systems;
      const seen = idempotencyKey === undefined ? undefined : systems.delivered.get(idempotencyKey);
      if (seen !== undefined) return { value: { ref: seen }, summary: `message ${seen} (already delivered)`, ref: seen };
      const p = call.params;
      const ref = `M${101 + systems.inbox.length}`;
      systems.inbox.push({
        ref, inbox: INBOX_OF[p.recipient ?? ''] ?? INBOX_OF.anyone!,
        recipient: p.recipient ?? '', caller: p.caller ?? '', phone: p.phone ?? '', message: p.message ?? '',
      });
      if (idempotencyKey !== undefined) systems.delivered.set(idempotencyKey, ref);
      return { value: { ref }, summary: `message ${ref}`, ref };
    },
    // The inbox's reply is not trusted: its reference is recorded with the write, so it must be a
    // reference. A reply that is not is never used, and a person takes the call.
    check: replyShape.object({ ref: replyShape.code() }),
  },
};

/** The values the write carries, read from the session: what the caller heard read back and said yes to, the message word for word. */
const messageParams = (s: Session): Record<string, string> => Object.fromEntries(WRITTEN.map((id) => [id, s.slots[id]?.value ?? '']));

/** The message form is full and the caller said yes: deliver it through the gate, and say so. */
function completeMessage(c: CompletionContext): Completion {
  const { s, acks } = c;
  // Arm the confirmed rule with the hash of what the read-back said.
  s.confirmedHash = s.pendingHash;
  const { decision } = c.callTool({ tool: 'leaveMessage', params: messageParams(s) });
  s.confirmedHash = null;
  // The caller changed something with their yes: the gate refused the write, so read it back again.
  if (decision.verdict === 'BLOCK' && decision.reason === 'confirmation') return { kind: 'reconfirm', acks };
  if (decision.verdict !== 'ALLOW') return c.refusal(decision);
  s.pendingHash = null;
  // The call ends on the line, then the goodbye.
  return { kind: 'end', promptId: 'message_taken', vars: { recipient: s.slots.recipient?.display ?? '' }, acks };
}

/**
 * Urgent: straight to the studio's main line, with the reason `urgent` (handoff_urgent is the line;
 * app.yaml's transfer says where it goes). The engine acknowledged the request on entering the form
 * ("Sure, I can help you reach the studio's main line."); drop it, so the caller hears one sentence.
 */
function toMainLine(c: CompletionContext): Completion {
  return { kind: 'decision', decision: handoff(c.s, 'urgent', c.acks.filter((a) => a.promptId !== 'ack_intent')) };
}

/** The app's TypeScript parts: everything the YAML names that runs. */
export const code: AppCode = {
  // Every slot is a library type in slots.yaml.
  slots: {},
  tools: TOOLS,
  systems: () => ({ sys: new Systems(), lookups: { ownerOf: () => null, scopeOf: () => [] } }),
  forms: {
    take_message: { confirmedParams: messageParams, complete: completeMessage },
    urgent: { complete: toMainLine },
  },
  // What the regression harness and the stub clients need (never used on a live call).
  testing: {
    // What `pnpm cli --client heuristic` listens for, in the order the first match wins.
    heuristics: {
      intents: [
        ['urgent', /\b(urgent|emergency|right now)\b/],
        ['studio_hours', /\b(hours|open|close)\b/],
        ['studio_address', /\b(address|where are you|located)\b/],
        ['take_message', /\b(message|call me back|callback|tell)\b/],
      ],
    },
    // The state a corpus line spoken mid-call is seeded with. The app verifies no one, so a seeded
    // caller is the anonymous one; each slot a seeded form has already collected has a stand-in value.
    seed: {
      caller: () => ANONYMOUS,
      placeholders: {
        recipient: { value: 'riley', display: 'Riley Moreno' },
        caller: { value: 'Alex Rivera', display: 'Alex Rivera' },
        phone: { value: '5555550142', display: '555 555 0142' },
        message: { value: 'the logo files are ready for review', display: 'the logo files are ready for review' },
      },
      // A message taken ends the call, so "anything else?" follows only a request the line could not
      // handle; a corpus line at anything_else is seeded as after a message.
      anythingElse: () => ({ form: 'take_message' }),
    },
    // The callers the gate grid crosses with the one action, for the policy read back: `pnpm
    // policy:matrix` writes policy.matrix from them, `pnpm policy:card` POLICY.md and `pnpm app:diagram`
    // APP-MAP.md. The app verifies no one and no one acts for others, so every caller gets the same
    // answer; the grid still tries a delegate whose role no rule names, one with no role, and a party
    // of another kind, so a rule added later that treats them differently shows in the matrix.
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
      values: { recipient: 'riley', caller: 'Alex Rivera', phone: '5555550142', message: 'the logo files are ready for review' },
    }),
  },
};

/** The app: the folder joined with the code above. */
export const app = defineApp(APP_DIR, code, { codeFile: 'src/app.ts' });
