import type { App } from '../../core/app/types';
import type { TraceRecord } from '../../trace/types';
import { isTopicSlot } from '../../core/knowledge';
import { rulesAt } from '../../core/routes';
import { KeywordRetriever } from '../../kb/keyword';
import { collectGaps, turnOf, GAP_KINDS, type CollectContext, type GapKind, type Turn } from '../../kb/gaps';
import { consoleMetaOf, type ConsoleMeta } from './meta';
import { askedWords, formLabel, handoffReasonText, withMeta } from './view.js';
import type { CallRow } from './rows';
import { addRenderCall, emptyRenderFigures, renderFactsOf, renderFiguresOf, sumRender, wordingInsightsOf, type RenderCallFacts, type RenderFigures, type WordingInsights } from './wordingFigures';

/**
 * The console's Insights (and the Knowledge page's unanswered questions): figures worked out from the
 * traces, call by call (CallFacts, read with the call's summary, calls.ts), then summed by the hour the
 * call started in (HourFigures) with how many calls were in progress each minute, which the daily
 * figures cache keeps per app and UTC day (figuresCache.ts) and a date range adds up (sumHours), then
 * said in the app's console words (insightsOf).
 *
 * Only counts, durations and dollars, never a value: what is counted is keyed by what the app is made of
 * (a form, a slot, a rule, a handoff reason, a topic, a carrier, a route), never by anything a caller
 * said or gave; where a caller hung up is kept as the form and what was asked (ids), and said in the
 * app's labels as it is shown. A day's file holds exactly DayData.
 */

/**
 * A figures shape's version: a cache written by another is worked out again from its traces, or, for a
 * closed day whose traces are gone, read as it can be (figuresCache.ts). 2: each call's span for the
 * peak at once, the abandoned by ids, the routes on business hours by open or closed. 3: no call's own
 * times, only how many were in progress each minute (a version-2 file is made so as it is read).
 */
export const FIGURES_VERSION = 3;

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
  /** Where it stood at its last turn, by ids (`<form>|<asked>`, `greeting`, `between`, `after:<form>`): where a caller who hung up left. */
  stopped: string;
  /** Turns the injection screen fired on (quarantined or not). */
  screenHits: number;
  /** The gate's refusals (BLOCK or NEEDS_HUMAN), counted once for each rule that failed. */
  refusals: Record<string, number>;
  /** The gate's step-ups (the call needs a higher identity level first). */
  stepUps: number;
  /** Routes taken by a rule on the business hours, by `<point>:<open|closed>:<what followed>`. */
  hours: Record<string, number>;
  /** The knowledge base's unanswered questions (kb/gaps.ts), by kind and by nearest topic (`~` for none), with the latest. */
  gaps: Partial<Record<GapKind, number>>;
  /** By nearest topic: how many, and the hour (UTC, ISO) of the latest. */
  gapTopics: Record<string, { n: number; latest: string }>;
  /** Generated wording (wordingFigures.ts): only for a call with a render record (an app that generates lines, run with a renderer). */
  render?: RenderCallFacts;
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
  /** Calls the caller hung up on, by where they stood (CallFacts.stopped). */
  abandoned: Record<string, number>;
  asked: Record<string, Struggle>;
  /** Each task: the calls that started it, finished it, and the time the finished ones took. */
  tasks: Record<string, { started: number; finished: number; ms: number }>;
  screenHits: number;
  refusals: Record<string, number>;
  stepUps: number;
  /** Calls a route on the business hours sent somewhere, and the routes by `<point>:<open|closed>:<what followed>`. */
  hoursRouted: number;
  hours: Record<string, number>;
  gaps: number;
  gapKinds: Partial<Record<GapKind, number>>;
  gapTopics: Record<string, { n: number; latest: string }>;
  /** Generated wording's figures (wordingFigures.ts): only in an hour with a call of an app that generates lines; absent otherwise, and in figures written before. */
  render?: RenderFigures;
}

/** The minutes a day's calls in progress are counted over: the day's own and the next day's (a call of the day going on past midnight; a call lasts at most a day). */
export const DAY_MINUTES = 1_440;
export const COUNTED_MINUTES = 2 * DAY_MINUTES;
const MINUTE_MS = 60_000;

