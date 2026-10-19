import type { App, Completion, CompletionContext, SlotId, ToolDef, ToolName } from '../core/app/types';
import { appOf } from '../core/app/registry';
import { offerTransfer, type Decision } from '../core/decision';
import type { Ack } from '../core/fia';
import type { KbSource, TurnOut } from '../core/lifecycle';
import { defaultLocaleOf } from '../core/locale';
import type { Session } from '../core/session';
import type { TurnContext } from '../core/turn';
import { isAnonymous } from '../gate/types';
import { VAR } from '../prompts/segments';
import { answerSpanOf, DEFAULT_DOCUMENTS_WORDS, KB_ACCOUNT_VAR, KB_QUESTION_VAR } from '../render/config';
import { collapseWhitespace } from './hash';
import { documentsSourceOf, kbAuditRow, kbSourceOf } from './record';
import { resolveSections, sectionKeysOf, sentencesOf } from './sectionTexts';
import { nextWording } from '../core/wordings';
import { localePromptEntry } from '../prompts/render';
import { resolvePassage } from './resolve';
import type { AppKnowledge, KbAnswer, KbPassage, KnowledgeBase } from './types';

/**
 * Speaking an answer from the knowledge base: the knowledge completion a form gives (kbCompletion,
 * or forms.yaml `answers:`), the resolving tool an app with a kb/ folder gives (kbAnswerTool), and
 * an informational intent's passage (informationalAnswer, intents.yaml `passage:`).
 *
 * The answer is a passage's approved text, said word for word through the answer line ("{answer}");
 * nothing in it is generated, unless the app frames the answer line with a span worded from the answer
 * (`from: answer`) and marks the topic `risk: low`: then a model may word the passage for the caller's
 * question, held to it by the checks and the drift judge, and the passage is said whenever one fails
 * (render/turn.ts). A completion reads it through the gate (the resolving tool reads the
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
/** The line an answer from documents is said through (kb.yaml documents), unless forms.yaml's answers.documents names another. */
export const KB_DOCUMENTS_ANSWER_PROMPT = 'kb_documents_answer';
/** The line said when nothing answers (a question no topic or section answers, or an answer from documents that cannot be worded); rotates through its variants. */
export const KB_NOT_FOUND_PROMPT = 'kb_not_found';
/** The frame of a section's opening sentences said in place of an answer from documents that cannot be worded (onFail: opening, or lines), with {opening}. */
export const KB_DOCUMENTS_OPENING_PROMPT = 'kb_documents_opening';
/** The variable an answer from documents carries its sections' text in, beside {answer} (the line's fallback): what the wording is drawn from, never said as it is. */
export const KB_SOURCE_VAR = 'answerSource';
/** The variable an answer from documents carries its sections' lines in, one a line (onFail: lines): those the decision model says answer the question are said in place of the opening when it cannot be worded; never said as it is. */
export const KB_LINES_VAR = 'answerLines';
/** The variable beside KB_LINES_VAR that carries the heading of each line's section, one a line, in the same order: the picker reads each line under it, and the lines chosen are said under it. */
export const KB_LINE_HEADINGS_VAR = 'answerLineHeadings';
/** The variable an answer line carries the wording of its hold line in (kb_hold, rotating): the hold line said if its wording is late. */
export const KB_HOLD_VAR = 'answerHold';
/** The variable an answer line carries the wording of its second hold line in (kb_hold_more, rotating), where the app has it. */
export const KB_HOLD_MORE_VAR = 'answerHoldMore';
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
    if (source.fresh !== true) return { unavailable: 'stale', source };
    const strings = (v: unknown): string[] | undefined => (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined);
    const sentences = strings(value.sentences);
    const sections = Array.isArray(value.sections) && value.sections.length > 0 && value.sections.every((x) => isObject(x) && typeof x.heading === 'string' && strings(x.sentences) !== undefined)
      ? (value.sections as { heading: string; sentences: string[] }[]).map((x) => ({ heading: x.heading, sentences: x.sentences }))
      : undefined;
    return { answer: value.answer, source, ...(sentences !== undefined ? { sentences } : {}), ...(sections !== undefined ? { sections } : {}) };
  }
  if (typeof value.unavailable === 'string' && value.unavailable !== '') return { unavailable: value.unavailable, ...(source ? { source } : {}) };
  return { unavailable: 'no-answer' };
}

function isKbSource(v: unknown): v is KbSource {
  return isObject(v) && typeof v.passageId === 'string' && typeof v.topic === 'string' && typeof v.version === 'string' && typeof v.fresh === 'boolean';
}

