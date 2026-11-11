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
      item: { type: choice, options: [lamp, kettle, clock], about: The item. }
    readBack:
      en: "Tell the counter about the {item}."
    audit: { item: keep }
  callback:
    about: Ask the counter to call the caller back.
    kind: change
    params:
      phone: { type: phone, about: The number to call back. }
    readBack:
      en: "A call back to {phone}. Is that right?"
    audit: { phone: last4 }
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
  calledBack: string[];
  jev: ReturnType<typeof fakeJev>;
  out: Out;
  run(s: ConverseState, input: Input): Promise<ConverseState>;
}

function harness(turns: ModelEvent[][], o: { reading?: { yes: number; no: number }; edit?: (t: string) => string; model?: ConverseModel; tools?: ConverseDeps['tools'] } = {}): Harness {
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
  const calledBack: string[] = [];
  const jev = fakeJev(o.reading ?? { yes: 0.95, no: 0.05 });
  const out: Out = {
    say: (t, f) => {
      // Out's contract: never an empty piece.
      if (t.trim() === '') throw new Error(`an empty piece was said (final ${f})`);
      said.push([t, f]);
    },
    end: (how) => void ended.push(how),
  };
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
      callback: async (p) => {
        calledBack.push(p.phone!);
        return 'queued';
      },
      ...o.tools,
    },
    texts: null,
    now: () => NOW,
    trace: (r) => void traces.push(r),
    jevTimeoutMs: 1000,
  };
  return { deps, model, rows, said, ended, traces, calendar, notified, calledBack, jev, out, run: (s, input) => converseTurn(s, input, deps, out) };
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
    // notify only follows book (its `then`): the model is never offered it.
    expect(req.tools.map((t) => t.name)).toEqual(['check_availability', 'book', 'callback', 'leave_note', 'end_call']);
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

    const kinds = h.rows.map((r) => (r.type === 'gate' ? `gate ${r.detail.tool} ${r.detail.verdict}` : `${r.type} ${String(r.detail.action ?? r.detail.tool ?? '')}`.trim()));
    expect(kinds).toEqual([
      'gate check_availability ALLOW',
      'tool_result check_availability',
      'gate book BLOCK',
      'confirmed book',
      'gate book ALLOW',
      'tool_result book',
      'confirmed notify',
      'gate notify ALLOW',
      'tool_result notify',
    ]);
    const bookHash = confirmationHash({ slot: SLOT, item: 'lamp' }, confirmedFields(h.deps.business.actions.book!));
    expect(h.rows[3]!.detail).toMatchObject({ action: 'book', hash: bookHash, yes: 0.95, no: 0.05 });
    // The follow-on's row names the parent's confirmation, and carries its own hash over the params it took.
    expect(h.rows[6]!.detail).toMatchObject({ action: 'notify', parent: 'book', parentHash: bookHash, hash: confirmationHash({ item: 'lamp' }, ['item']) });
    // Each action's result is recorded beside its gate row, what the model was sent, the call's masked values masked.
    expect(h.rows[1]!.detail).toMatchObject({ tool: 'check_availability', ok: true });
    // The lookup's day is recorded masked (agent.yaml names no audit for it), so its result is recorded with the day masked too.
    expect(String(h.rows[1]!.detail.summary)).toContain('"id":"•:morning"');
    expect(String(h.rows[1]!.detail.summary)).not.toContain(FRIDAY);
    expect(h.rows[5]!.detail).toMatchObject({ tool: 'book', ok: true });
    expect(h.rows[8]!.detail).toEqual({ tool: 'notify', ok: true, summary: 'noted' });
    // The slot is recorded masked (agent.yaml says nothing of it), the item as it is.
    expect(h.rows[2]!.detail.call).toBe('book(slot=•, item=lamp)');

    expect(h.traces.map((t) => t.tools.map((x) => `${x.name}:${x.outcome}`))).toEqual([[], ['check_availability:ran', 'book:readBack'], ['book:confirmed', 'notify:ran']]);
    // The trace keeps what was said with the masked slot masked, as said (its label) and as sent (its id).
    const MASKED = 'A visit •, for the lamp. Is that right?';
    expect(h.traces[1]!.readBack).toEqual({ text: MASKED });
    expect(h.traces[1]!.replies).toEqual(['Friday morning is free.', MASKED]);
    expect(h.traces[2]!.readBack).toEqual({ text: MASKED, yes: 0.95, no: 0.05, confirmed: true });
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
    expect(lastMessage(h)).toContain('Not done: nothing was changed, booked or sent. The caller did not confirm');
    expect(lastMessage(h)).toContain('yes but make it the afternoon');
    expect(h.rows.map((r) => r.type)).not.toContain('confirmed');
    expect(h.traces.at(-1)!.tools).toEqual([{ name: 'book', args: { slot: '•', item: 'lamp' }, outcome: 'notConfirmed' }]);
    expect(h.traces.at(-1)!.readBack).toEqual({ text: 'A visit •, for the lamp. Is that right?', yes: 0.9, no: 0.6, confirmed: false });
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

