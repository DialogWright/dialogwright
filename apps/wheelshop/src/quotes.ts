import { atLeast, DEFAULT_THRESHOLDS, noulValue, type AnswerMap, type IncomingText, type QuestionMap, type TextContext, type Texts } from 'dialogwright';
import {
  BUSINESS, ON_FILE_MS, SHOP_PHONE, WINDOW_NAMES, forwardBody, iso, nameWords, once, onceAsync, opensOn, sendText, tenDigits, textLine,
  type Kept, type Quote, type Systems,
} from './app';

/**
 * Quote and confirm (the maintainer's decisions, 2026-11-08; DESIGN.md "Quote and confirm"): a retail request
 * becomes a booking only once the customer accepts the shop's quote.
 *
 * - **The quote.** On the shop page (src/shopPage.ts) the shop sends a request a price and a drop-off day and
 *   window, offered only where the calendar the dealerships book into has room (sendQuote). Sending holds the
 *   window for the request and texts the customer business.yaml's `texts.quote`, only where the request said yes
 *   to texts; the page says to call any other.
 * - **The reply** (replyToQuote, from onText): read by the decision model (ctx.decide), never by matching the
 *   word: a reply that accepts the quote as offered books the held window and texts `texts.booked`; anything else
 *   is forwarded to the shop's phone, and the hold stays.
 * - **The hold lapses** at 6 pm the day before the drop-off, or 24 hours after the quote, whichever comes first
 *   (lapseDue): the window is released, the shop's phone told. Checked every minute (the server's sweep, which the
 *   shop page's route takes), as the page is drawn, and before a reply is read; each lapse is in the shop's log.
 *   A reply that accepts a lapsed quote still books it while the window has room and the drop-off's 6 pm the day
 *   before has not passed; otherwise the shop is told to call.
 *
 * Every write is once for its key: a quote for the request and its version (the form's), a booking for its quote.
 */

/** How long a quote holds its window at most: 24 hours. */
export const HOLD_MS = 24 * 60 * 60 * 1000;
/** The hour, in the server's time zone, of the day before the drop-off by which a hold lapses and a quote may no longer be booked: 6 pm. */
export const CUTOFF_HOUR = 18;
/** How many days ahead the form offers drop-off windows. */
export const OFFER_DAYS = 14;
/** The most a price may be, in cents ($99,999.99). */
const PRICE_MAX = 9_999_999;

/** The word a customer replies to book (business.yaml's `texts.confirmWord`; CONFIRM where it gives none: not YES, which Twilio takes as an opt-in keyword). */
export function confirmWord(): string {
  const w = BUSINESS.texts?.confirmWord?.trim() ?? '';
  return w === '' ? 'CONFIRM' : w;
}

/**
 * What the decision model is asked of a reply to a quote: typed questions, the reply's words and the quote it
 * answers (TextContext.decide's `about`), never a list of words.
 */
export const QUOTE_QUESTIONS: QuestionMap = {
  acceptsQuote: {
    type: 'noul',
    instructions: 'The business texted the customer the quote in about.quote, asking them to reply with the word in about.replyWord to book it. Is the customer\'s reply (message.words) an acceptance of that quote as offered, asking the business to book it? True where the reply says that word, in any case or with other words around it, or plainly agrees to book it as offered. False where it asks for any change (another day, time or price), asks a question, declines, or says anything else.',
  },
  asksChange: {
    type: 'noul',
    instructions: 'The business texted the customer the quote in about.quote. Does the customer\'s reply (message.words) ask for something other than the quote as offered: another day or time, a different price, an answer to a question, or not to go ahead?',
  },
};

/** Whether the answers accept the quote: a yes at the read-back's bar (CONFIRM_YES), above the reading that it asks for a change. */
export function accepts(answers: AnswerMap | null): boolean {
  if (answers === null) return false;
  const yes = noulValue(answers, 'acceptsQuote');
  return atLeast(yes, DEFAULT_THRESHOLDS.CONFIRM_YES) && yes > noulValue(answers, 'asksChange');
}

