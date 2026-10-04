import { choiceAnswer, choiceLabels, noulAnswer, normalize, scoreAnswer, sharp } from './distributions';
import { QUIET_NOUL, quietAnswer } from './defaults';
import { normalizeText, type CorpusEntry } from './corpus';
import { defaultAppOrNull } from '../core/app/registry';
import type { App } from '../core/app/types';
import {
  JevClientError, estimateTokens,
  type Answer, type AnswerMap, type JevClient, type JevRequest, type JevResponse, type Question,
} from './types';

export interface FixtureStubOptions {
  sharpness: number;
  /** answers utterances not in the corpus */
  fallback: JevClient;
  /** the app whose labels the corpus carries (App.testing.labeled); left out, the default app, at each ask */
  app?: App | null;
  /** return true to make the nth ask (1-based) reject with a timeout error */
  injectFailure?: (callIndex: number) => boolean;
}

function textOf(state: unknown): string {
  const s = state as { asr?: { text?: string } } | null;
  return s?.asr?.text ?? '';
}

/** A span label the question must be able to offer: exact after normalization, or the entry is wrong. */
function pickSpan(labels: string[], raw: string | undefined, entryId: string, what: string, sharpness: number): Answer {
  const span = raw === undefined ? undefined : normalizeText(raw);
  if (span !== undefined && !labels.includes(span)) {
    throw new Error(`corpus ${entryId}: ${what} span "${raw}" is not a candidate span of the text`);
  }
  return choiceAnswer(sharp(labels, span ?? 'none', sharpness));
}

/** Words as a criterion is compared with a label: lower case, spacing collapsed. */
const criterionKey = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * The one label of a choice whose criterion is `words` (case and spacing aside), or null: a label
 * named by what it offers, such as the part of the words a text slot's pick offers under a letter.
 */
function labelByCriterion(q: Extract<Question, { type: 'choice' }>, words: string): string | null {
  const want = criterionKey(words);
  const found = Object.entries(q.criteria).filter(([, c]) => typeof c === 'string' && criterionKey(c) === want);
  return found.length === 1 ? found[0]![0] : null;
}

/**
 * The entry's own label for a question (CorpusEntry.labels): a choice or score question's label, or
 * a yes or no. A choice's label may also be named by its criterion's words (a text slot's pick: the
 * part picked, as said). One the question cannot give is a corpus bug, so it throws with the entry id.
 */
function questionLabel(id: string, q: Question, label: string | boolean, entryId: string, sharpness: number): Answer {
  if (q.type === 'noul') {
    if (typeof label !== 'boolean') throw new Error(`corpus ${entryId}: label for ${id} must be true or false, not "${label}"`);
    return noulAnswer(label ? 0.9 : 0.05);
  }
  const labels = q.type === 'choice' ? choiceLabels(q) : q.levels.map((l) => l.label);
  if (q.type === 'choice' && typeof label === 'string' && !labels.includes(label)) label = labelByCriterion(q, label) ?? label;
  if (typeof label !== 'string' || !labels.includes(label)) throw new Error(`corpus ${entryId}: label ${JSON.stringify(label)} for ${id} is not one the question offers (${labels.join(', ')})`);
  const probabilities = sharp(labels, label, sharpness);
  return q.type === 'choice' ? choiceAnswer(probabilities) : scoreAnswer(q, probabilities);
}

