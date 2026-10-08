import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appTurnContext, renderSummary, summaryVars, type TurnContext, type TurnResult } from '../core/turn';
import { emptySlot, missingSlots, newSession, setForm, type Session } from '../core/session';
import { callTool, ensureEntry, newTurnOut, type GateEvent } from '../core/lifecycle';
import { atCallerOffer, confirmForm, contextForm, normalizeText, offerTransfer, promptsIdentity, type CorpusEntry, type PinnedOutcome } from '../jev/corpus';
import { JevClientError, type JevClient } from '../jev/types';
import { promptText } from '../prompts/render';
import { prompt } from '../core/decision';
import { appOf, defaultAppId, getApp } from '../core/app/registry';
import { formOf, identityOf } from '../core/app/lookup';
import { delegateProblem, subjectProblem } from '../core/app/principals';
import type { App, SlotId } from '../core/app/types';
import { serviceResultEvent, keyEvents, signedInEvent, silenceEvent, speechEvent, startEvent, textEvent, withCallerNumber, type SessionEvent } from '../channel/events';
import { lastFour, usesCallerNumber } from '../core/callerNumber';
import { sayText } from '../channel/actions';
import { ANONYMOUS } from '../gate/principal';
import type { Principal } from '../gate/types';
import { carryScrub } from '../core/recording';
export { runTurn, nowOf, type RunOptions, type TurnRun } from '../run/turn';
import { runTurn, nowOf, type RunOptions, type TurnRun } from '../run/turn';
import { demoTools } from '../core/tools';
import { VOICE_RELAY, WEB_CHAT } from '../channel/caps';

/** How a runner runs one turn: runTurn, unless a test runs each one another way (testing/sessionRoundTrip.ts). */
export type TurnRunner = typeof runTurn;

/** A run's options, and how it runs each turn (runTurn when `turn` is absent, as every run but a test's). */
export interface ScenarioRunOptions extends RunOptions {
  readonly turn?: TurnRunner;
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
export type SeedOptions = Pick<RunOptions, 'thresholds' | 'todayIso' | 'tools'>;

type Seed = NonNullable<NonNullable<App['testing']>['seed']>;

function fillPlaceholder(seed: Seed, session: Session, id: SlotId, confirmed: boolean): void {
  const placeholder = Object.hasOwn(seed.placeholders, id) ? seed.placeholders[id] : undefined;
  if (!placeholder) throw new Error(`no placeholder value for slot "${id}"`);
  session.slots[id] = { ...emptySlot(), value: placeholder.value, display: placeholder.display, confirmed };
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
  if (entry.context === 'no_form') return session;
  const app = appOf(session);
  const seed = app.testing?.seed;
  if (!seed) throw new Error(`corpus ${entry.id}: app "${app.id}" seeds no ${entry.context} context (App.testing.seed)`);
  const tc: TurnContext = appTurnContext(app, { nowMs: 0, todayIso: opts.todayIso, thresholds: opts.thresholds, tools: opts.tools ?? demoTools() });
  const identity = promptsIdentity(entry, app);
  session.principal = identity ? ANONYMOUS : seed.caller();
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
    // the app's placeholder for it as the number, and the slot is still empty: the entry answers the offer.
    const slot = entry.prompted;
    const placeholder = Object.hasOwn(seed.placeholders, slot) ? seed.placeholders[slot] : undefined;
    if (!placeholder) throw new Error(`no placeholder value for slot "${slot}"`);
    session.pendingConfirmation = { target: 'slot', slot, value: placeholder.value, display: placeholder.display, offered: true };
    session.callerOffered = [slot];
    session.promptedFor = slot;
    session.lastPromptId = `offer_${slot}`;
    session.lastPromptText = promptText(app, `offer_${slot}`, { last4: lastFour(placeholder.value) }, session.locale);
    session.lastPromptOptions = ['yes', 'no'];
    return session;
  }
  const slot = identity ? entry.prompted! : stopAt ?? null;
  session.promptedFor = slot;
  session.lastPromptId = slot ? `ask_${slot}` : null;
  session.lastPromptText = slot ? promptText(app, `ask_${slot}`, {}, session.locale) : '';
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
  // Seed before the greeting so the setup trace record already reports the placeholder slots
  // as filled; otherwise summarize() credits the entry's one utterance with filling them.
  // One book of business per entry: what the entry's turn reads or files is its own.
  const o = { ...opts, tools: opts.tools ?? demoTools() };
  const start = seedCorpusSession(startSession(entry.id, nowOf(opts)(), entry.as), entry, o);
  const asked = entry.context === 'no_form' ? null : seededPrompt(start);
  const turn = opts.turn ?? runTurn;
  const setup = await turn(start, startEvent(), o);
  // The greeting's own bookkeeping moves the prompt to the greeting, so put back the one the seed
  // left the caller answering. Only the prompt: seeding again would read a summary a second time,
  // and a summary hook that remembers what the caller heard (FormDef.onSummaryRead) would then read the
  // short re-read instead of the summary the entry answers.
  const session = setup.result.session;
  if (asked) Object.assign(session, asked);
  const run = await turn(session, saidEvent(session, entry.text), o);
  // The setup run is returned as well as traced: a summary that leaves it out would read
  // the seeded placeholders as slots this one utterance filled.
  return { outcome: outcomeOf(entry.id, run.result), run, setup };
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
   * the carrier writes it): the start event carries it (SessionStart.callerNumber) when the app has a
   * slot that offers the caller's number (SlotSpec.callerNumber). Without it, and on a chat, the
   * call has no number, as it always has.
   */
  callerNumber?: string;
  steps: ScenarioStep[];
  expect: ScenarioExpectation;
  /**
   * Under a real model (`--client recorded` or `jev`), `decidedGate` and `verdict` may differ from
   * the stub baseline without failing the run: the same decision reached by a different gate (the
   * diff still prints it, marked allowed). The scenario's own expectation and every other baseline
   * field are checked as usual, and the stub run is held to the baseline exactly.
   */
  cosmeticDrift?: boolean;
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
    const event = serviceResultEvent(effect.service, down || !answer ? null : answer(effect.params));
    // The answer's audit row is masked as the effect's params were recorded, as the server does (server/services.ts).
    carryScrub(effect, event);
    const next = await (opts.turn ?? runTurn)(session, event, opts);
    runs.push(next);
    session = next.result.session;
  }
  return runs;
}

