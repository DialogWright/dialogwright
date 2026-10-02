import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addDays, defineApp, describeDay, isChoice, matchesMask, noulValue, spokenToDigits,
  type AppCode, type Completion, type CompletionContext, type RuleContext, type RuleOutcome, type Session, type SlotOutcome, type SlotSpec, type ToolDef,
} from '../../index';

/**
 * Example Town Library: a small, fictional library's phone line, written as an app folder. The YAML
 * beside this file holds its intents, forms, prompts, policy and presentation; this file holds what
 * runs: three slots (a book from the catalog, a branch, a library card number), three tools, one rule
 * of the app's own, and the three forms' hooks. A caller renews a book (a confirmed write, so the
 * gate's R3 holds it to the title read back), asks whether a hold is ready at a branch, or asks what
 * is checked out on their card. The engine's tests build it with defineApp and run calls through it.
 */

/** The folder this app's YAML is in. */
export const LIBRARY_DIR = dirname(fileURLToPath(import.meta.url));

/** The catalog: each book's id, as the model picks it, and its title, as the line says it. */
export const BOOKS: Readonly<Record<string, string>> = {
  river_atlas: 'The River Atlas',
  quiet_orchard: 'A Quiet Orchard',
  clockwork_garden: 'The Clockwork Garden',
};

/** The branches a hold can be at. */
export const BRANCHES: Readonly<Record<string, string>> = { north: 'North', riverside: 'Riverside' };

/** A choice slot over a fixed list: the model picks an id, the line says its name. */
function choiceSlot(id: string, options: Readonly<Record<string, string>>, instructions: string): SlotSpec {
  const display = (value: string): string => options[value] ?? value;
  return {
    id,
    spokenConfirm: 'summary',
    // One question, named after the slot; nothing said beyond its ask and retry (a summary slot is
    // neither acknowledged nor read back on its own).
    questionIds: [id],
    prompts: [],
    questions: () => ({
      [id]: {
        type: 'choice',
        instructions,
        criteria: { ...Object.fromEntries(Object.entries(options).map(([key, name]) => [key, `The caller names ${name}`])), none: 'Names none of these' },
      },
    }),
    fill(answers, ctx): SlotOutcome {
      const a = answers[id];
      if (!isChoice(a) || !Object.hasOwn(options, a.choice)) return { kind: 'absent' };
      const p = a.probabilities[a.choice] ?? a.confidence;
      if (p < ctx.thresholds.SLOT_CHOICE_FILL) return { kind: 'absent' };
      return { kind: 'filled', value: a.choice, display: display(a.choice), confidence: p, confirm: 'none' };
    },
    display,
  };
}

/** A library card number: eight digits. */
export const CARD_MASK = /^\d{8}$/;

/**
 * The library card number: a value no list holds, so the model cannot choose it from one. It is
 * asked whether a number is said, which span of the words it is, and whether it was said whole;
 * the code turns the span into digits and checks them. Acknowledged when the model is less sure of the
 * span, keyed as eight digits after two misses, recorded and handed over by its last four.
 */
