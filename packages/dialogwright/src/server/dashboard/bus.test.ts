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

  it('bounds the history', () => {
    const bus = new DashboardBus(3);
    bus.publish(started('CA1'));
    for (let i = 0; i < 5; i++) bus.publish(dtmf('CA1', String(i), 10 + i));
    const late = vi.fn();
    bus.subscribe(late);
    // The call_started event is always kept, then the newest two.
    expect(late.mock.calls.map((c) => c[0].type)).toEqual(['call_started', 'dtmf', 'dtmf']);
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