/**
 * A day's figures: by the hour each call started in; for each minute from the day's start to the end of
 * the next day, how many of the day's calls were in progress at some moment of it (no call's own times:
 * counts by the minute); and, for figures of an older version, the peak each hour had.
 */
export interface DayData {
  hours: Record<string, HourFigures>;
  minutes: Uint16Array;
  peaks?: Record<string, number>;
}

/** No figures: an hour with no call. */
export function emptyHour(): HourFigures {
  return {
    calls: 0, ended: 0, contained: 0, toPerson: 0, hungUp: 0, errors: 0, lengthMs: 0, lengths: LENGTH_EDGES_S.map(() => 0).concat(0),
    voice: 0, voiceMs: 0, billedMinutes: {}, costUsd: 0, transfers: {}, abandoned: {}, asked: {}, tasks: {}, screenHits: 0, refusals: {}, stepUps: 0,
    hoursRouted: 0, hours: {}, gaps: 0, gapKinds: {}, gapTopics: {},
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
    documents: kb?.settings.documents?.summarize === 'on',
  };
}
const gapContexts = new WeakMap<App, CollectContext>();

/** Whether a route's rule read the business hours (the default's, `hours`, or a named schedule's, `hours.<name>`). */
const readsHours = (subjects: readonly string[] | undefined): boolean => (subjects ?? []).some((s) => s === 'hours' || s.startsWith('hours.'));

/**
 * What a call adds to the figures, from its records as on disk (the writer's masks already on them):
 * nothing here keeps a value, only what was asked and counts.
 */
export function factsOfTrace(records: readonly TraceRecord[], app: App): CallFacts {
  const facts: CallFacts = { tasks: {}, asked: {}, stopped: 'greeting', screenHits: 0, refusals: {}, stepUps: 0, hours: {}, gaps: {}, gapTopics: {} };
  const firstOn = new Map<string, number | null>();
  const turns = new Set<number>();
  let prev: TraceRecord | null = null;
  let lastAct: TraceRecord | null = null;
  for (const r of records) {
    if (r.outlivedHold === true) continue;
    turns.add(r.turnIndex);
    const at = msOf(r.ts);
    if ((r.questions !== null && r.questions !== undefined) || (r.decision?.kind !== 'ignore' && r.decision?.kind !== 'hold')) lastAct = r;
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
    // Business hours: a route taken by a rule that reads them, open or closed as the rule asks (the app's routes.yaml).
    for (const route of r.routes ?? []) {
      if (!readsHours(route.subjects)) continue;
      const rule = typeof route.rule === 'number' ? rulesAt(app, route.point, route.form)[route.rule - 1] : undefined;
      const cond = rule?.when.find((c) => c.kind === 'hours') as { open?: boolean } | undefined;
      bump(facts.hours, `${route.point}:${cond?.open === undefined ? '' : cond.open ? 'open' : 'closed'}:${route.outcome}`);
    }
    prev = r;
  }
  // Where the call stood at its last turn, by ids (said in the app's labels as it is shown).
  if (lastAct) {
    const form = typeof lastAct.form === 'string' ? lastAct.form : '';
    const askedNow = lastAct.pendingConfirmation ? 'confirm' : typeof lastAct.promptedFor === 'string' ? lastAct.promptedFor : '';
    const completed = Array.isArray(lastAct.completed) ? lastAct.completed : [];
    if (form === '' && turns.size <= 1) facts.stopped = 'greeting';
    else if (form !== '' || askedNow !== '') facts.stopped = `${form}|${askedNow}`;
    else facts.stopped = completed.length > 0 ? `after:${completed.at(-1)}` : 'between';
  }
  // The knowledge base's unanswered questions, by kb:gaps' rules (never the words: only their kind and nearest topic).
  if (app.knowledge) {
    let ctx = gapContexts.get(app);
    if (!ctx) { ctx = gapContextOf(app); gapContexts.set(app, ctx); }
    const gapTurns = records.map((r, i) => turnOf(r, '', i + 1)).filter((t): t is Turn => t !== null);
    for (const g of collectGaps(gapTurns, ctx).gaps) {
      facts.gaps[g.kind] = (facts.gaps[g.kind] ?? 0) + 1;
      const key = g.topic ?? '~';
      const had = facts.gapTopics[key] ?? { n: 0, latest: '' };
      // The hour it was asked in, as the figures count calls by the hour: no call's own time.
      const at = msOf(g.ts);
      const hour = at === null ? '' : new Date(hourOf(at)).toISOString();
      facts.gapTopics[key] = { n: had.n + 1, latest: hour > had.latest ? hour : had.latest };
    }
  }
  // Generated wording: the call's group, and what the two groups are compared on (only a call with a render record).
  const render = renderFactsOf(records, Object.values(facts.asked).reduce((n, s) => n + s.reasks, 0));
  if (render !== null) facts.render = render;
  return facts;
}

