import { describe, expect, it } from 'vitest';
import { fakeModel } from './fake';
import { collect } from './testStream';

describe('fakeModel', () => {
  it('answers each request with the next turn and keeps the requests', async () => {
    const m = fakeModel([[{ type: 'text', delta: 'a' }]]);
    const r = { system: 's', messages: [], tools: [], maxTokens: 1 };
    expect(await collect(m.stream(r, new AbortController().signal))).toEqual([{ type: 'text', delta: 'a' }]);
    expect(await collect(m.stream(r, new AbortController().signal))).toMatchObject([{ type: 'error' }]);
    expect(m.requests).toHaveLength(2);
  });
});
