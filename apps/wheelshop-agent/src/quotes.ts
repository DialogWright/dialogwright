import { atLeast, DEFAULT_THRESHOLDS, noulValue, sameNumber, type AnswerMap, type IncomingText, type QuestionMap, type TextContext, type Texts } from 'dialogwright';
import {
  NOT_SENT, ON_FILE_MS, SHOP_PHONE, deliver, forwardBody, iso, nameWords, once, onceAsync, sendText, tenDigits, textLine,
  type Kept, type Quote, type Systems,
} from './shop';
import { SHOP_TEXTS } from './shopTexts';

/**
 * Quote and confirm (the maintainer's decisions, 2026-11-08, calls 52 and 53; DESIGN.md "Quote and confirm"): a
 * retail request becomes a booking only once the customer accepts the shop's quote.
 *
 * - **The quote.** On the shop page (src/shopPage.ts) the shop sends a request a price and a drop-off day and
 *   window, offered only where the calendar the dealerships book into has room (sendQuote). Sending holds the
 *   window for the request and texts the customer SHOP_TEXTS.quote, only where the request said yes
 *   to texts; the page says to call any other. The shop may withdraw a waiting quote (withdrawQuote).
 * - **The reply** (replyToQuote, from onText): to a waiting quote only, read by the decision model (ctx.decide),
 *   never by matching the word: a reply that accepts the quote as offered books the held window and texts
 *   `texts.booked` to the number that consented; anything else is forwarded to the shop's phone, and the hold
 *   stays. A reply to a lapsed quote is never read and never books: it goes to the shop to call (call 53).
 * - **The hold lapses** at 6 pm the day before the drop-off, or 24 hours after the quote, whichever comes first
 *   (lapseDue): the window is released, the shop's phone told. Checked every minute (the server's sweep, which the
 *   shop page's route takes), as the page is drawn, and before a reply is read; each lapse is in the shop's log.
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

/** The word a customer replies to book (SHOP_TEXTS.confirmWord; CONFIRM where it gives none: not YES, which Twilio takes as an opt-in keyword). */
export function confirmWord(): string {
  const w = SHOP_TEXTS.confirmWord.trim();
  return w === '' ? 'CONFIRM' : w;
}

/**
 * What the decision model is asked of a reply to a quote: typed questions, the reply's words and the quote it
 * answers (TextContext.decide's `about`), never a list of words.
 */
export const QUOTE_QUESTIONS: QuestionMap = {
  acceptsQuote: {
    type: 'noul',
    instructions: 'The business texted the customer the quote in about.quote, which asks them to reply about.replyWord to book it. Does the customer\'s reply (message.words) accept the quote as offered and ask the business to book it?',
  },
  asksChange: {
    type: 'noul',
    instructions: 'The business texted the customer the quote in about.quote. Does the customer\'s reply (message.words) ask for something other than the quote as offered: another day or time, a different price, an answer to a question, or not to go ahead?',
  },
};

/** The most `asksChange` may read for a reply to book (call 53). */
export const CHANGE_BELOW = 0.5;

