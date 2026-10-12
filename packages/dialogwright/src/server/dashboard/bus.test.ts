import { describe, expect, it, vi } from 'vitest';
import { DashboardBus, type PublishedEvent } from './bus';
import { maskNumber, type DashboardEvent, type DashboardEventType } from './events';

const started = (callSid: string, at = 1): DashboardEvent => ({ type: 'call_started', callSid, at, from: '…0199', todayIso: '2026-09-21', thresholds: {} });
const dtmf = (callSid: string, digit: string, at = 2): DashboardEvent => ({ type: 'dtmf', callSid, at, digit });

describe('DashboardBus', () => {
  it('fans out to subscribers and numbers events', () => {
    const bus = new DashboardBus();
    const a = vi.fn(); const b = vi.fn();
    bus.subscribe(a); bus.subscribe(b);
    bus.publish(started('CA1'));
    bus.publish(dtmf('CA1', '1'));
    expect(a).toHaveBeenCalledTimes(2);
    expect(b.mock.calls.map((c) => c[0].seq)).toEqual([1, 2]);
  });

  it('replays the history to a late subscriber', () => {
    const bus = new DashboardBus();
    bus.publish(started('CA1'));
    bus.publish(dtmf('CA1', '1'));
    const late = vi.fn();
    bus.subscribe(late);
    expect(late.mock.calls.map((c) => c[0].type)).toEqual(['call_started', 'dtmf']);
  });

  it('keeps every call in progress, each with its own history, in the order published', () => {
    const bus = new DashboardBus();
    bus.publish(started('CA1'));
    bus.publish(dtmf('CA1', '1'));
    bus.publish(started('CA2', 5));
    bus.publish(dtmf('CA1', '2', 6));
    const late = vi.fn();
    bus.subscribe(late);
    expect(late.mock.calls.map((c) => [c[0].type, c[0].callSid, c[0].seq])).toEqual([
      ['call_started', 'CA1', 1], ['dtmf', 'CA1', 2], ['call_started', 'CA2', 3], ['dtmf', 'CA1', 4],
    ]);
    expect(bus.historyOf('CA1').map((e) => e.seq)).toEqual([1, 2, 4]);
    expect(bus.callIds()).toEqual(['CA1', 'CA2']);
    expect(bus.current()).toBe('CA2');
  });

  it('ignores an event for a call it never saw start, and starts a call\'s history over on a second call_started', () => {
    const bus = new DashboardBus();
    bus.publish(dtmf('CA9', '1'));
    expect(bus.history()).toEqual([]);
    bus.publish(started('CA1'));
    bus.publish(dtmf('CA1', '1'));
    bus.publish(started('CA1', 9));
    expect(bus.historyOf('CA1').map((e) => e.type)).toEqual(['call_started']);
  });

  it('keeps the newest calls that ended, up to its bound, and every call in progress', () => {
    const bus = new DashboardBus(2000, 2);
    for (const sid of ['CA1', 'CA2', 'CA3', 'CA4']) {
      bus.publish(started(sid));
      bus.publish({ type: 'ended', callSid: sid, at: 3, reason: 'hangup' });
    }
    bus.publish(started('CA5'));
    expect(bus.callIds()).toEqual(['CA3', 'CA4', 'CA5']);
    expect(bus.hasEnded('CA4')).toBe(true);
    expect(bus.hasEnded('CA5')).toBe(false);
    // A reconnect after the hangup webhook makes the call live again.
    bus.publish({ type: 'reconnect', callSid: 'CA4', at: 4, attempt: 1 });
    expect(bus.hasEnded('CA4')).toBe(false);
  });

  it('bounds the calls it keeps, dropping the oldest that ended first', () => {
    const bus = new DashboardBus(2000, 20, 3);
    bus.publish(started('CA1'));
    bus.publish(started('CA2'));
    bus.publish({ type: 'ended', callSid: 'CA2', at: 3, reason: 'hangup' });
    bus.publish(started('CA3'));
    bus.publish(started('CA4'));
    expect(bus.callIds()).toEqual(['CA1', 'CA3', 'CA4']);
    bus.publish(started('CA5'));
    expect(bus.callIds()).toEqual(['CA3', 'CA4', 'CA5']);
  });

  it('keeps a call ended when a turn finishes after the hangup (one in flight); a reconnect makes it live again', () => {
    const bus = new DashboardBus();
    bus.publish(started('CA1'));
    bus.publish({ type: 'ended', callSid: 'CA1', at: 3, reason: 'hangup' });
    bus.publish({ type: 'turn', callSid: 'CA1', at: 4, record: { turnIndex: 2 } as never, spoken: '' });
    bus.publish({ type: 'asked', callSid: 'CA1', at: 4, turnIndex: 3, questions: {}, turnState: {} as never });
    expect(bus.hasEnded('CA1')).toBe(true);
    bus.publish({ type: 'reconnect', callSid: 'CA1', at: 5, attempt: 1 });
    expect(bus.hasEnded('CA1')).toBe(false);
  });

  it('takes a reconnect for a call it never saw start (a server restarted or joining) as its start, from what the reconnect carries', () => {
    const bus = new DashboardBus();
    bus.publish({ type: 'reconnect', callSid: 'CA7', at: 50, attempt: 1, call: { from: '…0110', startedAt: 10, todayIso: '2026-10-12', thresholds: {}, channel: 'voice', provider: 'twilio', app: 'routed' } });
    expect(bus.historyOf('CA7').map((e) => e.type)).toEqual(['call_started', 'reconnect']);
    expect(bus.historyOf('CA7')[0]).toMatchObject({ at: 10, from: '…0110', provider: 'twilio', app: 'routed' });
    // One with nothing to start it by (a publisher before it) is still ignored.
    bus.publish({ type: 'reconnect', callSid: 'CA8', at: 50, attempt: 1 });
    expect(bus.callIds()).toEqual(['CA7']);
  });

  it('takes a call silent for long for ended (a server that stopped, a peer that died), and any word from it after makes it live again', () => {
    let t = 0;
    const bus = new DashboardBus(2000, 20, 500, { now: () => t });
    bus.publish(started('CA1'));
    bus.publish(started('CA2'));
    t = 60_000;
    bus.publish(dtmf('CA2', '1'));
    t = 100_000;
    expect(bus.markStale(50_000)).toEqual(['CA1']);
    expect(bus.hasEnded('CA1')).toBe(true);
    expect(bus.hasEnded('CA2')).toBe(false);
    bus.publish(dtmf('CA1', '2'));
    expect(bus.hasEnded('CA1')).toBe(false);
  });

  it('keeps the calls handed off in the last two minutes past its bound of ended calls, while the Live list shows them', () => {
    let t = 0;
    const bus = new DashboardBus(2000, 2, 500, { now: () => t });
    for (let i = 0; i < 5; i++) {
      bus.publish(started(`CA${i}`));
      bus.publish({ type: 'ended', callSid: `CA${i}`, at: 3, reason: 'handoff' });
    }
    expect(bus.callIds()).toHaveLength(5);
    t = 121_000;
    bus.publish(started('CA9'));
    bus.publish({ type: 'ended', callSid: 'CA9', at: 3, reason: 'hangup' });
    // Past the two minutes, the bound holds again: the newest two that ended.
    expect(bus.callIds()).toEqual(['CA4', 'CA9']);
  });

  it('keeps its history within a byte budget: the oldest ended calls go first, then a call in progress is trimmed and counts what it lost', () => {
    const bus = new DashboardBus(2000, 20, 500, { maxBytes: 2_000 });
    bus.publish(started('CA1'));
    bus.publish({ type: 'ended', callSid: 'CA1', at: 3, reason: 'hangup' });
    bus.publish(started('CA2'));
    for (let i = 0; i < 40; i++) bus.publish(dtmf('CA2', String(i % 10)));
    expect(bus.callIds()).toEqual(['CA2']);
    expect(bus.sizeInBytes()).toBeLessThanOrEqual(2_000);
    expect(bus.historyOf('CA2')[0]!.type).toBe('call_started');
    expect(bus.droppedOf('CA2')).toBe(41 - bus.historyOf('CA2').length);
    expect(bus.droppedOf('CA2')).toBeGreaterThan(0);
  });

  it('bounds the history', () => {
    const bus = new DashboardBus(3);
    bus.publish(started('CA1'));
    for (let i = 0; i < 5; i++) bus.publish(dtmf('CA1', String(i), 10 + i));
    const late = vi.fn();
    bus.subscribe(late);
    // The call_started event is always kept, then the newest two; the three dropped are counted.
    expect(late.mock.calls.map((c) => c[0].type)).toEqual(['call_started', 'dtmf', 'dtmf']);
    expect(bus.droppedOf('CA1')).toBe(3);
  });

  it('subscribes a subscriber that throws on the replay, and keeps streaming to it', () => {
    const bus = new DashboardBus();
    bus.publish(started('CA1'));
    const seen: DashboardEventType[] = [];
    let thrown = 0;
    const brittle = (e: PublishedEvent) => {
      seen.push(e.type);
      if (e.type === 'call_started') { thrown += 1; throw new Error('the page blew up on the history'); }
    };
    // The throw must neither escape `subscribe` nor cost the subscriber its place in the set.
    expect(() => bus.subscribe(brittle)).not.toThrow();
    expect(bus.size()).toBe(1);
    bus.publish(dtmf('CA1', '1'));
    expect(thrown).toBe(1);
    expect(seen).toEqual(['call_started', 'dtmf']);
  });

  it('unsubscribes', () => {
    const bus = new DashboardBus();
    const a = vi.fn();
    const off = bus.subscribe(a);
    off();
    bus.publish(started('CA1'));
    expect(a).not.toHaveBeenCalled();
  });
});

describe('maskNumber', () => {
  it('keeps the last four digits', () => {
    expect(maskNumber('+15555550199')).toBe('…0199');
    expect(maskNumber(undefined)).toBe('unknown');
    // Four digits or fewer would be the whole number: bullets. A value with no digits names no number.
    expect(maskNumber('123')).toBe('••••');
    expect(maskNumber('5550')).toBe('••••');
    expect(maskNumber('55505')).toBe('…5505');
    expect(maskNumber('anonymous')).toBe('…');
    // Idempotent: a number the trace already masked keeps its last four, bullets stay bullets.
    expect(maskNumber('...0142')).toBe('…0142');
    expect(maskNumber('…0142')).toBe('…0142');
    expect(maskNumber('••••')).toBe('••••');
  });
});
