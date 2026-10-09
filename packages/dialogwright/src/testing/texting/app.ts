import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANONYMOUS, callerOf, defineApp, type AppCode, type AppContext, type Completion, type CompletionContext, type Session, type SessionFacts, type ToolDef } from '../../index';
import type { CorpusSlotLabels, SummaryContext, SummaryRead } from '../../core/app/types';

/**
 * Example Requests: a small, fictional line that opens a request and offers to text updates about
 * it, written as an app folder. It is the engine's fixture for the number the caller is calling from
 * used by the app's own code and policy (app.yaml's `callerNumber: { use: hint }`): a hint, never
 * identity.
 *
 * - At call start the engine looks the number up once (`findCallerByPhone`, through the gate, before
 *   the greeting), and the line type it finds goes to the facts (fromCallerLookup).
 * - The `textTo` slot offers the number as a yes or no ("Can I text you updates at the number you're
 *   calling from, ending in 0142?"); a no, no answer, or no number to offer leaves it empty and no
 *   text is sent (`onNo`, `ifNone: skip`). The app's callerOffer hook refuses the offer for a landline,
 *   asking the gated `lineType` lookup for a number the call-start lookup did not know.
 * - The text is sent by `sendUpdates`, which the gate's callerNumber rule holds to the caller's own
 *   number, or to one the caller heard read back at the summary and said yes to.
 *
 * All numbers are made up (the 555 range).
 */

/** The folder this app's YAML is in. */
export const TEXTING_DIR = dirname(fileURLToPath(import.meta.url));

/** A line's type, as the fixture's systems know it. */
export type LineType = 'mobile' | 'landline' | 'unknown';

/** The numbers on file (as a session keeps them), by line type: what the call-start lookup finds. */
export const ON_FILE: Readonly<Record<string, Exclude<LineType, 'unknown'>>> = { '+15555550142': 'mobile', '+15555550143': 'landline' };

/** The numbers the line-type lookup knows beside those on file. */
export const LINE_TYPES: Readonly<Record<string, Exclude<LineType, 'unknown'>>> = { ...ON_FILE, '+15555550144': 'mobile', '+15555550145': 'landline' };

/** A request opened on a call, and the texts set up for it. */
export interface Request {
  ref: string;
  topic: string;
}

/** The app's systems for one call: the requests opened and the texts set up so far, in memory, and the lookups' answers. */
export class TextingSystems {
  readonly requests: Request[] = [];
  readonly texts: { ref: string; to: string }[] = [];
  /** How many times each lookup ran, by tool. */
  readonly lookedUp: Record<string, number> = {};
}

/** The session facts: the caller's line type, once a lookup has said it. */
export interface TextingFacts extends SessionFacts {
  lineType?: LineType;
}

/** The slots the write carries, in the order the confirmation hash is taken over. */
const WRITTEN = ['topic', 'textTo'] as const;

const counted = (sys: TextingSystems, tool: string): void => {
  sys.lookedUp[tool] = (sys.lookedUp[tool] ?? 0) + 1;
};

export const TOOLS: Record<string, ToolDef> = {
  // The call-start lookup: the line type of a number on file, and nothing else about the record.
  findCallerByPhone: {
    params: ['callerNumber'],
    run(call, sys) {
      const systems = sys as TextingSystems;
      counted(systems, 'findCallerByPhone');
      const found = ON_FILE[call.params.callerNumber ?? ''];
      return found === undefined ? { value: null, summary: 'no line on file' } : { value: { lineType: found }, summary: 'a line on file' };
    },
  },
  lineType: {
    params: ['callerNumber'],
    run(call, sys) {
      const systems = sys as TextingSystems;
      counted(systems, 'lineType');
      const lineType: LineType = LINE_TYPES[call.params.callerNumber ?? ''] ?? 'unknown';
      return { value: { lineType }, summary: `line type ${lineType}` };
    },
  },
  openRequest: {
    params: [...WRITTEN],
    idempotent: true,
    run(call, sys) {
      const systems = sys as TextingSystems;
      const ref = `R${101 + systems.requests.length}`;
      systems.requests.push({ ref, topic: call.params.topic ?? '' });
      return { value: { ref }, summary: `request ${ref}`, ref };
    },
  },
  sendUpdates: {
    params: [...WRITTEN],
    idempotent: true,
    run(call, sys) {
      const systems = sys as TextingSystems;
      const ref = systems.requests.at(-1)?.ref ?? '';
      systems.texts.push({ ref, to: call.params.textTo ?? '' });
      return { value: { sent: true }, summary: 'updates set up' };
    },
  },
};

/** The values the write carries, read from the session: what the caller heard read back and said yes to. */
const requestParams = (s: Session): Record<string, string> => Object.fromEntries(WRITTEN.map((id) => [id, s.slots[id]?.value ?? '']));

