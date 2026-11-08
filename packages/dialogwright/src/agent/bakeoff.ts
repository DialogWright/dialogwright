import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cassetteFileName } from '../jev/provider';
import { foreignFigure } from '../render/checks';
import { RENDER_EFFORTS, RENDER_THINKING_MODES, resolveRenderProvider, type RenderEffort, type RenderThinkingMode } from '../render/providers';
import type { RenderPrice } from '../render/types';
import { BAKEOFF_CALLS, BAKEOFF_EXAMPLES, BAKEOFF_FACTS, type BakeoffCall, type BakeoffTurn, type TextLabel, type ValueLabel } from './bakeoffCases';
import { AGENT_CASSETTE_MISS } from './cassette';
import { INCEPTION_EFFORTS, INCEPTION_KEY_VAR, openRouterAgent, resolveInceptionAgent, type InceptionEffort } from './provider';
import { NO_ACTION, type AgentAnswer, type AgentClient, type AgentContext, type AgentResult } from './types';

/**
 * Agent models compared on the bake-off's cases (`agent:bakeoff`, ./bakeoffCases.ts): every caller turn
 * of every case asked of each model, with and without the owner's sample replies, and each answer held
 * to the turn's labels. The table gives, per model and variant: the share of answers that are valid
 * JSON in the shape; the labelled values right (field and value), and those wrong, missed or extra;
 * values whose cited words the caller never said; the actions right; the replies with a figure the facts
 * and the values do not hold; the answer's time at the median and the 95th percentile; and the tokens and
 * the cost. The turns are scripted (what the line said after each is fixed), so every model is asked the
 * same turns, and a turn's context never depends on an earlier answer.
 *
 * Recording asks each model with the author's own key, sequentially (so the times are a turn's, not a
 * crowd's), within a generous budget so a slow answer is measured rather than cut off, into the model's
 * cassette (`src/agent/recorded/<model>.jsonl`); `--replay` tables the cassettes for nothing. The command
 * (harness-text/agentBakeoffCommand.ts) refuses to record in CI, and no test records.
 */

/** Where the bake-off's recordings are kept. */
export const AGENT_RECORDED_DIR = fileURLToPath(new URL('./recorded/', import.meta.url));

/** The budget a bake-off answer is measured within: long enough that a slow model is measured, not cut off. */
export const AGENT_BAKEOFF_BUDGET_MS = 30_000;

/** Stop asking a model once this many answers in a row failed as requests (a wrong id, a key refused). */
export const STOP_AFTER_ERRORS = 3;

export const AGENT_PROVIDERS = ['inception', 'openrouter'] as const;
export type AgentProviderName = (typeof AGENT_PROVIDERS)[number];

/** The key variable each provider's recording needs. */
export const AGENT_KEY_VARS: Readonly<Record<AgentProviderName, string>> = { inception: INCEPTION_KEY_VAR, openrouter: 'OPENROUTER_API_KEY' };

/** A model to compare, as `--models` names it. */
export interface AgentModelSpec {
  /** As given. */
  entry: string;
  provider: AgentProviderName;
  model: string;
  /** Inception: `reasoning_effort` (instant, low, medium, high). OpenRouter: RENDER_EFFORT (low, medium, high). Absent: the provider's default. */
  effort?: InceptionEffort | RenderEffort;
  /** OpenRouter only: RENDER_THINKING (reasoning off unless set or an effort is given). */
  thinking?: RenderThinkingMode;
  /** Inception only: `realtime: true`. */
  realtime: boolean;
}

/**
 * Reads `--models`: comma-separated entries, `inception:<model>[:<effort>][:realtime]` (effort: instant,
 * low, medium, high) or `openrouter:<vendor/model>[:<thinking>][:<effort>]` (render:bakeoff's words).
 * Throws, saying which entry is wrong.
 */