/** Where a call stood (CallFacts.stopped, or an older figure's own words, `text:<words>`), in the console's words for the app in force. */
export function stoppedWords(key: string): string {
  if (key === 'greeting') return 'the greeting';
  if (key === 'between') return 'between tasks';
  if (key.startsWith('text:')) return key.slice('text:'.length);
  if (key.startsWith('after:')) return `after ${formLabel(key.slice('after:'.length))}`;
  const [form, asked] = key.split('|');
  return [form ? formLabel(form) : '', asked ? askedWords(asked) : ''].filter(Boolean).join(' · ') || 'between tasks';
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
    else if (kind === 'hangup') { h.hungUp += 1; bump(h.abandoned, facts.stopped); }
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
  if (Object.keys(facts.hours).length > 0) h.hoursRouted += 1;
  addRecord(h.hours, facts.hours);
  for (const [k, n] of Object.entries(facts.gaps) as [GapKind, number][]) { h.gaps += n; h.gapKinds[k] = (h.gapKinds[k] ?? 0) + n; }
  mergeTopics(h.gapTopics, facts.gapTopics);
  if (facts.render) addRenderCall((h.render ??= emptyRenderFigures()), facts.render, { ending: row.ending?.kind ?? null, lengthMs: length, costUsd: row.costUsd });
}

function mergeTopics(into: HourFigures['gapTopics'], from: HourFigures['gapTopics']): void {
  for (const [k, g] of Object.entries(from)) {
    const had = into[k] ?? { n: 0, latest: '' };
    into[k] = { n: had.n + g.n, latest: g.latest > had.latest ? g.latest : had.latest };
  }
}

/**
 * A day's figures: its calls by the hour each started in (UTC, keyed by the hour's first ms), and how many
 * were in progress in each minute (DayData.minutes, from `dayStart`), from which a range's peak at once
 * is worked out to the minute (peaksByHour). `calls` are the day's: each started in it. A call in
 * progress counts to its last word.
 */
export function dayDataOf(calls: readonly CallSummary[], dayStart: number): DayData {
  const hours: Record<string, HourFigures> = {};
  const diff = new Int32Array(COUNTED_MINUTES + 1);
  for (const c of calls) {
    if (c.row.startedAt === null) continue;
    addCall((hours[String(hourOf(c.row.startedAt))] ??= emptyHour()), c);
    const start = c.row.startedAt;
    const end = Math.max(start + 1, c.row.endedAt ?? c.row.lastAt ?? start);
    const first = Math.max(0, Math.floor((start - dayStart) / MINUTE_MS));
    const last = Math.min(COUNTED_MINUTES - 1, Math.floor((end - 1 - dayStart) / MINUTE_MS));
    if (last < first) continue;
    diff[first]! += 1;
    diff[last + 1]! -= 1;
  }
  const minutes = new Uint16Array(COUNTED_MINUTES);
  let now = 0;
  for (let m = 0; m < COUNTED_MINUTES; m++) {
    now += diff[m]!;
    minutes[m] = Math.min(65_535, now);
  }
  for (const h of Object.values(hours)) h.costUsd = Math.round(h.costUsd * 1e6) / 1e6;
  return { hours, minutes };
}

