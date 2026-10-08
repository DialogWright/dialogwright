import { isAnonymous } from '../gate/types';
import type { AnswerMap } from '../jev/types';
import type { SlotCandidate, SlotContext, SlotOutcome, SlotPartial, SlotSpec } from './slots/types';
import { formOf, identityOf, listenOf, slotSpecOf } from './app/lookup';
import { appOf } from './app/registry';
import type { SlotId } from './app/types';
import { missingSlots, requiredSlots, type PendingConfirmation, type Session } from './session';
import type { Thresholds } from './thresholds';

export type RetryStep = 'open' | 'dtmf' | 'agent';

/** attempts = failures so far including the one just counted. */
export function retryStep(attempts: number, t: Thresholds): RetryStep {
  if (attempts >= t.MAX_ATTEMPTS) return 'agent';
  if (attempts >= t.MAX_ATTEMPTS - 1) return 'dtmf';
  return 'open';
}

export interface Ack {
  promptId: string;
  vars: Record<string, string>;
}

export interface FillEvent {
  slot: SlotId;
  outcome: SlotOutcome;
}

export interface FillResult {
  session: Session;
  events: FillEvent[];
  acks: Ack[];
  disambiguate: { slot: SlotId; a: SlotCandidate; b: SlotCandidate } | null;
  /** true if any slot was filled with a value it did not hold, narrowed to a new window, or needs disambiguation, or asked for help */
  progress: boolean;
  /** A help prompt to play in place of the question, for the slot the caller was just asked. */
  help: { slot: SlotId; promptId: string } | null;
}

export interface FillOptions {
  /**
   * A correction to a form the caller has already been read back:
   * a window over an already-filled slot reopens it for narrowing, the way a new value replaces it.
   * Mid-form a window never overwrites a filled slot, so that a value mentioned again in passing
   * ("next week" alongside an answer already given) cannot unfill it.
   */
  correcting?: boolean;
}

/**
 * The slots this turn listens for, and so asks the model about and fills.
 * - An anonymous caller: the identity factors as well as the form's slots (or every slot outside a
 *   form). Every form's entry call needs identity, so a account ID said on the opener, or with an
 *   answer, still lands; the step-up then asks only for what is still missing.
 * - A verified caller: the form's slots. Outside a form, every slot but the identity factors, which
 *   verification has closed.
 * - An anonymous web chat: as a verified caller, never the identity factors. A web chat customer
 *   proves who they are by the portal sign-in, so nothing typed is taken as a factor: no question
 *   asks the model for an account ID or birth date, and no slot keeps one.
 * parcelSelect stays on outside a form: its question is asked only when a parcel number is said or the
 * parcels are known, and "my mother's parcel, it's 7101" on the opener has to reach the gate as said.
 * Outside a form, a slot that listens only in its form (SlotSpec.listen `form`) is not asked: its
 * question is not sent until a form that has it is open.
 */
export function activeSlots(session: Session): SlotSpec[] {
  // At the code prompt nothing is asked of or filled from what the caller says: a spoken turn
  // there may be the code read aloud, and no slot may keep any part of it.
  if (session.promptedFor === 'otp') return [];
  const app = appOf(session);
  const factorSlots = identityOf(app).factorSlots;
  const collectsIdentity = isAnonymous(session.principal) && !session.caps.signIn;
  if (session.form) {
    const form = formOf(app, session.form).slots.map((id) => slotSpecOf(app, id));
    return collectsIdentity ? [...factorSlots.map((id) => slotSpecOf(app, id)), ...form.filter((spec) => !factorSlots.includes(spec.id))] : form;
  }
  return Object.values(app.slots).filter((spec) => (factorSlots.includes(spec.id) ? collectsIdentity : listenOf(app, spec.id) !== 'form'));
}

/**
 * The slots a turn fills from what it heard: those it listens for (activeSlots), but outside a form
 * only those a value said there is kept for: the identity factors (where the turn listens for them),
 * the slots the app carries from one form to the next (App.carrySlots, or SlotSpec.listen `call`),
 * and the slots that keep a value said anywhere (SlotSpec.listen `anywhere`).
 *
 * Outside a form the model is asked about every slot but those that listen only in their form, so
 * that the form a turn routes to hears what was said for it: enterForm opens the form and then fills
 * it, from this list as it stands inside the form (the default, SlotSpec.listen `up-front`). A turn
 * that opens no form (an informational answer, a declined transfer) would otherwise keep values said
 * for no form at all: the topic of the question just answered, a day in it ("are you open on
 * Saturday"). Left filled, a form asked for later would skip its question and read that value back
 * as the caller's answer. A form starts from what is said once it is asked for, unless the slot
 * says it keeps a value said anywhere.
 */