export function parseAgentModelSpecs(list: readonly string[]): AgentModelSpec[] {
  const entries = list.flatMap((l) => l.split(',')).map((e) => e.trim()).filter((e) => e !== '');
  if (entries.length === 0) throw new Error('--models names no model: give one or more, comma-separated, as inception:mercury-3[:<effort>][:realtime] or openrouter:<vendor/model>');
  const out: AgentModelSpec[] = [];
  for (const entry of entries) {
    const at = entry.indexOf(':');
    const provider = at === -1 ? '' : entry.slice(0, at);
    const parts = at === -1 ? [] : entry.slice(at + 1).split(':');
    if (!(AGENT_PROVIDERS as readonly string[]).includes(provider)) throw new Error(`"${entry}": start it with its provider, ${AGENT_PROVIDERS.map((p) => `${p}:`).join(' or ')} (inception:mercury-3:instant:realtime, openrouter:inception/mercury-3)`);
    if (provider === 'inception') {
      const realtime = parts.length > 1 && parts.at(-1) === 'realtime' ? (parts.pop(), true) : false;
      const effort = parts.length > 1 && (INCEPTION_EFFORTS as readonly string[]).includes(parts.at(-1)!) ? (parts.pop() as InceptionEffort) : undefined;
      if (parts.length !== 1 || parts[0]!.trim() === '') throw new Error(`"${entry}": give inception:<model>, then its effort (${INCEPTION_EFFORTS.join(', ')}) and realtime, either or both, in that order`);
      out.push({ entry, provider: 'inception', model: parts[0]!, ...(effort !== undefined ? { effort } : {}), realtime });
      continue;
    }
    if (parts.at(-1) === 'realtime') throw new Error(`"${entry}": realtime is Inception's own setting; give inception:<model>:realtime`);
    const effort = parts.length > 1 && (RENDER_EFFORTS as readonly string[]).includes(parts.at(-1)!) ? (parts.pop() as RenderEffort) : undefined;
    const thinking = parts.length > 1 && (RENDER_THINKING_MODES as readonly string[]).includes(parts.at(-1)!) ? (parts.pop() as RenderThinkingMode) : undefined;
    const model = parts.join(':');
    if (model.trim() === '') throw new Error(`"${entry}": name the model after openrouter:`);
    out.push({ entry, provider: 'openrouter', model, ...(thinking !== undefined ? { thinking } : {}), ...(effort !== undefined ? { effort } : {}), realtime: false });
  }
  const seen = new Set<string>();
  for (const s of out) {
    const id = agentCassetteName(s);
    if (seen.has(id)) throw new Error(`"${s.entry}" is named twice`);
    seen.add(id);
  }
  return out;
}

/** The name a model's recordings are kept under: provider, model, and its settings (`inception/mercury-3.instant.realtime`). */
export function agentCassetteName(s: AgentModelSpec): string {
  return `${s.provider}/${s.model}${s.thinking !== undefined ? `.thinking-${s.thinking}` : ''}${s.effort !== undefined ? `.${s.effort}` : ''}${s.realtime ? '.realtime' : ''}`;
}

/** Where a model's bake-off recordings are: `<dir>/<provider>__<model>[.settings].jsonl`. */
export function agentCassettePath(dir: string, s: AgentModelSpec): string {
  return join(dir, cassetteFileName(agentCassetteName(s)));
}

type Env = Record<string, string | undefined>;

/** The live client of a model's entry, its key read from the provider's own variable (throws, naming it, when unset). */
export function liveAgentClient(s: AgentModelSpec, env: Env, fetchFn: typeof fetch = fetch): AgentClient {
  if (s.provider === 'inception') return resolveInceptionAgent(env, { model: s.model, ...(s.effort !== undefined ? { effort: s.effort as InceptionEffort } : {}), realtime: s.realtime }, fetchFn);
  const p = resolveRenderProvider({ ...env, RENDER_PROVIDER: 'openrouter', RENDER_MODEL: s.model, RENDER_THINKING: s.thinking, RENDER_EFFORT: s.effort })!;
  return openRouterAgent(p, fetchFn);
}

