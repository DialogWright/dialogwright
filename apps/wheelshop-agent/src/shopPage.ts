import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { TWILIO_MEDIA_PREFIX, formFromOwnPage, sameNumber, type AppBrand, type AppRoute, type AppRoutes, type Texts } from 'dialogwright';
import { COUNTS, NOT_SENT, SHOP_PHONE, tenDigits, dayWords, nameWords, type Kept, type Quote, type QuoteStatus, type Received, type RequestStatus, type Systems, type Text } from './shop';
import { confirmWord, lapseDue, markLapsed, offeredSlots, priceWords, sendQuote, shortDay, withdrawQuote, type Slot } from './quotes';
import { SHOP_DATA_DIR } from './shopLog';

/**
 * The shop page: what the line took in, for the shop, without opening each call in the console. Served at
 * `/wheelshop-agent/shop` (`/shop` below the app's base) as one page the server renders on each request, with no
 * script: the requests, newest first (who, the number to call back whole, the car, the wheels, the damage,
 * diamond cut, the drop-off day and window, whether the caller may be texted, and the photos they texted
 * back); the bookings by day and window (the dealership, the cars, the window's room used); the texts sent
 * and received (the number whole, the words, the status the sender answered); and the callback notes.
 *
 * It shows whole numbers, callers' words and their photos, so it is never public: a console page
 * (AppRoute `auth: 'console'`). With the console's sign-in (CONSOLE_AUTH=token) the server serves it only
 * to a browser signed in to the console, from anywhere; otherwise only to a request made on the server's
 * machine, as the console is (CONSOLE_LOCAL_ONLY). The engine checks that before the page is asked.
 *
 * Mounting it opens the shop's log (SHOP_DATA_DIR, src/shopLog.ts) and reads it back, so the page, and the
 * line, start with every record kept before the server last stopped. Unset, the records are in memory, and
 * the server says so as it starts.
 *
 * Photos are shown as thumbnails linking to the full image at the provider's URL (Twilio's, the only ones
 * the engine keeps): the browser fetches each from Twilio, with no referrer; the server downloads nothing.
 *
 * Each request card shows its state (new, photo in, quoted and waiting, booked, lapsed; the header counts them)
 * and, until it is booked, a "Quote and book" form (src/quotes.ts): the price, a drop-off window with room (the
 * caller's own choice picked where it has room), and Send, which posts to `/shop/quote`. The form is the page's
 * only write: POST only, under the same sign-in as the page, with a token of its own (an HMAC of the request and
 * its version under a key the server makes as it starts), and once for the request and version. A request whose
 * caller said no to texts gets no form: the card says to call them, with the number.
 */

/** The page's path, below the app's base. */
export const SHOP_PATH = '/shop';

/** The accent when app.yaml's brand gives none: the engine's chat page's own. */
const DEFAULT_ACCENT = '#2f5bd3';
const HEX = /^#[0-9a-fA-F]{6}$/;

