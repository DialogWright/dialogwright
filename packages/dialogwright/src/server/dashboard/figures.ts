import type { App } from '../../core/app/types';
import type { TraceRecord } from '../../trace/types';
import { isTopicSlot } from '../../core/knowledge';
import { KeywordRetriever } from '../../kb/keyword';
import { collectGaps, turnOf, GAP_KINDS, type CollectContext, type GapKind, type Turn } from '../../kb/gaps';
import { consoleMetaOf, type ConsoleMeta } from './meta';
import { askedWords, formLabel, handoffReasonText, withMeta } from './view.js';
import type { CallRow } from './rows';

/**
 * The console's Insights (and the Knowledge page's unanswered questions): figures worked out from the
 * traces, call by call (CallFacts, read with the call's summary, calls.ts), then summed by the hour the
 * call started in (HourFigures), which the daily figures cache keeps per app and UTC day (figuresCache.ts)
 * and a date range adds up (sumHours), then said in the app's console words (insightsOf).
 *
 * Only counts and durations, never a value: what is counted is keyed by what the app is made of (a form,
 * a slot, a rule, a handoff reason, a topic, a carrier) or by where a call stood in the app's console
 * labels, never by anything a caller said or gave. A cached file holds exactly HourFigures.
 */

/** A figures shape's version: a cache written by another is worked out again (figuresCache.ts). */
export const FIGURES_VERSION = 1;

/** The upper bounds, in seconds, of the call-length buckets (the last bucket is everything longer). */
export const LENGTH_EDGES_S: readonly number[] = [30, 60, 120, 300, 600, 1200];

/** Where callers struggle on one question: asked again, silent, run out of attempts. */
export interface Struggle {
  reasks: number;
  silences: number;
  ranOut: number;
}

/** What one call adds to the figures, beyond its summary (CallRow): read once from its trace, kept with the summary. */
export interface CallFacts {
  /** Each task (form) it worked on: whether it finished, and how long from its first turn to the turn that finished it. */
  tasks: Record<string, { finished: boolean; ms: number | null }>;
  /** Where it struggled, by what was asked (a slot's id, `intent`, `confirm`, `otp`). */
  asked: Record<string, Struggle>;
  /** Turns the injection screen fired on (quarantined or not). */
  screenHits: number;
  /** The gate's refusals (BLOCK or NEEDS_HUMAN), counted once for each rule that failed. */
  refusals: Record<string, number>;
  /** The gate's step-ups (the call needs a higher identity level first). */
  stepUps: number;
  /** Routes taken by a rule that reads `hours` (business hours), by `<point>:<what followed>`. */
  hours: Record<string, number>;
  /** The knowledge base's unanswered questions (kb/gaps.ts), by kind and by nearest topic (`~` for none), with the latest. */
  gaps: Partial<Record<GapKind, number>>;
  gapTopics: Record<string, { n: number; latest: string }>;
}

/** The figures of the calls that started in one hour (or, summed, a range): counts, durations and dollars only. */
export interface HourFigures {
  calls: number;
  ended: number;
  /** Ended handled to the end by the agent, with no handoff (Console 1's containment). */
  contained: number;
  toPerson: number;
  hungUp: number;
  errors: number;
  /** The most calls in progress at once, among the calls that started this day (a call that started the day before is not counted). */
  peak: number;
  /** Of the calls that ended: their lengths summed, and how many fell in each LENGTH_EDGES_S bucket. */
  lengthMs: number;
  lengths: number[];
  /** Voice calls, their length summed (to the last word for one in progress), and by carrier the minutes billed: each call rounded up to the minute, at least one. */
  voice: number;
  voiceMs: number;
  billedMinutes: Record<string, number>;
  /** The decision model's cost, from every record's usage (exact). */
  costUsd: number;
  /** Calls handed to a person, by the handoff reason's code. */
  transfers: Record<string, number>;
  /** Calls the caller hung up on, by where they stood (the task and step in the app's labels, or the greeting). */
  abandoned: Record<string, number>;
  asked: Record<string, Struggle>;
  /** Each task: the calls that started it, finished it, and the time the finished ones took. */
  tasks: Record<string, { started: number; finished: number; ms: number }>;
  screenHits: number;
  refusals: Record<string, number>;
  stepUps: number;
  /** Calls routed by a rule reading business hours, and the routes by `<point>:<what followed>`. */
  afterHours: number;
  hours: Record<string, number>;
  gaps: number;
  gapKinds: Partial<Record<GapKind, number>>;
  gapTopics: Record<string, { n: number; latest: string }>;
}