/** A day's counts by the minute, as a file keeps them: runs of the same count, `[first minute, how many minutes, count]`, the quiet minutes left out. */
export function minutesToRuns(minutes: Uint16Array): number[] {
  const runs: number[] = [];
  for (let m = 0; m < minutes.length;) {
    const n = minutes[m]!;
    let k = m + 1;
    while (k < minutes.length && minutes[k] === n) k++;
    if (n > 0) runs.push(m, k - m, n);
    m = k;
  }
  return runs;
}

/** A file's runs read back as a day's counts by the minute; null for runs that are not counts inside the day's minutes. */
export function runsToMinutes(runs: unknown): Uint16Array | null {
  if (!Array.isArray(runs) || runs.length % 3 !== 0) return null;
  const minutes = new Uint16Array(COUNTED_MINUTES);
  for (let i = 0; i < runs.length; i += 3) {
    const [m, len, n] = [runs[i], runs[i + 1], runs[i + 2]];
    if (![m, len, n].every((x) => Number.isInteger(x) && (x as number) >= 0) || (len as number) < 1 || (m as number) + (len as number) > COUNTED_MINUTES || (n as number) > 65_535) return null;
    minutes.fill(n as number, m as number, (m as number) + (len as number));
  }
  return minutes;
}

/** A version-2 file's calls' spans (flat start, end pairs) made counts by the minute, as version 3 keeps them; null for spans not of that shape. */
function spansToMinutes(spans: unknown, dayStart: number): Uint16Array | null {
  if (!Array.isArray(spans) || spans.length % 2 !== 0 || !spans.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0)) return null;
  const diff = new Int32Array(COUNTED_MINUTES + 1);
  for (let i = 0; i < spans.length; i += 2) {
    const start = spans[i] as number;
    const end = Math.max(start + 1, spans[i + 1] as number);
    const first = Math.max(0, Math.floor((start - dayStart) / MINUTE_MS));
    const last = Math.min(COUNTED_MINUTES - 1, Math.floor((end - 1 - dayStart) / MINUTE_MS));
    if (last < first) continue;
    diff[first]! += 1;
    diff[last + 1]! -= 1;
  }
  const minutes = new Uint16Array(COUNTED_MINUTES);
  let now = 0;
  for (let m = 0; m < COUNTED_MINUTES; m++) { now += diff[m]!; minutes[m] = Math.min(65_535, now); }
  return minutes;
}

/**
 * The most calls in progress at once in each hour of [from, to], from counts by the minute of every app
 * together (`counts[i]` the minute starting at `base + i` minutes): to the minute, so two calls in one
 * minute, one ending as the other starts, count as two. A call that started before the counts given
 * (the day before the range's first) is not counted.
 */
export function peaksByHour(counts: ArrayLike<number>, base: number, from: number, to: number): Map<number, number> {
  const peaks = new Map<number, number>();
  const first = Math.max(0, Math.floor((from - base) / MINUTE_MS));
  const last = Math.min(counts.length - 1, Math.floor((to - base) / MINUTE_MS));
  for (let m = first; m <= last; m++) {
    const n = counts[m]!;
    if (n === 0) continue;
    const h = hourOf(base + m * MINUTE_MS);
    if (n > (peaks.get(h) ?? 0)) peaks.set(h, n);
  }
  return peaks;
}

/** Hours (or days) summed: counts, durations and dollars added. */
export function sumHours(hours: readonly HourFigures[]): HourFigures {
  const s = emptyHour();
  for (const h of hours) {
    for (const k of ['calls', 'ended', 'contained', 'toPerson', 'hungUp', 'errors', 'lengthMs', 'voice', 'voiceMs', 'costUsd', 'screenHits', 'stepUps', 'hoursRouted', 'gaps'] as const) s[k] += h[k];
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
    if (h.render) sumRender((s.render ??= emptyRenderFigures()), h.render);
  }
  s.costUsd = Math.round(s.costUsd * 1e6) / 1e6;
  return s;
}

// ---------------------------------------------------------------------------------------------
// A day's figures read back from a file: every number checked, older shapes read as they can be
// ---------------------------------------------------------------------------------------------

const count = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isMap = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const counts = (v: unknown): v is Record<string, number> => isMap(v) && Object.values(v).every(count);

