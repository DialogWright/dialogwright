import { readFileSync } from 'node:fs';
import { defaultAppId, getApp } from '../core/app/registry';
import { identityOf } from '../core/app/lookup';
import type { App, CorpusSlotLabels, FormId, Intent, SlotId } from '../core/app/types';
import { ENGINE_QUESTION_IDS } from '../core/questions';

export interface AnswerOverride {
  noul?: number;
  probabilities?: Record<string, number>;
}

/**
 * The state an utterance is spoken in:
 * - `no_form`: the opener, nothing started and nobody verified;
 * - a form in progress, with a verified (level 2) caller whose facts are loaded, unless `prompted`
 *   is an identity factor, which seeds an anonymous caller mid step-up instead;
 * - `confirm_<form>`: the summary of a form that has one (report_missing);
 * - `offer_transfer`: the transfer offered to a frustrated caller, seeded
 *   inside a track_parcel form so that a declined offer has a question to return to;
 * - `anything_else`: a form just completed, no form open, the last prompt "anything else?".
 */
export type CorpusContext = 'no_form' | FormId | `confirm_${FormId}` | 'offer_transfer' | 'anything_else';

/**
 * The outcome fields a known gap may pin: every field of a regression outcome but its id
 * (harness-text/runner.ts Outcome, which checks at compile time that the two agree; jev never
 * imports the harness).
 */
export interface PinnedOutcome {
  decision?: string;
  promptId?: string | null;
  acks?: string[];
  reason?: string | null;
  decidedGate?: string | null;
  verdict?: string | null;
  form?: string | null;
  slots?: Record<SlotId, string | null>;
  queued?: string[];
  principalLevel?: number;
  gate?: string | null;
}

const PINNABLE: ReadonlySet<string> = new Set([
  'decision', 'promptId', 'acks', 'reason', 'decidedGate', 'verdict', 'form', 'slots', 'queued', 'principalLevel', 'gate',
] satisfies (keyof PinnedOutcome)[]);

/**
 * A documented gap between an entry's label and what a real decision model does with it: why, and
 * the outcome fields the model is known to produce instead (the baseline's outcome with these
 * fields overlaid is the known outcome). Only that exact outcome is tolerated; anything else the
 * model does on the entry still fails the run.
 */
export interface KnownGap {
  /** one line: what the model reads, and what follows from it */
  reason: string;
  /** the fields that differ from the baseline when the model shows the gap, each with the value it produces */
  outcome: PinnedOutcome;
}

/** An identity factor a step-up asks for (App.identity.factorSlots); `prompted` may name one in any form context. */
export type IdentityPrompt = SlotId;

export interface CorpusEntry {
  id: string;
  text: string;
  intent: Intent;
  /** the state this utterance is spoken in (CorpusContext) */
  context: CorpusContext;
  /** the slot the last prompt asked for: one on the form, or an identity factor mid step-up; defaults to the form's first missing slot */
  prompted?: SlotId;
  /** the slot values the utterance says, by slot id, in the labels the app's testing hooks read (App.testing.checkCorpusSlots) */
  slots?: CorpusSlotLabels;
  /**
   * What the utterance answers to a question that is neither the engine's nor read off a slot label,
   * by question id: a slot's own side question (e.g. whether the caller is unsure) or one of the
   * app's (App.questions; e.g. a part of the day). A choice or score question's label, or true or
   * false for a yes-or-no question. The fixture stub answers from these first, and throws, naming
   * the entry, on a label the question cannot give; a question not asked in the entry's state never
   * reads its label.
   */
  labels?: Readonly<Record<string, string | boolean>>;
  /** the caller hedges the request */
  tentative?: boolean;
  /** in-form only: the utterance adds a task or replaces the current one; absent means answering */
  change?: 'adding' | 'replacing';
  /** confirm_ and offer_transfer contexts only: how the utterance answers the question */
  confirm?: 'yes' | 'no' | 'unanswered';
  /** confirm_ contexts only: the detail the caller names when asked what to change */
  changeSlot?: SlotId;
  /** no_form and anything_else only: a second task named alongside the main one */
  secondIntent?: FormId;
  /** the utterance tries to instruct or manipulate the agent (the injection screen) */
  manipulation?: boolean;
  /** explicit distributions that replace the generated ones */
  answers?: Record<string, AnswerOverride>;
  tags?: string[];
  /**
   * A documented gap between this entry's label and what a real decision model does with it: the
   * reason, and the outcome the model is known to produce. A run against a real model's answers
   * (jev, record, recorded) reports that exact outcome as allowed instead of failing; any other
   * difference still fails. A stub run ignores it and must match the baseline exactly.
   */
  knownGap?: KnownGap;
  /**
   * no_form only: the entry is typed in a delegate's chat by this delegate (a delegate id the app lists,
   * e.g. "taylor" or "morgan"), signed in through the portal, rather than spoken by an anonymous caller.
   */
  as?: string;
}