/** No figures: an hour with no call. */
export function emptyHour(): HourFigures {
  return {
    calls: 0, ended: 0, contained: 0, toPerson: 0, hungUp: 0, errors: 0, peak: 0, lengthMs: 0, lengths: LENGTH_EDGES_S.map(() => 0).concat(0),
    voice: 0, voiceMs: 0, billedMinutes: {}, costUsd: 0, transfers: {}, abandoned: {}, asked: {}, tasks: {}, screenHits: 0, refusals: {}, stepUps: 0,
    afterHours: 0, hours: {}, gaps: 0, gapKinds: {}, gapTopics: {},
  };
}

const ENGINE_ASKS = new Set(['intent', 'confirm', 'otp']);
const bump = (m: Record<string, number>, k: string, n = 1): void => { m[k] = (m[k] ?? 0) + n; };
const struggleOf = (m: Record<string, Struggle>, k: string): Struggle => (m[k] ??= { reasks: 0, silences: 0, ranOut: 0 });
const msOf = (ts: string): number | null => {
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : null;
};

/** The topic slots and informational intents of an app, and its nearest topic by keywords: what a gap is found with (kb/gaps.ts). */
function gapContextOf(app: App): CollectContext {
  const topicSlots = new Set(Object.entries(app.slots).filter(([, s]) => isTopicSlot(s)).map(([id]) => id));
  const informational = new Set(Object.entries(app.intents ?? {}).filter(([, i]) => i.kind === 'informational').map(([id]) => id));
  const kb = app.knowledge?.kb;
  const keyword = kb ? new KeywordRetriever(kb) : null;
  return {
    topicSlots,
    informational,
    nearest: (words, locale) => (keyword && kb ? keyword.scores(words, locale ?? kb.defaultLocale)[0]?.topic ?? null : null),
  };
}
const gapContexts = new WeakMap<App, CollectContext>();

/**
 * What a call adds to the figures, from its records as on disk (the writer's masks already on them):
 * nothing here keeps a value, only what was asked and counts.
 */
