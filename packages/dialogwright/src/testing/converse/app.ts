import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { businessCalendar, defineConverseApp, type Calendar, type ConverseApp } from '../../converse/app';

/**
 * A tiny converse app the engine's tests of the chat on the converse runtime build (server/converseChat.e2e.test.ts):
 * a visit looked up and booked into a window of a fake calendar, its read-back confirmed by the caller.
 * Its app.yaml lets a chat name the number it is calling from in its context (`chat.callerNumberFromContext`).
 */

/** The fixture's folder: agent.yaml and app.yaml. */
export const CONVERSE_FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));

/** A visit the fixture's `book` was asked to make, with its idempotency key. */
export interface FixtureBooking {
  window: string;
  name: string;
  phone: string;
  key: string;
}

/**
 * The fixture app, with its own calendar (today read from `now`) and the bookings its code was asked to
 * make: one app may be served by one server after another, so a test sees a write repeated across a
 * restart.
 */
export function converseFixture(now: () => Date = () => new Date()): { app: ConverseApp; calendar: Calendar; booked: FixtureBooking[] } {
  const booked: FixtureBooking[] = [];
  let calendar: Calendar | null = null;
  const app = defineConverseApp(CONVERSE_FIXTURE_DIR, {
    tools: {
      availability: async (p) => (await calendar!.free(p.day ?? '')).map((s) => ({ id: s.id, label: s.label })),
      book: async (p, ctx) => {
        booked.push({ window: p.window ?? '', name: p.name ?? '', phone: p.phone ?? '', key: ctx.key });
        const made = await calendar!.book(p.window ?? '', { name: p.name ?? '' }, ctx.key);
        return made.repeat ? `already booked (${made.id})` : `booked (${made.id})`;
      },
    },
  });
  calendar = businessCalendar(app.business, now);
  return { app, calendar: calendar!, booked };
}
