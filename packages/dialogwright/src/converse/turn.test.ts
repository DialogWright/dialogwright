import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AuditSink } from '../audit/sink';
import type { AuditDraft } from '../audit/types';
import { confirmationHash } from '../gate/lines';
import type { JevClient, JevRequest } from '../jev/types';
import { idempotencyKey } from './actions';
import { agentBusinessProblems } from './business/load';
import type { AgentBusiness } from './business/schema';
import { CALLER, NO_LOOKUPS, confirmedFields, policyOf } from './policy';
import { fakeModel } from './model/fake';
import type { ConverseModel, ModelEvent } from './model/types';
import { systemPrompt } from './prompt';
import { fakeCalendar } from './sources/calendar';
import { businessZone, newConverseState, type ConverseState } from './state';
import type { ConverseTraceRecord } from './trace';
import { confirmedHashFor, converseTurn, MAX_ROUNDS, type ConverseDeps, type Input, type Out } from './turn';

/**
 * The conversation loop: the model's replies streamed in sentences, its calls checked and put to the
 * gate, a change read back by the line and run only after the caller's yes (with its follow-ons), and
 * the model's failures met by one more try, the recovery line and, past the budget, a person.
 */

const BUSINESS = `# yaml-language-server: $schema=../../../schemas/agent.schema.json
business:
  name: Example Menders
  about: We mend small household items at our counter.
  hours: Weekdays, 9 to 5.
  timezone: America/New_York
services:
  - name: mending
    about: One item looked at and mended.
    price: { from: 40, to: 90, per: item }
  - name: estimate
    about: A look at an item and a price for the work.
    price: { from: 10, to: 15, per: visit }
priceCaveat:
  en: The final price is confirmed once the item has been seen.
persona:
  style: Calm and brief.
lines:
  greeting: { en: "Example Menders, how can I help?" }
  closing: { en: "Thanks for calling. Goodbye." }
  recovery: { en: "Sorry, could you say that again?" }
  handoff: { en: "Let me get a person to call you back." }
model:
  default: anthropic:claude-haiku-5-5
limits: { failuresPerCall: 2, refusalsPerAction: 2 }
actions:
  check_availability:
    about: List the free windows on a day.
    kind: lookup
    params:
      day: { type: date, about: The day. }
  book:
    about: Book a visit into a free window.
    kind: change
    params:
      slot: { type: slot, from: check_availability, about: A window the lookup returned. }
      item: { type: choice, options: [lamp, kettle, clock], about: The item to mend. }
    readBack:
      en: "A visit {slot}, for the {item}. Is that right?"
    then: [notify]
    audit: { item: keep }
  notify:
    about: Tell the counter about a visit.
    kind: change
    params:
      item: { type: text, about: The item. }
    readBack:
      en: "Tell the counter about the {item}."
    audit: { item: keep }
  leave_note:
    about: Leave a note for the counter.
    kind: change
    params:
      note: { type: text, about: The note. }
    readBack:
      en: "A note saying {note}. Is that right?"
`;

function business(edit: (t: string) => string = (t) => t): AgentBusiness {
  const { value, problems } = agentBusinessProblems(edit(BUSINESS));
  if (!value) throw new Error(problems.map((p) => `${p.path} ${p.message}`).join('\n'));
  return value;
}

const NOW = new Date('2026-11-11T15:00:00Z'); // a Wednesday, 10 a.m. in the business's zone
const FRIDAY = '2026-11-13';
const SLOT = `${FRIDAY}:morning`;
const CALLER_NUMBER = '+15555550142';

const text = (delta: string): ModelEvent => ({ type: 'text', delta });
const call = (id: string, name: string, args: Record<string, unknown>): ModelEvent => ({ type: 'tool_call', id, name, args });
const done = (stop: 'end' | 'tool' = 'end'): ModelEvent => ({ type: 'done', stop, usage: { inputTokens: 100, outputTokens: 10 } });
const timeout: ModelEvent = { type: 'error', kind: 'timeout', detail: 'no answer in time' };

