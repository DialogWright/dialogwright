import { describe, expect, it } from 'vitest';
import type { AuditDraft } from '../audit/types';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { noulValue, type JevClient, type JevRequest, type QuestionMap } from '../jev/types';
import { textDecider } from './decide';
import type { IncomingText } from './types';

/**
 * TextContext.decide (texts/decide.ts): an app's typed questions about a text that came in, asked of the
 * client its calls ask, with the text's words and what the app says it answers; each asking recorded
 * (`text_decision`) with no words. A fake client here: no test asks a model.
 */

const MESSAGE: IncomingText = { id: 'SM1', from: '+15555550177', to: '+15555550100', body: 'sounds good, go ahead', media: [], provider: 'twilio' };
const QUESTIONS: QuestionMap = { accepts: { type: 'noul', instructions: 'Does the reply accept the offer it answers?' } };

/** A client that answers each asking with `noul` and keeps what it was sent. */
function fake(noul: number): JevClient & { asked: JevRequest[] } {
  const asked: JevRequest[] = [];
  return {
    asked,
    async ask(req) {
      asked.push(req);
      return { answers: { accepts: { type: 'noul', noul } }, model: 'fake-model', usage: { inputTokens: 1, outputTokens: 1, estimated: true }, latencyMs: 12, source: 'recorded' };
    },
  };
}

describe('TextContext.decide', () => {
  it('asks the client the app\'s questions with the text\'s words and what it answers, and records the answers without the words', async () => {
    const client = fake(0.93);
    const rows: AuditDraft[] = [];
    const decide = textDecider(client, 4000, MESSAGE, (r) => rows.push(r));
    const answers = await decide(QUESTIONS, { offer: 'Reply OK to book it.' });
    expect(noulValue(answers!, 'accepts')).toBe(0.93);
    expect(client.asked[0]).toEqual({ state: { message: { words: 'sounds good, go ahead', media: 0 }, about: { offer: 'Reply OK to book it.' } }, questions: QUESTIONS, timeoutMs: 4000 });
    expect(rows).toEqual([{ type: 'text_decision', detail: { questions: ['accepts'], answers: ['accepts 0.93'], about: ['offer'], source: 'recorded', model: 'fake-model', latencyMs: 12, error: null } }]);
    expect(JSON.stringify(rows)).not.toContain('sounds good');
    expect(JSON.stringify(rows)).not.toContain('Reply OK');
  });

  it('resolves to null where the client fails, and records the failure by its name', async () => {
    const rows: AuditDraft[] = [];
    let t = 100;
    const failing: JevClient = { ask: async () => { t += 30; throw new TypeError('down'); } };
    const decide = textDecider(failing, 4000, MESSAGE, (r) => rows.push(r), () => t);
    expect(await decide(QUESTIONS)).toBeNull();
    expect(rows[0]).toEqual({ type: 'text_decision', detail: { questions: ['accepts'], answers: [], about: [], source: null, model: null, latencyMs: 30, error: 'TypeError' } });
  });

  it('a choice and a score are recorded by their reading', async () => {
    const rows: AuditDraft[] = [];
    const client: JevClient = {
      ask: async () => ({ answers: { pick: { type: 'choice', choice: 'b', probabilities: { a: 0.1, b: 0.9 }, confidence: 0.9 }, level: { type: 'score', score: 2.5, probabilities: { low: 0.5, high: 0.5 }, confidence: 0.5 } }, model: 'm', usage: { inputTokens: 0, outputTokens: 0, estimated: true }, latencyMs: 1, source: 'replay' }),
    };
    await textDecider(client, 4000, MESSAGE, (r) => rows.push(r))({ pick: { type: 'choice', instructions: 'Which?', criteria: { a: null, b: null } }, level: { type: 'score', instructions: 'How much?', levels: [{ label: 'low', description: 'low' }, { label: 'high', description: 'high' }] } });
    expect(rows[0]!.detail.answers).toEqual(['pick b 0.9', 'level 2.5']);
  });

  it('the heuristic stub reads a text\'s words as it reads a turn\'s', async () => {
    const answers = await textDecider(new HeuristicStubClient({ todayIso: '2026-11-09' }), 4000, { ...MESSAGE, body: 'yes please' }, () => {})({ confirmsYes: { type: 'noul', instructions: 'Is it a yes?' } });
    expect(noulValue(answers!, 'confirmsYes')).toBeGreaterThan(0.5);
  });
});
