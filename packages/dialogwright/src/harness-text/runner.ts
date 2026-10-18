import { readdirSync, readFileSync } from 'node:fs';
import { rulesAt } from '../core/routes';
import { localDateIso } from '../run/clock';
import { join } from 'node:path';
import { appTurnContext, askTextConsent, CALLER_LOOKUP_PURPOSE, renderSummary, summaryVars, type TurnContext, type TurnResult } from '../core/turn';
import { cloneSession, emptySlot, missingSlots, newSession, noteTaskClosed, setForm, type Session } from '../core/session';
import { untilReplied, type ToolMemo } from '../core/toolWait';
import { CALLER_MATCH_PROMPT, callTool, continueIdentity, ensureEntry, newTurnOut, type GateEvent } from '../core/lifecycle';
import { atCallerMatch, atCallerOffer, atGreetingOffer, atTextConsent, confirmForm, contextForm, normalizeText, offerTransfer, promptsIdentity, type CorpusEntry, type KnownGap, type PinnedOutcome } from '../jev/corpus';
import { scenarioGapProblems } from './scenarioGap';
import { JevClientError, type JevClient } from '../jev/types';
import { promptText, spokenText as decisionText } from '../prompts/render';
import { prompt, type Decision } from '../core/decision';
import { appOf, defaultAppId, getApp } from '../core/app/registry';
import { askedOfCaller, formOf, identityOf } from '../core/app/lookup';
import { delegateProblem, subjectProblem } from '../core/app/principals';
import type { App, Refused, SlotId } from '../core/app/types';
import { serviceResultEvent, keyEvents, signedInEvent, silenceEvent, speechEvent, startEvent, textEvent, withCallData, withCalledNumber, withCallerAttestation, withCallerNumber, withCallerWithheld, type SessionEvent } from '../channel/events';
import { keptCallerNumber, lastFour } from '../core/callerNumber';
import { factsOfferSlots, greetingOfferPromptId } from '../core/factsOffer';
import { sayText, type Action } from '../channel/actions';
import { ANONYMOUS } from '../gate/principal';
import type { Principal } from '../gate/types';
import { carryScrub } from '../core/recording';
import { RenderClientError, type RenderClient } from '../render/types';
export { runTurn, nowOf, type RunOptions, type TurnRun } from '../run/turn';
import { runTurn, nowOf, type RunOptions, type TurnRun } from '../run/turn';
import { demoTools } from '../core/tools';
import { VOICE_RELAY, WEB_CHAT } from '../channel/caps';
import { matchLocale } from '../core/locale';
import { localeOfNumber, numberLocalesOf } from '../core/numberLocales';

/** How a runner runs one turn: runTurn, unless a test runs each one another way (testing/sessionRoundTrip.ts). */
export type TurnRunner = typeof runTurn;

/** A run's options, and how it runs each turn (runTurn when `turn` is absent, as every run but a test's). */
export interface ScenarioRunOptions extends RunOptions {
  readonly turn?: TurnRunner;
  /**
   * A test's stand-in for a downstream service's answer (dialogwright/testing adversarialSuite: a
   * hostile reply): given what the app's stand-in answered (App.testing.serviceAnswers), what the call
   * is given in its place. Absent, as on every run but such a test, the stand-in's answer is given.
   */
  readonly serviceReply?: (service: string, answer: unknown) => unknown;
}

export interface Outcome {
  id: string;
  decision: string;
  promptId: string | null;
  /** implicit-confirm prompts spoken before this decision's prompt */
  acks: string[];
  reason: string | null;
  decidedGate: string | null;
  verdict: string | null;
  form: string | null;
  slots: Record<SlotId, string | null>;
  /** intents added mid-form and not yet started */
  queued: string[];
  /** how far the caller is verified: 0 anonymous, 1 account ID and date of birth, 2 the keypad code as well */
  principalLevel: number;
  /** the last action-gate decision, as "tool:VERDICT", or null when the gate was not asked */
  gate: string | null;
}

// A known gap (CorpusEntry.knownGap) pins outcome fields by name: its PinnedOutcome must name
// exactly these fields but the id, with the same types, or this fails to compile.
type SameKeys<A, B> = [Exclude<keyof A, keyof B>, Exclude<keyof B, keyof A>] extends [never, never] ? true : false;
const pinsEveryOutcomeField: SameKeys<Required<PinnedOutcome>, Omit<Outcome, 'id'>> & (Required<PinnedOutcome> extends Omit<Outcome, 'id'> ? true : false) = true;
void pinsEveryOutcomeField;

/** A gate event as the outcome pins it: "getAccount:BLOCK". */
export function gateLabel(event: GateEvent | undefined): string | null {
  return event ? `${event.decision.call.tool}:${event.decision.verdict}` : null;
}

/**
 * `gateEvents` defaults to this turn's own. A scenario passes every turn's, so a closing turn the
 * gate took no part in (a downstream service's answer) still reports the decision that led to it.
 */
export function outcomeOf(id: string, result: TurnResult, gateEvents: readonly GateEvent[] = result.gateEvents): Outcome {
  const d = result.decision;
  return {
    id,
    decision: d.kind,
    promptId: 'promptId' in d ? d.promptId : null,
    acks: 'acks' in d ? d.acks.map((a) => a.promptId) : [],
    reason: d.kind === 'handoff' ? d.reason : null,
    decidedGate: result.rows.find((r) => r.decided)?.gate ?? null,
    verdict: result.verdict?.kind ?? null,
    form: result.session.form,
    slots: Object.fromEntries(Object.keys(appOf(result.session).slots).map((id) => [id, result.session.slots[id]!.value])) as Record<SlotId, string | null>,
    queued: [...result.session.queued],
    principalLevel: result.session.principal.level,
    gate: gateLabel(gateEvents.at(-1)),
  };
}

