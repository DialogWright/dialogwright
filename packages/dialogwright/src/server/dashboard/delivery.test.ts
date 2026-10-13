import { describe, expect, it } from 'vitest';
import { deliveriesOf, deliveryFactOf, interruptFact } from './delivery';
import { DELIVERY_NOTES, deliveryNote } from './view.js';
import type { FrameLogLine } from '../frameLog';
import type { DeliveryFact } from './events';

/**
 * Delivery notes: a frame-log line of the adapter's (or the carrier's interrupt) as a fact, and the fact
 * as the sentence the console shows under the line it concerns.
 */

const note = (fact: DeliveryFact | null, held: Record<string, DeliveryFact> = {}) => (fact ? deliveryNote(fact, held) : null);

describe('deliveryFactOf: a frame-log line as a delivery fact', () => {
  it('flattens the kind\'s own fields, keeps a bare value as `value`, and the line\'s other fields beside them', () => {
    expect(deliveryFactOf({ resaid: { heardMs: 640, expectedMs: 9600 } })).toEqual({ kind: 'resaid', heardMs: 640, expectedMs: 9600 });
    expect(deliveryFactOf({ cutAgain: { heardMs: 500, expectedMs: 9600 } })).toEqual({ kind: 'cutAgain', heardMs: 500, expectedMs: 9600 });
    expect(deliveryFactOf({ callerResumed: { pauseMs: 1200, intoReplyMs: 300 } })).toEqual({ kind: 'callerResumed', pauseMs: 1200, intoReplyMs: 300 });
    expect(deliveryFactOf({ joined: 2 })).toEqual({ kind: 'joined', value: 2 });
    expect(deliveryFactOf({ endAfter: 'played', endHeldMs: 2000, expectedMs: 1800 })).toEqual({ kind: 'endAfter', value: 'played', endHeldMs: 2000, expectedMs: 1800 });
  });

  it('is null for a line that is no delivery fact, and for anything not a line', () => {
    expect(deliveryFactOf({ noInputArmedMs: 7000 })).toBeNull();
    expect(deliveryFactOf({ socketClosed: true, ended: false })).toBeNull();
    expect(deliveryFactOf({ type: 'interrupt', durationUntilInterruptMs: 300 })).toBeNull();
    expect(deliveryFactOf(null)).toBeNull();
    expect(deliveryFactOf('resaid')).toBeNull();
    expect(deliveryFactOf([{ resaid: {} }])).toBeNull();
  });

  it('keeps only numbers, booleans, nulls and short codes: never words', () => {
    const fact = deliveryFactOf({ resaid: { heardMs: 640, reason: 'spurious-interrupt', line: 'Your parcel ships Tuesday', nested: { a: 1 }, n: Number.NaN, ok: true, none: null } });
    expect(fact).toEqual({ kind: 'resaid', heardMs: 640, reason: 'spurious-interrupt', ok: true, none: null });
    expect(deliveryFactOf({ joined: 'two words' })).toEqual({ kind: 'joined' });
  });

  it('reads a kind the moment its line is in DELIVERY_NOTES, and not before', () => {
    expect(deliveryFactOf({ lineSkipped: { ms: 800 } })).toBeNull();
    expect(Object.hasOwn(DELIVERY_NOTES, 'lineSkipped')).toBe(false);
    expect(deliveryFactOf({ replyHeld: { ms: 1000, outcome: 'sent', utteranceComplete: 0.3, turn: 4 } })).toEqual({ kind: 'replyHeld', ms: 1000, outcome: 'sent', utteranceComplete: 0.3, turn: 4 });
  });
});