/** A decision model that reads every answer as `reading`, keeping what it was asked. */
function fakeJev(reading: { yes: number; no: number }): JevClient & { asked: JevRequest[] } {
  const asked: JevRequest[] = [];
  return {
    asked,
    async ask(req) {
      asked.push(req);
      return {
        answers: { confirmsYes: { type: 'noul', noul: reading.yes }, confirmsNo: { type: 'noul', noul: reading.no } },
        model: 'fake',
        usage: { inputTokens: 0, outputTokens: 0, estimated: true },
        latencyMs: 1,
        source: 'jev',
      };
    },
  };
}

interface Harness {
  deps: ConverseDeps;
  model: ConverseModel & { requests: { messages: unknown[] }[] };
  rows: AuditDraft[];
  said: [string, boolean][];
  ended: string[];
  traces: ConverseTraceRecord[];
  calendar: ReturnType<typeof fakeCalendar>;
  notified: Record<string, string>[];
  jev: ReturnType<typeof fakeJev>;
  out: Out;
  run(s: ConverseState, input: Input): Promise<ConverseState>;
}

function harness(turns: ModelEvent[][], o: { reading?: { yes: number; no: number }; edit?: (t: string) => string; model?: ConverseModel } = {}): Harness {
  const b = business(o.edit);
  const model = (o.model ?? fakeModel(turns)) as Harness['model'];
  const calendar = fakeCalendar({ days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'], windows: [{ name: 'morning', label: 'by noon', capacity: 1 }, { name: 'afternoon', label: 'by five', capacity: 1 }], now: () => NOW, timeZone: businessZone(b) });
  const rows: AuditDraft[] = [];
  const audit: AuditSink = {
    append(callId, channel, d) {
      rows.push(d);
      return { ...d, seq: rows.length, at: NOW.toISOString(), callId, channel, prevHash: '', hash: '' };
    },
  };
  const said: [string, boolean][] = [];
  const ended: string[] = [];
  const traces: ConverseTraceRecord[] = [];
  const notified: Record<string, string>[] = [];
  const jev = fakeJev(o.reading ?? { yes: 0.95, no: 0.05 });
  const out: Out = { say: (t, f) => void said.push([t, f]), end: (how) => void ended.push(how) };
  const deps: ConverseDeps = {
    business: b,
    model,
    jev,
    policy: policyOf(b),
    audit,
    tools: {
      check_availability: async (p) => calendar.free(p.day!),
      book: async (p, ctx) => calendar.book(p.slot!, { item: p.item! }, ctx.key),
      notify: async (p) => {
        notified.push(p);
        return 'noted';
      },
      leave_note: async () => 'left',
    },
    texts: null,
    now: () => NOW,
    trace: (r) => void traces.push(r),
    jevTimeoutMs: 1000,
  };
  return { deps, model, rows, said, ended, traces, calendar, notified, jev, out, run: (s, input) => converseTurn(s, input, deps, out) };
}

const fresh = (): ConverseState => newConverseState({ appId: 'menders', callId: 'call-1', channel: 'voice', callerNumber: CALLER_NUMBER, account: null });

/** The last message of the model's latest request, as JSON. */
const lastMessage = (h: Harness): string => JSON.stringify(h.model.requests.at(-1)!.messages.at(-1));

const READ_BACK = 'A visit Friday, November 13, by noon, for the lamp. Is that right?';

/** A call up to the read-back of a visit: the greeting, then the caller's request, a lookup and the booking called. */
async function upToReadBack(h: Harness): Promise<ConverseState> {
  let s = await h.run(fresh(), { kind: 'start' });
  s = await h.run(s, { kind: 'text', text: 'Can I bring my lamp in Friday morning?' });
  return s;
}

const lookupThenBook: ModelEvent[][] = [
  [call('c1', 'check_availability', { day: FRIDAY }), done('tool')],
  [text('Friday morning is free.'), call('c2', 'book', { slot: SLOT, item: 'lamp' }), done('tool')],
];

describe('converseTurn: the start', () => {
  it('says the greeting word for word and keeps it as the line\'s', async () => {
    const h = harness([]);
    const s = await h.run(fresh(), { kind: 'start' });
    expect(h.said).toEqual([['Example Menders, how can I help?', true]]);
    expect(s.messages).toEqual([{ role: 'assistant', content: [{ type: 'text', text: 'Example Menders, how can I help?' }] }]);
    expect(h.model.requests).toHaveLength(0);
    expect(h.traces).toHaveLength(1);
    expect(h.traces[0]).toMatchObject({ v: 3, kind: 'converse', sessionId: 'call-1', turnIndex: 0, said: null, replies: ['Example Menders, how can I help?'] });
    expect(s.turnIndex).toBe(1);
  });
});

describe('the model\'s request', () => {
  it('opens with a note that the call is connected where the line spoke first, so it starts with the caller\'s side', async () => {
    const h = harness([[text('Sure.'), done()]]);
    let s = await h.run(fresh(), { kind: 'start' });
    s = await h.run(s, { kind: 'text', text: 'hi' });
    const req = h.model.requests[0] as unknown as { messages: { role: string; content: { type: string; text?: string }[] }[]; tools: { name: string }[]; maxTokens: number };
    expect(req.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(req.messages[0]!.content).toEqual([{ type: 'text', text: '[The call is connected.]' }]);
    expect(s.messages.map((m) => m.role)).toEqual(['assistant', 'user', 'assistant']);
    expect(req.tools.map((t) => t.name)).toEqual(['check_availability', 'book', 'notify', 'leave_note']);
    expect(req.maxTokens).toBe(400);
  });
});

describe('converseTurn: a booking', () => {
  it('looks up, reads back, and on the yes books once with the idempotency key and runs the follow-on', async () => {
    const h = harness([...lookupThenBook, [text('You are booked for Friday morning.'), done()]]);
    let s = await upToReadBack(h);
    expect(h.said.slice(1)).toEqual([['Friday morning is free.', false], [READ_BACK, true]]);
    expect(s.pending).toMatchObject({ action: 'book', params: { slot: SLOT, item: 'lamp' }, text: READ_BACK, id: 'c2' });
    expect(h.calendar.bookings).toHaveLength(0);
    // The lookup's result went back to the model as the tool's result.
    expect(JSON.stringify(h.model.requests[1]!.messages.at(-1))).toContain(`"tool_result"`);
    expect(JSON.stringify(h.model.requests[1]!.messages.at(-1))).toContain(SLOT);

    s = await h.run(s, { kind: 'text', text: 'yes, that is right' });
    expect(h.jev.asked[0]!.state).toEqual({ readBack: READ_BACK, said: 'yes, that is right' });
    expect(s.pending).toBeNull();
    expect(h.calendar.bookings).toHaveLength(1);
    expect(h.calendar.bookings[0]!.key).toBe(idempotencyKey('call-1', 'book', { slot: SLOT, item: 'lamp' }));
    expect(h.notified).toEqual([{ item: 'lamp' }]);
    expect(lastMessage(h)).toContain('The caller confirmed; done');
    expect(h.said.at(-1)).toEqual(['You are booked for Friday morning.', true]);

    const kinds = h.rows.map((r) => (r.type === 'gate' ? `gate ${r.detail.tool} ${r.detail.verdict}` : `${r.type} ${String(r.detail.action ?? '')}`.trim()));
    expect(kinds).toEqual([
      'gate check_availability ALLOW',
      'gate book BLOCK',
      'confirmed book',
      'gate book ALLOW',
      'confirmed notify',
      'gate notify ALLOW',
    ]);
    const bookHash = confirmationHash({ slot: SLOT, item: 'lamp' }, confirmedFields(h.deps.business.actions.book!));
    expect(h.rows[2]!.detail).toMatchObject({ action: 'book', hash: bookHash, yes: 0.95, no: 0.05 });
    // The follow-on's row names the parent's confirmation, and carries its own hash over the params it took.
    expect(h.rows[4]!.detail).toMatchObject({ action: 'notify', parent: 'book', parentHash: bookHash, hash: confirmationHash({ item: 'lamp' }, ['item']) });
    // The slot is recorded masked (agent.yaml says nothing of it), the item as it is.
    expect(h.rows[1]!.detail.call).toBe('book(slot=•, item=lamp)');

    expect(h.traces.map((t) => t.tools.map((x) => `${x.name}:${x.outcome}`))).toEqual([[], ['check_availability:ran', 'book:readBack'], ['book:confirmed', 'notify:ran']]);
    expect(h.traces[1]!.readBack).toEqual({ text: READ_BACK });
    expect(h.traces[2]!.readBack).toEqual({ text: READ_BACK, yes: 0.95, no: 0.05, confirmed: true });
    expect(h.traces[1]!.model.usage).toEqual({ inputTokens: 200, outputTokens: 20 });
    expect(h.traces[1]!.tools[1]!.args).toEqual({ slot: '•', item: 'lamp' });
  });

  it('on a correction at the read-back runs nothing and tells the model what the caller said', async () => {
    const h = harness([...lookupThenBook, [text('Sure, which afternoon?'), done()]], { reading: { yes: 0.9, no: 0.6 } });
    let s = await upToReadBack(h);
    s = await h.run(s, { kind: 'text', text: 'yes but make it the afternoon' });
    expect(h.calendar.bookings).toHaveLength(0);
    expect(h.notified).toEqual([]);
    expect(s.pending).toBeNull();
    expect(lastMessage(h)).toContain('did not confirm');
    expect(lastMessage(h)).toContain('yes but make it the afternoon');
    expect(h.rows.map((r) => r.type)).not.toContain('confirmed');
    expect(h.traces.at(-1)!.tools).toEqual([{ name: 'book', args: { slot: '•', item: 'lamp' }, outcome: 'notConfirmed' }]);
    expect(h.traces.at(-1)!.readBack).toEqual({ text: READ_BACK, yes: 0.9, no: 0.6, confirmed: false });
  });

  it('refuses a slot the lookup never returned, naming the lookup, and reads nothing back', async () => {
    const h = harness([
      [call('c1', 'check_availability', { day: FRIDAY }), done('tool')],
      [call('c2', 'book', { slot: 'x-1', item: 'lamp' }), done('tool')],
      [text('Which of those works?'), done()],
    ]);
    const s = await upToReadBack(h);
    const result = JSON.stringify(h.model.requests[2]!.messages.at(-1));
    expect(result).toContain('"isError":true');
    expect(result).toContain('check_availability');
    expect(s.pending).toBeNull();
    expect(h.said.map(([t]) => t)).not.toContain(READ_BACK);
    expect(h.said.at(-1)).toEqual(['Which of those works?', true]);
    expect(h.traces.at(-1)!.tools.map((t) => t.outcome)).toEqual(['ran', 'invalid']);
    // The slot is recorded masked, in the reason as in the params.
    expect(h.traces.at(-1)!.tools[1]!.args.slot).toBe('•');
    expect(h.traces.at(-1)!.tools[1]!.reason).not.toContain('x-1');
    // An invalid call never reaches the gate.
    expect(h.rows.filter((r) => r.type === 'gate').map((r) => r.detail.tool)).toEqual(['check_availability']);
  });

  it('says the text that came before a read-back first, then the read-back, each once', async () => {
    const h = harness([
      [call('c1', 'check_availability', { day: FRIDAY }), done('tool')],
      [text('Let me check.'), call('c2', 'book', { slot: SLOT, item: 'lamp' }), done('tool')],
    ]);
    await upToReadBack(h);
    expect(h.said.slice(1)).toEqual([['Let me check.', false], [READ_BACK, true]]);
  });

  it('refuses a second change while one is waiting for the caller\'s yes', async () => {
    const h = harness([
      [call('c1', 'check_availability', { day: FRIDAY }), done('tool')],
      [call('c2', 'book', { slot: SLOT, item: 'lamp' }), call('c3', 'leave_note', { note: 'fragile' }), done('tool')],
      [text('Booked.'), done()],
    ]);
    let s = await upToReadBack(h);
    expect(s.pending).toMatchObject({ action: 'book', id: 'c2' });
    expect(h.said.filter(([, f]) => f).map(([t]) => t)).toEqual(['Example Menders, how can I help?', READ_BACK]);
    expect(h.traces.at(-1)!.tools.map((t) => `${t.name}:${t.outcome}`)).toEqual(['check_availability:ran', 'book:readBack', 'leave_note:refused']);
    expect(h.traces.at(-1)!.tools[2]!.reason).toMatch(/one confirmation at a time/);
    expect(s.refusals).toEqual({ leave_note: 1 });
    s = await h.run(s, { kind: 'text', text: 'yes' });
    // Both calls of that round have their results in the message after it: the refusal, then the yes.
    const results = (h.model.requests.at(-1)!.messages.at(-1) as { content: { type: string; id: string; isError?: boolean }[] }).content;
    expect(results.map((c) => [c.id, c.isError === true])).toEqual([['c3', true], ['c2', false]]);
    expect(h.calendar.bookings).toHaveLength(1);
  });

  it('runs nothing when the caller leaves at the read-back, and records that a read-back was waiting', async () => {
    const h = harness(lookupThenBook);
    let s = await upToReadBack(h);
    const asked = h.model.requests.length;
    s = await h.run(s, { kind: 'left' });
    expect(s.pending).toBeNull();
    expect(s.ended).toBe('left');
    expect(h.calendar.bookings).toHaveLength(0);
    expect(h.model.requests).toHaveLength(asked);
    expect(h.rows.at(-1)).toEqual({ type: 'converse_left', detail: { pending: 'book' } });
  });
});

describe('converseTurn: refusals', () => {
  it('sends the gate\'s refusal back as an error, counts it, and past the limit says to offer a person', async () => {
    const h = harness([
      [call('c1', 'notify', { item: 'lamp' }), done('tool')],
      [call('c2', 'notify', { item: 'kettle' }), done('tool')],
      [text('I can not do that.'), done()],
    ], { edit: (t) => t.replace('      item: { type: text, about: The item. }\n    readBack:\n      en: "Tell the counter', '      item: { type: text, about: The item. }\n    rules:\n      - oneOf: { field: item, values: [clock], reason: not-offered }\n    readBack:\n      en: "Tell the counter') });
    let s = await h.run(fresh(), { kind: 'start' });
    s = await h.run(s, { kind: 'text', text: 'tell them about my lamp' });
    expect(s.refusals).toEqual({ notify: 2 });
    const first = JSON.stringify(h.model.requests[1]!.messages.at(-1));
    const second = JSON.stringify(h.model.requests[2]!.messages.at(-1));
    expect(first).toContain('"isError":true');
    expect(first).toContain('not-offered');
    expect(first).not.toContain('offer the caller a person');
    expect(second).toContain('offer the caller a person');
    expect(h.rows.map((r) => `${r.type} ${String(r.detail.verdict)}`)).toEqual(['gate BLOCK', 'gate BLOCK']);
    expect(s.pending).toBeNull();
  });
});

describe('converseTurn: the model\'s failures', () => {
  it('asks once more after a failure with time left, and says the second answer', async () => {
    const h = harness([[timeout], [text('Hello. How can I help?'), done()]]);
    const s = await h.run(fresh(), { kind: 'text', text: 'hi' });
    expect(h.said).toEqual([['Hello. ', false], ['How can I help?', true]]);
    expect(s.failures).toBe(0);
    expect(h.traces[0]!.model).toMatchObject({ retried: true, error: 'timeout: no answer in time' });
  });

  it('drops the unfinished words of a failed answer before asking again', async () => {
    const h = harness([[text('Hel'), timeout], [text('Hello there.'), done()]]);
    await h.run(fresh(), { kind: 'text', text: 'hi' });
    expect(h.said).toEqual([['Hello there.', true]]);
    expect(h.traces[0]!.replies).toEqual(['Hello there.']);
  });

  it('does not ask again once part of the answer was said, and keeps what was said', async () => {
    const h = harness([[text('Sure. Let me'), timeout], [text('Never asked.'), done()]]);
    const s = await h.run(fresh(), { kind: 'text', text: 'hi' });
    expect(h.said).toEqual([['Sure. ', false], ['Sorry, could you say that again?', true]]);
    expect(h.model.requests).toHaveLength(1);
    expect(s.messages.at(-1)).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'Sure.' }, { type: 'text', text: 'Sorry, could you say that again?' }] });
  });

  it('says the recovery line after two failures, and the handoff line once the budget is spent', async () => {
    const h = harness([[timeout], [timeout], [timeout], [timeout]]);
    let s = await h.run(fresh(), { kind: 'text', text: 'hi' });
    expect(h.said).toEqual([['Sorry, could you say that again?', true]]);
    expect(s.failures).toBe(1);
    expect(h.ended).toEqual([]);
    expect(s.messages.at(-1)).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'Sorry, could you say that again?' }] });
    s = await h.run(s, { kind: 'text', text: 'hello?' });
    expect(h.said.at(-1)).toEqual(['Let me get a person to call you back.', true]);
    expect(s.failures).toBe(2);
    expect(s.ended).toBe('handoff');
    expect(h.ended).toEqual(['handoff']);
  });

  it('hands off at once with a budget of one', async () => {
    const h = harness([[timeout], [timeout]], { edit: (t) => t.replace('failuresPerCall: 2', 'failuresPerCall: 1') });
    const s = await h.run(fresh(), { kind: 'text', text: 'hi' });
    expect(h.said).toEqual([['Let me get a person to call you back.', true]]);
    expect(h.ended).toEqual(['handoff']);
    expect(s.ended).toBe('handoff');
  });

  it('gives up on a stream that says nothing within the model\'s time, with no time left to ask again', async () => {
    const asked: AbortSignal[] = [];
    const silent: ConverseModel = {
      id: 'silent',
      async *stream(_req, signal) {
        asked.push(signal);
        await new Promise((resolve) => signal.addEventListener('abort', resolve));
      },
    };
    const h = harness([], { model: silent, edit: (t) => t.replace('  default: anthropic:claude-haiku-5-5', '  default: anthropic:claude-haiku-5-5\n  timeoutMs: 40') });
    const s = await h.run(fresh(), { kind: 'text', text: 'hi' });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.aborted).toBe(true);
    expect(h.said).toEqual([['Sorry, could you say that again?', true]]);
    expect(s.failures).toBe(1);
    expect(h.traces[0]!.model.error).toMatch(/timeout/);
  });

  it('takes an empty reply as a failure', async () => {
    const h = harness([[done()], [done()]]);
    const s = await h.run(fresh(), { kind: 'text', text: 'hi' });
    expect(h.said).toEqual([['Sorry, could you say that again?', true]]);
    expect(s.failures).toBe(1);
  });

  it(`stops after ${MAX_ROUNDS} rounds of calls with the recovery line`, async () => {
    const lookups = Array.from({ length: MAX_ROUNDS }, (_, i) => [call(`c${i}`, 'check_availability', { day: FRIDAY }), done('tool')]);
    const h = harness(lookups);
    const s = await h.run(fresh(), { kind: 'text', text: 'hi' });
    expect(h.model.requests).toHaveLength(MAX_ROUNDS);
    expect(h.said).toEqual([['Sorry, could you say that again?', true]]);
    expect(s.failures).toBe(1);
  });
});

