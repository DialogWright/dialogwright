import type { SessionEvent } from '../channel/events';
import { maskedConversation } from '../agent/history';
import { fieldValueSent } from '../agent/prompt';
import { NO_ACTION, PRICE_LINE, PRICE_QUESTION, type AgentActionChoice, type AgentAnswer, type AgentAppField, type AgentContext, type AgentFailure, type AgentField, type AgentResult, type AgentUtterance, type SeenResult } from '../agent/types';
import { isAnonymous } from '../gate/types';
import { isChoice, isNoul, noulValue, type AnswerMap } from '../jev/types';
import { spokenText } from '../prompts/render';
import type { BuiltSlotSpec, ValueCheck } from '../slots/types';
import { isFormIntent } from './app/intents';
import { formOf } from './app/lookup';
import { appOf } from './app/registry';
import type { App, FormId, SlotId } from './app/types';
import { askSlot, handoff, prompt, type Decision, type PromptDecision } from './decision';
import type { Ack, FillEvent } from './fia';
import type { Verdict } from './gates';
import { atLeast, type Thresholds } from './thresholds';
import { localeOf, slotLocaleOf } from './locale';
import { emptySlot, setForm, type PendingConfirmation, type Session } from './session';
import { callTool } from './lifecycle';
import { namedPart, openPart } from './replyShape';
import type { SlotContext } from './slots/types';
import { resolve, type TurnContext, type TurnError, type TurnIO, type TurnResult } from './turn';
import type { ScreenResult } from './screen';
import type { RenderLine } from '../render/types';

/**
 * The agent turn: a turn of an app in agent mode (App.mode `agent`; docs/designs/2026-11-08-agent-mode.md,
 * "A turn"). The agent model's answer arrives as one more input (TurnContext.agent), asked beside the
 * decision model by the runner (run/turn.ts); this reads no clock and calls no model. Everything that is
 * not the caller's words (the call's start, a key, silence, a service's answer) is the core's as in a
 * scripted app, and so is every turn-level reading of the words (core/turn.ts resolveTurn): the screen,
 * a failed request, the gates. Where the gates settle the turn on their own (side speech, a held
 * partial, words not made out, a person asked for, a frustrated caller's handoff, a repeat, the caller
 * done) or the turn answers a question the core asked itself (the offer of the caller's number, the offer
 * of a person, a request's confirmation), the agent's answer is dropped and the turn is the scripted one.
 * Otherwise, in this order:
 *
 * 1. **At a read-back**: a failed answer reads the read-back again, uncounted, and does not complete here (a
 *    yes may carry a correction no one read): the runner reads the turn again the scripted way, the decision
 *    model asked the form's own questions, and decides it from them (run/turn.ts scriptedReading, call 38);
 *    this is what is said where that reading does not come in time. The second failure in a row hands off. Otherwise the answer's
 *    values are corrections, checked and stored: a value that changes reads the read-back again, a refused
 *    one walks its slot's ladder. With none, the decision model's yes completes the form (its
 *    engine-written `complete` hook calls its `then` through the gate), whatever the answer proposed; a
 *    `callback` opens the person form (checked with the caller first where the decision model read no
 *    person asked for, step 6); a no asks what to change (`ask_change`) and a second no reads it
 *    again on its ladder; a question answered from the facts is an aside, the reply and then the read-back
 *    again as it stands, uncounted; anything else (words neither a yes nor a no) asks the read-back again
 *    on its ladder, counted, the reply before it as an aside (after "What should I change?", that
 *    question with the reply in its place), so words that settle nothing reach the keypad and a person.
 * 2. **A form opened**: with none open, the request the decision model read opens its form; failing that,
 *    the form the answer's values belong to (the caller's own forms only: one only a recognized caller
 *    may open is never chosen for anyone else). A form only a recognized caller may open, asked for by
 *    anyone else, says its line and opens the form it offers instead (FormDef.recognizedOnly).
 * 3. **Values**: each checked by its field's slot type (BuiltSlotSpec.check), its words held to this
 *    turn's words. An accepted value is stored with its `shown` (`by: 'agent'`); a refused one is dropped,
 *    counts an attempt on its slot and walks the slot's own ladder (its retry line, then its
 *    onMaxAttempts, the keypad or a person), as a scripted fill that misses does.
 * 3a. **What the model may see** (business.yaml's `sees`): an accepted value that fills a field whose tool
 *    the model sees, with a value its result was not yet shown for, runs that tool through the gate (as an
 *    async tool waits, core/toolWait.ts). Its result, once it passes the tool's reply check (a closed form,
 *    which pnpm check holds it to), is kept (Session.agent.seen), only the fields the check names, and the
 *    turn asks for the model to be asked again with it before anything is said (TurnResult.agentAgain): the
 *    runner asks it within what is left of the turn's budget and resolves the turn again from the start with
 *    that answer (TurnContext.agentSeen), which asks no more. So a full window is met with the next free one
 *    before the read-back. The turn as it first stands (its values, its fixed question or read-back, the
 *    reply not said: it was written without the result) is what is said where the second answer does not
 *    come. A reply of the second answer is not said where it gave a value whose result the model was not
 *    shown. A result that fails its check ends the turn with a person (`result-unchecked`), as for any tool.
 * 4. **The read-back** once every required field is filled (`submit` before that is ignored).
 * 5. **The reply**, said as an agent line (PromptDecision.agent) in place of its fallback, the next empty
 *    field's question, or with no form the open question; a reply that asks nothing is said before that
 *    question instead. Where the core's own next step is not a plain question (the offer of the caller's
 *    number, a slot's own read-back, the identity a form needs), that step is said. A reply that could
 *    contradict what the core did is never said: where a value was refused or named no field of the form,
 *    the action was not taken, a form only a recognized caller may open said its line, or the form open is
 *    not the one the reply was written for, the fixed question is said alone.
 * 6. **Actions**: the model may propose `submit` and `callback` only (or none). `callback` opens the person
 *    form (App.personForm) where the decision model read the turn as a request for it too (its verdict
 *    routes there); where it read some sign of one, short of that (personSupported: at the bar a scripted
 *    app checks an unsure request at), it is checked with the caller first ("Just to check, do you want to
 *    speak with someone?": the `agent` intent's explicit check), its values kept: a yes opens the person
 *    form, a no goes back to the form where it stood; where it read none, the callback is not taken, and its
 *    reply is not said (a recording: the model read "I'll have the owner call you back to confirm" as a
 *    callback, mid-request, the decision model reading wantsHuman 0.02).
 *    A form's `then` tools are the engine's, called only by the yes at its read-back; the model never runs a tool.
 * 6a. **The price line** (business.yaml's `prices.say`), said whole before the turn's own line in place of the
 *    reply, where the decision model reads the caller asking what something costs (its `asksPrice` question,
 *    at AGENT_PRICE_ASKED or above), whether or not the answer named it; named where it reads under that,
 *    neither the line nor the reply is said, only the turn's own fixed step; named with no reading, the line
 *    is said (lineDue; the agent-mode design, call 43 and its amendment).
 *    At a read-back it is an aside, under the same bound as any other.
 * 7. **A failed answer** (a timeout, an answer not in its shape, an error) says the fallback, and the trace
 *    says why (`fallback`); at a read-back the turn is read again the scripted way (run/turn.ts
 *    scriptedReading). The second such turn in a row hands off: the handoff line, then the person form,
 *    the rest of the call run as a scripted app (core/turn.ts handoffToPersonForm). A call with
 *    no agent client (no key) runs as a scripted app from that turn for the rest of the call
 *    (scriptedFromNow): one begun so, and one resumed on a server without the key.
 *
 * Speech heard over a line the caller could not interrupt whose answer understood nothing (no value
 * accepted or refused, no action, nothing from the facts) is a miss, and is set aside as in a scripted app
 * (core/turn.ts overLineMiss).
 */

