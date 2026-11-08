import { fileURLToPath } from 'node:url';
import { defineApp, describeDay, loadBusiness, optionKey, parseIso, replyShape, type AppCode, type BusinessYaml, type ToolDef } from 'dialogwright';

/**
 * Example Wheel Works, in agent mode: a fictional one-man wheel repair shop's line. Everything about the
 * shop is in business.yaml, beside this src/ folder: who it is and how it sounds, what it does and
 * doesn't do, its claims, its days and drop-off windows, its dealership accounts, what a request, a
 * booking and a callback note collect, and every line said in fixed words. The engine builds the app
 * from that file (its intents, forms, slots, prompts, policy and identity), and a model leads the
 * conversation from it. This file is the shop's tools and nothing else, each a stand-in:
 *
 * - `availability`: the free drop-off windows on a day, from a calendar held in memory, two windows a
 *   weekday each with the capacity business.yaml gives. Its result is shown to the model (business.yaml's
 *   `sees`), so its reply check is closed: the day, and the windows by name.
 * - `request`, `book`, `callback`: the writes a read-back's yes makes, kept in memory.
 * - `send_photo_link` and the owner's notices (`notify_owner_request`, `notify_owner_booking`): texts,
 *   printed (never sent) until texting is registered, the owner's summary filled from business.yaml's
 *   fixed template. Each is shown in the trace by its summary, the caller's number by its last four.
 *
 * Every write is idempotent: a call repeated with the same key (a restart, a call taken over) is done
 * once. Policy is never here: the gate decides, from what the engine built from business.yaml, whether
 * a tool may run. All names and numbers are invented (the 555 range); the link is example.com's.
 * `dialogwright check` imports this module and checks the folder against `code`.
 */

/** The app's folder: the one with app.yaml and business.yaml, above this src/. */
export const APP_DIR = fileURLToPath(new URL('..', import.meta.url));

/** The shop's facts, as business.yaml says them: the windows' capacity, the days, the accounts, the owner's number and summary. */
function readBusiness(): BusinessYaml {
  const read = loadBusiness(APP_DIR);
  if (read.business === null) throw new Error(`business.yaml: ${read.problems.map((p) => `${p.path}: ${p.message}`).join('; ')}`);
  return read.business;
}
export const BUSINESS = readBusiness();

/** The drop-off windows by name, in business.yaml's order. */
export const WINDOW_NAMES: readonly string[] = (BUSINESS.windows ?? []).map((w) => w.name);

const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

/** A choice's words as a count ("three" is 3). */
const COUNTS: Readonly<Record<string, number>> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };

/**
 * The stand-in calendar's one booking already in: a standing dealership drop-off that fills every Friday
 * morning, so the demo has a full window to meet. Every other window starts empty.
 */
export function standingCars(day: string, window: string): number {
  return WEEKDAY_NAMES[new Date(parseIso(day)).getUTCDay()] === 'friday' && window === 'morning' ? capacityOf('morning') : 0;
}

/** How many cars a window takes (business.yaml's capacity; a window that gives none takes any number). */
function capacityOf(window: string): number {
  return BUSINESS.windows?.find((w) => w.name === window)?.capacity ?? Number.POSITIVE_INFINITY;
}

/** Whether the shop works on a day (business.yaml's days). */
function opensOn(day: string): boolean {
  return (BUSINESS.days ?? []).includes(WEEKDAY_NAMES[new Date(parseIso(day)).getUTCDay()]! as never);
}

/** A record a write kept, by its params, with its reference. */
export type Kept = Readonly<Record<string, string>> & { readonly ref: string };

/** A text the line would send, printed until texting is registered: whole here, masked where it is printed or recorded. */
export interface Text {
  ref: string;
  to: string;
  text: string;
}

/** Whether the texts are printed to the log (the server and the text harness turn it on; the tests and the regression stay quiet). */
let printing = false;
export function printTexts(on: boolean): void {
  printing = on;
}

/**
 * The app's systems for one call (App.systems builds a fresh one per call): the stand-in calendar (the
 * cars booked into each window, beside the standing drop-off), the requests, bookings and callback notes
 * kept, the texts the line would send, and each write's key, so a write repeated is done once. Replace
 * these with clients for the shop's real calendar and a texting service once the owner says what he uses.
 */
