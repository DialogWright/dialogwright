import { createHash } from 'node:crypto';
import { localDateIso, localMinutes, minutesOfTime } from '../../core/localDate';
import type { AgentBusiness } from '../business/schema';
import { businessZone } from '../state';
import { dayWords, parseDay, SlotFull, UnknownSlot, WEEKDAYS, type Calendar, type Slot } from './calendar';
import { CALENDAR_EVENTS_SCOPE, GoogleCalendarError, requestWithin, serviceAccountTokens, type GoogleFailure } from './googleAuth';

/**
 * Google Calendar through a service account, behind the converse runtime's Calendar (calendar.ts), for a
 * business whose agent.yaml says `sources.calendar.kind: google`. The windows are the business's, as the fake
 * calendar's are (agent.yaml's days, windows, capacity and `until`, in the business's zone); the Google
 * calendar holds what is booked in them:
 *
 * - **Free slots.** A day's events are listed (Calendar API v3, `singleEvents`, every page), and each window
 *   offers its capacity less the events that take a place in it: an event the line booked takes a place in the
 *   window it names (its private property `slot`); any other event (one the business put in by hand) takes one
 *   in each window whose span it overlaps, unless it is shown as free (`transparency: transparent`) or is
 *   cancelled. A window's span runs from the latest `until` before its own (midnight for the first) to its own
 *   `until`; a window with no `until` spans the whole day.
 * - **A booking** is one event whose id is derived from the write's idempotency key (eventIdOf), so a write
 *   repeated after a restart, or after an answer that came too late, is the same event, never a second. The
 *   day's events are read first: the key's own event there is the same booking (a repeat), found before the
 *   window is checked, so a write retried after its window's time has passed still finds it. Otherwise the
 *   window is checked and the event inserted; a 409 (the id is taken) is the same booking only where Google
 *   shows the event still standing in this slot. One deleted since is reported as removed, never as booked, and
 *   is not put back over the person who removed it; one under the same id in another slot is refused. A window
 *   with a `until` is booked as the half hour before it (from its span's start where that is later); one with
 *   none as an all-day event.
 * - **Failures.** A request Google answers with an error, or not within `timeoutMs`, fails the lookup or the
 *   booking with a GoogleCalendarError, whose message the model is told as the action's failure: no slot is
 *   ever invented, and a booking that failed is not reported as made. An insert that went unanswered (late,
 *   unreachable, a 5xx or a 429) may have been written all the same: its event is asked for by its id once (a
 *   request with its own `timeoutMs`), and booked where it stands in this slot; where it cannot be read, the
 *   model is told it is not known whether it was made and that booking it again is safe (`unconfirmed`), never
 *   that it was not booked. `timeoutMs` bounds each request, so one booking may take a sign-in, a listing, an
 *   insert and a read, each up to it. Nothing here logs, and no message names
 *   the key file's path or what it holds.
 *
 * Two lines booking the last place in a window at the same moment can both succeed (Google holds no
 * capacity): the window then has one more than its capacity, as a person booking by hand at that moment would
 * make it.
 */

/** The app setting that names the service account's key file (a path on the server; never in a file the repository tracks). */
export const GOOGLE_CALENDAR_KEY_FILE = 'GOOGLE_CALENDAR_KEY_FILE';
/** How long a request to Google may take before the lookup or booking fails: 4 s. */
export const GOOGLE_TIMEOUT_MS = 4000;
const API = 'https://www.googleapis.com/calendar/v3/calendars/';
/** The private property an event the line booked carries: the slot it takes a place in. */
const SLOT_PROPERTY = 'slot';
/** How long a booked event lasts before the window's last time (`until`): half an hour. */
const EVENT_MINUTES = 30;
/** The most pages of a day's events read (250 events each). */
const MAX_PAGES = 20;
/** The failures of an insert after which Google may hold the event all the same: no answer in time, none at all, a 5xx or a 429. */
const UNANSWERED: ReadonlySet<GoogleFailure> = new Set<GoogleFailure>(['timeout', 'unreachable', 'unavailable']);
/** What the model is told of a booking whose insert went unanswered and whose event could not be read: not known, never "not booked". */
const notConfirmed = (): GoogleCalendarError => new GoogleCalendarError('unconfirmed', 'the calendar did not confirm this booking, so it is not known whether it was made; booking it again with the same details on this call is safe and never books it twice');