/** The agent's answer as a turn used it (TurnResult.agent, TraceRecord.agent). */
export interface AgentTurnRecord {
  /** How long the answer took, ms. */
  ms: number;
  /** `used`: the turn read it; `dropped`: the turn was decided without it (`dropped` says by what); `failed`: there was no answer to read (`fallback` says why). */
  use: 'used' | 'dropped' | 'failed';
  /** What decided the turn without the answer: the gates' verdict, or what the call was at (a pending offer, a screen). */
  dropped?: string;
  /** Why there was no answer to read (agentFallback): the fallback was said. */
  fallback?: AgentFailure;
  /** The failure's detail, safe to record (no key, no words of the answer). */
  detail?: string;
  /**
   * Each value the answer gave: the value proposed and the caller's words it cited, and what its check made
   * of it; an accepted one with its `shown`. Each masked in the trace as the records mask its field's slot.
   */
  values: { field: string; slot?: SlotId; value: string; words: string; outcome: AgentValueOutcome; shown?: string }[];
  /** The reply the answer gave, said or not (`replySaid`); masked in the trace as a line said is. */
  reply?: string;
  /** The action the answer proposed (`none` where it proposed none, or there was no answer). */
  action: string;
  /**
   * What the turn did with it: `taken`; `checked`, a `callback` the decision model read only some sign of a
   * person asked for on, asked of the caller first ("do you want to speak with someone?"); or `ignored` (a
   * `submit` with a field empty, a `callback` the decision model read no sign of or against a yes at the
   * read-back, an action the turn had no use for).
   * Absent with no action.
   */
  actionOutcome?: 'taken' | 'checked' | 'ignored';
  /** Whether the answer said it answers from the facts. */
  fromFacts?: boolean;
  /** Whether the reply was said, as an agent line in place of its fallback or before it. */
  replySaid: boolean;
  /**
   * The fixed line said whole before the turn's line in place of the reply (the price line): the one the answer
   * named (AgentAnswer.fixedLine), or the price line the decision model read the caller asking for where the
   * answer named none (`priceAsked`). The reply was not said.
   */
  fixedLine?: string;
  /**
   * The decision model's reading of whether the caller asks what something costs (its `asksPrice` question), on
   * a turn of an app with a price line (the agent-mode design, call 43): `score`, the bar it was read against
   * (AGENT_PRICE_ASKED), and whether the answer named the price line. The line is said where the score reaches
   * the bar (and the form open allows it, `prices.forms`), named or not; under it, never, and where the answer
   * named it, nor is the reply (call 43's amendment). Absent where the decision model gave no reading: then a
   * line named is said (the safe outcome) and none named is not.
   */
  priceAsked?: { score: number; at: number; named: boolean };
  /**
   * The reply held to the facts (render/agentLine.ts): the agent line as said (`mode: generated`, with the
   * judge's reading) or replaced by its fixed line (`mode: fixed`, with why, the reply refused, and the
   * judge's reading where it was asked). Absent where no reply was said.
   */
  line?: RenderLine;
  /** The agent model's tokens and their cost, US dollars (the provider's own, else at the model's price); set by the runner. */
  usage?: { inputTokens: number; outputTokens: number };
  costUsd?: number;
  /**
   * The agent model asked again on this turn, with the results of the tools it sees (TurnResult.agentAgain),
   * set by the runner: the tools whose results it was shown, how long the second answer took, ms, and why
   * there was none where it failed (the turn then said what it first decided, its reply not said). This
   * record is then of the second answer where it came, and `ms` is both answers' time.
   */
  again?: { tools: string[]; ms: number; fallback?: AgentFailure; detail?: string };
  /**
   * The answer failed at a form's read-back, and the turn was read again the scripted way (run/turn.ts
   * scriptedReading, the agent-mode design's call 38): `read`, the decision model asked the form's own
   * questions and the turn decided from them (a yes completes, a correction is read back); `none`, no
   * reading came in the turn's budget, and the read-back was said again. Absent on every other turn.
   */
  scripted?: 'read' | 'none';
  /**
   * The text values accepted that are not the caller's words as cited, each as the drift judge read it
   * against them (run/turn.ts, render/agentLine.ts judgeTextValues; calls 40 and 45): held as given
   * (`value`), or not held (`before`: the judge refused it, failed or was late, so the field kept what it
   * held before, or none, and its question was asked again). Absent where none was judged.
   */
  textJudged?: { field: string; score?: number; refuseAt: number; held: 'value' | 'before' }[];
}

/**
 * What a value's check came to: accepted, refused by its slot type (ValueCheck's reason), `field`, naming no
 * field of the form it was given in, or `judged`, a text value the drift judge refused against the caller's
 * words (or did not read in time), never held (call 45).
 */
export type AgentValueOutcome = 'accepted' | Extract<ValueCheck, { ok: false }>['reason'] | 'field' | 'judged';

/**
 * The answer a turn reads when no agent client is set (a run with none, a server without the agent model's
 * key): no failure, but nothing understood, so each turn says its fixed question and nothing is counted.
 */
const NO_CLIENT_DETAIL = 'no agent client';
export const NO_AGENT_CLIENT: AgentResult = Object.freeze({ ok: false as const, reason: 'error' as const, detail: NO_CLIENT_DETAIL, ms: 0 });

/** Whether an answer is NO_AGENT_CLIENT's: no client was asked. */
export function noAgentClient(r: AgentResult): boolean {
  return !r.ok && r.reason === 'error' && r.detail === NO_CLIENT_DETAIL && r.ms === 0;
}

/** How many utterances of the conversation a session keeps for the agent model: the call's last forty. */
export const AGENT_CONVERSATION_KEPT = 40;

/** The agent action that reads the read-back, and the one that opens the person form. */
export const SUBMIT_ACTION = 'submit';
export const CALLBACK_ACTION = 'callback';

/**
 * Whether a turn asks the agent model: words, on a call of an app in agent mode that is taking them (not
 * over, not waiting on a service), with no question of the core's own pending other than a read-back (the
 * offer of the caller's number or of a person, a request's confirmation, are answered by the decision
 * model's yes or no alone).
 */
export function agentAsks(session: Session, event: SessionEvent, tc: Pick<TurnContext, 'duringService' | 'noAgentClient'>): boolean {
  if (event.type !== 'user.speech' && event.type !== 'user.text') return false;
  if (!agentLed(session) || tc.noAgentClient === true) return false;
  if (session.ended || session.pendingService !== null || tc.duringService === true) return false;
  const pc = session.pendingConfirmation;
  return pc === null || pc.target === 'form';
}

/**
 * Whether the session's turns are the agent's: an app in agent mode, on a call that began with an agent
 * client. A call that began with none (no key) runs as a scripted app for the whole call: the decision
 * model asks each field's own questions and fills it, as in any scripted form, and the read-back's yes,
 * with any correction in it, is the scripted one (Session.agent.scripted).
 */
export function agentLed(session: Session): boolean {
  const app = appOf(session);
  return app.mode === 'agent' && app.agent !== undefined && session.agent?.scripted !== true;
}

/**
 * Whether the session's turns become a scripted app's on this turn: an app in agent mode whose agent is
 * leading the call, on a run with no agent client (no key). A call that begins so, and a call resumed on a
 * server without the key, run as a scripted app from that turn for the rest of the call (Session.agent.scripted).
 */
export function scriptedFromNow(session: Session, tc: Pick<TurnContext, 'noAgentClient'>): boolean {
  return tc.noAgentClient === true && agentLed(session);
}

/** The forms a caller may open, in the app's order: a form only a recognized caller may open only for one. */
function openable(app: App, session: Session): FormId[] {
  const forms = Object.keys(app.agent?.forms ?? {});
  return forms.filter((f) => formOf(app, f).recognizedOnly === undefined || !isAnonymous(session.principal));
}

/** The fields the agent is told of: the open form's, or with none open, those of the forms the caller may open, one of each name. */
function fieldsFor(app: App, session: Session): AgentAppField[] {
  const forms = app.agent!.forms;
  if (session.form !== null) return forms[session.form]?.fields ?? [];
  const seen = new Set<string>();
  const out: AgentAppField[] = [];
  for (const f of openable(app, session)) {
    if (app.personForm?.form === f) continue;
    for (const field of forms[f]!.fields) {
      if (seen.has(field.name)) continue;
      seen.add(field.name);
      out.push(field);
    }
  }
  return out;
}

/** A field's value as the model is told it: a choice by its display (its option's words), every other value as it is held. */
function heldValue(app: App, session: Session, f: AgentAppField): string | null {
  if (session.form === null) return null;
  const slot = session.slots[f.slot];
  if (slot === undefined || slot.value === null) return null;
  return f.type === 'choice' ? (slot.display ?? slot.value) : slot.value;
}