/** The app a corpus is read against: the default one, which every session the harness starts gets. */
function corpusApp(): App {
  return getApp(defaultAppId());
}

function isForm(app: App, id: string): id is FormId {
  return Object.hasOwn(app.forms, id);
}

/**
 * confirm_ contexts only: the form behind the confirm, else null. Not a prefix test: a confirm_
 * context is exact membership, confirm_<FormId> for every form that asks a summary question
 * (e.g. report_missing; the other forms complete without one).
 */
export function confirmForm(context: CorpusContext, app: App = corpusApp()): FormId | null {
  if (!context.startsWith('confirm_')) return null;
  const form = context.slice('confirm_'.length);
  return isForm(app, form) && app.forms[form]!.summaryPromptId !== null ? form : null;
}

/** true for the transfer offer's context, which is a pending confirmation but not a form's summary */
export function offerTransfer(context: CorpusContext): boolean {
  return context === 'offer_transfer';
}

/** the form a context runs in: the form itself, the form behind a confirm_ context, or the offer's; null for no_form and anything_else */
export function contextForm(context: CorpusContext, app: App = corpusApp()): FormId | null {
  if (context === 'no_form' || context === 'anything_else') return null;
  // The form the transfer offer is seeded inside, so a declined offer has a question to come back to.
  if (offerTransfer(context)) return app.testing?.offerTransferForm ?? null;
  const cf = confirmForm(context, app);
  if (cf !== null) return cf;
  return isForm(app, context) ? context : null;
}

/** true for an identity factor named as the prompt: the entry seeds a step-up rather than a verified caller */
export function promptsIdentity(entry: Pick<CorpusEntry, 'prompted'>, app: App = corpusApp()): entry is { prompted: IdentityPrompt } {
  return entry.prompted !== undefined && identityOf(app).factorSlots.includes(entry.prompted);
}

export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

const ENTRY_KEYS = new Set([
  'id', 'text', 'intent', 'context', 'prompted', 'slots', 'tentative', 'change',
  'confirm', 'changeSlot', 'secondIntent', 'manipulation', 'answers', 'tags', 'as', 'labels', 'knownGap',
]);

/** A known gap (CorpusEntry.knownGap): a reason, and at least one outcome field it pins. */
function checkKnownGap(entry: CorpusEntry, gap: unknown): void {
  const shape = `corpus ${entry.id}: knownGap must be { reason, outcome }, a one-line reason and the outcome fields the model is known to produce`;
  if (typeof gap !== 'object' || gap === null || Array.isArray(gap)) throw new Error(shape);
  const { reason, outcome, ...rest } = gap as Record<string, unknown>;
  if (Object.keys(rest).length > 0) throw new Error(`${shape}; unknown key ${Object.keys(rest)[0]}`);
  if (typeof reason !== 'string' || reason.trim() === '') throw new Error(`${shape}; the reason is missing`);
  if (typeof outcome !== 'object' || outcome === null || Array.isArray(outcome) || Object.keys(outcome).length === 0) throw new Error(`${shape}; the outcome pins no field`);
  for (const key of Object.keys(outcome)) {
    if (!PINNABLE.has(key)) throw new Error(`corpus ${entry.id}: knownGap.outcome pins ${key}, which is not an outcome field (${[...PINNABLE].join(', ')})`);
  }
}

