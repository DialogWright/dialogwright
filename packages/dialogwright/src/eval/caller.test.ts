import { describe, expect, it } from 'vitest';
import { fakeModel } from '../converse/model/fake';
import { Budget } from './budget';
import { modelCaller } from './caller';
import type { Persona } from './personas';

const persona: Persona = { id: 'p', goal: 'Find out whether a part is in stock.', truth: { name: 'Pat Example', phone: '555-0100' }, manner: 'Brisk and a little impatient.', expects: 'answer' };
const done = { type: 'done' as const, stop: 'end' as const, usage: { inputTokens: 1000, outputTokens: 100 } };

describe('modelCaller', () => {
  it('tells the model the goal, the truth, the manner and never to reveal it is simulated', async () => {
    const model = fakeModel([[{ type: 'text', delta: 'Hi, is the part in stock?' }, done]]);
    const said = await modelCaller(model, new Budget(1, () => {}))(persona, [{ who: 'line', text: 'Welcome.', atMs: 0 }]);
    expect(said).toBe('Hi, is the part in stock?');
    const sys = model.requests[0]!.system;
    expect(sys).toContain('Find out whether a part is in stock.');
    expect(sys).toContain('Pat Example');
    expect(sys).toContain('Brisk and a little impatient.');
    expect(sys).toMatch(/Never reveal or hint that you are simulated/);
    expect(model.requests[0]!.messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'Welcome.' }] });
  });

  it('hangs up on the hang_up tool, with no goodbye where it said none', async () => {
    const spend = new Budget(1, () => {});
    const model = fakeModel([[{ type: 'tool_call', id: 't1', name: 'hang_up', args: {} }, { type: 'done', stop: 'tool', usage: { inputTokens: 1_000_000, outputTokens: 0 } }]]);
    // the fake's id is not priced, so the budget stays 0 but the call is made
    expect(await modelCaller(model, spend)(persona, [])).toEqual({ how: 'hang_up' });
  });

  it('keeps the goodbye said with the hang-up', async () => {
    const model = fakeModel([[{ type: 'text', delta: 'Thanks, bye.' }, { type: 'tool_call', id: 't1', name: 'hang_up', args: {} }, done]]);
    expect(await modelCaller(model, new Budget(1, () => {}))(persona, [])).toEqual({ how: 'hang_up', goodbye: 'Thanks, bye.' });
    expect(model.requests).toHaveLength(1);
  });

  it('asks again, the same request, after an empty reply, and uses the second', async () => {
    const model = fakeModel([[done], [{ type: 'text', delta: 'Is it in stock?' }, done]]);
    expect(await modelCaller(model, new Budget(1, () => {}))(persona, [{ who: 'line', text: 'Which part?', atMs: 0 }])).toBe('Is it in stock?');
    expect(model.requests).toHaveLength(2);
    expect(model.requests[1]).toEqual(model.requests[0]);
  });

  it('ends as empty after two empty replies, both requests spent', async () => {
    const used: string[] = [];
    const model = fakeModel([[done], [{ type: 'text', delta: '  ' }, done]]);
    const spend = new Budget(1, () => {});
    const add = spend.add.bind(spend);
    spend.add = (id, usage) => { used.push(id); return add(id, usage); };
    expect(await modelCaller(model, spend)(persona, [])).toEqual({ how: 'empty' });
    expect(model.requests).toHaveLength(2);
    expect(used).toHaveLength(2);
  });

  it('throws where the model fails', async () => {
    const model = fakeModel([[{ type: 'error', kind: 'http', detail: 'overloaded' }]]);
    await expect(modelCaller(model, new Budget(1, () => {}))(persona, [])).rejects.toThrow(/overloaded/);
  });
});
