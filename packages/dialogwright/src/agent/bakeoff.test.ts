import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { agentCassetteName, agentRequestOf, askedTurns, formatAgentBakeoff, formatAgentBakeoffMarkdown, labelValue, liveAgentClient, meetsBar, numbersNotIn, parseAgentModelSpecs, printedTurn, recordedDirFor, runAgentBakeoff, scoreAnswer, variantsOf, warmedUp, WARM_UP_CONTEXT, type AskedTurn } from './bakeoff';
import { loadBakeoffCases, parseBakeoffCases, type BakeoffTurn } from './bakeoffCases';
import { AGENT_CASSETTE_MISS, cassetteAgent } from './cassette';
import { fakeAgent, type FakeAgentFailure } from './fake';
import type { AgentAnswer, AgentContext } from './types';

/**
 * The agent bake-off on the fake agent and an invented library's cases (./fixture/library.cases.yaml): no
 * model is asked. A fake that answers every turn as its labels say scores every value and action right
 * (which also holds the cases' labels to each other), and one that slips is counted where it slips.
 */

const CASES_FILE = new URL('./fixture/library.cases.yaml', import.meta.url).pathname;
const cases = loadBakeoffCases(CASES_FILE);

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'agent-bakeoff-'));
  dirs.push(d);
  return d;
};

/** Every turn of the cases, by the caller's words (each is said once). */
const TURNS = new Map<string, { call: string; index: number; turn: BakeoffTurn }>(cases.calls.flatMap((c) => c.turns.map((turn, index) => [turn.caller, { call: c.id, index, turn }] as const)));
const latest = (ctx: AgentContext): { call: string; index: number; turn: BakeoffTurn } => TURNS.get(ctx.conversation.at(-1)!.text)!;

/** The answer a turn's labels describe: each labelled value, cited by the caller's whole turn, and the first action allowed. */
function labelled(ctx: AgentContext): AgentAnswer {
  const { turn } = latest(ctx);
  const values = Object.entries(turn.values ?? {}).map(([field, label]) => ({ field, value: labelValue(label), words: turn.caller }));
  const action = turn.action === undefined ? 'none' : typeof turn.action === 'string' ? turn.action : turn.action[0]!;
  return { reply: 'Happy to help with that.', values, action, fromFacts: false };
}

const turnOf = (call: string, index: number): AskedTurn => askedTurns(cases, cases.calls.find((c) => c.id === call)!, 'examples')[index]!;
const reply = (t: AskedTurn, text: string, values: AgentAnswer['values'] = []): AgentAnswer => ({ reply: text, values, action: 'none', fromFacts: false });

describe('the cases file', () => {
  it('is read and resolved: 4 calls, 8 caller turns, 14 labelled values', () => {
    expect(cases.calls.map((c) => c.id)).toEqual(['hold-request', 'room-booking', 'correction-in-one-turn', 'over-the-greeting']);
    expect(TURNS.size).toBe(8);
    expect(cases.calls.reduce((n, c) => n + c.turns.reduce((m, t) => m + Object.keys(t.values ?? {}).length, 0), 0)).toBe(14);
    expect(cases.calls[1]).toMatchObject({ form: { name: 'room' }, channel: 'chat', caller: { account: 'Rivergate Book Club' } });
  });

  it('refuses a form, a field or an action it does not have, saying where', () => {
    const base = { facts: { name: 'X', voice: 'Brief.' }, forms: { f: { about: 'a form', fields: [{ name: 'day', type: 'date' }], actions: [{ name: 'submit', about: 'read back' }] } } };
    const call = (turn: Record<string, unknown>, form = 'f') => ({ ...base, calls: [{ id: 'c', about: 'a call', form, today: '2026-11-09', turns: [{ caller: 'hi', line: 'hello', ...turn }] }] });
    expect(() => parseBakeoffCases(call({}, 'g'))).toThrow('form g is not one of the forms (f)');
    expect(() => parseBakeoffCases(call({ values: { night: '2026-11-10' } }))).toThrow('night is no field of form f');
    expect(() => parseBakeoffCases(call({ action: 'book' }))).toThrow('book is not one of the form\'s actions (submit, none)');
    expect(() => parseBakeoffCases({ ...base, forms: { f: { ...base.forms.f, fields: [{ name: 'dob', type: 'birthdate' }] } }, calls: [] })).toThrow();
    expect(parseBakeoffCases(call({ action: 'submit', values: { day: '2026-11-10' } })).calls[0]!.fields).toEqual([{ name: 'day', type: 'date', required: true }]);
  });

  it('each turn is asked with the conversation before it and the values its earlier labels set; the examples only with them', () => {
    const turns = askedTurns(cases, cases.calls[0]!, 'examples');
    expect(turns[0]!.ctx.fields.every((f) => f.value === null)).toBe(true);
    expect(turns[1]!.ctx.fields.find((f) => f.name === 'copies')!.value).toBe('two');
    expect(turns[1]!.ctx.conversation.map((u) => u.who)).toEqual(['line', 'caller', 'line', 'caller']);
    expect(turns[0]!.ctx.examples).toEqual(cases.examples);
    expect(askedTurns(cases, cases.calls[0]!, 'no examples')[0]!.ctx.examples).toEqual([]);
    expect(recordedDirFor('/a/b/cases.yaml')).toBe('/a/b/recorded');
    expect(printedTurn(cases)).toMatchObject({ call: { id: 'hold-request' }, index: 1 });
  });
});