describe('converseTurn: after the yes', () => {
  it('needs a fresh read-back for a change the model calls again once it ran', async () => {
    const h = harness([...lookupThenBook, [call('c3', 'book', { slot: SLOT, item: 'lamp' }), done('tool')]]);
    let s = await upToReadBack(h);
    s = await h.run(s, { kind: 'text', text: 'yes' });
    expect(h.calendar.bookings).toHaveLength(1);
    expect(s.pending).toMatchObject({ action: 'book', id: 'c3' });
    expect(h.said.at(-1)).toEqual([READ_BACK, true]);
    expect(h.rows.filter((r) => r.type === 'gate' && r.detail.tool === 'book').map((r) => r.detail.verdict)).toEqual(['BLOCK', 'ALLOW', 'BLOCK']);
  });

  it('answers a read-back kept through a save and a restore (JSON) as it would have', async () => {
    const h = harness([...lookupThenBook, [text('Booked.'), done()]]);
    const s = await upToReadBack(h);
    const restored = JSON.parse(JSON.stringify(s)) as ConverseState;
    const after = await h.run(restored, { kind: 'text', text: 'yes' });
    expect(after.pending).toBeNull();
    expect(h.calendar.bookings).toHaveLength(1);
    expect(h.calendar.bookings[0]!.key).toBe(idempotencyKey('call-1', 'book', { slot: SLOT, item: 'lamp' }));
  });

  it('says the done line where the reply after a confirmed action fails, rather than asking again', async () => {
    const h = harness([...lookupThenBook, [timeout], [timeout]]);
    let s = await upToReadBack(h);
    s = await h.run(s, { kind: 'text', text: 'yes' });
    expect(h.calendar.bookings).toHaveLength(1);
    expect(h.said.at(-1)).toEqual(["That's done.", true]);
    expect(h.said.map(([t]) => t)).not.toContain('Sorry, could you say that again?');
    expect(s.failures).toBe(1);
    expect(s.messages.at(-1)).toEqual({ role: 'assistant', content: [{ type: 'text', text: "That's done." }] });
  });

  it('says the done line before the handoff line where the failure spends the budget', async () => {
    const h = harness([...lookupThenBook, [timeout], [timeout]], { edit: (t) => t.replace('failuresPerCall: 2', 'failuresPerCall: 1').replace('  handoff: { en: "Let me get a person to call you back." }', '  handoff: { en: "Let me get a person to call you back." }\n  done: { en: "All set." }') });
    let s = await upToReadBack(h);
    s = await h.run(s, { kind: 'text', text: 'yes' });
    expect(h.said.slice(-2)).toEqual([['All set.', false], ['Let me get a person to call you back.', true]]);
    expect(h.ended).toEqual(['handoff']);
  });

  it('traces an action that throws once allowed as failed: a lookup, a confirmed change and a follow-on', async () => {
    const h = harness([
      [call('c1', 'check_availability', { day: FRIDAY }), done('tool')],
      [call('c2', 'check_availability', { day: FRIDAY }), done('tool')],
      [call('c3', 'book', { slot: SLOT, item: 'lamp' }), done('tool')],
      [text('Sorry about that.'), done()],
    ], {
      tools: {
        check_availability: (() => {
          let n = 0;
          return async () => {
            if (n++ === 0) throw new Error('down for a moment');
            return [{ id: SLOT, label: 'by noon' }];
          };
        })(),
        notify: async () => {
          throw new Error('no answer');
        },
      },
    });
    let s = await upToReadBack(h);
    expect(h.traces.at(-1)!.tools.map((t) => `${t.name}:${t.outcome}`)).toEqual(['check_availability:failed', 'check_availability:ran', 'book:readBack']);
    s = await h.run(s, { kind: 'text', text: 'yes' });
    expect(h.traces.at(-1)!.tools.map((t) => `${t.name}:${t.outcome}`)).toEqual(['book:confirmed', 'notify:failed']);
    expect(h.traces.at(-1)!.tools[1]!.reason).toBe('no answer');

    const throwing = harness([...lookupThenBook, [text('Sorry.'), done()]], { tools: { book: async () => { throw new Error('the window just filled'); } } });
    s = await upToReadBack(throwing);
    s = await throwing.run(s, { kind: 'text', text: 'yes' });
    expect(throwing.traces.at(-1)!.tools.map((t) => `${t.name}:${t.outcome}`)).toEqual(['book:failed']);
    expect(throwing.notified).toEqual([]);
    expect(JSON.stringify(throwing.model.requests.at(-1)!.messages.at(-1))).toContain('"isError":true');
  });
});

