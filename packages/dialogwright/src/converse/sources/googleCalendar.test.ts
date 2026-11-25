import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { businessCalendar, defineConverseApp } from '../app';
import { readAgentBusiness, resolveAgentSettings } from '../business/load';
import type { AgentBusiness } from '../business/schema';
import { fakeModel } from '../model/fake';
import { FakeGoogleCalendar, FAKE_TOKEN_URI } from '../../testing/fakeGoogleCalendar';
import { CONVERSE_FIXTURE_DIR } from '../../testing/converse/app';
import { BOOKING, CALLER, DAY, SLOT, yesJev } from '../../testing/converse/chat';
import { converseTestCall } from '../../testing/converseCall';
import { SlotFull, UnknownSlot } from './calendar';
import { eventIdOf, GOOGLE_CALENDAR_KEY_FILE, googleCalendar } from './googleCalendar';

/**
 * The converse runtime's Google calendar (googleCalendar.ts) against the fake Google API
 * (testing/fakeGoogleCalendar.ts): no request leaves the process. The service account's key pair is made
 * here, for these tests alone; no private key is ever committed.
 */

const CALENDAR_ID = 'visits@group.calendar.example.com';
const CLIENT_EMAIL = 'line@example-project.iam.gserviceaccount.com';
/** Wednesday, November 25 2026, 10:00 in New York. */
const T0 = Date.parse('2026-11-25T15:00:00Z');
/** A Monday the windows are open. */
const MONDAY = '2026-11-30';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

let dir: string;
let keyFile: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dw-gcal-'));
  keyFile = join(dir, 'secret-service-account-key.json');
  writeFileSync(keyFile, JSON.stringify({ type: 'service_account', client_email: CLIENT_EMAIL, private_key: PRIVATE_PEM, token_uri: FAKE_TOKEN_URI, private_key_id: 'k1' }));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

/** The fixture's business with the windows these tests use: a weekday morning by 8 (two places) and afternoon by noon (one), in New York. */
function business(): AgentBusiness {
  const b = readAgentBusiness(CONVERSE_FIXTURE_DIR);
  return {
    ...b,
    business: { ...b.business, timezone: 'America/New_York' },
    sources: {
      ...b.sources,
      calendar: {
        kind: 'google',
        calendarId: CALENDAR_ID,
        days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
        windows: [
          { name: 'morning', label: 'morning, by 8', capacity: 2, until: '08:00' },
          { name: 'afternoon', label: 'afternoon, by noon', capacity: 1, until: '12:00' },
        ],
      },
    },
  };
}

function setup(o: { timeoutMs?: number; keyFile?: string } = {}) {
  let now = T0;
  const clock = { set: (ms: number) => { now = ms; }, now: () => now };
  const google = new FakeGoogleCalendar({ publicKey, clientEmail: CLIENT_EMAIL, calendars: [CALENDAR_ID], now: () => now });
  const calendar = googleCalendar({ calendarId: CALENDAR_ID, keyFile: o.keyFile ?? keyFile, business: business(), fetch: google.fetch, now: () => new Date(now), wallClock: () => now, ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}) });
  return { google, calendar, clock };
}

/** An event the business's owner put in by hand, in New York's time (November: UTC-5). */
const ownEvent = (id: string, from: string, to: string, extra: Record<string, unknown> = {}) => ({ id, summary: 'Busy', start: { dateTime: `${MONDAY}T${from}:00-05:00` }, end: { dateTime: `${MONDAY}T${to}:00-05:00` }, ...extra });

