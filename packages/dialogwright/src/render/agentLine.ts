import { performance } from 'node:perf_hooks';
import type { Say } from '../channel/actions';
import { wordsOf, type SessionEvent } from '../channel/events';
import type { AuditDraft } from '../audit/types';
import { AGENT_SHAPE_KEYS } from '../agent/schema';
import { fieldValueSent } from '../agent/prompt';
import type { AgentField } from '../agent/types';
import { oneLine } from '../core/agentTurn';
import { appOf } from '../core/app/registry';
import type { App } from '../core/app/types';
import type { PromptDecision } from '../core/decision';
import type { Session } from '../core/session';
import type { TurnResult } from '../core/turn';
import { isNoul, type JevClient, type JevUsage, type JsonValue } from '../jev/types';
import { noteSaidLine, promptSay, promptText, saidLineOf, spokenText, type RenderContext } from '../prompts/render';
import { maskedConversation } from '../agent/history';
import { withReplies } from '../core/replies';
import type { SlotContext } from '../core/slots/types';
import { AGENT_DRIFT_QUESTION_ID, DATE_WORDS, DRIFT_FIRE, MAX_CHARS, digitRuns, foreignAddress, foreignFigure, renderAgentDriftQuestion, renderAgentDriftState, spelledNumbers, wordCount, words, type AgentUnderstood } from './checks';
import { keepChatExtras, withRenderAudit } from './turn';
import { DEFAULT_RENDER_CHECK_TIMEOUT_MS, type RenderFallback, type RenderJudge, type RenderLine } from './types';

/**
 * An agent line held to the facts (an app in agent mode; docs/designs/2026-11-08-agent-mode.md, "A turn",
 * step 3): the agent model's reply, said in place of its fixed line or before it (PromptDecision.agent),
 * passes the generated-wording checks and the drift judge, or its fixed line is said instead. No model is
 * asked to word it: the words are the agent's. Once the core has decided, as every generated line is held.
 *
 * The checks, each of the reply's data and shape, by code (render/checks.ts says why no check reads meaning):
 *
 * - `format`: over MAX_CHARS; on a call, markup or a line break (it is read aloud); in a chat, braces or
 *   angle brackets (a piece of a structure, or markup).
 * - `question`: more than one question.
 * - `shape`: a key of the answer's own shape (agent/schema.ts AGENT_SHAPE_KEYS) run into its words with no
 *   space ("What's your name?values"), or a key as the shape spells it (fromFacts): the answer's structure
 *   leaking into what is said. The keys are the schema's, never a list of words.
 * - `words`: over style.yaml's word budget on the channel.
 * - `avoid`: a phrase style.yaml says to avoid.
 * - `foreign`: a web address, or a figure (a number, an amount, a date word), that none of what the line
 *   holds has: the facts (what it may say, its fixed lines), the values understood (each as held and as
 *   shown, a date by its weekday and month, today and tomorrow) and the words each accepted value was cited
 *   from, a visible tool's result, and the turn's own fixed lines. Never the caller's own words: a figure the
 *   caller proposes is not the line's to agree to. A text value is no source of its own: it is the model's short version.
 * - `drift` (asked of the decision model once the rest pass; renderAgentDriftQuestion): the reply says
 *   something the business has not given its line to say: a claim, a promise, a service or an availability
 *   not held, speaking as a person the line is not, a value or availability confirmed that the engine has
 *   not confirmed, or the caller's words changed (a text value is held to the caller's words, as a framed
 *   summary is).
 *
 * A reply that fails one is not said: its fixed line is (a field's question, the open question, "What
 * should I change?"; for a reply said before the turn's own line, an aside, nothing), and the audit records
 * `render_fallback` with the check's name. The core's records of what was said (Session.lastPromptText, the
 * conversation kept for the agent model) and the decision traced are corrected to what was said.
 * A price is never worded at all: an answer that names the price line has it said whole by the core
 * (AgentAnswer.fixedLine, core/agentTurn.ts), and a reply with a figure the facts do not hold falls back here.
 */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/** How a date value may be said (its weekday, month and day, and today or tomorrow), so a reply saying it is not a figure of its own. */