/** What seeding needs to reach the tools: the same gate and book of business the entry's turn runs against. */
/**
 * What a seed runs with: the run's thresholds, day and systems, and the memo its tool calls are kept in
 * where a tool waits on a system (core/toolWait.ts untilReplied: the seed made again once the reply is in).
 */
export type SeedOptions = Pick<RunOptions, 'thresholds' | 'todayIso' | 'tools'> & { readonly toolMemo?: ToolMemo };

/** A seed's turn context: the moment 0, the run's day, thresholds and systems, and its memo (SeedOptions.toolMemo). */
export function seedTurnContext(app: App, opts: SeedOptions): TurnContext {
  return appTurnContext(app, { nowMs: 0, todayIso: opts.todayIso, thresholds: opts.thresholds, tools: opts.tools ?? demoTools(), ...(opts.toolMemo !== undefined ? { toolMemo: opts.toolMemo } : {}) });
}

type Seed = NonNullable<NonNullable<App['testing']>['seed']>;

function fillPlaceholder(seed: Seed, session: Session, id: SlotId, confirmed: boolean): void {
  const placeholder = Object.hasOwn(seed.placeholders, id) ? seed.placeholders[id] : undefined;
  if (!placeholder) throw new Error(`no placeholder value for slot "${id}"`);
  session.slots[id] = { ...emptySlot(), value: placeholder.value, display: placeholder.display, confirmed };
  // Given earlier in the call, so its form's afterSlot hook has seen it (Session.slotsSeen), as on a call.
  const form = session.form !== null ? formOf(appOf(session), session.form) : undefined;
  if (form?.afterSlot !== undefined && form.slots.includes(id)) session.slotsSeen = { ...(session.slotsSeen ?? {}), [id]: placeholder.value };
}

/**
 * The mid-call state a corpus entry's context implies: who the caller is, the form, the slots
 * already collected, and the prompt being answered. The values are the app's (App.testing.seed:
 * e.g. a seed customer and their details); the seeding is the harness's.
 *
 * - A form context seeds the app's caller (e.g. a seed customer, level 2), the form's entry call already
 *   passed through the gate (entered, facts loaded), so the entry tests slot filling rather than identity.
 * - `prompted` naming an identity factor (e.g. accountId, dob) seeds an anonymous caller with the
 *   gate's step-up for the form's entry call pending, the factors asked before it already in.
 * - `anything_else` seeds the caller with no form open, a form just answered (e.g. an account
 *   question), and "anything else?" asked.
 *
 * The entry call goes through the real lifecycle (ensureEntry), so the step-up and the facts are
 * exactly what a call would have; its gate events are the seed's, not the entry's.
 */
export function seedCorpusSession(session: Session, entry: CorpusEntry, opts: SeedOptions): Session {
  if (atGreetingOffer(entry, appOf(session))) return seedGreetingOffer(session, entry);
  if (atTextConsent(entry, appOf(session))) return seedTextConsent(session, entry, opts);
  if (atCallerMatch(entry, appOf(session))) return seedCallerMatch(session, entry, opts);
  if (entry.context === 'no_form') return session;
  const app = appOf(session);
  const seed = app.testing?.seed;
  if (!seed) throw new Error(`corpus ${entry.id}: app "${app.id}" seeds no ${entry.context} context (App.testing.seed)`);
  const tc: TurnContext = seedTurnContext(app, opts);
  const identity = promptsIdentity(entry, app);
  session.principal = identity ? ANONYMOUS : seed.caller();
  // The facts as the placeholders left them mid-call (App.testing.seed.facts).
  seed.facts?.(session.facts);
  // A caller seeded as verified was verified earlier in the call, so the routes after identity
  // (routes.yaml) have run: the entry's turn does not run them as if the caller had just verified.
  if (!identity && rulesAt(app, 'afterIdentity').length > 0) session.identityRouted = true;
  // A verified caller's factors stay on the call; a step-up has the factors it asked before the one prompted.
  const factors = identityOf(app).factorSlots;
  for (const id of factors) {
    if (!identity || factors.indexOf(id) < factors.indexOf(entry.prompted)) fillPlaceholder(seed, session, id, true);
    else session.slots[id] = emptySlot();
  }
  if (entry.context === 'anything_else') {
    // The form just answered, whose facts stay on the call. Read through the gate like every other
    // call: the seed reaches no tool the gate did not allow. What the result leaves on the session
    // is the form's own (FormDef.onEntry), as after its entry call. A form answered by its own line
    // has no call to make again.
    if (!seed.anythingElse) throw new Error(`corpus ${entry.id}: app "${app.id}" seeds no anything_else context (App.testing.seed.anythingElse)`);
    const answered = seed.anythingElse();
    session.completed = [answered.form];
    // It is the call's most recent task, as closing it would have left it (Session.lastTask).
    noteTaskClosed(session, answered.form);
    if (answered.call) {
      const { value } = callTool(session, answered.call, tc, newTurnOut());
      formOf(app, answered.form).onEntry?.(session, value);
    }
    session.promptedFor = 'intent';
    session.lastPromptId = 'anything_else';
    session.lastPromptText = promptText(app, 'anything_else', {}, session.locale);
    session.lastPromptOptions = [];
    return session;
  }
  const form = contextForm(entry.context, app)!;
  setForm(session, form);
  session.entered = null;
  const confirming = confirmForm(entry.context, app) !== null;
  const offering = offerTransfer(entry.context);
  // An entry that targets a later slot starts from a form that already has the earlier ones; a confirm_
  // entry starts from a form that has every slot, since the summary is only asked once the form is full.
  // Computed once, before any slot is filled: recomputing missingSlots(session) per iteration would chase
  // a moving target as the loop fills earlier slots. A step-up comes before any of the form's own slots.
  const stopAt = identity ? formOf(app, form).slots[0] : entry.prompted ?? missingSlots(session)[0];
  for (const id of formOf(app, form).slots) {
    if (!confirming && id === stopAt) break;
    // A slot not asked of the seeded caller (SlotSpec.askedOf) is no part of their form.
    if (!askedOfCaller(app.slots[id], session.principal)) continue;
    // In a confirm_ context every slot is seeded unconfirmed: the summary is what confirms them, not this
    // placeholder fill.
    fillPlaceholder(seed, session, id, !confirming);
  }
  // The entry call, through the gate: ALLOW for the seed customer (facts loaded, entered), STEP_UP for an
  // anonymous caller (the step-up pending, the next factor asked).
  ensureEntry(session, tc, newTurnOut(), []);
  if (confirming) {
    const promptId = formOf(app, form).summaryPromptId;
    if (!promptId) throw new Error(`corpus ${entry.id}: form ${form} has no summary prompt`);
    session.pendingConfirmation = { target: 'form', form, attempts: 0 };
    session.promptedFor = 'confirm';
    // Read as a turn reads it, through the form's summary hook (FormDef.onSummaryRead): what it names
    // beyond the slots (a record found, an option offered) is in the text the caller answers.
    const read = renderSummary(session, prompt(promptId, 'confirm', summaryVars(session), [], ['yes', 'no']), tc, newTurnOut());
    session.lastPromptId = read.promptId;
    session.lastPromptText = promptText(app, read.promptId, read.vars, session.locale);
    // The summary has been spoken, so its values are what a yes arms (the gate's confirmed rule): renderSummary took
    // their hash as it read them.
    session.lastPromptOptions = ['yes', 'no'];
    return session;
  }
  if (offering) {
    // The frustrated caller has been offered a transfer and has not answered it yet: two frustrated
    // turns behind them, the question `prompted` names still to come back to.
    session.pendingConfirmation = { target: 'transfer', attempts: 0 };
    session.promptedFor = 'confirm';
    session.lastPromptId = 'offer_transfer';
    session.lastPromptText = promptText(app, 'offer_transfer', {}, session.locale);
    session.lastPromptOptions = ['yes', 'no'];
    session.frustratedTurns = 2;
    return session;
  }
  if (atCallerOffer(entry, app)) {
    // The number the caller is calling from has been offered for the prompted slot (SlotSpec.callerNumber),
    // or a value proposed from the facts (`offer: facts`), the app's placeholder for the slot as the
    // value, and the slot is still empty: the entry answers the offer.
    const slot = entry.prompted;
    const placeholder = Object.hasOwn(seed.placeholders, slot) ? seed.placeholders[slot] : undefined;
    if (!placeholder) throw new Error(`no placeholder value for slot "${slot}"`);
    const facts = factsOfferSlots(app).includes(slot);
    session.pendingConfirmation = { target: 'slot', slot, value: placeholder.value, display: placeholder.display, offered: true, ...(facts ? { from: 'facts' as const } : {}) };
    session.callerOffered = [slot];
    session.promptedFor = slot;
    session.lastPromptId = `offer_${slot}`;
    session.lastPromptText = promptText(app, `offer_${slot}`, facts ? { [slot]: placeholder.display } : { last4: lastFour(placeholder.value) }, session.locale);
    session.lastPromptOptions = ['yes', 'no'];
    return session;
  }
  const slot = identity ? entry.prompted! : stopAt ?? null;
  session.promptedFor = slot;
  session.lastPromptId = slot ? `ask_${slot}` : null;
  session.lastPromptText = slot ? promptText(app, `ask_${slot}`, {}, session.locale) : '';
  return session;
}