/** Whether the prompt carries the owner's sample replies. */
export type AgentVariant = 'examples' | 'no examples';

/** Reads `--examples on|off|both`. */
export function variantsOf(flag: string | undefined): AgentVariant[] {
  if (flag === undefined || flag === 'both') return ['examples', 'no examples'];
  if (flag === 'on') return ['examples'];
  if (flag === 'off') return ['no examples'];
  throw new Error(`--examples is on, off or both, not "${flag}"`);
}

/** One turn of a case, as it is asked: its context, its labels, and everything the caller has said on the call so far. */
export interface AskedTurn {
  call: BakeoffCall;
  index: number;
  turn: BakeoffTurn;
  ctx: AgentContext;
  said: string;
  collected: Readonly<Record<string, string>>;
}

/** What a value's label sets the field to, for the turns after: the value, the first of several, or a text's `as`. */
export function labelValue(l: ValueLabel): string {
  return typeof l === 'string' ? l : isText(l) ? l.as : l[0]!;
}

const isText = (l: ValueLabel): l is TextLabel => typeof l === 'object' && !Array.isArray(l) && 'has' in (l as object);

/** The turns of a case in order, each with its context: the scripted conversation before it, and the values its earlier labels set. */
export function askedTurns(call: BakeoffCall, variant: AgentVariant): AskedTurn[] {
  const out: AskedTurn[] = [];
  const conversation = [...call.before];
  const collected: Record<string, string> = { ...call.collected };
  call.turns.forEach((turn, index) => {
    const now = [...conversation, { who: 'caller' as const, text: turn.caller }];
    const ctx: AgentContext = {
      facts: BAKEOFF_FACTS,
      examples: variant === 'examples' ? [...BAKEOFF_EXAMPLES] : [],
      form: call.form,
      fields: call.fields.map((f) => ({ ...f, value: collected[f.name] ?? null })),
      actions: call.actions,
      conversation: now,
      caller: call.caller,
      channel: call.channel,
      overLine: turn.overLine === true,
      seen: [],
      locale: 'en-US',
      today: call.today,
    };
    out.push({ call, index, turn, ctx, said: now.filter((u) => u.who === 'caller').map((u) => u.text).join(' '), collected: { ...collected } });
    for (const [field, label] of Object.entries(turn.values ?? {})) collected[field] = labelValue(label);
    conversation.push({ who: 'caller', text: turn.caller }, { who: 'line', text: turn.line });
  });
  return out;
}