/** The form is full and confirmed: open the request through the gate, then set up the texts where there is a number. */
function completeRequest(c: CompletionContext): Completion {
  const { s, acks } = c;
  s.confirmedHash = s.pendingHash;
  const { decision, value } = c.callTool({ tool: 'openRequest', params: requestParams(s) });
  if (decision.verdict === 'BLOCK' && decision.reason === 'confirmation') {
    s.confirmedHash = null;
    return { kind: 'reconfirm', acks };
  }
  if (decision.verdict !== 'ALLOW') {
    s.confirmedHash = null;
    return c.refusal(decision);
  }
  const { ref } = value as { ref: string };
  const textTo = s.slots.textTo;
  if (textTo?.value == null) {
    s.confirmedHash = null;
    s.pendingHash = null;
    return { kind: 'end', promptId: 'request_opened', vars: { ref }, acks };
  }
  const sent = c.callTool({ tool: 'sendUpdates', params: requestParams(s) });
  s.confirmedHash = null;
  s.pendingHash = null;
  if (sent.decision.verdict !== 'ALLOW') return { kind: 'end', promptId: 'request_opened_no_text', vars: { ref }, acks };
  return { kind: 'end', promptId: 'request_opened_text', vars: { ref, textTo: textTo.display ?? '' }, acks };
}

/** The summary names the number to text only when there is one. */
function readRequest(c: SummaryContext): SummaryRead | null {
  return c.s.slots.textTo?.value != null ? { promptId: 'confirm_open_request_text' } : null;
}

/**
 * Whether the number the caller is calling from may be offered for texts: only a mobile. The line
 * type is the call-start lookup's, where it found the number; otherwise the gated line-type lookup's,
 * kept in the facts. A refused lookup, or a line it does not know, makes no offer.
 */
function offerToMobile(ctx: AppContext, _slot: string): boolean {
  // Every number the line texts is offered only for a mobile (textTo here; its variants text alertTo too).
  const facts = ctx.s.facts as TextingFacts;
  if (facts.lineType === undefined) {
    const caller = callerOf(ctx.s);
    if (caller === null) return false;
    const { decision, value } = ctx.callTool({ tool: 'lineType', params: { callerNumber: caller.number } });
    facts.lineType = decision.verdict === 'ALLOW' ? ((value as { lineType?: LineType } | null)?.lineType ?? 'unknown') : 'unknown';
  }
  return facts.lineType === 'mobile';
}

/** A corpus line's number label: the span said and the digits it is. */
const textToOf = (l: CorpusSlotLabels): { span: string; value: string } | undefined => {
  const p = l.textTo as { span?: unknown; value?: unknown } | undefined;
  return typeof p?.span === 'string' && typeof p.value === 'string' ? { span: p.span, value: p.value } : undefined;
};

/** The app's TypeScript parts. */
export const textingCode: AppCode = {
  slots: {},
  tools: TOOLS,
  systems: () => ({ sys: new TextingSystems(), lookups: { ownerOf: () => null, scopeOf: () => [] } }),
  forms: {
    open_request: { confirmedParams: requestParams, complete: completeRequest, onSummaryRead: readRequest },
  },
  facts: {
    initial: (): TextingFacts => ({}),
    clone: (f) => ({ ...f }),
    fromCallerLookup(f, value) {
      const lineType = (value as { lineType?: unknown } | null)?.lineType;
      if (lineType === 'mobile' || lineType === 'landline') (f as TextingFacts).lineType = lineType;
    },
  },
  callerOffer: offerToMobile,
  testing: {
    // The fixture stub's answers from a corpus line's slot labels: the number as a span of the
    // words, the topic as a choice.
    labeled: {
      spans: { textToSpan: { what: 'textTo', span: (l) => textToOf(l)?.span } },
      choice: { topic: (l) => (typeof l.topic === 'string' ? l.topic : undefined) },
      noul: {
        textToGiven: (l) => (textToOf(l) ? 0.92 : 0.05),
        textToComplete: (l) => (textToOf(l) ? 0.9 : 0.1),
      },
    },
    heuristics: { intents: [['open_request', /\b(open a request|request|report)\b/]] },
    seed: {
      caller: () => ANONYMOUS,
      // The number a seeded consent question is asked for (its variants' textConsent), as a carrier sends it.
      callerNumber: '+15555550142',
      placeholders: {
        topic: { value: 'order', display: 'an order' },
        textTo: { value: '5555550142', display: '555 555 0142' },
      },
      anythingElse: () => ({ form: 'open_request' }),
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
      // The grid's caller calls from this number (and, on the other half of the grid, from none).
      callerNumber: '+15555550142',
      calls: {
        findCallerByPhone: { own: { callerNumber: '+15555550142' }, other: { callerNumber: '+15555550199' } },
        lineType: { own: { callerNumber: '+15555550142' }, other: { callerNumber: '+15555550199' } },
        sendUpdates: { own: { topic: 'order', textTo: '5555550142' }, other: { topic: 'order', textTo: '5555550199' } },
      },
      values: { topic: 'order', textTo: '5555550142' },
    }),
  },
};

/** The app: the folder joined with the code above. */
export const textingApp = defineApp(TEXTING_DIR, textingCode);

/** The code parts under the name `dialogwright check` imports them by. */
export const code = textingCode;
