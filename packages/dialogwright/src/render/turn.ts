import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { sayAction, type Action, type Say } from '../channel/actions';
import { wordsOf, type SessionEvent } from '../channel/events';
import type { AuditDraft } from '../audit/types';
import { identityOf } from '../core/app/lookup';
import { appOf } from '../core/app/registry';
import type { App, GeneratedLine, RenderChannel, RenderSituation } from '../core/app/types';
import type { Session } from '../core/session';
import type { TurnResult } from '../core/turn';
import { isNoul, type JevClient, type JevUsage, type JsonValue } from '../jev/types';
import { lineLang, localePromptEntry, promptSay, promptText, renderTemplate, saidLineOf, type RenderContext, type SaidLine } from '../prompts/render';
import { ANSWER_DRIFT_QUESTION_ID, ANSWER_LINE_QUESTION_PREFIX, answerLinesQuestions, answerLinesState, DOCUMENTS_DRIFT_QUESTION_ID, renderDocumentsDriftQuestion, renderDocumentsDriftState, checkAnswer, checkGenerated, checkSpan, cleanAnswer, cleanGenerated, cleanSpan, decisionQuestionOf, renderAnswerDriftQuestion, renderAnswerDriftState, sameWords, wordCount, DRIFT_FIRE, DRIFT_QUESTION_ID, renderDriftQuestion, renderDriftState, renderSpanDriftQuestion, renderSpanDriftState, SPAN_DRIFT_QUESTION_ID } from './checks';
import { answerSpanOf, answerWordBudget, generatesLines, identifierVarsFrom, isFramed, isSectionsSpan, KB_ACCOUNT_VAR, KB_ANSWER_LINE_VAR, KB_QUESTION_VAR, lineVars, saysKbAnswer, spanNameVars, speaksToCallerIn, summarizedVarsFrom } from './config';
import { actMessage, instructionsOf, renderKey, spanKey, spanSentence } from './prompt';
import { screenQuestions, screenState } from '../core/screen';
import { atLeast, type Thresholds } from '../core/thresholds';
import { DEFAULT_RENDER_ANSWER_TIMEOUT_MS, DEFAULT_RENDER_DOCUMENTS_TIMEOUT_MS, DEFAULT_RENDER_CHECK_TIMEOUT_MS, DEFAULT_RENDER_PRICE, DEFAULT_RENDER_TIMEOUT_MS, RenderClientError, type RenderAct, type RenderUsage, type Generation, type RenderFallback, type Renderer, type RenderHold, type RenderJudge, type RenderLine, type RenderRecord, type RenderSkip, type SpanAct, type SpeechAct, type SpeechItem } from './types';
import type { KbSource } from '../core/lifecycle';
import { KB_HOLD_MORE_VAR, KB_HOLD_VAR, KB_LINES_VAR, KB_SOURCE_VAR, openingFramed } from '../kb/answer';

/**
 * The call's group under RENDER_SHARE: `generated` for `share` percent of calls, `fixed` for the rest,
 * chosen per call from its id, so every turn of a call (and a call resumed after a restart) is in one
 * group, and a share of 100 serves every call generated.
 */
export function renderGroupOf(sessionId: string, share: number): 'generated' | 'fixed' {
  if (share >= 100) return 'generated';
  if (share <= 0) return 'fixed';
  const bucket = createHash('sha256').update(sessionId).digest().readUInt32BE(0) % 100;
  return bucket < share ? 'generated' : 'fixed';
}

/** The situations a line is said in on this turn (prompts.yaml's `when.situations`). */
export function situationsOf(before: Session, after: Session, result: Pick<TurnResult, 'verdict'>, promptId: string): RenderSituation[] {
  const saidBefore = before.lastPromptId === promptId || before.history.some((h) => h.node === promptId);
  const out: RenderSituation[] = [saidBefore ? 're-ask' : 'first-ask'];
  const changed = Object.keys(after.slots).some((id) => {
    const was = before.slots[id]?.value ?? null;
    const now = after.slots[id]?.value ?? null;
    return was !== null && now !== null && was !== now;
  });
  if (changed || result.verdict?.kind === 'rejected') out.push('after-correction');
  if (after.frustratedTurns > 0) out.push('frustrated');
  return out;
}

/** Whether the caller was answering a question whose words are sensitive (the code, an identity factor, a slot recorded masked): such words are never quoted to a model. */
function sensitivePrompt(app: App, promptedFor: Session['promptedFor']): boolean {
  if (promptedFor === 'otp') return true;
  if (promptedFor === null || promptedFor === 'intent' || promptedFor === 'confirm') return false;
  if (identityOf(app).factorSlots.includes(promptedFor)) return true;
  return Object.hasOwn(app.slots, promptedFor) && app.slots[promptedFor]!.redact !== undefined;
}

function channelOf(session: Session): RenderChannel {
  return session.caps.speech ? 'voice' : 'chat';
}

function frustrationOf(session: Session): SpeechAct['frustration'] {
  return session.frustratedTurns === 0 ? 'none' : session.frustratedTurns === 1 ? 'some' : 'high';
}

/** What a turn's rendering made: the actions as said, its trace record, its audit rows, and what its drift checks cost. */
export interface RenderedTurn {
  actions: Action[];
  record: RenderRecord;
  audit: AuditDraft[];
  /** The decision model's usage on the checks it was asked (the collected content screened, the drift check); null when none was asked. */
  driftUsage: JevUsage | null;
  /**
   * How many of `actions`, from the first, went to the caller before the turn ended (RenderInput.early:
   * the lines before a knowledge answer still being worded, and the hold line); 0 on every other turn.
   */
  early: number;
  /** What was said of the turn's knowledge answer, on a turn whose answer line words its answer (KbSource.said); absent otherwise. */
  kbSaid?: 'passage' | 'worded';
}

/**
 * The hold line in the call's language: the app's `kb_hold` in that language (a locale's own, or the
 * default locale's prompts.yaml for a call in it); else, for a call in English, the engine's words
 * (DEFAULT_HOLD_TEXT); else none, so a call in a language the app gives no hold line never hears one in
 * another (its answer then has a line's budget, as any line, rather than a silence while it is worded).
 */
function holdLineOf(app: App, locale: string | undefined, clips: RenderContext | null, wording: string = KB_HOLD_PROMPT): { line: Say; own: boolean } | null {
  const inDefault = locale === undefined || app.locales === undefined || locale === app.locales.default;
  const own = Object.hasOwn(app.prompts.manifest, KB_HOLD_PROMPT) && (inDefault || localePromptEntry(app, KB_HOLD_PROMPT, locale).localized);
  // The wording the knowledge completion chose for this answer (kb_hold in turn through its variants: KB_HOLD_VAR).
  if (own) return { line: promptSay(app, wording.startsWith(KB_HOLD_PROMPT) ? wording : KB_HOLD_PROMPT, {}, false, clips, locale), own: true };
  const language = (inDefault ? app.locales?.default : locale) ?? 'en-US';
  return /^en(?:-|_|$)/i.test(language) ? { line: sayAction([{ text: DEFAULT_HOLD_TEXT }], false, lineLang(app, locale)), own: false } : null;
}