describe('converseTurn: the caller\'s number', () => {
  it('takes "caller" for the number calling, reads back its last four, gives the tool the whole number, and never tells the model', async () => {
    const h = harness([[call('c1', 'callback', { phone: 'caller' }), done('tool')], [text('We will call you back.'), done()]]);
    let s = await h.run(fresh(), { kind: 'start' });
    s = await h.run(s, { kind: 'text', text: 'please call me back on this number' });
    expect(h.said.at(-1)).toEqual(['A call back to the number you\'re calling from, ending in 0142. Is that right?', true]);
    s = await h.run(s, { kind: 'text', text: 'yes' });
    expect(h.calledBack).toEqual([CALLER_NUMBER]);
    for (const req of h.model.requests) expect(JSON.stringify(req)).not.toContain('5555550142');
    expect(h.rows.find((r) => r.type === 'gate')!.detail.call).toBe('callback(phone=...0142)');
    expect(systemPrompt(h.deps.business, s, NOW)).toContain('"caller"');
  });

  it('reads a number the caller gave back whole, and keeps it out of the trace and the audit', async () => {
    const h = harness([[call('c1', 'callback', { phone: '555 555 0177' }), done('tool')], [text('We will call you back.'), done()]]);
    let s = await h.run(fresh(), { kind: 'start' });
    s = await h.run(s, { kind: 'text', text: 'call me back on 555 555 0177' });
    expect(h.said.at(-1)).toEqual(['A call back to 555 555 0177. Is that right?', true]);
    await h.run(s, { kind: 'text', text: 'yes' });
    expect(h.calledBack).toEqual(['+15555550177']);
    const recorded = JSON.stringify({ traces: h.traces.map((t) => ({ replies: t.replies, readBack: t.readBack, tools: t.tools })), rows: h.rows });
    expect(recorded).not.toContain('555 555 0177');
    expect(recorded).not.toContain('5555550177');
  });

  it('refuses "caller" on a chat with no number, saying to ask for one', async () => {
    const h = harness([[call('c1', 'callback', { phone: 'caller' }), done('tool')], [text('What number should we call?'), done()]]);
    const chat = newConverseState({ appId: 'menders', callId: 'chat-1', channel: 'chat' });
    await h.run(chat, { kind: 'text', text: 'call me back' });
    expect(JSON.stringify(h.model.requests[1]!.messages.at(-1))).toMatch(/not known on this call; ask the caller/);
    expect(h.traces[0]!.tools.map((t) => t.outcome)).toEqual(['invalid']);
  });
});

