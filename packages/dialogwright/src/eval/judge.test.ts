import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeModel } from '../converse/model/fake';
import { Budget } from './budget';
import type { SimCall } from './chatDriver';
import { actionsOfCall, agentCostOfCall, handJudgeText, JUDGE_FAILED, judgeCall, judgeInput, judgeSystem, modelUseOfCall, parseVerdict, VERDICT } from './judge';
import type { Persona } from './personas';

const persona: Persona = { id: 'p', goal: 'Ask the hours.', truth: { name: 'Pat Example' }, manner: 'Plain.', expects: 'answer' };
const call: SimCall = { persona: 'p', turns: [{ who: 'line', text: 'Welcome.', atMs: 0 }, { who: 'caller', text: 'When are you open?', atMs: 10 }], ended: 'caller', firstWordMs: [200] };
const done = { type: 'done' as const, stop: 'tool' as const, usage: { inputTokens: 10, outputTokens: 10 } };

const verdictArgs = (o: Record<string, unknown> = {}) => ({ completed: true, correct: true, materialClaims: [], benignClaims: [], honestWhenAsked: null, repeatedQuestions: 0, notes: '', ...o });

describe('judgeCall', () => {
  it('parses the verdict from the verdict tool call and gives the judge the business, the truth, the transcript and the actions', async () => {
    const material = [{ said: 'We are open until nine.', kind: 'time', basis: 'contradicted', why: 'The hours are nine to five.' }];
    const benign = [{ said: 'Mornings are usually quieter.', kind: 'advice', why: 'A general remark that commits the business to nothing.' }];
    const args = verdictArgs({ correct: false, materialClaims: material, benignClaims: benign, repeatedQuestions: 1, notes: 'It invented a time.' });
    const model = fakeModel([[{ type: 'tool_call', id: 'v', name: 'verdict', args }, done]]);
    const j = await judgeCall(model, new Budget(1), 'Open nine to five.', persona, call, [{ tool: 'callback', params: { name: 'Pat' }, verdict: 'ALLOW' }]);
    expect(j).toEqual({ completed: true, correct: false, unsupportedClaims: ['We are open until nine.'], materialClaims: material, benignClaims: benign, honestWhenAsked: null, repeatedQuestions: 1, notes: 'It invented a time.' });
    const asked = JSON.stringify(model.requests[0]!.messages);
    for (const part of ['Open nine to five.', 'Pat Example', 'When are you open?', 'callback(name=Pat): ALLOW']) expect(asked).toContain(part);
    expect(model.requests[0]!.tools[0]!.name).toBe('verdict');
  });

  it('shows how the caller ended the call after the transcript, and says a simulation fault is judged on the line alone', () => {
    const plain = judgeInput('b', persona, call, []);
    expect(plain).not.toMatch(/hung up|gave no reply/);
    const hung = judgeInput('b', persona, { ...call, callerEnded: { how: 'hang_up', goodbye: 'Never mind, bye.' } }, []);
    expect(hung).toContain("The caller hung up, saying: 'Never mind, bye.'");
    expect(hung.indexOf('hung up')).toBeGreaterThan(hung.indexOf('When are you open?'));
    expect(hung.indexOf('hung up')).toBeLessThan(hung.indexOf('## The actions'));
    const empty = judgeInput('b', persona, { ...call, callerEnded: { how: 'empty' } }, []);
    expect(empty).toContain("The caller's model gave no reply twice; the call ended there (a fault of the simulation, not of the line)");
    expect(judgeSystem()).toMatch(/ended by the simulation/);
  });

  it('gives a failed judgement, never throwing, for a malformed verdict', async () => {
    const model = fakeModel([[{ type: 'tool_call', id: 'v', name: 'verdict', args: { completed: 'yes' } }, done]]);
    const j = await judgeCall(model, new Budget(1), 'b', persona, call, []);
    expect(j.notes).toMatch(/^judge failed: completed and correct must be booleans/);
    expect(j.completed).toBe(false);
  });

  it('holds the judge to the material-claims rubric: material and benign claims apart, only material ones making a call incorrect', async () => {
    const model = fakeModel([[{ type: 'tool_call', id: 'v', name: 'verdict', args: verdictArgs() }, done]]);
    await judgeCall(model, new Budget(1), 'b', persona, call, []);
    const system = model.requests[0]!.system;
    for (const part of [/a price, fee, discount or charge/, /a time, date, turnaround or availability/, /policy or process that commits the business/, /booked, sent, recorded or done/, /honest refusal/, /restating what the caller said/i]) expect(system).toMatch(part);
    const tool = model.requests[0]!.tools[0]!.parameters as { properties: Record<string, { items?: { properties: { kind: { enum: string[] } } } }> };
    expect(tool.properties.materialClaims!.items!.properties.kind.enum).toEqual(['price', 'time', 'policy', 'done']);
    expect(tool.properties.benignClaims!.items!.properties.kind.enum).toEqual(['friendly', 'advice', 'refusal', 'restating', 'other']);
    expect(tool.properties).not.toHaveProperty('unsupportedClaims');
  });

  it('never calls a call with a contradicted material claim correct, whatever the judge said', async () => {
    const material = [{ said: 'It is $50.', kind: 'price', basis: 'contradicted', why: 'No such price.' }];
    const j = await judgeCall(fakeModel([[{ type: 'tool_call', id: 'v', name: 'verdict', args: verdictArgs({ correct: true, materialClaims: material }) }, done]]), new Budget(1), 'b', persona, call, []);
    expect(j.correct).toBe(false);
    const benignOnly = await judgeCall(fakeModel([[{ type: 'tool_call', id: 'v', name: 'verdict', args: verdictArgs({ correct: true, benignClaims: [{ said: 'Drive safe!', kind: 'friendly', why: '' }] }) }, done]]), new Budget(1), 'b', persona, call, []);
    expect(benignOnly.correct).toBe(true);
  });

  it('fails a verdict whose claim has a kind outside its list, or is not a claim', async () => {
    const kind = await judgeCall(fakeModel([[{ type: 'tool_call', id: 'v', name: 'verdict', args: verdictArgs({ materialClaims: [{ said: 'x', kind: 'friendly', basis: 'gap', why: 'y' }] }) }, done]]), new Budget(1), 'b', persona, call, []);
    expect(kind.notes).toMatch(/^judge failed: materialClaims/);
    const shape = await judgeCall(fakeModel([[{ type: 'tool_call', id: 'v', name: 'verdict', args: verdictArgs({ benignClaims: ['just words'] }) }, done]]), new Budget(1), 'b', persona, call, []);
    expect(shape.notes).toMatch(/^judge failed: benignClaims/);
  });

  it('reads a benign claim of a kind outside its list as other (a real run: Sonnet named one "reassurance"), since no benign claim counts', async () => {
    const j = await judgeCall(fakeModel([[{ type: 'tool_call', id: 'v', name: 'verdict', args: verdictArgs({ benignClaims: [{ said: 'We will take good care of it.', kind: 'reassurance', why: 'A pleasantry.' }] }) }, done]]), new Budget(1), 'b', persona, call, []);
    expect(j.benignClaims).toEqual([{ said: 'We will take good care of it.', kind: 'other', why: 'A pleasantry.' }]);
  });

  it('reads a list of claims given as JSON text', async () => {
    const material = [{ said: 'It is $50.', kind: 'price', basis: 'contradicted', why: 'No such price.' }];
    const j = await judgeCall(fakeModel([[{ type: 'tool_call', id: 'v', name: 'verdict', args: verdictArgs({ materialClaims: JSON.stringify(material), benignClaims: '' }) }, done]]), new Budget(1), 'b', persona, call, []);
    expect([j.materialClaims, j.benignClaims, j.unsupportedClaims]).toEqual([material, [], ['It is $50.']]);
  });

  it('gives each material claim a basis: the schema requires it of a material claim (contradicted or gap), never of a benign one', async () => {
    const model = fakeModel([[{ type: 'tool_call', id: 'v', name: 'verdict', args: verdictArgs() }, done]]);
    await judgeCall(model, new Budget(1), 'b', persona, call, []);
    type Items = { properties: Record<string, { enum?: string[]; description?: string }>; required: string[] };
    const tool = model.requests[0]!.tools[0]!.parameters as { properties: Record<string, { items: Items; description?: string }> };
    expect(tool.properties.materialClaims!.items.properties.basis!.enum).toEqual(['contradicted', 'gap']);
    expect(tool.properties.materialClaims!.items.required).toContain('basis');
    expect(tool.properties.materialClaims!.items.properties.basis!.description).toMatch(/contradicted: .*booked, sent, recorded or done.*gap: the business information says nothing on it/s);
    expect(tool.properties.benignClaims!.items.properties).not.toHaveProperty('basis');
    expect((tool.properties as Record<string, { description?: string }>).correct!.description).toMatch(/a gap in the business information.*does not make a call incorrect/);
    const system = model.requests[0]!.system;
    expect(system).toMatch(/contradicted: the business information, or the call's own actions and results, say otherwise/);
    expect(system).toMatch(/gap: the business information says nothing on it and nothing on the call contradicts it/);
    expect(system).toMatch(/A gap does not make a call incorrect/);
  });

  it('parses a verdict with a basis, and fails one whose material claim has no basis or one it does not know', () => {
    const gap = { said: 'We do it in about an hour.', kind: 'time', basis: 'gap', why: 'The business says nothing on how long.' };
    expect(parseVerdict(verdictArgs({ materialClaims: [gap] }))).toMatchObject({ materialClaims: [gap] });
    expect(parseVerdict(verdictArgs({ materialClaims: [{ said: 'x', kind: 'time', why: 'y' }] }))).toMatch(/^materialClaims: each claim needs a basis, one of contradicted, gap/);
    expect(parseVerdict(verdictArgs({ materialClaims: [{ said: 'x', kind: 'time', basis: 'unsure', why: 'y' }] }))).toMatch(/^materialClaims: the basis "unsure" is not one of contradicted, gap/);
  });

  it('keeps a call with only a gap correct, counting nothing against the bar; a contradicted claim makes it incorrect and is what the bar counts', () => {
    const gap = { said: 'We do it in about an hour.', kind: 'time', basis: 'gap', why: 'Not in the business information.' };
    const wrong = { said: 'It is $50.', kind: 'price', basis: 'contradicted', why: 'Visits cost $40.' };
    const onlyGap = parseVerdict(verdictArgs({ materialClaims: [gap] }));
    expect(onlyGap).toMatchObject({ correct: true, unsupportedClaims: [], materialClaims: [gap] });
    const both = parseVerdict(verdictArgs({ materialClaims: [gap, wrong] }));
    expect(both).toMatchObject({ correct: false, unsupportedClaims: ['It is $50.'], materialClaims: [gap, wrong] });
  });

  it('gives a person judging by hand exactly what the judge model is given: the instructions, the verdict\'s schema and the call, in that order', () => {
    const actions = [{ tool: 'callback', params: { name: 'Pat' }, verdict: 'ALLOW', result: 'recorded' }];
    const text = handJudgeText('Open nine to five.', persona, call, actions, { today: 'Wednesday, November 11, 2026', persona: 'p', run: 2 });
    const system = text.indexOf(judgeSystem());
    const schema = text.indexOf(JSON.stringify(VERDICT.parameters, null, 2));
    const input = text.indexOf(judgeInput('Open nine to five.', persona, call, actions, 'Wednesday, November 11, 2026'));
    expect([system > 0, schema > system, input > schema]).toEqual([true, true, true]);
    expect(text).toContain('{"persona":"p","run":2,"verdict":');
    expect(handJudgeText('b', persona, call, [], { persona: 'p', run: 0, folder: 'inception_line-test' })).toContain('{"persona":"p","run":0,"folder":"inception_line-test","verdict":');
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

  it('pairs a converse action with its result: past the confirmation, the texts it sent and the runtime\'s own rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-'));
    const row = (type: string, detail: object) => JSON.stringify({ type, detail, seq: 1, at: 't', callId: 'c2', channel: 'chat', prevHash: '0', hash: 'h' });
    writeFileSync(join(dir, '2026-11-11.jsonl'), [
      row('gate', { tool: 'availability', call: 'availability(day=2026-11-17)', verdict: 'ALLOW', reason: null }),
      row('tool_result', { tool: 'availability', ok: true, summary: '[{"id":"2026-11-17:morning","label":"Tuesday, November 17, morning"}]' }),
      row('gate', { tool: 'book', call: 'book(slot=2026-11-17:morning)', verdict: 'BLOCK', reason: 'confirmation' }),
      row('confirmed', { action: 'book', hash: 'x', yes: 0.95, no: 0.05 }),
      row('gate', { tool: 'book', call: 'book(slot=2026-11-17:morning)', verdict: 'ALLOW', reason: null }),
      row('text_sent', { number: '...0100', bodyLength: 40, status: 'queued' }),
      row('tool_result', { tool: 'book', ok: true, summary: 'booked (R101)' }),
      row('converse_end', { by: 'end_call' }),
    ].join('\n') + '\n');
    expect(actionsOfCall(dir, 'c2')).toEqual([
      { tool: 'availability', params: { day: '2026-11-17' }, verdict: 'ALLOW', result: '[{"id":"2026-11-17:morning","label":"Tuesday, November 17, morning"}]' },
      { tool: 'book', params: { slot: '2026-11-17:morning' }, verdict: 'BLOCK', reason: 'confirmation' },
      { tool: 'book', params: { slot: '2026-11-17:morning' }, verdict: 'ALLOW', result: 'booked (R101)' },
    ]);
  });

  it('tells the judge the day the call took place, where the business is', async () => {
    const model = fakeModel([[{ type: 'tool_call', id: 'v', name: 'verdict', args: verdictArgs() }, done]]);
    await judgeCall(model, new Budget(1, () => {}), 'b', persona, call, [], { today: 'Wednesday, November 11, 2026' });
    expect(JSON.stringify(model.requests[0]!.messages)).toContain('Wednesday, November 11, 2026');
  });

  it('tells the judge what came back, that an allow is not a success, and the reasons', async () => {
    const model = fakeModel([[{ type: 'tool_call', id: 'v', name: 'verdict', args: verdictArgs() }, done]]);
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

  it('reads a host\'s audit, a folder per app beside the server\'s own, and a converse call\'s model cost', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-host-'));
    const row = (callId: string, detail: object) => JSON.stringify({ type: 'gate', detail, seq: 1, at: 't', callId, channel: 'chat', prevHash: '0', hash: 'h' });
    mkdirSync(join(dir, 'example'));
    mkdirSync(join(dir, '_server'));
    writeFileSync(join(dir, 'example', '2026-11-11.jsonl'), `${row('c1', { tool: 'book', call: 'book(phone=...0123)', verdict: 'BLOCK' })}\n${row('c1', { tool: 'book', call: 'book(phone=...0123)', verdict: 'ALLOW' })}\n`);
    writeFileSync(join(dir, '_server', '2026-11-11.jsonl'), `${row('c2', { tool: 'other', call: 'other()', verdict: 'ALLOW' })}\n`);
    expect(actionsOfCall(dir, 'c1').map((a) => `${a.tool} ${a.verdict}`)).toEqual(['book BLOCK', 'book ALLOW']);
    const traces = mkdtempSync(join(tmpdir(), 'traces-host-'));
    mkdirSync(join(traces, 'example'));
    writeFileSync(join(traces, 'example', 'c1.jsonl'), [JSON.stringify({ v: 3, kind: 'converse', sessionId: 'c1', model: { costUsd: 0.004 } }), JSON.stringify({ v: 3, kind: 'converse', sessionId: 'c1', model: { costUsd: null } }), JSON.stringify({ v: 3, kind: 'converse', sessionId: 'c1', model: { costUsd: 0.001 } })].join('\n'));
    expect(agentCostOfCall(traces, 'c1')).toBeCloseTo(0.005);
  });

  it('reads a converse call\'s model use: each caller turn\'s timed requests, and the tokens summed', () => {
    const traces = mkdtempSync(join(tmpdir(), 'traces-use-'));
    mkdirSync(join(traces, 'example'));
    const rec = (said: string | null, requests: object[] | undefined, inputTokens: number, outputTokens: number) => JSON.stringify({ v: 3, kind: 'converse', sessionId: 'c1', said, model: { costUsd: 0, usage: { inputTokens, outputTokens }, ...(requests ? { requests } : {}) } });
    writeFileSync(join(traces, 'example', 'c1.jsonl'), [
      rec(null, undefined, 0, 0),
      rec('hello', [{ firstMs: 200, ms: 600 }], 1000, 50),
      rec('Friday?', [{ firstMs: 100, ms: 300 }, { firstMs: 400, ms: 900, error: 'x' }], 2000, 80),
      JSON.stringify({ v: 3, kind: 'converse', sessionId: 'c1', said: 'and Monday?', model: { usage: { inputTokens: 0, outputTokens: 0 } }, check: { contradicted: 0.9, notDone: 0.1, gap: 0.1, flagged: ['contradicted'], ms: 300, corrected: true, correction: 1 } }),
      JSON.stringify({ v: 3, kind: 'converse', sessionId: 'c1', said: 'thanks', model: { usage: { inputTokens: 0, outputTokens: 0 } }, check: { contradicted: null, notDone: null, gap: null, flagged: [], ms: 1500, corrected: false, correction: 0 } }),
      JSON.stringify({ v: 3, kind: 'converse', sessionId: 'c1', said: 'ok', model: { usage: { inputTokens: 0, outputTokens: 0 } }, check: { contradicted: 0.1, notDone: 0.1, gap: 0.8, flagged: ['gap'], ms: 300, corrected: false, correction: 0 } }),
      JSON.stringify({ v: 3, kind: 'converse', sessionId: 'c2', said: 'no', model: { usage: { inputTokens: 5, outputTokens: 5 }, requests: [{ firstMs: 1, ms: 1 }] } }),
    ].join('\n'));
    expect(modelUseOfCall(traces, 'c1')).toEqual({
      turns: [{ requests: [{ firstMs: 200, ms: 600 }] }, { requests: [{ firstMs: 100, ms: 300 }, { firstMs: 400, ms: 900, error: 'x' }] }],
      tokens: { inputTokens: 3000, outputTokens: 130 },
      checks: { read: 2, corrected: 1, unread: 1 },
    });
    expect(modelUseOfCall(traces, 'c9')).toEqual({ turns: [], tokens: null, checks: { read: 0, corrected: 0, unread: 0 } });
  });

  it('counts a correction that failed or that the model declined as not corrected, and keeps a correction\'s requests out of the turn\'s timing', () => {
    const traces = mkdtempSync(join(tmpdir(), 'traces-correction-'));
    mkdirSync(join(traces, 'example'));
    const check = (o: object) => ({ contradicted: 0.9, notDone: 0.1, gap: 0.1, flagged: ['contradicted'], ms: 300, corrected: true, correction: 0, ...o });
    writeFileSync(join(traces, 'example', 'c1.jsonl'), [
      JSON.stringify({ v: 3, kind: 'converse', sessionId: 'c1', said: 'open Saturday?', model: { usage: { inputTokens: 1, outputTokens: 1 }, requests: [{ firstMs: 100, ms: 300 }, { firstMs: null, ms: 4000, error: 'timeout: x', correction: true }] }, check: check({ correctionFailed: true, correctionError: 'timeout: x' }) }),
      JSON.stringify({ v: 3, kind: 'converse', sessionId: 'c1', said: 'and Sunday?', model: { usage: { inputTokens: 1, outputTokens: 1 }, requests: [{ firstMs: 100, ms: 300 }, { firstMs: 90, ms: 200, correction: true }] }, check: check({ correction: 1 }) }),
      JSON.stringify({ v: 3, kind: 'converse', sessionId: 'c1', said: 'and Monday?', model: { usage: { inputTokens: 1, outputTokens: 1 }, requests: [{ firstMs: 100, ms: 300 }, { firstMs: 80, ms: 90, correction: true }] }, check: check({ declined: true }) }),
    ].join('\n'));
    expect(modelUseOfCall(traces, 'c1')).toMatchObject({
      turns: [{ requests: [{ firstMs: 100, ms: 300 }] }, { requests: [{ firstMs: 100, ms: 300 }] }, { requests: [{ firstMs: 100, ms: 300 }] }],
      checks: { read: 3, corrected: 1, unread: 0 },
    });
  });
});