/**
 * The id of the subject a knowledge read is about: the session's caller when they are one of the app's
 * subjects; for anyone else who is not anonymous (a delegate), the value of the slot that names the
 * subject (KbCompletionOptions.subject), if any; '' otherwise (the scope rule refuses them).
 */
function subjectIdOf(app: App, s: Session, subjectSlot?: SlotId): string {
  if (!app.identity || isAnonymous(s.principal)) return '';
  if (s.principal.kind === app.identity.subjectKind) return s.principal.id;
  return subjectSlot !== undefined ? (s.slots[subjectSlot]?.value ?? '') : '';
}

/**
 * The params a knowledge read through `tool` carries: the subject's id under the param the tool's
 * scope rule names (PolicyTables.subjects), when the app verifies callers and the rule names one by
 * id, then the topic. For a caller who is not a subject, the subject is the one `subjectSlot` names
 * (forms.yaml `answers.subject`). The gate decides what they may read; the tool reads the facts from
 * its systems.
 */
export function kbCallParams(app: App, s: Session, tool: ToolName, topic: string, subjectSlot?: SlotId): Record<string, string> {
  const params: Record<string, string> = {};
  const subject = Object.hasOwn(app.policy.subjects, tool) ? app.policy.subjects[tool] : undefined;
  if (app.identity && subject !== undefined && subject.via !== 'record') params[subject.param] = subjectIdOf(app, s, subjectSlot);
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
  /**
   * The form's slot that names the subject the answer is about, for a caller who is not a subject (a
   * delegate, asked it by the slot's askedOf): its value is the subject param of the reads (kbCallParams),
   * and the gate's scope rule decides. A subject is always answered about themselves. Without it, a
   * caller who is not a subject is answered about no one.
   */
  readonly subject?: SlotId;
  /**
   * An answer from documents (kb.yaml documents): the line it is said through (default
   * kb_documents_answer), and what is said when it cannot be worded (`onFail`: `not-found`, the default,
   * the not-found line; `opening`, the best section's opening sentences, word for word).
   */
  readonly documents?: { readonly answer?: string; readonly onFail?: 'not-found' | 'opening' | 'lines' };
}

/** The action a knowledge completion resolves through: its own `via`, else the knowledge base's. */
function resolvingAction(app: App, via: ToolName | undefined): ToolName | null {
  return via ?? app.knowledge?.kb?.settings.action ?? null;
}

/**
 * The unavailable line, and a person offered in place of the form's answer, once per call: a caller
 * who has turned a person down on this call is not offered one again, and the form ends unanswered
 * (`refused`, uncounted). Declining the offer finishes the form (PendingConfirmation `after`); a
 * yes, plain or "yes, connect me to a person", is a handoff for a person (`why: 'no-answer'`: `live-agent`).
 */
