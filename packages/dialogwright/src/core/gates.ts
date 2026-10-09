import { isChoice, isScore, noulValue, rankProbabilities, type AnswerMap } from '../jev/types';
import { informationOf, isFormIntent, type Informs } from './app/intents';
import { changeSlotWithValueOf, formOf, priorityIntentsOf, priorityThresholdOf, unsureOf } from './app/lookup';
import { appOf } from './app/registry';
import type { App, FormId, Intent, SlotId } from './app/types';
import type { Session } from './session';
import type { TurnState } from './state';
import { atLeast, type Thresholds } from './thresholds';

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
 * or one that is answering the offer -- carries nothing.
 *
 * Only the verdicts that let the call go on carry it: the turn prepends the acknowledgment to the
 * prompt it was going to play, or replaces that prompt with the offer, and neither makes sense for
 * a turn that says nothing (`ignore`, `hold`), one that is already leaving (`handoff`), or a replay
 * of the last prompt.
 */
export type FrustrationRung = 'ack' | 'offer';
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
  | { kind: 'replay' }
  /** An informational intent: its prompt (`promptId`) or its knowledge-base passage (`passage`) is said, and the call resumes. */
  | ({ kind: 'inform' } & Informs & Frustrated)
  /**
   * A form to enter, or 'done': the caller is finished and the call ends with the goodbye. Or an
   * informational intent the model is unsure of, always with `confirm: 'explicit'`: the caller is
   * asked whether they want it, and its answer is said on a yes (turn.ts, the confirmed intent).
   */
  | ({ kind: 'route'; intent: FormId | 'done' | Intent; confirm: 'none' | 'implicit' | 'explicit'; queue?: FormId } & Frustrated)
  | ({ kind: 'queue'; intent: FormId } & Frustrated)
  | ({ kind: 'disambiguate_intent'; a: Intent; b: Intent } & Frustrated)
  | ({ kind: 'intent_failed' } & Frustrated)
  | ({ kind: 'proceed' } & Frustrated);

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
}

const NO_SLOTS: ReadonlySet<SlotId> = new Set();

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

  // 1. addressed to system
  {
    const v = noulValue(answers, 'addressedToSystem');
    const passed = atLeast(v, t.GATE_ADDRESSED);
    const row = { gate: 'addressedToSystem', value: v, threshold: t.GATE_ADDRESSED, passed, outcome: passed ? 'pass' : 'ignore', decided: false };
    passed ? rows.push(row) : decide(row, { kind: 'ignore' });
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
    const row = { gate: 'wantsHuman', value: v, threshold: t.GATE_WANTS_HUMAN, passed, outcome: passed ? 'pass' : 'handoff', decided: false };
    passed ? rows.push(row) : decide(row, { kind: 'handoff', reason });
  }

  // 5. frustration escalation (before intent; see Deviation note). The gate reads the rung off the
  // count the session carries; only the handoff is a verdict of its own, and the turn does the
  // bookkeeping. A repeated attempt no longer matters.
  let frustrationRung: FrustrationRung | null = null;
  {
    const f = answers.frustration;
    const high = isScore(f) ? (f.probabilities.high ?? 0) : 0;
    const frustrated = atLeast(high, t.GATE_FRUSTRATION_HIGH);
    // The caller answering the offer is not counted again, however crossly they answer it.
    const atOffer = session.pendingConfirmation?.target === 'transfer';
    const count = frustrated && !atOffer ? session.frustratedTurns + 1 : session.frustratedTurns;
    const rung = !frustrated || atOffer ? 'pass'
      : count === 1 ? 'ack'
        : count === 2 && !session.transferDeclined ? 'offer'
          : 'handoff';
    const row = { gate: 'frustration', value: high, threshold: t.GATE_FRUSTRATION_HIGH, passed: rung !== 'handoff', outcome: rung, decided: false };
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
    frustrationRung = rung === 'ack' || rung === 'offer' ? rung : null;
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
      const row = { gate: 'menuNumber', value: top.p, threshold: t.MENU_NUMBER, passed: true, outcome: `menu:${mapped.intent}`, decided: false };
      if (mapped.intent === 'agent') decide(row, { kind: 'handoff', reason: 'live-agent' });
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

    if (label === 'agent' && atLeast(top.p, t.INTENT_SWITCH)) { routeVerdict = { kind: 'handoff', reason: 'live-agent' }; outcome = 'agent'; }
    else if (label === 'repeat_prompt' && atLeast(top.p, t.INTENT_SWITCH)) { routeVerdict = { kind: 'replay' }; outcome = 'replay'; }
    else if (informs !== undefined && atLeast(top.p, t.INTENT_SWITCH)) { routeVerdict = { kind: 'inform', ...informs }; outcome = 'inform'; }
    else if (mode === 'answering') { routeVerdict = { kind: 'proceed' }; outcome = 'answering'; }
    else if (mode === 'adding') {
      // Adding keeps the task in hand, so that task is not what is added. What the model gives it
      // is the caller carrying on with it (the yes to its summary in "yes, and can I also check on
      // my other parcel"), so the added task is read from the rest: the likeliest other form, as a
      // share of what is not the current one.
      const added = addedIntent(app, ranked, inHand);
      if (added && atLeast(added.p, t.INTENT_IMPLICIT)) {
        routeVerdict = { kind: 'queue', intent: added.label }; outcome = 'queue';
        intentValue = added.p; intentLabel = added.label;
      } else { routeVerdict = { kind: 'proceed' }; outcome = 'add_unused'; }
    }
    else if (mode === 'replacing') {
      if (other && atLeast(top.p, t.INTENT_SWITCH)) { routeVerdict = { kind: 'route', intent: other, confirm: tentative ? 'explicit' : 'none' }; outcome = tentative ? 'switch_tentative' : 'switch'; }
      else if (other && atLeast(top.p, t.INTENT_IMPLICIT)) { routeVerdict = { kind: 'route', intent: other, confirm: 'explicit' }; outcome = 'switch_explicit'; }
      else { routeVerdict = { kind: 'proceed' }; outcome = 'replace_unresolved'; }
    }
    // An unrecognized change label decides nothing; carry on with the form.
    else { routeVerdict = { kind: 'proceed' }; outcome = 'proceed'; }
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
      const asked = changeTop && changeTop.label !== 'none' && atLeast(changeTop.p, t.SLOT_CHANGE) && formOf(app, pending.form).slots.includes(changeTop.label as SlotId) ? (changeTop.label as SlotId) : null;
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
  if (routeVerdict.kind === 'route' && second && isFormIntent(app, second.label)) {
    const margin = top.p - second.p;
    const passed = atLeast(margin, t.GATE_INTENT_MARGIN);
    marginRow = { gate: 'intentMargin', value: margin, threshold: t.GATE_INTENT_MARGIN, passed, outcome: passed ? 'pass' : 'disambiguate', decided: false };
    if (!passed) routeVerdict = { kind: 'disambiguate_intent', a: label, b: second.label as Intent };
  }

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

  return { rows, verdict: withFrustration(settledVerdict, frustrationRung) };
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
 * Whether the verdict the ladder settled on already does what a priority reading of `intent` would:
 * starts its form without asking (a route that is not an explicit confirmation), or says it (an
 * inform verdict for the top intent, `top`). Then the ladder's own row keeps the credit, and whatever
 * it carries (a second task queued at the opener) stands.
 */
function actsOn(v: Verdict, intent: Intent, top: Intent): boolean {
  if (v.kind === 'route') return v.intent === intent && v.confirm !== 'explicit';
  return v.kind === 'inform' && top === intent;
}