/**
 * The proposal at the greeting (atGreetingOffer): the app's placeholder for the prompted slot proposed
 * as a call opens (`offerAt: greeting`), as the engine makes it (core/turn.ts greetingProposal): no form
 * open, the slot still empty, `offer_<slot>` after the greeting's line, asked for no slot.
 */
function seedGreetingOffer(session: Session, entry: CorpusEntry & { prompted: SlotId }): Session {
  const app = appOf(session);
  const slot = entry.prompted;
  const placeholder = app.testing?.seed?.placeholders && Object.hasOwn(app.testing.seed.placeholders, slot) ? app.testing.seed.placeholders[slot] : undefined;
  if (!placeholder) throw new Error(`corpus ${entry.id}: no placeholder value for slot "${slot}"`);
  session.pendingConfirmation = { target: 'slot', slot, value: placeholder.value, display: placeholder.display, offered: true, from: 'facts', at: 'greeting' };
  session.greetingOffered = slot;
  const said = prompt(`offer_${slot}`, 'intent', { [slot]: placeholder.display }, [{ promptId: greetingOfferPromptId(app), vars: {} }], ['yes', 'no']);
  session.promptedFor = 'intent';
  session.lastPromptId = said.promptId;
  session.lastPromptText = decisionText(app, said, session.locale);
  session.lastPromptOptions = ['yes', 'no'];
  return session;
}

/**
 * The consent to text for the whole call just asked (atTextConsent), as the engine asks it: the call from
 * the app's seed number (App.testing.seed.callerNumber), its call-start lookup made through the gate and
 * kept in the facts as a call's is, then the question for the slot a call would choose (the first covered
 * slot that takes the number and that callerOffer allows), `consent_texts` after the greeting's line, no
 * form open.
 */
function seedTextConsent(session: Session, entry: CorpusEntry, opts: SeedOptions): Session {
  const app = appOf(session);
  const number = app.testing?.seed?.callerNumber;
  if (number === undefined) throw new Error(`corpus ${entry.id}: app "${app.id}" seeds no consent question (App.testing.seed.callerNumber, the number calling)`);
  const kept = keptCallerNumber(app, number);
  if (kept === undefined) throw new Error(`corpus ${entry.id}: the seed number ${number} is not one the app keeps`);
  session.callerNumber = kept;
  const tc: TurnContext = seedTurnContext(app, opts);
  // The call-start lookup, as a call makes it, so a callerOffer hook that reads what it found answers as on a call.
  const lookup = app.callerNumber?.lookup;
  if (lookup !== undefined) {
    const looked = callTool(session, { tool: lookup, params: { callerNumber: kept }, purpose: CALLER_LOOKUP_PURPOSE }, tc, newTurnOut());
    if (looked.decision.verdict === 'ALLOW' && looked.value != null) app.facts?.fromCallerLookup?.(session.facts, looked.value);
  }
  // The same choice of slot a call makes (core/turn.ts askTextConsent): the first covered slot that takes the number and that the hook allows.
  const said = askTextConsent(session, tc, newTurnOut());
  if (said === null) throw new Error(`corpus ${entry.id}: the seed number ${number} reaches no consent question (no covered slot takes it, or callerOffer allows none)`);
  session.promptedFor = 'intent';
  session.lastPromptId = said.promptId;
  session.lastPromptText = decisionText(app, said, session.locale);
  session.lastPromptOptions = ['yes', 'no'];
  return session;
}

