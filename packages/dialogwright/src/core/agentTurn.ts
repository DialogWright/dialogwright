import type { SessionEvent } from '../channel/events';
import { maskedConversation } from '../agent/history';
import { fieldValueSent } from '../agent/prompt';
import { NO_ACTION, type AgentActionChoice, type AgentAppField, type AgentContext, type AgentFailure, type AgentField, type AgentResult, type AgentUtterance } from '../agent/types';
import { isAnonymous } from '../gate/types';
import type { AnswerMap } from '../jev/types';
import { spokenText } from '../prompts/render';
import type { BuiltSlotSpec, ValueCheck } from '../slots/types';
import { isFormIntent } from './app/intents';
import { formOf } from './app/lookup';
import { appOf } from './app/registry';
import type { App, FormId, SlotId } from './app/types';
import { handoff, prompt, type Decision, type PromptDecision } from './decision';
import type { Ack, FillEvent } from './fia';
import type { Verdict } from './gates';
import { localeOf, slotLocaleOf } from './locale';
import { setForm, type PendingConfirmation, type Session } from './session';
import type { SlotContext } from './slots/types';
import { resolve, type TurnContext, type TurnError, type TurnIO, type TurnResult } from './turn';
import type { ScreenResult } from './screen';

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
 * 1. **At a read-back**: the answer's values are corrections, checked and stored, and a value that
 *    changes reads the read-back again; with none, the decision model's yes completes the form (its
 *    engine-written `complete` hook calls its `then` through the gate), a no asks what to change
 *    (`ask_change`), and anything else reads the read-back again, as the ladder does.
 * 2. **A form opened**: with none open, the request the decision model read opens its form; failing that,
 *    the form the answer's values belong to (the caller's own forms only: one only a recognized caller
 *    may open is never chosen for anyone else). A form only a recognized caller may open, asked for by
 *    anyone else, says its line and opens the form it offers instead (FormDef.recognizedOnly).
 * 3. **Values**: each checked by its field's slot type (BuiltSlotSpec.check), its words held to this
 *    turn's words. An accepted value is stored with its `shown` (`by: 'agent'`); a refused one is dropped
 *    and its field's question asked in fixed words.
 * 4. **The read-back** once every required field is filled (`submit` before that is ignored).
 * 5. **The reply**, said as an agent line (PromptDecision.agent) in place of its fallback: the next empty
 *    field's question, or the open question with no form. Where the core's own next step is not a plain
 *    question (the offer of the caller's number, a slot's own read-back, the identity a form needs), that
 *    step is said and the reply dropped.
 * 6. **Actions**: `callback` opens the person form (App.personForm). A form's `then` tools are called only
 *    by the yes at its read-back: one proposed before it is ignored, and the trace says so; the model never
 *    runs a tool. `submit` reads the read-back once it is due anyway.
 * 7. **A failed answer** (a timeout, an answer not in its shape, an error) says the fallback, and the trace
 *    says why (`fallback`); the second such turn in a row ends the call with the handoff line.
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
  /** Each value the answer gave, with what its check made of it; an accepted one with its `shown`, masked as the records mask its field. */
  values: { field: string; slot?: SlotId; outcome: AgentValueOutcome; shown?: string }[];
  /** The action the answer proposed (`none` where it proposed none, or there was no answer). */
  action: string;
  /** What the turn did with it: `taken`, or `ignored` (a form's `then` before its read-back's yes, a `submit` with a field empty, an action the turn had no use for). Absent with no action. */
  actionOutcome?: 'taken' | 'ignored';
  /** Whether the answer said it answers from the facts. */
  fromFacts?: boolean;
  /** Whether the reply was said, as an agent line in place of its fallback. */
  replySaid: boolean;
}

/** What a value's check came to: accepted, refused by its slot type (ValueCheck's reason), or `field`, naming no field of the form it was given in. */
export type AgentValueOutcome = 'accepted' | Extract<ValueCheck, { ok: false }>['reason'] | 'field';