/**
 * What `submit` and `callback` are, as the model is told (actionsFor; the bake-off's turns, agent/bakeoffCases.ts,
 * are told the same). `submit` is for a form with nothing required left (the agent-mode design, call 43: a live
 * chat's model proposed it with a required field still empty, which the core ignores).
 */
export const SUBMIT_ABOUT = 'only once nothing the form needs is still missing (no required field left in <still_needed>): the line reads back what it understood for the caller to confirm';
export const CALLBACK_ABOUT = 'the caller asks to speak with a person rather than go on: the line takes a callback note in place of what it was doing. Never for a call or a text the business makes anyway (a quote, a confirmation)';

/** What the model may propose on this turn: `submit` with a form open, `callback` where there is a person form not open, and always none. A form's `then` is the engine's, never offered. */
function actionsFor(app: App, session: Session): AgentActionChoice[] {
  const out: AgentActionChoice[] = [];
  const form = session.form;
  if (form !== null) out.push({ name: SUBMIT_ACTION, about: SUBMIT_ABOUT });
  if (app.personForm !== undefined && form !== app.personForm.form) out.push({ name: CALLBACK_ACTION, about: CALLBACK_ABOUT });
  return out;
}

/** An utterance on one line: its whitespace and line breaks collapsed, so no words of it can pass for another line of the history. */
export const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * What the agent model is sent for a turn on these words (agent/types.ts AgentContext): the facts, the
 * owner's sample replies, the form open (or with none, the fields of the forms the caller may open, so a
 * request said over the greeting gives values), each field with its value so far (masked where the records
 * hide it, agent/prompt.ts), what it may propose, the conversation so far with the values the records hide
 * masked once understood and these words last, whole, who the caller is where caller ID recognized them,
 * the channel, whether the words were heard over a line, the language and today. No identity factor: an
 * app in agent mode collects none. The checked results of the tools the model sees, kept on the call
 * (Session.agent.seen): only the fields each check names.
 */
export function agentContextOf(session: Session, event: SessionEvent, tc: Pick<TurnContext, 'todayIso'>): AgentContext {
  const app = appOf(session);
  const agent = app.agent!;
  const words = event.type === 'user.speech' || event.type === 'user.text' ? event.text : '';
  const fields = fieldsFor(app, session);
  const sent: AgentField[] = fields.map((f) => {
    const redact = app.slots[f.slot]?.redact;
    return {
      name: f.name,
      type: f.type,
      ...(f.about !== undefined ? { about: f.about } : {}),
      ...(f.options !== undefined ? { options: [...f.options] } : {}),
      value: heldValue(app, session, f),
      required: f.required,
      ...(redact !== undefined ? { redact } : {}),
    };
  });
  const allSlots = Object.values(agent.forms).flatMap((f) => f.fields.map((x) => x.slot));
  const earlier = maskedConversation(app, session.slots, allSlots, session.agent?.conversation ?? []);
  const p = session.principal;
  const form = session.form !== null && agent.forms[session.form] !== undefined ? { name: session.form, about: agent.forms[session.form]!.about } : null;
  // The fixed lines the answer may name in place of its reply (the price line): those the facts have, and
  // with a form open only those the business allows in it (prices.forms).
  const lines = Object.keys(agent.lines).filter((l) => Object.hasOwn(agent.facts.fixed, l) && lineAllowed(app, l, session.form));
  return {
    facts: agent.facts,
    examples: [...agent.examples],
    form,
    fields: sent,
    actions: actionsFor(app, session),
    ...(lines.length > 0 ? { lines } : {}),
    conversation: [...earlier.map((u) => ({ who: u.who, text: oneLine(u.text) })), { who: 'caller', text: oneLine(words) }],
    caller: { account: isAnonymous(p) ? null : p.first },
    channel: session.caps.speech ? 'voice' : 'chat',
    overLine: event.type === 'user.speech' && event.overLine === true,
    seen: (session.agent?.seen ?? []).map(({ tool, result }) => ({ tool, result })),
    locale: localeOf(session),
    today: tc.todayIso,
  };
}

/**
 * What a trace keeps of what the agent was sent (TraceRecord.agent.sent): the form, the fields with their
 * values masked as they were sent, the actions it might propose, the conversation (masked as sent), and
 * the turn's circumstances. Not the facts and sample replies, which are the app's own and the same all call.
 */
export function agentSentRecord(ctx: AgentContext): AgentSentRecord {
  return {
    form: ctx.form?.name ?? null,
    fields: ctx.fields.map((f) => ({ name: f.name, type: f.type, value: f.value === null ? null : fieldValueSent(f), required: f.required })),
    actions: ctx.actions.map((a) => a.name),
    conversation: ctx.conversation.map((u) => ({ ...u })),
    caller: { ...ctx.caller },
    channel: ctx.channel,
    overLine: ctx.overLine,
    today: ctx.today,
    ...(ctx.seen.length > 0 ? { seen: ctx.seen.map((x) => ({ ...x })) } : {}),
  };
}

/** What a trace keeps of what the agent model was sent (agentSentRecord). */
export interface AgentSentRecord {
  form: string | null;
  fields: { name: string; type: string; value: string | null; required: boolean }[];
  actions: string[];
  conversation: AgentUtterance[];
  caller: { account: string | null };
  channel: 'voice' | 'chat';
  overLine: boolean;
  today: string;
  /** The checked results it was shown (a closed form, only the fields each check names); absent where none. */
  seen?: { tool: string; result: unknown }[];
}

/**
 * A turn of an app in agent mode, with the agent model's answer (`agent`) beside the decision model's
 * (`answers`): the turn core/turn.ts resolves, which reads the answer where the turn is the agent's
 * (agentWords). The plan's interface; the runner passes the answer on TurnContext.agent itself.
 */
export function agentTurn(session: Session, event: SessionEvent, answers: AnswerMap | null, agent: AgentResult, tc: TurnContext, error: TurnError | null = null, screen: ScreenResult | null = null): TurnResult {
  return resolve(session, event, answers, { ...tc, agent }, error, screen);
}

/** What a step of the scripted turn hands back. */
export interface Handled {
  decision: Decision;
  events: FillEvent[];
}

/** The scripted turn's own steps an agent turn takes (core/turn.ts hands them over, so nothing of it is copied). */
export interface ScriptedSteps {
  handleVerdict(s: Session, verdict: Verdict, answers: AnswerMap, ctx: SlotContext, io: TurnIO): Handled;
  personForm(s: Session, reason: string, answers: AnswerMap, ctx: SlotContext, io: TurnIO): Handled | null;
  /** A person the agent model alone asked for, checked with the caller: a yes opens the person form, a no goes back to the form. */
  checkPerson(s: Session, answers: AnswerMap, ctx: SlotContext, acks: Ack[], io: TurnIO): PromptDecision;
  askSummary(s: Session, form: FormId, acks: Ack[], io: TurnIO): Decision;
  /** The pending read-back said again as it stands: its attempts and its "What should I change?" kept. */
  summaryPrompt(s: Session, form: FormId, acks: Ack[]): PromptDecision;
  askChange(pc: Extract<PendingConfirmation, { target: 'form' }>, acks: Ack[]): PromptDecision;
  reaskConfirmation(s: Session, io: TurnIO, acks?: Ack[]): Decision;
  continueForm(s: Session, io: TurnIO, acks: Ack[], disambiguate: null): Decision;
  /** A miss at a slot's question: an attempt counted, and the slot's own ladder (its retry line, its keypad rung, its onMaxAttempts or a person). */
  failAttempt(s: Session, slot: SlotId, io: TurnIO, acks: Ack[]): Decision;
}

/** The gates' verdicts the turn is the scripted one on, whatever the agent answered. */
const SCRIPTED_VERDICTS: ReadonlySet<Verdict['kind']> = new Set(['ignore', 'hold', 'nomatch', 'handoff', 'replay', 'inform']);