describe('googleCalendar', () => {
  it('free slots subtract the events in each window', async () => {
    const { google, calendar } = setup();
    expect((await calendar.free(MONDAY)).map((s) => [s.id, s.label])).toEqual([
      [`${MONDAY}:morning`, 'Monday, November 30, morning, by 8'],
      [`${MONDAY}:afternoon`, 'Monday, November 30, afternoon, by noon'],
    ]);
    // One busy event in the morning takes one of its two places; one in the afternoon fills it. An event shown
    // as free (transparent) and one cancelled take none, nor does one on another day.
    google.add(CALENDAR_ID, ownEvent('own00001', '07:00', '07:45'));
    google.add(CALENDAR_ID, ownEvent('own00002', '09:00', '10:00'));
    google.add(CALENDAR_ID, ownEvent('own00003', '06:00', '06:30', { transparency: 'transparent' }));
    google.add(CALENDAR_ID, ownEvent('own00004', '06:00', '06:30', { status: 'cancelled' }));
    google.add(CALENDAR_ID, { id: 'own00005', start: { dateTime: '2026-12-01T09:00:00-05:00' }, end: { dateTime: '2026-12-01T10:00:00-05:00' } });
    expect((await calendar.free(MONDAY)).map((s) => s.id)).toEqual([`${MONDAY}:morning`]);
    google.add(CALENDAR_ID, ownEvent('own00006', '05:00', '05:30'));
    expect(await calendar.free(MONDAY)).toEqual([]);
  });

  it('offers no day the windows are closed, a past day or an invalid one, and no window of today past its last time (until), asking Google nothing for a day it offers nothing on', async () => {
    const { google, calendar } = setup();
    expect(await calendar.free('2026-11-28')).toEqual([]); // a Saturday
    expect(await calendar.free('2026-11-24')).toEqual([]); // yesterday
    expect(await calendar.free('2026-02-30')).toEqual([]);
    expect(google.requests).toEqual([]);
    // 10:00 in New York: the morning (by 8) has passed today, the afternoon (by noon) has not.
    expect((await calendar.free('2026-11-25')).map((s) => s.window)).toEqual(['afternoon']);
  });

  it('a booking writes one event, and the same key writes no second', async () => {
    const { google, calendar } = setup();
    const made = await calendar.book(`${MONDAY}:afternoon`, { name: 'Avery Example', phone: '+15555550123' }, 'key-1');
    expect(made).toEqual({ id: eventIdOf('key-1'), repeat: false });
    expect(made.id).toMatch(/^[a-v0-9]{5,1024}$/);
    const events = google.events.get(CALENDAR_ID)!;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: made.id, start: { dateTime: `${MONDAY}T11:30:00-05:00` }, end: { dateTime: `${MONDAY}T12:00:00-05:00` }, extendedProperties: { private: { slot: `${MONDAY}:afternoon` } } });
    expect(events[0]!.description).toContain('name: Avery Example');
    // The same key again (the write repeated after a restart): the same event, no second.
    expect(await calendar.book(`${MONDAY}:afternoon`, { name: 'Avery Example' }, 'key-1')).toEqual({ id: made.id, repeat: true });
    expect(google.events.get(CALENDAR_ID)).toHaveLength(1);
    // The afternoon is full now: another key is refused, and the window is no longer offered.
    await expect(calendar.book(`${MONDAY}:afternoon`, {}, 'key-2')).rejects.toBeInstanceOf(SlotFull);
    expect((await calendar.free(MONDAY)).map((s) => s.window)).toEqual(['morning']);
    await expect(calendar.book(`${MONDAY}:evening`, {}, 'key-3')).rejects.toBeInstanceOf(UnknownSlot);
    await expect(calendar.book('2026-11-28:morning', {}, 'key-3')).rejects.toBeInstanceOf(UnknownSlot);
    await expect(calendar.book('2026-11-25:morning', {}, 'key-3')).rejects.toBeInstanceOf(UnknownSlot);
  });

  it('a booking whose answer came too late is asked for by its id once: Google holds it, so it is booked, and the same key after it writes no second', async () => {
    const { google, calendar } = setup({ timeoutMs: 50 });
    await calendar.free(MONDAY); // the token, in time
    google.writeDelayMs = 200; // Google writes the event and answers after the line has given up
    expect(await calendar.book(`${MONDAY}:morning`, { name: 'Avery Example' }, 'key-1')).toEqual({ id: eventIdOf('key-1'), repeat: false });
    expect(google.requests.filter((r) => r.path.endsWith(`/events/${eventIdOf('key-1')}`)).map((r) => `${r.method} ${r.status}`)).toEqual(['GET 200']);
    expect(google.events.get(CALENDAR_ID)).toHaveLength(1);
    google.writeDelayMs = 0;
    expect(await calendar.book(`${MONDAY}:morning`, { name: 'Avery Example' }, 'key-1')).toEqual({ id: eventIdOf('key-1'), repeat: true });
    expect(google.events.get(CALENDAR_ID)).toHaveLength(1);
  });

  it('a booking whose insert went unanswered and whose event cannot be read either is never told to the model as not booked', async () => {
    const UNKNOWN = /^the calendar did not confirm this booking, so it is not known whether it was made; booking it again with the same details on this call is safe and never books it twice/;
    const byId = (m: string, path: string): boolean => m === 'GET' && path.endsWith(`/events/${eventIdOf('key-1')}`);
    // The insert late (written), and the read of its event refused by an outage.
    const { google, calendar } = setup({ timeoutMs: 50 });
    await calendar.free(MONDAY);
    google.writeDelayMs = 200;
    google.failNext(1, 503, byId);
    await expect(calendar.book(`${MONDAY}:morning`, {}, 'key-1')).rejects.toThrow(UNKNOWN);
    expect(google.events.get(CALENDAR_ID)).toHaveLength(1);
    google.writeDelayMs = 0;
    expect(await calendar.book(`${MONDAY}:morning`, {}, 'key-1')).toEqual({ id: eventIdOf('key-1'), repeat: true });
    expect(google.events.get(CALENDAR_ID)).toHaveLength(1);
    // The insert answered 503 (nothing written here, though Google may still write it), and its event not found:
    // still not known, never "not booked".
    const second = setup();
    await second.calendar.free(MONDAY);
    second.google.failNext(1, 503, (m) => m === 'POST');
    await expect(second.calendar.book(`${MONDAY}:morning`, {}, 'key-1')).rejects.toThrow(UNKNOWN);
    expect(second.google.requests.filter((r) => byId(r.method, r.path)).map((r) => r.status)).toEqual([404]);
    // The insert answered 429 and its event stands: booked.
    const third = setup();
    await third.calendar.free(MONDAY);
    third.google.failNext(1, 429, (m) => m === 'POST');
    third.google.add(CALENDAR_ID, { ...ownEvent(eventIdOf('key-1'), '07:30', '08:00'), extendedProperties: { private: { slot: `${MONDAY}:morning` } } });
    third.google.unlisted.add(eventIdOf('key-1'));
    expect(await third.calendar.book(`${MONDAY}:morning`, {}, 'key-1')).toEqual({ id: eventIdOf('key-1'), repeat: false });
    // A refusal of the insert (a 400 or a 403) is no outage: no read of the event, the refusal said.
    const fourth = setup();
    await fourth.calendar.free(MONDAY);
    fourth.google.failNext(1, 403, (m) => m === 'POST');
    await expect(fourth.calendar.book(`${MONDAY}:morning`, {}, 'key-1')).rejects.toThrow(/^the calendar refused the request \(403\)/);
    expect(fourth.google.requests.filter((r) => byId(r.method, r.path))).toEqual([]);
  });

  it('a 409 for a key whose event stands in its slot (not yet listed) is the same booking', async () => {
    const { google, calendar } = setup();
    google.add(CALENDAR_ID, { ...ownEvent(eventIdOf('key-1'), '07:30', '08:00'), extendedProperties: { private: { slot: `${MONDAY}:morning` } } });
    google.unlisted.add(eventIdOf('key-1'));
    expect(await calendar.book(`${MONDAY}:morning`, {}, 'key-1')).toEqual({ id: eventIdOf('key-1'), repeat: true });
    expect(google.requests.filter((r) => r.method !== 'GET' || r.path.endsWith(eventIdOf('key-1'))).map((r) => `${r.method} ${r.status}`)).toEqual(['POST 200', 'POST 409', 'GET 200']);
  });

  it('a 409 for a key whose event was deleted is not reported as booked: the model is told it was removed', async () => {
    const { google, calendar } = setup();
    google.add(CALENDAR_ID, { ...ownEvent(eventIdOf('key-1'), '07:30', '08:00'), status: 'cancelled', extendedProperties: { private: { slot: `${MONDAY}:morning` } } });
    await expect(calendar.book(`${MONDAY}:morning`, {}, 'key-1')).rejects.toThrow(/^this booking was made earlier and then removed from the calendar/);
    expect(google.events.get(CALENDAR_ID)!.map((e) => e.status)).toEqual(['cancelled']);
  });

  it('a 409 for a key whose event stands in another slot is no booking of this one', async () => {
    const { google, calendar } = setup();
    google.add(CALENDAR_ID, { id: eventIdOf('key-1'), start: { dateTime: '2026-12-01T07:30:00-05:00' }, end: { dateTime: '2026-12-01T08:00:00-05:00' }, extendedProperties: { private: { slot: '2026-12-01:morning' } } });
    await expect(calendar.book(`${MONDAY}:morning`, {}, 'key-1')).rejects.toThrow(/^the calendar holds this booking's id for another window/);
  });

  it('a booking repeated after its window has passed (its first answer late) finds its event before the window is checked', async () => {
    const { google, calendar, clock } = setup({ timeoutMs: 50 });
    clock.set(Date.parse(`${MONDAY}T12:59:00Z`)); // 07:59 in New York, the morning's last minute
    await calendar.free(MONDAY);
    google.writeDelayMs = 200;
    google.failNext(1, 503, (m, path) => m === 'GET' && path.endsWith(`/events/${eventIdOf('key-1')}`)); // its event cannot be read either
    await expect(calendar.book(`${MONDAY}:morning`, {}, 'key-1')).rejects.toThrow(/^the calendar did not confirm this booking/);
    google.writeDelayMs = 0;
    clock.set(Date.parse(`${MONDAY}T13:01:00Z`)); // 08:01: the morning is over
    expect(await calendar.book(`${MONDAY}:morning`, {}, 'key-1')).toEqual({ id: eventIdOf('key-1'), repeat: true });
    expect(google.events.get(CALENDAR_ID)).toHaveLength(1);
    // A key with no event is still refused for the window that has passed.
    await expect(calendar.book(`${MONDAY}:morning`, {}, 'key-2')).rejects.toBeInstanceOf(UnknownSlot);
  });

  it('a response whose body stalls after its headers fails within the timeout, at sign-in and at a lookup', async () => {
    const { google, calendar } = setup({ timeoutMs: 50 });
    google.stallBodyMs = 1000;
    let started = Date.now();
    await expect(calendar.free(MONDAY)).rejects.toThrow(/^the calendar did not answer in time/);
    expect(Date.now() - started).toBeLessThan(500);
    google.stallBodyMs = 0;
    await calendar.free(MONDAY);
    google.stallBodyMs = 1000;
    started = Date.now();
    await expect(calendar.free(MONDAY)).rejects.toThrow(/^the calendar did not answer in time/);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('a window with no last time (until) is booked as an all-day event, and only events that name it take its places', async () => {
    const b = business();
    const cal = b.sources.calendar!;
    const open: AgentBusiness = { ...b, sources: { ...b.sources, calendar: { ...cal, windows: [{ name: 'morning', label: '9 to 12', capacity: 1 }, { name: 'afternoon', label: '1 to 5', capacity: 1 }] } } };
    const google = new FakeGoogleCalendar({ publicKey, clientEmail: CLIENT_EMAIL, calendars: [CALENDAR_ID] });
    const calendar = googleCalendar({ calendarId: CALENDAR_ID, keyFile, business: open, fetch: google.fetch, now: () => new Date(T0) });
    await calendar.book(`${MONDAY}:morning`, {}, 'key-1');
    expect(google.events.get(CALENDAR_ID)![0]).toMatchObject({ start: { date: MONDAY }, end: { date: '2026-12-01' } });
    expect((await calendar.free(MONDAY)).map((s) => s.window)).toEqual(['afternoon']);
  });

  it('reads every page of a busy day', async () => {
    const google = new FakeGoogleCalendar({ publicKey, clientEmail: CLIENT_EMAIL, calendars: [CALENDAR_ID], pageSize: 1 });
    const calendar = googleCalendar({ calendarId: CALENDAR_ID, keyFile, business: business(), fetch: google.fetch, now: () => new Date(T0) });
    google.add(CALENDAR_ID, ownEvent('own00001', '07:00', '07:30'));
    google.add(CALENDAR_ID, ownEvent('own00002', '07:00', '07:30'));
    google.add(CALENDAR_ID, ownEvent('own00003', '09:00', '09:30'));
    expect(await calendar.free(MONDAY)).toEqual([]);
    expect(google.requests.filter((r) => r.method === 'GET')).toHaveLength(3);
  });

  it('a 5xx or a timeout fails the lookup with a reason the model is told', async () => {
    const { google, calendar } = setup({ timeoutMs: 50 });
    await calendar.free(MONDAY);
    google.failNext(1, 503);
    await expect(calendar.free(MONDAY)).rejects.toThrow(/^the calendar is not answering \(503\)/);
    google.delayMs = 200;
    await expect(calendar.free(MONDAY)).rejects.toThrow(/^the calendar did not answer in time/);
    google.delayMs = 0;
    google.failNext(1, 503);
    await expect(calendar.book(`${MONDAY}:morning`, {}, 'key-1')).rejects.toThrow(/^the calendar is not answering \(503\)/);
    expect(google.events.get(CALENDAR_ID)).toEqual([]);
    expect((await calendar.free(MONDAY)).map((s) => s.window)).toEqual(['morning', 'afternoon']);
  });

  it('a lookup that fails mid-call is said to the model as the failure it is, and no window is offered', async () => {
    const google = new FakeGoogleCalendar({ publicKey, clientEmail: CLIENT_EMAIL, calendars: [CALENDAR_ID] }); // the real time: the sign-in is by it, the business's day 2030's
    const b = readAgentBusiness(CONVERSE_FIXTURE_DIR);
    const calendar = googleCalendar({ calendarId: CALENDAR_ID, keyFile, business: b, fetch: google.fetch, now: () => new Date('2030-01-14T15:00:00Z'), timeoutMs: 50 });
    const app = defineConverseApp(CONVERSE_FIXTURE_DIR, {
      tools: {
        availability: async (p) => (await calendar.free(p.day ?? '')).map((s) => ({ id: s.id, label: s.label })),
        book: async (p, ctx) => `booked (${(await calendar.book(p.window ?? '', { name: p.name ?? '' }, ctx.key)).id})`,
      },
    });
    const model = fakeModel(BOOKING);
    const c = converseTestCall(app, { model, jev: yesJev(), callerNumber: CALLER, now: () => new Date('2030-01-14T15:00:00Z') });
    await c.start();
    google.failNext(1, 500); // the token endpoint, the first thing the lookup asks
    await c.say(`Is there a visit free on ${DAY}?`);
    const results = model.requests[1]!.messages.flatMap((m) => m.content).filter((x) => x.type === 'tool_result');
    expect(results).toEqual([expect.objectContaining({ content: expect.stringMatching(/^Failed: the calendar is not answering \(500\)/) })]);
    expect(JSON.stringify(results)).not.toContain(SLOT);
    expect(c.audit.find((r) => r.type === 'tool_result')?.detail).toMatchObject({ tool: 'availability', ok: false });
  });

  it('a booking confirmed on a chat lands as one event', async () => {
    const NOW = new Date('2030-01-14T15:00:00Z');
    const google = new FakeGoogleCalendar({ publicKey, clientEmail: CLIENT_EMAIL, calendars: [CALENDAR_ID] });
    const b = readAgentBusiness(CONVERSE_FIXTURE_DIR);
    const calendar = googleCalendar({ calendarId: CALENDAR_ID, keyFile, business: b, fetch: google.fetch, now: () => NOW });
    const app = defineConverseApp(CONVERSE_FIXTURE_DIR, {
      tools: {
        availability: async (p) => (await calendar.free(p.day ?? '')).map((s) => ({ id: s.id, label: s.label })),
        book: async (p, ctx) => `booked (${(await calendar.book(p.window ?? '', { name: p.name ?? '' }, ctx.key)).id})`,
      },
    });
    const c = converseTestCall(app, { model: fakeModel(BOOKING), jev: yesJev(), callerNumber: CALLER, now: () => NOW });
    await c.start();
    await c.say(`Is there a visit free on ${DAY}?`);
    await c.say('The morning, for Sam Example, on this number.');
    expect(google.events.get(CALENDAR_ID)).toEqual([]);
    await c.say('yes');
    expect(google.events.get(CALENDAR_ID)).toMatchObject([{ extendedProperties: { private: { slot: SLOT } } }]);
  });

  it('the access token is reused until it nears its expiry', async () => {
    const { google, calendar, clock } = setup();
    await calendar.free(MONDAY);
    await calendar.free(MONDAY);
    await calendar.book(`${MONDAY}:morning`, {}, 'key-1');
    expect(google.tokensIssued).toBe(1);
    clock.set(T0 + (3600 - 61) * 1000); // more than a minute before it expires: the same token
    await calendar.free(MONDAY);
    expect(google.tokensIssued).toBe(1);
    clock.set(T0 + (3600 - 59) * 1000); // within a minute of its expiry: a new one
    await calendar.free(MONDAY);
    expect(google.tokensIssued).toBe(2);
  });

  it('signs in by the real time, whatever the business\'s clock says (an eval or a demo on a day of its own)', async () => {
    let wall = T0;
    const google = new FakeGoogleCalendar({ publicKey, clientEmail: CLIENT_EMAIL, calendars: [CALENDAR_ID], now: () => wall });
    let businessNow = Date.parse('2031-03-03T15:00:00Z'); // a Monday five years on
    const calendar = googleCalendar({ calendarId: CALENDAR_ID, keyFile, business: business(), fetch: google.fetch, now: () => new Date(businessNow), wallClock: () => wall });
    expect((await calendar.free('2031-03-03')).map((s) => s.window)).toEqual(['afternoon']);
    expect(google.tokensIssued).toBe(1);
    // The business's clock moving on is no reason for a new token; the real time nearing its expiry is.
    businessNow += 2 * 3600_000;
    await calendar.free('2031-03-04');
    expect(google.tokensIssued).toBe(1);
    wall = T0 + (3600 - 59) * 1000;
    await calendar.free('2031-03-04');
    expect(google.tokensIssued).toBe(2);
  });

  it('asks for two lookups at once with one token', async () => {
    const { google, calendar } = setup();
    await Promise.all([calendar.free(MONDAY), calendar.free('2026-12-01')]);
    expect(google.tokensIssued).toBe(1);
  });

  it('a token Google no longer takes fails that request, and the next signs in again', async () => {
    const { google, calendar } = setup();
    await calendar.free(MONDAY);
    google.revokeTokens();
    await expect(calendar.free(MONDAY)).rejects.toThrow(/^the calendar refused the line's sign-in/);
    expect((await calendar.free(MONDAY)).length).toBe(2);
    expect(google.tokensIssued).toBe(2);
  });

  it('a calendar Google does not know, or one not shared with the service account, is said so', async () => {
    const google = new FakeGoogleCalendar({ publicKey, clientEmail: CLIENT_EMAIL, calendars: [CALENDAR_ID] });
    const calendar = googleCalendar({ calendarId: 'other@group.calendar.example.com', keyFile, business: business(), fetch: google.fetch, now: () => new Date(T0) });
    await expect(calendar.free(MONDAY)).rejects.toThrow(/^the calendar was not found/);
  });

  it('the key file\'s path is never logged', async () => {
    const said: string[] = [];
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { said.push(a.map(String).join(' ')); });
    const bad = join(dir, 'secret-not-json.json');
    writeFileSync(bad, 'not json at all, PRIVATE');
    const partial = join(dir, 'secret-partial.json');
    writeFileSync(partial, JSON.stringify({ client_email: CLIENT_EMAIL }));
    const errors: string[] = [];
    for (const file of [join(dir, 'secret-missing.json'), bad, partial]) {
      const { calendar } = setup({ keyFile: file });
      errors.push(await calendar.free(MONDAY).then(() => 'no error', (e: unknown) => (e as Error).message));
    }
    expect(errors).toEqual([
      expect.stringMatching(/^the calendar's sign-in is not set up \(its key file cannot be read\)/),
      expect.stringMatching(/^the calendar's sign-in is not set up \(its key file is not a service account's key\)/),
      expect.stringMatching(/^the calendar's sign-in is not set up \(its key file is not a service account's key\)/),
    ]);
    const { calendar } = setup();
    await calendar.free(MONDAY);
    await calendar.book(`${MONDAY}:morning`, {}, 'key-1');
    for (const text of [...said, ...errors]) {
      expect(text).not.toContain(dir);
      expect(text).not.toContain('secret');
      expect(text).not.toContain('PRIVATE');
      expect(text).not.toContain(CLIENT_EMAIL);
    }
  });
});