/** The hold line's words when the app has no `kb_hold` of its own. */
export const DEFAULT_HOLD_TEXT = 'One moment while I gather that information.';
/** The line said before a knowledge answer whose wording runs past its line's budget, where the app has it. */
export const KB_HOLD_PROMPT = 'kb_hold';
/** The second hold line, said past half an answer's limit where the app has it. */
export const KB_HOLD_MORE_PROMPT = 'kb_hold_more';

/**
 * The fallbacks after which a knowledge answer is worded again where its span allows (`retry`): those
 * where the wording said more than its source, as the model is told of a refused wording: the drift
 * judge's refusal, and a figure the source does not have. A wording too long, or in the wrong shape, is
 * not asked again.
 */
const RETRIED: ReadonlySet<string> = new Set(['drift', 'foreign']);

/** What the lines question (onFail: lines) leaves of the answer's limit for saying what it chose, ms. */
const LINES_MARGIN_MS = 20;

/**
 * Hands a channel lines to say before the turn has ended: the turn's lines before a knowledge answer still
 * being worded, and the hold line after them, with the turn's result so far (its decision and session);
 * and, past half the answer's limit, a second batch of the second hold line alone, said after the first.
 * True when the channel said them (they are then not said again at the turn's end); false where it cannot,
 * and they go with the turn's other lines.
 */
export type EarlyLines = (actions: readonly Action[], result: TurnResult) => boolean;

export interface RenderInput {
  /** The session as the turn found it. */
  before: Session;
  result: TurnResult;
  /** The turn's event, as the core saw it (a code said aloud masked). */
  event: SessionEvent;
  renderer: Renderer;
  /** The run's decision model client: the drift check's, unless the renderer names its own. */
  client: JevClient;
  /** The run's thresholds: the screen's fire level, for the collected content screened again. */
  thresholds: Thresholds;
  /** The run's recorded clips (RunOptions.render): a framed line keeps its frame's clips when a span is worded. */
  clips?: RenderContext | null;
  /** A channel that can say lines before the turn has ended (RunOptions.early): the hold line goes to it as soon as it is due. */
  early?: EarlyLines;
}

/** A line's attempt: said, or fallen back (with the wording a check refused, and what was paid for: a generation's usage, or a late one's estimate). */
type Attempt = { said: string; gen: Generation; judge?: RenderJudge } | { unchanged: true; gen: Generation } | { fallback: RenderFallback; refused?: string; gen?: Generation; usage?: RenderUsage; error?: NonNullable<RenderLine['error']>; judge?: RenderJudge; lines?: { chosen: number[]; of: number; text: string } };

/** The drift judge's reading of an attempt, for its line (RenderLine.judge): absent where the judge was not asked or gave no reading. */
function judgeOf(got: Attempt): { judge?: RenderJudge } {
  return 'judge' in got && got.judge !== undefined ? { judge: got.judge } : {};
}

/** A failed request as the trace records it (RenderLine.error): the client's own account, never the request. */
function requestFailed(e: unknown): Attempt {
  if (e instanceof RenderClientError && e.kind === 'cassette-miss') return { fallback: 'cassette-miss' };
  const error: NonNullable<RenderLine['error']> = e instanceof RenderClientError
    ? { reason: e.message, ...(e.detail !== undefined ? { message: e.detail } : {}) }
    : { reason: e instanceof Error ? e.name : 'error' };
  return { fallback: 'error', error };
}

/**
 * What a request the turn stopped waiting for was likely billed: its input, estimated from the
 * request's size (the instructions and the act, about four characters a token); its output unknown.
 */
function requestUsage(act: RenderAct): RenderUsage {
  return { inputTokens: Math.ceil((instructionsOf(act).length + actMessage(act).length) / 4), outputTokens: 0, estimated: true };
}

/** One span of a framed line to word on this turn: its act and the values it must not name in place of the frame's items; or why it is not tried. */
type SpanPlan = { name: string; content: string } & ({ act: SpanAct; conflicts: string[] } | { skipped: RenderSkip });

/**
 * The spans of a framed line (prompts.yaml's `generate`) to word on this turn, or why none is tried.
 * The line as a whole is held as a line generated whole is (said exactly, the call's group, `when`,
 * the screen); then each span to its own goal in the call's locale and its content. A span's act is
 * its goal, its sentence (the frame's own words, the span a gap and every value a placeholder, but the
 * names it lists), its content (quoted), its budget, the style, the channel and the language: never a
 * value of the frame.
 */
function planFramed(app: App, input: RenderInput, line: GeneratedLine & { spans: NonNullable<GeneratedLine['spans']> }, said: SaidLine, group: 'generated' | 'fixed', identifiers: ReadonlySet<string>): { spans: SpanPlan[] } | { skipped: RenderSkip } {
  const { before, result, event } = input;
  const after = result.session;
  if (said.exact === true) return { skipped: 'exact' };
  if (group === 'fixed') return { skipped: 'share' };
  const situations = situationsOf(before, after, result, said.promptId);
  const channel = channelOf(after);
  if (line.channels !== undefined && !line.channels.includes(channel)) return { skipped: 'when' };
  if (line.situations !== undefined && !line.situations.some((s) => situations.includes(s))) return { skipped: 'when' };
  const words = wordsOf(event);
  if (words !== null && (result.screen === null || result.screen.fired || result.screen.error !== null || result.quarantined)) return { skipped: 'screen' };
  const locale = after.locale;
  const defaultLocale = app.locales?.default;
  const localized = locale !== undefined && defaultLocale !== undefined && locale !== defaultLocale;
  const template = localePromptEntry(app, said.promptId, locale).entry.text;
  const names = Object.keys(line.spans);
  const items = lineVars(template).filter((v) => !names.includes(v));
  const conflicts = conflictsOf(app, items, said.vars, locale);
  const style = app.generated!.style;
  const language = locale ?? defaultLocale ?? 'en-US';
  return {
    spans: Object.entries(line.spans).map(([name, span]): SpanPlan => {
      const content = said.vars[span.from] ?? '';
      const goal = localized ? app.generated!.localeSpanGoals?.[locale]?.[said.promptId]?.[name] : span.goal;
      if (goal === undefined) return { name, content, skipped: 'locale' };
      // A slot the records mask is never sent, but one the app marked to be summarized (redact: length-summarized).
      if (identifiers.has(span.from) && !summarizedVarsFrom(app.slots, identityOf(app).factorSlots).has(span.from)) return { name, content, skipped: 'identifier' };
      if (content.trim() === '') return { name, content, skipped: 'no-content' };
      // Speaking to the caller is English only for now: in another language the span is worded in the caller's own terms.
      const toCaller = span.speaks === 'to-caller' && speaksToCallerIn(language);
      // The names it may use, those it lists (who the message is for), as the line says them.
      const names: SpeechItem[] = toCaller
        ? spanNameVars(app.slots as Readonly<Record<string, { type?: unknown; redact?: string }>>, span.names, identityOf(app).factorSlots).map((v) => ({ name: v, value: said.vars[v] ?? '' })).filter((n) => n.value.trim() !== '' && !/\d/.test(n.value))
        : [];
      const act: SpanAct = {
        kind: 'span',
        goal,
        // The sentence it is put into: the frame's own words in the call's locale, the span a gap, its
        // listed names filled, every other value a placeholder (never the caller's name or number).
        sentence: spanSentence(template, name, names),
        content: [{ name: span.from, value: content }],
        channel,
        language,
        style: { persona: style.persona, words: span.words, avoid: [...style.avoid] },
        ...(toCaller ? { speaks: 'to-caller' as const } : {}),
        ...(names.length > 0 ? { names } : {}),
      };
      return { name, content, act, conflicts };
    }),
  };
}