/**
 * The caller-ID question just asked (atCallerMatch), as the engine asks it: the call from the app's
 * seed number (App.testing.seed.callerNumber), its call-start lookup made through the gate and kept in
 * the facts as a call's is, an anonymous caller, the identified factors and the one asked empty, and
 * `identity_caller_match` the prompt the entry answers. In a form's context, the form's entry call
 * through the gate (its step-up, which asks the question); in `no_form`, at the greeting (the step-up
 * `at: greeting`, after the greeting's line before a proposal).
 */
function seedCallerMatch(session: Session, entry: CorpusEntry & { prompted: SlotId }, opts: SeedOptions): Session {
  const app = appOf(session);
  const number = app.testing?.seed?.callerNumber;
  if (number === undefined) throw new Error(`corpus ${entry.id}: app "${app.id}" seeds no caller-ID question (App.testing.seed.callerNumber)`);
  const tc: TurnContext = seedTurnContext(app, opts);
  const kept = keptCallerNumber(app, number);
  const lookup = app.callerNumber?.lookup;
  if (kept === undefined || lookup === undefined) throw new Error(`corpus ${entry.id}: app "${app.id}" keeps no number to look up for the caller-ID question`);
  session.callerNumber = kept;
  const looked = callTool(session, { tool: lookup, params: { callerNumber: kept }, purpose: CALLER_LOOKUP_PURPOSE }, tc, newTurnOut());
  if (looked.decision.verdict === 'ALLOW' && looked.value != null) app.facts?.fromCallerLookup?.(session.facts, looked.value);
  const out = newTurnOut();
  let asked: Decision | Refused | null;
  if (entry.context === 'no_form') {
    const identity = identityOf(app);
    session.stepUp = { call: { tool: identity.verifyTool, params: {} }, need: 1, at: 'greeting' };
    asked = continueIdentity(session, tc, out, [{ promptId: greetingOfferPromptId(app), vars: {} }]);
  } else {
    setForm(session, contextForm(entry.context, app)!);
    session.entered = null;
    asked = ensureEntry(session, tc, out, []);
  }
  if (asked?.kind !== 'prompt' || asked.promptId !== CALLER_MATCH_PROMPT) throw new Error(`corpus ${entry.id}: the seed number ${number} does not reach the caller-ID question (the lookup found no single match)`);
  session.promptedFor = asked.target;
  session.lastPromptId = asked.promptId;
  session.lastPromptText = decisionText(app, asked, session.locale);
  session.lastPromptOptions = [];
  return session;
}

/** `as` for a scenario that is the subjects' web chat, anonymous until a `signIn` step. */
export const WEB_VISITOR = 'web';

/**
 * The delegate `as` names, signed in through the app's portal; null when the app has no such
 * delegate. One the app's identity does not declare (its kind, its role) is the app's error.
 */
function signedInDelegate(as: string): Principal | null {
  const app = getApp(defaultAppId());
  const p = app.principals?.delegatePrincipal?.(as) ?? null;
  const problem = p && app.identity ? delegateProblem(app.identity, p) : null;
  if (problem) throw new Error(`as "${as}" ${problem}`);
  return p;
}

/**
 * The subject `id` names, signed in through the app's portal at the level a sign-in proves
 * (identity.yaml's `signIn`; a subject's web chat). An app that takes no sign-in has none to give.
 */
function signedInSubject(scenarioId: string, id: string): Principal {
  const app = getApp(defaultAppId());
  const level = identityOf(app).signInLevel;
  if (level === undefined) throw new Error(`${scenarioId}: signIn "${id}", but the app takes no sign-in (identity.yaml has no signIn)`);
  const p = app.principals?.subjectPrincipal?.(id, level) ?? null;
  if (!p) throw new Error(`${scenarioId}: signIn "${id}" is not a ${identityOf(app).subjectKind}`);
  const problem = subjectProblem(identityOf(app), p, level);
  if (problem) throw new Error(`${scenarioId}: signIn "${id}" ${problem}`);
  return p;
}

/**
 * A new session: a phone call from an anonymous caller, or with `as` (a delegate id the app lists),
 * the delegates' chat, signed in through the portal as that delegate, or with `as: 'web'`, the subjects'
 * web chat, anonymous.
 */
export function startSession(id: string, nowMs: number, as?: string): Session {
  if (as === undefined) return newSession(id, nowMs, VOICE_RELAY);
  if (as === WEB_VISITOR) return newSession(id, nowMs, WEB_CHAT);
  const delegate = signedInDelegate(as);
  if (!delegate) throw new Error(`${id}: as "${as}" is not a ${identityOf(getApp(defaultAppId())).delegateKind ?? 'delegate'}`);
  return newSession(id, nowMs, WEB_CHAT, delegate);
}

/**
 * Words said on `session`'s channel: typed text where the channel has no speech (always final),
 * otherwise a transcript, final unless `final` is false.
 */
export function saidEvent(session: Session, text: string, final = true): SessionEvent {
  if (!session.caps.speech) {
    if (!final) throw new Error('saidEvent: a partial transcript (partial: true) needs a channel with speech; this session is typed text, which is always final');
    return textEvent(text);
  }
  return speechEvent(text, final);
}

