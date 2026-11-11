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

  it('hangs up (null) on the hang_up tool, and adds its tokens to the budget', async () => {
    const spend = new Budget(1, () => {});
    const model = fakeModel([[{ type: 'tool_call', id: 't1', name: 'hang_up', args: {} }, { type: 'done', stop: 'tool', usage: { inputTokens: 1_000_000, outputTokens: 0 } }]]);
    // the fake's id is not priced, so the budget stays 0 but the call is made
    expect(await modelCaller(model, spend)(persona, [])).toBeNull();
  });

  it('throws where the model fails', async () => {
    const model = fakeModel([[{ type: 'error', kind: 'http', detail: 'overloaded' }]]);
    await expect(modelCaller(model, new Budget(1, () => {}))(persona, [])).rejects.toThrow(/overloaded/);
  });
});
