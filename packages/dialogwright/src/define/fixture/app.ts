import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addDays, defineApp, describeDay, isChoice,
  type AppCode, type Completion, type CompletionContext, type RuleContext, type RuleOutcome, type Session, type SlotOutcome, type SlotSpec, type ToolDef,
} from '../../index';

/**
 * Example Town Library: a small, fictional library's phone line, written as an app folder. The YAML
 * beside this file holds its intents, forms, prompts, policy and presentation; this file holds what
 * runs: two slots (a book from the catalog, a branch), two tools, one rule of the app's own, and the
 * two forms' hooks. A caller renews a book (a confirmed write, so the gate's R3 holds it to the
 * title read back) or asks whether a hold is ready at a branch. The engine's tests build it with
 * defineApp and run calls through it.
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

export const LIBRARY_SLOTS: Record<string, SlotSpec> = {
  book: choiceSlot('book', BOOKS, 'Read asr.text. Which book in the catalog does the caller name?'),
  branch: choiceSlot('branch', BRANCHES, 'Read asr.text. Which library branch does the caller name?'),
};

/** What a hold looks like in the library's systems. */
export type HoldStatus = 'ready' | 'waiting';

/** The library's systems for one call: the holds on file and the renewals made on the call. */
export class LibrarySystems {
  readonly holds: Readonly<Record<string, HoldStatus>> = { 'river_atlas@north': 'ready', 'quiet_orchard@riverside': 'waiting' };
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

/** The library's code: everything the YAML names that runs. */
export const libraryCode: AppCode = {
  slots: LIBRARY_SLOTS,
  tools: LIBRARY_TOOLS,
  systems: () => ({ sys: new LibrarySystems(), lookups: { ownerOf: () => null, scopeOf: () => [] } }),
  forms: {
    renew_loan: { confirmedParams: renewParams, complete: renew },
    check_hold: { complete: checkHold },
  },
  customRules: { 'known-branch': knownBranch },
};

/** The code parts under the name `dialogwright check` imports an app module's code by. */
export const code = libraryCode;

/** The library line, built from this folder and the code above. */
export const libraryApp = defineApp(LIBRARY_DIR, libraryCode);