describe('scoreAnswer', () => {
  it('on a turn that may say no number, any number the fixed lines do not say is a figure, in digits or in words, the caller\'s own too', () => {
    const t = turnOf('hold-request', 1);
    for (const text of ['It would be about four hundred.', 'Around eight, usually.', "It's under a hundred bucks.", 'Maybe $2 a day.', 'Two copies, so no fee.']) expect(scoreAnswer(reply(t, text), t).figure, text).toBe(true);
    expect(scoreAnswer(reply(t, 'Fees are explained at the desk.'), t).figure).toBe(false);
    expect(numbersNotIn('someone at the desk', [])).toEqual([]);
    expect(numbersNotIn('It is 2 dollars, or about four hundred', ['The fee is $2.'])).toEqual(['400']);
  });

  it('a figure refused that is the number one alone is counted apart ("a lovely one"), so what the check costs is measured', () => {
    const t = turnOf('hold-request', 1);
    expect(scoreAnswer(reply(t, 'That is a lovely one.'), t)).toMatchObject({ figure: true, figureOne: true });
    expect(scoreAnswer(reply(t, 'It would be about four hundred.'), t)).toMatchObject({ figure: true, figureOne: false });
    expect(scoreAnswer(reply(t, 'One for four hundred.'), t)).toMatchObject({ figure: true, figureOne: false });
    expect(scoreAnswer(reply(t, 'Fees are explained at the desk.'), t)).toMatchObject({ figure: false, figureOne: false });
  });

  it('a reply may say back a figure the caller said, a year among them, but not one it makes from theirs', () => {
    const counted = parseBakeoffCases({
      facts: { name: 'Example Library', voice: 'Brief.' },
      forms: { hold: { about: 'a hold', fields: [{ name: 'copies', type: 'choice', options: ['seven'] }, { name: 'title', type: 'text' }] } },
      calls: [{ id: 'c', about: 'a call', form: 'hold', today: '2026-11-09', turns: [{ caller: 'Three copies of the 2019 edition for me and four for my sister, and call me before 9am.', line: 'Sure.' }] }],
    });
    const t = askedTurns(counted, counted.calls[0]!, 'no examples')[0]!;
    expect(scoreAnswer(reply(t, 'The 2019 edition, got it.'), t).figure).toBe(false);
    expect(scoreAnswer(reply(t, 'Three for you and four for your sister.'), t).figure).toBe(false);
    expect(scoreAnswer(reply(t, "I can't confirm 9am, sorry."), t).figure).toBe(false);
    expect(scoreAnswer(reply(t, "That's seven copies total."), t).figure).toBe(true);
    expect(scoreAnswer(reply(t, "That's 7 copies of the 2020 edition."), t).figure).toBe(true);
  });

  it('a reply may say back a date or time the caller said, but not on a turn that may say no number', () => {
    const asked = (noFigure: boolean) => {
      const c = parseBakeoffCases({
        facts: { name: 'Example Library', voice: 'Brief.' },
        forms: { hold: { about: 'a hold', fields: [{ name: 'title', type: 'text' }] } },
        calls: [{ id: 'c', about: 'a call', form: 'hold', today: '2026-11-09', turns: [{ caller: 'Hold it for me Thursday, or tomorrow at 7am, and tell me the fee.', line: 'Sure.', ...(noFigure ? { noFigure: true } : {}) }] }],
      });
      return askedTurns(c, c.calls[0]!, 'no examples')[0]!;
    };
    const t = asked(false);
    expect(scoreAnswer(reply(t, "I can't confirm tomorrow at 7am, but Thursday is fine."), t).figure).toBe(false);
    expect(scoreAnswer(reply(t, 'How about Friday?'), t).figure).toBe(true);
    const strict = asked(true);
    expect(scoreAnswer(reply(strict, "I can't confirm tomorrow at 7am."), strict).figure).toBe(true);
    expect(scoreAnswer(reply(strict, "I can't confirm that for Thursday."), strict).figure).toBe(true);
    expect(scoreAnswer(reply(strict, 'The fee is explained at the desk.'), strict).figure).toBe(false);
  });

  it('a value is a figure\'s source only when its label holds it right, and a text value never is', () => {
    const t = turnOf('hold-request', 0);
    expect(scoreAnswer(reply(t, 'Two copies it is.', [{ field: 'copies', value: 'two', words: 'two copies' }]), t).figure).toBe(false);
    expect(scoreAnswer(reply(t, 'Three copies it is.', [{ field: 'copies', value: 'three', words: 'three' }]), t).figure).toBe(true);
    expect(scoreAnswer(reply(t, 'The 4 Quiet Harbors, got it.', [{ field: 'title', value: 'The 4 Quiet Harbors', words: 'The Quiet Harbor' }]), t).figure).toBe(true);
    // Not on a noFigure turn, a figure the facts hold is no figure of its own: the morning window is 9 to noon.
    expect(scoreAnswer(reply(t, 'You can collect it from 9.'), t).figure).toBe(false);
  });

  it('cited words and a text label match whole words only', () => {
    const t = turnOf('hold-request', 0);
    const s = scoreAnswer(reply(t, 'Got it.', [{ field: 'title', value: 'The Quiet Harbors', words: 'Quiet Harb' }, { field: 'copies', value: 'two', words: 'two copies' }]), t);
    expect(s.mistakes).toEqual(['title "The Quiet Harbors", wanted words "quiet harbor"', 'title\'s words "Quiet Harb" were never said']);
  });

  it('a field given twice with different values is wrong; twice the same is right', () => {
    const t = turnOf('room-booking', 0);
    const base = labelled(t.ctx);
    const twice = scoreAnswer({ ...base, values: [...base.values, { field: 'people', value: 'five', words: 'Book the study room' }] }, t);
    expect(twice).toMatchObject({ right: 2, wrong: 1 });
    expect(twice.mistakes).toEqual(['people given twice: "four" and "five"']);
    expect(scoreAnswer({ ...base, values: [...base.values, { field: 'people', value: 'Four', words: 'four of us' }] }, t)).toMatchObject({ right: 3, wrong: 0 });
  });
});