describe('the confirmation a gate call carries', () => {
  it('is the read-back\'s hash only for its own action with exactly its params', () => {
    const b = business((t) => t.replace('      note: { type: text, about: The note. }', '      item: { type: text, about: The item. }').replace('A note saying {note}.', 'A note about the {item}.'));
    const policy = policyOf(b);
    const params = { item: 'lamp' };
    // notify and leave_note now take the same params, so their hashes are the same: the hash is not bound to the action.
    const hash = confirmationHash(params, confirmedFields(b.actions.notify!));
    expect(confirmationHash(params, confirmedFields(b.actions.leave_note!))).toBe(hash);
    const pending = { action: 'notify', params, hash, text: 'Tell the counter about the lamp.', id: 'c1' };
    expect(confirmedHashFor({ tool: 'notify', params }, pending)).toBe(hash);
    expect(confirmedHashFor({ tool: 'leave_note', params }, pending)).toBeNull();
    expect(confirmedHashFor({ tool: 'notify', params: { item: 'clock' } }, pending)).toBeNull();
    expect(confirmedHashFor({ tool: 'notify', params }, null)).toBeNull();
    const facts = (call: { tool: string; params: Record<string, string> }) => ({ attempts: 0, confirmedHash: confirmedHashFor(call, pending), todayIso: '2026-11-11' });
    const other = { tool: 'leave_note', params };
    expect(policy.evaluate(other, CALLER, facts(other), NO_LOOKUPS).verdict).toBe('BLOCK');
    const own = { tool: 'notify', params };
    expect(policy.evaluate(own, CALLER, facts(own), NO_LOOKUPS).verdict).toBe('ALLOW');
  });
});

