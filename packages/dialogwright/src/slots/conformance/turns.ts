import type { SlotContext, SlotOutcome } from '../../core/slots/types';
import { candidateSpans, candidateWordSpans } from '../../core/spans';
import { DEFAULT_THRESHOLDS, type Thresholds } from '../../core/thresholds';
import { canonicalJson } from '../../jev/cassette';
import type { Answer, AnswerMap, QuestionMap } from '../../jev/types';
import type { ExampleAnswer, ExampleContext } from '../types';

/**
 * What the conformance kit feeds a slot: contexts like the engine's, the model's answers as an
 * example writes them, quiet and malformed answers, and the same turn with every probability and
 * threshold scaled.
 */

/** Today, in every context the kit builds (the same day the engine's unit tests use). */
export const KIT_TODAY = '2026-09-18';

/** A slot context for `text`, as the engine would build one for a fresh turn in `locale` (else the example's own), with `over` applied. */
export function kitContext(text: string, over: ExampleContext = {}, locale?: string): SlotContext {
  const lang = locale ?? over.locale;
  const ctx: SlotContext = {
    text,
    candidateSpans: candidateSpans(text, lang),
    candidateWordSpans: candidateWordSpans(text, lang),
    todayIso: over.todayIso ?? KIT_TODAY,
    thresholds: { ...DEFAULT_THRESHOLDS },
    window: over.window ?? null,
    current: over.current ?? null,
    records: over.records ?? [],
    prompted: over.prompted ?? false,
  };
  if (over.sources !== undefined) ctx.sources = over.sources;
  if (lang !== undefined) ctx.locale = lang;
  return ctx;
}

/** The answers an example writes, as the model returns them. */
export function answersOf(written: Readonly<Record<string, ExampleAnswer>> | undefined): AnswerMap {
  const out: AnswerMap = {};
  for (const [id, a] of Object.entries(written ?? {})) {
    if ('noul' in a) out[id] = { type: 'noul', noul: a.noul };
    else if ('choice' in a) {
      const [top] = Object.entries(a.choice).sort((x, y) => y[1] - x[1]);
      out[id] = { type: 'choice', choice: top?.[0] ?? 'none', probabilities: { ...a.choice }, confidence: top?.[1] ?? 0 };
    } else {
      const labels = Object.keys(a.score);
      const expected = labels.reduce((acc, label, i) => acc + (i + 1) * a.score[label]!, 0);
      out[id] = { type: 'score', score: expected, probabilities: { ...a.score }, confidence: Math.max(0, ...Object.values(a.score)) };
    }
  }
  return out;
}

/**
 * The answers of a model that hears nothing for the slot: every yes-or-no at 0, every choice on
 * `none` (or spread evenly over its labels when it has no `none`), every score on its lowest level.
 */
export function quietAnswers(questions: QuestionMap): AnswerMap {
  const out: AnswerMap = {};
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === 'noul') out[id] = { type: 'noul', noul: 0 };
    else if (q.type === 'choice') {
      const labels = Object.keys(q.criteria);
      const hasNone = labels.includes('none');
      const probabilities = Object.fromEntries(labels.map((l) => [l, hasNone ? (l === 'none' ? 1 : 0) : 1 / labels.length]));
      const choice = hasNone ? 'none' : (labels[0] ?? 'none');
      out[id] = { type: 'choice', choice, probabilities, confidence: probabilities[choice] ?? 0 };
    } else {
      const probabilities = Object.fromEntries(q.levels.map((l, i) => [l.label, i === 0 ? 1 : 0]));
      out[id] = { type: 'score', score: 1, probabilities, confidence: 1 };
    }
  }
  return out;
}

