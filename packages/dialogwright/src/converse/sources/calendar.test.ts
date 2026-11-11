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
});
