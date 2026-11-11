import { describe, expect, it } from 'vitest';
import type { JevClient, JevRequest, JevResponse } from '../jev/types';
import { agentBusinessProblems } from './business/load';
import type { AgentBusiness } from './business/schema';
import { businessText } from './business/text';
import { actionsOfCall, CHECK_NOTE_MARK, checkNote, CLAIM_QUESTIONS, claimsState, readClaims } from './claims';
import { newConverseState, type ConverseState } from './state';

/**
 * The check after speaking (docs/designs/2026-11-11-claims-check.md): agent.yaml's settings, the state the
 * decision model is sent (the business, today, the call's actions with what came back, the reply as said),
 * its three questions, a reading it could not give, and the note the agent model is sent.
 */

const BUSINESS = `business:
  name: Example Menders
  about: We mend small household items at our counter.
  hours: Weekdays, 9 to 5.
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
actions:
  check_availability:
    about: List the free windows on a day.
    kind: lookup
    params:
      day: { type: date, about: The day. }
  leave_note:
    about: Leave a note for the counter.
    kind: change
    params:
      note: { type: text, about: The note. }
    readBack:
      en: "A note saying {note}. Is that right?"
`;

const parsed = (text: string) => agentBusinessProblems(text);
function business(extra = ''): AgentBusiness {
  const { value, problems } = parsed(BUSINESS + extra);
  if (!value) throw new Error(problems.map((p) => `${p.path} ${p.message}`).join('\n'));
  return value;
}

describe('agent.yaml checks.claims', () => {
  it('defaults to correcting, with both bars at 0.7, when the file says nothing', () => {
    expect(business().checks).toEqual({ claims: { mode: 'correct', correctAt: 0.7, gapAt: 0.7 } });
  });

  it('takes a mode and bars of its own, the rest defaulted', () => {
    expect(business('checks:\n  claims: { mode: record, correctAt: 0.8 }\n').checks.claims).toEqual({ mode: 'record', correctAt: 0.8, gapAt: 0.7 });
    expect(business('checks:\n  claims: { mode: "off" }\n').checks.claims.mode).toBe('off');
    expect(business('checks:\n  claims: { gapAt: 1 }\n').checks.claims.gapAt).toBe(1);
  });

  it('refuses a bar out of (0, 1] and a mode it does not know', () => {
    for (const bad of ['correctAt: 0', 'correctAt: 1.2', 'gapAt: -0.1', 'mode: hold']) {
      const { value, problems } = parsed(`${BUSINESS}checks:\n  claims: { ${bad} }\n`);
      expect(value, bad).toBeUndefined();
      expect(problems.some((p) => p.path.startsWith('checks.claims')), bad).toBe(true);
    }
  });
});

/** A call with a lookup that returned, a change refused, and a change read back and waiting for the caller's yes. */
function callSoFar(): ConverseState {
  const st = newConverseState({ appId: 'menders', callId: 'call-1', channel: 'chat' });
  st.messages = [
    { role: 'assistant', content: [{ type: 'text', text: 'Example Menders, how can I help?' }] },
    { role: 'user', content: [{ type: 'text', text: 'Is Friday free? Leave a note that I am coming.' }] },
    { role: 'assistant', content: [{ type: 'tool_call', id: 'c1', name: 'check_availability', args: { day: '2026-11-13' } }] },
    { role: 'user', content: [{ type: 'tool_result', id: 'c1', content: '[{"id":"2026-11-13:morning","label":"by noon"}]' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Friday morning is free.' }, { type: 'tool_call', id: 'c2', name: 'leave_note', args: { note: 'coming' } }, { type: 'tool_call', id: 'c3', name: 'leave_note', args: { note: 'again' } }] },
    { role: 'user', content: [{ type: 'tool_result', id: 'c3', content: 'Not run: one confirmation at a time.', isError: true }] },
  ];
  st.pending = { action: 'leave_note', params: { note: 'coming' }, hash: 'h', text: 'A note saying coming. Is that right?', id: 'c2' };
  return st;
}

describe('the call\'s actions, from the conversation', () => {
  it('lists each call in order with what came back, an error as one, and a read-back waiting for the caller\'s yes as such', () => {
    expect(actionsOfCall(callSoFar())).toEqual([
      { action: 'check_availability', args: { day: '2026-11-13' }, result: '[{"id":"2026-11-13:morning","label":"by noon"}]' },
      { action: 'leave_note', args: { note: 'coming' }, result: 'Not done yet: read back to the caller ("A note saying coming. Is that right?"), waiting for their yes.' },
      { action: 'leave_note', args: { note: 'again' }, result: 'Not run: one confirmation at a time.', error: true },
    ]);
  });

  it('says a call with no result is not done', () => {
    const st = callSoFar();
    st.pending = null;
    expect(actionsOfCall(st)[1]).toEqual({ action: 'leave_note', args: { note: 'coming' }, result: 'Not done: no result came back.' });
  });

  it('is empty for a call with no actions', () => {
    expect(actionsOfCall(newConverseState({ appId: 'menders', callId: 'call-1', channel: 'chat' }))).toEqual([]);
  });
});

describe('the state the decision model is sent', () => {
  it('holds the business information, the business\'s day, the call\'s actions and the reply as said, and nothing of the caller\'s number', () => {
    const b = business();
    const st = callSoFar();
    st.caller = { number: '+15555550142', account: null };
    const state = claimsState(b, st, '2026-11-11', 'Friday morning is free, and your note is left.');
    expect(state).toEqual({
      business: businessText(b),
      today: 'Wednesday, November 11, 2026 (2026-11-11)',
      actions: actionsOfCall(st),
      reply: 'Friday morning is free, and your note is left.',
    });
    expect(JSON.stringify(state)).not.toContain('5555550142');
  });
});

const response = (answers: Record<string, number>): JevResponse => ({
  answers: Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, { type: 'noul', noul: v }])),
  model: 'fake',
  usage: { inputTokens: 1, outputTokens: 1, estimated: true },
  latencyMs: 1,
  source: 'jev',
});

