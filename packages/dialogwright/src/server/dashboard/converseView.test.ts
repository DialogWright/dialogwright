import { describe, expect, it } from 'vitest';
import type { ConverseTraceRecord } from '../../converse/trace';
import type { FrameLogLine } from '../frameLog';
import { converseCall, converseRow } from './view.js';

/**
 * A converse call in the console (view.js): its row on the Calls page from its trace (kind 'converse')
 * and its frame log, and its detail: each turn's caller words and line, the tools with their outcomes,
 * the read-back and how it was answered, and the model's time and cost.
 */

const T0 = Date.parse('2026-11-11T15:00:00.000Z');
const ts = (s: number): string => new Date(T0 + s * 1000).toISOString();
const model = (ms: number, costUsd: number | null, extra: Partial<ConverseTraceRecord['model']> = {}): ConverseTraceRecord['model'] => ({ id: 'fake', ms, firstTextMs: ms === 0 ? null : 120, usage: { inputTokens: ms === 0 ? 0 : 200, outputTokens: ms === 0 ? 0 : 20 }, costUsd, ...extra });

const RECORDS: ConverseTraceRecord[] = [
  { v: 3, kind: 'converse', sessionId: 'chat-1', turnIndex: 0, ts: ts(0), said: null, replies: ['Example Visits, how can I help?'], tools: [], model: model(0, null) },
  { v: 3, kind: 'converse', sessionId: 'chat-1', turnIndex: 1, ts: ts(5), said: 'Is there a visit free on Tuesday?', replies: ['Let me look.', 'We have the morning or the afternoon.'], tools: [{ name: 'availability', args: { day: '•' }, outcome: 'ran' }], model: model(900, 0.0004) },
  { v: 3, kind: 'converse', sessionId: 'chat-1', turnIndex: 2, ts: ts(12), said: 'The morning, on this number.', replies: ['A visit Tuesday morning, on ending in 0123. Is that right?'], tools: [{ name: 'book', args: { phone: '…0123' }, outcome: 'readBack' }], readBack: { text: 'A visit Tuesday morning, on ending in 0123. Is that right?' }, model: model(700, 0.0003) },
  { v: 3, kind: 'converse', sessionId: 'chat-1', turnIndex: 3, ts: ts(20), said: 'yes', replies: ['You are booked.'], tools: [{ name: 'book', args: { phone: '…0123' }, outcome: 'confirmed' }], readBack: { text: 'A visit Tuesday morning, on ending in 0123. Is that right?', yes: 0.95, no: 0.05, confirmed: true }, model: model(500, 0.0002) },
  { v: 3, kind: 'converse', sessionId: 'chat-1', turnIndex: 4, ts: ts(30), said: 'Can you also fix a kettle?', replies: ['Sorry, could you say that again?'], tools: [{ name: 'book', args: {}, outcome: 'refused', reason: 'Not run: the call is ending.' }], model: model(6000, null, { error: 'timeout: no answer began within 3000 ms', retried: true }) },
];
const frames = (ended: string | null): FrameLogLine[] => [
  { ts: ts(0), dir: 'in', msg: { type: 'start', v: 1 } },
  ...(ended === null ? [] : [{ ts: ts(31), dir: 'log' as const, msg: { ended } }]),
];

describe('a converse call on the Calls page', () => {
  it('is a chat with its turns, the actions the caller confirmed as its tasks, and the model\'s cost', () => {
    expect(converseRow(RECORDS, frames('closing'))).toEqual({
      callSid: 'chat-1', app: null, from: 'web chat', caller: null, channel: 'chat', provider: null,
      startedAt: T0, lastAt: T0 + 31_000, endedAt: T0 + 31_000, turns: 4,
      task: { form: null, label: null }, step: null, tasks: [{ id: 'book', label: 'book' }],
      status: 'ended', frustrated: false, handoffReason: null, ending: { kind: 'handled', text: 'handled' }, costUsd: 0.0009,
    });
  });

  it('says how it ended: to a person, the person leaving, or still in progress', () => {
    expect(converseRow(RECORDS, frames('handoff'))).toMatchObject({ status: 'with-person', handoffReason: 'handoff', ending: { kind: 'person', reason: 'handoff' } });
    expect(converseRow(RECORDS, frames('caller'))).toMatchObject({ status: 'ended', ending: { kind: 'hangup', text: 'left the chat' } });
    expect(converseRow(RECORDS, frames('idle'))).toMatchObject({ status: 'ended', ending: { kind: 'hangup', text: 'left the chat (idle)' } });
    expect(converseRow(RECORDS, frames(null))).toMatchObject({ status: 'on-track', ending: null, endedAt: null, lastAt: T0 + 30_000 });
  });
});