const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: string): string => s.replace(/[&<>"']/g, (ch) => ESCAPES[ch]!);

/** A number as the shop reads and dials it: "(555) 555-0177" and its tel: link for a North American number; any other as it is, with no link. */
export function phone(n: string): { shown: string; tel: string | null } {
  const digits = n.replace(/\D/g, '');
  const ten = digits.length === 10 ? digits : digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : null;
  if (ten === null) return { shown: n, tel: null };
  return { shown: `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`, tel: `+1${ten}` };
}

/** A number as a link to call it, or as text. */
function phoneHtml(n: string): string {
  const p = phone(n);
  return p.tel === null ? esc(p.shown) : `<a class="tel" href="tel:${esc(p.tel)}">${esc(p.shown)}</a>`;
}

/** A photo's URL the page may show: Twilio's own media (the engine's prefix; it keeps no other), with nothing in it an attribute could be broken by. */
const showable = (url: string): boolean => url.startsWith(TWILIO_MEDIA_PREFIX) && !/[\s"'<>]/.test(url);

/** Thumbnails, each linking to its full image. */
function photosHtml(media: readonly string[]): string {
  const shown = media.filter(showable);
  if (shown.length === 0) return '';
  return `<div class="photos">${shown.map((u, i) => `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer"><img src="${esc(u)}" alt="Photo ${i + 1}" loading="lazy" referrerpolicy="no-referrer"></a>`).join('')}</div>`;
}

/** A choice as the shop reads it. */
const YES_NO: Readonly<Record<string, string>> = { yes: 'Yes', no: 'No', 'not sure': 'Not sure' };
/** What the page says of a field left empty. */
const NOT_GIVEN = 'not given';
const given = (v: string | undefined): string => (v === undefined || v.trim() === '' ? NOT_GIVEN : v);
const answer = (v: string | undefined): string => (v === undefined || v === '' ? NOT_GIVEN : (YES_NO[v] ?? v));

/** A request as the page shows it: the record, its photos, its state, its latest quote, and what its form offers. */
export interface RequestView {
  request: Kept;
  photos: Received[];
  status: RequestStatus;
  /** Its latest quote, what became of it, the text that carried it, and the booking it made. */
  quote: { quote: Quote; status: QuoteStatus; text: Text | null; booking: Kept | null } | null;
  /** The form's version: how many quotes the request has had. */
  version: string;
  /** The windows its form offers (none once it is booked). */
  slots: Slot[];
  /** The window the form picks: the latest quote's, else the caller's own, where offered. */
  picked: string | null;
}

/** What the page shows, worked out from the systems: pure, so a test renders it from fixture data. */
export interface ShopView {
  requests: RequestView[];
  windows: Array<{ day: string; window: string; capacity: number; standing: number; booked: number; held: number; bookings: Kept[]; holds: Quote[]; waiting: Kept[] }>;
  texts: Array<({ direction: 'sent' } & Text) | ({ direction: 'received' } & Received)>;
  callbacks: Kept[];
  /** How many requests are in each state, for the header. */
  states: Record<RequestStatus, number>;
}

/** Newest first, by when each was kept (ISO times sort as text). */
const newestFirst = <T extends { at: string }>(xs: readonly T[]): T[] => [...xs].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

/** The page's view of the systems at `nowMs`, its form's windows by the day in `timeZone` (the business's). */
export function shopView(sys: Systems, at: { nowMs: number; timeZone: string } = { nowMs: Date.now(), timeZone: 'UTC' }): ShopView {
  const states: Record<RequestStatus, number> = { new: 0, photo: 0, quoted: 0, booked: 0, lapsed: 0, withdrawn: 0 };
  const requests = newestFirst(sys.requests).map((request): RequestView => {
    const status = sys.requestStatus(request);
    states[status]++;
    const quotes = sys.quotesOf(request.ref);
    const latest = quotes.at(-1);
    const quote = latest === undefined ? null : {
      quote: latest,
      status: sys.statusOf(latest),
      text: sys.texts.find((t) => t.ref === latest.ref) ?? null,
      booking: sys.bookings.find((b) => b.quote === latest.ref) ?? null,
    };
    const slots = status === 'booked' ? [] : offeredSlots(sys, request.ref, at.nowMs, at.timeZone);
    const wanted = [latest === undefined ? null : `${latest.day} ${latest.window}`, `${request.day ?? ''} ${request.window ?? ''}`];
    const picked = wanted.find((w) => w !== null && slots.some((x) => x.value === w)) ?? null;
    return { request, photos: sys.received.filter((r) => r.request === request.ref && r.media.length > 0), status, quote, version: String(quotes.length), slots, picked };
  });
  const groups = new Map<string, { day: string; window: string; bookings: Kept[]; holds: Quote[]; waiting: Kept[] }>();
  const group = (day: string, window: string) => {
    const key = `${day} ${window}`;
    const g = groups.get(key) ?? { day, window, bookings: [], holds: [], waiting: [] };
    groups.set(key, g);
    return g;
  };
  for (const b of sys.bookings) group(b.day ?? '', b.window ?? '').bookings.push(b);
  for (const q of sys.quotes) if (sys.statusOf(q) === 'waiting') group(q.day, q.window).holds.push(q);
  // A request not yet quoted holds the place its caller picked.
  for (const r of sys.requests) if (sys.quotesOf(r.ref).length === 0 && (r.day ?? '') !== '') group(r.day ?? '', r.window ?? '').waiting.push(r);
  const names = sys.windowNames;
  const order = (w: string): number => (names.includes(w) ? names.indexOf(w) : names.length);
  const windows = [...groups.values()]
    .map(({ day, window, bookings, holds, waiting }) => {
      const standing = /^\d{4}-\d{2}-\d{2}$/.test(day) ? sys.standingCars(day, window) : 0;
      return { day, window, capacity: sys.capacityOf(window), standing, booked: sys.booked.get(`${day} ${window}`) ?? 0, held: holds.length + waiting.length, bookings, holds, waiting };
    })
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : order(a.window) - order(b.window)));
  const texts = newestFirst<ShopView['texts'][number]>([
    ...sys.texts.map((t) => ({ direction: 'sent' as const, ...t })),
    ...sys.received.map((r) => ({ direction: 'received' as const, ...r })),
  ]);
  return { requests, windows, texts, callbacks: newestFirst(sys.callbacks), states };
}

/** How the page writes a time: in the business's time zone, as "Wed, Nov 11, 9:05 AM". */
function timeWriter(timeZone: string): (iso: string) => string {
  const f = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return (iso) => {
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? iso : f.format(ms);
  };
}

/** What the page is drawn with beside the view. */
export interface ShopPageOptions {
  brand: Pick<AppBrand, 'name' | 'mark' | 'colors'>;
  timeZone: string;
  /** When the page was drawn, ms since the epoch. */
  nowMs: number;
  /** The nonce the response's policy lets the page's one style run by. */
  nonce: string;
  /** Where the records are kept: the log's file, or null for memory alone. */
  logFile: string | null;
  /** The page is behind the console's sign-in (CONSOLE_AUTH=token): it offers Sign out. */
  signOut?: boolean;
  /** The "Quote and book" and "Withdraw" forms: where each posts, and each form's token by what it does, its request and its version. Absent, no form is drawn. */
  quoteForm?: { action: string; withdraw: string; token(does: FormAction, request: string, version: string): string };
}

/** Each state as the page names it. */
export const STATE_WORDS: Readonly<Record<RequestStatus, string>> = { new: 'New', photo: 'Photo in', quoted: 'Quoted, waiting', booked: 'Booked', lapsed: 'Lapsed', withdrawn: 'Withdrawn' };

/** A window the form offers, as the shop reads it ("Tuesday, Nov 10 · morning"). */
const slotWords = (x: Slot): string => `${shortDay(x.day)} · ${x.window}`;

/** The page's HTML: every value escaped, no script. */
export function shopPageHtml(v: ShopView, o: ShopPageOptions): string {
  const when = timeWriter(o.timeZone);
  const accent = o.brand.colors?.accent !== undefined && HEX.test(o.brand.colors.accent) ? o.brand.colors.accent : DEFAULT_ACCENT;
  const time = (iso: string): string => `<time datetime="${esc(iso)}">${esc(when(iso))}</time>`;
  const row = (label: string, value: string): string => `<div><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
  const empty = (what: string): string => `<p class="empty">${esc(what)}</p>`;

  /** A request's quote, as it stands, and its form (until it is booked). */
  const quoteHtml = (rv: RequestView): string => {
    const r = rv.request;
    const q = rv.quote;
    const where = (x: Quote): string => `${esc(shortDay(x.day))}, ${esc(x.window)}`;
    // Whether the quote's text went (call 53): one refused, failed or only printed is said, with why, and the number to call.
    const notSent = q?.text !== null && q?.text !== undefined && NOT_SENT.includes(q.text.status);
    const sent = q?.text === null || q?.text === undefined ? '' : notSent
      ? ` <strong class="warn">Not texted (${esc(q.text.status === 'printed' ? 'printed, not sent' : q.text.status)}): call them at ${phoneHtml(r.callbackNumber ?? '')}.</strong>`
      : ` Texted: ${esc(q.text.status)}.`;
    const withdraw = q === null || q.status !== 'waiting' || o.quoteForm === undefined ? '' : `<form class="withdraw" method="post" action="${esc(o.quoteForm.withdraw)}">
<input type="hidden" name="request" value="${esc(r.ref)}"><input type="hidden" name="version" value="${esc(rv.version)}"><input type="hidden" name="quote" value="${esc(q.quote.ref)}"><input type="hidden" name="token" value="${esc(o.quoteForm.token('withdraw', r.ref, rv.version))}">
<label class="tell"><input type="checkbox" name="tell" value="yes"> Text them that it is withdrawn</label>
<button type="submit">Withdraw</button>
</form>`;
    const said = q === null ? '' : q.status === 'waiting'
      ? `<p class="quote-state">Quoted ${esc(priceWords(q.quote.price))} for ${where(q.quote)} (${esc(q.quote.ref)}): waiting for ${esc(confirmWord())}, held until ${time(q.quote.holdUntil)}.${sent}</p>${withdraw}`
      : q.status === 'withdrawn'
        ? `<p class="quote-state">Withdrawn: ${esc(q.quote.ref)}, ${esc(priceWords(q.quote.price))} for ${where(q.quote)}; the window was released.</p>`
      : q.status === 'booked'
        ? `<p class="quote-state">Booked ${where(q.quote)} at ${esc(priceWords(q.quote.price))} (${esc(q.booking?.ref ?? '')}, from ${esc(q.quote.ref)}).</p>`
        : q.status === 'lapsed'
          ? `<p class="quote-state warn">Lapsed: ${esc(q.quote.ref)}, ${esc(priceWords(q.quote.price))} for ${where(q.quote)}, had no yes by ${time(q.quote.holdUntil)}, so the window was released.</p>`
          : '';
    if (rv.status === 'booked') return said;
    if (r.textOk !== 'yes') return `${said}<p class="quote-state">The caller asked not to be texted: call them to quote, at ${phoneHtml(r.callbackNumber ?? '')}.</p>`;
    if (o.quoteForm === undefined) return said;
    if (rv.slots.length === 0) return `${said}<p class="empty">No drop-off window has room in the next two weeks.</p>`;
    const theirs = `${r.day ?? ''} ${r.window ?? ''}`;
    const options = rv.slots.map((x) => `<option value="${esc(x.value)}"${x.value === rv.picked ? ' selected' : ''}>${esc(slotWords(x))}${x.value === theirs ? ' (their choice)' : ''}</option>`).join('');
    return `${said}<form class="quote" method="post" action="${esc(o.quoteForm.action)}">
<h4>${q === null ? 'Quote and book' : 'Send a new quote'}</h4>
<input type="hidden" name="request" value="${esc(r.ref)}"><input type="hidden" name="version" value="${esc(rv.version)}"><input type="hidden" name="token" value="${esc(o.quoteForm.token('quote', r.ref, rv.version))}">
<label>Price <input name="price" inputmode="decimal" autocomplete="off" required placeholder="180" value="${q === null ? '' : esc(priceWords(q.quote.price).slice(1))}"></label>
<label>Drop-off <select name="slot" required>${options}</select></label>
<button type="submit">Send</button>
</form>`;
  };

  const requests = v.requests.length === 0
    ? empty('No requests yet.')
    : v.requests.map((rv) => {
      const { request: r, photos } = rv;
      const pics = photos.map((p) => `<div class="photo-set">${photosHtml(p.media)}<p class="meta">${time(p.at)}${p.text.trim() === '' ? '' : ` · “${esc(p.text.trim())}”`}</p></div>`).join('');
      return `<article class="card" id="${esc(r.ref)}">
<header><h3>${esc(nameWords(r.callerName ?? '') || 'No name given')}</h3><span class="badge state-${esc(rv.status)}">${esc(STATE_WORDS[rv.status])}</span></header>
<p class="meta">${time(r.at)} · ${esc(r.ref)}</p>
<p class="call">${phoneHtml(r.callbackNumber ?? '')}</p>
<dl>${[
        row('Car', esc(given(r.vehicle))),
        row('Wheels', esc(given(r.wheels))),
        row('Damage', esc(given(r.damage))),
        row('Diamond cut', esc(answer(r.diamondCut))),
        row('Drop-off', esc(`${given(dayWords(r.day ?? ''))}${r.window ? `, ${r.window}` : ''}`)),
        row('OK to text', esc(answer(r.textOk))),
      ].join('')}</dl>
<div class="photos-block"><h4>Photos</h4>${pics === '' ? `<p class="empty">${r.textOk === 'yes' ? 'None texted back yet.' : 'None: the caller asked not to be texted.'}</p>` : pics}</div>
${quoteHtml(rv)}
</article>`;
    }).join('\n');

  const bookings = v.windows.length === 0
    ? empty('No bookings yet.')
    : v.windows.map((w) => {
      const used = w.standing + w.booked + w.held;
      const cap = Number.isFinite(w.capacity) ? w.capacity : null;
      const room = `${cap === null ? `${used} car${used === 1 ? '' : 's'}` : `${used} of ${cap} cars`}${w.held > 0 ? `, ${w.held} held` : ''}`;
      const full = cap !== null && used >= cap;
      const items = w.bookings.map((b) => {
        const cars = COUNTS[b.cars ?? ''];
        // A dealership's booking by its account; one a customer's yes made from a quote by their name.
        const whose = b.quote !== undefined ? `${nameWords(b.callerName ?? '')} (quote ${b.quote}, ${priceWords(b.price ?? '0')})` : (b.account ?? '');
        return `<li><strong>${esc(whose)}</strong> · ${esc(cars === undefined ? (b.cars ?? '') : `${cars} car${cars === 1 ? '' : 's'}`)}${(b.vehicles ?? '') === '' ? '' : `: ${esc(b.vehicles ?? '')}`} <span class="meta">${esc(b.ref)}, booked ${time(b.at)}</span></li>`;
      }).join('') + w.holds.map((q) => {
        const r = v.requests.find((x) => x.request.ref === q.request)?.request;
        return `<li class="held"><strong>${esc(nameWords(r?.callerName ?? ''))}</strong> · held for ${esc(q.ref)} (${esc(priceWords(q.price))}): ${esc(r?.vehicle ?? '')} <span class="meta">until ${time(q.holdUntil)}</span></li>`;
      }).join('') + w.waiting.map((r) => `<li class="held"><strong>${esc(nameWords(r.callerName ?? ''))}</strong> · request ${esc(r.ref)}, waiting for a quote: ${esc(r.vehicle ?? '')}</li>`).join('');
      return `<article class="card">
<header><h3>${esc(dayWords(w.day))}, ${esc(w.window)}</h3><span class="badge${full ? ' full' : ''}">${esc(room)}${full ? ' · full' : ''}</span></header>
${w.standing > 0 ? `<p class="meta">Includes the standing drop-off (${w.standing} car${w.standing === 1 ? '' : 's'}).</p>` : ''}
<ul>${items}</ul>
</article>`;
    }).join('\n');

  const texts = v.texts.length === 0
    ? empty('No texts yet.')
    : `<ul class="texts">${v.texts.map((t) => {
      const who = t.direction === 'sent'
        ? (t.to === '' ? 'To the shop’s phone (SHOP_PHONE unset)' : `To ${phoneHtml(t.to)}`)
        : `From ${phoneHtml(t.from)}${t.request !== undefined ? ` <span class="meta">for ${esc(t.request)}</span>` : ''}`;
      const status = t.direction === 'sent' ? (t.status === 'printed' ? 'printed, not sent' : t.status) : 'received';
      const bad = t.direction === 'sent' && (t.status === 'failed' || t.status === 'limited' || t.status === 'printed');
      return `<li class="${t.direction}"><div class="text-head"><span>${who}</span><span class="badge${bad ? ' warn' : ''}">${esc(status)}</span></div>
<p class="words">${t.text === '' ? '<em>(a photo)</em>' : esc(t.text)}</p>${photosHtml(t.media ?? [])}<p class="meta">${time(t.at)} · ${esc(t.ref)}</p></li>`;
    }).join('')}</ul>`;

  const callbacks = v.callbacks.length === 0
    ? empty('No callback notes yet.')
    : `<ul class="notes">${v.callbacks.map((c) => `<li>${(c.name ?? '') === '' ? '' : `<strong>${esc(c.name ?? '')}</strong> `}<span class="call">${phoneHtml(c.callbackNumber ?? '')}</span>${(c.about ?? '') === '' ? '' : ` · ${esc(c.about ?? '')}`}<span class="meta">${time(c.at)} · ${esc(c.ref)}</span></li>`).join('')}</ul>`;

  const count = (n: number): string => `<span class="count">${n}</span>`;
  const name = esc(o.brand.name);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${name}: the shop</title>
<style nonce="${esc(o.nonce)}">
  :root { --accent: ${accent}; --bg: #f5f6f8; --card: #fff; --fg: #1d1d1f; --muted: #5b6270; --line: #e2e5ea; --warn: #9a5b00; color-scheme: light dark; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111317; --card: #1a1d23; --fg: #eef0f3; --muted: #a2a9b6; --line: #2b3039; --warn: #f0b75e; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .top { position: sticky; top: 0; z-index: 1; background: var(--bg); border-bottom: 1px solid var(--line); padding: 10px 16px; }
  .brand { display: flex; align-items: center; gap: 10px; }
  .mark { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 8px; background: var(--accent); color: #fff; font-weight: 700; font-size: .9rem; }
  .brand h1 { font-size: 1.1rem; margin: 0; }
  .brand .sub { color: var(--muted); font-size: .85rem; }
  .out { margin: 0; }
  .out button { font: inherit; font-size: .9rem; color: var(--muted); background: none; border: 1px solid var(--line); border-radius: 999px; padding: 6px 10px; cursor: pointer; }
  .refresh { margin-left: auto; color: var(--accent); font-weight: 600; text-decoration: none; padding: 6px 10px; border: 1px solid var(--accent); border-radius: 999px; font-size: .9rem; }
  nav { display: flex; gap: 6px; overflow-x: auto; margin-top: 8px; scrollbar-width: none; }
  nav a { white-space: nowrap; text-decoration: none; color: var(--fg); background: var(--card); border: 1px solid var(--line); border-radius: 999px; padding: 4px 12px; font-size: .9rem; }
  .count { color: var(--muted); margin-left: 4px; }
  main { max-width: 760px; margin: 0 auto; padding: 8px 16px 40px; }
  section { scroll-margin-top: 150px; }
  h2 { font-size: 1.15rem; margin: 22px 0 10px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; margin: 0 0 12px; }
  .card ul { margin-top: 10px; }
  .card header { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 10px; }
  .card h3 { font-size: 1.05rem; margin: 0; }
  h4 { font-size: .9rem; margin: 10px 0 6px; color: var(--muted); font-weight: 600; }
  .meta { color: var(--muted); font-size: .85rem; }
  .call { margin: 6px 0; font-size: 1.1rem; }
  .tel { color: var(--accent); font-weight: 600; text-decoration: none; }
  dl { display: grid; grid-template-columns: repeat(auto-fit, minmax(128px, 1fr)); gap: 6px 14px; margin: 8px 0 0; }
  dt { color: var(--muted); font-size: .8rem; }
  dd { margin: 0; overflow-wrap: anywhere; }
  .photos { display: flex; flex-wrap: wrap; gap: 6px; }
  .photos img { width: 96px; height: 96px; object-fit: cover; border-radius: 8px; border: 1px solid var(--line); display: block; background: var(--line); }
  .photo-set { margin-bottom: 8px; }
  .photo-set .meta { margin: 4px 0 0; }
  .badge { font-size: .85rem; padding: 2px 10px; border-radius: 999px; background: color-mix(in srgb, var(--accent) 14%, var(--card)); }
  .badge.full, .badge.warn { background: color-mix(in srgb, var(--warn) 20%, var(--card)); color: var(--warn); }
  ul { padding-left: 18px; margin: 8px 0 0; }
  li { margin: 4px 0; overflow-wrap: anywhere; }
  .texts, .notes { list-style: none; padding: 0; }
  .texts li, .notes li { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 10px 14px; margin: 0 0 10px; }
  .texts li.received { border-left: 4px solid var(--accent); }
  .text-head { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
  .words { margin: 6px 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  .notes li { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 4px 10px; }
  .notes .call { margin: 0; }
  .empty { color: var(--muted); }
  footer { color: var(--muted); font-size: .8rem; margin-top: 28px; }
  .states { margin: 6px 0 0; font-size: .85rem; color: var(--muted); }
  .badge.state-quoted { background: color-mix(in srgb, var(--accent) 24%, var(--card)); }
  .badge.state-booked { background: color-mix(in srgb, #2e8b57 22%, var(--card)); }
  .badge.state-lapsed { background: color-mix(in srgb, var(--warn) 20%, var(--card)); color: var(--warn); }
  .quote-state { margin: 10px 0 0; }
  .quote-state.warn, .quote-state .warn { color: var(--warn); }
  .badge.state-withdrawn { background: var(--line); }
  form.withdraw { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; }
  form.withdraw .tell { font-size: .85rem; color: var(--muted); }
  form.withdraw button { font: inherit; font-size: .9rem; color: var(--warn); background: none; border: 1px solid var(--warn); border-radius: 999px; padding: 6px 12px; cursor: pointer; }
  form.quote { margin-top: 10px; border-top: 1px solid var(--line); padding-top: 8px; display: grid; gap: 8px; }
  form.quote h4 { margin: 0; }
  form.quote label { display: grid; gap: 2px; font-size: .85rem; color: var(--muted); }
  form.quote input, form.quote select { font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; width: 100%; }
  form.quote button { font: inherit; font-weight: 600; color: #fff; background: var(--accent); border: 0; border-radius: 999px; padding: 10px 16px; cursor: pointer; justify-self: start; }
  li.held { color: var(--muted); }
</style>
</head>
<body>
<div class="top">
<div class="brand"><span class="mark" aria-hidden="true">${esc(o.brand.mark)}</span><div><h1>${name}</h1><div class="sub">What the line took in · ${time(new Date(o.nowMs).toISOString())}</div></div><a class="refresh" href="">Refresh</a>${o.signOut === true ? '<form class="out" method="post" action="/dashboard/logout"><button type="submit">Sign out</button></form>' : ''}</div>
<p class="states">${(Object.keys(STATE_WORDS) as RequestStatus[]).map((k) => `<span class="state">${esc(STATE_WORDS[k])}${count(v.states[k])}</span>`).join(' · ')}</p>
<nav aria-label="Sections"><a href="#requests">Requests${count(v.requests.length)}</a><a href="#bookings">Bookings${count(v.windows.reduce((n, w) => n + w.bookings.length, 0))}</a><a href="#texts">Texts${count(v.texts.length)}</a><a href="#callbacks">Callback notes${count(v.callbacks.length)}</a></nav>
</div>
<main>
<section id="requests"><h2>Requests</h2>
${requests}
</section>
<section id="bookings"><h2>Bookings by day and window</h2>
${bookings}
</section>
<section id="texts"><h2>Texts sent and received</h2>
${texts}
</section>
<section id="callbacks"><h2>Callback notes</h2>
${callbacks}
</section>
<footer>
<p>A text's status is what the sender answered when it was sent (“queued”: Twilio took it); delivery reports are not read yet. Photos open at Twilio.</p>
<p>${o.logFile === null ? 'Kept in memory: a restart of the server loses these (set SHOP_DATA_DIR to keep them).' : 'Kept on the server, in the shop’s log.'}</p>
</footer>
</main>
</body>
</html>
`;
}

/** The headers of the page's answer: its own policy (the page's style by its nonce, photos from https, its one form, Sign out, to this server), no framing, no referrer, never cached. */
function protect(res: ServerResponse, nonce: string): void {
  res.setHeader('content-security-policy', `default-src 'none'; style-src 'nonce-${nonce}'; img-src https:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`);
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
}

/** The forms' paths, below the page's: its only writes. */
export const QUOTE_PATH = `${SHOP_PATH}/quote`;
export const WITHDRAW_PATH = `${SHOP_PATH}/withdraw`;
/** What a form does: send a quote, or withdraw one. */
export type FormAction = 'quote' | 'withdraw';
/** The most a form's body may be. */
const FORM_MAX = 4096;

/** A form's token: an HMAC of what it does, its request and its version under the server's key, so only a page this server drew can send it. */
export function formToken(key: Buffer, does: FormAction, request: string, version: string): string {
  return createHmac('sha256', key).update(`${does} ${request} ${version}`).digest('base64url');
}

/** Whether a token is the form's, compared in constant time. */
function tokenIs(key: Buffer, does: FormAction, request: string, version: string, token: string): boolean {
  const want = Buffer.from(formToken(key, does, request, version));
  const got = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** A form's body, at most FORM_MAX bytes; null where it is longer. */
async function readForm(req: IncomingMessage): Promise<URLSearchParams | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > FORM_MAX) return null;
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

/** A short page saying why a form was not sent, with the way back. */
function sorryHtml(why: string, back: string, nonce: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Not sent</title>
<style nonce="${esc(nonce)}">body { font: 16px/1.45 system-ui, sans-serif; margin: 24px 16px; color-scheme: light dark; } a { font-weight: 600; }</style></head>
<body><h1>Not sent</h1><p>${esc(why)}</p><p><a href="${esc(back)}">Back to the shop page</a></p></body></html>
`;
}

/** What the route is given beside the systems. */
export interface ShopRouteOptions {
  brand: ShopPageOptions['brand'];
  timeZone: string;
  now: () => number;
  signOut?: boolean;
  /** Where the app's pages are mounted (`/wheelshop-agent`), for the form's action and the way back to the page. */
  base?: string;
  /** The app's sender for the page's texts (ShopPagesOptions.texts); absent, they are printed. */
  texts?: Texts;
  /** One of the app's settings (SHOP_PHONE). */
  env?: (name: string) => string | undefined;
  /** The forms' key; a new one each start by default (a page drawn before a restart is refreshed to send). */
  key?: Buffer;
  /** The server's log, for a lapse check that failed. */
  log?: (line: string) => void;
  /** The server's public name (PUBLIC_HOST), for the forms' Origin check (formFromOwnPage). */
  publicHost?: string;
}

/**
 * The page's route: GET and HEAD of `/shop` (or `/shop/`), POST of `/shop/quote` (the "Quote and book" form) and
 * `/shop/withdraw` (a waiting quote's Withdraw), each checked by its token and its Origin; anything else under it
 * is a 404, any other method a 405. The holds whose time is up lapse as the page is
 * drawn and on the server's sweep (every minute), the shop's phone told of each.
 */
export function shopRoute(sys: Systems, o: ShopRouteOptions): AppRoute {
  const base = o.base ?? '';
  const key = o.key ?? randomBytes(32);
  const env = o.env ?? (() => undefined);
  const pending = new Set<Promise<void>>();
  const track = (p: Promise<unknown>): void => {
    const done: Promise<void> = p.then(() => {}, (err: unknown) => o.log?.(`shop page: the lapse check failed (${err instanceof Error ? err.message : String(err)})`)).finally(() => pending.delete(done));
    pending.add(done);
  };
  const lapse = (): void => track(lapseDue(sys, o.texts, env, o.now()));
  const plain = (res: ServerResponse, status: number, text: string, headers: Record<string, string> = {}): true => {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers });
    res.end(`${text}\n`);
    return true;
  };
  return {
    label: 'shop page',
    path: SHOP_PATH,
    localOnly: true,
    auth: 'console',
    async handle(req, res, path) {
      if (path === QUOTE_PATH || path === WITHDRAW_PATH) {
        const does: FormAction = path === QUOTE_PATH ? 'quote' : 'withdraw';
        if (req.method !== 'POST') return plain(res, 405, 'method not allowed', { allow: 'POST' });
        if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/x-www-form-urlencoded')) return plain(res, 415, 'a form is sent as application/x-www-form-urlencoded');
        const back = `${base}${SHOP_PATH}`;
        const nonce = randomBytes(16).toString('base64');
        const sorry = (status: number, why: string): true => {
          protect(res, nonce);
          const body = sorryHtml(why, back, nonce);
          res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) });
          res.end(body);
          return true;
        };
        // A second layer behind the token: the browser's own word that the post came from this page.
        if (!formFromOwnPage(req, o.publicHost ?? '')) return sorry(403, 'This form did not come from the shop page.');
        const form = await readForm(req);
        if (form === null) return plain(res, 413, 'too long');
        const field = (name: string): string => form.get(name) ?? '';
        const request = field('request');
        const version = field('version');
        if (!tokenIs(key, does, request, version, field('token'))) return sorry(403, 'This form is out of date or did not come from this page: refresh the page and send it again.');
        markLapsed(sys, o.now());
        const done = does === 'quote'
          ? await sendQuote(sys, o.texts, { request, version, price: field('price'), slot: field('slot') }, o.now(), o.timeZone)
          : await withdrawQuote(sys, o.texts, { request, quote: field('quote'), tell: field('tell') === 'yes' }, o.now());
        if (!done.ok) return sorry(done.status, done.why);
        res.writeHead(303, { location: `${back}#${encodeURIComponent(done.quote.request)}`, 'cache-control': 'no-store' });
        res.end();
        return true;
      }
      if (path !== SHOP_PATH && path !== `${SHOP_PATH}/`) return plain(res, 404, 'not found');
      if (req.method !== 'GET' && req.method !== 'HEAD') return plain(res, 405, 'method not allowed', { allow: 'GET, HEAD' });
      // The holds whose time is up lapse before the page is drawn (the shop's phone told as they do).
      lapse();
      const nonce = randomBytes(16).toString('base64');
      protect(res, nonce);
      const nowMs = o.now();
      const body = shopPageHtml(shopView(sys, { nowMs, timeZone: o.timeZone }), {
        brand: o.brand, timeZone: o.timeZone, nowMs, nonce, logFile: sys.logFile, ...(o.signOut === true ? { signOut: true } : {}),
        quoteForm: { action: `${base}${QUOTE_PATH}`, withdraw: `${base}${WITHDRAW_PATH}`, token: (d, r, v) => formToken(key, d, r, v) },
      });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) });
      res.end(req.method === 'HEAD' ? undefined : body);
      return true;
    },
    // The server's idle sweep, every minute: the holds whose time is up lapse, and the shop is told.
    sweep: lapse,
    tails: () => [...pending],
  };
}