function labeledAnswer(id: string, q: Question, entry: CorpusEntry, sharpness: number, app: App | null): Answer {
  // The entry's own label for a question that is not the engine's (CorpusEntry.labels) comes first.
  if (entry.labels && Object.hasOwn(entry.labels, id)) return questionLabel(id, q, entry.labels[id]!, entry.id, sharpness);
  const slots = entry.slots ?? {};
  const labeled = app?.testing?.labeled;
  if (q.type === 'choice') {
    const labels = choiceLabels(q);
    const pick = (v: string | undefined) => choiceAnswer(sharp(labels, v && labels.includes(v) ? v : 'none', sharpness));
    if (id === 'intent') return pick(entry.intent);
    // The app's labels, by question. A span a question must offer (an ID said aloud, a year) is a
    // corpus bug if the text cannot offer it, so it throws with the entry id; any other label a
    // question does not offer in this state (one offered by what the call knows) is a quiet none.
    if (labeled?.spans && Object.hasOwn(labeled.spans, id)) {
      const { what, span } = labeled.spans[id]!;
      return pickSpan(labels, span(slots), entry.id, what, sharpness);
    }
    if (labeled?.choice && Object.hasOwn(labeled.choice, id)) return pick(labeled.choice[id]!(slots));
    if (id === 'intentChange') return choiceAnswer(sharp(labels, entry.change ?? 'answering', sharpness));
    if (id === 'changeSlot') return pick(entry.changeSlot);
    if (id === 'secondIntent') return pick(entry.secondIntent);
    return quietAnswer(id, q, sharpness, app);
  }
  if (q.type === 'noul') {
    if (labeled?.noul && Object.hasOwn(labeled.noul, id)) return noulAnswer(labeled.noul[id]!(slots));
    if (id === 'manipulation') return noulAnswer(entry.manipulation ? 0.92 : QUIET_NOUL.manipulation!);
    if (id === 'wantsHuman') return noulAnswer(entry.intent === 'agent' ? 0.9 : 0.04);
    if (id === 'intentTentative') return noulAnswer(entry.tentative ? 0.9 : QUIET_NOUL.intentTentative!);
    if (id === 'confirmsYes') return noulAnswer(entry.confirm === 'yes' ? 0.9 : QUIET_NOUL.confirmsYes!);
    if (id === 'confirmsNo') return noulAnswer(entry.confirm === 'no' ? 0.9 : QUIET_NOUL.confirmsNo!);
    return quietAnswer(id, q, sharpness, app);
  }
  return quietAnswer(id, q, sharpness, app);
}

function applyOverride(
  answer: Answer,
  q: Question,
  override: { noul?: number; probabilities?: Record<string, number> },
  entryId: string,
  questionId: string,
): Answer {
  if (answer.type === 'noul') {
    if (override.probabilities !== undefined) {
      throw new Error(`corpus ${entryId}: override for ${questionId} gives probabilities for a noul question`);
    }
    return override.noul === undefined ? answer : noulAnswer(override.noul);
  }
  if (override.noul !== undefined) {
    throw new Error(`corpus ${entryId}: override for ${questionId} gives noul for a ${answer.type} question`);
  }
  if (!override.probabilities) return answer;
  const labels = answer.type === 'choice' ? choiceLabels(q as Extract<Question, { type: 'choice' }>) : (q as Extract<Question, { type: 'score' }>).levels.map((l) => l.label);
  const given = override.probabilities;
  for (const key of Object.keys(given)) {
    if (!labels.includes(key)) {
      throw new Error(`corpus ${entryId}: override for ${questionId} names unknown label ${key}`);
    }
  }
  const givenMass = Object.values(given).reduce((a, b) => a + b, 0);
  const rest = labels.filter((l) => !(l in given));
  const probs: Record<string, number> = {};
  for (const l of labels) probs[l] = l in given ? given[l]! : rest.length ? Math.max(0, 1 - givenMass) / rest.length : 0;
  const normalized = normalize(probs);
  return answer.type === 'choice' ? choiceAnswer(normalized) : scoreAnswer(q as Extract<Question, { type: 'score' }>, normalized);
}

/** Deterministic answers from corpus labels. Unknown utterances go to the fallback. */
export class FixtureStubClient implements JevClient {
  private readonly index = new Map<string, CorpusEntry>();
  private calls = 0;

  constructor(entries: CorpusEntry[], private readonly opts: FixtureStubOptions) {
    for (const e of entries) this.index.set(normalizeText(e.text), e);
  }

  lookup(text: string): CorpusEntry | undefined {
    return this.index.get(normalizeText(text));
  }

  async ask(req: JevRequest): Promise<JevResponse> {
    this.calls += 1;
    if (this.opts.injectFailure?.(this.calls)) throw new JevClientError('injected timeout');
    const entry = this.lookup(textOf(req.state));
    if (!entry) return this.opts.fallback.ask(req);
    const app = this.opts.app === undefined ? defaultAppOrNull() : this.opts.app;
    const answers: AnswerMap = {};
    for (const [id, q] of Object.entries(req.questions)) {
      let a = labeledAnswer(id, q, entry, this.opts.sharpness, app);
      const override = entry.answers?.[id];
      if (override) a = applyOverride(a, q, override, entry.id, id);
      answers[id] = a;
    }
    return {
      answers,
      model: 'stub-fixture',
      usage: { inputTokens: estimateTokens(req.state) + estimateTokens(req.questions), outputTokens: 0, estimated: true },
      latencyMs: 0,
      source: 'stub:fixture',
    };
  }
}
