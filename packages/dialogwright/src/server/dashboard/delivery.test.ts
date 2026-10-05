import { describe, expect, it } from 'vitest';
import { callerHeardAt, deliveriesOf, deliveryFactOf, interruptFact, reportsSpeakers } from './delivery';
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
    // The other branch's held reply, say: no note until its one line is added to the table.
    expect(deliveryFactOf({ replyHeld: { ms: 800, outcome: 'joined' } })).toBeNull();
    expect(Object.hasOwn(DELIVERY_NOTES, 'replyHeld')).toBe(false);
  });
});

describe('DELIVERY_NOTES: each kind in words, under the line it concerns', () => {
  it('says a line cut short and said again, and one cut short again', () => {
    expect(note(deliveryFactOf({ resaid: { heardMs: 640, expectedMs: 9600 } }))).toEqual({ kind: 'resaid', on: 'agent', text: 'cut off at 0.6 s of about 9.6 s, said again' });
    expect(note(deliveryFactOf({ cutAgain: { heardMs: 500, expectedMs: 9600 } }))?.text).toBe('cut short again at 0.5 s of about 9.6 s, not said a third time');
    expect(note(deliveryFactOf({ resaid: { heardMs: 400, reason: 'spurious-interrupt' } }))?.text).toBe('stopped at 0.4 s by an interrupt with no caller speaking, said again');
  });

  it('says a carrier interrupt, with whether the caller was heard', () => {
    expect(note(interruptFact(700, true))).toEqual({ kind: 'interrupt', on: 'agent', text: 'caller talked over this, 0.7 s in' });
    expect(note(interruptFact(700, null))?.text).toBe('caller talked over this, 0.7 s in');
    expect(note(interruptFact(1704, false))?.text).toBe('interrupted 1.7 s in, caller not heard speaking');
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
    expect(note(joined)).toEqual({ kind: 'joined', on: 'caller', text: 'joined with the previous answer' });
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

describe('callerHeardAt: was the caller heard over a line the carrier interrupted', () => {
  const at = 10_000;
  it('heard when speaking, or begun since the line started', () => {
    expect(callerHeardAt({ reported: true, speaking: true, lastStartMs: null }, at, 700)).toBe(true);
    expect(callerHeardAt({ reported: true, speaking: false, lastStartMs: at - 400 }, at, 700)).toBe(true);
  });
  it('not heard on a carrier that reports its speakers; not known on one that does not', () => {
    expect(callerHeardAt({ reported: true, speaking: false, lastStartMs: at - 5000 }, at, 700)).toBe(false);
    expect(callerHeardAt({ reported: false, speaking: false, lastStartMs: null }, at, 700)).toBeNull();
  });
  it('takes the playback and the caller\'s voice as speaker reports, a line played alone not', () => {
    expect(reportsSpeakers({ kind: 'caller', speaking: false })).toBe(true);
    expect(reportsSpeakers({ kind: 'playback', state: 'started' })).toBe(true);
    expect(reportsSpeakers({ kind: 'playback', state: 'finished' })).toBe(true);
    expect(reportsSpeakers({ kind: 'playback', state: 'finished', text: 'Hello.' })).toBe(false);
  });
});

describe('deliveriesOf: a past call\'s facts, read back from its frame log', () => {
  const t = (ms: number) => new Date(Date.UTC(2026, 9, 5, 12, 0, 0) + ms).toISOString();
  const line = (ms: number, dir: FrameLogLine['dir'], msg: unknown): FrameLogLine => ({ ts: t(ms), dir, msg });
  const info = (name: string, value: string) => ({ carrierEvent: { type: 'info', name, value } });

  it('reads each delivery line and each interrupt, in order, with whether the caller was heard', () => {
    const frames: FrameLogLine[] = [
      line(0, 'in', { type: 'setup', callSid: 'CA1' }),
      line(100, 'out', { type: 'text', token: 'Hello.', last: true }),
      line(150, 'in', info('agentSpeaking', 'on')),
      // The greeting interrupted with no caller voice reported at all.
      line(1854, 'in', { type: 'interrupt', utteranceUntilInterrupt: 'Hello', durationUntilInterruptMs: 1704 }),
      line(3000, 'log', { resaid: { heardMs: 640, expectedMs: 9600 } }),
      line(4000, 'in', info('clientSpeaking', 'on')),
      line(4300, 'in', { type: 'interrupt', utteranceUntilInterrupt: 'Hel', durationUntilInterruptMs: 700 }),
      line(4400, 'log', { noInputArmedMs: 7000 }),
      line(5000, 'log', { callerResumed: { pauseMs: 1200, intoReplyMs: 300 } }),
      line(5100, 'log', { joined: 2 }),
      line(6000, 'log', { endAfter: 'played', endHeldMs: 2000, expectedMs: 1800 }),
    ];
    const out = deliveriesOf(frames, 'CA1');
    expect(out.every((e) => e.type === 'delivery' && e.callSid === 'CA1')).toBe(true);
    expect(out.map((e) => [e.at - Date.parse(t(0)), e.fact])).toEqual([
      [1854, { kind: 'interrupt', afterMs: 1704, callerHeard: false }],
      [3000, { kind: 'resaid', heardMs: 640, expectedMs: 9600 }],
      [4300, { kind: 'interrupt', afterMs: 700, callerHeard: true }],
      [5000, { kind: 'callerResumed', pauseMs: 1200, intoReplyMs: 300 }],
      [5100, { kind: 'joined', value: 2 }],
      [6000, { kind: 'endAfter', value: 'played', endHeldMs: 2000, expectedMs: 1800 }],
    ]);
  });

  it('says not known on a carrier that reports no speakers, and forgets the caller speaking at a reconnect', () => {
    const frames: FrameLogLine[] = [
      line(0, 'in', { type: 'interrupt', utteranceUntilInterrupt: 'Hi', durationUntilInterruptMs: 300 }),
      line(100, 'in', info('clientSpeaking', 'on')),
      line(200, 'log', { resumed: true, sessionId: 'VX2' }),
      line(5000, 'in', { type: 'interrupt', utteranceUntilInterrupt: 'Hi', durationUntilInterruptMs: 300 }),
    ];
    expect(deliveriesOf(frames, 'CA1').map((e) => e.fact)).toEqual([
      { kind: 'interrupt', afterMs: 300, callerHeard: null },
      { kind: 'interrupt', afterMs: 300, callerHeard: false },
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