/** The engine's setting for texts to one number in 24 hours, its default, and what this app suggests. */
const TEXT_LIMIT_SETTING = 'TEXT_LIMIT_PER_NUMBER';
const ENGINE_TEXT_LIMIT = 3;
export const SUGGESTED_TEXT_LIMIT = 5;

/**
 * The page's sender (call 53): the app's own (ShopPagesOptions.texts), held to the numbers this page may text, the
 * shop's phone (SHOP_PHONE) and a request's callback number whose caller said yes to texts. Any other is refused
 * (`refused`, never sent) and logged by its last four.
 */
export function allowListTexts(texts: Texts, sys: Systems, env: (name: string) => string | undefined, log: (line: string) => void): Texts {
  return {
    async send(t) {
      const shop = env(SHOP_PHONE)?.trim() ?? '';
      const allowed = (shop !== '' && sameNumber(t.to, shop)) || sys.requests.some((r) => r.textOk === 'yes' && (r.callbackNumber ?? '') !== '' && sameNumber(t.to, `+1${tenDigits(r.callbackNumber ?? '')}`));
      if (allowed) return texts.send(t);
      log(`shop page: a text to ...${t.to.replace(/\D/g, '').slice(-4)} refused: not the shop's phone, nor a request's number that said yes to texts`);
      return { id: null, status: 'refused', error: 'not a number this page may text' };
    },
  };
}