/** An hour's figures as a file holds them, every number a finite count and every map of its shape; null for anything else. `older`: a version-1 file's (a peak and `afterHours`, the abandoned in words, the routes by `<point>:<what followed>`). */
export function hourFiguresOf(raw: unknown, older = false): HourFigures | null {
  if (!isMap(raw)) return null;
  const scalars = ['calls', 'ended', 'contained', 'toPerson', 'hungUp', 'errors', 'lengthMs', 'voice', 'voiceMs', 'costUsd', 'screenHits', 'stepUps', 'gaps'] as const;
  if (!scalars.every((k) => count(raw[k]))) return null;
  const routed = older ? raw.afterHours : raw.hoursRouted;
  if (!count(routed)) return null;
  if (!Array.isArray(raw.lengths) || raw.lengths.length !== LENGTH_EDGES_S.length + 1 || !raw.lengths.every(count)) return null;
  for (const k of ['billedMinutes', 'transfers', 'abandoned', 'refusals', 'hours', 'gapKinds'] as const) if (!counts(raw[k])) return null;
  if (!isMap(raw.asked) || !Object.values(raw.asked).every((s) => isMap(s) && count(s.reasks) && count(s.silences) && count(s.ranOut))) return null;
  if (!isMap(raw.tasks) || !Object.values(raw.tasks).every((t) => isMap(t) && count(t.started) && count(t.finished) && count(t.ms))) return null;
  if (!isMap(raw.gapTopics) || !Object.values(raw.gapTopics).every((g) => isMap(g) && count(g.n) && typeof g.latest === 'string' && g.latest.length <= 40)) return null;
  const pick = <T,>(m: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(m));
  const h: HourFigures = {
    ...Object.fromEntries(scalars.map((k) => [k, raw[k] as number])) as Pick<HourFigures, (typeof scalars)[number]>,
    hoursRouted: routed,
    lengths: [...raw.lengths as number[]],
    billedMinutes: pick(raw.billedMinutes as Record<string, number>),
    transfers: pick(raw.transfers as Record<string, number>),
    abandoned: older ? Object.fromEntries(Object.entries(raw.abandoned as Record<string, number>).map(([k, n]) => [`text:${k}`, n])) : pick(raw.abandoned as Record<string, number>),
    asked: Object.fromEntries(Object.entries(raw.asked as Record<string, Struggle>).map(([k, s]) => [k, { reasks: s.reasks, silences: s.silences, ranOut: s.ranOut }])),
    tasks: Object.fromEntries(Object.entries(raw.tasks as Record<string, { started: number; finished: number; ms: number }>).map(([k, t]) => [k, { started: t.started, finished: t.finished, ms: t.ms }])),
    screenHits: raw.screenHits as number,
    refusals: pick(raw.refusals as Record<string, number>),
    hours: older ? Object.fromEntries(Object.entries(raw.hours as Record<string, number>).map(([k, n]) => [k.replace(':', '::'), n])) : pick(raw.hours as Record<string, number>),
    gapKinds: Object.fromEntries(Object.entries(raw.gapKinds as Record<string, number>).filter(([k]) => (GAP_KINDS as readonly string[]).includes(k))),
    gapTopics: Object.fromEntries(Object.entries(raw.gapTopics as Record<string, { n: number; latest: string }>).map(([k, g]) => [k, { n: g.n, latest: g.latest }])),
  };
  // Generated wording's figures, where the hour has them.
  if (raw.render !== undefined) {
    const render = renderFiguresOf(raw.render);
    if (render === null) return null;
    h.render = render;
  }
  return h;
}

/**
 * A day's figures as a file holds them (its hours keyed by an hour's first ms), checked; null for anything
 * malformed. `version`: 3, the counts by the minute as runs (`inProgress`); 2, each call's span, made
 * counts by the minute here (and never kept); 1, the peak each hour had, and the older words (`older`).
 */
