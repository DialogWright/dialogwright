import type { AuditDraft } from '../audit/types';
import type { Answer, AnswerMap, JevClient, JevUsage, QuestionMap } from '../jev/types';
import type { IncomingText, TextDecide } from './types';

/**
 * The decision model asked about a text that came in (TextContext.decide): the app's typed questions, the
 * same client its calls ask (JEV_CLIENT: the model, or the stubs; a test's own client), with the text's
 * words and what the app says it is about. It returns the answers, or null where the model could not answer
 * (an error, past JEV_TIMEOUT_MS), and records the asking in the app's audit beside the message
 * (`text_decision`): the questions by id, each answer, which client answered, how long it took and its tokens. Never
 * the words, and never what `about` holds (only its keys), as a turn's audit keeps no caller's words.
 */

/** The state the model is sent: the text's words and how many media it came with, and the app's `about`. */
export type TextDecisionState = {
  message: { words: string; media: number };
  about: Record<string, string>;
};

/** An answer as the audit row keeps it: "<id> <value>" (a yes-or-no's probability, a choice's label and its probability, a score). */
export function answerWords(id: string, a: Answer | undefined): string {
  if (a === undefined) return `${id} none`;
  const n = (x: number): string => String(Math.round(x * 1000) / 1000);
  if (a.type === 'noul') return `${id} ${n(a.noul)}`;
  if (a.type === 'choice') return `${id} ${a.choice} ${n(a.probabilities[a.choice] ?? 0)}`;
  return `${id} ${n(a.score)}`;
}

/** The audit row of one asking (`text_decision`). */
export function textDecisionRow(questions: QuestionMap, about: Readonly<Record<string, string>>, r: { answers: AnswerMap | null; source: string | null; model: string | null; latencyMs: number; error: string | null; usage?: JevUsage }): AuditDraft {
  const ids = Object.keys(questions);
  return {
    type: 'text_decision',
    detail: {
      questions: ids,
      answers: r.answers === null ? [] : ids.map((id) => answerWords(id, r.answers![id])),
      about: Object.keys(about),
      source: r.source,
      model: r.model,
      latencyMs: r.latencyMs,
      // What the asking cost, in the model's tokens (estimated for a stub): never the words.
      inputTokens: r.usage?.inputTokens ?? 0,
      outputTokens: r.usage?.outputTokens ?? 0,
      estimated: r.usage?.estimated ?? true,
      error: r.error,
    },
  };
}

/**
 * The `decide` a text's hook is given: each asking sent to `client` with `timeoutMs`, and recorded through
 * `record` once it is answered (or failed). Never throws: a failure is null, recorded with its error's name.
 */
export function textDecider(client: JevClient, timeoutMs: number, m: IncomingText, record: (row: AuditDraft) => void, now: () => number = () => Date.now()): TextDecide {
  return async (questions, about = {}) => {
    const state: TextDecisionState = { message: { words: m.body, media: m.media.length }, about: { ...about } };
    const started = now();
    try {
      const res = await client.ask({ state, questions, timeoutMs });
      record(textDecisionRow(questions, about, { answers: res.answers, source: res.source, model: res.model, latencyMs: res.latencyMs, error: null, usage: res.usage }));
      return res.answers;
    } catch (err) {
      record(textDecisionRow(questions, about, { answers: null, source: null, model: null, latencyMs: now() - started, error: err instanceof Error ? err.name : 'error' }));
      return null;
    }
  };
}