export const cardSlot: SlotSpec = {
  id: 'card',
  spokenConfirm: 'by-confidence',
  redact: 'last4',
  handoff: 'last4',
  detect: true,
  questionIds: ['cardGiven', 'cardSpan', 'cardComplete'],
  prompts: [
    { id: 'ask_card_length', why: 'the caller said a number that is not eight digits (the fill\'s retryPromptId)' },
    { id: 'ack_card', why: 'it acknowledges a card number it is less sure of', vars: ['card'] },
    { id: 'ask_card_dtmf', why: 'it asks for the card number on the keypad after spoken answers missed' },
  ],

  questions(ctx) {
    const criteria: Record<string, string | null> = {};
    for (const span of ctx.candidateSpans) criteria[span] = null;
    criteria.none = 'No span of asr.text is a library card number';
    return {
      cardGiven: {
        type: 'noul',
        instructions: 'Read asr.text. Does the caller state a library card number, as digits or as spoken number words?',
      },
      cardSpan: {
        type: 'choice',
        instructions: 'Read asr.text. Which of these spans is the library card number the caller states? Choose the span that covers the whole number as spoken, and no words that are not part of it. Choose none if no span is a card number.',
        criteria,
      },
      cardComplete: {
        type: 'noul',
        instructions: 'Read asr.text. If the caller states a library card number, do they finish saying the whole number rather than trailing off?',
      },
    };
  },

  fill(answers, ctx): SlotOutcome {
    const t = ctx.thresholds;
    if (noulValue(answers, 'cardGiven') < t.SLOT_DETECT) return { kind: 'absent' };
    if (noulValue(answers, 'cardComplete') < t.SLOT_DETECT) return { kind: 'invalid', reason: 'incomplete', raw: '' };
    const span = answers.cardSpan;
    if (!isChoice(span) || span.choice === 'none') return { kind: 'invalid', reason: 'no_span', raw: '' };
    const p = span.probabilities[span.choice] ?? span.confidence;
    if (p < t.SLOT_CHOICE_CONFIRM) return { kind: 'invalid', reason: 'low_confidence', raw: '' };
    const digits = spokenToDigits(span.choice);
    if (!matchesMask(digits, CARD_MASK)) return { kind: 'invalid', reason: 'length', raw: digits, retryPromptId: 'ask_card_length' };
    return { kind: 'filled', value: digits, display: digits, confidence: p, confirm: p >= t.SLOT_CHOICE_FILL ? 'none' : 'implicit' };
  },

  dtmf: {
    length: 8,
    parse: (digits) => (matchesMask(digits, CARD_MASK) ? { value: digits, display: digits } : null),
  },

  display: (value) => value,
};

export const LIBRARY_SLOTS: Record<string, SlotSpec> = {
  book: choiceSlot('book', BOOKS, 'Read asr.text. Which book in the catalog does the caller name?'),
  branch: choiceSlot('branch', BRANCHES, 'Read asr.text. Which library branch does the caller name?'),
  card: cardSlot,
};

/** What a hold looks like in the library's systems. */
export type HoldStatus = 'ready' | 'waiting';

/** A book out on a card, and the day it is due back (an ISO date). */
export interface Loan {
  book: string;
  due: string;
}

/** The library's systems for one call: the holds and the loans on file, and the renewals made on the call. */
export class LibrarySystems {
  readonly holds: Readonly<Record<string, HoldStatus>> = { 'river_atlas@north': 'ready', 'quiet_orchard@riverside': 'waiting' };
  /** By card number. */
  readonly loans: Readonly<Record<string, readonly Loan[]>> = {
    '55520417': [{ book: 'clockwork_garden', due: '2026-10-02' }, { book: 'quiet_orchard', due: '2026-09-25' }],
    '55531290': [],
  };
  readonly renewals: { ref: string; book: string; due: string }[] = [];
}

export const LIBRARY_TOOLS: Record<string, ToolDef> = {
  renewLoan: {
    run(call, sys, { tc }) {
      const systems = sys as LibrarySystems;
      const ref = `R${101 + systems.renewals.length}`;
      const due = addDays(tc.todayIso, 14);
      systems.renewals.push({ ref, book: call.params.book ?? '', due });
      return { value: { due }, summary: `renewed ${ref}`, ref };
    },
  },
  findHold: {
    run(call, sys) {
      const status = (sys as LibrarySystems).holds[`${call.params.book}@${call.params.branch}`] ?? null;
      return { value: status, summary: status ? `hold ${status}` : 'no hold' };
    },
  },
  // The param is named after the slot it carries, so the gate event, the trace and the audit
  // record it as the slot's redact says: by its last four.
  listLoans: {
    run(call, sys) {
      const { loans: onFile } = sys as LibrarySystems;
      const card = call.params.card ?? '';
      const loans = Object.hasOwn(onFile, card) ? onFile[card]! : null;
      return { value: loans, summary: loans ? `${loans.length} loans` : 'no card' };
    },
  },
};