function unavailableCompletion(c: CompletionContext, promptId: string): Completion {
  const { s } = c;
  const acks: Ack[] = [...c.acks, { promptId, vars: {} }];
  if (s.transferDeclined) return { kind: 'refused', acks };
  s.pendingConfirmation = s.form !== null ? { target: 'transfer', attempts: 0, after: s.form, why: 'no-answer' } : { target: 'transfer', attempts: 0, why: 'no-answer' };
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
    const params = kbCallParams(app, s, tool, topic, opts.subject);
    const { decision, value } = c.callTool({ tool, params });
    if (decision.verdict !== 'ALLOW') return c.refusal(decision);
    const result = readKbAnswer(value);
    if (result.source !== undefined) c.out.kb = result.source;
    if (!('answer' in result)) return unavailableCompletion(c, unavailablePrompt);
    // An answer said: the not-found replies in a row start again (core/turn.ts notFoundReply).
    if (s.kbNotFound !== undefined) s.kbNotFound = { ...s.kbNotFound, row: 0 };
    // An answer from sections of approved documents (kb.yaml documents): the line's fixed text is what is
    // said when it cannot be worded (onFail: the not-found line, or the best section's opening), and the
    // sections go beside it, for the wording alone (render/turn.ts).
    if (result.source.from === 'documents') {
      const line = opts.documents?.answer ?? KB_DOCUMENTS_ANSWER_PROMPT;
      const heard = s.slots[opts.slot]?.heard;
      const budget = answerSpanOf(app.generated?.lines[line])?.span.words ?? DEFAULT_DOCUMENTS_WORDS;
      const opening = openingOf(result.sentences ?? sentencesOf(result.answer.split('\n\n')[0] ?? ''), budget);
      const onFail = opts.documents?.onFail ?? 'not-found';
      const fallback = documentsFallback(app, s, onFail, opening, unavailablePrompt);
      // onFail: lines: the sections' lines beside it, one a line, for the decision model to pick from when the
      // answer cannot be worded (render/turn.ts); the opening is said where it picks none.
      const lines = onFail === 'lines' ? sectionLinesOf(result.sections ?? [{ heading: '', sentences: result.sentences ?? [] }]) : [];
      const linesVars: Record<string, string> = lines.length > 0 ? { [KB_LINES_VAR]: lines.map((l) => l.text).join('\n'), [KB_LINE_HEADINGS_VAR]: lines.map((l) => l.heading).join('\n') } : {};
      return { kind: 'said', acks: [...c.acks, { promptId: line, vars: { [KB_ANSWER_VAR]: fallback, [KB_SOURCE_VAR]: result.answer, ...linesVars, [KB_HOLD_VAR]: holdWording(app, s), ...holdMoreVars(app, s), ...(heard !== undefined && heard !== '' ? { [KB_QUESTION_VAR]: heard } : {}) } }] };
    }
    const defaultLocale = defaultLocaleOf(app);
    const locale = result.source.locale ?? s.locale ?? defaultLocale;
    let answer = result.answer;
    let account: string | null = null;
    const line = accountLineOf(app.knowledge, result.source.topic, locale, defaultLocale);
    if (line !== null) {
      const read = c.callTool({ tool: line.from, params: kbCallParams(app, s, line.from, result.source.topic, opts.subject) });
      account = read.decision.verdict === 'ALLOW' ? fillAccountLine(line.text, read.value) : null;
      if (account !== null) answer = `${answer} ${account}`;
    }
    return { kind: 'said', acks: [...c.acks, { promptId: answerPrompt, vars: { [KB_ANSWER_VAR]: answer, ...wordingVars(app, answerPrompt, account, s.slots[opts.slot]?.heard), ...(answerSpanOf(app.generated?.lines[answerPrompt]) !== null ? { [KB_HOLD_VAR]: holdWording(app, s), ...holdMoreVars(app, s) } : {}) } }] };
  };
}

/** Whether the app has the line `id` (in its prompts). */
const hasPrompt = (app: App, id: string): boolean => Object.hasOwn(app.prompts.manifest, id);

/**
 * The wording of the hold line for this answer (kb_hold, in turn through its variants: core/wordings.ts),
 * or kb_hold itself where the app has no variants. Counted once per answer that may be worded, said or not.
 */
function holdWording(app: App, s: Session): string {
  return hasPrompt(app, 'kb_hold') ? nextWording(s, 'kb_hold') : 'kb_hold';
}

/** The wording of the second hold line for this answer (kb_hold_more, in turn), where the app has it. */
function holdMoreVars(app: App, s: Session): Record<string, string> {
  return hasPrompt(app, 'kb_hold_more') ? { [KB_HOLD_MORE_VAR]: nextWording(s, 'kb_hold_more') } : {};
}

/** A list's markers (a bullet glyph, or a dash opening a line), which a document has for the eye and a caller should not hear: the words are kept as they are. */
const LIST_MARKER = /(^|\s)[\u2022\u25E6\u25AA\u25AB\u2023\u25CF\u25CB\u25A0\u25A1\u2043\uF0B7\uF0A7](?=\s|$)\s*/gu;
const withoutMarkers = (line: string): string => line.replace(LIST_MARKER, '$1').replace(/^[-*]\s+/, '').replace(/\s+/g, ' ').trim();

/** Words of a document said in place of an answer that cannot be worded, in the kb_documents_opening frame where the app has it (its {opening}), in the call's language. */
export function openingFramed(app: App, locale: string | undefined, words: string): string {
  if (!hasPrompt(app, KB_DOCUMENTS_OPENING_PROMPT)) return words;
  return localePromptEntry(app, KB_DOCUMENTS_OPENING_PROMPT, locale).entry.text.replace(VAR, (m, name: string) => (name === 'opening' ? words : m));
}

/** The most lines of the chosen sections the decision model is asked about (onFail: lines), shared among them: a long table's first. */
export const KB_MAX_LINES = 40;

/** One line of a chosen section (onFail: lines): its words as said, and its section's heading ('' where it has none). */
export interface SectionLine {
  readonly text: string;
  readonly heading: string;
}

/**
 * The chosen sections' lines as said (a list's markers left out, each ended where its line ended without a
 * stop), at most `max` in all, shared among the sections: a line to each section in turn, in their order,
 * so a long section never crowds out the next; the room one does not use goes to the others. Each section's
 * own lines in its order, the sections in theirs.
 */