/**
 * The event id a booking's idempotency key is written as: the key's SHA-256 in hex, 64 characters of the
 * base32hex alphabet Google's event ids take ([a-v0-9], 5 to 1024 long). The same key is always the same id.
 */
export function eventIdOf(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

export interface GoogleCalendarOptions {
  /** The calendar's id (its settings' "Integrate calendar": an address such as ...@group.calendar.google.com). */
  calendarId: string;
  /** The path of the service account's key file (the app's setting GOOGLE_CALENDAR_KEY_FILE). */
  keyFile: string;
  /** The business: its calendar's days and windows, and its zone. */
  business: AgentBusiness;
  /** How requests are sent; default the global fetch. Tests give the fake Google API's. */
  fetch?: typeof fetch;
  /** The business's clock: its day, and which windows have passed. */
  now: () => Date;
  /** The real time, in ms, for the sign-in (its assertion's times and the token's expiry); default Date.now. Tests give the fake Google API's clock. */
  wallClock?: () => number;
  /** How long one request to Google may take; default GOOGLE_TIMEOUT_MS. */
  timeoutMs?: number;
}

interface GoogleTime {
  dateTime?: string;
  date?: string;
}

interface GoogleEvent {
  id?: string;
  status?: string;
  transparency?: string;
  start?: GoogleTime;
  end?: GoogleTime;
  extendedProperties?: { private?: Record<string, string> };
}

interface Window {
  name: string;
  label: string;
  capacity: number;
  until?: string;
}

/** The offset of `zone` from UTC at `ms`, in ms (New York in November: -5 h). */
function offsetMs(ms: number, zone: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(ms).map((x) => [x.type, x.value]));
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - Math.floor(ms / 1000) * 1000;
}

/** The instant of `minutes` past midnight on `dayIso` in `zone`. */
function zonedMs(dayIso: string, minutes: number, zone: string): number {
  const [y, m, d] = dayIso.split('-').map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d, 0, minutes);
  let at = wall - offsetMs(wall, zone);
  at = wall - offsetMs(at, zone);
  return at;
}