/**
 * The prompt a seeded session is answering: what the greeting's bookkeeping (core/turn.ts
 * bookkeep) overwrites. Everything else the seed set (slots, form, the pending confirmation and its
 * summary hash, facts) the greeting leaves alone.
 */
function seededPrompt(s: Session): Pick<Session, 'lastPromptId' | 'lastPromptText' | 'lastPromptOptions' | 'promptedFor'> {
  return { lastPromptId: s.lastPromptId, lastPromptText: s.lastPromptText, lastPromptOptions: [...s.lastPromptOptions], promptedFor: s.promptedFor };
}

export async function runCorpusEntry(entry: CorpusEntry, opts: ScenarioRunOptions): Promise<{ outcome: Outcome; run: TurnRun; setup: TurnRun }> {
  const { setup, runs } = await runSeeded(entry, opts);
  const run = runs.at(-1)!;
  // The setup run is returned as well as traced: a summary that leaves it out would read
  // the seeded placeholders as slots this one utterance filled.
  return { outcome: outcomeOf(entry.id, run.result), run, setup };
}

/**
 * How a seeded call is set up and what is said into it (runSeeded), where it is not a corpus entry's
 * own: the language the call starts in, a seed of its own in place of the entry's context, and the
 * caller's events in place of the entry's words. Each absent: as a corpus entry runs.
 */
export interface SeededCall {
  /** The language tag the call asks to start in (a Scenario's `locale`): the session speaks the app's matching locale. */
  readonly locale?: string;
  /** The mid-call state, in place of seedCorpusSession's for the entry. */
  readonly seed?: (session: Session, opts: SeedOptions) => Session;
  /** What the caller does, in place of saying the entry's words: each event a turn, with its downstream services' answers after it. */
  readonly events?: (session: Session) => SessionEvent[];
}

/**
 * A corpus entry's call, as runCorpusEntry runs it: seeded to the entry's state (or `how.seed`'s),
 * greeted, the seeded prompt put back, then the entry's words said (or `how.events`, one turn each,
 * each followed by the answers of the services it asked, as a scripted call is). Returns the
 * greeting's run and the caller's turns' runs, in order.
 */
export async function runSeeded(entry: CorpusEntry, opts: ScenarioRunOptions, how: SeededCall = {}): Promise<{ setup: TurnRun; runs: TurnRun[] }> {
  // Seed before the greeting so the setup trace record already reports the placeholder slots
  // as filled; otherwise summarize() credits the entry's one utterance with filling them.
  // One book of business per entry: what the entry's turn reads or files is its own.
  // A seeded call happens at the seed's moment, where the app gives one (App.testing.seed.now: hours read it).
  const seededAt = getApp(defaultAppId()).testing?.seed?.now;
  const o = { ...opts, tools: opts.tools ?? demoTools(), ...(seededAt !== undefined ? { now: () => Date.parse(seededAt), todayIso: dateAt(Date.parse(seededAt)) } : {}) };
  const fresh = startSession(entry.id, nowOf(o)(), entry.as);
  // A call in another language is seeded in it, so the prompt the seed leaves is that language's.
  if (how.locale !== undefined) {
    const app = appOf(fresh);
    if (app.locales) fresh.locale = matchLocale(app, how.locale) ?? app.locales.default;
  }
  // A tool that waits on a system makes the seed again once its reply is in, from the fresh session each time.
  const { value: start } = await untilReplied((toolMemo) => {
    const s = cloneSession(fresh);
    return how.seed ? how.seed(s, { ...o, toolMemo }) : seedCorpusSession(s, entry, { ...o, toolMemo });
  }, appOf(fresh).waiting?.timeoutMs);
  const asked = how.seed === undefined && entry.context === 'no_form' && !atGreetingOffer(entry, appOf(start)) && !atCallerMatch(entry, appOf(start)) && !atTextConsent(entry, appOf(start)) ? null : seededPrompt(start);
  const turn = opts.turn ?? runTurn;
  // The call data a seeded call comes with (App.testing.seed.callData); none for an app whose seed names none.
  const setup = await turn(start, withCallData(startEvent({}, how.locale), appOf(start).testing?.seed?.callData), o);
  // The greeting's own bookkeeping moves the prompt to the greeting, so put back the one the seed
  // left the caller answering. Only the prompt: seeding again would read a summary a second time,
  // and a summary hook that remembers what the caller heard (FormDef.onSummaryRead) would then read the
  // short re-read instead of the summary the entry answers.
  let session = setup.result.session;
  if (asked) Object.assign(session, asked);
  if (how.events === undefined) return { setup, runs: [await turn(session, saidEvent(session, entry.text), o)] };
  const runs: TurnRun[] = [];
  for (const event of how.events(session)) {
    if (session.ended) break;
    const run = await turn(session, event, o);
    const followed = await followEffects(run, o);
    runs.push(run, ...followed);
    session = (followed.at(-1) ?? run).result.session;
  }
  return { setup, runs };
}

/**
 * `serviceDown` is not a turn: it makes the next service effect answer as though the service did not
 * (serviceResultEvent(service, null)), as a timeout or an error would. `signIn` (a subject's id) is the web
 * visitor signing in through the portal: the server's `auth.signed_in` event, at the level a sign-in proves (identity.yaml's `signIn`).
 */
export type ScenarioStep = { say: string; fail?: boolean; partial?: boolean } | { dtmf: string } | { silence: true } | { serviceDown: true } | { signIn: string };

export interface ScenarioExpectation {
  decision: string;
  promptId?: string;
  reason?: string;
  form?: string | null;
  slots?: Partial<Record<SlotId, string>>;
  /** substring the last turn's spoken text must contain (after a report is filed, the depot agent's answer is the last turn) */
  text?: string;
  principalLevel?: number;
  /** the last gate decision on the scenario, as "tool:VERDICT", or null for none */
  gate?: string | null;
  /**
   * The last turn's transfer (app.yaml's transfer, core/transfer.ts): the target's variable, and, where
   * given, exactly the headers and the chat data it sends. Absent: not checked.
   */
  transfer?: ScenarioTransfer;
}

