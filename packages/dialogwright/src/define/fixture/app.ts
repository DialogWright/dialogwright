import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addDays, defineApp, defineSlot, describeDay, slotLocaleOf,
  type AppCode, type Completion, type CompletionContext, type RuleContext, type RuleOutcome, type Session, type SlotSpec, type ToolDef,
} from '../../index';

/**
 * Example Town Library: a small, fictional library's phone line, written as an app folder. The YAML
 * beside this file holds its intents, forms, prompts, policy and presentation; this file holds what
 * runs: three slots (a book from the catalog and a branch, library `choice` slots, and a library
 * card number, a library `digits` slot), three tools, one rule of the app's own, and the three
 * forms' hooks. It speaks English and Spanish: locale/es/ has the Spanish lines and how the books and
 * branches are said in Spanish (slots.yaml), and the lines its code says give each book and due day
 * in the call's language. A caller renews a book (a confirmed write, so the
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

/**
 * The library card number: a value no list holds, so the model cannot choose it from one. It is
 * asked whether a number is said, which span of the words it is, and whether it was said whole;
 * the code turns the span into digits and checks them. A library `digits` slot: eight digits, keyed
 * on the keypad after two misses, acknowledged (ack_card) when the model is less sure of the span,
 * refused when it is unsure of it, re-asked with its own line (ask_card_length) when the digits are
 * not eight, recorded and handed over by its last four.
 */
export const cardSlot = defineSlot('card', {
  type: 'digits',
  noun: 'library card',
  length: 8,
  keypad: true,
  confirm: 'by-confidence',
  readBack: 'below-fill',
  minConfidence: 'SLOT_CHOICE_CONFIRM',
  lengthRetryPromptId: 'ask_card_length',
});

/**
 * The book the caller names: a library `choice` slot over the catalog (BOOKS, each key with its
 * title). The model picks a key; the line says the title. One question, `book`, whose criteria are
 * "The caller names <title>" for each book and "Names none of these".
 */
export const bookSlot = defineSlot('book', {
  type: 'choice',
  text: { instructions: 'Read asr.text. Which book in the catalog does the caller name?' },
  options: BOOKS,
});

/** The branch the caller names: a library `choice` slot over BRANCHES. */
export const branchSlot = defineSlot('branch', {
  type: 'choice',
  text: { instructions: 'Read asr.text. Which library branch does the caller name?' },
  options: BRANCHES,
});

export const LIBRARY_SLOTS: Record<string, SlotSpec> = { book: bookSlot, branch: branchSlot, card: cardSlot };

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
  return { kind: 'said', acks: [...acks, { promptId: 'renewed', vars: { book: displayOf(s, 'book'), due: describeDay(due, slotLocaleOf(s)) } }] };
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
  // The book and the day as the call's language says them: the book slot's display (its Spanish
  // wording in a Spanish call), the day in that language's words.
  const locale = slotLocaleOf(s);
  return { kind: 'said', acks: [...acks, { promptId: 'next_due', vars: { card, book: libraryApp.slots.book!.display(next.book, locale), due: describeDay(next.due, locale) } }] };
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
