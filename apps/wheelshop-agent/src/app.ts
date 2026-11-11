import { fileURLToPath } from 'node:url';
import { defineConverseApp, type ConverseApp, type ConverseToolImpl, type IncomingText, type TextContext } from 'dialogwright';
import { lapseDue, quoteFor, replyToLapsed, replyToQuote } from './quotes';
import {
  COUNTS, ON_FILE_MS, SHOP_PHONE, Systems, dayWords, forwardBody, iso, last4, once, onceAsync, ownerSummary, sendText, shopConfigOf, slotParts, tenDigits, textLine, usNumber,
} from './shop';
import { SHOP_DATA_DIR } from './shopLog';
import { shopPages } from './shopPage';

/**
 * Example Wheel Works on the converse runtime (docs/designs/2026-11-11-agent-runtime.md): a fictional wheel
 * repair shop's line. Everything about the shop is in agent.yaml beside this src/ folder; a model holds the
 * conversation from it, the runtime reads every change back in the shop's fixed words, runs it only on the
 * caller's yes and puts every action through the gate. This file is the shop's actions and nothing else,
 * each a stand-in on the shop's systems (src/shop.ts):
 *
 * - `recognise_caller`: the dealership account the number calling is on file for (the runtime's state), as a
 *   lookup, so `book_dealer`'s account is held to it before anything is read back.
 * - `check_availability`: the drop-off windows with room on a day, from the shop's fake calendar.
 * - `send_request`: a retail caller's request, kept, taking a place in the window they picked. On the yes it
 *   is followed by `send_photo_request` (a text asking for a photo, which the gate lets run only with the
 *   caller's yes to texts, never this code) and `notify_shop_request` (the shop's summary).
 * - `book_dealer`: a dealership's cars booked into a window, followed by `notify_shop_booking`. Its account is
 *   one `recognise_caller` returned (a slot param, checked by the runtime); its cars must fit the window's room
 *   now (the calendar refuses otherwise, as a real one would).
 * - `leave_callback`: a note for the shop to call the caller back, texted to the shop.
 * - `onText`: a text that comes in: a reply to a quote the shop sent from its page (src/quotes.ts), or a
 *   photo sent on to the shop's phone with the request it is for.
 *
 * The shop's texts go to its phone, the app's own setting SHOP_PHONE (ctx.env, never agent.yaml); unset, or
 * where the server has no sender, each is printed. Every write passes its idempotency key (ctx.key), so a
 * call repeated after a restart is done once. All names and numbers are invented (the 555 range).
 */

/** The app's folder: the one with app.yaml and agent.yaml, above this src/. */
export const APP_DIR = fileURLToPath(new URL('..', import.meta.url));

/** The app's id, as app.yaml names it: its pages are mounted under /<id>. */
const APP_ID = 'wheelshop-agent';

/** Whether a request's wheel is diamond cut, as the shop page and its summary say it: from the finish the caller described. */
const DIAMOND_CUT: Readonly<Record<string, string>> = { 'diamond cut': 'yes', painted: 'no', 'not sure': 'not sure' };

/** The details of a request, for the shop's summary. */
function requestDetails(p: Readonly<Record<string, string>>): string {
  const diamond = p.finish === 'diamond cut' ? ', diamond cut' : p.finish === 'not sure' ? ', not sure if diamond cut' : '';
  return `${p.vehicle ?? ''}, ${p.damage ?? ''}, ${p.wheels ?? ''} wheel${p.wheels === 'one' ? '' : 's'}${diamond}${(p.notes ?? '') === '' ? '' : `; note: ${p.notes}`}`;
}

/** A request or a booking that takes room the window has not got: the calendar refuses it, as a real one would. */
class NoRoom extends Error {}