/** A knowledge answer to word on this turn: its span, the passage and its record, and its act; or why it is not tried. */
type AnswerPlan = { name: string; passage: string; kb: KbSource | null; lines?: readonly string[] } & ({ act: SpanAct } | { skipped: RenderSkip });

/**
 * A form's answer line framed with a span worded from the answer (`from: answer`), on this turn: its act,
 * or why the approved passage is said word for word. It is worded only for a passage of the app's kb/
 * folder, fresh, on a topic marked `risk: low`, said as the knowledge completion gave it (the passage, then
 * the topic's account line), with the caller's question kept; and held as every generated line is (said
 * exactly, the call's group, `when`, the screen, a goal in the call's locale). Its act is the span's goal,
 * its sentence, the passage (its content: the only facts it may state), the caller's question (quoted),
 * its budget (room above the passage's word count, answerWordBudget, unless the span sets `words`), the style, the channel and the
 * language: never the account line, a record, another passage or the transcript.
 */
function planAnswer(app: App, input: RenderInput, line: GeneratedLine, name: string, said: SaidLine, group: 'generated' | 'fixed'): AnswerPlan {
  const { before, result, event } = input;
  const after = result.session;
  const span = line.spans![name]!;
  const answerVar = said.vars[KB_ANSWER_LINE_VAR] ?? '';
  const kb = app.knowledge?.kb;
  const record = result.kb;
  const passage = kb !== undefined && record !== null && Object.hasOwn(kb.passages, record.passageId) ? kb.passages[record.passageId]! : undefined;
  const base = { name, passage: passage?.answer ?? answerVar, kb: record };
  const account = said.vars[KB_ACCOUNT_VAR] ?? '';
  // The passage of the app's own kb/, fresh, said as the completion gave it: anything else is said as it came.
  if (passage === undefined || record === null || record.fresh !== true || answerVar !== (account === '' ? passage.answer : `${passage.answer} ${account}`)) return { ...base, skipped: 'knowledge' };
  if (kb!.topics[record.topic]?.risk !== 'low') return { ...base, skipped: 'regulated' };
  if (said.exact === true) return { ...base, skipped: 'exact' };
  if (group === 'fixed') return { ...base, skipped: 'share' };
  const situations = situationsOf(before, after, result, said.promptId);
  const channel = channelOf(after);
  if (line.channels !== undefined && !line.channels.includes(channel)) return { ...base, skipped: 'when' };
  if (line.situations !== undefined && !line.situations.some((s) => situations.includes(s))) return { ...base, skipped: 'when' };
  const words = wordsOf(event);
  if (words !== null && (result.screen === null || result.screen.fired || result.screen.error !== null || result.quarantined)) return { ...base, skipped: 'screen' };
  const locale = after.locale;
  const defaultLocale = app.locales?.default;
  const localized = locale !== undefined && defaultLocale !== undefined && locale !== defaultLocale;
  const goal = localized ? app.generated!.localeSpanGoals?.[locale]?.[said.promptId]?.[name] : span.goal;
  if (goal === undefined) return { ...base, skipped: 'locale' };
  const question = said.vars[KB_QUESTION_VAR];
  if (question === undefined || question.trim() === '') return { ...base, skipped: 'no-question' };
  const template = localePromptEntry(app, said.promptId, locale).entry.text;
  const style = app.generated!.style;
  const act: SpanAct = {
    kind: 'span',
    goal,
    sentence: spanSentence(template, name),
    content: [{ name: KB_ANSWER_LINE_VAR, value: passage.answer }],
    channel,
    language: locale ?? defaultLocale ?? 'en-US',
    style: { persona: style.persona, words: span.sizedToPassage === true ? answerWordBudget(wordCount(passage.answer)) : span.words, avoid: [...style.avoid] },
    answer: { question },
  };
  return { ...base, act };
}

/**
 * A form's documents answer line (kb.yaml documents), framed with a span worded from sections (`from:
 * sections`), on this turn: its act, or why its fixed text (the fallback: answers.documents.onFail) is said.
 * It is worded only for an answer the knowledge completion drew from sections of approved documents, fresh,
 * with the caller's question kept; and held as every generated line is (said exactly, the call's group,
 * `when`, the screen, a goal in the call's locale). Its act is the span's goal, its sentence, the sections
 * (its content: the only facts it may state), the caller's question (quoted), its budget (`words`, default
 * DEFAULT_DOCUMENTS_WORDS), the style, the channel and the language: never a record or the transcript.
 */
function planDocumentsAnswer(app: App, input: RenderInput, line: GeneratedLine, name: string, said: SaidLine, group: 'generated' | 'fixed'): AnswerPlan {
  const { before, result, event } = input;
  const after = result.session;
  const span = line.spans![name]!;
  const record = result.kb;
  const sections = (said.vars[KB_SOURCE_VAR] ?? '').split('\n\n').map((s) => s.trim()).filter((s) => s !== '');
  // onFail: lines: the sections' lines, for the decision model to pick from if the answer cannot be worded.
  const lines = (said.vars[KB_LINES_VAR] ?? '').split('\n').map((s) => s.trim()).filter((s) => s !== '');
  const base = { name, passage: said.vars[KB_ANSWER_LINE_VAR] ?? '', kb: record, ...(lines.length > 0 ? { lines } : {}) };
  if (record === null || record.from !== 'documents' || record.fresh !== true || sections.length === 0) return { ...base, skipped: 'knowledge' };
  if (said.exact === true) return { ...base, skipped: 'exact' };
  if (group === 'fixed') return { ...base, skipped: 'share' };
  const situations = situationsOf(before, after, result, said.promptId);
  const channel = channelOf(after);
  if (line.channels !== undefined && !line.channels.includes(channel)) return { ...base, skipped: 'when' };
  if (line.situations !== undefined && !line.situations.some((s) => situations.includes(s))) return { ...base, skipped: 'when' };
  const words = wordsOf(event);
  if (words !== null && (result.screen === null || result.screen.fired || result.screen.error !== null || result.quarantined)) return { ...base, skipped: 'screen' };
  const locale = after.locale;
  const defaultLocale = app.locales?.default;
  const localized = locale !== undefined && defaultLocale !== undefined && locale !== defaultLocale;
  const goal = localized ? app.generated!.localeSpanGoals?.[locale]?.[said.promptId]?.[name] : span.goal;
  if (goal === undefined) return { ...base, skipped: 'locale' };
  const question = said.vars[KB_QUESTION_VAR];
  if (question === undefined || question.trim() === '') return { ...base, skipped: 'no-question' };
  const template = localePromptEntry(app, said.promptId, locale).entry.text;
  const style = app.generated!.style;
  const act: SpanAct = {
    kind: 'span',
    goal,
    sentence: spanSentence(template, name),
    content: sections.map((value) => ({ name: KB_ANSWER_LINE_VAR, value })),
    channel,
    language: locale ?? defaultLocale ?? 'en-US',
    style: { persona: style.persona, words: span.words, avoid: [...style.avoid] },
    answer: { question, from: 'sections' },
  };
  return { ...base, act };
}