export function factsOfTrace(records: readonly TraceRecord[], app: App): CallFacts {
  const facts: CallFacts = { tasks: {}, asked: {}, screenHits: 0, refusals: {}, stepUps: 0, hours: {}, gaps: {}, gapTopics: {} };
  const firstOn = new Map<string, number | null>();
  let prev: TraceRecord | null = null;
  for (const r of records) {
    if (r.outlivedHold === true) continue;
    const at = msOf(r.ts);
    // Tasks: started when a turn is on its form, finished when the form is among those completed.
    for (const f of [r.form, ...(Array.isArray(r.completed) ? r.completed : [])]) {
      if (typeof f !== 'string' || facts.tasks[f]) continue;
      facts.tasks[f] = { finished: false, ms: null };
      firstOn.set(f, at);
    }
    for (const f of Array.isArray(r.completed) ? r.completed : []) {
      const t = facts.tasks[f];
      if (!t || t.finished) continue;
      t.finished = true;
      const from = firstOn.get(f) ?? null;
      t.ms = from !== null && at !== null ? Math.max(0, at - from) : null;
    }
    // Struggles: a silence is the question asked before it; a re-ask is a slot asked again after an
    // answer that did not fill it (its attempts counted up; the intent, a confirmation or a code asked
    // again is not told apart from asked anew, so only their silences and running out are counted); a
    // slot runs out when it is exhausted, or the call is handed off for attempts.
    const before = prev?.promptedFor ?? null;
    if (r.event?.type === 'user.silence' && typeof before === 'string') struggleOf(facts.asked, before).silences += 1;
    const asked = r.promptedFor;
    if (typeof asked === 'string' && !ENGINE_ASKS.has(asked) && r.decision?.kind === 'prompt' && r.event?.type !== 'user.silence') {
      const now = r.slots?.[asked]?.attempts ?? 0;
      const was = prev?.slots?.[asked]?.attempts ?? 0;
      if (now > was && before === asked) struggleOf(facts.asked, asked).reasks += 1;
    }
    if (r.slotExhausted) struggleOf(facts.asked, r.slotExhausted.slot).ranOut += 1;
    else if (r.decision?.kind === 'handoff' && r.decision.reason === 'max-attempts') {
      const which = (typeof asked === 'string' ? asked : null) ?? before;
      if (which) struggleOf(facts.asked, which).ranOut += 1;
    }
    // Safety: the screen's hits, and the gate's refusals by the rules that failed.
    if (r.screen?.fired === true || r.quarantined === true) facts.screenHits += 1;
    for (const g of r.gateEvents ?? []) {
      const d = g?.decision;
      if (!d) continue;
      if (d.verdict === 'STEP_UP') facts.stepUps += 1;
      if (d.verdict !== 'BLOCK' && d.verdict !== 'NEEDS_HUMAN') continue;
      const failed = (d.rules ?? []).filter((x) => x && x.pass === false).map((x) => x.id);
      for (const id of failed.length > 0 ? failed : [d.reason ?? 'unlisted']) bump(facts.refusals, id);
    }
    // Business hours: a route taken by a rule that reads them.
    for (const route of r.routes ?? []) if (route.subjects?.includes('hours')) bump(facts.hours, `${route.point}:${route.outcome}`);
    prev = r;
  }
  // The knowledge base's unanswered questions, by kb:gaps' rules (never the words: only their kind and nearest topic).
  if (app.knowledge) {
    let ctx = gapContexts.get(app);
    if (!ctx) { ctx = gapContextOf(app); gapContexts.set(app, ctx); }
    const turns = records.map((r, i) => turnOf(r, '', i + 1)).filter((t): t is Turn => t !== null);
    for (const g of collectGaps(turns, ctx).gaps) {
      facts.gaps[g.kind] = (facts.gaps[g.kind] ?? 0) + 1;
      const key = g.topic ?? '~';
      const had = facts.gapTopics[key] ?? { n: 0, latest: '' };
      facts.gapTopics[key] = { n: had.n + 1, latest: g.ts > had.latest ? g.ts : had.latest };
    }
  }
  return facts;
}

/** One call's summary and facts, as the figures read them. */
export interface CallSummary {
  row: CallRow;
  facts: CallFacts;
}

const HOUR_MS = 3_600_000;
/** The hour (UTC) a time is in, as its first millisecond. */
export const hourOf = (ms: number): number => Math.floor(ms / HOUR_MS) * HOUR_MS;

/** A call's length to its end, or to its last word while it is in progress. */
function lengthOf(row: CallRow): number {
  const until = row.endedAt ?? row.lastAt;
  return row.startedAt !== null && until !== null ? Math.max(0, until - row.startedAt) : 0;
}

function addRecord(into: Record<string, number>, from: Record<string, number>): void {
  for (const [k, v] of Object.entries(from)) bump(into, k, v);
}

/** Adds one call to its hour's figures. */
function addCall(h: HourFigures, { row, facts }: CallSummary): void {
  h.calls += 1;
  h.costUsd += row.costUsd;
  const length = lengthOf(row);
  if (row.ending !== null) {
    h.ended += 1;
    const kind = row.ending.kind;
    if (kind === 'handled') h.contained += 1;
    else if (kind === 'person') { h.toPerson += 1; bump(h.transfers, row.handoffReason ?? row.ending.reason ?? 'unknown'); }
    else if (kind === 'hangup') { h.hungUp += 1; bump(h.abandoned, row.ending.where ?? 'unknown'); }
    else h.errors += 1;
    h.lengthMs += length;
    const bucket = LENGTH_EDGES_S.findIndex((edge) => length < edge * 1000);
    h.lengths[bucket < 0 ? LENGTH_EDGES_S.length : bucket]! += 1;
  }
  if (row.channel !== 'chat') {
    h.voice += 1;
    h.voiceMs += length;
    bump(h.billedMinutes, row.provider ?? 'unknown', Math.max(1, Math.ceil(length / 60_000)));
  }
  for (const [k, s] of Object.entries(facts.asked)) {
    const t = struggleOf(h.asked, k);
    t.reasks += s.reasks; t.silences += s.silences; t.ranOut += s.ranOut;
  }
  for (const [form, t] of Object.entries(facts.tasks)) {
    const into = (h.tasks[form] ??= { started: 0, finished: 0, ms: 0 });
    into.started += 1;
    if (t.finished) { into.finished += 1; into.ms += t.ms ?? 0; }
  }
  h.screenHits += facts.screenHits;
  addRecord(h.refusals, facts.refusals);
  h.stepUps += facts.stepUps;
  if (Object.keys(facts.hours).length > 0) h.afterHours += 1;
  addRecord(h.hours, facts.hours);
  for (const [k, n] of Object.entries(facts.gaps) as [GapKind, number][]) { h.gaps += n; h.gapKinds[k] = (h.gapKinds[k] ?? 0) + n; }
  mergeTopics(h.gapTopics, facts.gapTopics);
}