/** A scripted call's expected transfer: the variable the target is in, and exactly what goes with it where given. */
export interface ScenarioTransfer {
  target: string;
  headers?: Record<string, string>;
  data?: Record<string, string>;
}

export interface Scenario {
  id: string;
  /** A delegate id the app lists (e.g. "taylor", "morgan"): the scenario is a delegate's chat signed in as them, not a call. "web" is the subjects' web chat, anonymous until a `signIn` step. */
  as?: string;
  /**
   * The language the call or chat asks to start in (a language tag, e.g. "es"), as a channel's start
   * asks for one (a phone number's locale, a chat's `start.locale`): the session speaks the app's
   * matching locale (core/locale.ts matchLocale), its default where it has none. Without it the
   * scenario starts in the app's default, as it always has.
   */
  locale?: string;
  /**
   * The number the call comes from, as a carrier sends it (e.g. "+15555550142"; a withheld one as
   * the carrier writes it, or a SIP address): the start event carries it (SessionStart.callerNumber),
   * the call's data for every app. Without it, and on a chat, the call has no number, as it always has.
   */
  callerNumber?: string;
  /**
   * The caller withheld their number and the carrier sent it anyway, marked so (Telnyx's marks: the
   * start event's callerPrivacy `withheld`), with `callerNumber` the number it sent. Default false.
   */
  callerWithheld?: boolean;
  /** The STIR/SHAKEN attestation the carrier gave the number (SessionStart.callerAttestation), as it writes it ("A"). */
  callerAttestation?: string;
  /**
   * The number the call is to (e.g. "+15555550100"): the start event carries it
   * (SessionStart.calledNumber), the call's data for every app, and a
   * call to a number app.yaml's voice.numbers lists starts in its locale, as on the phone (unless
   * `locale` names one). Without it, and on a chat, the call has none.
   */
  calledNumber?: string;
  /**
   * The data the call or chat comes with, by the app's callData keys (e.g. `{ "queue": "priority" }`),
   * as the channel reads them from its source (a custom parameter, a setup or webhook field, a chat's
   * context): the start event carries them (SessionStart.callData), and the session keeps the keys the
   * app names. Without it, the call came with none, as it always has.
   */
  callData?: Record<string, string>;
  /**
   * The moment the call happens, an ISO date and time with its offset (e.g. "2026-10-12T10:00:00-04:00"):
   * every turn of the scripted call reads this clock (TurnContext.nowMs), so business hours (app.yaml's
   * hours) are judged at it. Without it, the run's own clock, as it always has.
   */
  now?: string;
  /**
   * The call's date (YYYY-MM-DD), what date slots and rules read as today. Without it, with `now`, the
   * date at `now` in the app's hours' time zone (app.yaml's hours), else in UTC, as a server takes its
   * date in its own; without either, the run's.
   */
  todayIso?: string;
  /**
   * The environment the call's `called` conditions and app.yaml's voice.numbers read (`env.<NAME>`,
   * TurnContext.env), by variable (e.g. `{ "SPANISH_LINE": "+15555550188" }`). Without it, the run's own
   * (the process's, in a regress).
   */
  env?: Record<string, string>;
  steps: ScenarioStep[];
  expect: ScenarioExpectation;
  /**
   * How long each of the call's generated lines takes to word, ms, before the renderer answers (a fake, or
   * a cassette replayed): a slow model, for a knowledge answer's hold line (render/turn.ts), as a call
   * against RENDER_TIMEOUT_MS, RENDER_CHECK_TIMEOUT_MS and RENDER_ANSWER_TIMEOUT_MS has it. Without it, the
   * renderer answers at once, as it always has. Nothing for a run without a renderer.
   */
  renderDelayMs?: number;
  /**
   * Under a real model (`--client recorded` or `jev`), `decidedGate` and `verdict` may differ from
   * the stub baseline without failing the run: the same decision reached by a different gate (the
   * diff still prints it, marked allowed). The scenario's own expectation and every other baseline
   * field are checked as usual, and the stub run is held to the baseline exactly.
   */
  cosmeticDrift?: boolean;
  /**
   * A documented gap between this call's expectation and what a real decision model does on it, as a
   * corpus line's (CorpusEntry.knownGap): the reason, and the end outcome the model is known to give
   * (the baseline's end outcome with these fields overlaid; `outcomes`, a few such, any one allowed).
   * A run against a real model's answers (jev, record, recorded) reports that exact end as allowed: the
   * call is not counted as failing, and each difference prints `(allowed: knownGap: <reason>)`; the
   * misses of the call's own expectation must follow from the pin (scenarioGap.ts scenarioShowsGap).
   * Any other difference still fails, and a run whose end is the baseline's again says `knownGap now
   * matches`. A stub run ignores it: the call is held to its expectation and the baseline exactly.
   */
  knownGap?: KnownGap;
}

export interface ScenarioRun {
  outcome: Outcome;
  runs: TurnRun[];
  /** For each of `runs`, the index in the scenario's steps of the step that made it: -1 for the opening turn. */
  stepOf: number[];
  pass: boolean;
  mismatches: string[];
}

/**
 * The side effects a turn left for its runner, performed as the server performs them, each as the
 * turn it makes: a downstream service's request is answered by the app's stand-in for it
 * (App.testing.serviceAnswers; serviceResultEvent(service, null) when `down`, or when the app has none, as
 * a timeout or an error would). Run straight after the turn that produced them, since every caller
 * turn is ignored until the service's answer arrives. Returns the turns run, in order; the last one's
 * session is the call's.
 */