/**
 * An entry's question labels (CorpusEntry.labels): each names a question that is not the engine's
 * (the engine's are the entry's own fields, or an `answers` override), with a label or a yes or no.
 */
function checkLabels(entry: CorpusEntry, labels: unknown): void {
  if (typeof labels !== 'object' || labels === null || Array.isArray(labels)) throw new Error(`corpus ${entry.id}: labels must be an object of question labels`);
  for (const [id, label] of Object.entries(labels)) {
    if (ENGINE_QUESTION_IDS.includes(id)) throw new Error(`corpus ${entry.id}: labels names the engine's question ${id}; use the entry's own field or an answers override`);
    if (typeof label === 'boolean') continue;
    if (typeof label !== 'string' || label === '') throw new Error(`corpus ${entry.id}: label for ${id} must be a question's label or true or false`);
  }
}

function isContext(context: string, app: App): context is CorpusContext {
  return context === 'no_form' || context === 'anything_else' || contextForm(context as CorpusContext, app) !== null;
}

/**
 * The slots a label names: each one of the app's, and in a form one the entry's context listens
 * for; then each label against what its questions can offer, which is the app's to say
 * (App.testing.checkCorpusSlots).
 */
function checkSlots(app: App, entry: CorpusEntry, slots: CorpusSlotLabels): void {
  for (const key of Object.keys(slots)) if (!Object.hasOwn(app.slots, key)) throw new Error(`corpus ${entry.id}: unknown slot ${key}`);
  // In a form, the slots a turn can fill are that form's own, plus the identity factors while a
  // step-up is asking for them, and the new form's on a switch. Outside a form every slot listens
  // but one that listens only in its form (SlotSpec.listen `form`; fia.ts activeSlots).
  const form = contextForm(entry.context, app);
  if (form !== null) {
    const allowed = new Set<string>(app.forms[form]!.slots);
    if (promptsIdentity(entry, app)) for (const id of identityOf(app).factorSlots) allowed.add(id);
    // A switch to another form fills that form's slots from the same breath (turn.ts enterForm). An
    // added request's details are labelled as said too ("oh and is the ambulance covered too"),
    // though today they are not filled: the queued form asks for them when it starts.
    if (entry.change !== undefined && isForm(app, entry.intent)) for (const id of app.forms[entry.intent]!.slots) allowed.add(id);
    for (const key of Object.keys(slots)) {
      if (!allowed.has(key)) throw new Error(`corpus ${entry.id}: slot ${key} is not on form ${form}`);
    }
  }
  app.testing?.checkCorpusSlots?.(entry.id, entry.text, slots);
}