export async function runScenario(scenario: Scenario, opts: ScenarioRunOptions): Promise<ScenarioRun> {
  let failNext = false;
  const client: JevClient = {
    ask: (req) => (failNext ? Promise.reject(new JevClientError('injected timeout')) : opts.client.ask(req)),
  };
  // One book of business per scenario, so a record created on one turn is there on the next.
  const o = { ...opts, client, tools: opts.tools ?? demoTools() };
  const runs: TurnRun[] = [];
  const stepOf: number[] = [];
  let session = startSession(scenario.id, nowOf(opts)(), scenario.as);
  const turn = opts.turn ?? runTurn;
  // A call's number only: a chat has none (SessionStart.callerNumber).
  const start = withCallerNumber(startEvent({}, scenario.locale), session.caps.speech && usesCallerNumber(appOf(session)) ? scenario.callerNumber : undefined);
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
  const mismatches = checkExpectation(outcome, scenario.expect, spokenText(last.result));
  return { outcome, runs, stepOf, pass: mismatches.length === 0, mismatches };
}

/** Everything the caller hears this turn, ack phrases included. */
export function spokenText(result: TurnResult): string {
  return sayText(result.actions);
}

export function checkExpectation(outcome: Outcome, expected: ScenarioExpectation, spoken: string): string[] {
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
  return out;
}

function isValidScenario(s: unknown): s is Scenario {
  return (
    typeof s === 'object' && s !== null &&
    typeof (s as Scenario).id === 'string' &&
    Array.isArray((s as Scenario).steps) &&
    typeof (s as Scenario).expect === 'object' && (s as Scenario).expect !== null &&
    ((s as Scenario).locale === undefined || (typeof (s as Scenario).locale === 'string' && (s as Scenario).locale !== '')) &&
    ((s as Scenario).callerNumber === undefined || typeof (s as Scenario).callerNumber === 'string') &&
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
      if (!isValidScenario(s)) throw new Error(`scenarios ${file}: entry ${index} is missing id, steps, or expect, has a locale that is not a language tag (a non-empty string), a callerNumber that is not a string, or names no ${identityOf(getApp(defaultAppId())).delegateKind ?? 'delegate'} in as`);
      if (seen.has(s.id)) throw new Error(`scenario ${s.id}: duplicate id`);
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