describe('a converse call\'s detail', () => {
  it('shows each turn: the caller\'s words and the line\'s, the tools with their outcomes, the read-back and the model', () => {
    const view = converseCall(RECORDS);
    expect(view.turns).toHaveLength(5);
    expect(view.turns[0]).toEqual({ index: 0, at: T0, said: null, line: 'Example Visits, how can I help?', tools: [], readBack: null, model: null });
    expect(view.turns[1]).toMatchObject({ said: 'Is there a visit free on Tuesday?', line: 'Let me look. We have the morning or the afternoon.', tools: [{ name: 'availability', outcome: 'ran', args: 'day=•', reason: null }] });
    expect(view.turns[1]!.model).toEqual({ id: 'fake', ms: 900, firstTextMs: 120, tokens: '200 in, 20 out', costUsd: 0.0004, error: null, retried: false });
    expect(view.turns[2]!.readBack).toEqual({ text: 'A visit Tuesday morning, on ending in 0123. Is that right?', answer: 'waiting for the answer' });
    expect(view.turns[3]!.readBack).toEqual({ text: 'A visit Tuesday morning, on ending in 0123. Is that right?', answer: 'confirmed (yes 0.95, no 0.05)' });
    expect(view.turns[3]!.tools).toEqual([{ name: 'book', outcome: 'confirmed', args: 'phone=…0123', reason: null }]);
    expect(view.turns[4]!.tools[0]).toMatchObject({ outcome: 'refused', reason: 'Not run: the call is ending.' });
    expect(view.turns[4]!.model).toMatchObject({ error: 'timeout: no answer began within 3000 ms', retried: true, costUsd: null });
    expect(view.totals).toEqual({ turns: 4, modelMs: 8100, costUsd: 0.0009, models: ['fake'] });
  });

  it('reads only a converse trace\'s records', () => {
    expect(converseCall([{ v: 2, sessionId: 'x' } as unknown as ConverseTraceRecord]).turns).toEqual([]);
  });
});