function fakeJev(answer: (req: JevRequest) => Promise<JevResponse>): JevClient & { asked: JevRequest[] } {
  const asked: JevRequest[] = [];
  return { asked, ask: (req) => (asked.push(req), answer(req)) };
}

describe('readClaims', () => {
  const state = claimsState(business(), callSoFar(), '2026-11-11', 'Your note is left.');

  it('asks one request, the three questions over the state, and reads each as a probability', async () => {
    const jev = fakeJev(async () => response({ contradicted: 0.2, notDone: 0.9, gap: 0.1 }));
    expect(await readClaims(jev, state, 1500)).toEqual({ contradicted: 0.2, notDone: 0.9, gap: 0.1 });
    expect(jev.asked).toHaveLength(1);
    expect(jev.asked[0]!.state).toEqual(state);
    expect(jev.asked[0]!.questions).toBe(CLAIM_QUESTIONS);
    expect(Object.keys(CLAIM_QUESTIONS)).toEqual(['contradicted', 'notDone', 'gap']);
    for (const q of Object.values(CLAIM_QUESTIONS)) expect(q.type).toBe('noul');
    expect(jev.asked[0]!.timeoutMs).toBe(1500);
  });

  it('is null when the model errs, gives no answer to one, or one that is not a probability', async () => {
    expect(await readClaims(fakeJev(async () => { throw new Error('down'); }), state, 1500)).toBeNull();
    expect(await readClaims(fakeJev(async () => response({ contradicted: 0.2, notDone: 0.1 })), state, 1500)).toBeNull();
    expect(await readClaims(fakeJev(async () => response({ contradicted: 1.2, notDone: 0.1, gap: 0.1 })), state, 1500)).toBeNull();
  });

  it('is null when the model does not answer in time, and the request is aborted', async () => {
    const jev = fakeJev(() => new Promise<JevResponse>(() => {}));
    expect(await readClaims(jev, state, 20)).toBeNull();
    expect(jev.asked[0]!.signal?.aborted).toBe(true);
  });
});

describe('the note the agent model is sent', () => {
  it('is marked as the line\'s own check, never the caller\'s words, with the reply as said and what was read, in plain words', () => {
    const note = checkNote('We are open Saturdays.', { contradicted: 0.9, notDone: 0.1, gap: 0.1 }, 0.7);
    expect(note.startsWith(CHECK_NOTE_MARK)).toBe(true);
    expect(note).toContain('not the caller');
    expect(note).toContain('"We are open Saturdays."');
    expect(note).toContain('the business information or what the call\'s actions returned');
    expect(note).not.toContain('was done');
    const both = checkNote('Your note is left.', { contradicted: 0.8, notDone: 0.9, gap: 0.1 }, 0.7);
    expect(both).toContain('the business information or what the call\'s actions returned');
    expect(both).toContain('done that the call\'s actions do not show as done');
  });
});
