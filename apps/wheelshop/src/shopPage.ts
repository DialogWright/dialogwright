import { randomBytes } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import type { AppBrand, AppPageDeps, AppRoute, AppRoutes } from 'dialogwright';
import { COUNTS, WINDOW_NAMES, accountOf, capacityOf, dayWords, nameWords, standingCars, type Kept, type Received, type Systems, type Text } from './app';
import { SHOP_DATA_DIR } from './shopLog';

/**
 * The shop page: what the line took in, for the shop, without opening each call in the console. Served at
 * `/wheelshop/shop` (`/shop` below the app's base) as one page the server renders on each request, with no
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

/** A photo's URL the page may show: the provider's, over https (the engine keeps only Twilio's own). */
const showable = (url: string): boolean => /^https:\/\/[^\s"'<>]+$/.test(url);

/** Thumbnails, each linking to its full image. */
function photosHtml(media: readonly string[]): string {
  const shown = media.filter(showable);
  if (shown.length === 0) return '';
  return `<div class="photos">${shown.map((u, i) => `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer"><img src="${esc(u)}" alt="Photo ${i + 1}" loading="lazy" referrerpolicy="no-referrer"></a>`).join('')}</div>`;
}

/** A choice as the shop reads it. */
const YES_NO: Readonly<Record<string, string>> = { yes: 'Yes', no: 'No', not_sure: 'Not sure' };
/** What the page says of a field left empty. */
const NOT_GIVEN = 'not given';
const given = (v: string | undefined): string => (v === undefined || v.trim() === '' ? NOT_GIVEN : v);
const answer = (v: string | undefined): string => (v === undefined || v === '' ? NOT_GIVEN : (YES_NO[v] ?? v));

/** What the page shows, worked out from the systems: pure, so a test renders it from fixture data. */
export interface ShopView {
  requests: Array<{ request: Kept; photos: Received[] }>;
  windows: Array<{ day: string; window: string; capacity: number; standing: number; booked: number; bookings: Kept[] }>;
  texts: Array<({ direction: 'sent' } & Text) | ({ direction: 'received' } & Received)>;
  callbacks: Kept[];
}

/** Newest first, by when each was kept (ISO times sort as text). */
const newestFirst = <T extends { at: string }>(xs: readonly T[]): T[] => [...xs].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

/** The page's view of the systems. */
export function shopView(sys: Systems): ShopView {
  const requests = newestFirst(sys.requests).map((request) => ({ request, photos: sys.received.filter((r) => r.request === request.ref && r.media.length > 0) }));
  const groups = new Map<string, Kept[]>();
  for (const b of sys.bookings) {
    const key = `${b.day ?? ''} ${b.window ?? ''}`;
    groups.set(key, [...(groups.get(key) ?? []), b]);
  }
  const order = (w: string): number => (WINDOW_NAMES.includes(w) ? WINDOW_NAMES.indexOf(w) : WINDOW_NAMES.length);
  const windows = [...groups.values()]
    .map((bookings) => {
      const day = bookings[0]!.day ?? '';
      const window = bookings[0]!.window ?? '';
      const standing = /^\d{4}-\d{2}-\d{2}$/.test(day) ? standingCars(day, window) : 0;
      return { day, window, capacity: capacityOf(window), standing, booked: sys.booked.get(`${day} ${window}`) ?? 0, bookings };
    })
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : order(a.window) - order(b.window)));
  const texts = newestFirst<ShopView['texts'][number]>([
    ...sys.texts.map((t) => ({ direction: 'sent' as const, ...t })),
    ...sys.received.map((r) => ({ direction: 'received' as const, ...r })),
  ]);
  return { requests, windows, texts, callbacks: newestFirst(sys.callbacks) };
}

/** How the page writes a time: in the server's time zone (TIMEZONE), as "Wed, Nov 11, 9:05 AM". */
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
}

