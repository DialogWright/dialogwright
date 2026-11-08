import { describe, expect, it } from 'vitest';
import { agentCassetteName, askedTurns, formatAgentBakeoff, formatAgentBakeoffMarkdown, labelValue, liveAgentClient, meetsBar, parseAgentModelSpecs, runAgentBakeoff, variantsOf, warmedUp } from './bakeoff';
import { BAKEOFF_CALLS, BAKEOFF_EXAMPLES, type BakeoffTurn } from './bakeoffCases';
import { AGENT_CASSETTE_MISS } from './cassette';
import { fakeAgent, type FakeAgentFailure } from './fake';
import type { AgentAnswer, AgentContext } from './types';

/**
 * The agent bake-off on the fake agent: no model is asked. A fake that answers every turn as its labels
 * say scores every value and action right (which also holds the cases' labels to each other), and one
 * that slips is counted where it slips.
 */

/** Every turn of the cases, by the caller's words (each is said once). */
const TURNS = new Map<string, { call: string; index: number; turn: BakeoffTurn }>(BAKEOFF_CALLS.flatMap((c) => c.turns.map((turn, index) => [turn.caller, { call: c.id, index, turn }] as const)));
const latest = (ctx: AgentContext): { call: string; index: number; turn: BakeoffTurn } => TURNS.get(ctx.conversation.at(-1)!.text)!;

/** The answer a turn's labels describe: each labelled value, cited by the caller's whole turn, and the first action allowed. */
function labelled(ctx: AgentContext): AgentAnswer {
  const { turn } = latest(ctx);
  const values = Object.entries(turn.values ?? {}).map(([field, label]) => ({ field, value: labelValue(label), words: turn.caller }));
  const action = turn.action === undefined ? 'none' : typeof turn.action === 'string' ? turn.action : turn.action[0]!;
  return { reply: 'Sure, I can help with that.', values, action, fromFacts: false };
}

const TOTAL_TURNS = BAKEOFF_CALLS.reduce((n, c) => n + c.turns.length, 0);
const TOTAL_LABELLED = BAKEOFF_CALLS.reduce((n, c) => n + c.turns.reduce((m, t) => m + Object.keys(t.values ?? {}).length, 0), 0);

describe('the bake-off cases', () => {
  it('cover both demo calls and the review focus', () => {
    expect(BAKEOFF_CALLS.map((c) => c.id)).toEqual(expect.arrayContaining(['dealer-trade-ins', 'retail-bmw', 'correction-in-one-turn', 'claimed-account', 'instructions-to-the-model']));
    expect(TURNS.size).toBe(TOTAL_TURNS);
  });

  it('each turn is asked with the conversation before it and the values its earlier labels set; the examples only with them', () => {
    const turns = askedTurns(BAKEOFF_CALLS.find((c) => c.id === 'dealer-trade-ins')!, 'examples');
    expect(turns[0]!.ctx.fields.every((f) => f.value === null)).toBe(true);
    expect(turns[1]!.ctx.fields.find((f) => f.name === 'cars')!.value).toBe('three');
    expect(turns[1]!.ctx.conversation.map((u) => u.who)).toEqual(['line', 'caller', 'line', 'caller']);
    expect(turns[0]!.ctx.examples).toEqual(BAKEOFF_EXAMPLES);
    expect(askedTurns(BAKEOFF_CALLS[0]!, 'no examples')[0]!.ctx.examples).toEqual([]);
    expect(turns[0]!.ctx.caller).toEqual({ account: 'Rivergate Motors' });
  });
});