describe('systemPrompt', () => {
  const b = business();
  const prompt = systemPrompt(b, { ...fresh(), caller: { number: CALLER_NUMBER, account: 'Example Account' } }, NOW);

  it('holds every service price, the caveat, the two rules and the honesty rule', () => {
    expect(prompt).toContain('$40–$90 per item');
    expect(prompt).toContain('$10–$15 per visit');
    expect(prompt).toContain('The final price is confirmed once the item has been seen.');
    expect(prompt).toMatch(/Claim nothing/);
    expect(prompt).toMatch(/Nothing changes without the caller's yes/);
    expect(prompt).toMatch(/automated assistant/);
    expect(prompt).toContain('Calm and brief.');
  });

  it('holds the date and time in the business\'s zone, and the caller', () => {
    expect(prompt).toContain('Wednesday, November 11, 2026');
    expect(prompt).toContain('10:00');
    expect(prompt).toContain('today is 2026-11-11');
    expect(prompt).toContain('Example Account');
    expect(prompt).toContain('ending in 0142');
  });

  it('never holds the caller\'s whole number', () => {
    expect(prompt).not.toContain('5555550142');
    expect(prompt).not.toContain('555-0142');
  });
});

describe('engine vocabulary', () => {
  it('the loop, its prompt and their tests use neutral words', () => {
    const words = ['ca' + 'r', 'whe' + 'el', 'ti' + 're', 'sh' + 'op', 'vehic' + 'le', 'ri' + 'm', 'deal' + 'er'];
    const re = new RegExp(`\\b(?:${words.join('|')})s?\\b`, 'i');
    for (const f of ['turn.ts', 'turn.test.ts', 'prompt.ts', 'state.ts', 'trace.ts', 'app.ts', 'sentences.ts']) {
      const body = readFileSync(new URL(f, import.meta.url), 'utf8');
      expect(re.exec(body)?.[0] ?? null, f).toBeNull();
    }
  });
});