/** Lower case, letters and digits only, one space between words: how cited words are found in what was said. */
export const normalized = (s: string): string => s.toLowerCase().replace(/[‘’]/g, "'").replace(/[^\p{L}\p{N}']+/gu, ' ').replace(/'/g, '').trim();

/** Whether a value matches its label, compared as its field's type compares (digits by their digits, a date as it is, an option or a name by its words). */
function matches(label: ValueLabel | '*', value: string, type: string): boolean {
  if (label === '*') return true;
  if (isText(label)) return label.has.every((w) => normalized(value).includes(normalized(w)));
  const options = typeof label === 'string' ? [label] : label;
  return options.some((o) => (type === 'digits' ? value.replace(/\D/g, '') === o.replace(/\D/g, '') : type === 'date' ? value.trim() === o.trim() : normalized(value) === normalized(o)));
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/** How a date value may be said (its weekday, month and day, and today or tomorrow), so a reply saying it is not a figure of its own. */
function dateWords(iso: string, today: string): string[] {
  const d = new Date(`${iso}T00:00:00Z`);
  const t = new Date(`${today}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return [];
  const days = Math.round((d.getTime() - t.getTime()) / 86_400_000);
  return [`${DAYS[d.getUTCDay()]!} ${MONTHS[d.getUTCMonth()]!} ${d.getUTCDate()}`, ...(days === 0 ? ['today'] : days === 1 ? ['tomorrow'] : [])];
}

/** One turn's answer held to its labels. */
export interface TurnScore {
  labelled: number;
  right: number;
  wrong: number;
  missed: number;
  extra: number;
  wordsNotSaid: number;
  actionRight: boolean;
  figure: boolean;
  /** What was wrong, for the list of mistakes. */
  mistakes: string[];
}

/** Holds an answer to its turn's labels: each labelled value right, wrong or missed; any other value extra unless the turn allows it or it repeats what is collected. */
export function scoreAnswer(a: AgentAnswer, t: Pick<AskedTurn, 'call' | 'turn' | 'said' | 'collected'>): TurnScore {
  const typeOf = (field: string): string => t.call.fields.find((f) => f.name === field)?.type ?? 'text';
  // The last value an answer gives for a field is the one it means.
  const given = new Map<string, { value: string; words: string }>();
  for (const v of a.values) given.set(v.field, v);
  const labels = t.turn.values ?? {};
  const may = t.turn.may ?? {};
  const s: TurnScore = { labelled: 0, right: 0, wrong: 0, missed: 0, extra: 0, wordsNotSaid: 0, actionRight: false, figure: false, mistakes: [] };
  for (const [field, label] of Object.entries(labels)) {
    s.labelled += 1;
    const v = given.get(field);
    if (v === undefined) {
      s.missed += 1;
      s.mistakes.push(`${field} missed`);
    } else if (matches(label, v.value, typeOf(field))) s.right += 1;
    else {
      s.wrong += 1;
      s.mistakes.push(`${field} "${v.value}", wanted ${describe(label)}`);
    }
  }
  for (const [field, v] of given) {
    if (field in labels) continue;
    const allowed = may[field];
    if (allowed !== undefined) {
      if (!matches(allowed, v.value, typeOf(field))) {
        s.wrong += 1;
        s.mistakes.push(`${field} "${v.value}", wanted ${describe(allowed)} if given`);
      }
      continue;
    }
    const before = t.collected[field];
    if (before !== undefined && matches(before, v.value, typeOf(field))) continue;
    s.extra += 1;
    s.mistakes.push(`${field} "${v.value}" given, not asked for`);
  }
  const said = normalized(t.said);
  for (const v of a.values) {
    if (!said.includes(normalized(v.words)) || normalized(v.words) === '') {
      s.wordsNotSaid += 1;
      s.mistakes.push(`${v.field}'s words "${v.words}" were never said`);
    }
  }
  const actions = t.turn.action === undefined ? [NO_ACTION] : typeof t.turn.action === 'string' ? [t.turn.action] : t.turn.action;
  s.actionRight = actions.includes(a.action);
  if (!s.actionRight) s.mistakes.push(`action ${a.action}, wanted ${actions.join(' or ')}`);
  // A figure is the facts', the fixed lines', a value collected or understood this turn (and the caller's words it cites, where said), or a date value as it is said.
  const sources = [
    ...BAKEOFF_FACTS.says,
    ...Object.values(BAKEOFF_FACTS.fixed),
    ...Object.entries(t.collected).flatMap(([f, v]) => [v, ...(typeOf(f) === 'date' ? dateWords(v, t.call.today) : [])]),
    ...a.values.flatMap((v) => [v.value, ...(said.includes(normalized(v.words)) ? [v.words] : []), ...(typeOf(v.field) === 'date' ? dateWords(v.value, t.call.today) : [])]),
  ];
  s.figure = foreignFigure(a.reply, sources);
  if (s.figure) s.mistakes.push(`a figure not in the facts: "${a.reply}"`);
  return s;
}

function describe(l: ValueLabel | '*'): string {
  if (l === '*') return 'any';
  if (isText(l)) return `words ${l.has.map((w) => `"${w}"`).join(', ')}`;
  return typeof l === 'string' ? `"${l}"` : l.map((o) => `"${o}"`).join(' or ');
}

/** One model and variant's results. */
export interface AgentVariantResult {
  entry: string;
  model: string;
  variant: AgentVariant;
  /** `ran`; `not-recorded` (a replay with nothing recorded for it); `stopped` (its answers failed as requests, STOP_AFTER_ERRORS in a row). */
  status: 'ran' | 'not-recorded' | 'stopped';
  stopped?: string;
  /** Turns asked (each turn as many times as `--repeat`). */
  asked: number;
  /** Turns a replay found nothing recorded for. */
  notRecorded: number;
  valid: number;
  invalid: number;
  timeouts: number;
  /** Failed requests by their detail. */
  errors: Record<string, number>;
  values: { labelled: number; right: number; wrong: number; missed: number; extra: number; wordsNotSaid: number };
  actions: { right: number; of: number };
  /** Valid answers whose reply says a figure the facts and values do not hold. */
  figures: number;
  ms: { measured: number; p50: number | null; p95: number | null };
  tokens: { input: number; output: number };
  /** The provider's own cost where it gave one, else the tokens at `--price`; null when neither is known. */
  costUsd: number | null;
  /** What each turn got wrong. */
  mistakes: { call: string; turn: number; what: string }[];
  /** The replies to the turns a person reads (a turn's `review`). */
  reviewed: { call: string; turn: number; review: string; replies: string[] }[];
  /** The first invalid answers' reasons, for the notes. */
  invalidWhy: string[];
}

/** What a comparison prints and writes. */
export interface AgentBakeoffReport {
  calls: number;
  turns: number;
  repeat: number;
  replay: boolean;
  budgetMs: number;
  /** The drift judge's time added to each answer for the bar (`--judge-ms`); absent, not added. */
  judgeMs?: number;
  results: AgentVariantResult[];
}

export interface AgentBakeoffOptions {
  calls?: readonly BakeoffCall[];
  variants: readonly AgentVariant[];
  /** How many times each turn is asked; default 1. */
  repeat?: number;
  budgetMs?: number;
  /** Prices by entry or model id, US dollars per million tokens, for answers whose provider gives no cost. */
  prices?: ReadonlyMap<string, RenderPrice>;
  replay?: boolean;
  judgeMs?: number;
  progress?: (line: string) => void;
}

/** The value at fraction `q` of `xs`, by rank. */
function quantile(xs: readonly number[], q: number): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
}