export class Systems {
  readonly requests: Kept[] = [];
  readonly bookings: Kept[] = [];
  readonly callbacks: Kept[] = [];
  readonly texts: Text[] = [];
  /** The cars booked into each window on this calendar, by `<day> <window>`. */
  readonly booked = new Map<string, number>();
  /** The reference each write's key was given. */
  readonly written = new Map<string, string>();

  /** The windows with room left on a day: none on a day the shop is closed. */
  freeWindows(day: string): string[] {
    if (!opensOn(day)) return [];
    return WINDOW_NAMES.filter((w) => this.roomIn(day, w) > 0);
  }

  /** The cars a window has room for on a day: none on a day the shop is closed or in a window it does not have. */
  roomIn(day: string, window: string): number {
    if (!opensOn(day) || !WINDOW_NAMES.includes(window)) return 0;
    return capacityOf(window) - standingCars(day, window) - (this.booked.get(`${day} ${window}`) ?? 0);
  }
}

/** A number as it is recorded and printed: by its last four ("...0177"). */
const last4 = (digits: string): string => `...${digits.slice(-4)}`;

/** The owner's summary (business.yaml's owner.summary), filled: a fixed template, never a generated line. */
export function ownerSummary(vars: Readonly<Record<string, string>>): string {
  const template = BUSINESS.owner?.summary ?? '';
  return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_whole, v: string) => vars[v] ?? '');
}

/** The account a booking is for, by its key (the account slot's value): its name and the first number it calls from. */
function accountOf(key: string): { name: string; number: string } {
  const a = (BUSINESS.accounts ?? []).find((x) => optionKey(x.name) === key);
  return { name: a?.name ?? key, number: (a?.numbers[0] ?? '').replace(/^\+1/, '') };
}

