import type { App, Completion, CompletionContext, SlotId, ToolDef, ToolName } from '../core/app/types';
import { appOf } from '../core/app/registry';
import { offerTransfer } from '../core/decision';
import type { Ack } from '../core/fia';
import type { KbSource } from '../core/lifecycle';
import { defaultLocaleOf } from '../core/locale';
import type { Session } from '../core/session';
import type { TurnContext } from '../core/turn';
import { isAnonymous } from '../gate/types';
import { VAR } from '../prompts/segments';
import { collapseWhitespace } from './hash';
import { kbAuditRow, kbSourceOf } from './record';
import { resolvePassage } from './resolve';
import type { AppKnowledge, KbAnswer, KbPassage, KnowledgeBase } from './types';

/**
 * Speaking an answer from the knowledge base: the knowledge completion a form gives (kbCompletion,
 * or forms.yaml `answers:`), and the resolving tool an app with a kb/ folder gives (kbAnswerTool).
 *
 * The answer is a passage's approved text, said word for word through the answer line ("{answer}");
 * nothing in it is generated. A completion reads it through the gate (the resolving tool reads the
 * caller's facts from the system of record, never from what the caller said), may add the topic's
 * account line (a second gated read, of the caller's own data; dropped when that read is refused or
 * comes back without the values the line needs), and records the passage (TurnOut.kb). When there is
 * none to say (none in force, stale, no translation, nothing the tool could read), the unavailable
 * line is said and a person offered, once per call.
 */

/** The line an answer is said through, by default: its text is "{answer}". */
export const KB_ANSWER_PROMPT = 'kb_answer';
/** The line said when there is no answer to give, by default: a neutral line ("I don't have an answer to that I can give you right now."). */
export const KB_UNAVAILABLE_PROMPT = 'kb_unavailable';
/** The variable the answer line says the answer (and its account line) in. */
export const KB_ANSWER_VAR = 'answer';
/** The param the resolving tool and an account line's tool are given the topic in. */
export const KB_TOPIC_PARAM = 'topic';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A resolving tool's value as the completion reads it: an answer (non-empty text, with its record,
 * which must say it is fresh), or why there is none. Anything else (null, another shape, an answer
 * whose record says it is not fresh) is no answer: the completion fails closed.
 */
export function readKbAnswer(value: unknown): KbAnswer {
  if (!isObject(value)) return { unavailable: 'no-answer' };
  const source = isKbSource(value.source) ? value.source : undefined;
  if (typeof value.answer === 'string' && value.answer.trim() !== '' && source !== undefined) {
    return source.fresh === true ? { answer: value.answer, source } : { unavailable: 'stale', source };
  }
  if (typeof value.unavailable === 'string' && value.unavailable !== '') return { unavailable: value.unavailable, ...(source ? { source } : {}) };
  return { unavailable: 'no-answer' };
}

function isKbSource(v: unknown): v is KbSource {
  return isObject(v) && typeof v.passageId === 'string' && typeof v.topic === 'string' && typeof v.version === 'string' && typeof v.fresh === 'boolean';
}

/** The id of the session's caller when they are one of the app's subjects; '' for anyone else (the scope rule refuses them). */
function subjectIdOf(app: App, s: Session): string {
  if (!app.identity || isAnonymous(s.principal)) return '';
  return s.principal.kind === app.identity.subjectKind ? s.principal.id : '';
}

/**
 * The params a knowledge read through `tool` carries: the subject's id under the param the tool's
 * scope rule names (PolicyTables.subjects), when the app verifies callers and the rule names one by
 * id, then the topic. The gate decides what they may read; the tool reads the facts from its systems.
 */
export function kbCallParams(app: App, s: Session, tool: ToolName, topic: string): Record<string, string> {
  const params: Record<string, string> = {};
  const subject = Object.hasOwn(app.policy.subjects, tool) ? app.policy.subjects[tool] : undefined;
  if (app.identity && subject !== undefined && subject.via !== 'record') params[subject.param] = subjectIdOf(app, s);
  params[KB_TOPIC_PARAM] = topic;
  return params;
}

/** A topic's account line in a locale: its text there and the tool it reads through, or null when it has none there. */
export function accountLineOf(knowledge: AppKnowledge | undefined, topic: string, locale: string, defaultLocale: string): { text: string; from: string } | null {
  const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
  if (knowledge === undefined) return null;
  if (knowledge.kb !== undefined) {
    const t = Object.hasOwn(knowledge.kb.topics, topic) ? knowledge.kb.topics[topic]! : undefined;
    const line = t?.accountLine;
    if (!t || !line) return null;
    if (same(locale, knowledge.kb.defaultLocale)) return line;
    const wording = Object.entries(t.locales).find(([tag]) => same(tag, locale))?.[1];
    return wording?.accountLineText !== undefined ? { text: wording.accountLineText, from: line.from } : null;
  }
  const line = knowledge.topics.find((t) => t.id === topic)?.accountLine;
  if (!line) return null;
  if (same(locale, defaultLocale)) return { text: line.text, from: line.from };
  const text = Object.entries(line.texts ?? {}).find(([tag]) => same(tag, locale))?.[1];
  return text !== undefined ? { text, from: line.from } : null;
}