function emptyResult(entry: string, model: string, variant: AgentVariant): AgentVariantResult {
  return {
    entry, model, variant, status: 'ran', asked: 0, notRecorded: 0, valid: 0, invalid: 0, timeouts: 0, errors: {},
    values: { labelled: 0, right: 0, wrong: 0, missed: 0, extra: 0, wordsNotSaid: 0 }, actions: { right: 0, of: 0 }, figures: 0,
    ms: { measured: 0, p50: null, p95: null }, tokens: { input: 0, output: 0 }, costUsd: null, mistakes: [], reviewed: [], invalidWhy: [],
  };
}

class Stop extends Error {}

/** Asks every model every turn of every case, in each variant, and tables what came of it. Sequential: one answer at a time. */
export async function runAgentBakeoff(models: readonly { entry: string; client: AgentClient }[], opts: AgentBakeoffOptions): Promise<AgentBakeoffReport> {
  const calls = opts.calls ?? BAKEOFF_CALLS;
  const repeat = Math.max(1, opts.repeat ?? 1);
  const budget = opts.budgetMs ?? AGENT_BAKEOFF_BUDGET_MS;
  const results: AgentVariantResult[] = [];
  for (const m of models) {
    let errorsInARow = 0;
    let stopped: string | undefined;
    for (const variant of opts.variants) {
      const r = emptyResult(m.entry, m.client.model, variant);
      if (stopped !== undefined) {
        results.push({ ...r, status: 'stopped', stopped });
        continue;
      }
      const ms: number[] = [];
      let costKnown = 0;
      const unpriced = { input: 0, output: 0 };
      try {
        for (const call of calls) {
          opts.progress?.(`  ${m.entry} (${variant}): ${call.id}`);
          for (const t of askedTurns(call, variant)) {
            const replies: string[] = [];
            for (let k = 0; k < repeat; k += 1) {
              const res: AgentResult = await m.client.answer(t.ctx, budget);
              r.asked += 1;
              if (!res.ok && res.reason === 'error' && res.detail === AGENT_CASSETTE_MISS) {
                r.notRecorded += 1;
                continue;
              }
              if (res.usage !== undefined) {
                r.tokens.input += res.usage.inputTokens;
                r.tokens.output += res.usage.outputTokens;
                if (res.costUsd !== undefined) costKnown += res.costUsd;
                else {
                  unpriced.input += res.usage.inputTokens;
                  unpriced.output += res.usage.outputTokens;
                }
              }
              r.actions.of += 1;
              r.values.labelled += Object.keys(t.turn.values ?? {}).length;
              if (!res.ok && res.reason === 'error') {
                r.errors[res.detail] = (r.errors[res.detail] ?? 0) + 1;
                r.values.missed += Object.keys(t.turn.values ?? {}).length;
                r.mistakes.push({ call: call.id, turn: t.index + 1, what: `failed: ${res.detail}` });
                errorsInARow += 1;
                if (errorsInARow >= STOP_AFTER_ERRORS) throw new Stop(res.detail);
                continue;
              }
              errorsInARow = 0;
              ms.push(res.ms);
              if (!res.ok) {
                if (res.reason === 'timeout') r.timeouts += 1;
                else {
                  r.invalid += 1;
                  if (r.invalidWhy.length < 3) r.invalidWhy.push(res.detail);
                }
                r.values.missed += Object.keys(t.turn.values ?? {}).length;
                r.mistakes.push({ call: call.id, turn: t.index + 1, what: res.reason === 'timeout' ? `no answer within ${budget} ms` : `invalid: ${res.detail}` });
                continue;
              }
              r.valid += 1;
              const s = scoreAnswer(res.answer, t);
              r.values.right += s.right;
              r.values.wrong += s.wrong;
              r.values.missed += s.missed;
              r.values.extra += s.extra;
              r.values.wordsNotSaid += s.wordsNotSaid;
              if (s.actionRight) r.actions.right += 1;
              if (s.figure) r.figures += 1;
              for (const what of s.mistakes) r.mistakes.push({ call: call.id, turn: t.index + 1, what });
              replies.push(res.answer.reply);
            }
            if (t.turn.review !== undefined) r.reviewed.push({ call: call.id, turn: t.index + 1, review: t.turn.review, replies });
          }
        }
      } catch (e) {
        if (!(e instanceof Stop)) throw e;
        stopped = e.message;
        r.status = 'stopped';
        r.stopped = stopped;
      }
      if (r.status !== 'stopped' && r.notRecorded === r.asked && r.asked > 0) r.status = 'not-recorded';
      const price = opts.prices?.get(m.entry) ?? opts.prices?.get(m.client.model);
      const unpricedTokens = unpriced.input + unpriced.output;
      r.costUsd = unpricedTokens === 0 ? (r.tokens.input + r.tokens.output > 0 ? costKnown : null) : price === undefined ? null : costKnown + (unpriced.input * price.input + unpriced.output * price.output) / 1_000_000;
      r.ms = { measured: ms.length, p50: quantile(ms, 0.5), p95: quantile(ms, 0.95) };
      results.push(r);
    }
  }
  return {
    calls: calls.length,
    turns: calls.reduce((n, c) => n + c.turns.length, 0),
    repeat,
    replay: opts.replay === true,
    budgetMs: budget,
    ...(opts.judgeMs !== undefined ? { judgeMs: opts.judgeMs } : {}),
    results,
  };
}