describe('a converse call\'s detail with journeys', () => {
  const route = (from: string | null, to: string | null, outcome: NonNullable<ConverseTraceRecord['route']>['outcome']): NonNullable<ConverseTraceRecord['route']> => ({ from, to, outcome, task: null, ms: 40 });
  const J: ConverseTraceRecord[] = [
    { v: 3, kind: 'converse', sessionId: 'chat-2', turnIndex: 0, ts: ts(0), said: null, replies: ['Hello.'], tools: [], model: model(0, null) },
    { ...RECORDS[1]!, sessionId: 'chat-2', route: route(null, 'visit', 'start') },
    { ...RECORDS[2]!, sessionId: 'chat-2', route: route('visit', 'visit', 'carry') },
    { ...RECORDS[3]!, sessionId: 'chat-2', journeyEnded: { journey: 'visit', how: 'done' } },
    { ...RECORDS[4]!, sessionId: 'chat-2', turnIndex: 4, route: route('visit', 'note', 'switch') },
  ];

  it('gives each turn its journey, how it was routed, and the journey a confirmed action ended', () => {
    const turns = converseCall(J).turns;
    expect(turns.map((t) => t.journey)).toEqual([null, 'visit', 'visit', 'visit', 'note']);
    expect(turns.map((t) => t.routeOutcome)).toEqual([null, 'start', 'carry', null, 'switch']);
    expect(turns.map((t) => t.journeyEnded)).toEqual([null, null, null, 'visit', null]);
  });

  it('shows a call that starts in a journey in it from its start turn, the route the start turn recorded', () => {
    const started: ConverseTraceRecord[] = [
      { ...J[0]!, sessionId: 'chat-3', route: { from: null, to: 'visit_account', outcome: 'start', task: null, ms: 0 } },
      { ...RECORDS[1]!, sessionId: 'chat-3' },
      { ...RECORDS[2]!, sessionId: 'chat-3', route: route('visit_account', 'visit_account', 'carry') },
    ];
    const turns = converseCall(started).turns;
    expect(turns.map((t) => t.journey)).toEqual(['visit_account', 'visit_account', 'visit_account']);
    expect(turns.map((t) => t.routeOutcome)).toEqual(['start', null, 'carry']);
  });

  it('marks an unclear turn with its count, and a call the line ended by it', () => {
    const unclear: ConverseTraceRecord[] = [
      J[0]!,
      { ...RECORDS[1]!, sessionId: 'chat-2', route: { ...route(null, null, 'root'), unclear: 1, restarted: true } },
      { ...RECORDS[2]!, sessionId: 'chat-2', route: route(null, null, 'root') },
      { ...RECORDS[3]!, sessionId: 'chat-2', turnIndex: 3, route: { ...route(null, null, 'root'), unclear: 3 }, ended: 'unclear' },
    ];
    const turns = converseCall(unclear).turns;
    expect(turns.map((t) => t.unclear)).toEqual([null, 1, null, 3]);
    expect(turns.map((t) => t.endedBy)).toEqual([null, null, null, 'unclear']);
  });

  it('gives no unclear fields on a call without routes', () => {
    for (const t of converseCall(RECORDS).turns) {
      expect(t.unclear).toBeUndefined();
      expect(t.endedBy).toBeUndefined();
    }
  });

  it('leaves a call without routes as it was, with no journey on its turns', () => {
    for (const t of converseCall(RECORDS).turns) expect(t.journey).toBeUndefined();
  });
});

describe('a converse turn that failed in the line', () => {
  it('is shown as a turn, marked failed, chat and call alike; a turn that did not fail is unmarked', () => {
    const records: ConverseTraceRecord[] = [
      { v: 3, kind: 'converse', sessionId: 'c-f', turnIndex: 0, ts: ts(0), said: null, replies: ['Example Visits, how can I help?'], tools: [], model: model(0, null) },
      { v: 3, kind: 'converse', sessionId: 'c-f', turnIndex: 1, ts: ts(4), said: 'yes', replies: ["That's done."], tools: [{ name: 'book', args: {}, outcome: 'confirmed' }], model: model(800, 0.0002), failed: 'internal' },
    ];
    const turns = converseCall(records).turns;
    expect(turns[1]).toMatchObject({ said: 'yes', line: "That's done.", failed: true, tools: [{ name: 'book', outcome: 'confirmed' }] });
    expect(turns[0]).not.toHaveProperty('failed');
  });
});