/** `minutes` past midnight on `dayIso` in `zone`, as RFC 3339 with the zone's offset ("2026-11-30T11:30:00-05:00"). */
function zonedDateTime(dayIso: string, minutes: number, zone: string): string {
  const off = Math.round(offsetMs(zonedMs(dayIso, minutes, zone), zone) / 60_000);
  const abs = Math.abs(off);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${dayIso}T${two(Math.floor(minutes / 60))}:${two(minutes % 60)}:00${off < 0 ? '-' : '+'}${two(Math.floor(abs / 60))}:${two(abs % 60)}`;
}

const nextDay = (dayIso: string): string => new Date(Date.parse(`${dayIso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** A window's span on its day, in minutes from midnight: from the latest `until` before its own (or midnight) to its own (or the day's end). */
function spanOf(w: Window, all: readonly Window[]): { from: number; to: number } {
  if (w.until === undefined) return { from: 0, to: 24 * 60 };
  const to = minutesOfTime(w.until);
  const from = Math.max(0, ...all.filter((x) => x.until !== undefined && minutesOfTime(x.until) < to).map((x) => minutesOfTime(x.until!)));
  return { from, to };
}

export function googleCalendar(o: GoogleCalendarOptions): Calendar {
  const c = o.business.sources.calendar;
  const windows: readonly Window[] = c?.windows ?? [];
  const open = new Set((c?.days ?? []).map((d) => d.trim().toLowerCase()));
  const zone = businessZone(o.business);
  const fetcher = o.fetch ?? fetch;
  const timeoutMs = o.timeoutMs ?? GOOGLE_TIMEOUT_MS;
  const tokens = serviceAccountTokens({ keyFile: o.keyFile, scope: CALENDAR_EVENTS_SCOPE, fetch: fetcher, wallClock: o.wallClock ?? Date.now, timeoutMs });
  const base = `${API}${encodeURIComponent(o.calendarId)}/events`;

  const openDay = (dayIso: string): boolean => {
    const d = parseDay(dayIso);
    return d !== null && open.has(WEEKDAYS[d.getUTCDay()]!) && dayIso >= localDateIso(o.now().getTime(), zone);
  };
  /** Whether a window's last time (`until`) has passed on `dayIso`: only today's can have. */
  const over = (dayIso: string, w: Window): boolean => {
    if (w.until === undefined) return false;
    const now = o.now().getTime();
    return dayIso === localDateIso(now, zone) && localMinutes(now, zone) > minutesOfTime(w.until);
  };
  const slotOf = (dayIso: string, w: Window): Slot => ({ id: `${dayIso}:${w.name}`, dayIso, window: w.name, label: `${dayWords(parseDay(dayIso)!)}, ${w.label}` });

  /** A request to the calendar with the service account's token; its answer's JSON, or a GoogleCalendarError (`conflict` for a 409 when it is allowed). */
  const ask = async (url: string, init: RequestInit, allowConflict = false): Promise<{ conflict: true } | { conflict: false; json: unknown }> => {
    const token = await tokens.token();
    const res = await requestWithin(fetcher, url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` } }, timeoutMs);
    if (res.status === 409 && allowConflict) return { conflict: true };
    if (res.ok) return { conflict: false, json: res.json };
    if (res.status === 401) {
      tokens.forget();
      throw new GoogleCalendarError('sign-in', `the calendar refused the line's sign-in (${res.status}), so it cannot be read or booked now`);
    }
    if (res.status >= 500 || res.status === 429) throw new GoogleCalendarError('unavailable', `the calendar is not answering (${res.status}), so nothing is known from it now`);
    if (res.status === 404) throw new GoogleCalendarError('not-found', `the calendar was not found (${res.status}), so it cannot be read or booked now`);
    throw new GoogleCalendarError('refused', `the calendar refused the request (${res.status}), so it cannot be read or booked now`);
  };

  /** Every event of `dayIso` (in the business's zone), all pages. */
  const eventsOn = async (dayIso: string): Promise<GoogleEvent[]> => {
    const out: GoogleEvent[] = [];
    let page: string | undefined;
    for (let i = 0; i < MAX_PAGES; i += 1) {
      const q = new URLSearchParams({ timeMin: new Date(zonedMs(dayIso, 0, zone)).toISOString(), timeMax: new Date(zonedMs(nextDay(dayIso), 0, zone)).toISOString(), singleEvents: 'true', maxResults: '250', ...(page !== undefined ? { pageToken: page } : {}) });
      const r = await ask(`${base}?${q.toString()}`, { method: 'GET' });
      const json = (r.conflict ? {} : r.json) as { items?: unknown; nextPageToken?: unknown };
      if (Array.isArray(json.items)) out.push(...(json.items as GoogleEvent[]));
      if (typeof json.nextPageToken !== 'string') return out;
      page = json.nextPageToken;
    }
    return out;
  };

  /** The instant an event's start or end is, in ms; an all-day date is midnight in the business's zone. */
  const msOf = (t: GoogleTime | undefined): number => (t?.dateTime !== undefined ? Date.parse(t.dateTime) : t?.date !== undefined ? zonedMs(t.date, 0, zone) : Number.NaN);

  /** The places taken in `w` on `dayIso` by `events`. */
  const taken = (dayIso: string, w: Window, events: readonly GoogleEvent[]): number => {
    const slotId = `${dayIso}:${w.name}`;
    const span = spanOf(w, windows);
    const from = zonedMs(dayIso, span.from, zone);
    const to = span.to >= 24 * 60 ? zonedMs(nextDay(dayIso), 0, zone) : zonedMs(dayIso, span.to, zone);
    return events.filter((e) => {
      if (e.status === 'cancelled') return false;
      const booked = e.extendedProperties?.private?.[SLOT_PROPERTY];
      if (booked !== undefined) return booked === slotId;
      if (e.transparency === 'transparent') return false;
      const s = msOf(e.start);
      const t = msOf(e.end);
      return s < to && t > from;
    }).length;
  };

  /** The event a booking into `w` on `dayIso` is written as. */
  const eventFor = (id: string, slot: Slot, w: Window, details: Record<string, string>): Record<string, unknown> => {
    const span = spanOf(w, windows);
    const end = w.until === undefined ? null : minutesOfTime(w.until);
    const start = end === null ? null : Math.max(span.from, end - EVENT_MINUTES);
    const times = end === null || start === null || start >= end
      ? { start: { date: slot.dayIso }, end: { date: nextDay(slot.dayIso) } }
      : { start: { dateTime: zonedDateTime(slot.dayIso, start, zone), timeZone: zone }, end: { dateTime: zonedDateTime(slot.dayIso, end, zone), timeZone: zone } };
    const name = details.name?.trim();
    return {
      id,
      summary: name !== undefined && name !== '' ? `${name}, ${w.label}` : w.label,
      description: [...Object.entries(details).map(([k, v]) => `${k}: ${v}`), `Booked by the line for ${slot.label}.`].join('\n'),
      transparency: 'opaque',
      ...times,
      extendedProperties: { private: { [SLOT_PROPERTY]: slot.id } },
    };
  };

  const calendar: Calendar = {
    async free(dayIso) {
      if (!openDay(dayIso)) return [];
      const offered = windows.filter((w) => !over(dayIso, w));
      if (offered.length === 0) return [];
      const events = await eventsOn(dayIso);
      return offered.filter((w) => taken(dayIso, w, events) < w.capacity).map((w) => slotOf(dayIso, w));
    },
    async book(slotId, details, key) {
      const at = slotId.indexOf(':');
      if (at < 0) throw new UnknownSlot(slotId);
      const dayIso = slotId.slice(0, at);
      const w = windows.find((x) => x.name === slotId.slice(at + 1));
      if (w === undefined || parseDay(dayIso) === null) throw new UnknownSlot(slotId);
      const id = eventIdOf(key);
      const events = await eventsOn(dayIso);
      // The same key's event is already in (a write repeated, its first answer late perhaps): the same booking,
      // found before the window is checked (its day may have closed or its time passed since) and before its
      // room is counted, which it takes.
      const own = events.find((e) => e.id === id && e.status !== 'cancelled');
      if (own !== undefined) return { id, repeat: standsFor(own, slotId) };
      if (!openDay(dayIso) || over(dayIso, w)) throw new UnknownSlot(slotId);
      if (taken(dayIso, w, events) >= w.capacity) throw new SlotFull(slotId);
      const byId = `${base}/${encodeURIComponent(id)}`;
      let made: Awaited<ReturnType<typeof ask>>;
      try {
        made = await ask(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(eventFor(id, slotOf(dayIso, w), w, details)) }, true);
      } catch (e) {
        if (!(e instanceof GoogleCalendarError) || !UNANSWERED.has(e.failure)) throw e;
        // The insert went unanswered (late, unreachable, a 5xx or a 429): Google may hold the event all the same.
        // Its event is asked for by its id once, with a time of its own: standing in this slot, it is booked;
        // anything else leaves it not known, never "not booked" (a repeat with the same key is the same event).
        let held: GoogleEvent;
        try {
          const r = await ask(byId, { method: 'GET' });
          held = (r.conflict ? {} : r.json) as GoogleEvent;
        } catch {
          throw notConfirmed();
        }
        if (held.status === 'cancelled') throw notConfirmed();
        standsFor(held, slotId);
        return { id, repeat: false };
      }
      if (!made.conflict) return { id, repeat: false };
      // 409: Google already has an event with this id, written by this key before. It is the same booking only
      // where it still stands in this slot (not listed yet); one deleted since is not booked, and is not put back
      // over the person who removed it.
      let held: GoogleEvent;
      try {
        const r = await ask(byId, { method: 'GET' });
        held = (r.conflict ? {} : r.json) as GoogleEvent;
      } catch (e) {
        if (e instanceof GoogleCalendarError && e.failure === 'not-found') throw new GoogleCalendarError('refused', 'the calendar refused this booking\'s id as taken and cannot show it, so nothing was booked');
        throw e;
      }
      if (held.status === 'cancelled') throw new GoogleCalendarError('refused', 'this booking was made earlier and then removed from the calendar, so it is not booked now, and it was not booked again');
      return { id, repeat: standsFor(held, slotId) };
    },
  };

  /** Whether the line's own event `e` stands for `slotId` (true); throws where it holds another slot under the same id. */
  function standsFor(e: GoogleEvent, slotId: string): true {
    const slot = e.extendedProperties?.private?.[SLOT_PROPERTY];
    if (slot !== slotId) throw new GoogleCalendarError('refused', `the calendar holds this booking's id for another window${slot !== undefined ? ` (${slot})` : ''}, so nothing was booked`);
    return true;
  }
  return calendar;
}
