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
import { localePromptEntry, promptSay, promptText, renderTemplate, saidLineOf, type RenderContext, type SaidLine } from '../prompts/render';
import { checkGenerated, checkSpan, cleanGenerated, cleanSpan, decisionQuestionOf, DRIFT_FIRE, DRIFT_QUESTION_ID, renderDriftQuestion, renderDriftState, renderSpanDriftQuestion, renderSpanDriftState, SPAN_DRIFT_QUESTION_ID } from './checks';
import { generatesLines, identifierVarsFrom, isFramed, lineVars, saysKbAnswer, summarizedVarsFrom } from './config';
import { actMessage, instructionsOf, renderKey, spanKey } from './prompt';
import { screenQuestions, screenState } from '../core/screen';
import { atLeast, type Thresholds } from '../core/thresholds';
import { DEFAULT_RENDER_CHECK_TIMEOUT_MS, DEFAULT_RENDER_PRICE, DEFAULT_RENDER_TIMEOUT_MS, RenderClientError, type RenderAct, type RenderUsage, type Generation, type RenderFallback, type Renderer, type RenderLine, type RenderRecord, type RenderSkip, type SpanAct, type SpeechAct, type SpeechItem } from './types';

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
}

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
}

/** A line's attempt: said, or fallen back (with the wording a check refused, and what was paid for: a generation's usage, or a late one's estimate). */
type Attempt = { said: string; gen: Generation } | { fallback: RenderFallback; refused?: string; gen?: Generation; usage?: RenderUsage; error?: NonNullable<RenderLine['error']> };

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
 * its goal, its content (quoted), its budget, the style, the channel and the language: never the frame.
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
  return {
    spans: Object.entries(line.spans).map(([name, span]): SpanPlan => {
      const content = said.vars[span.from] ?? '';
      const goal = localized ? app.generated!.localeSpanGoals?.[locale]?.[said.promptId]?.[name] : span.goal;
      if (goal === undefined) return { name, content, skipped: 'locale' };
      // A slot the records mask is never sent, but one the app marked to be summarized (redact: length-summarized).
      if (identifiers.has(span.from) && !summarizedVarsFrom(app.slots, identityOf(app).factorSlots).has(span.from)) return { name, content, skipped: 'identifier' };
      if (content.trim() === '') return { name, content, skipped: 'no-content' };
      const act: SpanAct = {
        kind: 'span',
        goal,
        content: [{ name: span.from, value: content }],
        channel,
        language: locale ?? defaultLocale ?? 'en-US',
        style: { persona: style.persona, words: span.words, avoid: [...style.avoid] },
      };
      return { name, content, act, conflicts };
    }),
  };
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
  // Whether the turn has said an acknowledgement before the line at hand: an ack of the decision's, or a line of the engine's own.
  let acked = false;
  result.actions.forEach((a, index) => {
    if (a.type !== 'say') return;
    const said = saidLineOf(a);
    const wasAcked = acked;
    if (said === undefined || said.role === 'acknowledge') acked = true;
    if (said === undefined || !Object.hasOwn(generated.lines, said.promptId)) return;
    const line = generated.lines[said.promptId]!;
    // A framed line: only its spans are worded, each spliced into its fixed text.
    if (isFramed(line)) framed.push({ index, said, plan: planFramed(app, input, line, said, group, identifiers) });
    else planned.push({ index, said, plan: planLine(app, input, line, said, group, identifiers, wasAcked) });
  });
  if (planned.length === 0 && framed.length === 0 && !start) return null;

  const t0 = performance.now();
  const channel = channelOf(result.session);
  // Two budgets: the model's wording, and the decision model's checks (the collected content screened
  // before, the drift check after), so a slow wording never starves the checks of their time.
  const budget = (renderer.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS)[channel];
  const checkBudget = (renderer.checkTimeoutMs ?? DEFAULT_RENDER_CHECK_TIMEOUT_MS)[channel];
  const abort = new AbortController();
  const timers: ReturnType<typeof setTimeout>[] = [];
  const after = (ms: number): Promise<'late'> => new Promise((resolve) => {
    timers.push(setTimeout(() => resolve('late'), ms));
  });
  // The turn's whole budget: no line takes longer than the wording's and the checks' together.
  const deadline = after(budget + checkBudget);
  const drift = renderer.drift ?? input.client;
  let checkUsage: JevUsage | null = null;
  const used = (u: JevUsage): void => {
    checkUsage = {
      inputTokens: (checkUsage?.inputTokens ?? 0) + u.inputTokens,
      outputTokens: (checkUsage?.outputTokens ?? 0) + u.outputTokens,
      estimated: (checkUsage?.estimated ?? false) || u.estimated,
    };
  };
  // A line's (or a span's) checks share their budget: each is given what is left of it.
  const checker = () => {
    let checkLeft = checkBudget;
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
      if (a.noul >= DRIFT_FIRE) return { fallback: 'drift', refused: text, gen };
    } catch {
      return { fallback: 'drift-error', refused: text, gen };
    }
    return { said: text, gen };
  };
  // A framed line's span: screened, worded, held to its content alone (checkSpan), and asked of the
  // drift check as a summary of its content; never the frame.
  const attemptSpan = async (promptId: string, span: string, act: SpanAct, conflicts: readonly string[]): Promise<Attempt> => {
    const c = checker();
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
    const failed = checkSpan(text, act, { conflicts });
    if (failed !== null) return { fallback: failed, refused: text, gen };
    try {
      const r = await c.check(drift.ask({ state: renderSpanDriftState(act, text) as unknown as JsonValue, questions: renderSpanDriftQuestion(), timeoutMs: c.left(), signal: abort.signal }));
      if (r === 'late') return { fallback: 'timeout', refused: text, gen };
      used(r.usage);
      const a = r.answers[SPAN_DRIFT_QUESTION_ID];
      if (!isNoul(a)) return { fallback: 'drift-error', refused: text, gen };
      if (a.noul >= DRIFT_FIRE) return { fallback: 'drift', refused: text, gen };
    } catch {
      return { fallback: 'drift-error', refused: text, gen };
    }
    return { said: text, gen };
  };
  const timed = async (act: RenderAct, run: () => Promise<Attempt>): Promise<{ got: Attempt; ms: number }> => {
    const began = performance.now();
    const got = await raceDeadline(run(), deadline);
    return { got: got === 'late' ? ({ fallback: 'timeout', usage: requestUsage(act) } as Attempt) : got, ms: performance.now() - began };
  };
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
  for (const t of timers) clearTimeout(t);
  abort.abort();

  const actions = [...result.actions];
  const lines: RenderLine[] = [];
  const audit: AuditDraft[] = [];
  let usage: RenderUsage | null = null;
  let model: string | undefined;
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
    if (paid !== undefined) {
      usage = { inputTokens: (usage?.inputTokens ?? 0) + paid.inputTokens, outputTokens: (usage?.outputTokens ?? 0) + paid.outputTokens, ...((usage?.estimated ?? false) || paid.estimated === true ? { estimated: true } : {}) };
    }
    if (gen !== undefined) model = gen.model;
    const meta = { situations: [...p.plan.act.situations], ms, ...(paid !== undefined ? { usage: paid } : {}), ...(gen !== undefined ? { source: gen.source } : {}) };
    if ('said' in got) {
      const was = actions[p.index] as Say;
      actions[p.index] = sayAction([{ text: got.said }], was.interruptible, was.lang);
      lines.push({ ...base, mode: 'generated', said: got.said, ...meta });
      return;
    }
    lines.push({ ...base, mode: 'fixed', ...meta, fallback: got.fallback, ...(got.refused !== undefined ? { refused: got.refused } : {}), ...(got.error !== undefined ? { error: got.error } : {}) });
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
      if (paid !== undefined) {
        usage = { inputTokens: (usage?.inputTokens ?? 0) + paid.inputTokens, outputTokens: (usage?.outputTokens ?? 0) + paid.outputTokens, ...((usage?.estimated ?? false) || paid.estimated === true ? { estimated: true } : {}) };
      }
      if (gen !== undefined) model = gen.model;
      const meta = { situations, ms, ...(paid !== undefined ? { usage: paid } : {}), ...(gen !== undefined ? { source: gen.source } : {}) };
      if ('said' in got) {
        worded[sp.name] = got.said;
        spanLines.push({ ...base, mode: 'generated', said: got.said, ...meta });
        return;
      }
      spanLines.push({ ...base, mode: 'fixed', ...meta, fallback: got.fallback, ...(got.refused !== undefined ? { refused: got.refused } : {}), ...(got.error !== undefined ? { error: got.error } : {}) });
      audit.push({ type: 'render_fallback', detail: { prompt: promptId, span: sp.name, reason: got.fallback } });
    });
    if (Object.keys(worded).length > 0) {
      // Said as the fixed line is (its frame's recorded clips kept), each worded span in its place.
      const was = actions[f.index] as Say;
      actions[f.index] = promptSay(app, promptId, { ...f.said.vars }, was.interruptible, input.clips ?? null, result.session.locale, worded);
    }
  });
  // In the order the lines were said.
  lines.push(...spanLines);
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
  };
  return { actions, record, audit, driftUsage: checkUsage };
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
