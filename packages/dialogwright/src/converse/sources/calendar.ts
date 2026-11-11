/** A fake calendar for the converse runtime: free places per day by window and capacity, booked with a key. */

export interface Slot {
  /** Unique across days: "<day>:<window>". */
  id: string;
  dayIso: string;
  window: string;
  /** How it reads aloud: "Friday, November 13, drop off by noon". */
  label: string;
}

export interface Calendar {
  free(dayIso: string): Promise<Slot[]>;
  book(slotId: string, details: Record<string, string>, key: string): Promise<{ id: string; repeat: boolean }>;
}

/** A booking into a window that is at capacity. */
export class SlotFull extends Error {
  constructor(readonly slotId: string) {
    super(`slot ${slotId} is full`);
    this.name = 'SlotFull';
  }
}

/** A booking into a slot id the calendar never offered. */
export class UnknownSlot extends Error {
  constructor(readonly slotId: string) {
    super(`unknown slot ${slotId}`);
    this.name = 'UnknownSlot';
  }
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** The UTC date of a valid ISO day (YYYY-MM-DD), or null. */
function parseDay(dayIso: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayIso)) return null;
  const d = new Date(`${dayIso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== dayIso ? null : d;
}

const dayWords = (d: Date): string => d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });

export function fakeCalendar(o: {
  days: string[];
  windows: { name: string; label: string; capacity: number }[];
  now: () => Date;
}): Calendar & { bookings: { slotId: string; details: Record<string, string>; key: string }[] } {
  const open = new Set(o.days.map((d) => d.trim().toLowerCase()));
  const bookings: { slotId: string; details: Record<string, string>; key: string }[] = [];
  const byKey = new Map<string, string>();
  const slotOf = (dayIso: string, w: { name: string; label: string }): Slot => {
    const d = parseDay(dayIso)!;
    return { id: `${dayIso}:${w.name}`, dayIso, window: w.name, label: `${dayWords(d)}, ${w.label}` };
  };
  const taken = (slotId: string): number => bookings.filter((b) => b.slotId === slotId).length;
  const openDay = (d: Date | null): d is Date => d !== null && open.has(WEEKDAYS[d.getUTCDay()]!) && d.toISOString().slice(0, 10) >= o.now().toISOString().slice(0, 10);
  return {
    bookings,
    async free(dayIso) {
      const d = parseDay(dayIso);
      if (!openDay(d)) return [];
      return o.windows.filter((w) => taken(`${dayIso}:${w.name}`) < w.capacity).map((w) => slotOf(dayIso, w));
    },
    async book(slotId, details, key) {
      const before = byKey.get(key);
      if (before !== undefined) return { id: before, repeat: true };
      const at = slotId.indexOf(':');
      const dayIso = slotId.slice(0, at);
      const w = o.windows.find((x) => x.name === slotId.slice(at + 1));
      const d = at < 0 ? null : parseDay(dayIso);
      if (w === undefined || !openDay(d)) throw new UnknownSlot(slotId);
      if (taken(slotId) >= w.capacity) throw new SlotFull(slotId);
      bookings.push({ slotId, details: { ...details }, key });
      const id = `bk-${bookings.length}`;
      byKey.set(key, id);
      return { id, repeat: false };
    },
  };
}