/** A record of an answer the turn did not read, for the reason given. */
function droppedRecord(agent: AgentResult, dropped: string): AgentTurnRecord {
  return {
    ms: agent.ms,
    use: 'dropped',
    dropped,
    ...(agent.ok ? {} : { fallback: agent.reason, detail: agent.detail }),
    values: [],
    action: agent.ok ? agent.answer.action : NO_ACTION,
    ...(agent.ok ? { fromFacts: agent.answer.fromFacts, reply: agent.answer.reply } : {}),
    replySaid: false,
  };
}

/** The record of an answer a turn set aside or quarantined without reading it (core/turn.ts). */
export function agentDropped(agent: AgentResult | undefined, dropped: string): AgentTurnRecord | undefined {
  return agent === undefined ? undefined : droppedRecord(agent, dropped);
}

/** The required fields of a form all hold a value. */
export function requiredFilled(app: App, s: Session, form: FormId): boolean {
  return (app.agent!.forms[form]?.fields ?? []).every((f) => !f.required || s.slots[f.slot]?.value != null);
}

/** A reply with words in it, trimmed; null for none. */
const replyOf = (reply: string | null | undefined): string | null => (reply === null || reply === undefined || reply.trim() === '' ? null : reply.trim());

/** Whether a reply asks the caller anything: a question mark in it. */
const asks = (reply: string): boolean => reply.includes('?');

/** `decision` with the agent's reply said in its place (PromptDecision.agent), where there is a reply. */
function withReply(decision: PromptDecision, reply: string | null, record: AgentTurnRecord): PromptDecision {
  const r = replyOf(reply);
  if (r === null) return decision;
  record.replySaid = true;
  return { ...decision, agent: { reply: r } };
}

/** `decision` with the agent's reply said before it, as an aside (AgentLine.aside), where there is a reply. */
function withAside(decision: PromptDecision, reply: string | null, record: AgentTurnRecord): PromptDecision {
  const r = replyOf(reply);
  if (r === null) return decision;
  record.replySaid = true;
  return { ...decision, agent: { reply: r, aside: true } };
}

/**
 * `question` (a field's plain question, or the open question) with the reply: in its place where the reply
 * asks something, before it where the reply asks nothing (so the caller is still asked what is needed).
 */
function replyOrAside(question: PromptDecision, reply: string | null, record: AgentTurnRecord): PromptDecision {
  const r = replyOf(reply);
  if (r === null) return question;
  return asks(r) ? withReply(question, r, record) : withAside(question, r, record);
}

/** Whether a decision is a field's own question as the core asks it, plain: one an agent line may stand in for. */
function plainQuestion(app: App, d: Decision, form: FormId): d is PromptDecision {
  if (d.kind !== 'prompt' || d.help !== undefined || d.target === null) return false;
  const field = app.agent!.forms[form]?.fields.find((f) => f.slot === d.target);
  return field !== undefined && d.promptId.startsWith(`ask_${field.slot}`) && !d.promptId.endsWith('_retry');
}

/**
 * The form to open for values with none open and no request read: the caller's form whose fields the
 * values name most (a form only a recognized caller may open first among equals, for such a caller),
 * never the person form. Null where they name none.
 */
function formForValues(app: App, s: Session, fields: readonly string[]): FormId | null {
  if (fields.length === 0) return null;
  const forms = openable(app, s).filter((f) => app.personForm?.form !== f);
  let best: { form: FormId; n: number; only: boolean } | null = null;
  for (const form of forms) {
    const names = new Set(app.agent!.forms[form]!.fields.map((f) => f.name));
    const n = fields.filter((f) => names.has(f)).length;
    const only = formOf(app, form).recognizedOnly !== undefined;
    if (n > 0 && (best === null || n > best.n || (n === best.n && only && !best.only))) best = { form, n, only };
  }
  return best?.form ?? null;
}

/**
 * Opens `form`, or for a caller not recognized, the form a form only a recognized caller may open offers
 * instead, after its line (FormDef.recognizedOnly). Null where nothing opens.
 */
function openForm(app: App, s: Session, form: FormId, acks: Ack[]): FormId | null {
  const only = formOf(app, form).recognizedOnly;
  let open = form;
  if (only !== undefined && isAnonymous(s.principal)) {
    acks.push({ promptId: only.say, vars: {} });
    if (only.instead === undefined || only.instead === form) return null;
    open = only.instead;
  }
  setForm(s, open);
  return open;
}

interface Applied {
  events: FillEvent[];
  /** The slot of the first value refused, whose question is asked. */
  refused: SlotId | null;
  /** The slot of the first text value the drift judge refused (TurnContext.agentTextRefused), whose question is asked again (call 45). */
  judged: SlotId | null;
  /** Whether a value was stored that differs from the one held. */
  changed: boolean;
}

/** The slot of a field of this name in any of the app's forms (for masking a value given for no field of the form open), or undefined. */
function slotNamed(app: App, field: string): SlotId | undefined {
  for (const f of Object.values(app.agent!.forms)) {
    const found = f.fields.find((x) => x.name === field);
    if (found !== undefined) return found.slot;
  }
  return undefined;
}

/** The answer's values checked by their fields' slot types and the accepted ones stored (see the top). */
function applyValues(app: App, s: Session, values: readonly { field: string; value: string; words: string }[], said: string, tc: TurnContext, record: AgentTurnRecord): Applied {
  const out: Applied = { events: [], refused: null, judged: null, changed: false };
  const held: { field: AgentAppField; proposed: { field: string; slot: string; value: string; words: string }; before: Session['slots'][string] }[] = [];
  const fields = s.form !== null ? (app.agent!.forms[s.form]?.fields ?? []) : [];
  const locale = slotLocaleOf(s);
  for (const v of values) {
    const field = fields.find((f) => f.name === v.field);
    if (field === undefined) {
      const slot = slotNamed(app, v.field);
      record.values.push({ field: v.field, ...(slot !== undefined ? { slot } : {}), value: v.value, words: v.words, outcome: 'field' });
      continue;
    }
    // The value the field holds, given back as the model was shown it (masked where the records hide it:
    // "...0177" at a callback number's read-back): no new value, nor a correction, so nothing to check and
    // nothing changed (a recording: a yes at the callback note's read-back, the number restated
    // masked, was refused as a correction and the read-back set aside).
    const onFile = s.slots[field.slot];
    if (onFile !== undefined && onFile.value !== null && restatesHeld(app, field, onFile, v.value)) {
      record.values.push({ field: field.name, slot: field.slot, value: v.value, words: v.words, outcome: 'accepted', shown: onFile.display ?? String(onFile.value) });
      continue;
    }
    // A text value the drift judge refused against the caller's words, or did not read in time (call 45):
    // never held, neither as given nor as the words it cited; the field keeps what it held before, or none.
    if (tc.agentTextRefused?.includes(field.name) === true) {
      record.values.push({ field: field.name, slot: field.slot, value: v.value, words: v.words, outcome: 'judged' });
      out.judged ??= field.slot;
      continue;
    }
    const spec = app.slots[field.slot] as BuiltSlotSpec | undefined;
    const before = s.slots[field.slot]?.value;
    const check: ValueCheck = spec?.check !== undefined ? spec.check(v.value, v.words, said, { today: tc.todayIso, ...(locale !== undefined ? { locale } : {}), ...(before !== null && before !== undefined ? { held: String(before) } : {}) }) : { ok: false, reason: 'unsupported' };
    const proposed = { field: field.name, slot: field.slot, value: v.value, words: v.words };
    if (!check.ok) {
      record.values.push({ ...proposed, outcome: check.reason });
      out.events.push({ slot: field.slot, outcome: { kind: 'invalid', reason: `agent-${check.reason}`, raw: '' } });
      out.refused ??= field.slot;
      continue;
    }
    const slot = s.slots[field.slot]!;
    if (field.freeFrom !== undefined) held.push({ field, proposed, before: { ...slot } });
    if (slot.value !== check.value) out.changed = true;
    Object.assign(slot, { value: check.value, display: check.shown, confirmed: false, window: null, by: 'agent' as const });
    delete slot.declined;
    delete slot.missed;
    // A value held: a later judge's refusal of this field is a first one again (judgedAgain).
    if (s.agent?.judged?.includes(field.slot) === true) s.agent = { ...s.agent, judged: s.agent.judged.filter((x) => x !== field.slot) };
    record.values.push({ ...proposed, outcome: 'accepted', shown: check.shown });
    out.events.push({ slot: field.slot, outcome: { kind: 'filled', value: check.value, display: check.shown, confidence: 1, confirm: 'none' } });
  }
  // A value that must be free (business.yaml's `freeFrom`), once every value of the answer is in (the day may
  // come with it): where the model has been shown the free options for the form's day, one not among them
  // is refused (`range`), its slot as it was, so the line never takes, or promises, an option that is full.
  for (const { field, proposed, before } of held) {
    const slot = s.slots[field.slot]!;
    const free = freeOptions(app, s, field, tc);
    if (free === null || slot.value === null || free.includes(String(slot.value))) continue;
    Object.assign(slot, before);
    const at = record.values.findIndex((r) => r.slot === field.slot && r.outcome === 'accepted' && r.value === proposed.value);
    if (at !== -1) {
      const { shown: _shown, ...rest } = record.values[at]!;
      record.values[at] = { ...rest, outcome: 'range' };
    }
    const filled = out.events.findIndex((e) => e.slot === field.slot && e.outcome.kind === 'filled');
    if (filled !== -1) out.events.splice(filled, 1);
    out.events.push({ slot: field.slot, outcome: { kind: 'invalid', reason: 'agent-range', raw: '' } });
    out.refused ??= field.slot;
  }
  return out;
}