/** A name as the owner reads it: the name slot keeps it in lower case ("jordan lee" is Jordan Lee). */
const nameWords = (name: string): string => name.replace(/(^|[\s'-])(\p{Ll})/gu, (_m, b: string, c: string) => b + c.toUpperCase());

/** A day as the owner reads it ("Wednesday, November 11"). */
const dayWords = (iso: string): string => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? describeDay(iso) : iso);

/**
 * A write done once for its key: `make` runs the first time and its reference is kept; a call repeated
 * with the same key returns the same reference and does nothing again.
 */
function once(sys: Systems, key: string | undefined, prefix: string, count: number, make: (ref: string) => string): { value: { ref: string }; summary: string; ref: string } {
  const seen = key === undefined ? undefined : sys.written.get(`${prefix} ${key}`);
  if (seen !== undefined) return { value: { ref: seen }, summary: `${seen} (already done)`, ref: seen };
  const ref = `${prefix}${101 + count}`;
  const summary = make(ref);
  if (key !== undefined) sys.written.set(`${prefix} ${key}`, ref);
  return { value: { ref }, summary, ref };
}

/** A text the line would send: kept whole, printed and summarized with the caller's number by its last four. */
function text(sys: Systems, ref: string, to: string, body: string, masked: string): string {
  sys.texts.push({ ref, to, text: body });
  const line = `text to ${to.startsWith('+') ? to : last4(to)} (printed, not sent): ${masked}`;
  if (printing) console.log(`[wheelshop] ${line}`);
  return line;
}

/** The params every call a form makes carries: its fields by name (and a booking's account first). */
const REQUEST = ['callerName', 'vehicle', 'wheels', 'damage', 'diamondCut', 'day', 'window', 'callbackNumber'];
const BOOKING = ['account', 'cars', 'vehicles', 'day', 'window'];

/** A write's reply: its reference, a code. */
const REF = replyShape.object({ ref: replyShape.code() });

/** The details of a request, for the owner's summary. */
function requestDetails(p: Readonly<Record<string, string>>): string {
  const diamond = p.diamondCut === 'yes' ? ', diamond cut' : p.diamondCut === 'not_sure' ? ', not sure if diamond cut' : '';
  return `${p.vehicle ?? ''}, ${p.damage ?? ''}, ${p.wheels ?? ''} wheel${p.wheels === 'one' ? '' : 's'}${diamond}`;
}

/** Every tool, by name: each is one business.yaml names (a form's then, or a field's sees). */
export const TOOLS: Record<string, ToolDef> = {
  // Shown to the model once a day is filled: the day and its windows with room left, in a closed form.
  availability: {
    params: ['day'],
    run(call, sys) {
      const day = call.params.day ?? '';
      const windows = (sys as Systems).freeWindows(day);
      return { value: { day, windows }, summary: windows.length === 0 ? `${day}: no window free` : `${day}: ${windows.join(' and ')} free` };
    },
    check: replyShape.object({ day: replyShape.isoDate(), windows: replyShape.list(replyShape.oneOf(WINDOW_NAMES)) }),
  },

  request: {
    params: REQUEST,
    idempotent: true,
    run(call, sys, { idempotencyKey }) {
      const s = sys as Systems;
      return once(s, idempotencyKey, 'R', s.requests.length, (ref) => {
        s.requests.push({ ...call.params, ref });
        return `request ${ref} for ${call.params.day ?? ''} ${call.params.window ?? ''}`;
      });
    },
    check: REF,
  },

  send_photo_link: {
    params: REQUEST,
    idempotent: true,
    run(call, sys, { idempotencyKey }) {
      const s = sys as Systems;
      const to = call.params.callbackNumber ?? '';
      return once(s, idempotencyKey, 'P', s.texts.length, (ref) => {
        const body = `${BUSINESS.business.says ?? BUSINESS.business.name}: send ${BUSINESS.business.owner ?? 'us'} a photo of the damage at https://example.com/photo/${ref}`;
        return text(s, ref, to, body, body);
      });
    },
    check: REF,
  },

  notify_owner_request: {
    params: REQUEST,
    idempotent: true,
    run(call, sys, { idempotencyKey }) {
      const s = sys as Systems;
      const p = call.params;
      const vars = { kind: 'request', who: nameWords(p.callerName ?? ''), details: requestDetails(p), day: dayWords(p.day ?? ''), window: p.window ?? '' };
      return once(s, idempotencyKey, 'N', s.texts.length, (ref) =>
        text(s, ref, BUSINESS.owner?.number ?? '', ownerSummary({ ...vars, callbackNumber: p.callbackNumber ?? '' }), ownerSummary({ ...vars, callbackNumber: last4(p.callbackNumber ?? '') })));
    },
    check: REF,
  },

  book: {
    params: BOOKING,
    idempotent: true,
    run(call, sys, { idempotencyKey }) {
      const s = sys as Systems;
      const p = call.params;
      // The calendar refuses a window without room for the cars, as a real one would (the gate does not
      // know the calendar): nothing is booked, and its reply is no reference, so the call goes to Sam.
      const repeat = idempotencyKey !== undefined && s.written.has(`B ${idempotencyKey}`);
      if (!repeat && s.roomIn(p.day ?? '', p.window ?? '') < (COUNTS[p.cars ?? ''] ?? 1)) {
        return { value: { full: true }, summary: `${p.day ?? ''} ${p.window ?? ''}: no room for ${p.cars ?? ''} cars, not booked` };
      }
      return once(s, idempotencyKey, 'B', s.bookings.length, (ref) => {
        s.bookings.push({ ...p, ref });
        const at = `${p.day ?? ''} ${p.window ?? ''}`;
        s.booked.set(at, (s.booked.get(at) ?? 0) + (COUNTS[p.cars ?? ''] ?? 1));
        return `booking ${ref}: ${p.cars ?? ''} cars for ${p.account ?? ''}, ${at}`;
      });
    },
    check: REF,
  },

  notify_owner_booking: {
    params: BOOKING,
    idempotent: true,
    run(call, sys, { idempotencyKey }) {
      const s = sys as Systems;
      const p = call.params;
      const account = accountOf(p.account ?? '');
      const summary = ownerSummary({ kind: 'booking', who: account.name, callbackNumber: account.number, details: `${p.cars ?? ''} cars, ${p.vehicles ?? ''}`, day: dayWords(p.day ?? ''), window: p.window ?? '' });
      // The account's own number is the business's record, not a caller's: printed whole.
      return once(s, idempotencyKey, 'N', s.texts.length, (ref) => text(s, ref, BUSINESS.owner?.number ?? '', summary, summary));
    },
    check: REF,
  },

  callback: {
    params: ['callbackNumber'],
    idempotent: true,
    run(call, sys, { idempotencyKey }) {
      const s = sys as Systems;
      const number = call.params.callbackNumber ?? '';
      return once(s, idempotencyKey, 'C', s.callbacks.length, (ref) => {
        s.callbacks.push({ ...call.params, ref });
        const body = `Call back ${number} (callback note ${ref}).`;
        text(s, ref, BUSINESS.owner?.number ?? '', body, `Call back ${last4(number)} (callback note ${ref}).`);
        return `callback note ${ref} for ${last4(number)}`;
      });
    },
    check: REF,
  },
};

/** The app's TypeScript parts: its tools, its systems and the gate grid's people. */
export const code: AppCode = {
  slots: {},
  forms: {},
  tools: TOOLS,
  systems: () => ({ sys: new Systems(), lookups: { ownerOf: () => null, scopeOf: () => [] } }),
  testing: {
    // A corpus line spoken mid-call (fixtures/corpus.jsonl) is seeded with a dealership account recognized by its
    // number (it may book and send a request alike) and these stand-ins, by the slots the engine builds from
    // business.yaml (<form>_<field>). A corpus line is the decision model's alone: in agent mode it runs without
    // the agent, so it holds what the decision model reads on every turn (the request, the yes or no).
    seed: {
      caller: () => ({ kind: 'account', level: 1, id: 'rivergate_motors', first: 'Rivergate Motors' }),
      placeholders: {
        account: { value: 'rivergate_motors', display: 'Rivergate Motors' },
        request_callerName: { value: 'jordan lee', display: 'Jordan Lee' },
        request_vehicle: { value: '2020 BMW 3 Series', display: '2020 BMW 3 Series' },
        request_wheels: { value: 'one', display: 'one' },
        request_damage: { value: 'curb rash', display: 'curb rash' },
        request_diamondCut: { value: 'yes', display: 'yes' },
        request_day: { value: '2026-11-12', display: 'Thursday, November 12' },
        request_window: { value: 'morning', display: 'morning' },
        request_callbackNumber: { value: '5555550177', display: '555 555 0177' },
        booking_cars: { value: 'three', display: 'three' },
        booking_vehicles: { value: '2019 Civic, Tacoma, 2021 Model 3', display: '2019 Civic, Tacoma, 2021 Model 3' },
        booking_day: { value: '2026-11-11', display: 'Wednesday, November 11' },
        booking_window: { value: 'morning', display: 'morning' },
        callback_callbackNumber: { value: '5555550177', display: '555 555 0177' },
      },
      callerNumber: '+15555550142',
    },
    policyMatrix: () => ({
      principals: {
        subject1: { kind: 'account', level: 1, id: 'rivergate_motors', first: 'Rivergate Motors' },
        subject2: { kind: 'account', level: 2, id: 'rivergate_motors', first: 'Rivergate Motors' },
        delegates: {},
        unlistedRole: { kind: 'staff', level: 2, id: 'S-1', first: 'Quinn', role: 'assistant' },
        roleless: { kind: 'staff', level: 2, id: 'S-2', first: 'Rowan' },
        otherParty: { kind: 'visitor', level: 2, id: 'V-1', first: 'Robin' },
      },
      records: {
        own: { subject: 'rivergate_motors' },
        inScope: { subject: 'northside_auto_sales' },
        outOfScope: { subject: 'eastside_motors' },
        unknown: { subject: 'no_such_account' },
      },
      // The grid's caller calls from Rivergate Motors' number (and, on the other half of the grid, from none).
      callerNumber: '+15555550142',
      calls: {
        lookupAccount: { own: { callerNumber: '+15555550142' }, other: { callerNumber: '+15555550199' } },
      },
      values: {
        callerName: 'Jordan Lee', vehicle: '2020 BMW 3 Series', wheels: 'one', damage: 'curb rash', diamondCut: 'yes',
        day: '2026-11-12', window: 'morning', callbackNumber: '5555550177', cars: 'three', vehicles: '2019 Civic, Tacoma, 2021 Model 3',
      },
    }),
  },
};

/** The app: the folder joined with the code above. */
export const app = defineApp(APP_DIR, code, { codeFile: 'src/app.ts' });