/** A day before an ISO date ("2026-11-10" is "2026-11-09"). */
function dayBefore(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/** The local date and hour-and-minute of an instant in a time zone. */
function localParts(ms: number, timeZone: string): { date: string; minutes: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(ms).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

/** Today's date in a time zone. */
export function localDate(ms: number, timeZone: string): string {
  return localParts(ms, timeZone).date;
}

/** The instant a wall clock in a time zone shows `hour`:00 on `day` (daylight saving the zone's). */
export function zonedHour(day: string, hour: number, timeZone: string): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const wanted = Date.UTC(y, m - 1, d, hour);
  let ms = wanted;
  // Two passes: the zone's offset at the guess, then at the answer (a day that changes its clocks).
  for (let i = 0; i < 2; i++) {
    const p = localParts(ms, timeZone);
    const [py, pm, pd] = p.date.split('-').map(Number) as [number, number, number];
    const shown = Date.UTC(py, pm - 1, pd, Math.floor(p.minutes / 60), p.minutes % 60);
    ms += wanted - shown;
  }
  return ms;
}

/** 6 pm the day before a drop-off, in the time zone: the last moment it may be booked. */
export function cutoffOf(day: string, timeZone: string): number {
  return zonedHour(dayBefore(day), CUTOFF_HOUR, timeZone);
}

/** When a quote sent at `atMs` for a drop-off on `day` lapses: 24 hours on, or the cutoff, whichever comes first. */
export function holdUntilOf(atMs: number, day: string, timeZone: string): number {
  return Math.min(atMs + HOLD_MS, cutoffOf(day, timeZone));
}

/** A price as the shop types it ("180", "$180", "1,250.50"), in cents; null for anything else, nothing, or nothing to charge. */
export function parsePrice(text: string): number | null {
  const m = /^\$?\s*(\d{1,3}(?:,\d{3})+|\d{1,7})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (m === null) return null;
  const cents = Number(m[1]!.replace(/,/g, '')) * 100 + Number((m[2] ?? '0').padEnd(2, '0'));
  return cents > 0 && cents <= PRICE_MAX ? cents : null;
}

/** A price in cents as a customer reads it ("$180", "$1,250.50"). */
export function priceWords(cents: string | number): string {
  const n = Number(cents);
  const dollars = Math.floor(n / 100);
  const rest = n % 100;
  return `$${dollars.toLocaleString('en-US')}${rest === 0 ? '' : `.${String(rest).padStart(2, '0')}`}`;
}

/** A drop-off day as a text says it ("Tuesday, Nov 10"). */
export function shortDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'short', day: 'numeric' }).format(Date.UTC(y, m - 1, d));
}

/** A window as a customer's text says it: business.yaml's words for it ("drop off by noon, ready by about 5"). */
export function windowSays(window: string): string {
  return BUSINESS.windows?.find((w) => w.name === window)?.says ?? window;
}

/** The wheels as the quote says them ("wheel", "two wheels"). */
const wheelsWords = (wheels: string | undefined): string => (wheels === undefined || wheels === '' || wheels === 'one' ? 'wheel' : `${wheels} wheels`);

/** The quote's text, in business.yaml's words (`texts.quote`). */
export function quoteText(q: Pick<Quote, 'price' | 'day' | 'window'>, request: Kept): string {
  return textLine('quote', { wheels: wheelsWords(request.wheels), vehicle: request.vehicle ?? '', price: priceWords(q.price), day: shortDay(q.day), window: windowSays(q.window), word: confirmWord() });
}

/** A drop-off window the form offers: the day, the window, and the value the form sends (`<day> <window>`). */
export interface Slot {
  readonly day: string;
  readonly window: string;
  readonly value: string;
}

/**
 * The windows the form offers a request: the next OFFER_DAYS days the shop opens, from today in the time zone,
 * each window with room for a car (the request's own waiting hold counted as room, so it may be quoted again
 * in its own window), and none whose cutoff has passed.
 */
export function offeredSlots(sys: Systems, request: string, nowMs: number, timeZone: string): Slot[] {
  const own = sys.quotesOf(request).filter((q) => sys.statusOf(q) === 'waiting');
  const today = localDate(nowMs, timeZone);
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const slots: Slot[] = [];
  for (let i = 0; i <= OFFER_DAYS; i++) {
    const day = new Date(Date.UTC(y, m - 1, d + i)).toISOString().slice(0, 10);
    if (!opensOn(day) || cutoffOf(day, timeZone) <= nowMs) continue;
    for (const window of WINDOW_NAMES) {
      const room = sys.roomIn(day, window) + own.filter((q) => q.day === day && q.window === window).length;
      if (room >= 1) slots.push({ day, window, value: `${day} ${window}` });
    }
  }
  return slots;
}

/** What the form sends. */
export interface QuoteForm {
  readonly request: string;
  readonly version: string;
  readonly price: string;
  readonly slot: string;
}