/**
 * The account line with its variables filled from the fields of the tool's result (as the gate let
 * the caller see it: a field the policy withheld is null), or null when a variable has no value
 * (missing, null, empty, or not a plain value): the line is never said with a gap in it.
 */
export function fillAccountLine(text: string, value: unknown): string | null {
  if (!isObject(value)) return null;
  let gap = false;
  const filled = text.replace(VAR, (_match, name: string) => {
    const v = Object.hasOwn(value, name) ? value[name] : undefined;
    if ((typeof v === 'string' && v.trim() !== '') || (typeof v === 'number' && Number.isFinite(v))) return String(v);
    gap = true;
    return '';
  });
  return gap ? null : collapseWhitespace(filled);
}

/** What a knowledge completion is: the topic slot it answers, the action that resolves it, and the two lines it says. */
export interface KbCompletionOptions {
  /** The form's topic slot: its value is the topic the caller asked about. */
  readonly slot: SlotId;
  /** The gated action that resolves the answer, returning a KbAnswer. Default: the knowledge base's own (kb.yaml `action`). */
  readonly via?: ToolName;
  /** The line the answer is said through; it says `{answer}`. Default KB_ANSWER_PROMPT (`kb_answer`). */
  readonly answer?: string;
  /** The line said when there is no answer to give. Default KB_UNAVAILABLE_PROMPT (`kb_unavailable`). */
  readonly unavailable?: string;
}

/** The action a knowledge completion resolves through: its own `via`, else the knowledge base's. */
function resolvingAction(app: App, via: ToolName | undefined): ToolName | null {
  return via ?? app.knowledge?.kb?.settings.action ?? null;
}

/**
 * The unavailable line, and a person offered in place of the form's answer, once per call: a caller
 * who has turned a person down on this call is not offered one again, and the form ends unanswered
 * (`refused`, uncounted). Declining the offer finishes the form (PendingConfirmation `after`).
 */
function unavailableCompletion(c: CompletionContext, promptId: string): Completion {
  const { s } = c;
  const acks: Ack[] = [...c.acks, { promptId, vars: {} }];
  if (s.transferDeclined) return { kind: 'refused', acks };
  s.pendingConfirmation = s.form !== null ? { target: 'transfer', attempts: 0, after: s.form } : { target: 'transfer', attempts: 0 };
  return { kind: 'decision', decision: offerTransfer(acks) };
}

/**
 * A form's completion that says an answer from the knowledge base (forms.yaml `answers:`, or a
 * form's `complete` hook that delegates to it):
 *
 *   complete: kbCompletion({ slot: 'topic' })
 *   complete: kbCompletion({ slot: 'subject', via: 'lookUpAnswer', answer: 'subject_answer', unavailable: 'subject_unavailable' })
 *
 * In order:
 *  1. the resolving action (`via`, else kb.yaml's `action`) through the gate, with the subject's id
 *     where its scope rule names one, and the topic (kbCallParams); a refusal is the engine's (its
 *     line, or a person);
 *  2. its value read as a KbAnswer (readKbAnswer: anything else is no answer);
 *  3. an answer: its record is the turn's (TurnOut.kb); when the topic has an account line in the
 *     answer's language, its tool through the gate (the same params), its variables filled from the
 *     result's fields; a refused read, or one without every value the line needs, leaves the line
 *     out. The answer line says `{answer}`: the passage's text, then the account line after a space;
 *  4. none: the record of a withheld passage, when the tool gives one, is the turn's; the
 *     unavailable line is said and a person offered, once per call.
 */