export function slotsToFill(session: Session): SlotSpec[] {
  const listening = activeSlots(session);
  if (session.form) return listening;
  const app = appOf(session);
  const callSlots = new Set<SlotId>([...identityOf(app).factorSlots, ...(app.carrySlots ?? [])]);
  return listening.filter((spec) => {
    if (callSlots.has(spec.id)) return true;
    const listen = listenOf(app, spec.id);
    return listen === 'anywhere' || listen === 'call';
  });
}

/**
 * The context handed to one spec's `questions`/`fill`: that spec's own slot's pending partial
 * substituted in, never another slot's, and whether the last prompt asked for this slot. A
 * pending partial says what year is still owed on the next turn; `prompted` lets a slot call a
 * miss on its own question invalid rather than absent. `current` is the slot's own value already
 * on file, so a slot can refuse to let a later unprompted turn overwrite it; a correcting fill
 * (opts.correcting) hides it as null so the same slot can still replace what is there.
 */
export function slotCtx(session: Session, ctx: SlotContext, id: SlotId, opts: FillOptions = {}): SlotContext {
  const slot = session.slots[id]!;
  return { ...ctx, window: slot.window, prompted: session.promptedFor === id, current: opts.correcting === true ? null : slot.value };
}

/**
 * A pending narrowing as one comparable value, part by part rather than by object identity or
 * key order: `dob:day=5,month=3` for a date's month/day partial.
 */
function windowKey(w: SlotPartial | null): string {
  if (w === null) return 'none';
  const parts = Object.keys(w).filter((k) => k !== 'kind').sort().map((k) => `${k}=${String(w[k])}`);
  return `${w.kind}:${parts.join(',')}`;
}

const ISO_DAY = /^\d{4}-(\d{1,2})-(\d{1,2})$/;

/**
 * The one calendar day a date-valued slot's outcome asserts (SlotSpec.valueKind 'date': its value
 * is a calendar day, an ISO date, and so it can hear the same day twice), as `month-day`, or null when it
 * asserts none. A rejected value still says which day was heard (`invalid.raw` for a birthday in
 * the future), and a partial names its `month` and `day` with the rest still owed (a dob's year).
 */
function monthDayOf(spec: SlotSpec, outcome: SlotOutcome): string | null {
  if (spec.valueKind !== 'date') return null;
  const iso = outcome.kind === 'filled' ? outcome.value : outcome.kind === 'invalid' ? outcome.raw : null;
  if (iso !== null) {
    const m = ISO_DAY.exec(iso);
    return m ? `${Number(m[1])}-${Number(m[2])}` : null;
  }
  if (outcome.kind === 'window') {
    const { month, day } = outcome.window;
    return typeof month === 'number' && typeof day === 'number' ? `${month}-${day}` : null;
  }
  return null;
}

/**
 * One calendar day heard twice. Every slot reads every turn, so a day spoken in answer to one
 * slot's question is offered to the others as well: "March fifth" at ask_dob is a birthday, and
 * the due date the expectedDate slot builds out of it (the last March 5th) is an artifact of
 * asking two questions of one sentence, not something the caller said. The slot that was asked
 * owns the day; the other date-valued slot, if it resolves the same month and day on that turn,
 * is dropped, fill and window alike. A different day in the same breath ("March fifth, and I fell
 * last Saturday") is a real over-answer and stands, and a turn that prompted no slot -- the intent
 * question, a summary -- has no owner to decide with, so nothing is dropped.
 */
function sameDayAsPrompted(session: Session, results: { spec: SlotSpec; outcome: SlotOutcome }[]): Set<SlotId> {
  const dropped = new Set<SlotId>();
  const asked = session.promptedFor;
  if (asked === null || asked === 'intent' || asked === 'confirm' || asked === 'otp') return dropped;
  const own = results.find((r) => r.spec.id === asked);
  const key = own ? monthDayOf(own.spec, own.outcome) : null;
  if (key === null) return dropped;
  for (const r of results) {
    if (r.spec.id === asked) continue;
    if ((r.outcome.kind === 'filled' || r.outcome.kind === 'window') && monthDayOf(r.spec, r.outcome) === key) dropped.add(r.spec.id);
  }
  return dropped;
}