/**
 * The act of one line, or why the line is not tried on this turn. `afterAck`: the turn says an
 * acknowledgement before it (an ack the core put before the line, such as ack_intent or
 * read_back_exact, or a line of the engine's own such as a language switch's), so the line adds none
 * of its own, as with `acknowledge: false`: two acknowledgements never stack.
 */
function planLine(app: App, input: RenderInput, line: GeneratedLine, said: SaidLine, group: 'generated' | 'fixed', identifiers: ReadonlySet<string>, afterAck = false): { act: SpeechAct; judgeFixed: string; conflicts: string[] } | { skipped: RenderSkip } {
  const { before, result, event } = input;
  const after = result.session;
  // A line the core said must be heard word for word (a summary read back exactly after a no): always fixed.
  if (said.exact === true) return { skipped: 'exact' };
  if (group === 'fixed') return { skipped: 'share' };
  const locale = after.locale;
  const defaultLocale = app.locales?.default;
  const localized = locale !== undefined && defaultLocale !== undefined && locale !== defaultLocale;
  const goal = localized ? app.generated!.localeGoals[locale]?.[said.promptId] : line.goal;
  if (goal === undefined) return { skipped: 'locale' };
  const situations = situationsOf(before, after, result, said.promptId);
  const channel = channelOf(after);
  if (line.channels !== undefined && !line.channels.includes(channel)) return { skipped: 'when' };
  if (line.situations !== undefined && !line.situations.some((s) => situations.includes(s))) return { skipped: 'when' };
  const template = localePromptEntry(app, said.promptId, locale).entry.text;
  const vars = lineVars(template);
  if (vars.some((v) => identifiers.has(v))) return { skipped: 'identifier' };
  if (saysKbAnswer(template)) return { skipped: 'knowledge' };
  const words = wordsOf(event);
  // A turn with words is generated only once the injection screen has read them and not flagged them.
  if (words !== null && (result.screen === null || result.screen.fired || result.screen.error !== null || result.quarantined)) return { skipped: 'screen' };
  const from = new Set(line.from ?? []);
  const value = (name: string): SpeechItem => ({ name, value: said.vars[name] ?? '' });
  const content = vars.filter((v) => from.has(v)).map(value);
  const fixed = promptText(app, said.promptId, { ...said.vars }, locale);
  const style = app.generated!.style;
  // A question a yes or a no settles (a confirmation is pending once it is said) is kept word for word.
  const keep = said.role === 'ask' && after.pendingConfirmation !== null ? decisionQuestionOf(fixed) : undefined;
  const quiet = line.acknowledge === false || afterAck;
  const act: SpeechAct = {
    act: said.role,
    goal,
    fixed,
    asks: fixed.includes('?'),
    ...(keep !== undefined ? { keep } : {}),
    items: vars.filter((v) => !from.has(v)).map(value),
    ...(content.length > 0 ? { content } : {}),
    // A line that adds no acknowledgement is not sent the caller's words: it has nothing to say back of them.
    // In an app with a slot the records mask whose words a model summarizes (redact: length-summarized), no
    // line is sent the caller's words: they reach the render model only in the span that summarizes them.
    ...(words !== null && !sensitivePrompt(app, before.promptedFor) && !quiet && summarizedVarsFrom(app.slots, identityOf(app).factorSlots).size === 0 ? { heard: words } : {}),
    ...(quiet ? { acknowledge: false as const } : {}),
    frustration: frustrationOf(after),
    situations,
    channel,
    language: locale ?? defaultLocale ?? 'en-US',
    style: { persona: style.persona, words: style.words[channel], avoid: [...style.avoid] },
  };
  // The fixed line as the drift check reads it: each collected value left as its {placeholder}, the content apart.
  const judgeFixed = renderTemplate(template, Object.fromEntries(vars.map((v) => [v, from.has(v) ? `{${v}}` : (said.vars[v] ?? '')])));
  return { act, judgeFixed, conflicts: conflictsOf(app, vars.filter((v) => !from.has(v)), said.vars, locale) };
}

/**
 * The other values of each item's own slot, as said: for a choice slot, every other option's display
 * (the other person a message could be for, say). Naming one the fixed line does not is a `conflict`.
 */
function conflictsOf(app: App, items: readonly string[], vars: Readonly<Record<string, string>>, locale: string | undefined): string[] {
  const out: string[] = [];
  for (const v of items) {
    const spec = Object.hasOwn(app.slots, v) ? (app.slots[v] as { type?: unknown; config?: { options?: Record<string, unknown> }; display: (value: string, locale?: string) => string }) : undefined;
    if (spec?.type !== 'choice' || spec.config?.options === undefined) continue;
    for (const option of Object.keys(spec.config.options)) {
      const said = spec.display(option, locale);
      if (said !== vars[v]) out.push(said);
    }
  }
  return out;
}

/** Rejects with 'late' once `deadline` has passed. */
function raceDeadline<T>(p: Promise<T>, deadline: Promise<'late'>): Promise<T | 'late'> {
  return Promise.race([p, deadline]);
}

/**
 * Renders a turn's generated lines (design section 5), once the core has decided: each line the app
 * generates (App.generated) is worded by the renderer's client, checked (render/checks.ts), and said in
 * place of its fixed line only when every check passed within the turn's budget; otherwise its fixed
 * line is said and the audit records `render_fallback`. Null for an app that generates nothing, or a
 * turn that says none of its generated lines: the turn is exactly as it was.
 *
 * A knowledge answer worded for the caller's question (a form's answer line framed `from: answer`, on a
 * topic marked `risk: low`) has longer: its wording and checks may take up to the renderer's answer limit
 * (RENDER_ANSWER_TIMEOUT_MS). When it is not done by the line's own budgets (the wording's and the
 * checks'), the hold line (`kb_hold`, else DEFAULT_HOLD_TEXT) is put before it, and handed with the lines
 * before it to the channel to say at once (`early`), where the channel can; the answer, or the passage
 * word for word if it is still not ready or a check fails, follows when it is.
 */