/** What the shop page is made with: where it is mounted, the app's settings and sender, the clock and the log. */
export interface ShopPagesOptions {
  /** The app's name and mark on the page. */
  brand: ShopPageOptions['brand'];
  /** Where the app's pages are mounted, `/<app id>`. */
  base: string;
  /** One of the app's settings (SHOP_DATA_DIR, SHOP_PHONE, TEXT_LIMIT_PER_NUMBER). */
  env: (name: string) => string | undefined;
  /** The server's public name (PUBLIC_HOST), for the forms' Origin check. */
  publicHost: string;
  /** The console has a sign-in (CONSOLE_AUTH=token): the page offers Sign out. */
  signOut: boolean;
  /** The app's sender for the page's texts; absent, they are printed. */
  texts?: Texts;
  now: () => number;
  log: (line: string) => void;
}

/**
 * The app's pages (ConverseApp.pages): the shop page, made by the server as it starts (ConversePageDeps). It opens the shop's log (SHOP_DATA_DIR;
 * a relative folder is from where the server runs, as TRACE_DIR is) and reads it back, or, unset, says the
 * records are in memory alone; then lapses the holds whose time is up. The lapse check is the page route's
 * sweep from then on: one server's (DESIGN.md, "Quote and confirm").
 */
export function shopPages(sys: Systems, o: ShopPagesOptions): AppRoutes {
  const dir = o.env(SHOP_DATA_DIR)?.trim() ?? '';
  const warnings: string[] = [];
  if (dir === '') {
    warnings.push(`shop page: ${SHOP_DATA_DIR} unset, so the shop's records are kept in memory, and a restart of the server loses them`);
  } else {
    const { read, skipped, warnings: folder } = sys.openLog(resolve(dir));
    warnings.push(...folder.map((w) => `shop page: ${w}`));
    o.log(`shop page: ${read} record${read === 1 ? '' : 's'} read back from ${sys.logFile}`);
    if (skipped > 0) warnings.push(`shop page: ${skipped} line${skipped === 1 ? '' : 's'} of ${sys.logFile} could not be read and ${skipped === 1 ? 'was' : 'were'} skipped`);
  }
  if (o.texts !== undefined) {
    // A customer may be texted four times in a day (more with each new quote): under 5, the booking's text may be refused.
    const raw = o.env(TEXT_LIMIT_SETTING)?.trim() ?? '';
    const limit = raw === '' ? ENGINE_TEXT_LIMIT : Number(raw);
    if (Number.isFinite(limit) && limit < SUGGESTED_TEXT_LIMIT) {
      o.log(`shop page: ${TEXT_LIMIT_SETTING} is ${limit}${raw === '' ? ' (the default)' : ''}: a customer may be texted four times in a day (the photo request, the thank-you, the quote and the booking; one more for each new quote), so the booking's text may be refused (limited); ${SUGGESTED_TEXT_LIMIT} is suggested (DESIGN.md "Quote and confirm")`);
    }
  }
  // Behind the console's sign-in where the server has one (a console page): then it offers Sign out.
  const publicHost = o.publicHost.trim();
  const route = shopRoute(sys, {
    brand: o.brand, now: o.now, signOut: o.signOut, base: o.base, env: o.env, log: o.log,
    // The business's time zone (agent.yaml's business.timezone), read once the systems are configured: the page's times and the quotes' cutoffs.
    get timeZone() {
      return sys.config.timeZone;
    },
    ...(publicHost ? { publicHost } : {}),
    ...(o.texts !== undefined ? { texts: allowListTexts(o.texts, sys, o.env, o.log) } : {}),
  });
  // Holds whose time ran out while the server was stopped lapse now, as the records are read back.
  route.sweep?.();
  return { routes: [route], warnings };
}