function mergeTopics(into: HourFigures['gapTopics'], from: HourFigures['gapTopics']): void {
  for (const [k, g] of Object.entries(from)) {
    const had = into[k] ?? { n: 0, latest: '' };
    into[k] = { n: had.n + g.n, latest: g.latest > had.latest ? g.latest : had.latest };
  }
}

/**
 * The figures of a day's calls by the hour each started in (UTC, keyed by the hour's first ms), with the
 * peak at once in each hour among them. `calls` are the day's: each started in it.
 */
export function hoursOf(calls: readonly CallSummary[]): Record<string, HourFigures> {
  const out: Record<string, HourFigures> = {};
  const started = calls.filter((c) => c.row.startedAt !== null);
  for (const c of started) addCall((out[String(hourOf(c.row.startedAt!))] ??= emptyHour()), c);
  // The peak at once: a sweep over the calls' starts and ends, the most in progress at any moment of each hour.
  const edges: [number, number][] = [];
  for (const c of started) {
    const start = c.row.startedAt!;
    edges.push([start, 1], [Math.max(start, c.row.endedAt ?? c.row.lastAt ?? start), -1]);
  }
  edges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let now = 0;
  for (const [at, d] of edges) {
    now += d;
    const h = out[String(hourOf(at))];
    if (h && now > h.peak) h.peak = now;
  }
  // An hour none started in but some were going through keeps no figures of its own: its peak shows in the hour they started.
  for (const h of Object.values(out)) h.costUsd = Math.round(h.costUsd * 1e6) / 1e6;
  return out;
}

/** Hours (or days) summed: counts and durations added, the peak the most of any. */
export function sumHours(hours: readonly HourFigures[]): HourFigures {
  const s = emptyHour();
  for (const h of hours) {
    for (const k of ['calls', 'ended', 'contained', 'toPerson', 'hungUp', 'errors', 'lengthMs', 'voice', 'voiceMs', 'costUsd', 'screenHits', 'stepUps', 'afterHours', 'gaps'] as const) s[k] += h[k];
    s.peak = Math.max(s.peak, h.peak);
    h.lengths.forEach((n, i) => { s.lengths[i] = (s.lengths[i] ?? 0) + n; });
    addRecord(s.billedMinutes, h.billedMinutes);
    addRecord(s.transfers, h.transfers);
    addRecord(s.abandoned, h.abandoned);
    for (const [k, x] of Object.entries(h.asked)) {
      const t = struggleOf(s.asked, k);
      t.reasks += x.reasks; t.silences += x.silences; t.ranOut += x.ranOut;
    }
    for (const [k, t] of Object.entries(h.tasks)) {
      const into = (s.tasks[k] ??= { started: 0, finished: 0, ms: 0 });
      into.started += t.started; into.finished += t.finished; into.ms += t.ms;
    }
    addRecord(s.refusals, h.refusals);
    addRecord(s.hours, h.hours);
    for (const [k, n] of Object.entries(h.gapKinds) as [GapKind, number][]) s.gapKinds[k] = (s.gapKinds[k] ?? 0) + n;
    mergeTopics(s.gapTopics, h.gapTopics);
  }
  s.costUsd = Math.round(s.costUsd * 1e6) / 1e6;
  return s;
}