export function dateWords(iso: string, today: string): string[] {
  const d = new Date(`${iso}T00:00:00Z`);
  const t = new Date(`${today}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return [];
  const days = Math.round((d.getTime() - t.getTime()) / 86_400_000);
  return [`${DAYS[d.getUTCDay()]!} ${MONTHS[d.getUTCMonth()]!} ${d.getUTCDate()}`, ...(days === 0 ? ['today'] : days === 1 ? ['tomorrow'] : [])];
}

/** The figures a caller's words give that a reply may say back: their numbers (in digits or in words, as digits) and their date words. */
export function callerFigures(text: string): string {
  return [...digitRuns(text), ...spelledNumbers(text), ...words(text).filter((w) => DATE_WORDS.has(w))].join(' ');
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether a reply says a piece of the answer's own shape: a key of it run into another word by the marks
 * the answer's JSON is written with (`?`, `!`, `.`, `:`, `,`, a quote, a brace or a bracket), no space
 * between ("name?values", 'reply:"Thanks"'), or written as the shape spells it, a capital inside it
 * (fromFacts). A key as a word of the language ("a few words", "the value/price", "two words—that is all")
 * passes.
 */
export function shapeLeak(text: string, keys: ReadonlySet<string> = AGENT_SHAPE_KEYS): boolean {
  const word = String.raw`[\p{L}\p{N}]`;
  for (const k of keys) {
    if (/\p{Lu}/u.test(k.slice(1)) && new RegExp(`(?<!${word})${escapeRegExp(k)}(?!${word})`, 'u').test(text)) return true;
  }
  const alt = [...keys].map(escapeRegExp).join('|');
  const before = new RegExp(`${word}[?!.:,"{}\\[\\]]+(?:${alt})(?!${word})`, 'iu');
  const after = new RegExp(`(?<!${word})(?:${alt})[:,"{}\\[\\]]+["{\\[]*${word}`, 'iu');
  // A key as the JSON writes it, quoted with its colon ('"values":').
  const quoted = new RegExp(`"(?:${alt})"\\s*:`, 'iu');
  return before.test(text) || after.test(text) || quoted.test(text);
}

/** What an agent reply is held to by code (checkAgentReply). */
export interface AgentReplyGuard {
  readonly channel: 'voice' | 'chat';
  /** The most words it may use on the channel (style.yaml's `words`). */
  readonly words: number;
  readonly avoid: readonly string[];
  /** Everything a figure or a web address in it may come from (agentFigureSources). */
  readonly sources: readonly string[];
}

const fold = (s: string): string => s.replace(/[‘’ʼ]/g, "'").toLowerCase().replace(/\s+/g, ' ').trim();

/** The first check an agent reply fails, or null when it passes them all (the drift judge aside). */
export function checkAgentReply(text: string, g: AgentReplyGuard): RenderFallback | null {
  if (text.trim() === '') return 'empty';
  if (text.length > MAX_CHARS) return 'format';
  if (g.channel === 'voice' ? /[\r\n]/.test(text) || /[*_#`<>{}[\]|\\]/.test(text) : /[<>{}]/.test(text)) return 'format';
  if ((text.match(/\?/g) ?? []).length > 1) return 'question';
  if (shapeLeak(text)) return 'shape';
  if (wordCount(text) > g.words) return 'words';
  const folded = fold(text);
  if (g.avoid.some((phrase) => folded.includes(fold(phrase)))) return 'avoid';
  if (foreignAddress(text, g.sources.join(' '))) return 'foreign';
  if (foreignFigure(text, g.sources)) return 'foreign';
  return null;
}

/** The held value of every field of the app's forms, by field: its slot's value and display, its type, and whether the caller confirmed it. */
function heldFields(app: App, s: Session): { field: string; slot: string; type: string; about?: string; value: string; display: string; confirmed: boolean }[] {
  const out: { field: string; slot: string; type: string; about?: string; value: string; display: string; confirmed: boolean }[] = [];
  for (const form of Object.values(app.agent?.forms ?? {})) {
    for (const f of form.fields) {
      const slot = s.slots[f.slot];
      if (slot === undefined || slot.value === null) continue;
      out.push({ field: f.name, slot: f.slot, type: f.type, ...(f.about !== undefined ? { about: f.about } : {}), value: slot.value, display: slot.display ?? slot.value, confirmed: slot.confirmed });
    }
  }
  return out;
}

/**
 * What a figure or a web address in an agent reply may come from: the facts (what the line may say, its
 * fixed lines), every value held but a text value (as held and as shown, a date with how it is said), the
 * words a digits or name value accepted this turn was cited from (tied to the value by its check), a visible tool's result, and
 * `fixed`, the turn's own fixed lines. Never the caller's own words: a figure the caller proposes ("is it
 * under a hundred?", "in two days?") is not the line's to state or agree to, as a generated line may not
 * state the caller's figure as its own (render/checks.ts allowedFigures; the review of Task 7).
 */
export function agentFigureSources(app: App, s: Session, today: string, opts: { cited?: readonly string[]; seen?: readonly { tool: string; result: unknown }[]; fixed?: readonly string[] } = {}): string[] {
  const facts = app.agent?.facts;
  const values = heldFields(app, s).filter((f) => f.type !== 'text').flatMap((f) => [f.value, f.display, ...(f.type === 'date' ? dateWords(f.value, today) : [])]);
  return [
    ...(facts?.says ?? []),
    ...Object.values(facts?.fixed ?? {}),
    ...values,
    ...(opts.cited ?? []),
    ...(opts.seen ?? []).map((x) => JSON.stringify(x.result) ?? ''),
    ...(opts.fixed ?? []),
  ].filter((x) => x.trim() !== '');
}

/**
 * The figures of a text value that are both in the value as held and in the words it was cited from, as one
 * source (the review of wheelshop): a figure the caller said outside the value's own words stays no source.
 */
export function textValueFigures(held: string, words: string): string {
  const cited = new Set([...digitRuns(words), ...spelledNumbers(words)]);
  return [...new Set([...digitRuns(held), ...spelledNumbers(held)].filter((n) => cited.has(n)))].join(' ');
}

/** The slot types whose values' cited words are a source of figures: those whose check ties the value to its words. */
const CITED_TYPES: ReadonlySet<string> = new Set(['digits', 'name']);

/** A field's slot type, by its slot, in any of the app's forms (text where none has it: no source of figures). */
function typeOfSlot(app: App, slot: string | undefined): string {
  for (const form of Object.values(app.agent?.forms ?? {})) {
    const f = form.fields.find((x) => x.slot === slot);
    if (f !== undefined) return f.type;
  }
  return 'text';
}

/** What the agent line is held with, on its turn. */
export interface AgentLineInput {
  /** The turn as the core decided it. */
  result: TurnResult;
  /** The turn's event, as the core saw it. */
  event: SessionEvent;
  /** The decision model client the drift judge asks (RunOptions.renderer's `drift`, else the run's own). */
  judge: JevClient;
  /** How long the judge may take, per channel (RENDER_CHECK_TIMEOUT_MS); default DEFAULT_RENDER_CHECK_TIMEOUT_MS. */
  checkTimeoutMs?: { voice: number; chat: number };
  /** The run's recorded clips: a fallback is said as its fixed line is. */
  clips?: RenderContext | null;
  /** The checked results of the tools the app lets the model see, as it was sent them. */
  seen?: readonly { tool: string; result: unknown }[];
  /** Today, ISO: a date value's weekday and month as a reply may say them. */
  todayIso: string;
  /** What a slot's chat buttons are read from (core/turn.ts slotContext), for the fixed line said in a reply's place; absent, a slot's own buttons are not given. */
  slotContext?: () => SlotContext;
}

/** The turn with its agent line held: said, or replaced by its fixed line and the records corrected; what the judge cost, and how long it all took. */
export interface HeldAgentLine {
  result: TurnResult;
  usage: JevUsage | null;
  ms: number;
}

/** A decision without its agent line: what is said where the reply is not. */
function withoutReply(d: PromptDecision): PromptDecision {
  const { agent: _reply, ...rest } = d;
  return rest;
}

/**
 * The turn's agent line held to the facts (see the top): null for a turn that says none (every turn of an
 * app not in agent mode, and every agent turn whose reply the core did not say).
 */
export async function holdAgentLine(input: AgentLineInput): Promise<HeldAgentLine | null> {
  const { result, event } = input;
  const d = result.decision;
  if (d.kind !== 'prompt' || d.agent === undefined) return null;
  const app = appOf(result.session);
  if (app.agent === undefined) return null;
  const index = result.actions.findIndex((a) => a.type === 'say' && saidLineOf(a)?.agent !== undefined);
  if (index === -1) return null;
  const t0 = performance.now();
  const session = result.session;
  const channel = session.caps.speech ? 'voice' : 'chat';
  const shown = { shown: !session.caps.speech };
  const reply = d.agent.reply;
  const aside = d.agent.aside === true;
  const fixedDecision = withoutReply(d);
  // What the line says where the reply is not: the prompt it stands in for; before the turn's own line (an aside), nothing.
  const fixed = aside ? '' : promptText(app, d.promptId, d.vars, session.locale, shown);
  const style = app.agent.style;
  const refuseAt = style.refuseAt ?? DRIFT_FIRE;
  const accepted = result.agent?.values.filter((v) => v.outcome === 'accepted') ?? [];
  const heard = wordsOf(event);
  const base = { index, promptId: d.promptId, fixed, act: aside ? ('acknowledge' as const) : ('ask' as const), situations: [], source: 'agent' as const };

  let usage: JevUsage | null = null;
  const attempt = async (): Promise<{ said: true; judge: RenderJudge } | { fallback: RenderFallback | 'screen'; judge?: RenderJudge }> => {
    // A reply written from words the injection screen flagged or did not read is never said.
    if (heard !== null && (result.screen === null || result.screen.fired || result.screen.error !== null || result.quarantined)) return { fallback: 'screen' };
    const sources = agentFigureSources(app, session, input.todayIso, {
      // A digits or name value's cited words are tied to it (its check holds them to it); a choice's or a date's are
      // not (a synonym, "Thursday"), so only its held value and display are sources (the review of Task 8).
      cited: [
        ...accepted.filter((v) => CITED_TYPES.has(typeOfSlot(app, v.slot))).map((v) => v.words),
        // A text value's figure, where it is both in the value as held and in the words it was cited from
        // ("2020 BMW 3 Series" from "it's a 2020 BMW 3 Series"): the caller's own, kept in what the line understood.
        ...accepted.filter((v) => typeOfSlot(app, v.slot) === 'text').map((v) => textValueFigures(session.slots[v.slot as string]?.value ?? '', v.words)),
      ],
      seen: input.seen ?? [],
      fixed: [spokenText(app, fixedDecision, session.locale, shown)],
    });
    const failed = checkAgentReply(reply, { channel, words: style.words[channel], avoid: style.avoid, sources });
    if (failed !== null) return { fallback: failed };
    const cited = new Map(accepted.map((v) => [v.field, v.words]));
    const understood: AgentUnderstood[] = heldFields(app, session).map((f) => {
      const redact = app.slots[f.slot]?.redact as AgentField['redact'];
      const words = cited.get(f.field);
      return {
        field: f.field,
        ...(f.about !== undefined ? { about: f.about } : {}),
        value: fieldValueSent({ value: f.display, ...(redact !== undefined ? { redact } : {}) }),
        ...(f.type === 'text' ? { summary: true as const, ...(words !== undefined ? { words } : {}) } : {}),
        confirmed: f.confirmed,
      };
    });
    const state = renderAgentDriftState(reply, {
      speaks: `the automated line of ${app.agent!.facts.name}, speaking with a caller ${channel === 'voice' ? 'on a phone call' : 'in a web chat'}`,
      ...(aside ? { then: spokenText(app, fixedDecision, session.locale, shown) } : {}),
      maySay: app.agent!.facts.says,
      background: app.agent!.facts.background,
      fixedLines: Object.values(app.agent!.facts.fixed),
      understood,
      seen: input.seen ?? [],
      conversation: judgedHistory(app, session, heard, oneLine(spokenText(app, d, session.locale, shown))),
      ...(heard !== null ? { heard } : {}),
    });
    const budget = (input.checkTimeoutMs ?? DEFAULT_RENDER_CHECK_TIMEOUT_MS)[channel];
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), budget);
    });
    try {
      const r = await Promise.race([input.judge.ask({ state: state as unknown as JsonValue, questions: renderAgentDriftQuestion(), timeoutMs: budget, signal: abort.signal }), late]);
      if (r === 'late') return { fallback: 'timeout' };
      usage = r.usage;
      const a = r.answers[AGENT_DRIFT_QUESTION_ID];
      if (!isNoul(a)) return { fallback: 'drift-error' };
      // The judge's reading, kept on the line whether it passed or refused it (RenderLine.judge).
      const judge: RenderJudge = { score: a.noul, refuseAt };
      return a.noul >= refuseAt ? { fallback: 'drift', judge } : { said: true, judge };
    } catch {
      return { fallback: 'drift-error' };
    } finally {
      clearTimeout(timer);
      abort.abort();
    }
  };
  const got = await attempt();
  const ms = performance.now() - t0;
  if ('said' in got) {
    const line: RenderLine = { ...base, mode: 'generated', said: reply, ms, judge: got.judge };
    return { result: { ...result, ...(result.agent !== undefined ? { agent: { ...result.agent, line } } : {}) }, usage, ms };
  }
  // The fixed line in the reply's place, or before the turn's own line nothing; the records say what was said.
  const actions = [...result.actions];
  if (aside) actions.splice(index, 1);
  else {
    const was = actions[index] as Say;
    const instead = keepChatExtras(was, promptSay(app, d.promptId, { ...d.vars }, was.interruptible, input.clips ?? null, session.locale, undefined, shown));
    // The fixed line is the prompt's own, as any line decisionToActions makes, with its chat buttons (app.yaml's chat.replies).
    noteSaidLine(instead, { promptId: d.promptId, vars: d.vars, role: 'ask' });
    actions[index] = instead;
    if (index === actions.length - 1 && input.slotContext !== undefined) withReplies(app, fixedDecision, actions, { shown: shown.shown, locale: session.locale, ctx: input.slotContext });
  }
  const line: RenderLine = {
    ...base,
    mode: 'fixed',
    ms,
    ...(got.fallback === 'screen' ? { skipped: 'screen' as const } : { fallback: got.fallback, refused: reply }),
    ...(got.judge !== undefined ? { judge: got.judge } : {}),
  };
  const audit: AuditDraft[] = [{ type: 'render_fallback', detail: { prompt: d.promptId, reason: got.fallback, agent: true } }];
  return {
    result: {
      ...result,
      decision: fixedDecision,
      actions,
      session: correctedSession(app, session, d, fixedDecision),
      audit: withRenderAudit(result.audit, audit),
      ...(result.agent !== undefined ? { agent: { ...result.agent, replySaid: false, line } } : {}),
    },
    usage,
    ms,
  };
}