export function sectionLinesOf(sections: readonly { readonly heading: string; readonly sentences: readonly string[] }[], max: number = KB_MAX_LINES): SectionLine[] {
  const all = sections.map((s) => ({ heading: s.heading, lines: s.sentences.map(withoutMarkers).filter((x) => x !== '').map(ended) }));
  const take = all.map(() => 0);
  let left = max;
  while (left > 0 && all.some((s, i) => take[i]! < s.lines.length)) {
    all.forEach((s, i) => {
      if (left > 0 && take[i]! < s.lines.length) {
        take[i]! += 1;
        left -= 1;
      }
    });
  }
  return all.flatMap((s, i) => s.lines.slice(0, take[i]).map((text) => ({ text, heading: s.heading })));
}

/**
 * Lines of the chosen sections as they are said (onFail: lines): those of one section after its heading
 * (ended, so it reads as a sentence of its own), in the order given, a section's heading said once for the
 * lines that follow it.
 */
export function sectionLinesSaid(lines: readonly SectionLine[]): string {
  const out: string[] = [];
  let heading: string | null = null;
  for (const l of lines) {
    if (l.heading !== heading && l.heading !== '') out.push(ended(l.heading));
    heading = l.heading;
    out.push(l.text);
  }
  return out.join(' ');
}

const ended = (x: string): string => (/[.?!:;]$/.test(x) ? x : `${x}.`);

/**
 * A section's opening, said when an answer from it cannot be worded: the whole section where it fits
 * the answer's word budget (the span's `words`), else its first two sentences; each ended where its
 * line ended without a stop (a table's row), so that rows are not run together, and a list's markers left out.
 */
export function openingOf(sentences: readonly string[], words: number): string {
  const all = sentences.map(withoutMarkers).filter((x) => x !== '').map(ended);
  const whole = all.join(' ');
  return whole.split(/\s+/).filter((w) => w !== '').length <= words ? whole : all.slice(0, 2).join(' ');
}

/**
 * What an answer from documents says when it cannot be worded (its line's fixed text): with onFail
 * `not-found` (the default), the not-found line in turn through its wordings (kb_not_found), else the
 * form's unavailable line; with `opening`, the best section's opening (openingOf), word for word, in
 * the kb_documents_opening frame where the app has it. Text in the call's language.
 */
function documentsFallback(app: App, s: Session, onFail: 'not-found' | 'opening' | 'lines', opening: string, unavailablePrompt: string): string {
  if (onFail === 'opening' || onFail === 'lines') return openingFramed(app, s.locale, opening);
  const id = hasPrompt(app, KB_NOT_FOUND_PROMPT) ? nextWording(s, KB_NOT_FOUND_PROMPT) : unavailablePrompt;
  return localePromptEntry(app, id, s.locale).entry.text;
}

/**
 * What an answer line that words its answer (a span `from: answer`, render/config.ts) is given beside
 * {answer}: the account line alone (said after a wording of the passage), and the caller's question, in
 * their words (what the wording is for), each only where there is one. Nothing for every other line, so
 * its decision is as it was. In an app whose caller's words are sent to a model only to summarize a slot
 * the records mask (a `text` slot's `redact: length-summarized`), the question is not given: no other line
 * is sent the caller's words, and the passage is said word for word.
 */