describe('runAgentBakeoff', () => {
  it('the table counts valid answers, labelled values right, and timings', async () => {
    let n = 0;
    // A turn's time is its order: 10, 20, ... 80 ms.
    const right = fakeAgent(labelled, { ms: () => (n += 1) * 10, usage: { inputTokens: 1000, outputTokens: 50 } });
    const slips = fakeAgent((ctx): AgentAnswer | FakeAgentFailure => {
      const { call, index } = latest(ctx);
      const a = labelled(ctx);
      if (call === 'correction-in-one-turn') return { fail: 'invalid', detail: 'the answer is not JSON' };
      if (call === 'hold-request' && index === 0) return { ...a, values: a.values.map((v) => (v.field === 'copies' ? { ...v, value: 'three' } : v)) };
      if (call === 'hold-request' && index === 1) return { ...a, reply: 'Usually about $2 a day.' };
      if (call === 'hold-request' && index === 2) return { ...a, values: a.values.map((v) => (v.field === 'patronName' ? { ...v, words: 'Dana Reye' } : v)) };
      if (call === 'room-booking' && index === 0) return { ...a, values: [...a.values, { field: 'people', value: 'five', words: 'Book the study room' }] };
      if (call === 'over-the-greeting') return { ...a, values: [...a.values, { field: 'callbackNumber', value: '5555550123', words: 'yeah hi' }] };
      return a;
    }, { ms: 500 });
    const report = await runAgentBakeoff([{ entry: 'fake:right', client: right }, { entry: 'fake:slips', client: slips }], { cases, variants: ['examples'], prices: new Map([['fake-agent', { input: 1, output: 2 }]]) });
    const [good, bad] = report.results;

    expect(good).toMatchObject({ status: 'ran', asked: 8, failed: 0, answered: 8, valid: 8, invalid: 0, figures: 0, actions: { right: 8, of: 8 } });
    expect(good!.values).toEqual({ labelled: 14, right: 14, wrong: 0, missed: 0, extra: 0, wordsNotSaid: 0 });
    expect(good!.mistakes).toEqual([]);
    expect(good!.ms).toEqual({ measured: 8, p50: 40, p95: 80 });
    expect(good!.tokens).toEqual({ input: 8000, output: 400 });
    expect(good!.costUsd).toBeCloseTo(0.0088);
    expect(good!.reviewed).toEqual([{ call: 'hold-request', turn: 2, review: 'fee pushed: no figure', replies: ['Happy to help with that.'] }]);

    expect(bad).toMatchObject({ answered: 8, valid: 7, invalid: 1, figures: 1, ms: { p50: 500, p95: 500 }, costUsd: null });
    expect(bad!.values).toEqual({ labelled: 14, right: 9, wrong: 2, missed: 3, extra: 1, wordsNotSaid: 1 });
    expect(bad!.mistakes.map((m) => `${m.call} ${m.turn}: ${m.what}`)).toEqual([
      'hold-request 1: copies "three", wanted "two"',
      'hold-request 2: a number on a turn that may say none: "Usually about $2 a day."',
      'hold-request 3: patronName\'s words "Dana Reye" were never said',
      'room-booking 1: people given twice: "four" and "five"',
      'correction-in-one-turn 1: invalid: the answer is not JSON',
      'over-the-greeting 1: callbackNumber "5555550123" given, not asked for',
    ]);

    const text = formatAgentBakeoff(report, { byTurn: true }).join('\n');
    expect(text).toContain('7/8 (88%)');
    expect(text).toContain('40 / 80');
    const markdown = formatAgentBakeoffMarkdown(report);
    expect(markdown).toContain('| model | prompt | asked | answered | valid JSON | values right |');
    expect(markdown).toContain('replies to read');
  });

  it('a failed request is no answer: left out of every share, reported as availability, and its replay tables alike', async () => {
    const path = join(scratch(), 'fake.jsonl');
    const live = fakeAgent((ctx) => {
      const { call, index } = latest(ctx);
      return call === 'hold-request' && index === 2 ? { fail: 'error', detail: 'fake: HTTP 503' } : labelled(ctx);
    }, { ms: 300, usage: { inputTokens: 100, outputTokens: 10 } });
    const recorded = await runAgentBakeoff([{ entry: 'fake', client: cassetteAgent(path, { record: live }) }], { cases, variants: ['examples'] });
    const r = recorded.results[0]!;
    expect(r).toMatchObject({ asked: 8, failed: 1, answered: 7, valid: 7, actions: { right: 7, of: 7 }, errors: { 'fake: HTTP 503': 1 } });
    expect(r.values).toMatchObject({ labelled: 11, right: 11, missed: 0 });
    const replayed = await runAgentBakeoff([{ entry: 'fake', client: cassetteAgent(path) }], { cases, variants: ['examples'] });
    expect(formatAgentBakeoff(replayed, { byTurn: true })).toEqual(formatAgentBakeoff(recorded, { byTurn: true }));
    expect(formatAgentBakeoff(recorded).join('\n')).toContain('7/8 (88%)');
  });

  it('asks each turn as often as --repeat, in each variant; a replay past what was recorded is not recorded; the judge\'s time counts against the bar', async () => {
    const path = join(scratch(), 'fake.jsonl');
    await runAgentBakeoff([{ entry: 'fake', client: cassetteAgent(path, { record: fakeAgent(labelled, { ms: 400 }) }) }], { cases, variants: ['examples'] });
    const report = await runAgentBakeoff([{ entry: 'fake', client: cassetteAgent(path) }], { cases, variants: ['examples'], repeat: 2, judgeMs: 500, replay: true });
    expect(report.results[0]).toMatchObject({ asked: 8, notRecorded: 8 });
    const live = await runAgentBakeoff([{ entry: 'fake:fast', client: fakeAgent(labelled, { ms: 400 }) }], { cases, variants: ['examples', 'no examples'], repeat: 2, judgeMs: 500 });
    expect(live.results.map((r) => [r.variant, r.asked])).toEqual([['examples', 16], ['no examples', 16]]);
    expect(meetsBar(live.results[0]!, 500)).toBe(true);
    expect(meetsBar(live.results[0]!, 700)).toBe(false);
    expect(formatAgentBakeoff(live).join('\n')).toContain('900 / 900');
  });

  it('a replay with nothing recorded is not recorded; failed requests in a row stop the model', async () => {
    const miss = { model: 'cassette', answer: async () => ({ ok: false as const, reason: 'error' as const, detail: AGENT_CASSETTE_MISS, ms: 0 }) };
    const down = fakeAgent(() => ({ fail: 'error', detail: 'inception: HTTP 401' }));
    const report = await runAgentBakeoff([{ entry: 'replayed', client: miss }, { entry: 'down', client: down }], { cases, variants: ['examples', 'no examples'], replay: true });
    expect(report.results.map((r) => [r.entry, r.variant, r.status])).toEqual([['replayed', 'examples', 'not-recorded'], ['replayed', 'no examples', 'not-recorded'], ['down', 'examples', 'stopped'], ['down', 'no examples', 'stopped']]);
    expect(report.results[2]).toMatchObject({ asked: 3, failed: 3, answered: 0 });
    expect(formatAgentBakeoff(report).join('\n')).toContain('stopped, 3 requests in a row failed: inception: HTTP 401');
  });
});