/** The library's own rule: a hold is looked up only at a branch the library has. */
function knownBranch(c: RuleContext): RuleOutcome {
  const branch = c.call.params.branch ?? '';
  const known = Object.hasOwn(BRANCHES, branch);
  const result = { id: 'known-branch', description: 'The hold is at one of the library\'s branches', compared: known ? `branch ${branch}: known` : 'branch not known', pass: known };
  return known ? { result } : { result, fail: { verdict: 'BLOCK', reason: 'branch' } };
}

const valueOf = (s: Session, slot: string): string => s.slots[slot]?.value ?? '';
const displayOf = (s: Session, slot: string): string => s.slots[slot]?.display ?? '';

/** The renewal writes the book read back at the summary, once the caller said yes (R3). */
const renewParams = (s: Session): Record<string, string> => ({ book: valueOf(s, 'book') });

function renew(c: CompletionContext): Completion {
  const { s, acks } = c;
  s.confirmedHash = s.pendingHash;
  const { decision, value } = c.callTool({ tool: 'renewLoan', params: renewParams(s) });
  s.confirmedHash = null;
  if (decision.verdict === 'BLOCK' && decision.reason === 'confirmation') return { kind: 'reconfirm', acks };
  if (decision.verdict !== 'ALLOW') return c.refusal(decision);
  s.pendingHash = null;
  const { due } = value as { due: string };
  return { kind: 'said', acks: [...acks, { promptId: 'renewed', vars: { book: displayOf(s, 'book'), due: describeDay(due) } }] };
}

function checkHold(c: CompletionContext): Completion {
  const { s, acks } = c;
  const { decision, value } = c.callTool({ tool: 'findHold', params: { book: valueOf(s, 'book'), branch: valueOf(s, 'branch') } });
  if (decision.verdict !== 'ALLOW') return c.refusal(decision);
  const vars = { book: displayOf(s, 'book'), branch: displayOf(s, 'branch') };
  const promptId = value === 'ready' ? 'hold_ready' : value === 'waiting' ? 'hold_waiting' : 'no_hold';
  return { kind: 'said', acks: [...acks, { promptId, vars }] };
}

/** The book due back soonest on the card, or that nothing is out, or that there is no such card. */
function checkLoans(c: CompletionContext): Completion {
  const { s, acks } = c;
  const card = displayOf(s, 'card');
  const { decision, value } = c.callTool({ tool: 'listLoans', params: { card: valueOf(s, 'card') } });
  if (decision.verdict !== 'ALLOW') return c.refusal(decision);
  const loans = value as readonly Loan[] | null;
  if (loans === null) return { kind: 'said', acks: [...acks, { promptId: 'no_card', vars: { card } }] };
  const [next] = [...loans].sort((a, b) => a.due.localeCompare(b.due));
  if (!next) return { kind: 'said', acks: [...acks, { promptId: 'no_loans', vars: { card } }] };
  return { kind: 'said', acks: [...acks, { promptId: 'next_due', vars: { card, book: BOOKS[next.book] ?? next.book, due: describeDay(next.due) } }] };
}

/** The library's code: everything the YAML names that runs. */
export const libraryCode: AppCode = {
  slots: LIBRARY_SLOTS,
  tools: LIBRARY_TOOLS,
  systems: () => ({ sys: new LibrarySystems(), lookups: { ownerOf: () => null, scopeOf: () => [] } }),
  forms: {
    renew_loan: { confirmedParams: renewParams, complete: renew },
    check_hold: { complete: checkHold },
    check_loans: { complete: checkLoans },
  },
  customRules: { 'known-branch': knownBranch },
};

/** The code parts under the name `dialogwright check` imports an app module's code by. */
export const code = libraryCode;

/** The library line, built from this folder and the code above. */
export const libraryApp = defineApp(LIBRARY_DIR, libraryCode);