function wordingVars(app: App, promptId: string, account: string | null, heard: string | undefined): Record<string, string> {
  if (answerSpanOf(app.generated?.lines[promptId]) === null) return {};
  const summarizing = Object.values(app.slots).some((spec) => spec.summarized === true);
  return {
    ...(account !== null ? { [KB_ACCOUNT_VAR]: account } : {}),
    ...(heard !== undefined && heard !== '' && !summarizing ? { [KB_QUESTION_VAR]: heard } : {}),
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
/** The tools kbAnswerTool made: the engine's own, which read the app's approved passages and no downstream system. */
const KB_ANSWER_TOOLS = new WeakSet<ToolDef>();

/** Whether `def` is a tool kbAnswerTool made (the adversarial suite gives it no hostile reply: it reaches no downstream system). */
export function isKbAnswerTool(def: ToolDef): boolean {
  return KB_ANSWER_TOOLS.has(def);
}

export function kbAnswerTool(opts: KbAnswerToolOptions = {}): ToolDef {
  const def: ToolDef = {
    params: [...(opts.subject !== undefined ? [opts.subject] : []), KB_TOPIC_PARAM],
    run(call, sys, { s, tc }) {
      const kb = appOf(s).knowledge?.kb;
      if (kb === undefined) return { value: { unavailable: 'no-answer' } satisfies KbAnswer, summary: 'no knowledge base' };
      const facts = opts.facts ? opts.facts(call.params, sys, tc) : {};
      if (facts === null) return { value: { unavailable: 'no-facts' } satisfies KbAnswer, summary: 'no passage (no-facts)' };
      const locale = opts.locale?.(s) ?? s.locale ?? kb.defaultLocale;
      // Sections of approved documents (kb.yaml documents), named by the topic slot's value.
      const keys = sectionKeysOf(call.params[KB_TOPIC_PARAM] ?? '');
      if (keys !== null) {
        const r = resolveSections(kb, keys, facts, locale);
        if ('unavailable' in r) return { value: { unavailable: r.unavailable } satisfies KbAnswer, summary: `no passage (${r.unavailable})` };
        return { value: { answer: r.sections.map((x) => x.text).join('\n\n'), source: documentsSourceOf(kb, r.sections, facts), sentences: r.sections[0]?.sentences ?? [], sections: r.sections.map((x) => ({ heading: x.heading, sentences: x.sentences })) } satisfies KbAnswer, summary: `documents ${r.sections.map((x) => x.key).join(', ')}` };
      }
      const r = resolvePassage(kb, { topic: call.params[KB_TOPIC_PARAM] ?? '', facts, todayIso: tc.todayIso, locale });
      if ('fresh' in r) return { value: { answer: r.passage.answer, source: recordOf(kb, r.passage, facts, true) } satisfies KbAnswer, summary: r.passage.id };
      const value: KbAnswer = { unavailable: r.unavailable, ...(r.passage ? { source: recordOf(kb, r.passage, facts, false) } : {}) };
      return { value, summary: `no passage (${r.unavailable})` };
    },
    audit: ({ call, summary, kb }) => [{ type: 'tool_result', detail: { tool: call.tool, summary } }, ...(kb ? [kbAuditRow(kb)] : [])],
  };
  KB_ANSWER_TOOLS.add(def);
  return def;
}

/** What an informational intent's passage comes to: the line to say, and whether it is the answer (false: the unavailable line). */
export interface InformationalAnswer {
  readonly ack: Ack;
  readonly answered: boolean;
}

/**
 * An informational intent's passage (IntentDef.passage), said with no gate and no facts: the
 * passage in force today for the named passage's topic, in the call's language (resolvePassage
 * with no facts, so a passage that applies to some callers only never answers here), through the
 * `kb_answer` line. Its record is the turn's (TurnOut.kb), and the audit's `kb_answer` row follows
 * from it. None to say (not in force, stale, no translation, or no such passage): the
 * `kb_unavailable` line, and the record of a withheld passage, when there is one.
 */
export function informationalAnswer(s: Session, tc: TurnContext, out: TurnOut, passageId: string): InformationalAnswer {
  const unavailable: InformationalAnswer = { ack: { promptId: KB_UNAVAILABLE_PROMPT, vars: {} }, answered: false };
  const kb = appOf(s).knowledge?.kb;
  const named = kb !== undefined && Object.hasOwn(kb.passages, passageId) ? kb.passages[passageId]! : undefined;
  if (kb === undefined || named === undefined) return unavailable;
  const r = resolvePassage(kb, { topic: named.topic, facts: {}, todayIso: tc.todayIso, locale: s.locale ?? kb.defaultLocale });
  if ('fresh' in r) {
    out.kb = recordOf(kb, r.passage, {}, true);
    return { ack: { promptId: KB_ANSWER_PROMPT, vars: { [KB_ANSWER_VAR]: r.passage.answer } }, answered: true };
  }
  if (r.passage) out.kb = recordOf(kb, r.passage, {}, false);
  return unavailable;
}

/**
 * After an informational passage that could not be said: a person offered in place of the question
 * the caller was on, once per call. A caller who turned one down on this call, an offer already on
 * the table, or a downstream service's answer awaited: no offer (null), and the call resumes. The
 * question comes back once the offer is declined: the confirmation it displaced (`resume`) or the form loop.
 * The offer says why it was made (`why: 'no-answer'`), so a yes is a handoff for a person
 * (`live-agent`), not a frustrated caller's.
 */
export function offerAfterUnavailable(s: Session, acks: Ack[]): Decision | null {
  if (s.transferDeclined || s.pendingConfirmation?.target === 'transfer' || s.pendingService !== null) return null;
  const displaced = s.pendingConfirmation;
  s.pendingConfirmation = displaced !== null ? { target: 'transfer', attempts: 0, resume: displaced, why: 'no-answer' } : { target: 'transfer', attempts: 0, why: 'no-answer' };
  s.promptedFor = 'confirm';
  return offerTransfer(acks);
}