/** What sending a quote came to: the quote (and whether it was sent before, a double submit), or why not, with the page's status. */
export type QuoteSent = { ok: true; quote: Quote; repeat: boolean } | { ok: false; status: number; why: string };

/** The write key a form's send is once for: the request and its version (kept as `Q <request> <version>`). */
const quoteKey = (request: string, version: string): string => `${request} ${version}`;

/**
 * Sends a quote from the shop page's form: checked (the request on file and not booked, its yes to texts, the
 * form's version still the request's, the price, a window offered), then kept (its hold taken, any earlier quote
 * of the request superseded) and texted to the customer. Once for the request and version: a second submit of
 * the same form returns the first quote and sends nothing.
 */
export async function sendQuote(sys: Systems, texts: Texts | undefined, form: QuoteForm, nowMs: number, timeZone: string): Promise<QuoteSent> {
  const request = sys.requests.find((r) => r.ref === form.request);
  if (request === undefined) return { ok: false, status: 404, why: 'No such request.' };
  const seen = sys.written.get(`Q ${quoteKey(form.request, form.version)}`);
  if (seen !== undefined) {
    const quote = sys.quotes.find((q) => q.ref === seen);
    if (quote !== undefined) return { ok: true, quote, repeat: true };
  }
  if (sys.requestStatus(request) === 'booked') return { ok: false, status: 409, why: 'This request is booked already.' };
  if (request.textOk !== 'yes') return { ok: false, status: 409, why: 'The caller asked not to be texted: call them to quote.' };
  if (form.version !== String(sys.quotesOf(request.ref).length)) return { ok: false, status: 409, why: 'The request has changed since the page was drawn: refresh the page and send it again.' };
  const cents = parsePrice(form.price);
  if (cents === null) return { ok: false, status: 400, why: 'The price is not an amount: type it in dollars, such as 180 or 180.50.' };
  const slot = offeredSlots(sys, request.ref, nowMs, timeZone).find((x) => x.value === form.slot);
  if (slot === undefined) return { ok: false, status: 409, why: 'That drop-off window is not free (or past its 6 pm the day before): pick another.' };
  const to = tenDigits(request.callbackNumber ?? '');
  let made: Quote | undefined;
  const r = await onceAsync(sys, quoteKey(form.request, form.version), 'Q', sys.quotes.length, nowMs, async (ref) => {
    const quote: Quote = {
      ref, at: iso(nowMs), request: request.ref, version: form.version, price: String(cents), day: slot.day, window: slot.window, to,
      holdUntil: iso(holdUntilOf(nowMs, slot.day, timeZone)), cutoff: iso(cutoffOf(slot.day, timeZone)),
    };
    // Kept before it is texted, so the hold is on file first.
    sys.keep('quote', quote, nowMs);
    made = quote;
    const body = quoteText(quote, request);
    return sendText(sys, texts, nowMs, ref, to, body, body, { key: `quote ${request.ref} ${form.version}` });
  });
  const quote = made ?? sys.quotes.find((q) => q.ref === r.ref)!;
  return { ok: true, quote, repeat: made === undefined };
}

/** The quotes whose hold has ended by `nowMs`, marked lapsed (each on file): their windows are free again. */
export function markLapsed(sys: Systems, nowMs: number): Quote[] {
  const due = sys.quotes.filter((q) => sys.statusOf(q) === 'waiting' && nowMs >= Date.parse(q.holdUntil));
  for (const q of due) sys.keep('quote_state', { ref: q.ref, at: iso(nowMs), state: 'lapsed' }, nowMs);
  return due;
}

/** The request a quote is for (a quote is only ever made for one on file). */
const requestOf = (sys: Systems, q: Quote): Kept => sys.requests.find((r) => r.ref === q.request) ?? { ref: q.request, at: q.at };

/** What the shop's texts say of a quote's customer: their name and their number's last four. */
const who = (sys: Systems, q: Quote): { name: string; last4: string } => ({ name: nameWords(requestOf(sys, q).callerName ?? ''), last4: q.to.slice(-4) });

