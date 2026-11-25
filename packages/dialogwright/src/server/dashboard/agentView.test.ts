import { describe, expect, it } from 'vitest';
import { agentOf } from './view.js';

/**
 * The console's view of a turn of the old agent mode, from the record a trace written before that mode was
 * taken out holds (TraceRecord.agent): each value with its check's outcome, the action, the reply said or
 * replaced and why.
 */

describe('the console\'s call view of an agent turn, as a trace written by the old agent mode holds it', () => {
  it('agentOf: a value refused with no attempt counted, and one whose words are from an earlier turn (calls 57 to 59)', () => {
    const a = agentOf({ ms: 500, use: 'used', action: 'none', replySaid: false, values: [
      { field: 'item', value: 'Vega 911', words: 'Vega nine eleven', outcome: 'words', counted: false },
      { field: 'title', value: 'The Quiet Harbor', words: 'The Quiet Harbor', outcome: 'accepted', earlier: true },
    ] })!;
    expect(a.values.map((v) => v.outcome)).toEqual(['refused: the caller never said its words; no attempt counted', 'accepted, its words from an earlier turn']);
  });

  it('agentOf: an answer asked again after one not in its shape (AGENT_RETRY, call 60), used or failed too', () => {
    expect(agentOf({ ms: 1443, use: 'used', action: 'none', replySaid: false, values: [], retried: { invalid: 'the answer is not the shape', ms: 610 } }))
      .toMatchObject({ use: 'used', retried: 'asked again once, the first answer not in its shape (the answer is not the shape): the second used, in 610 ms' });
    expect(agentOf({ ms: 800, use: 'failed', fallback: 'invalid', detail: 'x', action: 'none', replySaid: false, values: [], retried: { invalid: 'x', ms: 400, fallback: 'timeout', detail: 'no answer within 967 ms' } }))
      .toMatchObject({ retried: 'asked again once, the first answer not in its shape (x): the second failed too: timeout (no answer within 967 ms), in 400 ms' });
    expect(agentOf({ ms: 500, use: 'used', action: 'none', replySaid: false, values: [] })!.retried).toBeUndefined();
    // A turn the provider's content filter refused, asked again once (call 61).
    expect(agentOf({ ms: 1180, use: 'used', action: 'none', replySaid: true, values: [], retried: { filtered: 'inception: HTTP 400 content_filter_error', ms: 550 } }))
      .toMatchObject({ retried: "asked again once, the first answer refused by the provider's content filter (inception: HTTP 400 content_filter_error): the second used, in 550 ms" });
    // A line said while the model was slow on a call (business.yaml's waiting).
    expect(agentOf({ ms: 2100, use: 'used', action: 'none', replySaid: false, values: [], filler: { promptId: 'agent_wait_1', atMs: 1203, said: true } })!.filler)
      .toBe('agent_wait_1 said 1203 ms in, the model\'s answer not in');
  });

  it('agentOf: an answer that never came, one set aside, and the price line said in a reply\'s place', () => {
    expect(agentOf({ ms: 1200, use: 'failed', fallback: 'timeout', detail: 'no answer within 1200 ms', values: [], action: 'none', replySaid: false })).toMatchObject({ use: 'failed', why: 'no answer: timeout (no answer within 1200 ms), the fixed line said' });
    expect(agentOf({ ms: 300, use: 'dropped', dropped: 'ignore', values: [], action: 'none', reply: 'Sure.', replySaid: false })).toMatchObject({ why: 'answer set aside: side speech', reply: { said: false, why: 'the turn was decided without it' } });
    expect(agentOf({ ms: 300, use: 'used', values: [], action: 'none', reply: 'About forty.', replySaid: false, fixedLine: 'price' })!.reply).toEqual({ text: 'About forty.', said: false, why: 'the price line was said whole in its place' });
    // A reply that takes leave of the caller where the call went on (call 55), and a value given for a full option's words.
    expect(agentOf({ ms: 300, use: 'used', values: [], action: 'none', reply: 'Thanks for calling.', replySaid: false, closes: true })!.reply).toEqual({ text: 'Thanks for calling.', said: false, why: 'it takes leave of the caller, and the call went on' });
    expect(agentOf({ ms: 300, use: 'used', values: [{ field: 'window', value: 'afternoon', words: 'friday morning', outcome: 'full' }], action: 'none', replySaid: false })!.values[0]).toMatchObject({ outcome: "set aside: the caller's words ask for an option that is full", accepted: false });
    // The decision model's reading of a price asked (call 43): the line said, read alone, or named and not said.
    expect(agentOf({ ms: 300, use: 'used', values: [], action: 'none', replySaid: false, fixedLine: 'price', priceAsked: { score: 0.91, at: 0.5, named: false } })!.price).toBe('the price line said, not named by the agent: the decision model read a price asked at 0.91 (bar 0.5)');
    expect(agentOf({ ms: 300, use: 'used', values: [], action: 'none', replySaid: false, priceAsked: { score: 0.04, at: 0.5, named: true } })!.price).toBe('the price line named by the agent, not said: the decision model read a price asked at 0.04 (bar 0.5)');
    expect(agentOf({ ms: 300, use: 'used', values: [], action: 'none', replySaid: false, priceAsked: { score: 0.04, at: 0.5, named: false } })!.price).toBeUndefined();
    // The action it proposed, and what the turn did with it.
    expect(agentOf({ ms: 300, use: 'used', values: [], action: 'submit', actionOutcome: 'ignored', replySaid: false })).toMatchObject({ action: 'submit', actionOutcome: 'ignored' });
    expect(agentOf(undefined)).toBeNull();
  });
});