describe('a converse phone call in the console', () => {
  const CALL: ConverseTraceRecord[] = [
    { v: 3, kind: 'converse', sessionId: 'CA-1', turnIndex: 0, ts: ts(0), said: null, replies: ['Example Visits, how can I help?'], tools: [], model: model(0, null) },
    { v: 3, kind: 'converse', sessionId: 'CA-1', turnIndex: 1, ts: ts(5), said: 'Is there a visit free on Tuesday?', replies: ['We have the morning free.', 'Or the afternoon, if that suits you better.'], tools: [], model: model(1900, 0.0004), bridge: true, heard: { cutIn: false, spokeBefore: false, chars: 31 } },
    { v: 3, kind: 'converse', sessionId: 'CA-1', turnIndex: 2, ts: ts(9), said: 'actually, Monday', replies: ['Monday then.'], tools: [], model: model(400, 0.0001), heard: { cutIn: true, spokeBefore: false, chars: 25 } },
    { v: 3, kind: 'converse', sessionId: 'CA-1', turnIndex: 3, ts: ts(12), said: 'thanks', replies: [], tools: [], model: model(300, 0.0001), interrupted: true, heard: { cutIn: false, spokeBefore: true, chars: null } },
  ];
  const callFrames = (ended: string | null, provider = 'twilio'): FrameLogLine[] => [
    { ts: ts(0), dir: 'in', msg: { type: 'setup', callSid: 'CA-1', from: '...0123', to: '+15555550105' } },
    { ts: ts(0), dir: 'log', msg: { provider } },
    ...(ended === null ? [] : [{ ts: ts(20), dir: 'log' as const, msg: { ended } }]),
  ];

  it('is a call on its carrier, ended as a call ends', () => {
    expect(converseRow(CALL, callFrames('closing'))).toMatchObject({ callSid: 'CA-1', channel: 'voice', provider: 'twilio', from: 'unknown', turns: 3, status: 'ended', ending: { kind: 'handled', text: 'handled' } });
    expect(converseRow(CALL, callFrames('handoff', 'telnyx'))).toMatchObject({ channel: 'voice', provider: 'telnyx', status: 'with-person', ending: { kind: 'person', reason: 'handoff' } });
    expect(converseRow(CALL, callFrames('caller'))).toMatchObject({ status: 'ended', ending: { kind: 'hangup', text: 'hung up' } });
    expect(converseRow(CALL, callFrames(null))).toMatchObject({ channel: 'voice', status: 'on-track', ending: null });
  });

  it('shows a cut-in turn\'s heard text, a turn the caller spoke before, a stopped turn and a bridge', () => {
    const turns = converseCall(CALL).turns;
    // A chat's turn is as it was: none of these.
    expect(turns[0]).not.toHaveProperty('heard');
    expect(turns[1]).toMatchObject({ bridge: true, heard: { cutIn: false, spokeBefore: false, chars: 31, text: 'Example Visits, how can I help?' } });
    // What was heard of the line before, as the trace keeps the line: its first characters.
    expect(turns[2]).toMatchObject({ heard: { cutIn: true, spokeBefore: false, chars: 25, text: 'We have the morning free.' } });
    expect(turns[2]).not.toHaveProperty('bridge');
    expect(turns[3]).toMatchObject({ interrupted: true, heard: { cutIn: false, spokeBefore: true, chars: null, text: null } });
  });

  it('shows a read-back said again held (and brief), and the speech over it that was ignored, by its length', () => {
    const turns = converseCall([
      { v: 3, kind: 'converse', sessionId: 'CA-2', turnIndex: 0, ts: ts(0), said: 'wait, what?', replies: ['Tuesday morning, on ending in 0123. Right?'], tools: [{ name: 'book', args: {}, outcome: 'readBack' }], readBack: { text: 'Tuesday morning, on ending in 0123. Right?', held: true, brief: true }, model: model(300, 0.0001) },
      { v: 3, kind: 'converse', sessionId: 'CA-2', turnIndex: 1, ts: ts(9), said: 'yes', replies: ['Booked.'], tools: [], readBack: { text: 'Tuesday morning, on ending in 0123. Right?', held: true, brief: true, yes: 0.95, no: 0.05, confirmed: true }, model: model(300, 0.0001), ignored: [12, 3] },
    ]).turns;
    expect(turns[0]!.readBack).toEqual({ text: 'Tuesday morning, on ending in 0123. Right?', answer: 'waiting for the answer', held: true, brief: true });
    expect(turns[0]).not.toHaveProperty('ignored');
    expect(turns[1]).toMatchObject({ ignored: [12, 3] });
    // A read-back not held is as it was.
    expect(converseCall(CALL).turns.every((t) => t.readBack === null || !Object.hasOwn(t.readBack, 'held'))).toBe(true);
  });
});