/**
 * A text value the drift judge refused (call 45): its field's question asked again. The first such refusal
 * of the field counts no attempt (the model's short version was unfaithful, not the caller's answer); one
 * after it, with no value of the field held between, counts an attempt and walks the slot's own ladder, so
 * a field the judge keeps refusing still reaches the keypad and a person.
 */
function judgedAgain(s: Session, slot: SlotId, io: TurnIO, steps: ScriptedSteps, acks: Ack[], events: FillEvent[]): Handled {
  const before = s.agent?.judged ?? [];
  if (before.includes(slot)) {
    return { decision: steps.failAttempt(s, slot, io, acks), events: [...events, { slot, outcome: { kind: 'invalid', reason: 'agent-judged', raw: '' } }] };
  }
  s.agent = { ...(s.agent ?? { conversation: [], failures: 0 }), judged: [...before, slot] };
  return { decision: askSlot(s, slot, null, acks), events };
}

/** Whether `value` is the held value as the field holds it, shows it, or was sent it masked (agent/prompt.ts fieldValueSent). */
function restatesHeld(app: App, field: AgentAppField, held: { value: unknown; display?: string | null }, value: string): boolean {
  const redact = app.slots[field.slot]?.redact as AgentField['redact'];
  const forms = [String(held.value), ...(held.display != null ? [held.display] : [])];
  return forms.some((f) => f === value || (redact !== undefined && fieldValueSent({ value: f, redact }) === value));
}

/**
 * The second answer of a turn asked again with a seen tool's result (TurnResult.agentAgain), with the values
 * the first answer gave and the turn accepted kept where the second leaves them out (the agent-mode design,
 * call 39): the model, shown the day's free windows, need not say the day again, and an omission is no
 * retraction. A value the second gives replaces the first's. A `freeFrom` field's first value is kept only
 * where the result it was held to still lists it (it is checked again with the rest); otherwise it is left
 * out, never refused, since the result is what made it wrong.
 */
export function withFirstValues(app: App, first: Pick<AgentTurnRecord, 'values'>, form: FormId | null, second: AgentAnswer, seen: readonly SeenResult[]): AgentAnswer {
  if (form === null) return second;
  const fields = app.agent?.forms[form]?.fields ?? [];
  const given = new Set(second.values.map((v) => v.field));
  const kept = first.values.filter((v) => v.outcome === 'accepted' && !given.has(v.field)).filter((v) => {
    const field = fields.find((f) => f.name === v.field);
    if (field === undefined) return false;
    if (field.freeFrom === undefined) return true;
    const seer = fields.find((f) => f.sees === field.freeFrom!.tool);
    const day = first.values.find((x) => x.field === seer?.name && x.outcome === 'accepted')?.value;
    const result = seen.find((x) => x.tool === field.freeFrom!.tool && x.value === day)?.result;
    const list = typeof result === 'object' && result !== null ? (result as Record<string, unknown>)[field.freeFrom.list] : undefined;
    return Array.isArray(list) && list.includes(v.value);
  });
  return kept.length === 0 ? second : { ...second, values: [...second.values, ...kept.map(({ field, value, words }) => ({ field, value, words }))] };
}

/**
 * Every value the open form holds for a `freeFrom` field that the latest result kept for its day no longer
 * lists, cleared (its attempts kept, none counted): the first such field's slot, or null where none is.
 */
function clearUnfree(app: App, s: Session, tc: TurnContext): SlotId | null {
  if (s.form === null) return null;
  let first: SlotId | null = null;
  for (const field of app.agent?.forms[s.form]?.fields ?? []) {
    if (field.freeFrom === undefined) continue;
    const slot = s.slots[field.slot];
    if (slot === undefined || slot.value === null) continue;
    const free = freeOptions(app, s, field, tc);
    if (free === null || free.includes(String(slot.value))) continue;
    Object.assign(slot, emptySlot(), { attempts: slot.attempts });
    first ??= field.slot as SlotId;
  }
  return first;
}

/**
 * The options free for a `freeFrom` field (AgentAppField.freeFrom), by their keys: the list in the latest
 * result kept on the call (Session.agent.seen, or on a second resolution the results it was asked again with) of its tool for the value the form's seeing field holds now
 * (the day); null where there is none yet (the model has not been shown it: its value stands, and the
 * model is asked again with the result, core/agentTurn.ts step 3a) or the list is not one of words.
 */
function freeOptions(app: App, s: Session, field: AgentAppField, tc: TurnContext): string[] | null {
  const from = field.freeFrom!;
  const form = s.form !== null ? app.agent!.forms[s.form] : undefined;
  const seer = form?.fields.find((f) => f.sees === from.tool);
  const day = seer !== undefined ? s.slots[seer.slot]?.value : null;
  if (day === null || day === undefined) return null;
  // The results kept on the call, and on a second resolution those the model was just asked again with.
  const kept = [...(s.agent?.seen ?? []), ...(tc.agentSeen?.seen ?? [])].reverse().find((x) => x.tool === from.tool && x.value === String(day));
  const list = kept !== undefined && typeof kept.result === 'object' && kept.result !== null ? (kept.result as Record<string, unknown>)[from.list] : undefined;
  return Array.isArray(list) && list.every((x) => typeof x === 'string') ? (list as string[]) : null;
}

/** Whether an answer understood nothing: no value, no action, nothing from the facts, no fixed line said (a miss, which speech over a line sets aside). */
const understoodNothing = (a: AgentAnswer, fixed: boolean): boolean => a.values.length === 0 && a.action === NO_ACTION && !a.fromFacts && !fixed;

/** Whether a fixed line may be named with `form` open (AgentApp.lineForms: business.yaml's `prices.forms`): with no form open, or a line no form list limits, always. */
function lineAllowed(app: App, line: string, form: FormId | null): boolean {
  const forms = app.agent?.lineForms?.[line];
  return form === null || forms === undefined || forms.includes(form);
}

/** The fixed line `name` (one an answer names in place of its reply), with the prompt it is said through, where the app has it and allows it in the form open; else null. */
function fixedLineOf(app: App, name: string | null, form: FormId | null): { name: string; promptId: string } | null {
  if (name === null || name === NO_ACTION || !lineAllowed(app, name, form)) return null;
  const promptId = app.agent?.lines[name];
  return promptId !== undefined && Object.hasOwn(app.prompts.manifest, promptId) ? { name, promptId } : null;
}

/**
 * The fixed line due on this turn (the agent-mode design, call 43 and its amendment), given the line the
 * answer named (or null): the price line only where the decision model read the caller asking what something
 * costs, at AGENT_PRICE_ASKED or above (its `asksPrice` question, asked on every turn of an app with a price
 * line), so the line is the business's answer to a caller who asked, never a "what happens next" the agent
 * model chose: named and so read, it is said; read and not named, it is said all the same. Named and read under
 * the bar, it is not, and nor is the reply (`refused`): the model wrote that reply as a price answer, so it is
 * never trusted on its own, and the turn says its own fixed step. With no reading (the question missing from
 * the decision model's answers, or not a reading), the safe outcome: a line named is said, and none named is
 * not. The reading is kept on the record. A line with no question of its own is due as named.
 */