describe('parseAgentModelSpecs', () => {
  it('reads Inception\'s effort and realtime, and OpenRouter\'s thinking and effort', () => {
    expect(parseAgentModelSpecs(['inception:mercury-3:instant:realtime,inception:mercury-3:low', 'openrouter:vendor/model', 'openrouter:vendor/always-reasons:low'])).toEqual([
      { entry: 'inception:mercury-3:instant:realtime', provider: 'inception', model: 'mercury-3', effort: 'instant', realtime: true },
      { entry: 'inception:mercury-3:low', provider: 'inception', model: 'mercury-3', effort: 'low', realtime: false },
      { entry: 'openrouter:vendor/model', provider: 'openrouter', model: 'vendor/model', realtime: false },
      { entry: 'openrouter:vendor/always-reasons:low', provider: 'openrouter', model: 'vendor/always-reasons', effort: 'low', realtime: false },
    ]);
    expect(agentCassetteName(parseAgentModelSpecs(['inception:mercury-3:instant:realtime'])[0]!)).toBe('inception/mercury-3.instant.realtime');
  });

  it('refuses an entry it cannot read, saying which', () => {
    expect(() => parseAgentModelSpecs([])).toThrow('names no model');
    expect(() => parseAgentModelSpecs(['mercury-3'])).toThrow('"mercury-3": start it with its provider');
    expect(() => parseAgentModelSpecs(['inception:mercury-3:realtime:instant'])).toThrow('in that order');
    expect(() => parseAgentModelSpecs(['openrouter:vendor/model:realtime'])).toThrow("realtime is Inception's");
    expect(() => parseAgentModelSpecs(['inception:mercury-3', 'inception:mercury-3'])).toThrow('named twice');
  });

  it('reads --examples', () => {
    expect(variantsOf(undefined)).toEqual(['examples', 'no examples']);
    expect(variantsOf('on')).toEqual(['examples']);
    expect(variantsOf('off')).toEqual(['no examples']);
    expect(() => variantsOf('maybe')).toThrow('on, off or both');
  });

  it('makes a live client only with its provider\'s key; the request a replay keys by needs none, and sends reasoning only where asked', () => {
    const [inception, plain, low] = parseAgentModelSpecs(['inception:mercury-3:instant:realtime', 'openrouter:vendor/model', 'openrouter:vendor/always-reasons:low']);
    expect(() => liveAgentClient(inception!, {})).toThrow('INCEPTION_API_KEY');
    expect(() => liveAgentClient(plain!, {})).toThrow('OPENROUTER_API_KEY');
    expect(liveAgentClient(inception!, { INCEPTION_API_KEY: 'sk-test-not-a-real-key' }).model).toBe('mercury-3');
    const ctx = turnOf('hold-request', 0).ctx;
    expect(agentRequestOf(inception!).body(ctx)).toMatchObject({ model: 'mercury-3', reasoning_effort: 'instant', realtime: true });
    expect(agentRequestOf(plain!).body(ctx)).not.toHaveProperty('reasoning');
    expect(agentRequestOf(low!).body(ctx)).toMatchObject({ reasoning: { effort: 'low', exclude: true } });
  });
});

describe('warmedUp', () => {
  it('asks a small turn of its own before its first answer, drops it, and keeps what it cost', async () => {
    const asked: AgentContext[] = [];
    const inner = fakeAgent((ctx) => (asked.push(ctx), ctx === WARM_UP_CONTEXT ? { reply: 'Hi.', values: [], action: 'none', fromFacts: false } : labelled(ctx)), { usage: { inputTokens: 200, outputTokens: 5 } });
    const client = warmedUp(inner, { input: 1, output: 2 });
    expect(client.spent).toBeNull();
    const ctx = turnOf('hold-request', 0).ctx;
    await client.answer(ctx, 1000);
    await client.answer(ctx, 1000);
    expect(asked).toEqual([WARM_UP_CONTEXT, ctx, ctx]);
    expect(client.spent).toMatchObject({ requests: 1, usage: { inputTokens: 200, outputTokens: 5 } });
    expect(client.spent!.costUsd).toBeCloseTo(0.00021);
  });
});