/** Answers no model gives, but a broken recording, a stub or a changed question could: each must leave the slot standing. */
export const MALFORMED_ANSWERS: readonly { name: string; answer: unknown }[] = [
  { name: 'a yes-or-no of NaN', answer: { type: 'noul', noul: Number.NaN } },
  { name: 'a yes-or-no without its value', answer: { type: 'noul' } },
  { name: 'a yes-or-no of 7', answer: { type: 'noul', noul: 7 } },
  { name: 'a choice of a label it does not offer', answer: { type: 'choice', choice: 'not-a-label', probabilities: { 'not-a-label': 1 }, confidence: 1 } },
  { name: 'a choice with no probabilities', answer: { type: 'choice', choice: 'none', probabilities: {}, confidence: 1 } },
  { name: 'a choice without its fields', answer: { type: 'choice' } },
  { name: 'a score with no probabilities', answer: { type: 'score', score: 9, probabilities: {}, confidence: 1 } },
  { name: 'an answer of an unknown type', answer: { type: 'free-text', text: 'hello' } },
  { name: 'null', answer: null },
  { name: 'a number', answer: 0.9 },
  { name: 'a string', answer: 'yes' },
];

/** Keys no slot takes: each must give null or a value, never throw. */
export const MALFORMED_KEYS: readonly string[] = ['', 'abc', '#*#', '12a4', '0'.repeat(64)];

/** `answers` with every probability (and a choice's or score's confidence) multiplied by `k`. */
export function scaleAnswers(answers: AnswerMap, k: number): AnswerMap {
  const scale = (p: Record<string, number>) => Object.fromEntries(Object.entries(p).map(([l, v]) => [l, v * k]));
  const out: AnswerMap = {};
  for (const [id, a] of Object.entries(answers)) {
    const scaled: Answer =
      a.type === 'noul' ? { type: 'noul', noul: a.noul * k } : { ...a, probabilities: scale(a.probabilities), confidence: a.confidence * k };
    out[id] = scaled;
  }
  return out;
}

/** `t` with every threshold multiplied by `k`. */
export function scaleThresholds(t: Thresholds, k: number): Thresholds {
  return Object.fromEntries(Object.entries(t).map(([name, v]) => [name, v * k])) as Thresholds;
}

/** `t`, recording into `reads` the name of every threshold read from it. */
export function recordingThresholds(t: Thresholds, reads: Set<string>): Thresholds {
  return new Proxy(t, {
    get(target, key, receiver) {
      if (typeof key === 'string') reads.add(key);
      return Reflect.get(target, key, receiver);
    },
  });
}

/** An outcome without its confidence, as canonical JSON: what must not change when the numbers are scaled. */
export function essence(outcome: SlotOutcome): string {
  const { confidence: _confidence, ...rest } = outcome as SlotOutcome & { confidence?: number };
  return canonicalJson(rest);
}

/** An outcome, short, for a message: `filled "abc" ("your note")`, `invalid:length`, `absent`. */
export function describeOutcome(o: SlotOutcome): string {
  switch (o.kind) {
    case 'filled': return `filled ${JSON.stringify(o.value)} (${JSON.stringify(o.display)})`;
    case 'invalid': return `invalid:${o.reason}${o.retryPromptId ? ` (${o.retryPromptId})` : ''}`;
    case 'help': return `help (${o.promptId})`;
    case 'disambiguate': return `disambiguate ${JSON.stringify(o.a.display)} or ${JSON.stringify(o.b.display)}`;
    case 'window': return `window ${canonicalJson(o.window)}`;
    default: return o.kind;
  }
}

const KINDS = new Set(['absent', 'filled', 'disambiguate', 'window', 'invalid', 'help']);

/** What is wrong with a value a fill returned as an outcome, or null when it is one. */
export function outcomeProblem(o: unknown): string | null {
  if (typeof o !== 'object' || o === null) return `fill returned ${JSON.stringify(o)}, which is not an outcome`;
  const kind = (o as { kind?: unknown }).kind;
  if (typeof kind !== 'string' || !KINDS.has(kind)) return `fill returned an outcome of kind ${JSON.stringify(kind)}`;
  if (kind === 'filled') {
    const f = o as { value?: unknown; display?: unknown; confidence?: unknown };
    if (typeof f.value !== 'string' || typeof f.display !== 'string') return 'fill returned a filled outcome without a string value and display';
    if (typeof f.confidence !== 'number' || Number.isNaN(f.confidence)) return 'fill returned a filled outcome without a numeric confidence';
  }
  return null;
}