/** The holds lapsed by now, each marked and the shop's phone told (texts.quoteLapsed). */
export async function lapseDue(sys: Systems, texts: Texts | undefined, env: (name: string) => string | undefined, nowMs: number): Promise<Quote[]> {
  const lapsed = markLapsed(sys, nowMs);
  for (const q of lapsed) {
    const body = textLine('quoteLapsed', { ref: q.ref, ...who(sys, q), day: shortDay(q.day), window: q.window });
    await sendText(sys, texts, nowMs, `T${101 + sys.texts.length}`, env(SHOP_PHONE) ?? '', body, body, { key: `lapsed ${q.ref}` });
  }
  return lapsed;
}

/**
 * The quote a text from `from` answers: the latest quote texted to that number, where it is its request's latest
 * and is waiting, or lapsed within the last week (ON_FILE_MS), so a late yes is still read as one; none otherwise.
 */
export function quoteFor(sys: Systems, from: string, nowMs: number): Quote | undefined {
  const number = tenDigits(from);
  const q = sys.quotes.filter((x) => x.to === number).at(-1);
  if (q === undefined || sys.quotesOf(q.request).at(-1) !== q) return undefined;
  const st = sys.statusOf(q);
  if (st === 'waiting') return q;
  if (st === 'lapsed' && nowMs - Date.parse(q.holdUntil) <= ON_FILE_MS) return q;
  return undefined;
}

/** Books a quote's window from the customer's yes: once for the quote; refused where it lapsed past its cutoff, or the window has no room now. */
export function bookQuote(sys: Systems, q: Quote, nowMs: number): { booking: string } | { refused: 'late' | 'full' } {
  const done = sys.written.get(`B quote ${q.ref}`);
  if (done !== undefined) return { booking: done };
  const waiting = sys.statusOf(q) === 'waiting';
  if (!waiting && nowMs >= Date.parse(q.cutoff)) return { refused: 'late' };
  // The quote's own hold is its room while it waits; a lapsed one takes what the window has left.
  if (sys.roomIn(q.day, q.window) + (waiting ? 1 : 0) < 1) return { refused: 'full' };
  const request = requestOf(sys, q);
  const r = once(sys, `quote ${q.ref}`, 'B', sys.bookings.length, nowMs, (ref) => {
    sys.keep('booking', {
      ref, at: iso(nowMs), quote: q.ref, request: q.request, callerName: request.callerName ?? '', callbackNumber: q.to,
      cars: 'one', vehicles: request.vehicle ?? '', day: q.day, window: q.window, price: q.price,
    }, nowMs);
    return `booking ${ref} from quote ${q.ref}`;
  });
  return { booking: r.ref };
}

/**
 * A customer's text that answers a quote (onText): the decision model asked whether it accepts the quote as
 * offered. A yes books the window (texts.booked to the customer, texts.quoteBooked to the shop), or, where it
 * cannot, tells the shop to call (texts.quoteFull, texts.quoteLate). Anything else, or no reading, goes to the
 * shop's phone as the customer wrote it (texts.quoteReply), and the hold stays.
 */
export async function replyToQuote(sys: Systems, q: Quote, m: IncomingText, ctx: TextContext): Promise<void> {
  const request = requestOf(sys, q);
  const shop = ctx.env(SHOP_PHONE) ?? '';
  const media = m.media.map((x) => x.url);
  const vars = { ref: q.ref, ...who(sys, q), day: shortDay(q.day), window: q.window, vehicle: request.vehicle ?? '', price: priceWords(q.price) };
  const next = (): string => `T${101 + sys.texts.length}`;
  const answers = await ctx.decide(QUOTE_QUESTIONS, { quote: quoteText(q, request), replyWord: confirmWord() });
  if (!accepts(answers)) {
    const line = textLine('quoteReply', vars);
    await sendText(sys, ctx.texts, ctx.nowMs, next(), shop, forwardBody(line, m.body), line, { media });
    return;
  }
  const booked = bookQuote(sys, q, ctx.nowMs);
  if ('refused' in booked) {
    const line = textLine(booked.refused === 'late' ? 'quoteLate' : 'quoteFull', vars);
    await sendText(sys, ctx.texts, ctx.nowMs, next(), shop, forwardBody(line, m.body), line, { media });
    return;
  }
  const toCustomer = textLine('booked', { day: shortDay(q.day), window: windowSays(q.window) });
  await sendText(sys, ctx.texts, ctx.nowMs, next(), m.from, toCustomer, toCustomer, { key: `booked ${q.ref}` });
  const toShop = textLine('quoteBooked', { ...vars, booking: booked.booking });
  await sendText(sys, ctx.texts, ctx.nowMs, next(), shop, toShop, toShop, { key: `booked shop ${q.ref}` });
}