/** The page's HTML: every value escaped, no script. */
export function shopPageHtml(v: ShopView, o: ShopPageOptions): string {
  const when = timeWriter(o.timeZone);
  const accent = o.brand.colors?.accent !== undefined && HEX.test(o.brand.colors.accent) ? o.brand.colors.accent : DEFAULT_ACCENT;
  const time = (iso: string): string => `<time datetime="${esc(iso)}">${esc(when(iso))}</time>`;
  const row = (label: string, value: string): string => `<div><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
  const empty = (what: string): string => `<p class="empty">${esc(what)}</p>`;

  const requests = v.requests.length === 0
    ? empty('No requests yet.')
    : v.requests.map(({ request: r, photos }) => {
      const pics = photos.map((p) => `<div class="photo-set">${photosHtml(p.media)}<p class="meta">${time(p.at)}${p.text.trim() === '' ? '' : ` · “${esc(p.text.trim())}”`}</p></div>`).join('');
      return `<article class="card">
<header><h3>${esc(nameWords(r.callerName ?? '') || 'No name given')}</h3><span class="meta">${time(r.at)} · ${esc(r.ref)}</span></header>
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
</article>`;
    }).join('\n');

  const bookings = v.windows.length === 0
    ? empty('No bookings yet.')
    : v.windows.map((w) => {
      const used = w.standing + w.booked;
      const cap = Number.isFinite(w.capacity) ? w.capacity : null;
      const room = cap === null ? `${used} car${used === 1 ? '' : 's'}` : `${used} of ${cap} cars`;
      const full = cap !== null && used >= cap;
      const items = w.bookings.map((b) => {
        const cars = COUNTS[b.cars ?? ''];
        return `<li><strong>${esc(accountOf(b.account ?? '').name)}</strong> · ${esc(cars === undefined ? (b.cars ?? '') : `${cars} car${cars === 1 ? '' : 's'}`)}: ${esc(b.vehicles ?? '')} <span class="meta">${esc(b.ref)}, booked ${time(b.at)}</span></li>`;
      }).join('');
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
    : `<ul class="notes">${v.callbacks.map((c) => `<li><span class="call">${phoneHtml(c.callbackNumber ?? '')}</span><span class="meta">${time(c.at)} · ${esc(c.ref)}</span></li>`).join('')}</ul>`;

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
</style>
</head>
<body>
<div class="top">
<div class="brand"><span class="mark" aria-hidden="true">${esc(o.brand.mark)}</span><div><h1>${name}</h1><div class="sub">What the line took in · ${time(new Date(o.nowMs).toISOString())}</div></div><a class="refresh" href="">Refresh</a></div>
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

/** The headers of the page's answer: its own policy (the page's style by its nonce, photos from https), no framing, no referrer, never cached. */
function protect(res: ServerResponse, nonce: string): void {
  res.setHeader('content-security-policy', `default-src 'none'; style-src 'nonce-${nonce}'; img-src https:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
}

/** The page's route: GET and HEAD of `/shop` (or `/shop/`); anything else under it is a 404, any other method a 405. */
export function shopRoute(sys: Systems, o: { brand: ShopPageOptions['brand']; timeZone: string; now: () => number }): AppRoute {
  return {
    label: 'shop page',
    path: SHOP_PATH,
    localOnly: true,
    auth: 'console',
    async handle(req, res, path) {
      if (path !== SHOP_PATH && path !== `${SHOP_PATH}/`) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found\n');
        return true;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' });
        res.end('method not allowed\n');
        return true;
      }
      const nonce = randomBytes(16).toString('base64');
      protect(res, nonce);
      const body = shopPageHtml(shopView(sys), { brand: o.brand, timeZone: o.timeZone, nowMs: o.now(), nonce, logFile: sys.logFile });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) });
      res.end(req.method === 'HEAD' ? undefined : body);
      return true;
    },
  };
}

/**
 * The app's pages (App.pages): the shop page. Built once as the server starts, with the app's systems: it
 * opens the shop's log (SHOP_DATA_DIR; a relative folder is from where the server runs, as TRACE_DIR is) and
 * reads it back, or, unset, says the records are in memory alone.
 */
export function shopPages(deps: AppPageDeps): AppRoutes {
  const sys = deps.tools.sys as Systems;
  const dir = deps.env(SHOP_DATA_DIR)?.trim() ?? '';
  const warnings: string[] = [];
  if (dir === '') {
    warnings.push(`shop page: ${SHOP_DATA_DIR} unset, so the shop's records are kept in memory, and a restart of the server loses them`);
  } else {
    const { read, skipped } = sys.openLog(resolve(dir));
    deps.log(`shop page: ${read} record${read === 1 ? '' : 's'} read back from ${sys.logFile}`);
    if (skipped > 0) warnings.push(`shop page: ${skipped} line${skipped === 1 ? '' : 's'} of ${sys.logFile} could not be read and ${skipped === 1 ? 'was' : 'were'} skipped`);
  }
  const brand = deps.app.brand ?? { name: deps.app.id, mark: deps.app.id.slice(0, 2).toUpperCase() };
  return { routes: [shopRoute(sys, { brand, timeZone: deps.config.timezone, now: deps.now })], warnings };
}
