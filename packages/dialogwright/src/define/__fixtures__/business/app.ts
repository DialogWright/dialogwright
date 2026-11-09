import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineApp, type AppCode } from '../../defineApp';
import { replyShape } from '../../../core/replyShape';
import type { ToolDef } from '../../../core/app/types';

/**
 * Example Library's line in agent mode: the engine's fixture for an app built from business.yaml. The
 * code is its tools and nothing else, each a stand-in: holds and room bookings kept in memory, the desk
 * told by a line printed nowhere, a callback note kept. The forms, slots, prompts, policy and identity
 * are the engine's, built from business.yaml (define/businessFiles.ts, define/businessApp.ts).
 *
 * All names and numbers are invented (the 555 range).
 */

/** The folder this app's YAML is in. */
export const BUSINESS_FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));

/** The app's systems for one call: what was placed, booked and noted, in memory. */
export class LibrarySystems {
  readonly holds: Record<string, string>[] = [];
  readonly bookings: Record<string, string>[] = [];
  readonly notes: Record<string, string>[] = [];
  readonly told: string[] = [];
}

/** The study room's windows, by day: a stand-in calendar where every day has both free but the 14th's afternoon and all of the 21st. */
function freeWindows(day: string): string[] {
  return day.endsWith('-14') ? ['morning'] : day.endsWith('-21') ? [] : ['morning', 'afternoon'];
}

const REQUEST = ['patronName', 'title', 'copies', 'format', 'day', 'window', 'callbackNumber'];
const BOOKING = ['account', 'people', 'day', 'window'];

export const TOOLS: Record<string, ToolDef> = {
  placeHold: {
    params: REQUEST,
    idempotent: true,
    run(call, sys) {
      (sys as LibrarySystems).holds.push({ ...call.params });
      return { value: { ok: true }, summary: 'hold placed' };
    },
  },
  notifyDesk: {
    params: REQUEST,
    idempotent: true,
    run(call, sys) {
      (sys as LibrarySystems).told.push(`hold for ${call.params.patronName ?? ''}`);
      return { value: { ok: true }, summary: 'desk told' };
    },
  },
  bookRoom: {
    params: BOOKING,
    idempotent: true,
    run(call, sys) {
      (sys as LibrarySystems).bookings.push({ ...call.params });
      return { value: { ok: true }, summary: 'room booked' };
    },
  },
  noteCallback: {
    params: ['callbackNumber'],
    idempotent: true,
    run(call, sys) {
      (sys as LibrarySystems).notes.push({ ...call.params });
      return { value: { ok: true }, summary: 'callback noted' };
    },
  },
  // Seen by the agent model once the booking's day is filled: the day and its free windows, in a closed form.
  roomAvailability: {
    params: ['day'],
    run(call) {
      const day = call.params.day ?? '';
      return { value: { day, windows: freeWindows(day) }, summary: `${freeWindows(day).length} windows free` };
    },
    check: replyShape.object({ day: replyShape.isoDate(), windows: replyShape.list(replyShape.oneOf(['morning', 'afternoon'])) }),
  },
};

/** The app's TypeScript parts: its tools, its systems and the gate grid's people. */
export const businessFixtureCode: AppCode = {
  slots: {},
  forms: {},
  tools: TOOLS,
  systems: () => ({ sys: new LibrarySystems(), lookups: { ownerOf: () => null, scopeOf: () => [] } }),
  testing: {
    policyMatrix: () => ({
      principals: {
        subject1: { kind: 'account', level: 1, id: 'rivergate_book_club', first: 'Rivergate Book Club' },
        subject2: { kind: 'account', level: 2, id: 'rivergate_book_club', first: 'Rivergate Book Club' },
        delegates: {},
        unlistedRole: { kind: 'staff', level: 2, id: 'S-1', first: 'Quinn', role: 'assistant' },
        roleless: { kind: 'staff', level: 2, id: 'S-2', first: 'Rowan' },
        otherParty: { kind: 'visitor', level: 2, id: 'V-1', first: 'Robin' },
      },
      records: {
        own: { subject: 'rivergate_book_club' },
        inScope: { subject: 'northside_readers' },
        outOfScope: { subject: 'eastside_circle' },
        unknown: { subject: 'no_such_account' },
      },
      // The grid's caller calls from the book club's number (and, on the other half of the grid, from none).
      callerNumber: '+15555550142',
      calls: {
        lookupAccount: { own: { callerNumber: '+15555550142' }, other: { callerNumber: '+15555550199' } },
      },
      values: { patronName: 'Avery Lane', title: 'The Quiet Harbor', copies: 'two', format: 'print', day: '2026-11-12', window: 'morning', callbackNumber: '5555550144', people: 'four' },
    }),
  },
};

/** The app: the folder joined with the code above. */
export const businessFixtureApp = defineApp(BUSINESS_FIXTURE_DIR, businessFixtureCode);

/** The code parts under the name `dialogwright check` imports them by. */
export const code = businessFixtureCode;