function lineDue(app: App, named: string | null, answers: AnswerMap, t: Thresholds, record: AgentTurnRecord): { due: string | null; refused: boolean } {
  if (app.agent?.lines[PRICE_LINE] === undefined) return { due: named, refused: false };
  const answer = answers[PRICE_QUESTION];
  if (!isNoul(answer)) return { due: named, refused: false };
  const score = answer.noul;
  record.priceAsked = { score, at: t.AGENT_PRICE_ASKED, named: named === PRICE_LINE };
  const asked = atLeast(score, t.AGENT_PRICE_ASKED);
  if (named === PRICE_LINE) return asked ? { due: PRICE_LINE, refused: false } : { due: null, refused: true };
  return { due: named ?? (asked ? PRICE_LINE : null), refused: false };
}

/**
 * A turn with a fixed line due (the price line, lineDue): that line said whole, first, and the reply never,
 * so a price is never worded; the turn's own line (a field's question, the read-back) after it.
 */
function withFixedLine(h: Handled, fixed: { name: string; promptId: string } | null, record: AgentTurnRecord): Handled {
  if (fixed === null || h.decision.kind !== 'prompt') return h;
  const { agent: _reply, ...decision } = h.decision;
  record.replySaid = false;
  record.fixedLine = fixed.name;
  return { ...h, decision: { ...decision, acks: [{ promptId: fixed.promptId, vars: {} }, ...decision.acks] } };
}

/** What the tools the model sees came to on this turn (lookUpSeen). */
interface Looked {
  /** The results to ask the model again with (every result kept on the call), where a value this turn ran a tool the model was not yet shown; else null. */
  again: SeenResult[] | null;
  /** On the second resolution: a value the second answer gave ran a tool whose result the model was not shown, so its reply was written without it. */
  unseen: boolean;
}

/** How many results of the tools the model sees a call keeps (Session.agent.seen): the latest, one per tool, field and value. */
export const SEEN_KEPT = 8;

const sameCall = (a: Pick<SeenResult, 'tool' | 'field' | 'value'>, b: Pick<SeenResult, 'tool' | 'field' | 'value'>): boolean => a.tool === b.tool && a.field === b.field && a.value === b.value;

/** Nothing looked up: no tool run, nothing to ask again. */
const LOOKED_NOTHING: Looked = { again: null, unseen: false };

/**
 * The tools the model sees (business.yaml's `sees`, App.agent.sees), each run through the gate for an
 * accepted value of its field whose result the model has not yet been shown (step 3a at the top), its
 * result, once it passes its reply check, kept on the call (Session.agent.seen, the latest SEEN_KEPT, one
 * per tool, field and value) with only the fields that check names. A call still waiting makes the pass
 * provisional (core/toolWait.ts); one the gate refuses, with no result, that throws or replies late (its
 * failure recorded by callTool), or whose check is not known closed (a guard: pnpm check refuses such a
 * tool), shows nothing, and the turn goes on; one whose reply fails its check ends the turn with a person
 * (TurnOut.unchecked, as for any tool), and nothing is asked again. On the second resolution every call
 * the first made is made again, through the turn's memo (no tool runs twice), so the turn's records and
 * the call keep each one, whatever the second answer gave.
 */
function lookUpSeen(app: App, s: Session, io: TurnIO, record: AgentTurnRecord): Looked {
  const sees = app.agent!.sees;
  const given = io.tc.agentSeen;
  const kept = [...(s.agent?.seen ?? [])];
  const keep = (x: SeenResult): void => {
    const at = kept.findIndex((k) => sameCall(k, x));
    if (at >= 0) kept.splice(at, 1);
    kept.push(x);
    if (kept.length > SEEN_KEPT) kept.splice(0, kept.length - SEEN_KEPT);
  };
  const shown = (tool: string, field: string, value: string): unknown => {
    const check = app.tools[tool]?.check;
    if (openPart(check) !== null) return undefined;
    const before = io.out.effects.length;
    let ran: ReturnType<typeof callTool>;
    try {
      ran = callTool(s, { tool, params: { [field]: value } }, io.tc, io.out);
    } catch {
      // The tool threw, or replied late: recorded as failed by callTool; what it queued is dropped, and nothing is shown.
      io.out.effects.length = before;
      return undefined;
    }
    if (ran.pending === true || ran.decision.verdict !== 'ALLOW' || ran.value === null || ran.value === undefined) return undefined;
    return namedPart(check, ran.value);
  };
  for (const g of given?.seen ?? []) {
    if (kept.some((k) => sameCall(k, g))) continue;
    const result = shown(g.tool, g.field, g.value);
    if (result !== undefined) keep({ tool: g.tool, field: g.field, value: g.value, result });
  }
  let fresh = false;
  let unseen = false;
  for (const v of record.values) {
    const tool = v.outcome === 'accepted' && v.slot !== undefined ? sees[v.slot] : undefined;
    if (tool === undefined) continue;
    const value = s.slots[v.slot!]?.value;
    if (value === null || value === undefined) continue;
    const call = { tool, field: v.field, value };
    // Shown on an earlier turn (the model was sent it with this turn's words), or, on the second resolution, on the first.
    if (kept.some((k) => sameCall(k, call))) continue;
    const result = shown(tool, v.field, value);
    if (result === undefined) continue;
    keep({ ...call, result });
    if (given === undefined) fresh = true;
    else unseen = true;
  }
  if (kept.length > 0) s.agent = { conversation: s.agent?.conversation ?? [], failures: s.agent?.failures ?? 0, ...s.agent, seen: kept };
  const checkedAll = (io.out.unchecked?.length ?? 0) === 0;
  return { again: fresh && checkedAll ? kept.map((k) => ({ ...k })) : null, unseen };
}

/**
 * The words turn of an app in agent mode, once the gates have read the turn (core/turn.ts): see the top.
 * `said` is the turn's words, which every value's words are held to.
 */
export function agentWords(s: Session, verdict: Verdict, answers: AnswerMap, ctx: SlotContext, io: TurnIO, steps: ScriptedSteps, said: string): Handled {
  const app = io.app;
  // Not asked (agentAsks: a question of the core's own pending): the scripted turn, with nothing to record.
  if (io.tc.agent === undefined) return steps.handleVerdict(s, verdict, answers, ctx, io);
  const agent = io.tc.agent;
  const pc = s.pendingConfirmation;
  // The gates settled the turn, or it answers a question of the core's own: the scripted turn.
  const routedElsewhere = verdict.kind === 'route' && !isFormIntent(app, verdict.intent);
  if (SCRIPTED_VERDICTS.has(verdict.kind) || routedElsewhere || (pc !== null && pc.target !== 'form')) {
    io.agent = droppedRecord(agent, pc !== null && pc.target !== 'form' && !SCRIPTED_VERDICTS.has(verdict.kind) ? `pending:${pc.target}` : routedElsewhere ? `route:${verdict.intent}` : verdict.kind);
    return steps.handleVerdict(s, verdict, answers, ctx, io);
  }
  const answer = agent.ok ? agent.answer : null;
  // No client (no key): no failure; the turn runs on its fixed questions.
  const none = noAgentClient(agent);
  const record: AgentTurnRecord = {
    ms: agent.ms,
    use: answer !== null ? 'used' : 'failed',
    ...(agent.ok ? {} : { fallback: agent.reason, detail: agent.detail }),
    values: [],
    action: answer?.action ?? NO_ACTION,
    ...(answer !== null ? { fromFacts: answer.fromFacts, reply: answer.reply } : {}),
    replySaid: false,
  };
  io.agent = record;
  // Two failures in a row on a call end it with the handoff line; an answer read resets the count. No client counts nothing.
  const conversation = s.agent?.conversation ?? [];
  const failures = answer !== null ? 0 : none ? (s.agent?.failures ?? 0) : (s.agent?.failures ?? 0) + 1;
  s.agent = { ...s.agent, conversation, failures };
  const failedTwice = answer === null && !none && failures >= 2;
  const action = record.action;
  const actionDone = (outcome: 'taken' | 'checked' | 'ignored'): void => {
    if (action !== NO_ACTION) record.actionOutcome = outcome;
  };

  // A fixed line due (the price line: named by the answer and read by the decision model, or read alone):
  // that line said whole before the turn's own, never the reply. The price line named where the decision
  // model reads no price asked is not due, and nor is the reply written as a price answer beside it: the
  // turn's own fixed step alone (lineDue; call 43's amendment).
  const named = answer !== null && answer.fixedLine !== undefined && answer.fixedLine !== NO_ACTION ? answer.fixedLine : null;
  const { due, refused } = answer !== null ? lineDue(app, named, answers, io.tc.thresholds, record) : { due: null, refused: false };
  const fixed = fixedLineOf(app, due, s.form);
  const handled = answered(s, verdict, answers, ctx, io, steps, said, record, actionDone, { none, failedTwice, fixed: fixed !== null });
  if (refused) return withoutAgentReply(handled, record);
  if (fixed === null || !lineAllowed(app, fixed.name, s.form)) {
    // A line named and due where the business does not allow it (prices.forms), with the form open before the
    // turn or the one it opened: not said, and nor is the reply written to stand beside it; the turn's own
    // line is. A line read but not named, there: the turn as it stands.
    return named !== null && due === named ? withoutAgentReply(handled, record) : handled;
  }
  return withFixedLine(handled, fixed, record);
}

