import { isChoice, isScore, noulValue, rankProbabilities, type AnswerMap } from '../jev/types';
import { informationOf, isFormIntent, isTaskIntent, type Informs } from './app/intents';
import { changeSlotWithValueOf, formOf, frustrationElsewhereOf, frustrationHeardIn, frustrationMildOf, priorityIntentsOf, priorityThresholdOf, questionAtSummaryOf, unsureOf } from './app/lookup';
import { appOf } from './app/registry';
import type { App, FormId, Intent, SlotId } from './app/types';
import type { Session } from './session';
import type { TurnState } from './state';
import { atLeast, type Thresholds } from './thresholds';
import { dictationOf } from './fia';

export interface GateRow {
  gate: string;
  value: number | null;
  threshold: number | null;
  passed: boolean;
  outcome: string;
  decided: boolean;
}

/**
 * The rung the frustration gate reached: `ack` for the first frustrated turn,
 * `offer` for the second. A handoff is a verdict of its own, and a turn that is not frustrated --
 * or one that is answering the offer -- carries nothing. `ack_only` is no rung of the ladder: a turn
 * read as high frustration where the ladder does not run (App.frustration.elsewhere `acknowledge`)
 * hears the acknowledgement as `ack` does, and is never counted toward the offer of a person.
 *
 * Only the verdicts that let the call go on carry it: the turn prepends the acknowledgment to the
 * prompt it was going to play, or replaces that prompt with the offer, and neither makes sense for
 * a turn that says nothing (`ignore`, `hold`), one that is already leaving (`handoff`), or a replay
 * of the last prompt.
 */
export type FrustrationRung = 'ack' | 'offer' | 'ack_only';
interface Frustrated {
  frustration?: FrustrationRung;
}

export type Verdict =
  | { kind: 'ignore' }
  | { kind: 'hold' }
  | ({ kind: 'nomatch' } & Frustrated)
  | { kind: 'handoff'; reason: string }
  | ({ kind: 'confirmed'; queue?: FormId } & Frustrated)
  | ({ kind: 'rejected'; queue?: FormId } & Frustrated)
  | ({ kind: 'confirm_unanswered'; queue?: FormId } & Frustrated)
  | ({ kind: 'change_slot'; slot: SlotId; queue?: FormId } & Frustrated)
  /** The prompt said again (repeat_prompt); `wait`: the caller asked for a moment (the `wait` intent), and is given it. */
  | { kind: 'replay'; wait?: true }
  /** An informational intent: its prompt (`promptId`) or its knowledge-base passage (`passage`) is said, and the call resumes. */
  | ({ kind: 'inform' } & Informs & Frustrated)
  /**
   * A form to enter, or 'done': the caller is finished and the call ends with the goodbye. Or an
   * informational intent the model is unsure of, always with `confirm: 'explicit'`: the caller is
   * asked whether they want it, and its answer is said on a yes (turn.ts, the confirmed intent).
   * `aside`: a form that is an aside to the form in hand (FormDef.aside), asked for while it is open,
   * as a replacing or an added request: the form in hand is set aside and resumed after it (turn.ts).
   */
  | ({ kind: 'route'; intent: FormId | 'done' | Intent; confirm: 'none' | 'implicit' | 'explicit'; queue?: FormId; aside?: true } & Frustrated)
  | ({ kind: 'queue'; intent: FormId } & Frustrated)
  | ({ kind: 'disambiguate_intent'; a: Intent; b: Intent } & Frustrated)
  | ({ kind: 'intent_failed' } & Frustrated)
  /**
   * The turn goes to the form's slots. `dictated`: the turn is that slot's words, whole (SlotSpec.dictation,
   * fia.ts dictationOf): the gates acted on nothing in it, and the slot takes the words (core/turn.ts).
   */
  | ({ kind: 'proceed'; dictated?: SlotId } & Frustrated);

/** The rung a verdict carries, if it is one of the kinds that can carry one. */
export function frustrationOf(verdict: Verdict): FrustrationRung | undefined {
  return 'frustration' in verdict ? verdict.frustration : undefined;
}

/** Stamp the rung onto the verdict the gates settled on, where that verdict can carry it. */
function withFrustration(verdict: Verdict, rung: FrustrationRung | null): Verdict {
  if (rung === null) return verdict;
  switch (verdict.kind) {
    case 'ignore':
    case 'hold':
    case 'handoff':
    case 'replay':
      return verdict;
    default:
      return { ...verdict, frustration: rung };
  }
}

/** An intent the opening question routes on: a form, or "that's all" (outside a form only) where the app has it. */
function isRoutable(app: App, intent: string): boolean {
  return isFormIntent(app, intent) || (intent === 'done' && Object.hasOwn(app.intents, 'done'));
}

/**
 * The task in hand as the intents name it: the open form, and the forms it was reached through by
 * `next` on this call (Session.reachedThrough: the screen the caller came through, not every form
 * that could lead there), which are the same request. Exactly the open form for a form entered any
 * other way, so for every app without `next`.
 */
function sameTask(session: Session, form: FormId): FormId[] {
  return [form, ...(session.reachedThrough ?? [])];
}

/**
 * The raw probability an added form needs before its share is read at all. The share divides by
 * what `active` leaves, so as `active` nears 1 a sliver of leftover would otherwise pass (0.03
 * beside 0.95 is a 0.6 share): the added task must also stand on its own.
 */