/** The bar on a call, the judge included (the build plan, Task 2): p50 at most 1.0 s, p95 at most 1.8 s, valid JSON 98% or more, values right 90% or more. */
export const AGENT_BAR = { p50Ms: 1000, p95Ms: 1800, valid: 0.98, valuesRight: 0.9 } as const;

const pct = (n: number, of: number): string => (of === 0 ? '-' : `${((100 * n) / of).toFixed(0)}%`);
const share = (n: number, of: number): string => (of === 0 ? '-' : `${n}/${of} (${pct(n, of)})`);

/** Whether a result meets the bar, the judge's time added; null when it was not measured. */
export function meetsBar(r: AgentVariantResult, judgeMs: number): boolean | null {
  if (r.ms.p50 === null || r.ms.p95 === null) return null;
  const answered = r.asked - r.notRecorded;
  return r.ms.p50 + judgeMs <= AGENT_BAR.p50Ms && r.ms.p95 + judgeMs <= AGENT_BAR.p95Ms && r.valid / answered >= AGENT_BAR.valid && (r.values.labelled === 0 || r.values.right / r.values.labelled >= AGENT_BAR.valuesRight);
}

function head(r: AgentBakeoffReport): string[] {
  return ['model', 'prompt', 'asked', 'valid JSON', 'values right', 'wrong / missed / extra', 'words not said', 'actions right', 'figure not in facts', 'ms p50 / p95', ...(r.judgeMs !== undefined ? [`with judge (+${r.judgeMs} ms)`, 'meets the bar'] : []), 'tokens in / out', 'cost'];
}

