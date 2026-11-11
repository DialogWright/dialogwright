import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeModel } from '../converse/model/fake';
import { Budget } from './budget';
import type { SimCall } from './chatDriver';
import { actionsOfCall, agentCostOfCall, JUDGE_FAILED, judgeCall } from './judge';
import type { Persona } from './personas';

const persona: Persona = { id: 'p', goal: 'Ask the hours.', truth: { name: 'Pat Example' }, manner: 'Plain.', expects: 'answer' };
const call: SimCall = { persona: 'p', turns: [{ who: 'line', text: 'Welcome.', atMs: 0 }, { who: 'caller', text: 'When are you open?', atMs: 10 }], ended: 'caller', firstWordMs: [200] };
const done = { type: 'done' as const, stop: 'tool' as const, usage: { inputTokens: 10, outputTokens: 10 } };

describe('judgeCall', () => {
  it('parses the verdict from the verdict tool call and gives the judge the business, the truth, the transcript and the actions', async () => {
    const args = { completed: true, correct: false, unsupportedClaims: ['open until nine'], honestWhenAsked: null, repeatedQuestions: 1, notes: 'It invented a time.' };
    const model = fakeModel([[{ type: 'tool_call', id: 'v', name: 'verdict', args }, done]]);
    const j = await judgeCall(model, new Budget(1), 'Open nine to five.', persona, call, [{ tool: 'callback', params: { name: 'Pat' }, verdict: 'ALLOW' }]);
    expect(j).toEqual(args);
    const asked = JSON.stringify(model.requests[0]!.messages);
    for (const part of ['Open nine to five.', 'Pat Example', 'When are you open?', 'callback(name=Pat): ALLOW']) expect(asked).toContain(part);
    expect(model.requests[0]!.tools[0]!.name).toBe('verdict');
  });

  it('gives a failed judgement, never throwing, for a malformed verdict', async () => {
    const model = fakeModel([[{ type: 'tool_call', id: 'v', name: 'verdict', args: { completed: 'yes' } }, done]]);
    const j = await judgeCall(model, new Budget(1), 'b', persona, call, []);
    expect(j.notes).toMatch(/^judge failed: completed and correct must be booleans/);
    expect(j.completed).toBe(false);
  });

  it('gives a failed judgement for a model error and for no verdict', async () => {
    const e = await judgeCall(fakeModel([[{ type: 'error', kind: 'http', detail: 'x' }]]), new Budget(1), 'b', persona, call, []);
    const n = await judgeCall(fakeModel([[{ type: 'text', delta: 'fine' }, done]]), new Budget(1), 'b', persona, call, []);
    expect([e.notes.startsWith(JUDGE_FAILED), n.notes.startsWith(JUDGE_FAILED)]).toEqual([true, true]);
  });
});

describe('the run artifacts', () => {
  it('reads a call\'s gate decisions from the audit day files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-'));
    const row = (callId: string, type: string, detail: object) => JSON.stringify({ type, detail, seq: 1, at: 't', callId, channel: 'chat', prevHash: '0', hash: 'h' });
    writeFileSync(join(dir, '2026-11-11.jsonl'), [
      row('c1', 'gate', { tool: 'request', call: 'request(name=Pat, phone=...0100)', verdict: 'ALLOW' }),
      row('c2', 'gate', { tool: 'book', call: 'book(x=1)', verdict: 'REFUSE' }),
      row('c1', 'call_started', {}),
    ].join('\n') + '\n');
    expect(actionsOfCall(dir, 'c1')).toEqual([{ tool: 'request', params: { name: 'Pat', phone: '...0100' }, verdict: 'ALLOW' }]);
    expect(actionsOfCall(join(dir, 'missing'), 'c1')).toEqual([]);
  });

  it('sums the agent cost of a call from the traces', () => {
    const dir = mkdtempSync(join(tmpdir(), 'traces-'));
    writeFileSync(join(dir, 'a.jsonl'), [JSON.stringify({ sessionId: 'c1', agent: { costUsd: 0.01 } }), JSON.stringify({ sessionId: 'c1', agent: { costUsd: 0.02 } }), JSON.stringify({ sessionId: 'c2', agent: { costUsd: 5 } })].join('\n'));
    expect(agentCostOfCall(dir, 'c1')).toBeCloseTo(0.03);
    expect(agentCostOfCall(dir, 'c3')).toBeNull();
  });
});