export const ADDED_INTENT_FLOOR = 0.3;

/**
 * The task an in-form "adding" utterance adds: the likeliest form other than `active`, with its
 * probability as a share of everything but `active` (the model's reading that the words go on with
 * the current task is no evidence against the task added beside it). `active` is the form in hand
 * and the forms it was reached through by next (sameTask): the screen the caller came through is the
 * booking's own request, so naming it again adds nothing. Null when no other form is
 * ranked, when `active` takes all of it, or when the added form's own probability is under
 * `ADDED_INTENT_FLOOR`.
 */
function addedIntent(app: App, ranked: readonly { label: string; p: number }[], active: readonly FormId[]): { label: FormId; p: number } | null {
  const pActive = ranked.filter((r) => active.includes(r.label)).reduce((sum, r) => sum + r.p, 0);
  const best = ranked.find((r) => !active.includes(r.label) && isFormIntent(app, r.label));
  if (!best || pActive >= 1 || best.p < ADDED_INTENT_FLOOR) return null;
  return { label: best.label as FormId, p: best.p / (1 - pActive) };
}

export interface GateResult {
  rows: GateRow[];
  verdict: Verdict;
  /**
   * The frustration question read this turn as high (GATE_FRUSTRATION_HIGH, its high alone), not at a
   * dictation: the turn keeps it on the session (Session.frustrationHigh) when the turn was meant for us.
   */
  readHigh: boolean;
}

const NO_SLOTS: ReadonlySet<SlotId> = new Set();

/**
 * The detail of `form` the turn names as the one to change (changeSlot's top label, a slot of the form,
 * at SLOT_CHANGE or more), or null: what the summary's resolution reads, and what a yes to the summary
 * reads to tell an acceptance from a yes that names a detail (turn.ts, the confirmed summary).
 */
export function changeSlotNamed(app: App, answers: AnswerMap, form: FormId, t: Thresholds): SlotId | null {
  const [changeTop] = isChoice(answers.changeSlot) ? rankProbabilities(answers.changeSlot.probabilities) : [];
  return changeTop && changeTop.label !== 'none' && atLeast(changeTop.p, t.SLOT_CHANGE) && formOf(app, form).slots.includes(changeTop.label as SlotId) ? (changeTop.label as SlotId) : null;
}

/**
 * `given` is read only at a form's summary: the slots of that form this turn's words give a value
 * they do not already hold (fia.ts valuesGiven, read by turn.ts before anything is filled). Empty
 * where the caller says no new value, and wherever there is no summary pending.
 */