// ---------------------------------------------------------------------------------------------
// Said in the app's words: what the Insights page draws
// ---------------------------------------------------------------------------------------------

/** One app's figures for a range, as summed, with the app it is (null on a server of one). */
export interface AppFigures {
  id: string | null;
  app: App;
  figures: HourFigures;
  /** Its figures by the hour, for the calls-by-hour chart. */
  hours: Record<string, HourFigures>;
}

/** A row of a table the page draws: its app's name on a host, its label in the app's words, and its numbers. */
export interface LabelledRow<T> {
  app: string | null;
  key: string;
  label: string;
  value: T;
}

/** The carrier's cost when a rate is set: each carrier's billed minutes at its rate. */
export interface CarrierCost {
  usd: number;
  byCarrier: { carrier: string; minutes: number; ratePerMin: number; usd: number }[];
  /** Billed minutes on a carrier with no rate (counted, not priced). */
  unpriced: number;
}

/** What /dashboard/insights answers: the range's figures, totalled and in each app's words. */
export interface Insights {
  totals: Omit<HourFigures, 'asked' | 'tasks' | 'transfers' | 'abandoned' | 'refusals' | 'hours' | 'gapTopics'>;
  containment: number | null;
  /** The length of the calls that ended, on average (null with none). */
  meanLengthMs: number | null;
  /** Minutes on voice calls, exact. */
  minutes: number;
  carrier: CarrierCost | null;
  /** The decision model's cost, the carrier's (when priced), per call and per handled call. */
  cost: { modelUsd: number; carrierUsd: number | null; totalUsd: number; perCall: number | null; perHandled: number | null };
  byHour: { hour: number; calls: number; peak: number }[];
  transfers: LabelledRow<number>[];
  abandoned: LabelledRow<number>[];
  struggles: LabelledRow<Struggle>[];
  tasks: LabelledRow<{ started: number; finished: number; meanMs: number | null }>[];
  refusals: LabelledRow<number>[];
  hours: LabelledRow<number>[];
  gapTopics: LabelledRow<{ n: number; latest: string }>[];
}

const byCount = <T>(n: (r: LabelledRow<T>) => number) => (a: LabelledRow<T>, b: LabelledRow<T>): number => n(b) - n(a) || a.label.localeCompare(b.label);

/** The routes' outcomes in words. */
const ROUTE_WORDS: Record<string, string> = { handoff: 'to a person', end: 'ended', 'anything-else': 'asked what else', form: 'into a task', continue: 'went on', locale: 'changed language' };
const POINT_WORDS: Record<string, string> = { start: 'at the start', afterIdentity: 'after identity', afterForm: 'after a task' };

/** A topic's title in an app's knowledge, else its id; "no near topic" for `~`. */
function topicTitle(app: App, topic: string): string {
  if (topic === '~') return 'no near topic';
  const kb = app.knowledge?.kb;
  if (kb && Object.hasOwn(kb.topics, topic)) return kb.topics[topic]!.title;
  return app.knowledge?.topics?.find((t) => t.id === topic)?.title ?? topic;
}