/** The actions' code, on the shop's systems. Each write is done once for its key (ctx.key). */
export function shopTools(sys: Systems): Record<string, ConverseToolImpl> {
  /** A window's room checked for `cars` before a write, unless the write was done already under its key (a repeat). */
  const room = (key: string, prefix: string, slot: string, cars: number): { day: string; window: string } => {
    const at = slotParts(slot);
    if (!sys.written.has(`${prefix} ${key}`) && sys.roomIn(at.day, at.window) < cars) {
      throw new NoRoom(`${at.day} ${at.window} has room for ${Math.max(0, sys.roomIn(at.day, at.window))} now, not ${cars}: look again with check_availability and offer another window`);
    }
    return at;
  };
  return {
    // The account the number calling is on file for (the runtime matched it as the call started), as the lookup book_dealer's account comes from.
    recognise_caller: async (_p, ctx) => (ctx.caller.account ? [{ id: ctx.caller.account, label: ctx.caller.account }] : []),

    check_availability: async (p) => sys.free(p.day ?? ''),

    // Kept with the caller's words, the callback number by its ten digits (as the shop page and onText read it),
    // and a place taken in the window picked until the shop quotes it.
    send_request: async (p, ctx) => {
      const { day, window } = room(ctx.key, 'R', p.slot ?? '', 1);
      const nowMs = sys.now();
      const r = once(sys, ctx.key, 'R', sys.requests.length, nowMs, (ref) => {
        sys.keep('request', {
          ref, at: iso(nowMs), callerName: p.name ?? '', vehicle: p.vehicle ?? '', wheels: p.wheels ?? '', damage: p.damage ?? '', diamondCut: DIAMOND_CUT[p.finish ?? ''] ?? '', finish: p.finish ?? '',
          day, window, callbackNumber: tenDigits(p.callbackNumber ?? ''), textOk: p.textOk ?? '', ...((p.notes ?? '') === '' ? {} : { notes: p.notes! }),
        }, nowMs);
        return `request ${ref} sent for ${day} ${window}`;
      });
      return r.summary;
    },

    // The caller is asked to reply with a photo. The gate lets this run only where the caller said yes to being
    // texted (agent.yaml's oneOf rule on textOk): this code never checks the consent itself.
    send_photo_request: async (p, ctx) => {
      const nowMs = sys.now();
      const body = textLine('photoRequest');
      return (await onceAsync(sys, ctx.key, 'P', sys.texts.length, nowMs, (ref) => sendText(sys, ctx.texts, nowMs, ref, p.callbackNumber ?? '', body, body, { key: ctx.key }))).summary;
    },

    notify_shop_request: async (p, ctx) => {
      const nowMs = sys.now();
      const { day, window } = slotParts(p.slot ?? '');
      const vars = { kind: 'request', who: p.name ?? '', details: requestDetails(p), day: dayWords(day), window };
      const number = tenDigits(p.callbackNumber ?? '');
      return (await onceAsync(sys, ctx.key, 'N', sys.texts.length, nowMs, (ref) =>
        sendText(sys, ctx.texts, nowMs, ref, ctx.env(SHOP_PHONE) ?? '', ownerSummary({ ...vars, callbackNumber: number }), ownerSummary({ ...vars, callbackNumber: last4(number) }), { key: ctx.key }))).summary;
    },

    // The account is one recognise_caller returned (the runtime holds the slot param to it before the read-back).
    book_dealer: async (p, ctx) => {
      const cars = COUNTS[p.cars ?? ''] ?? 1;
      const { day, window } = room(ctx.key, 'B', p.slot ?? '', cars);
      const nowMs = sys.now();
      return once(sys, ctx.key, 'B', sys.bookings.length, nowMs, (ref) => {
        sys.keep('booking', { ref, at: iso(nowMs), account: p.account ?? '', cars: p.cars ?? '', vehicles: p.vehicles ?? '', day, window }, nowMs);
        return `booking ${ref}: ${p.cars ?? ''} cars for ${p.account ?? ''}, ${day} ${window}`;
      }).summary;
    },

    notify_shop_booking: async (p, ctx) => {
      const nowMs = sys.now();
      const { day, window } = slotParts(p.slot ?? '');
      const account = sys.accountOf(p.account ?? '');
      // The account's own number is the business's record, not a caller's: in the summary whole.
      const summary = ownerSummary({ kind: 'booking', who: account.name, callbackNumber: account.number, details: `${p.cars ?? ''} cars${(p.vehicles ?? '') === '' ? '' : `, ${p.vehicles ?? ''}`}`, day: dayWords(day), window });
      return (await onceAsync(sys, ctx.key, 'N', sys.texts.length, nowMs, (ref) => sendText(sys, ctx.texts, nowMs, ref, ctx.env(SHOP_PHONE) ?? '', summary, summary, { key: ctx.key }))).summary;
    },

    leave_callback: async (p, ctx) => {
      const nowMs = sys.now();
      const number = tenDigits(p.callbackNumber ?? '');
      return (await onceAsync(sys, ctx.key, 'C', sys.callbacks.length, nowMs, async (ref) => {
        sys.keep('callback', { ref, at: iso(nowMs), name: p.name ?? '', callbackNumber: number, about: p.about ?? '', ...((p.notes ?? '') === '' ? {} : { notes: p.notes! }) }, nowMs);
        const vars = { name: p.name ?? '', about: (p.notes ?? '') === '' ? p.about ?? '' : `${p.about ?? ''} (note: ${p.notes})`, ref };
        await sendText(sys, ctx.texts, nowMs, ref, ctx.env(SHOP_PHONE) ?? '', textLine('callbackNote', { ...vars, number }), textLine('callbackNote', { ...vars, number: last4(number) }), { key: ctx.key });
        return `callback note ${ref} for ${last4(number)}`;
      })).summary;
    },
  };
}