export function evaluateGates(session: Session, ts: TurnState, answers: AnswerMap, t: Thresholds, given: ReadonlySet<SlotId> = NO_SLOTS): GateResult {
  const app = appOf(session);
  const rows: GateRow[] = [];
  let verdict: Verdict | null = null;

  const decide = (row: GateRow, v: Verdict): void => {
    if (verdict === null) {
      verdict = v;
      row.decided = true;
    }
    rows.push(row);
  };
  /**
   * The verdict an earlier gate has already settled on, if any. Read through a function so that
   * TypeScript uses `verdict`'s declared type: it is only ever assigned inside these closures, so
   * straight-line narrowing would have it as `null` everywhere below.
   */
  const settled = (): Verdict | null => verdict;
  /** Take the verdict away from the gate that settled it: this row decided the turn instead. */
  const resettle = (row: GateRow, v: Verdict): void => {
    for (const r of rows) r.decided = false;
    verdict = v;
    row.decided = true;
    rows.push(row);
  };
  const info = (gate: string, value: number | null, outcome = 'info'): void => {
    rows.push({ gate, value, threshold: null, passed: true, outcome, decided: false });
  };

  // 0. A dictation (SlotSpec.dictation, fia.ts dictationOf; live findings item 29): the turn answers the
  // question of a slot that takes it whole, so it is the slot's words, and no request in it is acted on
  // but the intents the slot lists (`heeds`). Only what leaves no words to take still decides: words not
  // made out (2) and a partial held for the rest (3); the injection screen ran before the gates. An aside
  // (1) is taken as words: a message is words meant for someone else, which is what the aside question
  // looks for, and the read-back lets the caller say no. A gate that would have acted reports `dictation`.
  const dictation = dictationOf(session, ts.asr.text);
  const heeds = (intent: string): boolean => dictation === null || dictation.listen.has(intent);

  // 1. addressed to system. Side speech is a spoken call's (someone in the room, a television): words
  // typed into a chat are always meant for it, so on a channel without speech the reading is recorded
  // (`typed`) and never ignores the turn, which would leave the person with no reply at all.
  {
    const v = noulValue(answers, 'addressedToSystem');
    const typed = !session.caps.speech;
    const passed = typed || atLeast(v, t.GATE_ADDRESSED);
    const row = { gate: 'addressedToSystem', value: v, threshold: t.GATE_ADDRESSED, passed, outcome: atLeast(v, t.GATE_ADDRESSED) ? 'pass' : typed ? 'typed' : dictation !== null ? 'dictation' : 'ignore', decided: false };
    passed || dictation !== null ? rows.push(row) : decide(row, { kind: 'ignore' });
  }

  // 2. intelligible
  {
    const v = noulValue(answers, 'intelligible');
    const passed = atLeast(v, t.GATE_INTELLIGIBLE);
    const row = { gate: 'intelligible', value: v, threshold: t.GATE_INTELLIGIBLE, passed, outcome: passed ? 'pass' : 'nomatch', decided: false };
    passed ? rows.push(row) : decide(row, { kind: 'nomatch' });
  }

  // 3. utterance complete
  {
    const v = noulValue(answers, 'utteranceComplete');
    const passed = atLeast(v, t.GATE_COMPLETE);
    if (passed) rows.push({ gate: 'utteranceComplete', value: v, threshold: t.GATE_COMPLETE, passed, outcome: 'pass', decided: false });
    else if (!ts.asr.isFinal) decide({ gate: 'utteranceComplete', value: v, threshold: t.GATE_COMPLETE, passed, outcome: 'hold', decided: false }, { kind: 'hold' });
    else rows.push({ gate: 'utteranceComplete', value: v, threshold: t.GATE_COMPLETE, passed, outcome: 'noted', decided: false });
  }

  // 4. wants human. At the transfer offer this gate sees the yes before the confirmation gate
  // does -- "yes, connect me" is an explicit request for a person -- so the reason has to say
  // which transfer it is: the caller is accepting the one we offered a frustrated caller, not
  // asking out of the blue, and `frustrated` is what plays the line the offer promised. An offer
  // made because there was no answer to give (`why: 'no-answer'`) was not for a frustrated caller:
  // accepting it is a request for a person, `live-agent`, as the confirmation gate's yes is.
  {
    const v = noulValue(answers, 'wantsHuman');
    const passed = !atLeast(v, t.GATE_WANTS_HUMAN);
    const pc = session.pendingConfirmation;
    const forNoAnswer = pc?.target === 'transfer' && pc.why === 'no-answer';
    const reason = pc?.target === 'transfer' && !forNoAnswer ? 'frustrated' : 'live-agent';
    // At a dictation a request for a person is acted on only where the slot lists `agent`.
    const heard = heeds('agent');
    const row = { gate: 'wantsHuman', value: v, threshold: t.GATE_WANTS_HUMAN, passed, outcome: passed ? 'pass' : heard ? 'handoff' : 'dictation', decided: false };
    passed || !heard ? rows.push(row) : decide(row, { kind: 'handoff', reason });
  }

  // 5. frustration escalation (before intent; see Deviation note). The gate reads the rung off the
  // count the session carries; only the handoff is a verdict of its own, and the turn does the
  // bookkeeping. A repeated attempt no longer matters.
  let frustrationRung: FrustrationRung | null = null;
  let shownHigh = false;
  {
    const f = answers.frustration;
    const readHigh = isScore(f) ? (f.probabilities.high ?? 0) : 0;
    // Once the call has shown high frustration (Session.frustrationHigh), a turn read as mild or more
    // counts as a high one does (App.frustration.mild, default `after-high`, the maintainer's decision,
    // 2026-10-17): its mild and high together at the same bar. A caller never read as high is unchanged:
    // a terse caller often reads mild. The row's value is what was held to the bar.
    const mildCounts = session.frustrationHigh === true && frustrationMildOf(app) === 'after-high';
    const high = mildCounts && isScore(f) ? readHigh + (f.probabilities.mild ?? 0) : readHigh;
    shownHigh = atLeast(readHigh, t.GATE_FRUSTRATION_HIGH) && dictation === null;
    // At a dictation the caller's tone is the words' own (an annoyed message is still a message): the
    // turn is neither counted nor answered for it, and the row says so.
    // Outside the forms the app names for it (App.frustration), the ladder does not run: the form
    // open, the one set aside for an aside; with none open the task the words ask for (the intent
    // read), "this is ridiculous, I just want to know about my claim" at the opening question; and
    // with none asked for, the call's most recent task (Session.lastTask, App.frustration.after):
    // "this is ridiculous" just after a claim's lookup was refused.
    const [top] = session.form === null && isChoice(answers.intent) ? rankProbabilities(answers.intent.probabilities) : [];
    const asked = top !== undefined && isTaskIntent(app, top.label) ? top.label : null;
    const heard = frustrationHeardIn(app, session.form, session.parked?.form ?? null, asked, session.lastTask ?? null);
    const strong = atLeast(high, t.GATE_FRUSTRATION_HIGH) && dictation === null;
    const frustrated = strong && heard;
    // The caller answering the offer is not counted again, however crossly they answer it.
    const atOffer = session.pendingConfirmation?.target === 'transfer';
    const count = frustrated && !atOffer ? session.frustratedTurns + 1 : session.frustratedTurns;
    const rung = !frustrated || atOffer ? 'pass'
      : count === 1 ? 'ack'
        : count === 2 && !session.transferDeclined ? 'offer'
          : 'handoff';
    const unheard = dictation !== null && atLeast(high, t.GATE_FRUSTRATION_HIGH);
    const unlisted = strong && !heard;
    // Where the ladder does not run, a caller this upset still hears the acknowledgement before what
    // the turn says (App.frustration.elsewhere), never counted: the offer of a person stays the listed
    // forms'. Not at the offer of a person (one made because there was no answer), which the turn answers.
    const acknowledged = unlisted && !atOffer && frustrationElsewhereOf(app) === 'acknowledge';
    const row = { gate: 'frustration', value: high, threshold: t.GATE_FRUSTRATION_HIGH, passed: rung !== 'handoff', outcome: unheard ? 'dictation' : acknowledged ? 'ack_only' : unlisted ? 'not_listed' : rung, decided: false };
    if (rung !== 'handoff') rows.push(row);
    // The third rung is a verdict of its own, and `decide` is first-wins, so a verdict an earlier
    // gate already settled has to be answered for rather than quietly swallowing the transfer.
    else if (settled()?.kind === 'ignore') {
      // Gate 1 heard side speech: the outburst was not aimed at us, so there is nothing to
      // transfer out of and the row says so. The turn is not counted either -- `withFrustration`
      // never stamps an `ignore`, so the rung comes round again when the caller is talking to us.
      rows.push({ ...row, passed: true, outcome: 'not_addressed' });
    } else if (settled()?.kind === 'nomatch') {
      // Gate 2 could not make out the words, but a caller this upset for the third time gets a
      // person anyway: the rung takes the verdict off the re-ask. The `intelligible` row keeps
      // its failure and loses only the credit for deciding the turn.
      resettle(row, { kind: 'handoff', reason: 'frustrated' });
    } else decide(row, { kind: 'handoff', reason: 'frustrated' });
    frustrationRung = rung === 'ack' || rung === 'offer' ? rung : acknowledged ? 'ack_only' : null;
  }

  // 6. pending confirmation. Intent and slot readbacks decide here. The summary (target form)
  // defers: an added intent or a correction in the same breath must not be lost to an early yes/no.
  const pending = session.pendingConfirmation;
  let confirmationUnanswered = false;
  let formConfirm: 'confirmed' | 'rejected' | null = null;
  // Kept so the summary resolution below can mark this row (rather than the intent row) as the
  // one that actually decided the verdict; `decidedGate` feeds the regress baseline and metrics.
  let confirmationRow: GateRow | null = null;
  if (pending) {
    const isForm = pending.target === 'form';
    const yes = noulValue(answers, 'confirmsYes');
    const no = noulValue(answers, 'confirmsNo');
    // The transfer offer takes anything that is not a yes as a no: the caller
    // who answers it with a parcel number, or with nothing much, is not asked it a second time.
    if (atLeast(yes, t.CONFIRM_YES) && yes >= no) {
      confirmationRow = { gate: 'confirmation', value: yes, threshold: t.CONFIRM_YES, passed: true, outcome: 'confirmed', decided: false };
      if (isForm) { formConfirm = 'confirmed'; rows.push(confirmationRow); } else decide(confirmationRow, { kind: 'confirmed' });
    } else if (atLeast(no, t.CONFIRM_NO) || pending.target === 'transfer') {
      confirmationRow = { gate: 'confirmation', value: no, threshold: t.CONFIRM_NO, passed: true, outcome: 'rejected', decided: false };
      if (isForm) { formConfirm = 'rejected'; rows.push(confirmationRow); } else decide(confirmationRow, { kind: 'rejected' });
    } else {
      confirmationRow = { gate: 'confirmation', value: Math.max(yes, no), threshold: t.CONFIRM_YES, passed: false, outcome: 'unanswered', decided: false };
      rows.push(confirmationRow);
      confirmationUnanswered = true;
    }
  }

  // 7. spoken menu number
  if (session.menuActive) {
    const m = answers.menuNumberSaid;
    const [top] = isChoice(m) ? rankProbabilities(m.probabilities) : [];
    const mapped = top && top.label !== 'none' ? app.menu.find((o) => o.digit === top.label) : undefined;
    if (top && mapped && atLeast(top.p, t.MENU_NUMBER)) {
      const row = { gate: 'menuNumber', value: top.p, threshold: t.MENU_NUMBER, passed: true, outcome: heeds(mapped.intent) ? `menu:${mapped.intent}` : 'dictation', decided: false };
      // At a dictation a number said is words too, unless its intent is one the slot lists.
      if (!heeds(mapped.intent)) rows.push(row);
      else if (mapped.intent === 'agent') decide(row, { kind: 'handoff', reason: 'live-agent' });
      else if (isFormIntent(app, mapped.intent)) decide(row, { kind: 'route', intent: mapped.intent, confirm: 'none' });
      else rows.push(row);
    } else {
      rows.push({ gate: 'menuNumber', value: top?.p ?? null, threshold: t.MENU_NUMBER, passed: false, outcome: 'no_menu_number', decided: false });
    }
  }

  // informational rows for the debug table
  info('rephrasingLastTurn', noulValue(answers, 'rephrasingLastTurn'));
  info('confusedByPrompt', noulValue(answers, 'confusedByPrompt'));
  info('spokeAMenuNumber', noulValue(answers, 'spokeAMenuNumber'));

  // 8. intent
  const intentAnswer = answers.intent;
  const ranked = isChoice(intentAnswer) ? rankProbabilities(intentAnswer.probabilities) : [];
  const top = ranked[0] ?? { label: 'none', p: 0 };
  const second = ranked[1];
  const label = top.label as Intent;
  const activeForm = session.form;
  // The form in hand, and the forms it was reached through by next: one task (sameTask).
  const inHand = activeForm === null ? [] : sameTask(session, activeForm);
  const informs = informationOf(app, label);

  let routeVerdict: Verdict | null = null;
  let outcome: string;
  // What the intent row reports: the top intent, unless an added task was read from below it.
  let intentValue = top.p;
  let intentLabel: string = label;
  const tentative = atLeast(noulValue(answers, 'intentTentative'), t.INTENT_TENTATIVE);

  if (activeForm === null) {
    if (label === 'agent' && atLeast(top.p, t.INTENT_IMPLICIT)) { routeVerdict = { kind: 'handoff', reason: 'live-agent' }; outcome = 'agent'; }
    else if (label === 'repeat_prompt' && atLeast(top.p, t.INTENT_IMPLICIT)) { routeVerdict = { kind: 'replay' }; outcome = 'replay'; }
    else if (label === 'wait' && atLeast(top.p, t.INTENT_IMPLICIT)) { routeVerdict = { kind: 'replay', wait: true }; outcome = 'wait'; }
    else if (informs !== undefined && atLeast(top.p, t.INTENT_IMPLICIT)) { routeVerdict = { kind: 'inform', ...informs }; outcome = 'inform'; }
    else if (isRoutable(app, label) && atLeast(top.p, t.INTENT_ROUTE)) { routeVerdict = { kind: 'route', intent: label, confirm: 'none' }; outcome = 'route'; }
    // Every form entry is acknowledged now, so this band no longer earns the
    // caller a different turn from a plain route -- only the dropped second task below and the
    // 'route_implicit' debug label still tell the two apart.
    else if (isRoutable(app, label) && atLeast(top.p, t.INTENT_IMPLICIT)) { routeVerdict = { kind: 'route', intent: label, confirm: 'implicit' }; outcome = 'route_implicit'; }
    // The band where the model is unsure, from INTENT_EXPLICIT up to INTENT_IMPLICIT: the app (or the
    // intent) says whether the caller is asked (App.unsureIntent, IntentDef.unsure). Told no-match,
    // the reading fails as one below the band does, with an outcome of its own for the debug table.
    else if ((isRoutable(app, label) || informs !== undefined) && atLeast(top.p, t.INTENT_EXPLICIT) && unsureOf(app, label) === 'no-match') { routeVerdict = { kind: 'intent_failed' }; outcome = 'unsure_no_match'; }
    else if (isRoutable(app, label) && atLeast(top.p, t.INTENT_EXPLICIT)) { routeVerdict = { kind: 'route', intent: label, confirm: 'explicit' }; outcome = 'route_explicit'; }
    // An informational intent gets the band a form gets: read at INTENT_IMPLICIT or more it is said
    // (above), and below that, down to INTENT_EXPLICIT, the caller is asked whether that is what they
    // want rather than told the words were not understood. A yes says it; a no is the intent question
    // again, as for a form. Only outside a form: inside one it needs INTENT_SWITCH as before, since a
    // question there would stand in for the one the form is asking.
    else if (informs !== undefined && atLeast(top.p, t.INTENT_EXPLICIT)) { routeVerdict = { kind: 'route', intent: label, confirm: 'explicit' }; outcome = 'inform_explicit'; }
    else { routeVerdict = { kind: 'intent_failed' }; outcome = 'failed'; }
    // A hedged request is confirmed however sure the model is which request it is.
    if (tentative && routeVerdict.kind === 'route' && routeVerdict.confirm !== 'explicit') {
      routeVerdict = { kind: 'route', intent: routeVerdict.intent, confirm: 'explicit' };
      outcome = 'route_tentative';
    }
  } else {
    // What the utterance does to the current task decides how the intent is used.
    const change = answers.intentChange;
    const [changeTop] = isChoice(change) ? rankProbabilities(change.probabilities) : [];
    const changePassed = changeTop !== undefined && atLeast(changeTop.p, t.INTENT_CHANGE);
    // Too unsure to act on a change is the same as answering the question we asked.
    const mode = changePassed ? changeTop.label : 'answering';
    rows.push({ gate: 'intentChange', value: changeTop?.p ?? null, threshold: t.INTENT_CHANGE, passed: changePassed, outcome: changePassed ? mode : `${mode}:below`, decided: false });

    // Only an intent that is a form other than the one in hand can add or replace.
    const other = isFormIntent(app, label) && !inHand.includes(label) ? label : null;
    // A form that is an aside to the task in hand (FormDef.aside): replacing or added, it is taken
    // as an aside, and the form in hand resumes after it (turn.ts).
    const isAside = (form: string): boolean => formOf(app, form).aside !== undefined;

    if (label === 'agent' && atLeast(top.p, t.INTENT_SWITCH)) { routeVerdict = { kind: 'handoff', reason: 'live-agent' }; outcome = 'agent'; }
    else if (label === 'repeat_prompt' && atLeast(top.p, t.INTENT_SWITCH)) { routeVerdict = { kind: 'replay' }; outcome = 'replay'; }
    else if (label === 'wait' && atLeast(top.p, t.INTENT_SWITCH)) { routeVerdict = { kind: 'replay', wait: true }; outcome = 'wait'; }
    else if (informs !== undefined && atLeast(top.p, t.INTENT_SWITCH)) { routeVerdict = { kind: 'inform', ...informs }; outcome = 'inform'; }
    else if (mode === 'answering') { routeVerdict = { kind: 'proceed' }; outcome = 'answering'; }
    else if (mode === 'adding') {
      // Adding keeps the task in hand, so that task is not what is added. What the model gives it
      // is the caller carrying on with it (the yes to its summary in "yes, and can I also check on
      // my other parcel"), so the added task is read from the rest: the likeliest other form, as a
      // share of what is not the current one.
      const added = addedIntent(app, ranked, inHand);
      if (added && atLeast(added.p, t.INTENT_IMPLICIT) && isAside(added.label)) {
        // An aside is not queued behind the task: it is taken now, and the task resumes after it.
        routeVerdict = { kind: 'route', intent: added.label, confirm: tentative ? 'explicit' : 'none', aside: true }; outcome = tentative ? 'aside_tentative' : 'aside_added';
        intentValue = added.p; intentLabel = added.label;
      } else if (added && atLeast(added.p, t.INTENT_IMPLICIT)) {
        routeVerdict = { kind: 'queue', intent: added.label }; outcome = 'queue';
        intentValue = added.p; intentLabel = added.label;
      } else { routeVerdict = { kind: 'proceed' }; outcome = 'add_unused'; }
    }
    else if (mode === 'replacing') {
      const aside = other !== null && isAside(other) ? { aside: true as const } : {};
      const named = aside.aside ? 'aside' : 'switch';
      if (other && atLeast(top.p, t.INTENT_SWITCH)) { routeVerdict = { kind: 'route', intent: other, confirm: tentative ? 'explicit' : 'none', ...aside }; outcome = tentative ? `${named}_tentative` : named; }
      else if (other && atLeast(top.p, t.INTENT_IMPLICIT)) { routeVerdict = { kind: 'route', intent: other, confirm: 'explicit', ...aside }; outcome = `${named}_explicit`; }
      else { routeVerdict = { kind: 'proceed' }; outcome = 'replace_unresolved'; }
    }
    // An unrecognized change label decides nothing; carry on with the form.
    else { routeVerdict = { kind: 'proceed' }; outcome = 'proceed'; }
    // A question at a form's summary (App.questionAtSummary, `aside` by default; Harbor findings item 1):
    // a form that answers as an aside, or an informational intent, read at INTENT_ROUTE or more, where
    // the ladder above left the turn to the summary (the model read it as answering the read-back, or
    // as a change it could not act on). The caller asked something about the task before saying yes,
    // so it is answered, nothing is written, and the summary is asked again (turn.ts resumes on it).
    if (routeVerdict.kind === 'proceed' && pending?.target === 'form' && questionAtSummaryOf(app) === 'aside' && atLeast(top.p, t.INTENT_ROUTE)) {
      if (other !== null && isAside(other)) {
        routeVerdict = { kind: 'route', intent: other, confirm: tentative ? 'explicit' : 'none', aside: true }; outcome = tentative ? 'aside_tentative' : 'aside_at_summary';
      } else if (informs !== undefined) {
        // An informational line writes nothing and asks nothing, so a hedged question is answered too.
        routeVerdict = { kind: 'inform', ...informs }; outcome = 'inform_at_summary';
      }
    }
    // At a dictation the request is acted on only where the slot lists its intent; else the turn is words.
    const acted = intentActedOn(routeVerdict, label);
    if (acted !== null && !heeds(acted)) { routeVerdict = { kind: 'proceed' }; outcome = 'dictation'; }
  }

  // Second task on the opening utterance: only a plain route carries it;
  // a tentative or explicit route still gets a row, so the table shows it was named and dropped.
  // A caller who is done has no second task to queue.
  if (activeForm === null && routeVerdict.kind === 'route' && routeVerdict.intent !== 'done') {
    const [secondTop] = isChoice(answers.secondIntent) ? rankProbabilities(answers.secondIntent.probabilities) : [];
    const secondTask = secondTop && secondTop.label !== 'none' && isFormIntent(app, secondTop.label) && secondTop.label !== routeVerdict.intent && atLeast(secondTop.p, t.INTENT_SECOND) ? secondTop.label : null;
    if (secondTask && routeVerdict.confirm !== 'none') {
      rows.push({ gate: 'secondIntent', value: secondTop!.p, threshold: t.INTENT_SECOND, passed: false, outcome: 'ignored:not_plain_route', decided: false });
    } else {
      rows.push({ gate: 'secondIntent', value: secondTop?.p ?? null, threshold: t.INTENT_SECOND, passed: secondTask !== null, outcome: secondTask ? `queue:${secondTask}` : 'none', decided: false });
      if (secondTask) routeVerdict = { ...routeVerdict, queue: secondTask };
    }
  }

  // The summary's answer, combined with what the intent gate found:
  // a handoff, replay, or replacing route wins; otherwise yes/no/change/unanswered, carrying an added intent.
  let changeSlotRow: GateRow | null = null;
  // The row that actually decided a summary verdict, for the debug table and `decidedGate`:
  // the confirmation row for yes/no/unanswered, the changeSlot row for a named detail.
  let summaryDecidedRow: GateRow | null = null;
  if (pending?.target === 'form' && (routeVerdict.kind === 'proceed' || routeVerdict.kind === 'queue' || routeVerdict.kind === 'intent_failed')) {
    const queue = routeVerdict.kind === 'queue' ? routeVerdict.intent : undefined;
    const withQueue = (v: Extract<Verdict, { kind: 'confirmed' | 'rejected' | 'confirm_unanswered' | 'change_slot' }>): Verdict => (queue ? { ...v, queue } : v);
    if (formConfirm === 'confirmed') routeVerdict = withQueue({ kind: 'confirmed' });
    else {
      // A no that names the detail ("no, the date is wrong") says which slot to reopen, so the
      // name is read before the no is settled for. A no that carries a value instead answers the
      // question's `none`, and turn.ts fills it on the rejected path.
      const [changeTop] = isChoice(answers.changeSlot) ? rankProbabilities(answers.changeSlot.probabilities) : [];
      const asked = changeSlotNamed(app, answers, pending.form, t);
      // The form may keep the detail named, taking the answer as its own move ("a later time that day"
      // names the date and asks to keep it): the slot is not reopened, and the answer goes on to the
      // form's summary hook as a no or an unanswered turn (FormDef.keepsSlot, onSummaryAnswer).
      const kept = asked !== null && formOf(app, pending.form).keepsSlot?.(answers, asked, t) === true;
      // The change question asks for a detail named WITHOUT its new value, and its `none` is a new
      // value said instead. A turn that does give one of the form's slots a new value ("not Chen,
      // Cheng", "no, born June 15th") therefore contradicts a reading that it only named a detail:
      // the model has taken the value's own words for the naming, and on the threshold it does so
      // turn to turn. So the reading is set aside and the turn goes as it would without it, a no
      // with a correction (turn.ts fills the value on the rejected path), rather than reopening a
      // slot the caller did not ask about (the caller's name, for a doctor's) or crediting the
      // change gate with a plain correction. A value said again unchanged is no new value ("no,
      // it's Patel" with Patel held), so the naming still decides there. An app that wants the
      // reading to decide regardless says so (App.changeSlotWithValue `decides`).
      const setAside = asked !== null && !kept && given.size > 0 && changeSlotWithValueOf(app) === 'set-aside';
      const named = kept || setAside ? null : asked;
      changeSlotRow = { gate: 'changeSlot', value: changeTop?.p ?? null, threshold: t.SLOT_CHANGE, passed: named !== null, outcome: named ? `change:${named}` : kept ? 'kept' : setAside ? `value_given:${asked}` : 'none', decided: false };
      rows.push(changeSlotRow);
      if (named) routeVerdict = withQueue({ kind: 'change_slot', slot: named });
      else if (formConfirm === 'rejected') routeVerdict = withQueue({ kind: 'rejected' });
      else routeVerdict = withQueue({ kind: 'confirm_unanswered' });
    }
    outcome = `summary_${routeVerdict.kind}`;
    summaryDecidedRow = routeVerdict.kind === 'change_slot' ? changeSlotRow : confirmationRow;
  }

  rows.push({ gate: 'intentTentative', value: noulValue(answers, 'intentTentative'), threshold: t.INTENT_TENTATIVE, passed: true, outcome: tentative ? 'tentative' : 'plain', decided: false });

  const intentRow: GateRow = {
    gate: 'intent', value: intentValue, threshold: activeForm === null ? t.INTENT_EXPLICIT : t.INTENT_SWITCH,
    passed: routeVerdict.kind !== 'intent_failed', outcome: `${outcome}:${intentLabel}`, decided: false,
  };

  // A pending confirmation the caller neither answered nor talked past is a
  // confirmation retry, not an intent failure or a slot turn. Mid-form the
  // intent gate returns 'proceed', so that case has to be rescued too or the
  // confirmation goes stale and captures a later yes. A clear new route still
  // wins; enterForm/setForm clears the pending state.
  // `pending?.target !== 'form'` defends against future reordering: the summary resolution above
  // already consumes every routeVerdict.kind this rescue would otherwise map, for a form target.
  if (confirmationUnanswered && pending?.target !== 'form' && (routeVerdict.kind === 'intent_failed' || routeVerdict.kind === 'proceed' || routeVerdict.kind === 'queue')) {
    // An added intent still counts: the rescue carries it so the form can queue it
    // while the confirmation is re-asked.
    routeVerdict = routeVerdict.kind === 'queue' ? { kind: 'confirm_unanswered', queue: routeVerdict.intent } : { kind: 'confirm_unanswered' };
    intentRow.outcome = `confirm_unanswered:${intentLabel}`;
  }

  // 9. margin, whenever routing on a form intent. With normalized probabilities a
  // top-1 >= 0.60 always has margin >= 0.20, so in practice this fires inside the
  // explicit-confirm band and turns "confirm the top one" into "ask which of two".
  let marginRow: GateRow | null = null;
  // Only for a route on the top intent: an aside added beside the task is read from below it.
  // At a dictation, only between two intents the slot lists: an unlisted one is the slot's words.
  if (routeVerdict.kind === 'route' && routeVerdict.intent === label && second && isFormIntent(app, second.label) && heeds(second.label)) {
    const margin = top.p - second.p;
    const passed = atLeast(margin, t.GATE_INTENT_MARGIN);
    marginRow = { gate: 'intentMargin', value: margin, threshold: t.GATE_INTENT_MARGIN, passed, outcome: passed ? 'pass' : 'disambiguate', decided: false };
    if (!passed) routeVerdict = { kind: 'disambiguate_intent', a: label, b: second.label as Intent };
  }

  // A dictation that goes to the form's slots is the slot's words: the turn says which slot takes them.
  if (dictation !== null && routeVerdict.kind === 'proceed') routeVerdict = { kind: 'proceed', dictated: dictation.slot };

  if (routeVerdict.kind === 'proceed') {
    rows.push(intentRow);
  } else if (summaryDecidedRow) {
    // The summary resolved this turn, not the intent Choice: push the intent row for the debug
    // table (with its `summary_*` outcome) but leave it undecided, and credit the row that
    // actually drove the verdict instead — same "only if nothing decided yet" rule as `decide`.
    rows.push(intentRow);
    if (verdict === null) {
      verdict = routeVerdict;
      summaryDecidedRow.decided = true;
    }
  } else {
    decide(intentRow, routeVerdict);
  }
  if (marginRow) {
    if (!marginRow.passed && intentRow.decided) { intentRow.decided = false; marginRow.decided = true; }
    rows.push(marginRow);
  }

  // `verdict` is only ever assigned inside the `decide` closure, so TypeScript narrows it to null here; the `??` is load-bearing at runtime.
  let settledVerdict: Verdict = verdict ?? routeVerdict;
  // 10. priority intent (IntentDef.priority), only for an app that marks one: every other app's rows
  // and verdicts are exactly what the ladder above settled. Read last, from answers the ladder already
  // has (the intent's probabilities), so it can say which gate it took the turn from. It overrides
  // every verdict but a handoff to a person (wantsHuman, frustration, the agent intent, a menu's 0)
  // and a held partial (read again when final); the injection screen runs before the gates.
  if (priorityIntentsOf(app).length > 0) {
    const p = priorityReading(app, ranked, t);
    const decidedBy = rows.find((r) => r.decided)?.gate ?? 'intent';
    const row: GateRow = { gate: 'priorityIntent', value: p?.p ?? null, threshold: p?.threshold ?? null, passed: p?.reached === true, outcome: '', decided: false };
    // `none` stands when the intent answer ranks no priority intent at all.
    if (p === null) row.outcome = 'none';
    else if (!p.reached) row.outcome = 'below';
    else if (inHand.includes(p.intent)) row.outcome = 'in_form';
    // At a dictation, acted on only where the slot lists it: else the turn is the slot's words.
    else if (!heeds(p.intent)) row.outcome = 'dictation';
    else if (settledVerdict.kind === 'handoff' || settledVerdict.kind === 'hold') row.outcome = `stands:${decidedBy}`;
    else if (actsOn(settledVerdict, p.intent, label)) row.outcome = 'agrees';
    else {
      const informs = informationOf(app, p.intent);
      settledVerdict = informs !== undefined ? { kind: 'inform', ...informs } : { kind: 'route', intent: p.intent, confirm: 'none' };
      row.outcome = `act:${p.intent}:over:${decidedBy}`;
      for (const r of rows) r.decided = false;
      row.decided = true;
    }
    rows.push(row);
  }

  return { rows, verdict: withFrustration(settledVerdict, frustrationRung), readHigh: shownHigh };
}