describe('runAgentBakeoff', () => {
  it('the table counts valid answers, labelled values right, and timings', async () => {
    let n = 0;
    // A turn's time is its order: 10, 20, ... ms.
    const right = fakeAgent(labelled, { ms: () => (n += 1) * 10, usage: { inputTokens: 1000, outputTokens: 50 } });
    const slips = fakeAgent((ctx): AgentAnswer | FakeAgentFailure => {
      const { call, index } = latest(ctx);
      const a = labelled(ctx);
      if (call === 'correction-in-one-turn') return { fail: 'invalid', detail: 'the answer is not JSON' };
      if (call === 'dealer-trade-ins' && index === 0) return { ...a, values: a.values.map((v) => (v.field === 'cars' ? { ...v, value: 'two' } : v)) };
      if (call === 'retail-bmw' && index === 4) return { ...a, reply: 'Usually about $80 for one wheel.' };
      if (call === 'retail-bmw' && index === 6) return { ...a, values: a.values.map((v) => ({ ...v, words: 'Jordan Leigh' })) };
      if (call === 'over-the-greeting') return { ...a, values: [...a.values, { field: 'callbackNumber', value: '5555550123', words: 'yeah hi' }] };
      return a;
    }, { ms: 500 });
    const report = await runAgentBakeoff([{ entry: 'fake:right', client: right }, { entry: 'fake:slips', client: slips }], { variants: ['examples'], prices: new Map([['fake-agent', { input: 1, output: 2 }]]) });
    const [good, bad] = report.results;

    expect(good).toMatchObject({ status: 'ran', asked: TOTAL_TURNS, valid: TOTAL_TURNS, invalid: 0, figures: 0, actions: { right: TOTAL_TURNS, of: TOTAL_TURNS } });
    expect(good!.values).toEqual({ labelled: TOTAL_LABELLED, right: TOTAL_LABELLED, wrong: 0, missed: 0, extra: 0, wordsNotSaid: 0 });
    expect(good!.mistakes).toEqual([]);
    const times = Array.from({ length: TOTAL_TURNS }, (_, i) => (i + 1) * 10);
    expect(good!.ms).toEqual({ measured: TOTAL_TURNS, p50: times[Math.ceil(0.5 * TOTAL_TURNS) - 1], p95: times[Math.ceil(0.95 * TOTAL_TURNS) - 1] });
    expect(good!.tokens).toEqual({ input: 1000 * TOTAL_TURNS, output: 50 * TOTAL_TURNS });
    expect(good!.costUsd).toBeCloseTo((1000 * TOTAL_TURNS * 1 + 50 * TOTAL_TURNS * 2) / 1_000_000);
    // The replies to the turns a person reads are kept, by turn.
    expect(good!.reviewed.find((v) => v.call === 'retail-bmw' && v.turn === 5)).toMatchObject({ review: expect.stringContaining('price'), replies: ['Sure, I can help with that.'] });

    const correctionLabels = Object.keys(BAKEOFF_CALLS.find((c) => c.id === 'correction-in-one-turn')!.turns[0]!.values!).length;
    expect(bad).toMatchObject({ valid: TOTAL_TURNS - 1, invalid: 1, figures: 1, ms: { p50: 500, p95: 500 }, costUsd: null });
    expect(bad!.values).toMatchObject({ wrong: 1, missed: correctionLabels, extra: 1, wordsNotSaid: 1, right: TOTAL_LABELLED - 1 - correctionLabels });
    expect(bad!.mistakes.map((m) => `${m.call} ${m.turn}: ${m.what}`)).toEqual(expect.arrayContaining([
      'dealer-trade-ins 1: cars "two", wanted "three"',
      'retail-bmw 5: a figure not in the facts: "Usually about $80 for one wheel."',
      'retail-bmw 7: callerName\'s words "Jordan Leigh" were never said',
      'correction-in-one-turn 1: invalid: the answer is not JSON',
      'over-the-greeting 1: callbackNumber "5555550123" given, not asked for',
    ]));

    const text = formatAgentBakeoff(report, { byTurn: true }).join('\n');
    expect(text).toContain('valid JSON');
    expect(text).toContain(`${TOTAL_TURNS - 1}/${TOTAL_TURNS}`);
    expect(text).toContain('cars "two", wanted "three"');
    const markdown = formatAgentBakeoffMarkdown(report);
    expect(markdown).toContain('| model | prompt | asked | valid JSON | values right |');
    expect(markdown).toContain('replies to read');
  });

  it('asks each turn as often as --repeat, in each variant, and the judge\'s time counts against the bar', async () => {
    const report = await runAgentBakeoff([{ entry: 'fake:fast', client: fakeAgent(labelled, { ms: 400 }) }], { variants: ['examples', 'no examples'], repeat: 2, judgeMs: 500 });
    expect(report.results.map((r) => [r.variant, r.asked])).toEqual([['examples', 2 * TOTAL_TURNS], ['no examples', 2 * TOTAL_TURNS]]);
    expect(meetsBar(report.results[0]!, 500)).toBe(true);
    expect(meetsBar(report.results[0]!, 700)).toBe(false);
    expect(formatAgentBakeoff(report).join('\n')).toContain('900 / 900');
  });

  it('a replay with nothing recorded is not recorded; failed requests in a row stop the model', async () => {
    const miss = { model: 'cassette', answer: async () => ({ ok: false as const, reason: 'error' as const, detail: AGENT_CASSETTE_MISS, ms: 0 }) };
    const down = fakeAgent(() => ({ fail: 'error', detail: 'inception: HTTP 401' }));
    const report = await runAgentBakeoff([{ entry: 'replayed', client: miss }, { entry: 'down', client: down }], { variants: ['examples', 'no examples'], replay: true });
    expect(report.results.map((r) => [r.entry, r.variant, r.status])).toEqual([['replayed', 'examples', 'not-recorded'], ['replayed', 'no examples', 'not-recorded'], ['down', 'examples', 'stopped'], ['down', 'no examples', 'stopped']]);
    expect(report.results[2]!.asked).toBe(3);
    expect(formatAgentBakeoff(report).join('\n')).toContain('stopped, 3 requests in a row failed: inception: HTTP 401');
  });
});