/** A turn said without the agent's reply: its own line alone. */
function withoutAgentReply(h: Handled, record: AgentTurnRecord): Handled {
  if (h.decision.kind !== 'prompt' || h.decision.agent === undefined) return h;
  const { agent: _reply, ...decision } = h.decision;
  record.replySaid = false;
  return { ...h, decision };
}

/** The words turn once the answer is recorded (agentWords): the read-back's, or the form's (steps 1 to 6 at the top). */
function answered(s: Session, verdict: Verdict, answers: AnswerMap, ctx: SlotContext, io: TurnIO, steps: ScriptedSteps, said: string, record: AgentTurnRecord, actionDone: (o: 'taken' | 'checked' | 'ignored') => void, failed: { none: boolean; failedTwice: boolean; fixed: boolean }): Handled {
  const app = io.app;
  const pc = s.pendingConfirmation;
  const answer = io.tc.agent?.ok === true ? io.tc.agent.answer : null;
  const { failedTwice } = failed;
  const action = record.action;

  // 1. At a read-back.
  if (pc !== null && pc.target === 'form') return atReadBack(s, verdict, answers, ctx, io, steps, said, pc, record, actionDone, failed);

  // A callback asked for, where the decision model read the person form's request too: the person form, as
  // a person asked for is (App.personForm). Asked for by the agent model alone, it is checked below.
  if (action === CALLBACK_ACTION && personRead(app, verdict)) {
    const person = steps.personForm(s, 'live-agent', answers, ctx, io);
    if (person !== null) {
      actionDone('taken');
      return person;
    }
  }

  // 2. A form opened. The reply was written for the form open before the turn (or, with none, for the
  // forms the caller may open, whose fields it was sent).
  const formBefore = s.form;
  const acks: Ack[] = [];
  let opened = false;
  if (s.form === null) {
    const want = verdict.kind === 'route' && isFormIntent(app, verdict.intent) ? verdict.intent : formForValues(app, s, (answer?.values ?? []).map((v) => v.field));
    if (want !== null) opened = openForm(app, s, want, acks) !== null || acks.length > 0;
  }
  const lineSaid = acks.length > 0;

  // 3. Values.
  const applied = applyValues(app, s, answer?.values ?? [], said, io.tc, record);
  // 3a. The tools the model sees, for the values it gave: asked again with their results where any is new;
  // not where a value was refused, whose slot's own question is asked (no second asking for it).
  const looked = applied.refused === null && applied.judged === null ? lookUpSeen(app, s, io, record) : LOOKED_NOTHING;
  if (looked.again !== null) io.agentAgain = { seen: looked.again };
  const form = s.form;
  if (answer !== null && understoodNothing(answer, failed.fixed) && !opened) io.missed = true;

  if (failedTwice) {
    // 7. A second failure in a row where the turn needed the answer: the handoff line.
    return { decision: handoff(s, 'system-failure', acks), events: applied.events };
  }
  if (applied.refused !== null) {
    // A value its slot type refused: dropped, an attempt counted on its slot, and the slot's own ladder.
    actionDone('ignored');
    return { decision: steps.failAttempt(s, applied.refused, io, acks), events: applied.events };
  }
  if (applied.judged !== null) {
    // A text value the drift judge refused: not held, and its field's question asked again (call 45).
    actionDone('ignored');
    return judgedAgain(s, applied.judged, io, steps, acks, applied.events);
  }
  // A value held to a seen result (`freeFrom`) that the latest result no longer lists (the day changed after
  // it was given): cleared, no attempt counted, and its question asked (the agent-mode design, call 40).
  const cleared = clearUnfree(app, s, io.tc);
  if (cleared !== null) {
    actionDone('ignored');
    return { decision: askSlot(s, cleared, null, acks), events: applied.events };
  }
  if (action === CALLBACK_ACTION && personCheckable(app, s) && personSupported(app, answers, io.tc.thresholds)) {
    // 6. A callback the agent model proposed that the decision model read some sign of, not enough to
    // act on: the caller is asked first, so a model's misreading never takes them off what they were
    // doing; the values the answer gave are kept, and a no goes back to the form where it stood. One it
    // read no sign of is not taken (below: ignored, its reply not said).
    actionDone('checked');
    return { decision: steps.checkPerson(s, answers, ctx, acks, io), events: applied.events };
  }
  if (form !== null && requiredFilled(app, s, form)) {
    // 4. Every required field filled: the read-back, in the business's fixed words.
    actionDone(action === SUBMIT_ACTION ? 'taken' : 'ignored');
    return { decision: steps.askSummary(s, form, acks, io), events: applied.events };
  }
  actionDone('ignored');
  // 5. The reply, unless it could contradict what the core did: a value set aside, the action not taken,
  // a form only a recognized caller may open turned down, or a form open it was not written for.
  const forFormOpen = formBefore === form || (formBefore === null && form !== null && openable(app, s).includes(form));
  // Nor a reply written without a result the model sees: one it is to be asked again with, or a value's whose result it was not shown.
  const contradicts = record.values.some((v) => v.outcome !== 'accepted') || record.actionOutcome === 'ignored' || lineSaid || !forFormOpen || looked.again !== null || looked.unseen;
  const reply = contradicts ? null : (answer?.reply ?? null);
  if (form !== null) {
    // The reply in place of the core's own next question; any other next step of the core's is said instead.
    const next = steps.continueForm(s, io, acks, null);
    return { decision: plainQuestion(app, next, form) ? replyOrAside(next, reply, record) : next, events: applied.events };
  }
  return { decision: replyOrAside(prompt('ask_intent', 'intent', {}, acks), reply, record), events: applied.events };
}

/**
 * Whether the decision model read the turn as a request for the person form (the `callback` the agent
 * proposed is then the caller's, read twice): its verdict routes to that form. A person asked for outright
 * (wantsHuman, the `agent` intent) is a handoff the gates settle before the agent's answer is read.
 */
function personRead(app: App, verdict: Verdict): boolean {
  return app.personForm !== undefined && verdict.kind === 'route' && verdict.intent === app.personForm.form;
}

/**
 * Whether the decision model read some sign of a person asked for, short of acting on it: its wantsHuman,
 * or its request read as a person or the person form (the `agent` intent and the person form's together),
 * at the bar a scripted app checks an unsure request at ("Just to check, do you want to ...?",
 * INTENT_EXPLICIT). Under it the decision model reads none, and the agent model's `callback` alone is not
 * taken: a recording read wantsHuman 0.02 on every turn the model proposed one mid-request ("I'll have
 * the owner call you back to confirm"), and a person asked for outright the gates hand
 * off on at GATE_WANTS_HUMAN, before the answer is read.
 */
function personSupported(app: App, answers: AnswerMap, t: Thresholds): boolean {
  const wants = noulValue(answers, 'wantsHuman') ?? 0;
  const intent = answers.intent;
  const asked = isChoice(intent) ? (intent.probabilities.agent ?? 0) + (app.personForm !== undefined ? (intent.probabilities[app.personForm.form] ?? 0) : 0) : 0;
  return atLeast(Math.max(wants, asked), t.INTENT_EXPLICIT);
}

