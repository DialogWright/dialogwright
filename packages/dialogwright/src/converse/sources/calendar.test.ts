import { describe, expect, it } from 'vitest';
import { fakeCalendar, SlotFull, UnknownSlot } from './calendar';

const make = () =>
  fakeCalendar({
    days: ['monday', 'Friday'],
    windows: [{ name: 'morning', label: 'drop off by noon', capacity: 1 }, { name: 'afternoon', label: 'drop off by five', capacity: 2 }],
    now: () => new Date('2026-11-11T10:00:00Z'),
  });

describe('fakeCalendar', () => {
  it('lists a day\'s windows with room, labelled to read aloud', async () => {
    const free = await make().free('2026-11-13');
    expect(free.map((s) => s.id)).toEqual(['2026-11-13:morning', '2026-11-13:afternoon']);
    expect(free[0]!.label).toBe('Friday, November 13, drop off by noon');
  });
  it('gives none for a day not listed, a past day or an invalid day', async () => {
    const c = make();
    expect(await c.free('2026-11-12')).toEqual([]);
    expect(await c.free('2026-11-09')).toEqual([]);
    expect(await c.free('2026-02-30')).toEqual([]);
    expect(await c.free('soon')).toEqual([]);
  });
  it('takes one place per booking and drops a full window', async () => {
    const c = make();
    await c.book('2026-11-13:morning', { item: 'lamp' }, 'k1');
    expect((await c.free('2026-11-13')).map((s) => s.window)).toEqual(['afternoon']);
    await expect(c.book('2026-11-13:morning', {}, 'k2')).rejects.toBeInstanceOf(SlotFull);
    expect(c.bookings).toHaveLength(1);
  });
  it('books once for the same key', async () => {
    const c = make();
    const a = await c.book('2026-11-13:afternoon', {}, 'k');
    const b = await c.book('2026-11-13:afternoon', {}, 'k');
    expect(a.repeat).toBe(false);
    expect(b).toEqual({ id: a.id, repeat: true });
    expect(c.bookings).toHaveLength(1);
  });
  it('throws for an unknown slot', async () => {
    const c = make();
    await expect(c.book('2026-11-13:night', {}, 'k')).rejects.toBeInstanceOf(UnknownSlot);
    await expect(c.book('nonsense', {}, 'k')).rejects.toBeInstanceOf(UnknownSlot);
  });
  it('throws for a past day', async () => {
    await expect(make().book('2026-11-09:morning', {}, 'k')).rejects.toBeInstanceOf(UnknownSlot);
  });
  it('takes today in the business\'s zone', async () => {
    const c = fakeCalendar({
      days: ['monday', 'tuesday', 'wednesday'],
      windows: [{ name: 'morning', label: 'drop off by noon', capacity: 1 }],
      now: () => new Date('2026-11-12T02:00:00Z'),
      timeZone: 'America/New_York',
    });
    expect((await c.free('2026-11-11')).map((s) => s.id)).toEqual(['2026-11-11:morning']);
    expect(await c.free('2026-11-10')).toEqual([]);
  });
  describe('a window with a drop-off time', () => {
    const windows = [{ name: 'morning', label: 'by 8', capacity: 1, until: '08:00' }, { name: 'afternoon', label: 'by noon', capacity: 1, until: '12:00' }, { name: 'evening', label: 'any time', capacity: 1 }];
    // 2026-11-11 is a Wednesday; New York is UTC-5 in November.
    const at = (iso: string) => fakeCalendar({ days: ['wednesday', 'thursday'], windows, now: () => new Date(iso), timeZone: 'America/New_York' });
    it('offers today\'s window until its time, in the business\'s zone, and not after', async () => {
      expect((await at('2026-11-11T12:00:00Z').free('2026-11-11')).map((s) => s.window)).toEqual(['morning', 'afternoon', 'evening']);
      expect((await at('2026-11-11T13:00:00Z').free('2026-11-11')).map((s) => s.window)).toEqual(['morning', 'afternoon', 'evening']);
      expect((await at('2026-11-11T13:01:00Z').free('2026-11-11')).map((s) => s.window)).toEqual(['afternoon', 'evening']);
      expect((await at('2026-11-11T17:01:00Z').free('2026-11-11')).map((s) => s.window)).toEqual(['evening']);
    });
    it('refuses a booking into a window whose time has passed, and takes it before', async () => {
      await expect(at('2026-11-11T19:00:00Z').book('2026-11-11:morning', {}, 'k')).rejects.toBeInstanceOf(UnknownSlot);
      await expect(at('2026-11-11T19:00:00Z').book('2026-11-11:afternoon', {}, 'k')).rejects.toBeInstanceOf(UnknownSlot);
      expect((await at('2026-11-11T19:00:00Z').book('2026-11-11:evening', {}, 'k')).repeat).toBe(false);
      expect((await at('2026-11-11T12:30:00Z').book('2026-11-11:morning', {}, 'k')).repeat).toBe(false);
    });
    it('leaves a later day\'s window offered at any hour', async () => {
      const c = at('2026-11-11T23:00:00Z');
      expect((await c.free('2026-11-12')).map((s) => s.window)).toEqual(['morning', 'afternoon', 'evening']);
      expect((await c.book('2026-11-12:morning', {}, 'k')).repeat).toBe(false);
    });
    it('compares the zone\'s day, not UTC\'s', async () => {
      // 02:00Z on the 12th is 21:00 on the 11th in New York: the 11th is still today.
      const c = at('2026-11-12T02:00:00Z');
      expect((await c.free('2026-11-11')).map((s) => s.window)).toEqual(['evening']);
      expect((await c.free('2026-11-12')).map((s) => s.window)).toEqual(['morning', 'afternoon', 'evening']);
    });
  });
});