/** Reads a corpus against `app` (default: the default app), checking every label it carries. */
export function parseCorpus(jsonl: string, app: App = corpusApp()): CorpusEntry[] {
  const seen = new Set<string>();
  const seenText = new Map<string, string>();
  const out: CorpusEntry[] = [];
  for (const [i, line] of jsonl.split('\n').entries()) {
    if (!line.trim()) continue;
    let entry: CorpusEntry;
    try {
      entry = JSON.parse(line) as CorpusEntry;
    } catch (e) {
      throw new Error(`corpus line ${i + 1}: invalid JSON`, { cause: e });
    }
    for (const key of Object.keys(entry)) {
      if (!ENTRY_KEYS.has(key)) throw new Error(`corpus ${entry.id}: unknown field ${key}`);
    }
    if (!entry.id || !entry.text) throw new Error(`corpus line ${i + 1}: id and text are required`);
    if (!Object.hasOwn(app.intents, entry.intent)) throw new Error(`corpus ${entry.id}: unknown intent ${entry.intent}`);
    if (!isContext(entry.context, app)) throw new Error(`corpus ${entry.id}: unknown context ${entry.context}`);
    const cf = confirmForm(entry.context, app);
    const offering = offerTransfer(entry.context);
    const form = contextForm(entry.context, app);
    // prompted names a slot on a form already in progress (for the offer, the question the caller
    // was on when it was made), or an identity factor a step-up is asking for in any form; a
    // summary has no "prompted slot" of its own.
    if (entry.prompted !== undefined) {
      if (cf !== null || form === null) throw new Error(`corpus ${entry.id}: prompted needs a form context, not ${entry.context}`);
      const identity = promptsIdentity(entry, app);
      if (identity && offering) throw new Error(`corpus ${entry.id}: prompted ${entry.prompted} needs a form context, not ${entry.context}`);
      if (!identity && !app.forms[form]!.slots.includes(entry.prompted)) {
        throw new Error(`corpus ${entry.id}: prompted slot ${entry.prompted} is not on form ${form}`);
      }
    }
    if (entry.tentative !== undefined && typeof entry.tentative !== 'boolean') {
      throw new Error(`corpus ${entry.id}: tentative must be a boolean`);
    }
    if (entry.manipulation !== undefined && typeof entry.manipulation !== 'boolean') {
      throw new Error(`corpus ${entry.id}: manipulation must be a boolean`);
    }
    if (entry.knownGap !== undefined) checkKnownGap(entry, entry.knownGap);
    if (entry.change !== undefined) {
      if (entry.change !== 'adding' && entry.change !== 'replacing') throw new Error(`corpus ${entry.id}: change must be adding or replacing`);
      if (form === null) throw new Error(`corpus ${entry.id}: change needs a form context`);
      if (entry.intent === 'none') throw new Error(`corpus ${entry.id}: change needs an intent to add or switch to`);
    }
    if (entry.confirm !== undefined) {
      if (!['yes', 'no', 'unanswered'].includes(entry.confirm)) throw new Error(`corpus ${entry.id}: confirm must be yes, no, or unanswered`);
      if (cf === null && !offering) throw new Error(`corpus ${entry.id}: confirm needs a confirm_ or offer_transfer context`);
    }
    if (entry.changeSlot !== undefined) {
      if (cf === null) throw new Error(`corpus ${entry.id}: changeSlot needs a confirm_ context`);
      if (entry.confirm === 'yes') throw new Error(`corpus ${entry.id}: changeSlot needs confirm no or unanswered`);
      if (!app.forms[cf]!.slots.includes(entry.changeSlot)) throw new Error(`corpus ${entry.id}: changeSlot ${entry.changeSlot} is not on form ${cf}`);
    }
    if (entry.secondIntent !== undefined) {
      if (form !== null) throw new Error(`corpus ${entry.id}: secondIntent needs no_form or anything_else`);
      if (!isForm(app, entry.secondIntent)) throw new Error(`corpus ${entry.id}: unknown secondIntent ${entry.secondIntent}`);
      if (entry.secondIntent === entry.intent) throw new Error(`corpus ${entry.id}: secondIntent must differ from intent`);
    }
    if (entry.as !== undefined) {
      if ((app.principals?.delegatePrincipal?.(entry.as) ?? null) === null) throw new Error(`corpus ${entry.id}: as "${entry.as}" is not a ${identityOf(app).delegateKind ?? 'delegate'}`);
      if (entry.context !== 'no_form') throw new Error(`corpus ${entry.id}: as needs the no_form context`);
    }
    if (entry.slots !== undefined) checkSlots(app, entry, entry.slots);
    if (entry.labels !== undefined) checkLabels(entry, entry.labels);
    if (seen.has(entry.id)) throw new Error(`corpus ${entry.id}: duplicate id`);
    seen.add(entry.id);
    const normalized = normalizeText(entry.text);
    const otherId = seenText.get(normalized);
    if (otherId) throw new Error(`corpus ${entry.id}: text duplicates ${otherId} after normalization`);
    seenText.set(normalized, entry.id);
    out.push(entry);
  }
  return out;
}

export function loadCorpus(path: string, app?: App): CorpusEntry[] {
  return parseCorpus(readFileSync(path, 'utf8'), app);
}