describe('converseTurn: the app\'s settings', () => {
  it('gives an action\'s code the app\'s settings as ctx.env, and none where the deps name none', async () => {
    const seen: (string | undefined)[] = [];
    const tools = { leave_note: async (_p: Record<string, string>, ctx: { env: (name: string) => string | undefined }) => (seen.push(ctx.env('NOTE_DESK')), 'left') };
    const script = (): ModelEvent[][] => [[call('c1', 'leave_note', { note: 'the lamp' }), done('tool')], [text('Done.'), done()]];
    const h = harness(script(), { tools });
    h.deps.env = (name) => (name === 'NOTE_DESK' ? 'desk-2' : undefined);
    let s = await h.run(fresh(), { kind: 'start' });
    s = await h.run(s, { kind: 'text', text: 'leave a note about the lamp' });
    await h.run(s, { kind: 'text', text: 'yes' });
    const bare = harness(script(), { tools });
    delete bare.deps.env;
    s = await bare.run(fresh(), { kind: 'start' });
    s = await bare.run(s, { kind: 'text', text: 'leave a note about the lamp' });
    await bare.run(s, { kind: 'text', text: 'yes' });
    expect(seen).toEqual(['desk-2', undefined]);
  });
});

describe('converseTurn: ending the call', () => {
  it('says the closing line once when the model calls end_call, records it and ends', async () => {
    const h = harness([[text('Glad to help.'), call('c1', 'end_call', {}), done('tool')]]);
    const s = await h.run(fresh(), { kind: 'text', text: 'that is all, thanks' });
    expect(h.said).toEqual([['Glad to help.', false], ['Thanks for calling. Goodbye.', true]]);
    expect(h.ended).toEqual(['closing']);
    expect(s.ended).toBe('closing');
    expect(h.rows).toEqual([{ type: 'converse_end', detail: { by: 'end_call' } }]);
    expect(h.model.requests).toHaveLength(1);
    expect(h.traces[0]!.tools).toEqual([{ name: 'end_call', args: {}, outcome: 'ran' }]);
    // An ended call takes no more turns.
    expect(await h.run(s, { kind: 'text', text: 'wait' })).toBe(s);
  });

  it('refuses end_call while a read-back waits for the caller\'s answer (one confirmation at a time), counting no refusal', async () => {
    const h = harness([
      [call('c1', 'check_availability', { day: FRIDAY }), done('tool')],
      [call('c2', 'book', { slot: SLOT, item: 'lamp' }), call('c3', 'end_call', {}), call('c4', 'check_availability', { day: FRIDAY }), done('tool')],
    ]);
    const s = await upToReadBack(h);
    expect(s.pending).toMatchObject({ action: 'book' });
    expect(s.ended).toBeUndefined();
    expect(h.ended).toEqual([]);
    expect(h.said.at(-1)).toEqual([READ_BACK, true]);
    expect(h.traces.at(-1)!.tools.map((t) => `${t.name}:${t.outcome}`)).toEqual(['check_availability:ran', 'book:readBack', 'end_call:refused', 'check_availability:refused']);
    // Only a change counts toward its refusals.
    expect(s.refusals).toEqual({});
  });
});

describe('converseTurn: Out', () => {
  it('ends a reply whose text ends in a space with its last sentence as the final piece, never an empty one', async () => {
    const h = harness([[text('Sure. '), done()]]);
    await h.run(fresh(), { kind: 'text', text: 'hi' });
    expect(h.said).toEqual([['Sure. ', true]]);
  });
});

