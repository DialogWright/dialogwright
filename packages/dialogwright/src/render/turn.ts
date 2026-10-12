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
import { isNoul, type JevClient, type JevUsage } from '../jev/types';
import { localePromptEntry, promptText, saidLineOf, type SaidLine } from '../prompts/render';
import { checkGenerated, cleanGenerated, DRIFT_FIRE, DRIFT_QUESTION_ID, renderDriftQuestion, renderDriftState } from './checks';
import { generatesLines, identifierVarsFrom, lineVars } from './config';
import { renderKey } from './prompt';
import { DEFAULT_RENDER_PRICE, DEFAULT_RENDER_TIMEOUT_MS, RenderClientError, type Generation, type RenderFallback, type Renderer, type RenderLine, type RenderRecord, type RenderSkip, type SpeechAct, type SpeechItem } from './types';

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
  /** The decision model's usage on the drift checks; null when none was asked. */
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
}

type Attempt = { said: string; gen: Generation } | { fallback: RenderFallback; refused?: string; gen?: Generation };

/** The act of one line, or why the line is not tried on this turn. */
function planLine(app: App, input: RenderInput, line: GeneratedLine, said: SaidLine, group: 'generated' | 'fixed', identifiers: ReadonlySet<string>): { act: SpeechAct } | { skipped: RenderSkip } {
  const { before, result, event } = input;
  const after = result.session;
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
  const words = wordsOf(event);
  // A turn with words is generated only once the injection screen has read them and not flagged them.
  if (words !== null && (result.screen === null || result.screen.fired || result.screen.error !== null || result.quarantined)) return { skipped: 'screen' };
  const from = new Set(line.from ?? []);
  const value = (name: string): SpeechItem => ({ name, value: said.vars[name] ?? '' });
  const content = vars.filter((v) => from.has(v)).map(value);
  const fixed = promptText(app, said.promptId, { ...said.vars }, locale);
  const style = app.generated!.style;
  const act: SpeechAct = {
    act: said.role,
    goal,
    fixed,
    asks: fixed.includes('?'),
    items: vars.filter((v) => !from.has(v)).map(value),
    ...(content.length > 0 ? { content } : {}),
    ...(words !== null && !sensitivePrompt(app, before.promptedFor) ? { heard: words } : {}),
    frustration: frustrationOf(after),
    situations,
    channel,
    language: locale ?? defaultLocale ?? 'en-US',
    style: { persona: style.persona, words: style.words[channel], avoid: [...style.avoid] },
  };
  return { act };
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
  result.actions.forEach((a, index) => {
    if (a.type !== 'say') return;
    const said = saidLineOf(a);
    if (said === undefined || !Object.hasOwn(generated.lines, said.promptId)) return;
    planned.push({ index, said, plan: planLine(app, input, generated.lines[said.promptId]!, said, group, identifiers) });
  });
  if (planned.length === 0 && !start) return null;

  const t0 = performance.now();
  const budget = (renderer.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS)[channelOf(result.session)];
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), budget);
  });
  const drift = renderer.drift ?? input.client;
  let driftUsage: JevUsage | null = null;
  const attempt = async (promptId: string, act: SpeechAct): Promise<Attempt> => {
    let gen: Generation;
    try {
      gen = await renderer.client.generate({ promptId, act, key: renderKey(promptId, act) }, abort.signal);
    } catch (e) {
      return { fallback: e instanceof RenderClientError && e.kind === 'cassette-miss' ? 'cassette-miss' : 'error' };
    }
    const text = cleanGenerated(gen.text);
    const failed = checkGenerated(text, act);
    if (failed !== null) return { fallback: failed, refused: text, gen };
    try {
      const r = await drift.ask({ state: renderDriftState(act, text), questions: renderDriftQuestion(), timeoutMs: budget, signal: abort.signal });
      driftUsage = {
        inputTokens: (driftUsage?.inputTokens ?? 0) + r.usage.inputTokens,
        outputTokens: (driftUsage?.outputTokens ?? 0) + r.usage.outputTokens,
        estimated: (driftUsage?.estimated ?? false) || r.usage.estimated,
      };
      const a = r.answers[DRIFT_QUESTION_ID];
      if (!isNoul(a)) return { fallback: 'drift-error', refused: text, gen };
      if (a.noul >= DRIFT_FIRE) return { fallback: 'drift', refused: text, gen };
    } catch {
      return { fallback: 'drift-error', refused: text, gen };
    }
    return { said: text, gen };
  };
  const settled = await Promise.all(planned.map(async (p) => {
    if (!('act' in p.plan)) return null;
    const began = performance.now();
    const got = await raceDeadline(attempt(p.said.promptId, p.plan.act), deadline);
    return { got: got === 'late' ? ({ fallback: 'timeout' } as Attempt) : got, ms: performance.now() - began };
  }));
  clearTimeout(timer);
  abort.abort();

  const actions = [...result.actions];
  const lines: RenderLine[] = [];
  const audit: AuditDraft[] = [];
  let usage: { inputTokens: number; outputTokens: number } | null = null;
  let model: string | undefined;
  planned.forEach((p, i) => {
    const base = { index: p.index, promptId: p.said.promptId, fixed: promptText(app, p.said.promptId, { ...p.said.vars }, result.session.locale), act: p.said.role };
    if (!('act' in p.plan)) {
      lines.push({ ...base, mode: 'fixed', situations: situationsOf(input.before, result.session, result, p.said.promptId), skipped: p.plan.skipped });
      return;
    }
    const { got, ms } = settled[i]!;
    const gen = 'gen' in got ? got.gen : undefined;
    if (gen !== undefined) {
      usage = { inputTokens: (usage?.inputTokens ?? 0) + gen.usage.inputTokens, outputTokens: (usage?.outputTokens ?? 0) + gen.usage.outputTokens };
      model = gen.model;
    }
    const meta = { situations: [...p.plan.act.situations], ms, ...(gen !== undefined ? { usage: { ...gen.usage }, source: gen.source } : {}) };
    if ('said' in got) {
      const was = actions[p.index] as Say;
      actions[p.index] = sayAction([{ text: got.said }], was.interruptible, was.lang);
      lines.push({ ...base, mode: 'generated', said: got.said, ...meta });
      return;
    }
    lines.push({ ...base, mode: 'fixed', ...meta, fallback: got.fallback, ...(got.refused !== undefined ? { refused: got.refused } : {}) });
    audit.push({ type: 'render_fallback', detail: { prompt: p.said.promptId, reason: got.fallback } });
  });
  if (start) audit.unshift({ type: 'render_group', detail: { group, share } });
  const price = renderer.price ?? DEFAULT_RENDER_PRICE;
  const spent = usage as { inputTokens: number; outputTokens: number } | null;
  const record: RenderRecord = {
    group,
    share,
    ...(model !== undefined ? { model } : {}),
    lines,
    ...(spent !== null ? { usage: { ...spent, costUsd: (spent.inputTokens * price.input + spent.outputTokens * price.output) / 1_000_000 } } : {}),
    ms: performance.now() - t0,
  };
  return { actions, record, audit, driftUsage };
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
