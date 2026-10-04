import type { Turn } from './traces';

/**
 * What counts as a gap, found turn by turn in the traces. A gap is a turn where a caller asked the
 * knowledge base something and did not get an answer from it, or got one only by luck. Four kinds:
 *
 * - `none`: the topic slot's question was asked (retrieval nominated topics) and the model answered
 *   `none`, or chose a topic but the slot did not fill with it (below the slot's fill threshold).
 *   Skipped when the call went on to ask another slot's question: the words were about something else.
 * - `unmatched`: retrieval ran (a topic slot was listening) and nominated nothing, on words that look
 *   like a question: they end in `?` (or `¿...` at the start), or start with a question word
 *   (QUESTION_WORDS), or the model's intent was `other` or one of the app's informational intents.
 *   Skipped when the caller was answering a one-time code, a yes or no, or another slot's question.
 *   A retrieval that failed (`error`, `invalid`, `late`) is not a gap: it is counted, never grouped.
 * - `unavailable`: a passage could not be said (the resolving tool's `no passage (<reason>)`, or a
 *   knowledge record that is not fresh): `stale`, `not-in-force`, `no-translation`, `no-facts`, and
 *   the rarer `unknown-topic`, `ambiguous` and `no-answer`.
 * - `close`: the topic slot asked the caller which of two topics they meant (a `disambiguate_<slot>`
 *   prompt with the topic question asked): the two were within the margin of each other.
 *
 * A turn is at most one gap. A quarantined turn (the injection screen) is never one and its words are
 * never read. The words shown are the trace's recorded text as it is, except a turn whose words
 * carried a value the trace masks (an identity slot took a masked value on that turn, or a gated call
 * or the decision carries one): its words are withheld, never printed.
 */

export type GapKind = 'none' | 'unmatched' | 'unavailable' | 'close';

export const GAP_KINDS: readonly GapKind[] = ['none', 'unmatched', 'unavailable', 'close'];

export type Unavailable = 'stale' | 'not-in-force' | 'no-translation' | 'no-facts' | 'unknown-topic' | 'ambiguous' | 'no-answer';

const UNAVAILABLE: readonly Unavailable[] = ['stale', 'not-in-force', 'no-translation', 'no-facts', 'unknown-topic', 'ambiguous', 'no-answer'];

/** Where a gap's topic came from: what retrieval nominated, the keyword retriever's best match on the words, the passage's own topic, or nowhere. */
export type Near = 'nominated' | 'keyword' | 'passage' | 'none';

export interface Gap {
  kind: GapKind;
  /** The nearest topic: the group the gap falls in; null for "no near topic". */
  topic: string | null;
  near: Near;
  /** The topics retrieval nominated for the words, best first. */
  nominated: string[];
  /** The caller's words as the trace recorded them; null when withheld (the turn carried a masked value). */
  words: string | null;
  sessionId: string;
  turnIndex: number;
  ts: string;
  locale: string | null;
  /** An `unavailable` gap: why. */
  reason?: Unavailable;
  /** The passage a stale resolution withheld, when the trace names one. */
  passage?: { id: string; document: string | null; section: string | null };
  /** A `close` gap: the other topic of the pair (`topic` is the first). */
  other?: string;
}

/** What the collector knows beyond the trace. */
export interface CollectContext {
  /** The ids of the app's topic slots, when known (slots.yaml `type: topic`); topic questions seen in the traces add to them. */
  topicSlots: ReadonlySet<string>;
  /** The ids of the app's informational intents. */
  informational: ReadonlySet<string>;
  /** The nearest topic by keywords for words said in a locale, when the knowledge base is known and any topic scores. */
  nearest(words: string, locale: string | null): string | null;
}

/** What a collection counted besides the gaps. */
export interface CollectStats {
  /** The turns read (one per trace record). */
  turns: number;
  sessions: number;
  /** Turns whose retrieval failed (nothing nominated because it errored, was invalid or late): never grouped. */
  retrievalFailed: number;
  /** Gaps whose words were withheld. */
  withheld: number;
  /** Lines passed over: not a v2 trace record. */
  skipped: number;
  /** The first and last turn's day, when there were turns. */
  from: string | null;
  to: string | null;
}

/** Words that start a question, in lower case: English and Spanish, kept short. A heuristic, never a parse. */
export const QUESTION_WORDS: readonly string[] = [
  'what', 'whats', "what's", 'when', 'where', 'why', 'who', 'whom', 'whose', 'which', 'how', 'can', 'could', 'do', 'does', 'did', 'is', 'isnt', 'are', 'am',
  'was', 'were', 'will', 'would', 'should', 'shall', 'may', 'might', 'have', 'has',
  'qué', 'que', 'cuándo', 'cuando', 'dónde', 'donde', 'cómo', 'como', 'cuánto', 'cuanto', 'cuál', 'cual', 'quién', 'quien', 'puedo', 'hay', 'tienen',
];