/**
 * A text that came in to the shop's number (ConverseApp.onText). First the holds whose time is up lapse; then a
 * text with words from the number a quote is waiting on is a reply to it, read by the decision model
 * (src/quotes.ts replyToQuote), and one to a quote lapsed lately goes to the shop to call (replyToLapsed).
 * Otherwise it is sent on to the shop's phone as it came, its photos attached by their URLs (the engine fetches
 * none). From a number with a request on file in the last week, with a line naming the request, and, where it
 * brought a photo and the request said yes to being texted and is not yet quoted, the caller thanked in the
 * shop's words; from any other number, as a text with no request on file.
 */
export async function shopOnText(s: Systems, m: IncomingText, ctx: TextContext): Promise<void> {
  await lapseDue(s, ctx.texts, ctx.env, ctx.nowMs);
  const number = usNumber(m.from);
  const found = number === null ? undefined : s.onFile.get(number);
  const recent = found !== undefined && ctx.nowMs - found.atMs <= ON_FILE_MS ? found : undefined;
  const quote = quoteFor(s, m.from, ctx.nowMs);
  const media = m.media.map((x) => x.url);
  const request = quote?.request ?? recent?.ref;
  s.keep('received', { ref: `I${101 + s.received.length}`, at: iso(ctx.nowMs), from: m.from, text: m.body, media, ...(request !== undefined ? { request } : {}) }, ctx.nowMs);
  if (quote !== undefined && m.body.trim() !== '') {
    if (s.statusOf(quote) === 'waiting') await replyToQuote(s, quote, m, ctx);
    else await replyToLapsed(s, quote, m, ctx);
    return;
  }
  const vars = { name: recent?.name ?? '', last4: m.from.replace(/\D/g, '').slice(-4), vehicle: recent?.vehicle ?? '' };
  const line = recent === undefined ? textLine('unknownForward', vars) : textLine(media.length > 0 ? 'photoForward' : 'textForward', vars);
  await sendText(s, ctx.texts, ctx.nowMs, s.nextRef('T', s.texts.length), ctx.env(SHOP_PHONE) ?? '', forwardBody(line, m.body), line, { media });
  // The thank-you promises a price, so it goes only before the request is quoted, and to the number on file.
  if (recent !== undefined && number !== null && recent.textOk === 'yes' && media.length > 0 && s.quotesOf(recent.ref).length === 0) await sendText(s, ctx.texts, ctx.nowMs, s.nextRef('T', s.texts.length), `+1${number}`, textLine('photoThanks'), textLine('photoThanks'));
}

/** What the app is made with: the clock its systems read (the server's, or a test's). */
export interface WheelshopOptions {
  now?: () => number;
  /**
   * Keep the shop's records in memory alone, whatever SHOP_DATA_DIR says: the app made fresh for a simulated
   * call (`fresh`), which must never read the shop's log back nor write a pretend request into it.
   */
  inMemory?: boolean;
}

/**
 * The app and its systems: one per server (index.ts), one per test, one per simulated call (`fresh`). Nothing
 * is read from the process as it is made: agent.yaml's references (env.DEALER_TEST_LINE) are read by the server
 * from the app's own settings as it starts, and the shop page is made then too, with the app's settings, its
 * sender and the server's clock and log.
 */
export function wheelshop(o: WheelshopOptions = {}): { app: ConverseApp; sys: Systems } {
  const sys = new Systems(o.now);
  const app = defineConverseApp(APP_DIR, {
    tools: shopTools(sys),
    onText: (m, ctx) => shopOnText(sys, m, ctx),
    pages: (deps) => shopPages(sys, {
      brand: { name: 'Example Wheel Works', mark: 'EW' }, base: deps.base, env: o.inMemory === true ? (name) => (name === SHOP_DATA_DIR ? undefined : deps.env(name)) : deps.env, now: deps.now, log: deps.log,
      publicHost: deps.publicHost, signOut: deps.consoleSignIn, ...(deps.texts !== undefined ? { texts: deps.texts } : {}),
    }),
    fresh: () => wheelshop({ ...o, inMemory: true }).app,
  });
  // The systems read the calendar, the time zone and the accounts from agent.yaml, once it is joined to the code.
  sys.configure(shopConfigOf(app.business));
  return { app, sys };
}
