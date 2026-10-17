/**
 * The knowledge base's gaps, found in the traces: what `kb:gaps` ranks (packages/kb-author, which reads
 * the trace files and writes the report) and what the console's Insights and Knowledge pages count
 * (server/dashboard/figures.ts). Pure: records in, gaps out; no file is read here.
 *
 * The trace already masks the identity slots (the writer's redaction); the caller's own words are in
 * it as spoken. `masked` marks the slots whose value in a record is one of those masks, which is how
 * a gap knows the words of that turn carried a masked value.
 */

// ---------------------------------------------------------------------------------------------
// What a gap reads of a record
// ---------------------------------------------------------------------------------------------

/** One question as the model was asked it, as far as a gap needs it. */
export interface TurnQuestion {
  type: string;
  /** The labels of a choice question. */
  labels: string[];
}

/** One choice answer: the label chosen, and every label's probability. */
export interface TurnAnswer {
  choice: string | null;
  probabilities: Record<string, number>;
  confidence: number | null;
}

/** One turn of a trace, as kb:gaps reads it. */
export interface Turn {
  file: string;
  line: number;
  sessionId: string;
  turnIndex: number;
  ts: string;
  /** The caller's words as recorded (speech or text); null for any other event. */
  words: string | null;
  quarantined: boolean;
  locale: string | null;
  /** What the knowledge retriever did; null when it did not run on this turn. */
  retrieval: { nominated: string[]; failed: string | null } | null;
  questions: Record<string, TurnQuestion>;
  answers: Record<string, TurnAnswer>;
  /** The intent the model chose, when it was asked. */
  intent: string | null;
  decision: { kind: string; promptId: string | null; target: string | null; acks: string[] };
  promptedFor: string | null;
  /** The slots with a value after the turn, as recorded (a masked slot's value is the mask). */
  slotValues: Record<string, string>;
  /** The slots whose value is one of the trace's masks. */
  masked: string[];
  /** Whether a masked value is in what the turn did: a gated call's params, or what the decision says (its variables, a handoff's slots). */
  maskedInDecision: boolean;
  /** The gated calls of the turn: the tool, the `topic` param when recorded, and the tool's summary. */
  calls: { tool: string; topic: string | null; summary: string | null }[];
  /** The knowledge record of the turn (a passage said, or one withheld). */
  kb: { passageId: string; topic: string; fresh: boolean; document: string | null; section: string | null; locale: string | null } | null;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** The values the trace writer puts in place of an identity slot's value (trace/redact.ts): last four, year only, a length. */
const MASKED_VALUE = /^(?:\.\.\.\d{4}|••\/••\/(?:\d{4}|••••)|<\d+ chars>)$/;

/** A record as a Turn, or null when it does not read as a v2 record with a session and a turn. */
export function turnOf(raw: unknown, file: string, line: number): Turn | null {
  // A record a server wrote after it had let the call go (trace/store.ts): the server that took the call ran that turn too.
  if (!isObject(raw) || raw.v !== 2 || raw.outlivedHold === true) return null;
  const sessionId = str(raw.sessionId);
  const ts = str(raw.ts);
  if (sessionId === null || ts === null || typeof raw.turnIndex !== 'number') return null;
  const event = isObject(raw.event) ? raw.event : {};
  const words = (event.type === 'user.speech' || event.type === 'user.text') && typeof event.text === 'string' ? event.text : null;

  const retrieval = isObject(raw.retrieval)
    ? {
        nominated: (Array.isArray(raw.retrieval.nominated) ? raw.retrieval.nominated : []).flatMap((n) => (isObject(n) && typeof n.topic === 'string' ? [n.topic] : [])),
        failed: str(raw.retrieval.failed),
      }
    : null;

  // The turn's questions and answers, with its second request's on the same words (TraceRecord.followUp:
  // the topic question of an aside asked in the middle of a task), which are the turn's as much.
  const followUp = isObject(raw.followUp) ? raw.followUp : null;
  const questions: Record<string, TurnQuestion> = {};
  for (const asked of [raw.questions, followUp?.questions]) {
    if (!isObject(asked)) continue;
    for (const [id, q] of Object.entries(asked)) {
      if (!isObject(q)) continue;
      questions[id] = { type: str(q.type) ?? '', labels: isObject(q.criteria) ? Object.keys(q.criteria) : [] };
    }
  }
  const answers: Record<string, TurnAnswer> = {};
  for (const answered of [raw.answers, followUp?.answers]) {
    if (!isObject(answered)) continue;
    for (const [id, a] of Object.entries(answered)) {
      if (!isObject(a) || a.type !== 'choice') continue;
      const probabilities: Record<string, number> = {};
      if (isObject(a.probabilities)) for (const [label, p] of Object.entries(a.probabilities)) if (typeof p === 'number' && Number.isFinite(p)) probabilities[label] = p;
      answers[id] = { choice: str(a.choice), probabilities, confidence: typeof a.confidence === 'number' ? a.confidence : null };
    }
  }

  const d = isObject(raw.decision) ? raw.decision : {};
  const decision = {
    kind: str(d.kind) ?? '',
    promptId: str(d.promptId),
    target: str(d.target),
    acks: (Array.isArray(d.acks) ? d.acks : []).flatMap((a) => (isObject(a) && typeof a.promptId === 'string' ? [a.promptId] : [])),
  };

  const slotValues: Record<string, string> = {};
  const masked: string[] = [];
  if (isObject(raw.slots)) {
    for (const [id, s] of Object.entries(raw.slots)) {
      if (!isObject(s) || typeof s.value !== 'string') continue;
      slotValues[id] = s.value;
      if (MASKED_VALUE.test(s.value)) masked.push(id);
    }
  }

  const calls: Turn['calls'] = [];
  const isMask = (v: unknown): boolean => typeof v === 'string' && MASKED_VALUE.test(v);
  const hasMask = (o: unknown): boolean => isObject(o) && Object.values(o).some(isMask);
  let maskedInDecision = hasMask(d.vars) || hasMask(d.slots) || (Array.isArray(d.acks) && d.acks.some((a) => isObject(a) && hasMask(a.vars)));
  if (Array.isArray(raw.gateEvents)) {
    for (const g of raw.gateEvents) {
      if (!isObject(g) || !isObject(g.decision) || !isObject(g.decision.call)) continue;
      const params = isObject(g.decision.call.params) ? g.decision.call.params : {};
      if (hasMask(params)) maskedInDecision = true;
      calls.push({ tool: str(g.decision.call.tool) ?? '', topic: str(params.topic), summary: str(g.summary) });
    }
  }

  let kb: Turn['kb'] = null;
  if (isObject(raw.kb) && typeof raw.kb.passageId === 'string' && typeof raw.kb.topic === 'string') {
    kb = { passageId: raw.kb.passageId, topic: raw.kb.topic, fresh: raw.kb.fresh === true, document: str(raw.kb.document), section: str(raw.kb.section), locale: str(raw.kb.locale) };
  }

  const intent = isObject(raw.answers) && isObject(raw.answers.intent) ? str(raw.answers.intent.choice) : null;
  return {
    file,
    line,
    sessionId,
    turnIndex: raw.turnIndex,
    ts,
    words,
    quarantined: raw.quarantined === true,
    locale: str(raw.locale),
    retrieval,
    questions,
    answers,
    intent,
    decision,
    promptedFor: str(raw.promptedFor),
    slotValues,
    masked,
    maskedInDecision,
    calls,
    kb,
  };
}

/** The turns of a trace's lines (a file's, or a call's joined segments), named `file`, each with its line number. */
export function turnsOfLines(lines: readonly string[], file: string): { turns: Turn[]; skipped: number } {
  const turns: Turn[] = [];
  let skipped = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i]!;
    if (l.trim() === '') continue;
    try {
      const turn = turnOf(JSON.parse(l) as unknown, file, i + 1);
      if (turn) turns.push(turn);
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  return { turns, skipped };
}

// ---------------------------------------------------------------------------------------------
// What counts as a gap
// ---------------------------------------------------------------------------------------------

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

/**
 * The topic question of a turn: a choice question whose labels are nominated topics and `none`, with
 * `unanswered` too where the slot tells a question no topic answers from one that asks nothing (the
 * topic slot's `unanswered: retry`). Null when the turn asked none.
 */
export function topicQuestionOf(t: Turn): { id: string; nominated: string[]; unanswered: boolean } | null {
  if (t.retrieval === null || t.retrieval.nominated.length === 0) return null;
  const nominated = new Set(t.retrieval.nominated);
  for (const [id, q] of Object.entries(t.questions)) {
    if (q.type !== 'choice' || !q.labels.includes('none')) continue;
    const topics = q.labels.filter((l) => l !== 'none' && l !== 'unanswered');
    if (topics.length > 0 && topics.every((l) => nominated.has(l))) return { id, nominated: t.retrieval.nominated, unanswered: q.labels.includes('unanswered') };
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

  // Answered from sections of approved documents (kb.yaml documents): no gap, though no topic answered it.
  if (t.kb !== null && t.kb.fresh && t.kb.topic === 'documents') return null;

  const q = topicQuestionOf(t);
  if (q !== null) {
    const answer = t.answers[q.id];
    if (answer === undefined) return null;
    // The call went on to ask another slot's question: the words were about something else.
    const movedOn = t.promptedFor !== null && !['intent', 'confirm', 'otp'].includes(t.promptedFor) && !topicSlots.has(t.promptedFor);
    if (t.decision.promptId?.startsWith('disambiguate_')) {
      const pair = ranked(answer).filter((l) => q.nominated.includes(l));
      const [a, b] = pair.length >= 2 ? pair : q.nominated;
      if (a === undefined || b === undefined) return null;
      return { kind: 'close', topic: a, near: 'nominated', ...base, words: own, other: b };
    }
    const label = answer.choice ?? ranked(answer)[0] ?? null;
    if (label === null || movedOn) return null;
    // With an `unanswered` label, `none` is a turn that asked nothing: a gap only where its words still read as a question.
    const missed = label === 'unanswered' || (label === 'none' && (!q.unanswered || (t.words !== null && looksLikeQuestion(t.words))));
    if (missed || (q.nominated.includes(label) && !filledWith(t, label))) {
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