/** Whether words look like a question: they end in `?`, start with `¿`, or start with a question word. */
export function looksLikeQuestion(words: string): boolean {
  const text = words.trim().replace(/^["'“”‘’(]+|["'“”‘’)]+$/g, '').trim();
  if (text === '') return false;
  if (text.endsWith('?') || text.startsWith('¿')) return true;
  const first = text.split(/\s+/)[0]!.toLowerCase().replace(/[^\p{L}']/gu, '');
  return QUESTION_WORDS.includes(first);
}

/** The topic question of a turn: a choice question whose labels are nominated topics and `none`. Null when the turn asked none. */
export function topicQuestionOf(t: Turn): { id: string; nominated: string[] } | null {
  if (t.retrieval === null || t.retrieval.nominated.length === 0) return null;
  const nominated = new Set(t.retrieval.nominated);
  for (const [id, q] of Object.entries(t.questions)) {
    if (q.type !== 'choice' || !q.labels.includes('none')) continue;
    const topics = q.labels.filter((l) => l !== 'none');
    if (topics.length > 0 && topics.every((l) => nominated.has(l))) return { id, nominated: t.retrieval.nominated };
  }
  return null;
}

/** The slot a topic question belongs to, by the engine's naming: the slot's id followed by `Topic`. */
const slotOfQuestion = (id: string): string => (id.endsWith('Topic') && id.length > 'Topic'.length ? id.slice(0, -'Topic'.length) : id);

/** The labels of an answer, best probability first (a tie by label). */
function ranked(answer: { probabilities: Record<string, number> }): string[] {
  return Object.entries(answer.probabilities)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([label]) => label);
}

/** Whether the turn filled the topic slot with `label`: a slot holds it, a gated call asked for it, or a knowledge record names it. */
function filledWith(t: Turn, label: string): boolean {
  return Object.values(t.slotValues).includes(label) || t.calls.some((c) => c.topic === label) || t.kb?.topic === label;
}

/** The reason a passage was not said on this turn, when one was not: with the topic and the passage it names. */
function unavailableOf(t: Turn): { reason: Unavailable; topic: string | null; passage?: Gap['passage'] } | null {
  const passage = t.kb !== null ? { id: t.kb.passageId, document: t.kb.document, section: t.kb.section } : undefined;
  for (const c of t.calls) {
    const m = c.summary === null ? null : /^no passage \(([a-z-]+)\)$/.exec(c.summary);
    if (m === null) continue;
    const reason = (UNAVAILABLE as readonly string[]).includes(m[1]!) ? (m[1] as Unavailable) : 'no-answer';
    return { reason, topic: t.kb?.topic ?? c.topic, ...(passage ? { passage } : {}) };
  }
  if (t.kb !== null && !t.kb.fresh) return { reason: 'stale', topic: t.kb.topic, passage: passage! };
  // A passage of an informational intent that could not be said: the unavailable line, with no call to name why.
  if (t.decision.acks.includes('kb_unavailable')) return { reason: 'no-answer', topic: t.kb?.topic ?? null };
  return null;
}

/**
 * Whether a masked value was given on this turn, so its words may carry the value itself: an identity
 * slot holds a mask it did not hold on the call's previous turn, or a masked value is in what the
 * turn did (a gated call's params, what the decision says; a form that finishes clears its slots, so
 * its slots no longer show the value, but the call does).
 */
function carriedMasked(t: Turn, prev: Turn | undefined): boolean {
  return t.maskedInDecision || t.masked.some((id) => prev?.slotValues[id] !== t.slotValues[id]);
}

interface Seen {
  prev: Turn | undefined;
  /** The last turn of the call on which the topic question was asked. */
  asked: Turn | undefined;
  askedPrev: Turn | undefined;
}

/** The gap a turn is, or null. */
function gapOf(t: Turn, seen: Seen, ctx: CollectContext, topicSlots: ReadonlySet<string>, nearest: (words: string, locale: string | null) => string | null): Gap | null {
  if (t.quarantined) return null;
  if (t.retrieval?.failed) return null;
  const nominated = t.retrieval?.nominated ?? [];
  const base = { nominated, sessionId: t.sessionId, turnIndex: t.turnIndex, ts: t.ts, locale: t.locale };
  const wordsFor = (from: Turn, before: Turn | undefined): string | null => (from.words === null || carriedMasked(from, before) ? null : from.words);
  const own = wordsFor(t, seen.prev);

  const un = unavailableOf(t);
  if (un !== null) {
    // The words that asked: this turn's when it asked the topic question, else the call's last asking turn's (a "yes" or a topic's name says nothing).
    const useAsked = topicQuestionOf(t) === null && seen.asked !== undefined;
    const words = useAsked ? wordsFor(seen.asked!, seen.askedPrev) : own;
    const topic = un.topic ?? nominated[0] ?? null;
    return { kind: 'unavailable', topic, near: un.topic !== null ? 'passage' : nominated.length > 0 ? 'nominated' : 'none', ...base, words, reason: un.reason, ...(un.passage ? { passage: un.passage } : {}) };
  }

  const q = topicQuestionOf(t);
  if (q !== null) {
    const answer = t.answers[q.id];
    if (answer === undefined) return null;
    // The call went on to ask another slot's question: the words were about something else.
    const movedOn = t.promptedFor !== null && !['intent', 'confirm', 'otp'].includes(t.promptedFor) && !topicSlots.has(t.promptedFor);
    if (t.decision.promptId?.startsWith('disambiguate_')) {
      const pair = ranked(answer).filter((l) => l !== 'none' && q.nominated.includes(l));
      const [a, b] = pair.length >= 2 ? pair : q.nominated;
      if (a === undefined || b === undefined) return null;
      return { kind: 'close', topic: a, near: 'nominated', ...base, words: own, other: b };
    }
    const label = answer.choice ?? ranked(answer)[0] ?? null;
    if (label === null || movedOn) return null;
    if (label === 'none' || (q.nominated.includes(label) && !filledWith(t, label))) {
      return { kind: 'none', topic: q.nominated[0]!, near: 'nominated', ...base, words: own };
    }
    return null;
  }

  if (t.retrieval !== null && nominated.length === 0 && t.words !== null) {
    const answering = seen.prev !== undefined && seen.prev.promptedFor !== null && (['otp', 'confirm'].includes(seen.prev.promptedFor) || (topicSlots.size > 0 && seen.prev.promptedFor !== 'intent' && !topicSlots.has(seen.prev.promptedFor)));
    const asks = looksLikeQuestion(t.words) || t.intent === 'other' || (t.intent !== null && ctx.informational.has(t.intent));
    if (answering || !asks) return null;
    const topic = nearest(t.words, t.locale);
    return { kind: 'unmatched', topic, near: topic !== null ? 'keyword' : 'none', ...base, words: own };
  }
  return null;
}

/** The gaps in `turns` (the traces of any number of calls, each call's turns in the order written), with what else was counted. */
export function collectGaps(turns: readonly Turn[], ctx: CollectContext, skipped = 0): { gaps: Gap[]; stats: CollectStats } {
  // The topic slots: the app's, and every slot a topic question was asked for in these traces.
  const topicSlots = new Set(ctx.topicSlots);
  for (const t of turns) {
    const q = topicQuestionOf(t);
    if (q !== null) topicSlots.add(slotOfQuestion(q.id));
  }
  const memo = new Map<string, string | null>();
  const nearest = (words: string, locale: string | null): string | null => {
    const key = `${locale ?? ''}\u0000${words}`;
    if (!memo.has(key)) memo.set(key, ctx.nearest(words, locale));
    return memo.get(key)!;
  };
  const gaps: Gap[] = [];
  const calls = new Map<string, Seen>();
  const stats: CollectStats = { turns: turns.length, sessions: 0, retrievalFailed: 0, withheld: 0, skipped, from: null, to: null };
  for (const t of turns) {
    const day = t.ts.slice(0, 10);
    if (stats.from === null || day < stats.from) stats.from = day;
    if (stats.to === null || day > stats.to) stats.to = day;
    let seen = calls.get(t.sessionId);
    if (seen === undefined) {
      seen = { prev: undefined, asked: undefined, askedPrev: undefined };
      calls.set(t.sessionId, seen);
    }
    if (t.retrieval?.failed) stats.retrievalFailed += 1;
    const gap = gapOf(t, seen, ctx, topicSlots, nearest);
    if (gap !== null) {
      gaps.push(gap);
      if (gap.words === null) stats.withheld += 1;
    }
    if (topicQuestionOf(t) !== null) {
      seen.asked = t;
      seen.askedPrev = seen.prev;
    }
    seen.prev = t;
  }
  stats.sessions = calls.size;
  return { gaps, stats };
}