export async function renderTurn(input: RenderInput): Promise<RenderedTurn | null> {
  const { result, renderer } = input;
  const app = appOf(result.session);
  if (!generatesLines(app)) return null;
  const share = renderer.share ?? 100;
  const group = renderGroupOf(result.session.sessionId, share);
  const start = input.event.type === 'session.start';
  const generated = app.generated!;
  const identifiers = identifierVarsFrom(app.slots, identityOf(app).factorSlots);
  const planned: { index: number; said: SaidLine; plan: ReturnType<typeof planLine> }[] = [];
  const framed: { index: number; said: SaidLine; plan: ReturnType<typeof planFramed> }[] = [];
  const answers: { index: number; said: SaidLine; plan: AnswerPlan }[] = [];
  // Whether the turn has said an acknowledgement before the line at hand: an ack of the decision's, or a line of the engine's own.
  let acked = false;
  result.actions.forEach((a, index) => {
    if (a.type !== 'say') return;
    const said = saidLineOf(a);
    const wasAcked = acked;
    if (said === undefined || said.role === 'acknowledge') acked = true;
    if (said === undefined || !Object.hasOwn(generated.lines, said.promptId)) return;
    const line = generated.lines[said.promptId]!;
    // A knowledge answer worded for the caller's question: its own plan, and its own, longer limit.
    const answer = answerSpanOf(line);
    if (answer !== null) answers.push({ index, said, plan: isSectionsSpan(answer.span) ? planDocumentsAnswer(app, input, line, answer.name, said, group) : planAnswer(app, input, line, answer.name, said, group) });
    // A framed line: only its spans are worded, each spliced into its fixed text.
    else if (isFramed(line)) framed.push({ index, said, plan: planFramed(app, input, line, said, group, identifiers) });
    else planned.push({ index, said, plan: planLine(app, input, line, said, group, identifiers, wasAcked) });
  });
  if (planned.length === 0 && framed.length === 0 && answers.length === 0 && !start) return null;

  const t0 = performance.now();
  const channel = channelOf(result.session);
  // Two budgets: the model's wording, and the decision model's checks (the collected content screened
  // before, the drift check after), so a slow wording never starves the checks of their time.
  const budget = (renderer.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS)[channel];
  const checkBudget = (renderer.checkTimeoutMs ?? DEFAULT_RENDER_CHECK_TIMEOUT_MS)[channel];
  // The hold line in the call's language, or none where the app gives it none there (holdLineOf).
  const firstWorded = answers.find((a) => 'act' in a.plan);
  const holdLine = firstWorded !== undefined ? holdLineOf(app, result.session.locale, input.clips ?? null, firstWorded.said.vars[KB_HOLD_VAR]) : null;
  // An answer from documents (kb.yaml documents) has a longer limit of its own (RENDER_DOCUMENTS_TIMEOUT_MS).
  const documents = answers.some((a) => 'act' in a.plan && a.plan.act.answer?.from === 'sections');
  // A knowledge answer's own limit, its wording and checks together: never less than a line's; and no
  // longer than a line's where there is no hold line to say while it is worded (the caller would wait in silence).
  const answerLimit = holdLine === null ? budget + checkBudget : Math.max((documents ? (renderer.documentsTimeoutMs ?? DEFAULT_RENDER_DOCUMENTS_TIMEOUT_MS) : (renderer.answerTimeoutMs ?? DEFAULT_RENDER_ANSWER_TIMEOUT_MS))[channel], budget + checkBudget);
  const abort = new AbortController();
  const timers: ReturnType<typeof setTimeout>[] = [];
  const after = (ms: number): Promise<'late'> => new Promise((resolve) => {
    timers.push(setTimeout(() => resolve('late'), ms));
  });
  // The turn's whole budget: no line takes longer than the wording's and the checks' together.
  const deadline = after(budget + checkBudget);
  const drift = renderer.drift ?? input.client;
  // Where the drift judge refuses a wording (style.yaml's judge.refuseAt), default DRIFT_FIRE.
  const refuseAt = generated.style.refuseAt ?? DRIFT_FIRE;
  let checkUsage: JevUsage | null = null;
  const used = (u: JevUsage): void => {
    checkUsage = {
      inputTokens: (checkUsage?.inputTokens ?? 0) + u.inputTokens,
      outputTokens: (checkUsage?.outputTokens ?? 0) + u.outputTokens,
      estimated: (checkUsage?.estimated ?? false) || u.estimated,
    };
  };
  // A line's (or a span's) checks share their budget: each is given what is left of it.
  const checker = (initial: number = checkBudget) => {
    let checkLeft = initial;
    const check = async <T,>(p: Promise<T>): Promise<T | 'late'> => {
      const began = performance.now();
      const got = await raceDeadline(p, after(Math.max(0, checkLeft)));
      checkLeft -= performance.now() - began;
      return got;
    };
    return { check, left: () => Math.max(1, checkLeft) };
  };
  // Collected content is the caller's words, kept from an earlier turn: screened again now, alone, and
  // a line (or a span) is generated from it only when the screen reads it and does not flag it.
  const screened = async (content: readonly SpeechItem[], c: ReturnType<typeof checker>): Promise<Attempt | null> => {
    for (const item of content) {
      try {
        const r = await c.check(drift.ask({ state: screenState(item.value), questions: screenQuestions(app), timeoutMs: c.left(), signal: abort.signal }));
        if (r === 'late') return { fallback: 'timeout' };
        used(r.usage);
        const read = r.answers.manipulation;
        if (!isNoul(read) || atLeast(read.noul, input.thresholds.SCREEN_FIRE)) return { fallback: 'content-flagged' };
      } catch {
        return { fallback: 'content-flagged' };
      }
    }
    return null;
  };
  const attempt = async (promptId: string, act: SpeechAct, judgeFixed: string, conflicts: readonly string[]): Promise<Attempt> => {
    const c = checker();
    const { check } = c;
    const flagged = await screened(act.content ?? [], c);
    if (flagged !== null) return flagged;
    let gen: Generation;
    try {
      const wording = await raceDeadline(renderer.client.generate({ promptId, act, key: renderKey(promptId, act) }, abort.signal), after(budget));
      if (wording === 'late') return { fallback: 'timeout', usage: requestUsage(act) };
      gen = wording;
    } catch (e) {
      return requestFailed(e);
    }
    const text = cleanGenerated(gen.text);
    const failed = checkGenerated(text, act, { conflicts });
    if (failed !== null) return { fallback: failed, refused: text, gen };
    try {
      const r = await check(drift.ask({ state: renderDriftState(act, text, judgeFixed) as unknown as JsonValue, questions: renderDriftQuestion(), timeoutMs: c.left(), signal: abort.signal }));
      if (r === 'late') return { fallback: 'timeout', refused: text, gen };
      used(r.usage);
      const a = r.answers[DRIFT_QUESTION_ID];
      if (!isNoul(a)) return { fallback: 'drift-error', refused: text, gen };
      // The judge's reading, kept on the line whether it passed or refused it (RenderLine.judge).
      const judge: RenderJudge = { score: a.noul, refuseAt };
      if (a.noul >= refuseAt) return { fallback: 'drift', refused: text, gen, judge };
      return { said: text, gen, judge };
    } catch {
      return { fallback: 'drift-error', refused: text, gen };
    }
  };
  // A framed line's span: screened, worded, held to its content's data and shape (checkSpan), and asked of
  // the drift judge whether it is a faithful summary of its content, heard in its sentence; the frame
  // itself is never the model's.
  const attemptSpan = async (promptId: string, span: string, act: SpanAct, conflicts: readonly string[]): Promise<Attempt> => {
    const c = checker();
    // The content screened again; a to-caller span's names are not: they are the app's own option text, never the caller's words.
    const flagged = await screened(act.content, c);
    if (flagged !== null) return flagged;
    let gen: Generation;
    try {
      const wording = await raceDeadline(renderer.client.generate({ promptId, span, act, key: spanKey(promptId, span, act) }, abort.signal), after(budget));
      if (wording === 'late') return { fallback: 'timeout', usage: requestUsage(act) };
      gen = wording;
    } catch (e) {
      return requestFailed(e);
    }
    const text = cleanSpan(gen.text);
    // The content back word for word: said as the exact words, in the frame for them, with nothing more asked.
    if (sameWords(text, act.content.map((c) => c.value).join(' '))) return { unchanged: true, gen };
    const failed = checkSpan(text, act, { conflicts });
    if (failed !== null) return { fallback: failed, refused: text, gen };
    try {
      const r = await c.check(drift.ask({ state: renderSpanDriftState(act, text) as unknown as JsonValue, questions: renderSpanDriftQuestion(act.speaks), timeoutMs: c.left(), signal: abort.signal }));
      if (r === 'late') return { fallback: 'timeout', refused: text, gen };
      used(r.usage);
      const a = r.answers[SPAN_DRIFT_QUESTION_ID];
      if (!isNoul(a)) return { fallback: 'drift-error', refused: text, gen };
      // The judge's reading, kept on the line whether it passed or refused it (RenderLine.judge).
      const judge: RenderJudge = { score: a.noul, refuseAt };
      if (a.noul >= refuseAt) return { fallback: 'drift', refused: text, gen, judge };
      return { said: text, gen, judge };
    } catch {
      return { fallback: 'drift-error', refused: text, gen };
    }
  };
  // A knowledge answer: the caller's question screened again (their words, kept from the turn they asked
  // it on), the passage worded for it within the answer's limit, held to the passage's data and shape
  // (checkAnswer), and asked of the drift judge whether it says only what the passage says for the
  // question; its checks have the line's budget, or what is left of the answer's limit where that is more.
  const attemptAnswer = async (promptId: string, span: string, first: SpanAct, retries: number, lines?: readonly string[]): Promise<Attempt> => {
    const flagged = await screened([{ name: 'question', value: first.answer!.question }], checker());
    if (flagged !== null) return flagged;
    let got = await wordAnswer(promptId, span, first);
    // A wording that said more than its source (the drift judge refused it, or it has a figure the source
    // does not): asked again (the span's `retry`), told only that its last was refused, within what is
    // left of the answer's limit; each draw is checked and judged again.
    for (let n = 0; n < retries && 'fallback' in got && RETRIED.has(got.fallback) && got.refused !== undefined && performance.now() - t0 < answerLimit - checkBudget; n++) {
      got = await wordAnswer(promptId, span, { ...first, answer: { ...first.answer!, refused: got.refused } }, got);
    }
    // Not worded, with onFail: lines: the lines of the sections that answer the question, if the decision
    // model says which in what is left of the answer's limit; else the opening, the line's fixed text.
    if ('fallback' in got && lines !== undefined && lines.length > 0) {
      const picked = await pickLines(first, lines);
      if (picked !== null) got = { ...got, lines: picked };
    }
    return got;
  };
  // The lines that answer the question, asked of the decision model, one yes-or-no question for each line
  // (answerLinesQuestions): those it says yes to (KB_LINE_ANSWERS), in the document's order, as many as
  // the answer's word budget holds (the first always). Null where it says none, errs or is late.
  const pickLines = async (act: SpanAct, lines: readonly string[]): Promise<{ chosen: number[]; of: number; text: string } | null> => {
    const left = answerLimit - (performance.now() - t0) - LINES_MARGIN_MS;
    if (left <= 0) return null;
    const c = checker(left);
    try {
      const r = await c.check(drift.ask({ state: answerLinesState(act.answer?.question ?? '', lines) as unknown as JsonValue, questions: answerLinesQuestions(lines.length), timeoutMs: c.left(), signal: abort.signal }));
      if (r === 'late') return null;
      used(r.usage);
      const chosen: number[] = [];
      let words = 0;
      lines.forEach((line, i) => {
        const a = r.answers[`${ANSWER_LINE_QUESTION_PREFIX}${i + 1}`];
        if (!isNoul(a) || !atLeast(a.noul, input.thresholds.KB_LINE_ANSWERS)) return;
        const n = wordCount(line);
        if (chosen.length > 0 && words + n > act.style.words) return;
        chosen.push(i + 1);
        words += n;
      });
      if (chosen.length === 0) return null;
      return { chosen, of: lines.length, text: chosen.map((i) => lines[i - 1]!).join(' ') };
    } catch {
      return null;
    }
  };
  const wordAnswer = async (promptId: string, span: string, act: SpanAct, before?: Attempt): Promise<Attempt> => {
    const fromSections = act.answer?.from === 'sections';
    // What a second draw paid for its first, so the line's usage counts both.
    const prior = before !== undefined && 'gen' in before && before.gen !== undefined ? before.gen.usage : undefined;
    const withPrior = (g: Generation): Generation => (prior === undefined ? g : { ...g, usage: { inputTokens: g.usage.inputTokens + prior.inputTokens, outputTokens: g.usage.outputTokens + prior.outputTokens, estimated: g.usage.estimated || prior.estimated } });
    let gen: Generation;
    try {
      const left = Math.max(1, answerLimit - checkBudget - (performance.now() - t0));
      const wording = await raceDeadline(renderer.client.generate({ promptId, span, act, key: spanKey(promptId, span, act) }, abort.signal), after(left));
      if (wording === 'late') return { fallback: 'timeout', usage: requestUsage(act) };
      gen = withPrior(wording);
    } catch (e) {
      return requestFailed(e);
    }
    const text = cleanAnswer(gen.text, act);
    const passage = act.content.map((c) => c.value).join(' ');
    // The passage back word for word: said as the passage, with nothing more asked. Not for an answer from
    // documents, whose fixed text is its fallback, not the sections: the sections back whole are checked as any wording.
    if (!fromSections && sameWords(text, passage)) return { unchanged: true, gen };
    const failed = checkAnswer(text, act);
    if (failed !== null) return { fallback: failed, refused: text, gen };
    const c = checker(Math.max(checkBudget, answerLimit - (performance.now() - t0)));
    try {
      const state = fromSections ? renderDocumentsDriftState(act, text) : renderAnswerDriftState(act, text);
      const r = await c.check(drift.ask({ state: state as unknown as JsonValue, questions: fromSections ? renderDocumentsDriftQuestion() : renderAnswerDriftQuestion(), timeoutMs: c.left(), signal: abort.signal }));
      if (r === 'late') return { fallback: 'timeout', refused: text, gen };
      used(r.usage);
      const a = r.answers[fromSections ? DOCUMENTS_DRIFT_QUESTION_ID : ANSWER_DRIFT_QUESTION_ID];
      if (!isNoul(a)) return { fallback: 'drift-error', refused: text, gen };
      // The judge's reading, kept on the line whether it passed or refused it (RenderLine.judge); an answer
      // from documents at its own cutoff where style.yaml gives one (judge.documentsRefuseAt).
      const cutoff = fromSections ? (generated.style.documentsRefuseAt ?? refuseAt) : refuseAt;
      const judge: RenderJudge = { score: a.noul, refuseAt: cutoff };
      if (a.noul >= cutoff) return { fallback: 'drift', refused: text, gen, judge };
      return { said: text, gen, judge };
    } catch {
      return { fallback: 'drift-error', refused: text, gen };
    }
  };
  const timed = async (act: RenderAct, run: () => Promise<Attempt>, by: Promise<'late'> = deadline): Promise<{ got: Attempt; ms: number }> => {
    const began = performance.now();
    const got = await raceDeadline(run(), by);
    return { got: got === 'late' ? ({ fallback: 'timeout', usage: requestUsage(act) } as Attempt) : got, ms: performance.now() - began };
  };
  // The answers start with the rest, and have till their own limit.
  const answerDeadline = answers.some((a) => 'act' in a.plan) ? after(answerLimit) : deadline;
  const answering = answers.map((a) => ('act' in a.plan ? timed(a.plan.act, () => attemptAnswer(a.said.promptId, a.plan.name, (a.plan as { act: SpanAct }).act, app.generated?.lines[a.said.promptId]?.spans?.[a.plan.name]?.retry ?? 0, a.plan.lines), answerDeadline) : null));
  const [settled, settledSpans] = await Promise.all([
    Promise.all(planned.map(async (p) => {
      if (!('act' in p.plan)) return null;
      const plan = p.plan;
      return timed(plan.act, () => attempt(p.said.promptId, plan.act, plan.judgeFixed, plan.conflicts));
    })),
    Promise.all(framed.map(async (f) => {
      if (!('spans' in f.plan)) return [];
      return Promise.all(f.plan.spans.map(async (sp) => ('act' in sp ? timed(sp.act, () => attemptSpan(f.said.promptId, sp.name, sp.act, sp.conflicts)) : null)));
    })),
  ]);

  const actions = [...result.actions];
  const lines: RenderLine[] = [];
  const audit: AuditDraft[] = [];
  let usage: RenderUsage | null = null;
  let model: string | undefined;
  const pay = (paid: RenderUsage | undefined): void => {
    if (paid === undefined) return;
    usage = { inputTokens: (usage?.inputTokens ?? 0) + paid.inputTokens, outputTokens: (usage?.outputTokens ?? 0) + paid.outputTokens, ...((usage?.estimated ?? false) || paid.estimated === true ? { estimated: true } : {}) };
  };
  planned.forEach((p, i) => {
    const base = { index: p.index, promptId: p.said.promptId, fixed: promptText(app, p.said.promptId, { ...p.said.vars }, result.session.locale), act: p.said.role };
    if (!('act' in p.plan)) {
      lines.push({ ...base, mode: 'fixed', situations: situationsOf(input.before, result.session, result, p.said.promptId), skipped: p.plan.skipped });
      return;
    }
    const { got, ms } = settled[i]!;
    const gen = 'gen' in got ? got.gen : undefined;
    // What the line was paid for: its generation's usage, or a request the turn stopped waiting for (estimated).
    const paid: RenderUsage | undefined = gen !== undefined ? { ...gen.usage } : 'usage' in got ? got.usage : undefined;
    pay(paid);
    if (gen !== undefined) model = gen.model;
    const meta = { situations: [...p.plan.act.situations], ms, ...(paid !== undefined ? { usage: paid } : {}), ...(gen !== undefined ? { source: gen.source } : {}) };
    if ('said' in got) {
      const was = actions[p.index] as Say;
      actions[p.index] = sayAction([{ text: got.said }], was.interruptible, was.lang);
      lines.push({ ...base, mode: 'generated', said: got.said, ...meta, ...judgeOf(got) });
      return;
    }
    // (A line worded whole is never said unchanged: only a span is compared with its content.)
    if ('unchanged' in got) {
      lines.push({ ...base, mode: 'fixed', unchanged: true, ...meta });
      return;
    }
    lines.push({ ...base, mode: 'fixed', ...meta, fallback: got.fallback, ...(got.refused !== undefined ? { refused: got.refused } : {}), ...(got.error !== undefined ? { error: got.error } : {}), ...judgeOf(got) });
    audit.push({ type: 'render_fallback', detail: { prompt: p.said.promptId, reason: got.fallback } });
  });
  // A framed line: each span said as worded or as its exact content, spliced into the line's fixed
  // text, which no wording reaches; one entry per span in the record, a fallback per span in the audit.
  const spanLines: RenderLine[] = [];
  framed.forEach((f, i) => {
    const promptId = f.said.promptId;
    const situations = situationsOf(input.before, result.session, result, promptId);
    const spanBase = (name: string, content: string) => ({ index: f.index, promptId, span: name, fixed: content, act: f.said.role });
    if (!('spans' in f.plan)) {
      const skipped = f.plan.skipped;
      for (const name of Object.keys(generated.lines[promptId]!.spans!)) {
        const content = f.said.vars[generated.lines[promptId]!.spans![name]!.from] ?? '';
        spanLines.push({ ...spanBase(name, content), mode: 'fixed', situations, skipped });
      }
      return;
    }
    const worded: Record<string, string> = {};
    f.plan.spans.forEach((sp, j) => {
      const base = spanBase(sp.name, sp.content);
      if (!('act' in sp)) {
        spanLines.push({ ...base, mode: 'fixed', situations, skipped: sp.skipped });
        return;
      }
      const { got, ms } = settledSpans[i]![j]!;
      const gen = 'gen' in got ? got.gen : undefined;
      const paid: RenderUsage | undefined = gen !== undefined ? { ...gen.usage } : 'usage' in got ? got.usage : undefined;
      pay(paid);
      if (gen !== undefined) model = gen.model;
      const meta = { situations, ms, ...(paid !== undefined ? { usage: paid } : {}), ...(gen !== undefined ? { source: gen.source } : {}) };
      if ('said' in got) {
        worded[sp.name] = got.said;
        spanLines.push({ ...base, mode: 'generated', said: got.said, ...meta, ...judgeOf(got) });
        return;
      }
      // Its content word for word: said unchanged, no fallback (no check failed), so no audit row.
      if ('unchanged' in got) {
        spanLines.push({ ...base, mode: 'fixed', unchanged: true, ...meta });
        return;
      }
      spanLines.push({ ...base, mode: 'fixed', ...meta, fallback: got.fallback, ...(got.refused !== undefined ? { refused: got.refused } : {}), ...(got.error !== undefined ? { error: got.error } : {}), ...judgeOf(got) });
      audit.push({ type: 'render_fallback', detail: { prompt: promptId, span: sp.name, reason: got.fallback } });
    });
    if (Object.keys(worded).length > 0) {
      // Said as the fixed line is (its frame's recorded clips kept), each worded span in its place.
      const was = actions[f.index] as Say;
      actions[f.index] = promptSay(app, promptId, { ...f.said.vars }, was.interruptible, input.clips ?? null, result.session.locale, worded);
    }
  });

  // A knowledge answer not yet worded when the line's budgets have run out: the hold line goes before it,
  // and, with the lines before it, to the caller at once where the channel can say them before the turn ends.
  let hold: RenderHold | undefined;
  let early = 0;
  const pending = answers.filter((_, i) => answering[i] !== null);
  if (pending.length > 0 && holdLine !== null) {
    const done = await Promise.race([Promise.all(answering).then(() => true as const), deadline.then(() => false as const)]);
    if (!done) {
      const at = Math.min(...pending.map((a) => a.index));
      const { line, own } = holdLine;
      const before = actions.slice(0, at);
      // Only lines said as their fixed text go early (a wording's checks are all done by now, but a line
      // said before its turn's record is written keeps nothing back: a span the records mask, say).
      const fixedBefore = [...lines, ...spanLines].every((l) => l.index >= at || l.mode === 'fixed') && before.every((a) => a.type === 'say');
      const sent = fixedBefore && input.early !== undefined ? input.early([...before, line], { ...result, actions: [...before, line] }) : false;
      actions.splice(at, 0, line);
      hold = { index: at, promptId: own ? KB_HOLD_PROMPT : null, atMs: performance.now() - t0, early: sent };
      if (sent) early = at + 1;
      // Still not worded past half the answer's limit: the second hold line (kb_hold_more, in turn through its
      // wordings), right after the first, to the caller at once where the first went early, so a long wait is
      // never silence. Only the app's own line, in the call's language.
      const moreId = firstWorded?.said.vars[KB_HOLD_MORE_VAR];
      const locale = result.session.locale;
      const inDefault = locale === undefined || app.locales === undefined || locale === app.locales.default;
      if (moreId !== undefined && Object.hasOwn(app.prompts.manifest, KB_HOLD_MORE_PROMPT) && (inDefault || localePromptEntry(app, KB_HOLD_MORE_PROMPT, locale).localized)) {
        const stillDone = await Promise.race([Promise.all(answering).then(() => true as const), after(Math.max(0, answerLimit / 2 - (performance.now() - t0))).then(() => false as const)]);
        if (!stillDone) {
          const more = promptSay(app, moreId, {}, false, input.clips ?? null, locale);
          const moreSent = sent && input.early !== undefined ? input.early([more], { ...result, actions: [...before, line, more] }) : false;
          actions.splice(at + 1, 0, more);
          hold.more = { promptId: KB_HOLD_MORE_PROMPT, atMs: performance.now() - t0, early: moreSent };
          if (moreSent) early = at + 2;
        }
      }
    }
  }
  const settledAnswers = await Promise.all(answering);
  for (const t of timers) clearTimeout(t);
  abort.abort();
  // The lines after the hold line moved one on (two, where the second was said too).
  const shift = (index: number): number => (hold !== undefined && index >= hold.index ? index + (hold.more !== undefined ? 2 : 1) : index);
  let kbSaid: RenderedTurn['kbSaid'];
  const answerLines: RenderLine[] = [];
  answers.forEach((a, i) => {
    const promptId = a.said.promptId;
    const index = shift(a.index);
    const situations = situationsOf(input.before, result.session, result, promptId);
    const kb = a.plan.kb;
    const base = { index, promptId, span: a.plan.name, fixed: a.plan.passage, act: a.said.role, ...(kb !== null ? { answer: { passageId: kb.passageId, topic: kb.topic } } : {}) };
    kbSaid ??= 'passage';
    if (!('act' in a.plan)) {
      answerLines.push({ ...base, mode: 'fixed', situations, skipped: a.plan.skipped });
      return;
    }
    const { got, ms } = settledAnswers[i]!;
    const gen = 'gen' in got ? got.gen : undefined;
    const paid: RenderUsage | undefined = gen !== undefined ? { ...gen.usage } : 'usage' in got ? got.usage : undefined;
    pay(paid);
    if (gen !== undefined) model = gen.model;
    const meta = { situations, ms, ...(paid !== undefined ? { usage: paid } : {}), ...(gen !== undefined ? { source: gen.source } : {}) };
    if ('said' in got) {
      const was = actions[index] as Say;
      actions[index] = promptSay(app, promptId, { ...a.said.vars }, was.interruptible, input.clips ?? null, result.session.locale, { [a.plan.name]: got.said });
      answerLines.push({ ...base, mode: 'generated', said: got.said, ...meta, ...judgeOf(got) });
      kbSaid = 'worded';
      // The record of what was said: a wording of this approved passage, by its id, version and approval.
      if (kb !== null) audit.push({ type: 'kb_worded', detail: { prompt: promptId, passageId: kb.passageId, version: kb.version, ...(kb.approvalHash !== undefined ? { approvalHash: kb.approvalHash } : {}), ...(kb.from === 'documents' ? { from: 'documents', sections: kb.sections ?? [] } : {}) } });
      return;
    }
    if ('unchanged' in got) {
      answerLines.push({ ...base, mode: 'fixed', unchanged: true, ...meta });
      return;
    }
    // onFail: lines: the lines the decision model said answer the question, word for word in the opening's frame, in place of the opening.
    let lines: RenderLine['lines'];
    if (got.lines !== undefined) {
      const text = openingFramed(app, result.session.locale, got.lines.text);
      const was = actions[index] as Say;
      actions[index] = promptSay(app, promptId, { ...a.said.vars, [KB_ANSWER_LINE_VAR]: text }, was.interruptible, input.clips ?? null, result.session.locale);
      lines = { chosen: got.lines.chosen, of: got.lines.of, said: text };
    }
    answerLines.push({ ...base, mode: 'fixed', ...meta, fallback: got.fallback, ...(got.refused !== undefined ? { refused: got.refused } : {}), ...(got.error !== undefined ? { error: got.error } : {}), ...judgeOf(got), ...(lines !== undefined ? { lines } : {}) });
    audit.push({ type: 'render_fallback', detail: { prompt: promptId, span: a.plan.name, reason: got.fallback, ...(lines !== undefined ? { lines: lines.chosen.length } : {}) } });
  });
  // In the order the lines were said.
  const said = [...lines, ...spanLines].map((l) => ({ ...l, index: shift(l.index) }));
  lines.splice(0, lines.length, ...said, ...answerLines);
  lines.sort((a, b) => a.index - b.index);
  if (start) audit.unshift({ type: 'render_group', detail: { group, share } });
  const price = renderer.price ?? DEFAULT_RENDER_PRICE;
  const spent = usage as RenderUsage | null;
  const record: RenderRecord = {
    group,
    share,
    ...(model !== undefined ? { model } : {}),
    lines,
    ...(spent !== null ? { usage: { ...spent, costUsd: (spent.inputTokens * price.input + spent.outputTokens * price.output) / 1_000_000 } } : {}),
    ms: performance.now() - t0,
    ...(hold !== undefined ? { hold } : {}),
  };
  return { actions, record, audit, driftUsage: checkUsage, early, ...(kbSaid !== undefined ? { kbSaid } : {}) };
}

/**
 * The turn's audit drafts with the rendering's rows in place: after the turn's own, before the rows
 * that close the call (the handoff, its summary, the call's end), so a line's fallback is recorded
 * before the call is said to end. On the call's first turn, its group (`render_group`) after call_started.
 */
export function withRenderAudit(drafts: readonly AuditDraft[], render: readonly AuditDraft[]): AuditDraft[] {
  if (render.length === 0) return [...drafts];
  const closing = new Set(['handoff', 'handoff_summary', 'call_ended']);
  const at = drafts.findIndex((d) => closing.has(d.type));
  const cut = at === -1 ? drafts.length : at;
  const group = render.filter((d) => d.type === 'render_group');
  const rest = render.filter((d) => d.type !== 'render_group');
  const started = drafts.findIndex((d) => d.type === 'call_started');
  const head = [...drafts.slice(0, cut)];
  if (group.length > 0) head.splice(started === -1 ? 0 : started + 1, 0, ...group);
  return [...head, ...rest, ...drafts.slice(cut)];
}