export function kbCompletion(opts: KbCompletionOptions): (c: CompletionContext) => Completion {
  const answerPrompt = opts.answer ?? KB_ANSWER_PROMPT;
  const unavailablePrompt = opts.unavailable ?? KB_UNAVAILABLE_PROMPT;
  return (c) => {
    const { s } = c;
    const app = appOf(s);
    const tool = resolvingAction(app, opts.via);
    // An app that names no action and has no knowledge base of its own has nothing to read the answer through.
    if (tool === null) return unavailableCompletion(c, unavailablePrompt);
    const topic = s.slots[opts.slot]?.value ?? '';
    const params = kbCallParams(app, s, tool, topic);
    const { decision, value } = c.callTool({ tool, params });
    if (decision.verdict !== 'ALLOW') return c.refusal(decision);
    const result = readKbAnswer(value);
    if (result.source !== undefined) c.out.kb = result.source;
    if (!('answer' in result)) return unavailableCompletion(c, unavailablePrompt);
    const defaultLocale = defaultLocaleOf(app);
    const locale = result.source.locale ?? s.locale ?? defaultLocale;
    let answer = result.answer;
    const line = accountLineOf(app.knowledge, result.source.topic, locale, defaultLocale);
    if (line !== null) {
      const read = c.callTool({ tool: line.from, params: kbCallParams(app, s, line.from, result.source.topic) });
      const filled = read.decision.verdict === 'ALLOW' ? fillAccountLine(line.text, read.value) : null;
      if (filled !== null) answer = `${answer} ${filled}`;
    }
    return { kind: 'said', acks: [...c.acks, { promptId: answerPrompt, vars: { [KB_ANSWER_VAR]: answer } }] };
  };
}

/** How kbAnswerTool reads what it needs beside the knowledge base. */
export interface KbAnswerToolOptions {
  /**
   * The param its calls name the subject by (the action's scope rule's `param`), when the facts are
   * a subject's: listed among the tool's params before `topic`. Without it, the tool's params are
   * `topic` alone.
   */
  readonly subject?: string;
  /**
   * The caller's facts for kb.yaml's applies domain, read by the app's code from its systems (never
   * from what the caller said): the call's params, the app's systems (App.systems `sys`) and the
   * turn. Null: there is no record to read them from (no answer, `no-facts`). Without it, no facts:
   * only a passage that applies to every caller answers.
   */
  readonly facts?: (params: Readonly<Record<string, string>>, systems: unknown, tc: TurnContext) => Readonly<Record<string, string | undefined>> | null;
  /** The language to answer in. Default: the session's, else the knowledge base's default. */
  readonly locale?: (s: Session) => string | undefined;
}

/** A passage's knowledge record for the caller's facts, naming its source document by its title. */
function recordOf(kb: KnowledgeBase, passage: KbPassage, facts: Readonly<Record<string, string | undefined>>, fresh: boolean): KbSource {
  const applies = Object.fromEntries(Object.entries(facts).filter((e): e is [string, string] => typeof e[1] === 'string'));
  const doc = Object.hasOwn(kb.sources, passage.source.document) ? kb.sources[passage.source.document] : undefined;
  return kbSourceOf(passage, { applies, fresh, ...(doc ? { document: doc.document } : {}) });
}

/**
 * The resolving tool of an app with a kb/ folder (its kb.yaml `action`): resolves the topic's
 * passage for the caller's facts, the day and the call's language (kb/resolve.ts), and returns a
 * KbAnswer: the passage's answer with its record, or why there is none (with the withheld passage's
 * record when it is stale). Its summary names the passage, or the reason; its audit rows are its
 * result and, for the turn's record, `kb_answer` (kbAuditRow). Its params are the subject param, if
 * any, and `topic`; policy.yaml records `topic` as declared under `audit:` (`topic: keep`).
 *
 *   tools: { findPassage: kbAnswerTool({ subject: 'cardNumber', facts: (p, sys) => (sys as Systems).cardFacts(p.cardNumber) }) }
 */
export function kbAnswerTool(opts: KbAnswerToolOptions = {}): ToolDef {
  return {
    params: [...(opts.subject !== undefined ? [opts.subject] : []), KB_TOPIC_PARAM],
    run(call, sys, { s, tc }) {
      const kb = appOf(s).knowledge?.kb;
      if (kb === undefined) return { value: { unavailable: 'no-answer' } satisfies KbAnswer, summary: 'no knowledge base' };
      const facts = opts.facts ? opts.facts(call.params, sys, tc) : {};
      if (facts === null) return { value: { unavailable: 'no-facts' } satisfies KbAnswer, summary: 'no passage (no-facts)' };
      const locale = opts.locale?.(s) ?? s.locale ?? kb.defaultLocale;
      const r = resolvePassage(kb, { topic: call.params[KB_TOPIC_PARAM] ?? '', facts, todayIso: tc.todayIso, locale });
      if ('fresh' in r) return { value: { answer: r.passage.answer, source: recordOf(kb, r.passage, facts, true) } satisfies KbAnswer, summary: r.passage.id };
      const value: KbAnswer = { unavailable: r.unavailable, ...(r.passage ? { source: recordOf(kb, r.passage, facts, false) } : {}) };
      return { value, summary: `no passage (${r.unavailable})` };
    },
    audit: ({ call, summary, kb }) => [{ type: 'tool_result', detail: { tool: call.tool, summary } }, ...(kb ? [kbAuditRow(kb)] : [])],
  };
}