describe('businessCalendar with agent.yaml\'s google calendar', () => {
  it('reads the key file\'s path from GOOGLE_CALENDAR_KEY_FILE and the calendar\'s id from its env.<NAME>', async () => {
    const google = new FakeGoogleCalendar({ publicKey, clientEmail: CLIENT_EMAIL, calendars: [CALENDAR_ID] });
    const b = business();
    const byEnv: AgentBusiness = { ...b, sources: { ...b.sources, calendar: { ...b.sources.calendar!, calendarId: 'env.VISIT_CALENDAR' } } };
    const env = (name: string): string | undefined => ({ [GOOGLE_CALENDAR_KEY_FILE]: keyFile, VISIT_CALENDAR: CALENDAR_ID } as Record<string, string>)[name];
    const calendar = businessCalendar(byEnv, () => new Date(T0), { env, fetch: google.fetch })!;
    expect((await calendar.free(MONDAY)).map((s) => s.window)).toEqual(['morning', 'afternoon']);
    // Resolved as the server starts (resolveAgentSettings), the id is the setting's value.
    expect(resolveAgentSettings(byEnv, { VISIT_CALENDAR: CALENDAR_ID }).sources.calendar!.calendarId).toBe(CALENDAR_ID);
    expect(() => resolveAgentSettings(byEnv, {})).toThrow(/env\.VISIT_CALENDAR names a setting that is not set/);
  });

  it('says plainly what is missing: the key file\'s setting, or the calendar\'s id', () => {
    const b = business();
    expect(() => businessCalendar(b, () => new Date(T0), { env: () => undefined })).toThrow(/GOOGLE_CALENDAR_KEY_FILE is not set/);
    const byEnv: AgentBusiness = { ...b, sources: { ...b.sources, calendar: { ...b.sources.calendar!, calendarId: 'env.VISIT_CALENDAR' } } };
    expect(() => businessCalendar(byEnv, () => new Date(T0), { env: (n) => (n === GOOGLE_CALENDAR_KEY_FILE ? keyFile : undefined) })).toThrow(/VISIT_CALENDAR is not set/);
  });
});