/** Whether a person the agent model asked for can be checked with the caller: the app's person form, not open, and the `agent` intent its yes opens it by. */
function personCheckable(app: App, s: Session): boolean {
  return app.personForm !== undefined && s.form !== app.personForm.form && app.intents.agent !== undefined;
}

/** The read-back's turn (step 1 at the top). */
function atReadBack(s: Session, verdict: Verdict, answers: AnswerMap, ctx: SlotContext, io: TurnIO, steps: ScriptedSteps, said: string, pc: Extract<PendingConfirmation, { target: 'form' }>, record: AgentTurnRecord, actionDone: (o: 'taken' | 'checked' | 'ignored') => void, failed: { none: boolean; failedTwice: boolean; fixed: boolean }): Handled {
  const app = io.app;
  const answer = io.tc.agent?.ok === true ? io.tc.agent.answer : null;
  // Asides in a row at the read-back: only the first is uncounted (below), so questions alone never hold it open.
  const asideBefore = pc.aside === true;
  delete pc.aside;
  if (answer === null && !failed.none) {
    // A failed answer: the words may hold a correction no one read ("yes, but make it three"), so nothing
    // completes here. The read-back is said again, uncounted; the second failure in a row hands off. The
    // runner then reads the turn the scripted way (run/turn.ts scriptedReading), and this stands only where
    // that reading does not come in time.
    if (failed.failedTwice) return { decision: handoff(s, 'system-failure'), events: [] };
    return { decision: steps.askSummary(s, pc.form, [], io), events: [] };
  }
  const applied = applyValues(app, s, answer?.values ?? [], said, io.tc, record);
  if (applied.refused !== null) {
    // A correction its slot type refused: the read-back is set aside, an attempt counted on the slot, and its ladder.
    actionDone('ignored');
    s.pendingConfirmation = null;
    s.pendingHash = null;
    return { decision: steps.failAttempt(s, applied.refused, io, []), events: applied.events };
  }
  if (applied.judged !== null) {
    // A text correction the drift judge refused: not held (the value read back stays), the read-back set
    // aside, and the field's question asked again (call 45).
    actionDone('ignored');
    s.pendingConfirmation = null;
    s.pendingHash = null;
    return judgedAgain(s, applied.judged, io, steps, [], applied.events);
  }
  // A correction ("no, it's two"): stored, and the read-back said again with it. A correction of a field whose
  // tool the model sees runs it and asks the model again (step 3a); the second answer's reply, written with
  // the result, is said before the read-back as an aside ("Saturday afternoon is full, so the morning?").
  // On the second resolution, the first having changed a value: the read-back again, never the yes, whatever
  // the second answer gave (a yes said with a change, "yes, but make it Saturday", confirms nothing yet).
  if (applied.changed || io.tc.agentSeen?.changed === true) {
    actionDone('ignored');
    const looked = lookUpSeen(app, s, io, record);
    if (looked.again !== null) io.agentAgain = { seen: looked.again, changed: true };
    // A value held to a seen result that the latest no longer lists: the read-back set aside, the value cleared and asked.
    const cleared = clearUnfree(app, s, io.tc);
    if (cleared !== null) {
      s.pendingConfirmation = null;
      s.pendingHash = null;
      return { decision: askSlot(s, cleared, null, []), events: applied.events };
    }
    const again = steps.askSummary(s, pc.form, [], io);
    const informed = io.tc.agentSeen !== undefined && !looked.unseen && again.kind === 'prompt';
    return { decision: informed ? withAside(again as PromptDecision, answer?.reply ?? null, record) : again, events: applied.events };
  }
  // A value held to a seen result that the latest no longer lists: never confirmed as it stands.
  const unfree = clearUnfree(app, s, io.tc);
  if (unfree !== null) {
    actionDone('ignored');
    s.pendingConfirmation = null;
    s.pendingHash = null;
    return { decision: askSlot(s, unfree, null, []), events: applied.events };
  }
  // The yes, with nothing changed: the form completes through its engine-written complete hook, whatever was proposed.
  if (verdict.kind === 'confirmed') {
    actionDone('ignored');
    return steps.handleVerdict(s, verdict, answers, ctx, io);
  }
  // A callback asked for instead: the person form, where the decision model read it too; the agent model's
  // alone, checked with the caller first (a no reads the read-back again).
  if (record.action === CALLBACK_ACTION && personRead(app, verdict)) {
    const person = steps.personForm(s, 'live-agent', answers, ctx, io);
    if (person !== null) {
      actionDone('taken');
      return person;
    }
  }
  if (record.action === CALLBACK_ACTION && personCheckable(app, s) && personSupported(app, answers, io.tc.thresholds)) {
    actionDone('checked');
    s.pendingHash = null;
    return { decision: steps.checkPerson(s, answers, ctx, [], io), events: applied.events };
  }
  actionDone('ignored');
  if (verdict.kind === 'rejected') {
    // A no with nothing more: what to change; a second asks the read-back again, on its ladder.
    return { decision: pc.askedChange === true ? steps.reaskConfirmation(s, io) : steps.askChange(pc, []), events: applied.events };
  }
  // A question at the read-back ("do you open on Saturdays?", "how much is it?"), an answer from the facts
  // or a fixed line named in its place: answered as an aside, and the read-back said again as it stands (its
  // attempts and its "What should I change?" kept), uncounted: the first in a row only, and only with
  // something said in answer. A second in a row, or one with nothing to say, counts as any other turn (the
  // review of Task 7), so a caller who only asks still reaches the keypad and a person.
  // A callback not taken (the decision model read no sign of a person asked for): its reply, written as if
  // it were, is never said; the turn goes on as one with nothing to say.
  const spoken = record.action === CALLBACK_ACTION ? null : (answer?.reply ?? null);
  const isAside = answer !== null && answer.values.length === 0 && (answer.fromFacts || failed.fixed);
  const answeredSomething = failed.fixed || replyOf(spoken) !== null;
  if (isAside && answeredSomething && !asideBefore) {
    pc.aside = true;
    return { decision: withAside(steps.summaryPrompt(s, pc.form, []), spoken, record), events: applied.events };
  }
  // Anything else, neither a yes nor a no ("um", "the day" after "What should I change?"): the read-back
  // asked again on its ladder, counted, so words that settle nothing reach the keypad and then a person.
  // The reply is said before it, as an aside (held to the facts as every agent line is); after "What should
  // I change?" the re-ask's rung is that question with the reply in its place.
  const again = steps.reaskConfirmation(s, io);
  const reply = spoken;
  // An aside counted: the next in a row is counted too.
  if (isAside && s.pendingConfirmation?.target === 'form') s.pendingConfirmation.aside = true;
  if (again.kind !== 'prompt') return { decision: again, events: applied.events };
  if (pc.askedChange === true && again.target === 'confirm' && again.promptId !== 'confirm_dtmf') {
    // "What should I change?" again: the reply in its place where it asks something, else before it, so the question is still asked.
    return { decision: replyOrAside(prompt('ask_change', 'confirm', {}, again.acks), reply, record), events: applied.events };
  }
  return { decision: withAside(again, reply, record), events: applied.events };
}

/**
 * The conversation kept for the agent model (Session.agent), after a turn of an app in agent mode said
 * `decision`: the caller's words where the turn took them (not a quarantined turn's), then what the line
 * said, each on one line. Nothing for a turn that says nothing.
 */
export function noteConversation(s: Session, event: SessionEvent, decision: Decision, took: boolean): void {
  if (appOf(s).mode !== 'agent' || decision.kind === 'ignore' || decision.kind === 'hold') return;
  const conversation = [...(s.agent?.conversation ?? [])];
  if (took && (event.type === 'user.speech' || event.type === 'user.text') && oneLine(event.text) !== '') conversation.push({ who: 'caller', text: oneLine(event.text) });
  const line = oneLine(spokenText(appOf(s), decision, s.locale, { shown: !s.caps.speech }));
  if (line !== '') conversation.push({ who: 'line', text: line });
  s.agent = { ...s.agent, conversation: conversation.slice(-AGENT_CONVERSATION_KEPT), failures: s.agent?.failures ?? 0 };
}