/** Whether the answers accept the quote: `acceptsQuote` at the read-back's bar (CONFIRM_YES), above `asksChange`, and `asksChange` under CHANGE_BELOW. */
export function accepts(answers: AnswerMap | null): boolean {
  if (answers === null) return false;
  const yes = noulValue(answers, 'acceptsQuote');
  const change = noulValue(answers, 'asksChange');
  return atLeast(yes, DEFAULT_THRESHOLDS.CONFIRM_YES) && yes > change && change < CHANGE_BELOW;
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

/** A window as a customer's text says it: agent.yaml's label for it ("afternoon, by noon"). */
export function windowSays(sys: Systems, window: string): string {
  return sys.windowSays(window);
}

/** The wheels as the quote says them ("wheel", "two wheels"). */
const wheelsWords = (wheels: string | undefined): string => (wheels === undefined || wheels === '' || wheels === 'one' ? 'wheel' : `${wheels} wheels`);

/** The quote's text, in the shop's words (SHOP_TEXTS.quote). */
export function quoteText(sys: Systems, q: Pick<Quote, 'price' | 'day' | 'window'>, request: Kept): string {
  return textLine('quote', { wheels: wheelsWords(request.wheels), vehicle: request.vehicle ?? '', price: priceWords(q.price), day: shortDay(q.day), window: windowSays(sys, q.window), word: confirmWord() });
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
  // A request not yet quoted holds the place its caller picked: room for it to be quoted there.
  const mine = sys.quotesOf(request).length === 0 ? sys.requests.find((r) => r.ref === request) : undefined;
  const today = localDate(nowMs, timeZone);
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const slots: Slot[] = [];
  for (let i = 0; i <= OFFER_DAYS; i++) {
    const day = new Date(Date.UTC(y, m - 1, d + i)).toISOString().slice(0, 10);
    if (!sys.opensOn(day) || cutoffOf(day, timeZone) <= nowMs) continue;
    for (const window of sys.windowNames) {
      const room = sys.roomIn(day, window) + own.filter((q) => q.day === day && q.window === window).length + (mine?.day === day && mine.window === window ? 1 : 0);
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
    const body = quoteText(sys, quote, request);
    return sendText(sys, texts, nowMs, ref, `+1${to}`, body, body, { key: `quote ${request.ref} ${form.version}` });
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

/** The holds lapsed by now, each marked and the shop's phone told (texts.quoteLapsed): the lapse on file before the text. */
export async function lapseDue(sys: Systems, texts: Texts | undefined, env: (name: string) => string | undefined, nowMs: number): Promise<Quote[]> {
  const lapsed = markLapsed(sys, nowMs);
  for (const q of lapsed) {
    const body = textLine('quoteLapsed', { ref: q.ref, ...who(sys, q), day: shortDay(q.day), window: q.window });
    await sendText(sys, texts, nowMs, sys.nextRef('T', sys.texts.length), env(SHOP_PHONE) ?? '', body, body, { key: `lapsed ${q.ref}` });
  }
  return lapsed;
}

/** What withdrawing a quote came to: the quote withdrawn, or why not. */
export type QuoteWithdrawn = { ok: true; quote: Quote; texted: boolean } | { ok: false; status: number; why: string };

/**
 * The shop withdraws a waiting quote from its page: the hold released and the quote withdrawn (on file), the card
 * "Withdrawn". The customer is texted (`texts.quoteWithdrawn`) only where the shop ticks the form's box: by
 * default not, and the shop calls if it wants (call 53). Once: a quote no longer waiting is not withdrawn again.
 */
export async function withdrawQuote(sys: Systems, texts: Texts | undefined, form: { request: string; quote: string; tell: boolean }, nowMs: number): Promise<QuoteWithdrawn> {
  const q = sys.quotes.find((x) => x.ref === form.quote && x.request === form.request);
  if (q === undefined) return { ok: false, status: 404, why: 'No such quote.' };
  if (sys.statusOf(q) !== 'waiting') return { ok: true, quote: q, texted: false };
  sys.keep('quote_state', { ref: q.ref, at: iso(nowMs), state: 'withdrawn' }, nowMs);
  if (!form.tell) return { ok: true, quote: q, texted: false };
  const body = textLine('quoteWithdrawn', { wheels: wheelsWords(requestOf(sys, q).wheels), vehicle: requestOf(sys, q).vehicle ?? '' });
  const { text } = await deliver(sys, texts, nowMs, sys.nextRef('T', sys.texts.length), `+1${q.to}`, body, body, { key: `withdrawn ${q.ref}` });
  return { ok: true, quote: q, texted: !NOT_SENT.includes(text.status) };
}

/** Whether a text came from the number a quote went to: exactly, a North American number in E.164 (call 53). */
export const fromQuoted = (from: string, q: Quote): boolean => from.startsWith('+1') && sameNumber(from, `+1${q.to}`);

/**
 * The quote a text from `from` answers: the latest quote texted to that number exactly (fromQuoted), where it is
 * its request's latest and is waiting, or lapsed within the last week (ON_FILE_MS), whose reply goes to the shop
 * to call (replyToLapsed); none otherwise.
 */
export function quoteFor(sys: Systems, from: string, nowMs: number): Quote | undefined {
  const q = sys.quotes.filter((x) => fromQuoted(from, x)).at(-1);
  if (q === undefined || sys.quotesOf(q.request).at(-1) !== q) return undefined;
  const st = sys.statusOf(q);
  if (st === 'waiting') return q;
  if (st === 'lapsed' && nowMs - Date.parse(q.holdUntil) <= ON_FILE_MS) return q;
  return undefined;
}

/** Why a yes did not book: the quote is no longer the one to book (superseded, withdrawn, booked, or its request booked), its hold has lapsed, or (a calendar that changed under the hold) its window has no room. */
export type NotBooked = 'stale' | 'late' | 'full';

/** Books a quote's window from the customer's yes: only a waiting quote, the request's latest, whose request has no booking, inside its hold; once for the quote. */
export function bookQuote(sys: Systems, q: Quote, nowMs: number): { booking: string } | { refused: NotBooked } {
  const st = sys.statusOf(q);
  if (st === 'lapsed' || (st === 'waiting' && nowMs >= Date.parse(q.holdUntil))) return { refused: 'late' };
  if (st !== 'waiting' || sys.quotesOf(q.request).at(-1) !== q || sys.bookedRequest(q.request)) return { refused: 'stale' };
  // The quote's own hold is its room.
  if (sys.roomIn(q.day, q.window) + 1 < 1) return { refused: 'full' };
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

/** The shop's texts' placeholders for a quote. */
function shopVars(sys: Systems, q: Quote): Record<string, string> {
  return { ref: q.ref, ...who(sys, q), day: shortDay(q.day), window: q.window, vehicle: requestOf(sys, q).vehicle ?? '', price: priceWords(q.price) };
}

/** A customer's reply sent on to the shop's phone with one of the shop's lines, their words after it, their photos with it. */
async function toShop(sys: Systems, ctx: TextContext, line: string, m: IncomingText, nowMs: number): Promise<void> {
  await sendText(sys, ctx.texts, nowMs, sys.nextRef('T', sys.texts.length), ctx.env(SHOP_PHONE) ?? '', forwardBody(line, m.body), line, { media: m.media.map((x) => x.url) });
}

/** A reply to a quote whose hold lapsed: never read, never booked (call 53); the shop is told to call (texts.quoteLate), and the customer gets no text. */
export async function replyToLapsed(sys: Systems, q: Quote, m: IncomingText, ctx: TextContext): Promise<void> {
  await toShop(sys, ctx, textLine('quoteLate', shopVars(sys, q)), m, ctx.nowMs);
}

/**
 * A customer's text that answers a waiting quote (onText): the decision model asked whether it accepts the quote
 * as offered. The quote is looked at again once the model has answered (the shop may have sent a new quote, or
 * withdrawn it, meanwhile), on the clock of that moment. A yes books the window (texts.booked to the number that
 * consented; texts.quoteBooked to the shop, saying so where the customer's text did not go). Anything else, no
 * reading, or a quote no longer the one to book, goes to the shop's phone as the customer wrote it
 * (texts.quoteReply), and the hold stays; a yes the hold's end or the calendar refuses tells the shop to call
 * (texts.quoteLate, texts.quoteFull).
 */
export async function replyToQuote(sys: Systems, q: Quote, m: IncomingText, ctx: TextContext): Promise<void> {
  const request = requestOf(sys, q);
  const started = Date.now();
  const answers = await ctx.decide(QUOTE_QUESTIONS, { quote: quoteText(sys, q, request), replyWord: confirmWord() });
  // The clock after the model's answer: the context's time, and the time the asking took.
  const nowMs = ctx.nowMs + Math.max(0, Date.now() - started);
  const vars = shopVars(sys, q);
  if (!accepts(answers)) return toShop(sys, ctx, textLine('quoteReply', vars), m, nowMs);
  const booked = bookQuote(sys, q, nowMs);
  if ('refused' in booked) {
    const line = booked.refused === 'stale' ? 'quoteReply' : booked.refused === 'late' ? 'quoteLate' : 'quoteFull';
    return toShop(sys, ctx, textLine(line, vars), m, nowMs);
  }
  const toCustomer = textLine('booked', { day: shortDay(q.day), window: windowSays(sys, q.window) });
  // To the number that consented (the request's callback number), never the number the text came from.
  const { text } = await deliver(sys, ctx.texts, nowMs, sys.nextRef('T', sys.texts.length), `+1${q.to}`, toCustomer, toCustomer, { key: `booked ${q.ref}` });
  const told = textLine('quoteBooked', { ...vars, booking: booked.booking });
  const shopLine = NOT_SENT.includes(text.status) ? `${told} ${textLine('customerNotTexted', { status: text.status })}` : told;
  await sendText(sys, ctx.texts, nowMs, sys.nextRef('T', sys.texts.length), ctx.env(SHOP_PHONE) ?? '', shopLine, shopLine, { key: `booked shop ${q.ref}` });
}