/**
 * What each spec's fill reads from the turn, before any of it is applied: absent outcomes and the
 * slots the same-day rule drops are left out. It changes nothing, so it can be read ahead of the
 * fill itself (valuesGiven).
 */
function readSlots(session: Session, answers: AnswerMap, ctx: SlotContext, specs: SlotSpec[], opts: FillOptions): { spec: SlotSpec; outcome: SlotOutcome }[] {
  // Read every spec before applying any of it: the same-day rule compares the slots against each
  // other. Each spec sees only its own slot's pending partial, which no other spec's fill touches,
  // so reading them all up front says exactly what reading them one at a time did.
  const results = specs.map((spec) => ({ spec, outcome: spec.fill(answers, slotCtx(session, ctx, spec.id, opts)) }));
  const dropped = sameDayAsPrompted(session, results);
  return results.filter(({ spec, outcome }) => outcome.kind !== 'absent' && !dropped.has(spec.id));
}

/**
 * Whether an outcome gives its slot something it does not already hold: a value other than the
 * one on file (or one that settles a pending window), a window other than the one pending (where a
 * window may land: an empty slot, or a correction), or two candidates to choose between. Exactly
 * what fillSlots counts as progress for a slot, help aside, which is no value.
 */
function givesNew(session: Session, id: SlotId, outcome: SlotOutcome, opts: FillOptions): boolean {
  const slot = session.slots[id]!;
  switch (outcome.kind) {
    case 'filled':
      return !(slot.value === outcome.value && slot.window === null);
    case 'window':
      return (slot.value === null || opts.correcting === true) && windowKey(slot.window) !== windowKey(outcome.window);
    case 'disambiguate':
      return true;
    default:
      return false;
  }
}

/**
 * The slots among `specs` this turn's words give something new (givesNew), read without filling
 * anything. The gates read it at a form's summary, where a detail named as wrong in the same breath
 * as a new value is not a detail named alone (App.changeSlotWithValue).
 */
export function valuesGiven(session: Session, answers: AnswerMap, ctx: SlotContext, specs: SlotSpec[], opts: FillOptions = {}): Set<SlotId> {
  const given = new Set<SlotId>();
  for (const { spec, outcome } of readSlots(session, answers, ctx, specs, opts)) {
    if (outcome.kind === 'help') continue;
    if (givesNew(session, spec.id, outcome, opts)) given.add(spec.id);
  }
  return given;
}