/**
 * The turn's reading of the app's priority intents: the likeliest of them, its probability, the
 * threshold it is read against (IntentDef.priority: PRIORITY_INTENT, or the one it names, the
 * engine's or the app's own), and whether the probability reaches it. Null when the intent answer
 * ranks none of them.
 */
function priorityReading(app: App, ranked: readonly { label: string; p: number }[], t: Thresholds): { intent: Intent; p: number; threshold: number | null; reached: boolean } | null {
  for (const { label, p } of ranked) {
    const name = priorityThresholdOf(app, label);
    if (name === null) continue;
    // A direct call with the engine's thresholds alone still reads the app's own (App.thresholds).
    const threshold = t[name] ?? app.thresholds?.[name] ?? null;
    return { intent: label as Intent, p, threshold, reached: threshold !== null && atLeast(p, threshold) };
  }
  return null;
}

/**
 * The intent a verdict of the form's ladder acts on, if any: the agent intent's handoff, the repeat's
 * replay, an informational answer (the top intent, `top`), a form entered or queued. Null for the turn
 * that goes to the form's slots. Read at a dictation, where only the intents the slot lists are acted on.
 */
function intentActedOn(v: Verdict, top: Intent): string | null {
  switch (v.kind) {
    case 'handoff': return 'agent';
    case 'replay': return v.wait === true ? 'wait' : 'repeat_prompt';
    case 'inform': return top;
    case 'route': case 'queue': return v.intent;
    default: return null;
  }
}

/**
 * Whether the verdict the ladder settled on already does what a priority reading of `intent` would:
 * starts its form without asking (a route that is not an explicit confirmation), or says it (an
 * inform verdict for the top intent, `top`). Then the ladder's own row keeps the credit, and whatever
 * it carries (a second task queued at the opener) stands.
 */
function actsOn(v: Verdict, intent: Intent, top: Intent): boolean {
  if (v.kind === 'route') return v.intent === intent && v.confirm !== 'explicit';
  return v.kind === 'inform' && top === intent;
}