describe('parseAgentModelSpecs', () => {
  it('reads Inception\'s effort and realtime, and OpenRouter\'s thinking and effort', () => {
    expect(parseAgentModelSpecs(['inception:mercury-3:instant:realtime,inception:mercury-3:low', 'openrouter:inception/mercury-3', 'openrouter:google/gemini-3.5-flash-lite:low'])).toEqual([
      { entry: 'inception:mercury-3:instant:realtime', provider: 'inception', model: 'mercury-3', effort: 'instant', realtime: true },
      { entry: 'inception:mercury-3:low', provider: 'inception', model: 'mercury-3', effort: 'low', realtime: false },
      { entry: 'openrouter:inception/mercury-3', provider: 'openrouter', model: 'inception/mercury-3', realtime: false },
      { entry: 'openrouter:google/gemini-3.5-flash-lite:low', provider: 'openrouter', model: 'google/gemini-3.5-flash-lite', effort: 'low', realtime: false },
    ]);
    expect(agentCassetteName(parseAgentModelSpecs(['inception:mercury-3:instant:realtime'])[0]!)).toBe('inception/mercury-3.instant.realtime');
  });

  it('refuses an entry it cannot read, saying which', () => {
    expect(() => parseAgentModelSpecs([])).toThrow('names no model');
    expect(() => parseAgentModelSpecs(['mercury-3'])).toThrow('"mercury-3": start it with its provider');
    expect(() => parseAgentModelSpecs(['inception:mercury-3:realtime:instant'])).toThrow('in that order');
    expect(() => parseAgentModelSpecs(['openrouter:inception/mercury-3:realtime'])).toThrow("realtime is Inception's");
    expect(() => parseAgentModelSpecs(['inception:mercury-3', 'inception:mercury-3'])).toThrow('named twice');
  });

  it('reads --examples', () => {
    expect(variantsOf(undefined)).toEqual(['examples', 'no examples']);
    expect(variantsOf('on')).toEqual(['examples']);
    expect(variantsOf('off')).toEqual(['no examples']);
    expect(() => variantsOf('maybe')).toThrow('on, off or both');
  });

  it('makes a live client only with its provider\'s key, naming the variable', () => {
    const [inception, openrouter] = parseAgentModelSpecs(['inception:mercury-3:instant:realtime', 'openrouter:inception/mercury-3']);
    expect(() => liveAgentClient(inception!, {})).toThrow('INCEPTION_API_KEY');
    expect(() => liveAgentClient(openrouter!, {})).toThrow('OPENROUTER_API_KEY');
    expect(liveAgentClient(inception!, { INCEPTION_API_KEY: 'sk-test-not-a-real-key' }).model).toBe('mercury-3');
  });
});

describe('warmedUp', () => {
  it('asks once more before its first answer, and drops it', async () => {
    let asked = 0;
    const client = warmedUp(fakeAgent((ctx) => (asked += 1, labelled(ctx))));
    const ctx = askedTurns(BAKEOFF_CALLS[0]!, 'examples')[0]!.ctx;
    await client.answer(ctx, 1000);
    await client.answer(ctx, 1000);
    expect(asked).toBe(3);
  });
});
