import { describe, expect, it } from 'vitest';
import { parseSse } from './sse';
import { collect, sseResponse } from './testStream';

describe('parseSse', () => {
  it('yields each data payload across chunk boundaries, ignoring comments and event lines, and stops at [DONE]', async () => {
    const res = sseResponse([': ping\n\n', 'event: x\ndata: {"a":1}\n\n', 'data: two\n\n', 'data: [DONE]\n\n', 'data: after\n\n'], 3);
    expect(await collect(parseSse(res.body!))).toEqual(['{"a":1}', 'two']);
  });
  it('handles CRLF line ends', async () => {
    const res = sseResponse(['data: one\r\n\r\ndata: two\r\n\r\n'], 5);
    expect(await collect(parseSse(res.body!))).toEqual(['one', 'two']);
  });
});