export async function followEffects(run: TurnRun, opts: ScenarioRunOptions, down = false): Promise<TurnRun[]> {
  const runs: TurnRun[] = [];
  let session = run.result.session;
  for (const effect of run.result.effects) {
    if (effect.kind !== 'service') continue;
    const answer = appOf(session).testing?.serviceAnswers?.[effect.service];
    const answered = down || !answer ? null : answer(effect.params);
    const event = serviceResultEvent(effect.service, answered !== null && opts.serviceReply ? opts.serviceReply(effect.service, answered) : answered);
    // The answer's audit row is masked as the effect's params were recorded, as the server does (server/services.ts).
    carryScrub(effect, event);
    const next = await (opts.turn ?? runTurn)(session, event, opts);
    runs.push(next);
    session = next.result.session;
  }
  return runs;
}

/** The date at `ms` where the call is: in the app's hours' time zone (app.yaml's hours), else UTC. */
function dateAt(ms: number): string {
  return localDateIso(ms, getApp(defaultAppId()).hours?.timezone ?? 'UTC');
}

/**
 * The locale a scripted call to `called` starts in by the app's voice.numbers (core/numberLocales.ts),
 * each env.<NAME> read from `env`; undefined for no number, an app without locales, or a number not
 * listed, so the call starts in the default as it always has.
 */
function numberLocale(app: App, called: string | undefined, env: RunOptions['env']): string | undefined {
  if (called === undefined || !app.locales || app.voice?.numbers === undefined) return undefined;
  const { numbers } = numberLocalesOf(app.voice, (name) => (env !== undefined && Object.hasOwn(env, name) ? env[name] : undefined));
  return localeOfNumber(numbers, called);
}

export async function runScenario(scenario: Scenario, opts: ScenarioRunOptions): Promise<ScenarioRun> {
  let failNext = false;
  const client: JevClient = {
    ask: (req) => (failNext ? Promise.reject(new JevClientError('injected timeout')) : opts.client.ask(req)),
  };
  // One book of business per scenario, so a record created on one turn is there on the next. A scenario
  // with its own clock or environment runs every turn on them.
  const at = scenario.now === undefined ? undefined : Date.parse(scenario.now);
  const today = scenario.todayIso ?? (at !== undefined ? dateAt(at) : undefined);
  // A slow renderer, where the call says so (renderDelayMs).
  const renderer = opts.renderer && scenario.renderDelayMs !== undefined && scenario.renderDelayMs > 0 ? { ...opts.renderer, client: slowRenderClient(opts.renderer.client, scenario.renderDelayMs) } : undefined;
  const o = { ...opts, client, tools: opts.tools ?? demoTools(), ...(at !== undefined ? { now: () => at } : {}), ...(today !== undefined ? { todayIso: today } : {}), ...(scenario.env !== undefined ? { env: { ...scenario.env } } : {}), ...(renderer !== undefined ? { renderer } : {}) };
  const runs: TurnRun[] = [];
  const stepOf: number[] = [];
  let session = startSession(scenario.id, nowOf(o)(), scenario.as);
  const turn = opts.turn ?? runTurn;
  // A call's numbers only: a chat has none (SessionStart.callerNumber, calledNumber). A call to a number
  // app.yaml's voice.numbers lists starts in its locale, as the server's start document asks
  // (server/http.ts startLocale), its env.<NAME> read from the call's env; a scenario's own `locale` wins.
  const locale = scenario.locale ?? (session.caps.speech ? numberLocale(appOf(session), scenario.calledNumber, o.env) : undefined);
  const speech = session.caps.speech;
  const calling = withCallerAttestation(withCallerWithheld(withCallerNumber(startEvent({}, locale), speech ? scenario.callerNumber : undefined), speech && scenario.callerWithheld === true), speech ? scenario.callerAttestation : undefined);
  const start = withCallData(withCalledNumber(calling, speech ? scenario.calledNumber : undefined), scenario.callData);
  const setup = await turn(session, start, o);
  runs.push(setup);
  stepOf.push(-1);
  session = setup.result.session;
  let last = setup;
  let serviceDown = false;
  for (const [index, step] of scenario.steps.entries()) {
    if (session.ended) break;
    if ('serviceDown' in step) {
      serviceDown = true;
      continue;
    }
    // A partial step is a non-final ASR result, which the complete gate may hold on.
    const events: SessionEvent[] = 'dtmf' in step ? keyEvents(step.dtmf)
      : 'silence' in step ? [silenceEvent()]
      : 'signIn' in step ? [signedInEvent(signedInSubject(scenario.id, step.signIn))]
      : [saidEvent(session, step.say, step.partial !== true)];
    failNext = 'say' in step && step.fail === true;
    for (const event of events) {
      last = await turn(session, event, o);
      runs.push(last);
      stepOf.push(index);
      failNext = false;
      // A scenario is synchronous, so a downstream service's answer is the very next turn.
      const followed = await followEffects(last, o, serviceDown);
      if (followed.length > 0) serviceDown = false;
      runs.push(...followed);
      stepOf.push(...followed.map(() => index));
      last = followed.at(-1) ?? last;
      session = last.result.session;
      if (session.ended) break;
    }
    failNext = false;
  }
  const outcome = outcomeOf(scenario.id, last.result, runs.flatMap((r) => r.result.gateEvents));
  const mismatches = checkExpectation(outcome, scenario.expect, spokenText(last.result), last.result.actions.find((a) => a.type === 'transfer'));
  return { outcome, runs, stepOf, pass: mismatches.length === 0, mismatches };
}

/**
 * `client` answering each line `ms` later (a scripted call's renderDelayMs): the line's request waits, and
 * is given up as a request on a call is (its signal aborted) when the turn stops waiting for it.
 */
export function slowRenderClient(client: RenderClient, ms: number): RenderClient {
  return {
    model: client.model,
    async generate(req, signal) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        signal.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new RenderClientError('aborted'));
        });
      });
      return client.generate(req, signal);
    },
  };
}

/** Everything the caller hears this turn, ack phrases included. */
export function spokenText(result: TurnResult): string {
  return sayText(result.actions);
}