export function dayDataFrom(raw: { hours?: unknown; inProgress?: unknown; spans?: unknown }, version: number, dayStart: number): DayData | null {
  if (!isMap(raw.hours)) return null;
  const older = version === 1;
  const hours: Record<string, HourFigures> = {};
  const peaks: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw.hours)) {
    if (!/^\d{1,15}$/.test(k) || Number(k) % HOUR_MS !== 0) return null;
    const h = hourFiguresOf(v, older);
    if (h === null) return null;
    hours[k] = h;
    if (older && isMap(v) && count(v.peak)) peaks[k] = v.peak;
  }
  if (older) return { hours, minutes: new Uint16Array(COUNTED_MINUTES), peaks };
  const minutes = version === 2 ? spansToMinutes(raw.spans, dayStart) : runsToMinutes(raw.inProgress);
  return minutes === null ? null : { hours, minutes };
}

// ---------------------------------------------------------------------------------------------
// Said in the app's words: what the Insights page draws
// ---------------------------------------------------------------------------------------------

/** One app's figures for a range, as summed, with the app it is (null on a server of one). */
export interface AppFigures {
  id: string | null;
  app: App;
  figures: HourFigures;
  /** Its calls by the hour, for the calls-by-hour chart. */
  hourCalls: Record<string, number>;
  /** Its calls in progress by the minute from `base` (the range's first UTC day's start), for the peak at once; and an older figure's peak by the hour, where it has no counts. */
  base: number;
  minutes: Uint32Array;
  peaks: Record<string, number>;
  /** Days read from figures of an older version (their traces gone), days whose figures could not be read, and days older than FIGURES_RETENTION_DAYS. */
  older: string[];
  unreadable: string[];
  expired?: string[];
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
  totals: Omit<HourFigures, 'asked' | 'tasks' | 'transfers' | 'abandoned' | 'refusals' | 'hours' | 'gapTopics' | 'render'> & { peak: number };
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
  /**
   * Generated wording (wordingFigures.ts): the calls served generated beside those served fixed
   * (RENDER_SHARE), each generated line's fallback rate and latency, and what the lines cost (in
   * `cost.modelUsd` too). Only when a call in the range had generated lines; absent otherwise.
   */
  wording?: WordingInsights;
  /** Days shown from figures of an older version, days whose figures could not be read (left out), and days older than FIGURES_RETENTION_DAYS (left out). */
  older: string[];
  unreadable: string[];
  expired: string[];
}

const byCount = <T>(n: (r: LabelledRow<T>) => number) => (a: LabelledRow<T>, b: LabelledRow<T>): number => n(b) - n(a) || a.label.localeCompare(b.label);

/** The routes' outcomes in words. */
const ROUTE_WORDS: Record<string, string> = { handoff: 'to a person', end: 'ended', 'anything-else': 'asked what else', form: 'into a task', continue: 'went on', locale: 'changed language' };
const POINT_WORDS: Record<string, string> = { start: 'at the start', afterIdentity: 'after identity', afterForm: 'after a task' };

/** A route on the business hours in words: `at the start, closed: to a person`. */
function routeWords(key: string): string {
  const [point, state, then] = key.split(':');
  return `${POINT_WORDS[point!] ?? point}${state ? `, ${state}` : ''}: ${ROUTE_WORDS[then!] ?? then}`;
}

/** A topic's title in an app's knowledge, else its id; "no near topic" for `~`. */
function topicTitle(app: App, topic: string): string {
  if (topic === '~') return 'no near topic';
  const kb = app.knowledge?.kb;
  if (kb && Object.hasOwn(kb.topics, topic)) return kb.topics[topic]!.title;
  return app.knowledge?.topics?.find((t) => t.id === topic)?.title ?? topic;
}

/**
 * The figures for a range ([from, to]), said in each app's console words; `rates` the carriers' rates a
 * minute (config.carrierRates). The peak at once is worked out from every app's counts by the minute together.
 */