/** The answer a turn reads when no agent client is set (a run with none): an error, so the fallback is said. */
export const NO_AGENT_CLIENT: AgentResult = { ok: false, reason: 'error', detail: 'no agent client', ms: 0 };

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
export function agentAsks(session: Session, event: SessionEvent, tc: Pick<TurnContext, 'duringService'>): boolean {
  if (event.type !== 'user.speech' && event.type !== 'user.text') return false;
  const app = appOf(session);
  if (app.mode !== 'agent' || app.agent === undefined) return false;
  if (session.ended || session.pendingService !== null || tc.duringService === true) return false;
  const pc = session.pendingConfirmation;
  return pc === null || pc.target === 'form';
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

/** A tool's name in a few words ("notifyDesk" is "notify desk"). */
const toolWords = (tool: string): string => tool.replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().trim();

/** What the model may propose on this turn. */
function actionsFor(app: App, session: Session): AgentActionChoice[] {
  const out: AgentActionChoice[] = [];
  const form = session.form;
  if (form !== null) out.push({ name: SUBMIT_ACTION, about: 'every required field is filled: the line reads back what it understood for the caller to confirm' });
  if (app.personForm !== undefined && form !== app.personForm.form) out.push({ name: CALLBACK_ACTION, about: 'the caller wants a person to call them back: the line takes a callback note' });
  if (form !== null) {
    for (const tool of app.agent!.forms[form]?.then.slice(1) ?? []) out.push({ name: tool, about: `${toolWords(tool)}, done only once the caller says yes to the read-back` });
  }
  return out;
}

/**
 * What the agent model is sent for a turn on these words (agent/types.ts AgentContext): the facts, the
 * owner's sample replies, the form open (or with none, the fields of the forms the caller may open, so a
 * request said over the greeting gives values), each field with its value so far (masked where the records
 * hide it, agent/prompt.ts), what it may propose, the conversation so far with the values the records hide
 * masked once understood and these words last, whole, who the caller is where caller ID recognized them,
 * the channel, whether the words were heard over a line, the language and today. No identity factor: an
 * app in agent mode collects none. No tool's result yet (`seen`, a later step).
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
  return {
    facts: agent.facts,
    examples: [...agent.examples],
    form,
    fields: sent,
    actions: actionsFor(app, session),
    conversation: [...earlier, { who: 'caller', text: words }],
    caller: { account: isAnonymous(p) ? null : p.first },
    channel: session.caps.speech ? 'voice' : 'chat',
    overLine: event.type === 'user.speech' && event.overLine === true,
    seen: [],
    locale: localeOf(session),
    today: tc.todayIso,
  };
}

/**
 * What a trace keeps of what the agent was sent (TraceRecord.agentSent): the form, the fields with their
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
  askSummary(s: Session, form: FormId, acks: Ack[], io: TurnIO): Decision;
  askChange(pc: Extract<PendingConfirmation, { target: 'form' }>, acks: Ack[]): PromptDecision;
  reaskConfirmation(s: Session, io: TurnIO, acks?: Ack[]): Decision;
  continueForm(s: Session, io: TurnIO, acks: Ack[], disambiguate: null): Decision;
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
    ...(agent.ok ? { fromFacts: agent.answer.fromFacts } : {}),
    replySaid: false,
  };
}

/** The record of an answer a turn set aside or quarantined without reading it (core/turn.ts). */
export function agentDropped(agent: AgentResult | undefined, dropped: string): AgentTurnRecord | undefined {
  return agent === undefined ? undefined : droppedRecord(agent, dropped);
}

/** The required fields of a form all hold a value. */
function requiredFilled(app: App, s: Session, form: FormId): boolean {
  return (app.agent!.forms[form]?.fields ?? []).every((f) => !f.required || s.slots[f.slot]?.value != null);
}

/** `decision` with the agent's reply said in its place (PromptDecision.agent), where there is a reply. */
function withReply(decision: PromptDecision, reply: string | null, record: AgentTurnRecord): PromptDecision {
  if (reply === null || reply.trim() === '') return decision;
  record.replySaid = true;
  return { ...decision, agent: { reply: reply.trim() } };
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
  /** Whether a value was stored that differs from the one held. */
  changed: boolean;
}

/** The answer's values checked by their fields' slot types and the accepted ones stored (see the top). */
function applyValues(app: App, s: Session, values: readonly { field: string; value: string; words: string }[], said: string, tc: TurnContext, record: AgentTurnRecord): Applied {
  const out: Applied = { events: [], refused: null, changed: false };
  const fields = s.form !== null ? (app.agent!.forms[s.form]?.fields ?? []) : [];
  const locale = slotLocaleOf(s);
  for (const v of values) {
    const field = fields.find((f) => f.name === v.field);
    if (field === undefined) {
      record.values.push({ field: v.field, outcome: 'field' });
      continue;
    }
    const spec = app.slots[field.slot] as BuiltSlotSpec | undefined;
    const check: ValueCheck = spec?.check !== undefined ? spec.check(v.value, v.words, said, { today: tc.todayIso, ...(locale !== undefined ? { locale } : {}) }) : { ok: false, reason: 'unsupported' };
    if (!check.ok) {
      record.values.push({ field: field.name, slot: field.slot, outcome: check.reason });
      out.events.push({ slot: field.slot, outcome: { kind: 'invalid', reason: `agent-${check.reason}`, raw: '' } });
      out.refused ??= field.slot;
      continue;
    }
    const slot = s.slots[field.slot]!;
    if (slot.value !== check.value) out.changed = true;
    Object.assign(slot, { value: check.value, display: check.shown, confirmed: false, window: null, by: 'agent' as const });
    delete slot.declined;
    delete slot.missed;
    record.values.push({ field: field.name, slot: field.slot, outcome: 'accepted', shown: check.shown });
    out.events.push({ slot: field.slot, outcome: { kind: 'filled', value: check.value, display: check.shown, confidence: 1, confirm: 'none' } });
  }
  return out;
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
  const record: AgentTurnRecord = {
    ms: agent.ms,
    use: answer !== null ? 'used' : 'failed',
    ...(agent.ok ? {} : { fallback: agent.reason, detail: agent.detail }),
    values: [],
    action: answer?.action ?? NO_ACTION,
    ...(answer !== null ? { fromFacts: answer.fromFacts } : {}),
    replySaid: false,
  };
  io.agent = record;
  // Two failures in a row on a call end it with the handoff line; an answer read resets the count.
  const conversation = s.agent?.conversation ?? [];
  const failures = answer !== null ? 0 : (s.agent?.failures ?? 0) + 1;
  s.agent = { conversation, failures };
  const action = record.action;
  const actionDone = (outcome: 'taken' | 'ignored'): void => {
    if (action !== NO_ACTION) record.actionOutcome = outcome;
  };

  // A callback asked for: the person form, as a person asked for is (App.personForm).
  if (action === CALLBACK_ACTION) {
    const person = steps.personForm(s, 'live-agent', answers, ctx, io);
    if (person !== null) {
      actionDone('taken');
      return person;
    }
  }

  // 1. At a read-back.
  if (pc !== null && pc.target === 'form') return atReadBack(s, verdict, answers, ctx, io, steps, said, pc, record, actionDone);

  // 2. A form opened.
  const acks: Ack[] = [];
  let opened = false;
  if (s.form === null) {
    const want = verdict.kind === 'route' && isFormIntent(app, verdict.intent) ? verdict.intent : formForValues(app, s, (answer?.values ?? []).map((v) => v.field));
    if (want !== null) opened = openForm(app, s, want, acks) !== null || acks.length > 0;
  }

  // 3. Values.
  const applied = applyValues(app, s, answer?.values ?? [], said, io.tc, record);
  const form = s.form;
  // Understood nothing (no value, no action, nothing from the facts), on a turn that opened nothing: a miss,
  // which speech over a line sets aside (core/turn.ts overLineMiss).
  if (answer !== null && answer.values.length === 0 && action === NO_ACTION && !answer.fromFacts && !opened) io.missed = true;

  let decision: Decision;
  if (applied.refused !== null) {
    // A value its slot type refused: dropped, and its field's question asked in fixed words.
    actionDone('ignored');
    decision = prompt(`ask_${applied.refused}`, applied.refused, {}, acks);
  } else if (form !== null && requiredFilled(app, s, form)) {
    // 4. Every required field filled: the read-back, in the business's fixed words.
    actionDone(action === SUBMIT_ACTION ? 'taken' : 'ignored');
    decision = steps.askSummary(s, form, acks, io);
  } else if (form !== null) {
    // 5. The reply, in place of the core's own next question; any other next step of the core's is said instead.
    actionDone('ignored');
    const next = steps.continueForm(s, io, acks, null);
    decision = plainQuestion(app, next, form) ? withReply(next, answer?.reply ?? null, record) : next;
  } else {
    actionDone('ignored');
    decision = withReply(prompt('ask_intent', 'intent', {}, acks), answer?.reply ?? null, record);
  }
  // 7. A second failure in a row where the turn needed the answer: the handoff line.
  if (answer === null && failures >= 2) decision = handoff(s, 'system-failure', acks);
  return { decision, events: applied.events };
}

/** The read-back's turn (step 1 at the top). */
function atReadBack(s: Session, verdict: Verdict, answers: AnswerMap, ctx: SlotContext, io: TurnIO, steps: ScriptedSteps, said: string, pc: Extract<PendingConfirmation, { target: 'form' }>, record: AgentTurnRecord, actionDone: (o: 'taken' | 'ignored') => void): Handled {
  const app = io.app;
  const answer = io.tc.agent?.ok === true ? io.tc.agent.answer : null;
  const applied = applyValues(app, s, answer?.values ?? [], said, io.tc, record);
  // Nothing proposed is done here: the yes completes the form, and its then is the completion's.
  actionDone('ignored');
  if (applied.refused !== null) {
    // A correction its slot type refused: the read-back is set aside, and the field asked again in fixed words.
    s.pendingConfirmation = null;
    s.pendingHash = null;
    return { decision: prompt(`ask_${applied.refused}`, applied.refused, {}, []), events: applied.events };
  }
  // A correction ("no, it's two"): stored, and the read-back said again with it.
  if (applied.changed) return { decision: steps.askSummary(s, pc.form, [], io), events: applied.events };
  // The yes, with nothing changed: the form completes through its engine-written complete hook.
  if (verdict.kind === 'confirmed') return steps.handleVerdict(s, verdict, answers, ctx, io);
  if (verdict.kind === 'rejected') {
    // A no with nothing more: what to change; a second asks the read-back again, on its ladder.
    return { decision: pc.askedChange === true ? steps.reaskConfirmation(s, io) : steps.askChange(pc, []), events: applied.events };
  }
  // Asked what to change, and answered with no value yet ("the day"): the reply, in place of the question again.
  if (pc.askedChange === true && answer !== null) {
    return { decision: withReply(prompt('ask_change', 'confirm', {}, []), answer.reply, record), events: applied.events };
  }
  return { decision: steps.reaskConfirmation(s, io), events: applied.events };
}

/**
 * The conversation kept for the agent model (Session.agent), after a turn of an app in agent mode said
 * `decision`: the caller's words where the turn took them (not a quarantined turn's), then what the line
 * said. Nothing for a turn that says nothing.
 */
export function noteConversation(s: Session, event: SessionEvent, decision: Decision, took: boolean): void {
  if (appOf(s).mode !== 'agent' || decision.kind === 'ignore' || decision.kind === 'hold') return;
  const conversation = [...(s.agent?.conversation ?? [])];
  if (took && (event.type === 'user.speech' || event.type === 'user.text') && event.text.trim() !== '') conversation.push({ who: 'caller', text: event.text });
  const line = spokenText(appOf(s), decision, s.locale, { shown: !s.caps.speech });
  if (line.trim() !== '') conversation.push({ who: 'line', text: line });
  s.agent = { conversation: conversation.slice(-AGENT_CONVERSATION_KEPT), failures: s.agent?.failures ?? 0 };
}