export function checkExpectation(outcome: Outcome, expected: ScenarioExpectation, spoken: string, transfer?: Action): string[] {
  const out: string[] = [];
  if (outcome.decision !== expected.decision) out.push(`decision: expected ${expected.decision}, got ${outcome.decision}`);
  if (expected.promptId !== undefined && outcome.promptId !== expected.promptId) out.push(`promptId: expected ${expected.promptId}, got ${outcome.promptId}`);
  if (expected.reason !== undefined && outcome.reason !== expected.reason) out.push(`reason: expected ${expected.reason}, got ${outcome.reason}`);
  if (expected.form !== undefined && outcome.form !== expected.form) out.push(`form: expected ${expected.form}, got ${outcome.form}`);
  for (const [slot, value] of Object.entries(expected.slots ?? {})) {
    if (outcome.slots[slot as SlotId] !== value) out.push(`slot ${slot}: expected ${value}, got ${outcome.slots[slot as SlotId]}`);
  }
  if (expected.principalLevel !== undefined && outcome.principalLevel !== expected.principalLevel) {
    out.push(`principalLevel: expected ${expected.principalLevel}, got ${outcome.principalLevel}`);
  }
  if (expected.gate !== undefined && outcome.gate !== expected.gate) out.push(`gate: expected ${expected.gate}, got ${outcome.gate}`);
  if (expected.text !== undefined && !spoken.includes(expected.text)) {
    out.push(`text: expected to contain ${JSON.stringify(expected.text)}, got ${JSON.stringify(spoken)}`);
  }
  if (expected.transfer !== undefined) {
    const t = transfer?.type === 'transfer' ? transfer : undefined;
    const got = (v: unknown): string => JSON.stringify(v ?? null);
    if (t?.target !== expected.transfer.target) out.push(`transfer target: expected ${expected.transfer.target}, got ${t?.target ?? 'no transfer target'}`);
    if (expected.transfer.headers !== undefined && got(t?.headers) !== got(expected.transfer.headers)) out.push(`transfer headers: expected ${got(expected.transfer.headers)}, got ${got(t?.headers)}`);
    if (expected.transfer.data !== undefined && got(t?.data) !== got(expected.transfer.data)) out.push(`transfer data: expected ${got(expected.transfer.data)}, got ${got(t?.data)}`);
  }
  return out;
}

/** An object of strings (a scenario's callData). */
function isStringMap(v: unknown): v is Record<string, string> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string');
}

function isValidScenario(s: unknown): s is Scenario {
  return (
    typeof s === 'object' && s !== null &&
    typeof (s as Scenario).id === 'string' &&
    Array.isArray((s as Scenario).steps) &&
    typeof (s as Scenario).expect === 'object' && (s as Scenario).expect !== null &&
    ((s as Scenario).locale === undefined || (typeof (s as Scenario).locale === 'string' && (s as Scenario).locale !== '')) &&
    ((s as Scenario).callerNumber === undefined || typeof (s as Scenario).callerNumber === 'string') &&
    ((s as Scenario).callerWithheld === undefined || typeof (s as Scenario).callerWithheld === 'boolean') &&
    ((s as Scenario).callerAttestation === undefined || typeof (s as Scenario).callerAttestation === 'string') &&
    ((s as Scenario).calledNumber === undefined || typeof (s as Scenario).calledNumber === 'string') &&
    ((s as Scenario).callData === undefined || isStringMap((s as Scenario).callData)) &&
    ((s as Scenario).now === undefined || (typeof (s as Scenario).now === 'string' && Number.isFinite(Date.parse((s as Scenario).now!)))) &&
    ((s as Scenario).todayIso === undefined || (typeof (s as Scenario).todayIso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test((s as Scenario).todayIso!))) &&
    ((s as Scenario).env === undefined || isStringMap((s as Scenario).env)) &&
    ((s as Scenario).renderDelayMs === undefined || (Number.isInteger((s as Scenario).renderDelayMs) && (s as Scenario).renderDelayMs! >= 0 && (s as Scenario).renderDelayMs! <= 30_000)) &&
    ((s as Scenario).as === undefined || (s as Scenario).as === WEB_VISITOR || signedInDelegate(String((s as Scenario).as)) !== null)
  );
}

export function loadScenarios(dir: string): Scenario[] {
  const seen = new Set<string>();
  const out: Scenario[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    if (!Array.isArray(parsed)) throw new Error(`scenarios ${file}: expected an array`);
    for (const [index, s] of parsed.entries()) {
      if (!isValidScenario(s)) throw new Error(`scenarios ${file}: entry ${index} is missing id, steps, or expect, has a locale that is not a language tag (a non-empty string), a callerNumber or calledNumber that is not a string, a callData or env that is not an object of strings, a now that is not a date and time, a todayIso that is not YYYY-MM-DD, a renderDelayMs that is not a whole number of ms from 0 to 30000, or names no ${identityOf(getApp(defaultAppId())).delegateKind ?? 'delegate'} in as`);
      if (seen.has(s.id)) throw new Error(`scenario ${s.id}: duplicate id`);
      const [gapProblem] = scenarioGapProblems(s);
      if (gapProblem !== undefined) throw new Error(`scenarios ${file}: ${gapProblem.message}`);
      seen.add(s.id);
      out.push(s);
    }
  }
  return out;
}

/**
 * Every spoken step of the scripted calls whose words are no corpus line's text, as
 * `<scenario id>: <the words>`. The stub answers only from the corpus, and answers words it has no
 * line for with nothing (a missed turn), so such a step would run as a miss the call never meant.
 */
export function unanswerableSteps(corpus: readonly CorpusEntry[], scenarios: readonly Scenario[]): string[] {
  const texts = new Set(corpus.map((e) => normalizeText(e.text)));
  return scenarios.flatMap((s) => s.steps.flatMap((step) => ('say' in step && !texts.has(normalizeText(step.say)) ? [`${s.id}: ${step.say}`] : [])));
}