/**
 * The call before this turn as the drift judge is told it, as the agent model is sent it (agent/history.ts):
 * the conversation kept, without this turn's own words and line (the words are quoted apart, the line is
 * what is judged): only the line this turn noted (`noted`, its words as said) is taken off, never an earlier
 * one; each value the records hide masked once understood.
 */
export function judgedHistory(app: App, s: Session, heard: string | null, noted: string): { who: 'caller' | 'line'; text: string }[] {
  const conversation = [...(s.agent?.conversation ?? [])];
  const end = conversation.at(-1);
  if (end?.who === 'line' && end.text === noted) conversation.pop();
  const last = conversation.at(-1);
  if (heard !== null && last?.who === 'caller' && last.text === oneLine(heard)) conversation.pop();
  const fields = Object.values(app.agent?.forms ?? {}).flatMap((f) => f.fields.map((x) => x.slot));
  return maskedConversation(app, s.slots, fields, conversation);
}

/**
 * The session with the core's records of what was said put right after an agent line fell back: the line
 * just said (lastPromptText, which a repeat says again) and the conversation's last line, which the agent
 * model is sent next turn. Nothing else of it changes.
 */
function correctedSession(app: App, s: Session, said: PromptDecision, instead: PromptDecision): Session {
  const shown = { shown: !s.caps.speech };
  const was = oneLine(spokenText(app, said, s.locale, shown));
  const now = spokenText(app, instead, s.locale, shown);
  const conversation = [...(s.agent?.conversation ?? [])];
  const last = conversation.at(-1);
  if (last !== undefined && last.who === 'line' && last.text === was) conversation[conversation.length - 1] = { who: 'line', text: oneLine(now) };
  return { ...s, lastPromptText: now, ...(s.agent !== undefined ? { agent: { ...s.agent, conversation } } : {}) };
}
