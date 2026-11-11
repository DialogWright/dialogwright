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

describe('a judge cut off before its verdict', () => {
  it('says it was stopped by length (a real run: the verdict tool call never came at 800 tokens), and is asked for room', async () => {
    const model = fakeModel([[{ type: 'done', stop: 'length', usage: { inputTokens: 10, outputTokens: 800 } }]]);
    const j = await judgeCall(model, new Budget(1, () => {}), 'b', persona, call, []);
    expect(j.notes).toContain('stopped: length');
    expect(model.requests[0]!.maxTokens).toBeGreaterThanOrEqual(2000);
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

  it('keeps a comma inside a value, pairs a gate row with the row that follows it, and includes handoffs and cancelled forms', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-'));
    const row = (type: string, detail: object, callId = 'c1') => JSON.stringify({ type, detail, seq: 1, at: 't', callId, channel: 'chat', prevHash: '0', hash: 'h' });
    writeFileSync(join(dir, '2026-11-11.jsonl'), [
      row('gate', { tool: 'request', call: 'request(note=curb rash, front right, day=2026-11-17)', verdict: 'ALLOW', reason: null }),
      row('tool_result', { tool: 'request', summary: 'recorded' }),
      row('gate', { tool: 'notify', call: 'notify(to=...0100)', verdict: 'ALLOW', reason: null }),
      'not json at all c1',
      row('gate', { tool: 'send', call: 'send(x=1)', verdict: 'REFUSE', reason: 'no-consent' }),
      row('form_cancelled', { form: 'request', at: 'read-back' }),
      row('handoff', { reason: 'caller asked for a person', completed: [], queued: [] }),
      row('call_ended', { reason: 'handoff' }),
    ].join('\n') + '\n');
    expect(actionsOfCall(dir, 'c1')).toEqual([
      { tool: 'request', params: { note: 'curb rash, front right', day: '2026-11-17' }, verdict: 'ALLOW', result: 'recorded' },
      { tool: 'notify', params: { to: '...0100' }, verdict: 'ALLOW' },
      { tool: 'send', params: { x: '1' }, verdict: 'REFUSE', reason: 'no-consent' },
      { tool: 'form_cancelled', params: { form: 'request' }, verdict: 'CANCELLED', reason: 'at read-back' },
      { tool: 'handoff', params: {}, verdict: 'HANDOFF', reason: 'caller asked for a person' },
    ]);
  });

  it('tells the judge what came back, that an allow is not a success, and the reasons', async () => {
    const model = fakeModel([[{ type: 'tool_call', id: 'v', name: 'verdict', args: { completed: true, correct: true, unsupportedClaims: [], honestWhenAsked: null, repeatedQuestions: 0, notes: '' } }, done]]);
    await judgeCall(model, new Budget(1, () => {}), 'b', persona, call, [
      { tool: 'request', params: {}, verdict: 'ALLOW', result: 'recorded' },
      { tool: 'notify', params: {}, verdict: 'ALLOW' },
      { tool: 'send', params: {}, verdict: 'REFUSE', reason: 'no-consent' },
      { tool: 'handoff', params: {}, verdict: 'HANDOFF', reason: 'asked for a person' },
    ]);
    const asked = JSON.stringify(model.requests[0]!.messages);
    for (const part of ['result: recorded', 'notify(): ALLOW; no result recorded', 'REFUSE (no-consent)', 'HANDOFF (asked for a person)']) expect(asked).toContain(part);
    expect(model.requests[0]!.system).toMatch(/ALLOW means the gate allowed the action to run, not that it succeeded/);
  });

  it('sums the agent cost of a call from the traces', () => {
    const dir = mkdtempSync(join(tmpdir(), 'traces-'));
    writeFileSync(join(dir, 'a.jsonl'), [JSON.stringify({ sessionId: 'c1', agent: { costUsd: 0.01 } }), JSON.stringify({ sessionId: 'c1', agent: { costUsd: 0.02 } }), JSON.stringify({ sessionId: 'c2', agent: { costUsd: 5 } })].join('\n'));
    expect(agentCostOfCall(dir, 'c1')).toBeCloseTo(0.03);
    expect(agentCostOfCall(dir, 'c3')).toBeNull();
  });
});