describe('DELIVERY_NOTES: each kind in words, under the line it concerns', () => {
  it('says a line cut short and said again, and one cut short again', () => {
    expect(note(deliveryFactOf({ resaid: { heardMs: 640, expectedMs: 9600 } }))).toEqual({ kind: 'resaid', on: 'agent', text: 'cut off at 0.6 s of about 9.6 s, said again', replaces: [], unsaid: false });
    expect(note(deliveryFactOf({ cutAgain: { heardMs: 500, expectedMs: 9600 } }))?.text).toBe('cut short again at 0.5 s of about 9.6 s, not said a third time');
  });

  it("says a carrier interrupt as the caller's, unless the adapter found it was not: then one note, said again or not", () => {
    expect(note(interruptFact(700))).toEqual({ kind: 'interrupt', on: 'agent', text: 'caller talked over this, 0.7 s in', replaces: [], unsaid: false });
    const spurious = note(deliveryFactOf({ spuriousInterrupt: { afterMs: 1704, quietMs: null } }));
    expect(spurious).toMatchObject({ on: 'agent', text: 'interrupted 1.7 s in with no caller speaking', replaces: ['interrupt'] });
    const again = note(deliveryFactOf({ resaid: { reason: 'spurious-interrupt', afterMs: 1704, expectedMs: 9600 } }));
    expect(again).toMatchObject({ on: 'agent', text: 'interrupted 1.7 s in with no caller speaking, said again', replaces: ['interrupt', 'spuriousInterrupt'] });
  });

  it('says a reply held for the caller to finish, and marks one never said', () => {
    expect(note(deliveryFactOf({ replyHeld: { ms: 1000, outcome: 'sent', utteranceComplete: 0.3, turn: 4 } }))).toMatchObject({ on: 'agent', text: 'reply held 1.0 s for the caller to finish, then said', unsaid: false });
    expect(note(deliveryFactOf({ replyHeld: { ms: 600, outcome: 'joined', utteranceComplete: 0.3, turn: 4 } }))).toMatchObject({ on: 'agent', text: 'not said: the caller went on', unsaid: true });
  });

  it('says how a held end went', () => {
    const end = (value: string) => note(deliveryFactOf({ endAfter: value, endHeldMs: 2000, expectedMs: 1800 }))?.text;
    expect(end('played')).toBe('call end held 2.0 s until it played');
    expect(end('timeout')).toBe('call end held 2.0 s until the time limit');
    expect(end('estimate')).toBe("call end held 2.0 s, the line's estimated length");
    expect(end('closed')).toBe('caller hung up 2.0 s into it');
    expect(note(deliveryFactOf({ endAfter: 'played', endHeldMs: 2000 }))?.on).toBe('agent');
  });

  it('says a join on the caller\'s line, with the pause when the caller came back in', () => {
    const joined = deliveryFactOf({ joined: 2 });
    expect(note(joined)).toMatchObject({ kind: 'joined', on: 'caller', text: 'joined with the previous answer' });
    expect(note(joined, { callerResumed: { kind: 'callerResumed', pauseMs: 1200, intoReplyMs: 300 } })?.text).toBe('joined with the previous answer (paused 1.2 s)');
    // The coming back in is not a note of its own: the join says it.
    expect(note(deliveryFactOf({ callerResumed: { pauseMs: 1200, intoReplyMs: 300 } }))).toBeNull();
  });

  it('names a line for every kind it shows, and shows nothing for a kind it does not know', () => {
    for (const [kind, entry] of Object.entries(DELIVERY_NOTES)) {
      expect([null, 'agent', 'caller'], kind).toContain(entry.on);
      if (entry.on) expect(typeof entry.text, kind).toBe('function');
    }
    expect(deliveryNote({ kind: 'nothing' })).toBeNull();
  });
});

describe('deliveriesOf: a past call\'s facts, read back from its frame log', () => {
  const t = (ms: number) => new Date(Date.UTC(2026, 9, 5, 12, 0, 0) + ms).toISOString();
  const line = (ms: number, dir: FrameLogLine['dir'], msg: unknown): FrameLogLine => ({ ts: t(ms), dir, msg });
  const info = (name: string, value: string) => ({ carrierEvent: { type: 'info', name, value } });

  it('reads each delivery line and each interrupt, in order', () => {
    const frames: FrameLogLine[] = [
      line(0, 'in', { type: 'setup', callSid: 'CA1' }),
      line(100, 'out', { type: 'text', token: 'Hello.', last: true }),
      line(150, 'in', info('agentSpeaking', 'on')),
      // The greeting cut with no caller: the adapter's settle finds it was not theirs, and says it again.
      line(1854, 'in', { type: 'interrupt', utteranceUntilInterrupt: 'Hello', durationUntilInterruptMs: 1704 }),
      line(3854, 'log', { spuriousInterrupt: { afterMs: 1704, quietMs: null } }),
      line(3855, 'log', { resaid: { reason: 'spurious-interrupt', afterMs: 1704, expectedMs: 9600 } }),
      line(4300, 'in', { type: 'interrupt', utteranceUntilInterrupt: 'Hel', durationUntilInterruptMs: 700 }),
      line(4400, 'log', { noInputArmedMs: 7000 }),
      line(4500, 'log', { replyHeld: { ms: 600, outcome: 'joined', utteranceComplete: 0.2, turn: 3 } }),
      line(5000, 'log', { callerResumed: { pauseMs: 1200, intoReplyMs: 300 } }),
      line(5100, 'log', { joined: 2 }),
      line(6000, 'log', { endAfter: 'played', endHeldMs: 2000, expectedMs: 1800 }),
    ];
    const out = deliveriesOf(frames, 'CA1');
    expect(out.every((e) => e.type === 'delivery' && e.callSid === 'CA1')).toBe(true);
    expect(out.map((e) => [e.at - Date.parse(t(0)), e.fact])).toEqual([
      [1854, { kind: 'interrupt', afterMs: 1704 }],
      [3854, { kind: 'spuriousInterrupt', afterMs: 1704, quietMs: null }],
      [3855, { kind: 'resaid', reason: 'spurious-interrupt', afterMs: 1704, expectedMs: 9600 }],
      [4300, { kind: 'interrupt', afterMs: 700 }],
      [4500, { kind: 'replyHeld', ms: 600, outcome: 'joined', utteranceComplete: 0.2, turn: 3 }],
      [5000, { kind: 'callerResumed', pauseMs: 1200, intoReplyMs: 300 }],
      [5100, { kind: 'joined', value: 2 }],
      [6000, { kind: 'endAfter', value: 'played', endHeldMs: 2000, expectedMs: 1800 }],
    ]);
  });

  it('passes over a line with no readable time or no message, and an interrupt with no duration', () => {
    const frames = [
      { ts: 'not a time', dir: 'log', msg: { resaid: { heardMs: 1 } } },
      line(0, 'log', null),
      line(0, 'in', { type: 'interrupt', utteranceUntilInterrupt: 'Hi' }),
    ] as FrameLogLine[];
    expect(deliveriesOf(frames, 'CA1')).toEqual([]);
  });
});