describe('converseTurn: refusals', () => {
  it('refuses a call to an action that only follows another (its `then`), which the model is never offered: nothing is read back or run', async () => {
    const h = harness([[call('c1', 'notify', { item: 'lamp' }), done('tool')], [text('Let me book it instead.'), done()]]);
    let s = await h.run(fresh(), { kind: 'start' });
    s = await h.run(s, { kind: 'text', text: 'tell them about my lamp' });
    expect(h.notified).toEqual([]);
    expect(s.pending).toBeNull();
    expect(h.rows.filter((r) => r.type === 'gate')).toEqual([]);
    expect(JSON.stringify(h.model.requests[1]!.messages.at(-1))).toMatch(/runs only after book/);
    expect(h.traces.at(-1)!.tools).toMatchObject([{ name: 'notify', outcome: 'refused' }]);
  });

  it('sends the gate\'s refusal back as an error, counts it, and past the limit says to offer a person', async () => {
    const h = harness([
      [call('c1', 'leave_note', { note: 'the lamp' }), done('tool')],
      [call('c2', 'leave_note', { note: 'the kettle' }), done('tool')],
      [text('I can not do that.'), done()],
    ], { edit: (t) => t.replace('    readBack:\n      en: "A note saying', '    rules:\n      - oneOf: { field: note, values: [the clock], reason: not-offered }\n    readBack:\n      en: "A note saying') });
    let s = await h.run(fresh(), { kind: 'start' });
    s = await h.run(s, { kind: 'text', text: 'tell them about my lamp' });
    expect(s.refusals).toEqual({ leave_note: 2 });
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

  it('takes a reply cut off at the token limit as a failure: its unfinished words are never said, and it is asked once more', async () => {
    const cut: ModelEvent = { type: 'done', stop: 'length', usage: { inputTokens: 100, outputTokens: 400 } };
    const h = harness([[text('We have the morning and the aftern'), cut], [text('We have the morning.'), done()]]);
    await h.run(fresh(), { kind: 'text', text: 'what is free?' });
    expect(h.said).toEqual([['We have the morning.', true]]);
    expect(h.traces[0]!.model).toMatchObject({ retried: true, error: expect.stringMatching(/^length: /) });
    const spoke = harness([[text('Sure. We have the morning and the aftern'), cut], [text('Never asked.'), done()]]);
    const s = await spoke.run(fresh(), { kind: 'text', text: 'what is free?' });
    expect(spoke.said).toEqual([['Sure. ', false], ['Sorry, could you say that again?', true]]);
    expect(s.failures).toBe(1);
  });

  it('asks the model at agent.yaml\'s effort, and at none where it names none', async () => {
    const h = harness([[text('Hello.'), done()]], { edit: (t) => t.replace('  default: anthropic:claude-haiku-5-5', '  default: anthropic:claude-haiku-5-5\n  effort: minimal') });
    await h.run(fresh(), { kind: 'text', text: 'hi' });
    expect(h.model.requests[0]).toMatchObject({ effort: 'minimal' });
    const bare = harness([[text('Hello.'), done()]]);
    await bare.run(fresh(), { kind: 'text', text: 'hi' });
    expect(bare.model.requests[0]).not.toHaveProperty('effort');
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

  it('stops a model that has not begun within half its time, and asks once more with the time left', async () => {
    const asked: AbortSignal[] = [];
    let n = 0;
    const slowFirst: ConverseModel = {
      id: 'slow-first',
      async *stream(_req, signal) {
        asked.push(signal);
        if (n++ === 0) {
          // Never answers: only the runtime's own abort ends it.
          await new Promise((resolve) => signal.addEventListener('abort', resolve));
          return;
        }
        yield text('Hello there.');
        yield done();
      },
    };
    const h = harness([], { model: slowFirst, edit: (t) => t.replace('  default: anthropic:claude-haiku-5-5', '  default: anthropic:claude-haiku-5-5\n  timeoutMs: 1000') });
    const started = Date.now();
    const s = await h.run(fresh(), { kind: 'text', text: 'hi' });
    expect(asked).toHaveLength(2);
    expect(asked[0]!.aborted).toBe(true);
    expect(h.said).toEqual([['Hello there.', true]]);
    expect(s.failures).toBe(0);
    expect(h.traces[0]!.model).toMatchObject({ retried: true });
    expect(h.traces[0]!.model.error).toMatch(/no answer began within 500 ms/);
    // Half the time and the second answer: never the whole of it.
    expect(Date.now() - started).toBeLessThan(900);
  });

  it('gives up on a model that never answers, after asking it twice within its time', async () => {
    const asked: AbortSignal[] = [];
    const silent: ConverseModel = {
      id: 'silent',
      async *stream(_req, signal) {
        asked.push(signal);
        await new Promise((resolve) => signal.addEventListener('abort', resolve));
      },
    };
    const h = harness([], { model: silent, edit: (t) => t.replace('  default: anthropic:claude-haiku-5-5', '  default: anthropic:claude-haiku-5-5\n  timeoutMs: 60') });
    const started = Date.now();
    const s = await h.run(fresh(), { kind: 'text', text: 'hi' });
    expect(asked).toHaveLength(2);
    expect(asked.every((a) => a.aborted)).toBe(true);
    expect(h.said).toEqual([['Sorry, could you say that again?', true]]);
    expect(s.failures).toBe(1);
    expect(h.traces[0]!.model.error).toMatch(/timeout/);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('bounds a model that trickles its answer by its time, not only by the gap between words', async () => {
    const trickle: ConverseModel = {
      id: 'trickle',
      async *stream(_req, signal) {
        while (!signal.aborted) {
          yield text('word ');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      },
    };
    const h = harness([], { model: trickle, edit: (t) => t.replace('  default: anthropic:claude-haiku-5-5', '  default: anthropic:claude-haiku-5-5\n  timeoutMs: 80') });
    const started = Date.now();
    const s = await h.run(fresh(), { kind: 'text', text: 'hi' });
    expect(h.said).toEqual([['Sorry, could you say that again?', true]]);
    expect(s.failures).toBe(1);
    expect(h.traces[0]!.model.error).toMatch(/not done within/);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('keeps each request\'s time in the trace: to its first event and to its end, and how it failed', async () => {
    let n = 0;
    const slow: ConverseModel = {
      id: 'slow',
      async *stream(_req, signal) {
        if (n++ === 0) {
          await new Promise((resolve) => signal.addEventListener('abort', resolve));
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 40));
        yield text('Hello there.');
        await new Promise((resolve) => setTimeout(resolve, 30));
        yield done();
      },
    };
    const h = harness([], { model: slow, edit: (t) => t.replace('  default: anthropic:claude-haiku-5-5', '  default: anthropic:claude-haiku-5-5\n  timeoutMs: 200') });
    await h.run(fresh(), { kind: 'text', text: 'hi' });
    const [stalled, answered] = h.traces[0]!.model.requests!;
    expect(stalled).toMatchObject({ firstMs: null, error: expect.stringMatching(/^timeout: no answer began/) });
    expect(stalled!.ms).toBeGreaterThanOrEqual(90);
    expect(answered!.error).toBeUndefined();
    expect(answered!.firstMs).toBeGreaterThanOrEqual(35);
    expect(answered!.ms).toBeGreaterThanOrEqual(answered!.firstMs! + 25);
    expect(h.traces[0]!.model.requests).toHaveLength(2);
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
    expect(prompt).toMatch(/Never say that something was booked, sent, changed or done unless an action's result on this call says it was done/);
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