function row(x: AgentVariantResult, r: AgentBakeoffReport): string[] {
  if (x.status === 'not-recorded') return [x.entry, x.variant, String(x.asked), 'not recorded', ...head(r).slice(4).map(() => '-')];
  const answered = x.asked - x.notRecorded;
  const latency = x.ms.p50 === null ? '-' : `${x.ms.p50} / ${x.ms.p95}`;
  const judged = r.judgeMs === undefined ? [] : [x.ms.p50 === null ? '-' : `${x.ms.p50 + r.judgeMs} / ${x.ms.p95! + r.judgeMs}`, meetsBar(x, r.judgeMs) === null ? '-' : meetsBar(x, r.judgeMs) ? 'yes' : 'no'];
  return [
    x.entry, x.variant, String(answered), share(x.valid, answered), share(x.values.right, x.values.labelled),
    `${x.values.wrong} / ${x.values.missed} / ${x.values.extra}`, String(x.values.wordsNotSaid), share(x.actions.right, x.actions.of), String(x.figures),
    latency, ...judged, `${x.tokens.input} / ${x.tokens.output}`, x.costUsd === null ? 'no price' : `$${x.costUsd.toFixed(4)}`,
  ];
}

function notes(r: AgentBakeoffReport): string[] {
  const out: string[] = [];
  for (const x of r.results) {
    const who = `${x.entry} (${x.variant})`;
    if (x.status === 'not-recorded') out.push(`${who}: not recorded; run without --replay to record it`);
    else if (x.notRecorded > 0) out.push(`${who}: ${x.notRecorded} of ${x.asked} turns not recorded, left out of the table`);
    if (x.status === 'stopped') out.push(`${who}: stopped, ${STOP_AFTER_ERRORS} requests in a row failed: ${x.stopped}`);
    for (const [why, n] of Object.entries(x.errors)) out.push(`${who}: ${n} failed request${n === 1 ? '' : 's'}: ${why}`);
    if (x.timeouts > 0) out.push(`${who}: ${x.timeouts} answers took longer than ${r.budgetMs} ms: not valid, and in the times at the budget`);
    for (const why of x.invalidWhy) out.push(`${who}: invalid: ${why}`);
    if (x.costUsd === null && x.tokens.input + x.tokens.output > 0) out.push(`${who}: the provider gave no cost and no price was given (--price ${x.model}=<input>,<output>)`);
  }
  return out;
}