export function insightsOf(apps: readonly AppFigures[], rates: Readonly<Partial<Record<string, number>>> | undefined, range: { from: number; to: number }): Insights {
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
  // Calls by the hour, and the peak at once from every app's counts by the minute added (an older figure's own peak where it has none).
  const base = apps[0]?.base ?? range.from;
  const together = new Uint32Array(Math.max(0, ...apps.map((a) => a.minutes.length)));
  for (const a of apps) for (let m = 0; m < a.minutes.length; m++) together[m]! += a.minutes[m]!;
  const peaks = peaksByHour(together, base, range.from, range.to);
  const hourly = new Map<number, { calls: number; peak: number }>();
  for (const a of apps) {
    for (const [k, n] of Object.entries(a.hourCalls)) {
      const had = hourly.get(Number(k)) ?? { calls: 0, peak: 0 };
      hourly.set(Number(k), { calls: had.calls + n, peak: had.peak + (a.peaks[k] ?? 0) });
    }
  }
  for (const [h, p] of peaks) {
    const had = hourly.get(h) ?? { calls: 0, peak: 0 };
    hourly.set(h, { ...had, peak: Math.max(had.peak, p) });
  }
  const { asked: _a, tasks: _t, transfers: _tr, abandoned: _ab, refusals: _r, hours: _h, gapTopics: _g, render: _render, ...rest } = all;
  const wording = wordingInsightsOf(apps.map((a) => ({ name: named ? (a.app.brand?.name ?? a.id) : null, render: a.figures.render })));
  const totals = { ...rest, peak: Math.max(0, ...[...hourly.values()].map((h) => h.peak)) };
  return {
    totals,
    containment: all.ended === 0 ? null : all.contained / all.ended,
    meanLengthMs: all.ended === 0 ? null : Math.round(all.lengthMs / all.ended),
    minutes: Math.round((all.voiceMs / 60_000) * 10) / 10,
    carrier,
    cost: { modelUsd: all.costUsd, carrierUsd, totalUsd, perCall: all.calls === 0 ? null : totalUsd / all.calls, perHandled: all.contained === 0 ? null : totalUsd / all.contained },
    byHour: [...hourly].filter(([, h]) => h.calls > 0 || h.peak > 0).sort((x, y) => x[0] - y[0]).map(([hour, h]) => ({ hour, ...h })),
    transfers: labelled((a, meta) => Object.entries(a.figures.transfers).map(([code, n]) => [code, reasonWords(meta, code), n] as [string, string, number])).sort(byCount((r) => r.value)),
    abandoned: labelled((a) => Object.entries(a.figures.abandoned).map(([where, n]) => [where, stoppedWords(where), n] as [string, string, number])).sort(byCount((r) => r.value)),
    struggles: labelled((a) => Object.entries(a.figures.asked).map(([k, s]) => [k, askedWords(k), s] as [string, string, Struggle]))
      .filter((r) => r.value.reasks + r.value.silences + r.value.ranOut > 0)
      .sort(byCount((r) => r.value.reasks + r.value.silences + r.value.ranOut)),
    tasks: labelled((a) => Object.entries(a.figures.tasks).map(([form, t]) => [form, formLabel(form), { started: t.started, finished: t.finished, meanMs: t.finished === 0 ? null : Math.round(t.ms / t.finished) }] as [string, string, { started: number; finished: number; meanMs: number | null }]))
      .sort(byCount((r) => r.value.started)),
    refusals: labelled((a) => Object.entries(a.figures.refusals).map(([rule, n]) => [rule, rule, n] as [string, string, number])).sort(byCount((r) => r.value)),
    hours: labelled((a) => Object.entries(a.figures.hours).map(([k, n]) => [k, routeWords(k), n] as [string, string, number])).sort(byCount((r) => r.value)),
    // Ranked as kb:gaps ranks its groups: how many, then the latest, then the topic.
    gapTopics: labelled((a) => Object.entries(a.figures.gapTopics).map(([topic, g]) => [topic, topicTitle(a.app, topic), g] as [string, string, { n: number; latest: string }]))
      .sort((x, y) => y.value.n - x.value.n || (y.value.latest > x.value.latest ? 1 : y.value.latest < x.value.latest ? -1 : 0) || x.key.localeCompare(y.key)),
    ...(wording !== null ? { wording } : {}),
    older: [...new Set(apps.flatMap((a) => a.older))].sort(),
    unreadable: [...new Set(apps.flatMap((a) => a.unreadable))].sort(),
    expired: [...new Set(apps.flatMap((a) => a.expired ?? []))].sort(),
  };
}

export { GAP_KINDS };