export function fillSlots(session: Session, answers: AnswerMap, ctx: SlotContext, specs: SlotSpec[], opts: FillOptions = {}): FillResult {
  const events: FillEvent[] = [];
  const acks: Ack[] = [];
  let disambiguate: FillResult['disambiguate'] = null;
  let progress = false;
  let help: FillResult['help'] = null;

  for (const { spec, outcome } of readSlots(session, answers, ctx, specs, opts)) {
    const slot = session.slots[spec.id]!;
    if (outcome.kind === 'help') {
      // Honoured only for the slot the caller was asked for, and once per prompt since the slot
      // was last emptied (`helped` is part of what `emptySlot` clears, so a queued second form
      // asks again). Anywhere else it is exactly a miss: no event, no progress -- the same as an
      // absent outcome. `slot.helped` is checked, not written, here: a decision this turn takes
      // is not yet a prompt spoken, so `bookkeep` (turn.ts) is what records it, once the decision
      // that plays it survives `escalate` and `continueForm`'s own precedence over disambiguation.
      if (session.promptedFor !== spec.id || slot.helped.includes(outcome.promptId)) continue;
      events.push({ slot: spec.id, outcome });
      help = { slot: spec.id, promptId: outcome.promptId };
      progress = true;
      continue;
    }
    events.push({ slot: spec.id, outcome });
    // Read before the slot is written: what counts as new is judged against what it held.
    const isNew = givesNew(session, spec.id, outcome, opts);
    switch (outcome.kind) {
      case 'filled': {
        // The slot's own policy, not the fill outcome, decides whether a spoken value is
        // read back: an always-confirm slot lands unconfirmed and silent, and the caller
        // hears it in a confirm_<slot> prompt. A summary-policy slot also lands unconfirmed
        // and silent, but its readback is the form's final confirm rather than a confirm_<slot>
        // prompt of its own. A value already confirmed and spoken again unchanged stays
        // confirmed, so repeating it does not re-open the readback.
        // Only a value the slot did not already hold is progress, as with a window below and a
        // correction at the summary (correctingFill, turn.ts): a value spoken again unchanged (one
        // the form holds, heard again in answer to another slot's question) answers nothing, and
        // counting it would hold the prompted slot's `attempts` and re-ask its question forever.
        const policy = spec.spokenConfirm;
        const keepConfirmed = slot.confirmed && slot.value === outcome.value;
        slot.value = outcome.value;
        slot.display = outcome.display;
        slot.confirmed = keepConfirmed || (policy === 'by-confidence' && outcome.confirm === 'none');
        slot.window = null;
        // A slot the caller declined (SlotState.declined) that they now give a value is filled, no longer declined.
        delete slot.declined;
        if (policy === 'by-confidence' && outcome.confirm === 'implicit') acks.push({ promptId: `ack_${spec.id}`, vars: { [spec.id]: outcome.display } });
        if (isNew) progress = true;
        break;
      }
      case 'window': {
        if (slot.value === null || opts.correcting === true) {
          // Only a window that differs from the one already pending is progress: a partial that
          // gained a component, or a different partial altogether. Re-speaking the partial the
          // caller was just asked to complete ("march fifth" again at ask_dob_year) answers nothing, and counting it as progress would hold
          // `attempts` at zero and re-ask the same question forever. turn.ts' `case 'proceed'`
          // turns a turn without progress into failAttempt, so the ladder walks to the keypad
          // rung and then to an agent -- the same reading correctingFill/summaryState give an
          // unchanged fill on the summary's own ladder.
          slot.value = null;
          slot.display = null;
          slot.confirmed = false;
          slot.window = outcome.window;
          if (isNew) progress = true;
        }
        break;
      }
      case 'disambiguate':
        if (!disambiguate) disambiguate = { slot: spec.id, a: outcome.a, b: outcome.b };
        progress = true;
        break;
      case 'invalid':
        break;
    }
  }
  return { session, events, acks, disambiguate, progress, help };
}

export type NextPrompt =
  | { kind: 'ask'; slot: SlotId; window: SlotPartial | null }
  | { kind: 'complete' };

export function nextPrompt(session: Session): NextPrompt {
  const [slot] = missingSlots(session);
  if (!slot) return { kind: 'complete' };
  return { kind: 'ask', slot, window: session.slots[slot]!.window };
}

/** The readback owed for the first filled, unconfirmed always-confirm slot, or null. */
export function pendingSlotConfirmation(session: Session): Extract<PendingConfirmation, { target: 'slot' }> | null {
  const app = appOf(session);
  for (const id of requiredSlots(session)) {
    const s = session.slots[id]!;
    if (s.value !== null && !s.confirmed && slotSpecOf(app, id).spokenConfirm === 'always') {
      return { target: 'slot', slot: id, value: s.value, display: s.display ?? s.value };
    }
  }
  return null;
}

export type DtmfResult =
  | { kind: 'collecting' }
  | { kind: 'filled'; slot: SlotId; display: string }
  | { kind: 'invalid'; slot: SlotId }
  | { kind: 'no_target' };

/**
 * Apply a DTMF digit buffer to the slot that was last prompted: one the turn is listening for, which
 * includes the identity factors a step-up asks for. The keypad code is never a slot and never gets here.
 */
export function applyDtmf(session: Session, buffer: string, ctx: SlotContext): DtmfResult {
  const target = session.promptedFor;
  if (target === null || target === 'intent' || target === 'confirm' || target === 'otp') return { kind: 'no_target' };
  if (!activeSlots(session).some((spec) => spec.id === target)) return { kind: 'no_target' };
  const spec = slotSpecOf(appOf(session), target);
  if (!spec.dtmf) return { kind: 'no_target' };
  if (buffer.length < spec.dtmf.length) return { kind: 'collecting' };
  const parsed = spec.dtmf.parse(buffer.slice(0, spec.dtmf.length), ctx);
  if (!parsed) return { kind: 'invalid', slot: target };
  const slot = session.slots[target]!;
  slot.value = parsed.value;
  slot.display = parsed.display;
  slot.confirmed = true;
  slot.window = null;
  delete slot.declined;
  return { kind: 'filled', slot: target, display: parsed.display };
}