/** The figures for a range, said in each app's console words; `rates` the carriers' rates a minute (config.carrierRates). */
export function insightsOf(apps: readonly AppFigures[], rates: Readonly<Partial<Record<string, number>>> | undefined): Insights {
  const all = sumHours(apps.map((a) => a.figures));
  const named = apps.length > 1 || apps.some((a) => a.id !== null);
  const labelled = <T>(pick: (a: AppFigures, meta: ConsoleMeta) => [string, string, T][]): LabelledRow<T>[] => apps.flatMap((a) => {
    const meta = consoleMetaOf(a.app);
    return withMeta(meta, () => pick(a, meta)).map(([key, label, value]) => ({ app: named ? (a.app.brand?.name ?? a.id) : null, key, label, value }));
  });
  const reasonWords = (meta: ConsoleMeta, code: string): string => (Object.hasOwn(meta.handoffReasons, code) ? meta.handoffReasons[code]! : handoffReasonText(code));

  // The carrier's cost: only with a rate set for some carrier; a call on a carrier with no rate is counted, not priced.
  let carrier: CarrierCost | null = null;
  if (rates && Object.keys(rates).length > 0) {
    const byCarrier: CarrierCost['byCarrier'] = [];
    let unpriced = 0;
    for (const [c, minutes] of Object.entries(all.billedMinutes).sort()) {
      const rate = rates[c];
      if (rate === undefined) { unpriced += minutes; continue; }
      byCarrier.push({ carrier: c, minutes, ratePerMin: rate, usd: Math.round(minutes * rate * 1e4) / 1e4 });
    }
    carrier = { usd: Math.round(byCarrier.reduce((s, x) => s + x.usd, 0) * 1e4) / 1e4, byCarrier, unpriced };
  }
  const carrierUsd = carrier?.usd ?? null;
  const totalUsd = Math.round((all.costUsd + (carrierUsd ?? 0)) * 1e6) / 1e6;
  const hourly = new Map<number, { calls: number; peak: number }>();
  for (const a of apps) {
    for (const [k, h] of Object.entries(a.hours)) {
      const had = hourly.get(Number(k)) ?? { calls: 0, peak: 0 };
      // Apps' peaks are added: their calls can be at once.
      hourly.set(Number(k), { calls: had.calls + h.calls, peak: had.peak + h.peak });
    }
  }
  const { asked: _a, tasks: _t, transfers: _tr, abandoned: _ab, refusals: _r, hours: _h, gapTopics: _g, ...totals } = all;
  if (apps.length > 1) totals.peak = Math.max(totals.peak, ...[...hourly.values()].map((h) => h.peak));
  return {
    totals,
    containment: all.ended === 0 ? null : all.contained / all.ended,
    meanLengthMs: all.ended === 0 ? null : Math.round(all.lengthMs / all.ended),
    minutes: Math.round((all.voiceMs / 60_000) * 10) / 10,
    carrier,
    cost: { modelUsd: all.costUsd, carrierUsd, totalUsd, perCall: all.calls === 0 ? null : totalUsd / all.calls, perHandled: all.contained === 0 ? null : totalUsd / all.contained },
    byHour: [...hourly].sort((x, y) => x[0] - y[0]).map(([hour, h]) => ({ hour, ...h })),
    transfers: labelled((a, meta) => Object.entries(a.figures.transfers).map(([code, n]) => [code, reasonWords(meta, code), n] as [string, string, number])).sort(byCount((r) => r.value)),
    abandoned: labelled((a) => Object.entries(a.figures.abandoned).map(([where, n]) => [where, where, n] as [string, string, number])).sort(byCount((r) => r.value)),
    struggles: labelled((a) => Object.entries(a.figures.asked).map(([k, s]) => [k, askedWords(k), s] as [string, string, Struggle]))
      .filter((r) => r.value.reasks + r.value.silences + r.value.ranOut > 0)
      .sort(byCount((r) => r.value.reasks + r.value.silences + r.value.ranOut)),
    tasks: labelled((a) => Object.entries(a.figures.tasks).map(([form, t]) => [form, formLabel(form), { started: t.started, finished: t.finished, meanMs: t.finished === 0 ? null : Math.round(t.ms / t.finished) }] as [string, string, { started: number; finished: number; meanMs: number | null }]))
      .sort(byCount((r) => r.value.started)),
    refusals: labelled((a) => Object.entries(a.figures.refusals).map(([rule, n]) => [rule, rule, n] as [string, string, number])).sort(byCount((r) => r.value)),
    hours: labelled((a) => Object.entries(a.figures.hours).map(([k, n]) => {
      const [point, then] = k.split(':');
      return [k, `${POINT_WORDS[point!] ?? point}, ${ROUTE_WORDS[then!] ?? then}`, n] as [string, string, number];
    })).sort(byCount((r) => r.value)),
    // Ranked as kb:gaps ranks its groups: how many, then the latest, then the topic.
    gapTopics: labelled((a) => Object.entries(a.figures.gapTopics).map(([topic, g]) => [topic, topicTitle(a.app, topic), g] as [string, string, { n: number; latest: string }]))
      .sort((x, y) => y.value.n - x.value.n || (y.value.latest > x.value.latest ? 1 : y.value.latest < x.value.latest ? -1 : 0) || x.key.localeCompare(y.key)),
  };
}

export { GAP_KINDS };