/** The comparison as text: a header, the table, its notes, and with `byTurn` each result's mistakes and the replies to review. */
export function formatAgentBakeoff(r: AgentBakeoffReport, opts: { byTurn?: boolean } = {}): string[] {
  const rows = [head(r), ...r.results.map((x) => row(x, r))];
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((c) => (c[i] ?? '').length)));
  const out = [
    intro(r),
    '',
    ...rows.map((c) => c.map((cell, i) => cell.padEnd(widths[i]!)).join('  ').trimEnd()),
  ];
  const n = notes(r);
  if (n.length > 0) out.push('', ...n);
  if (opts.byTurn) {
    for (const x of r.results) {
      if (x.mistakes.length > 0) out.push('', `${x.entry} (${x.variant}), mistakes:`, ...x.mistakes.map((m) => `  ${m.call} turn ${m.turn}: ${m.what}`));
      if (x.reviewed.length > 0) out.push('', `${x.entry} (${x.variant}), replies to read:`, ...x.reviewed.flatMap((v) => [`  ${v.call} turn ${v.turn} (${v.review}):`, ...v.replies.map((reply) => `    "${reply}"`)]));
    }
  }
  return out;
}

function intro(r: AgentBakeoffReport): string {
  return `agent models on ${r.calls} calls, ${r.turns} caller turns${r.repeat > 1 ? `, each asked ${r.repeat} times` : ''}${r.replay ? ', replayed from their cassettes' : ''}; each answer within ${r.budgetMs} ms. Values right: each labelled value given and right. Extra: a value no label asked for. Words not said: a value whose cited words the caller never said. ms: the answer's time alone${r.judgeMs !== undefined ? `; with judge: plus ${r.judgeMs} ms for the drift judge, against the bar (p50 at most ${AGENT_BAR.p50Ms} ms, p95 at most ${AGENT_BAR.p95Ms} ms, valid JSON ${AGENT_BAR.valid * 100}%, values right ${AGENT_BAR.valuesRight * 100}%)` : ''}.`;
}

const md = (s: string): string => s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');

/** The comparison as a Markdown page (`--out`): the table, its notes, each result's mistakes, and the replies to review. */
export function formatAgentBakeoffMarkdown(r: AgentBakeoffReport): string {
  const h = head(r);
  const out = ['# Agent models compared', '', intro(r), '', `| ${h.join(' | ')} |`, `| ${h.map(() => '---').join(' | ')} |`, ...r.results.map((x) => `| ${row(x, r).map(md).join(' | ')} |`)];
  const n = notes(r);
  if (n.length > 0) out.push('', ...n.map((l) => `- ${md(l)}`));
  for (const x of r.results) {
    if (x.reviewed.length > 0) {
      out.push('', `## ${md(x.entry)} (${x.variant}): replies to read`, '');
      for (const v of x.reviewed) out.push(`- ${v.call} turn ${v.turn}, ${md(v.review)}:`, ...v.replies.map((reply) => `  - "${md(reply)}"`));
    }
    if (x.mistakes.length > 0) {
      out.push('', `## ${md(x.entry)} (${x.variant}): mistakes`, '');
      for (const m of x.mistakes) out.push(`- ${m.call} turn ${m.turn}: ${md(m.what)}`);
    }
  }
  return `${out.join('\n')}\n`;
}

/**
 * A client whose connection is opened before its first measured answer: the first time it is asked, it
 * asks once more beforehand and drops that answer, so the first turn's time is not its connection's setup.
 */
export function warmedUp(client: AgentClient): AgentClient {
  let warm = false;
  return {
    model: client.model,
    async answer(ctx, timeoutMs) {
      if (!warm) {
        warm = true;
        await client.answer(ctx, timeoutMs);
      }
      return client.answer(ctx, timeoutMs);
    },
  };
}

/** The case and turn `--print-prompt` prints: the retail call's price pushed, mid-call, with values collected. */
export const PRINTED_TURN = { call: 'retail-bmw', turn: 5 } as const;
