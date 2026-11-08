import { fileURLToPath } from 'node:url';
import { ShopLog, type ShopEntry } from './shopLog';
import { shopPages } from './shopPage';
import { lapseDue, quoteFor, replyToLapsed, replyToQuote } from './quotes';
import { defineApp, describeDay, loadBusiness, optionKey, parseIso, replyShape, sameNumber, type AppCode, type BusinessYaml, type IncomingText, type TextContext, type Texts, type ToolDef } from 'dialogwright';

/**
 * Example Wheel Works, in agent mode: a fictional wheel repair shop's line, speaking as the shop. Everything about the
 * shop is in business.yaml, beside this src/ folder: who it is and how it sounds, what it does and
 * doesn't do, its claims, its days and drop-off windows, its dealership accounts, what a request, a
 * booking and a callback note collect, and every line said in fixed words. The engine builds the app
 * from that file (its intents, forms, slots, prompts, policy and identity), and a model leads the
 * conversation from it. This file is the shop's tools and nothing else, each a stand-in:
 *
 * - `availability`: the free drop-off windows on a day, from a calendar held in memory, two windows a
 *   weekday each with the capacity business.yaml gives. Its result is shown to the model (business.yaml's
 *   `sees`), so its reply check is closed: the day, and the windows by name.
 * - `request`, `book`, `callback`: the writes a read-back's yes makes, kept in memory and, where the app's
 *   setting SHOP_DATA_DIR names a folder, in the shop's log there (src/shopLog.ts), which the server reads
 *   back as it starts. The shop page (src/shopPage.ts, `/wheelshop/shop`, behind the console's sign-in)
 *   shows them.
 * - `send_photo_link`: a text to the caller asking them to reply with a photo of the damage, in business.yaml's
 *   words (`texts.photoRequest`), sent only with their yes to being texted (business.yaml's `when`: the
 *   gate refuses it otherwise, never this code).
 * - The shop's notices (`notify_owner_request`, `notify_owner_booking`, and the callback note's): texts to the
 *   shop's phone, the app's own setting SHOP_PHONE, the summary filled from business.yaml's fixed template.
 *   A text to the business, not to a caller, so no caller's consent applies.
 * - `onText`: a text that comes in. A reply to a quote the shop sent from its page is read by the decision
 *   model (src/quotes.ts: a yes books the held window, anything else goes to the shop). A photo from a number
 *   with a recent request is sent on to the shop's phone with a line naming the request, and the caller
 *   thanked while the request is not yet quoted; any other text is sent on as it came. Each is kept (whole,
 *   with its photos' URLs) for the shop page.
 *
 * Each text goes through the server's sender (ctx.texts, TEXT_FROM) and is printed where there is none (or
 * no SHOP_PHONE): the server and the text CLI print, the tests and the regression stay quiet. Each is shown
 * in the trace and the audit by the engine, the number by its last four.
 *
 * Every write is idempotent: a call repeated with the same key (a restart, a call taken over) is done
 * once. Policy is never here: the gate decides, from what the engine built from business.yaml, whether
 * a tool may run. All names and numbers are invented (the 555 range).
 * `dialogwright check` imports this module and checks the folder against `code`.
 */

/** The app's folder: the one with app.yaml and business.yaml, above this src/. */
export const APP_DIR = fileURLToPath(new URL('..', import.meta.url));

/** The shop's facts, as business.yaml says them: the windows' capacity, the days, the accounts, the owner's summary and the texts. */
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
export const COUNTS: Readonly<Record<string, number>> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };

/**
 * The stand-in calendar's one booking already in: a standing dealership drop-off that fills every Friday
 * morning, so the demo has a full window to meet. Every other window starts empty.
 */
export function standingCars(day: string, window: string): number {
  return WEEKDAY_NAMES[new Date(parseIso(day)).getUTCDay()] === 'friday' && window === 'morning' ? capacityOf('morning') : 0;
}

/** How many cars a window takes (business.yaml's capacity; a window that gives none takes any number). */
export function capacityOf(window: string): number {
  return BUSINESS.windows?.find((w) => w.name === window)?.capacity ?? Number.POSITIVE_INFINITY;
}

/** Whether the shop works on a day (business.yaml's days). */
export function opensOn(day: string): boolean {
  return (BUSINESS.days ?? []).includes(WEEKDAY_NAMES[new Date(parseIso(day)).getUTCDay()]! as never);
}

/** A record a write kept, by its params, with its reference and when it was made (ISO). */
export type Kept = Readonly<Record<string, string>> & { readonly ref: string; readonly at: string };

/** A text the line sent (or printed, with no sender): whole here, masked where it is printed or recorded. */
export interface Text {
  ref: string;
  /** When it was sent (ISO). */
  at: string;
  to: string;
  text: string;
  /** The media it carried, by URL (a photo sent on to the shop). */
  media?: string[];
  /** The sender's status ("queued", "failed"), or `printed` where there was no sender or no number to send to. */
  status: string;
}

/** A text that came in to the shop's number, whole, as the shop page shows it. */
export interface Received {
  ref: string;
  /** When it came (ISO). */
  at: string;
  /** The number it came from, whole (E.164). */
  from: string;
  /** The caller's own words ("" for a photo alone). */
  text: string;
  /** Its photos, by the provider's URLs (the engine keeps only Twilio's own); nothing is downloaded. */
  media: string[];
  /** The request it was matched to (a recent request from its number), by its reference. */
  request?: string;
}

/** A request on file for the number a caller may text from: which request, who, which car, whether they said yes to being texted, and when it was sent. */
export interface OnFile {
  ref: string;
  name: string;
  vehicle: string;
  /** The request's textOk ("yes" or "no"): only a yes is ever texted back. */
  textOk: string;
  atMs: number;
}

/**
 * A quote the shop sent from its page ("Quote and book", src/quotes.ts): the price, the drop-off day and window
 * it holds for the request, the number it was texted to, and when the hold ends. Every field a string, as the
 * shop's log keeps it.
 */
export interface Quote {
  /** Its reference ("Q101"), which its text and its states carry too. */
  readonly ref: string;
  /** When it was sent (ISO). */
  readonly at: string;
  /** The request it quotes, by its reference. */
  readonly request: string;
  /** How many quotes the request had before this one ("0" for the first): with the request, what makes a form's send once. */
  readonly version: string;
  /** The price in cents ("18000" is $180). */
  readonly price: string;
  /** The drop-off day (ISO date) and window it holds. */
  readonly day: string;
  readonly window: string;
  /** The number it was texted to: the request's callback number, ten digits. */
  readonly to: string;
  /** When its hold lapses (ISO): 24 hours after it was sent or 6 pm the day before the drop-off, whichever is first. */
  readonly holdUntil: string;
  /** 6 pm the day before the drop-off (ISO), in the server's time zone (TIMEZONE): the last moment it may be booked. */
  readonly cutoff: string;
}

/** What became of a quote: booked (by the customer's reply), lapsed (no yes by its hold's end), withdrawn (by the shop, from its page) or superseded (a newer quote sent for the request). Waiting is a quote with none. */
export type QuoteEnd = 'booked' | 'lapsed' | 'withdrawn' | 'superseded';
export interface QuoteState {
  readonly ref: string;
  readonly at: string;
  readonly state: QuoteEnd;
  /** The booking it made, by its reference (booked only). */
  readonly booking?: string;
}

/** A quote's state now: waiting while it holds its window, else what became of it. */
export type QuoteStatus = 'waiting' | QuoteEnd;

/** A request's state on the shop page: new, a photo in, quoted (a quote waiting), booked, lapsed or withdrawn (its latest quote's end). */
export type RequestStatus = 'new' | 'photo' | 'quoted' | 'booked' | 'lapsed' | 'withdrawn';

/** The most characters a text forwarded to the shop carries: under a long SMS's 1,600, the caller's words cut to fit. */
export const FORWARD_MAX = 1500;

/** How long a request is matched to a text from its number: a week. */
export const ON_FILE_MS = 7 * 24 * 60 * 60 * 1000;

/** The setting the shop's phone is read from (the app's own settings file; never business.yaml): unset, the shop's texts are printed. */
export const SHOP_PHONE = 'SHOP_PHONE';

/** One of business.yaml's texts (`texts`), its placeholders filled: a fixed line, never a generated one. */
export function textLine(name: string, vars: Readonly<Record<string, string>> = {}): string {
  const template = BUSINESS.texts?.[name];
  if (template === undefined) throw new Error(`business.yaml has no text "${name}"`);
  return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_whole, v: string) => vars[v] ?? '');
}

/** Whether the texts are printed to the log (the server and the text harness turn it on; the tests and the regression stay quiet). */
let printing = false;
export function printTexts(on: boolean): void {
  printing = on;
}

/**
 * The app's systems (App.systems builds them: a server once, shared by every call and by onText; a test or a
 * scripted call its own): the stand-in calendar (the cars booked into each window, beside the standing
 * drop-off), the requests, bookings and callback notes kept, the texts sent and received, and each write's
 * key, so a write repeated is done once. In memory, and in the shop's log once the server opens it
 * (openLog, SHOP_DATA_DIR). Replace these with clients for the shop's real calendar once the owner says what
 * the shop uses.
 */
export class Systems {
  readonly requests: Kept[] = [];
  readonly bookings: Kept[] = [];
  readonly callbacks: Kept[] = [];
  readonly texts: Text[] = [];
  /** The texts that came in, each whole, matched to a request where one was on file. */
  readonly received: Received[] = [];
  /** The shop's log (SHOP_DATA_DIR), once opened; null keeps everything in memory alone. */
  private log: ShopLog | null = null;
  /**
   * The requests on file by the ten digits of their callback number, so a photo texted in is matched to its
   * request. Read back from the shop's log as the server starts (SHOP_DATA_DIR); with no log, in memory
   * alone, and a server restarted forgets them (a photo is then sent on as from a number with no request on file).
   */
  readonly onFile = new Map<string, OnFile>();
  /** The cars booked into each window on this calendar, by `<day> <window>`. */
  readonly booked = new Map<string, number>();
  /** The reference each write's key was given. */
  readonly written = new Map<string, string>();
  /** The quotes the shop sent from its page, in order (src/quotes.ts). */
  readonly quotes: Quote[] = [];
  /** What became of each quote that is no longer waiting, by its reference. */
  readonly quoteEnds = new Map<string, QuoteState>();

  /** Where the records are kept: the log's file, or null for memory alone. */
  get logFile(): string | null {
    return this.log?.file ?? null;
  }

  /**
   * Keeps the records in the log in `dir` from now on, after reading back what it holds (the server does
   * this once, as it starts: src/shopPage.ts). Returns how many records were read (a write's key is not
   * one), how many lines skipped, and any warning about the folder. Opened once: a second call does nothing.
   */
  openLog(dir: string): { read: number; skipped: number; warnings: string[] } {
    if (this.log !== null) return { read: 0, skipped: 0, warnings: [] };
    const { log, read, warnings } = ShopLog.open(dir);
    for (const line of read.lines) this.replay(line);
    this.log = log;
    return { read: read.lines.filter((l) => l.kind !== 'written').length, skipped: read.skipped, warnings };
  }

  /** A record kept: in memory, and in the log where there is one. */
  keep(kind: 'request' | 'booking' | 'callback', record: Kept, atMs: number): void;
  keep(kind: 'text', record: Text, atMs: number): void;
  keep(kind: 'received', record: Received, atMs: number): void;
  keep(kind: 'quote', record: Quote, atMs: number): void;
  keep(kind: 'quote_state', record: QuoteState, atMs: number): void;
  keep(kind: Exclude<ShopEntry['kind'], 'written'>, record: Kept | Text | Received | Quote | QuoteState, atMs: number): void {
    const entry = { kind, record } as ShopEntry;
    this.replay(entry);
    this.log?.append(entry, atMs);
  }

  /** A write's key and the reference it was given, kept so a repeat (after a restart too) is done once: call it once the write is done. */
  remember(name: string, ref: string, atMs: number): void {
    this.written.set(name, ref);
    this.log?.append({ kind: 'written', name, ref }, atMs);
  }

  /** A write's key held in memory alone while the write is under way, so a repeat in the same turn is caught; remember files it once the write is done. */
  hold(name: string, ref: string): void {
    this.written.set(name, ref);
  }

  /** One entry into memory: what keep does, and what reading the log back does for each line. */
  private replay(e: ShopEntry): void {
    switch (e.kind) {
      case 'request': {
        this.requests.push(e.record);
        // On file by its callback number, so a photo texted in from it is matched to this request.
        const number = tenDigits(e.record.callbackNumber ?? '');
        if (number !== '') this.onFile.set(number, { ref: e.record.ref, name: nameWords(e.record.callerName ?? ''), vehicle: e.record.vehicle ?? '', textOk: e.record.textOk ?? '', atMs: Date.parse(e.record.at) });
        return;
      }
      case 'booking': {
        this.bookings.push(e.record);
        const at = `${e.record.day ?? ''} ${e.record.window ?? ''}`;
        this.booked.set(at, (this.booked.get(at) ?? 0) + (COUNTS[e.record.cars ?? ''] ?? 1));
        // A booking a customer's reply made from a quote (src/quotes.ts): the quote is booked, its hold now this booking, in one line.
        if (e.record.quote !== undefined) this.quoteEnds.set(e.record.quote, { ref: e.record.quote, at: e.record.at, state: 'booked', booking: e.record.ref });
        return;
      }
      case 'callback':
        this.callbacks.push(e.record);
        return;
      case 'text':
        this.texts.push(e.record);
        return;
      case 'received':
        this.received.push(e.record);
        return;
      case 'written':
        this.written.set(e.name, e.ref);
        return;
      case 'quote':
        // A newer quote for the request supersedes one still waiting, its hold released, in the same line.
        for (const q of this.quotes) {
          if (q.request === e.record.request && this.statusOf(q) === 'waiting') this.quoteEnds.set(q.ref, { ref: q.ref, at: e.record.at, state: 'superseded' });
        }
        this.quotes.push(e.record);
        return;
      case 'quote_state':
        this.quoteEnds.set(e.record.ref, e.record);
        return;
    }
  }

  /** A quote's state now. */
  statusOf(q: Quote): QuoteStatus {
    return this.quoteEnds.get(q.ref)?.state ?? 'waiting';
  }

  /** The refs handed out ahead of their records, by prefix, so two texts in flight never take one reference. */
  private readonly taken = new Map<string, number>();

  /** The next reference for `prefix` ("T104"), taken now: past the `count` records kept and every reference already taken. */
  nextRef(prefix: string, count: number): string {
    const n = Math.max(count, this.taken.get(prefix) ?? 0);
    this.taken.set(prefix, n + 1);
    return `${prefix}${101 + n}`;
  }

  /** Whether a request has a booking already (one made from any of its quotes). */
  bookedRequest(request: string): boolean {
    return this.bookings.some((b) => b.request === request);
  }

  /** A request's quotes, in order. */
  quotesOf(request: string): Quote[] {
    return this.quotes.filter((q) => q.request === request);
  }

  /** A request's state, as the shop page shows it. */
  requestStatus(request: Kept): RequestStatus {
    const latest = this.quotesOf(request.ref).at(-1);
    if (latest !== undefined) {
      const st = this.statusOf(latest);
      if (st === 'booked') return 'booked';
      if (st === 'waiting') return 'quoted';
      if (st === 'lapsed') return 'lapsed';
      if (st === 'withdrawn') return 'withdrawn';
    }
    return this.received.some((r) => r.request === request.ref && r.media.length > 0) ? 'photo' : 'new';
  }

  /** The cars held in a window for quotes waiting on a reply (a retail car each). */
  held(day: string, window: string): number {
    return this.quotes.filter((q) => q.day === day && q.window === window && this.statusOf(q) === 'waiting').length;
  }

  /** The windows with room left on a day: none on a day the shop is closed. */
  freeWindows(day: string): string[] {
    if (!opensOn(day)) return [];
    return WINDOW_NAMES.filter((w) => this.roomIn(day, w) > 0);
  }

  /** The cars a window has room for on a day, after the standing drop-off, the bookings and the quotes holding it: none on a day the shop is closed or in a window it does not have. */
  roomIn(day: string, window: string): number {
    if (!opensOn(day) || !WINDOW_NAMES.includes(window)) return 0;
    return capacityOf(window) - standingCars(day, window) - (this.booked.get(`${day} ${window}`) ?? 0) - this.held(day, window);
  }
}

/** A number as it is recorded and printed: by its last four ("...0177"). */
export const last4 = (digits: string): string => `...${digits.slice(-4)}`;

/** The owner's summary (business.yaml's owner.summary), filled: a fixed template, never a generated line. */
export function ownerSummary(vars: Readonly<Record<string, string>>): string {
  const template = BUSINESS.owner?.summary ?? '';
  return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_whole, v: string) => vars[v] ?? '');
}

/** The account a booking is for, by its key (the account slot's value): its name and the first number it calls from. */
export function accountOf(key: string): { name: string; number: string } {
  const a = (BUSINESS.accounts ?? []).find((x) => optionKey(x.name) === key);
  // The first number written out: one read from a setting (env.<NAME>, a tester's phone) is never in the summary.
  const number = a?.numbers.find((n) => !n.startsWith('env.')) ?? '';
  return { name: a?.name ?? key, number: number.replace(/^\+1/, '') };
}

/** A name as the owner reads it: the name slot keeps it in lower case ("jordan lee" is Jordan Lee). */
export const nameWords = (name: string): string => name.replace(/(^|[\s'-])(\p{Ll})/gu, (_m, b: string, c: string) => b + c.toUpperCase());

/** A day as the owner reads it ("Wednesday, November 11"). */
export const dayWords = (iso: string): string => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? describeDay(iso) : iso);

/**
 * A write done once for its key: `make` runs the first time and its reference is kept; a call repeated
 * with the same key returns the same reference and does nothing again.
 */
export function once(sys: Systems, key: string | undefined, prefix: string, count: number, nowMs: number, make: (ref: string) => string): { value: { ref: string }; summary: string; ref: string } {
  const seen = key === undefined ? undefined : sys.written.get(`${prefix} ${key}`);
  if (seen !== undefined) return { value: { ref: seen }, summary: `${seen} (already done)`, ref: seen };
  const ref = `${prefix}${101 + count}`;
  const summary = make(ref);
  if (key !== undefined) sys.remember(`${prefix} ${key}`, ref, nowMs);
  return { value: { ref }, summary, ref };
}

/** `once` for a write that waits on a system (a text): its key taken before it waits, so a repeat on the same turn does nothing again. */
export async function onceAsync(sys: Systems, key: string | undefined, prefix: string, count: number, nowMs: number, make: (ref: string) => Promise<string>): Promise<{ value: { ref: string }; summary: string; ref: string }> {
  const seen = key === undefined ? undefined : sys.written.get(`${prefix} ${key}`);
  if (seen !== undefined) return { value: { ref: seen }, summary: `${seen} (already done)`, ref: seen };
  const ref = `${prefix}${101 + count}`;
  // Held before it waits, so a repeat on the same turn does nothing again; on file only once the write is done,
  // so a crash in flight leaves no key on file and the write (a text) is made again after the restart.
  if (key !== undefined) sys.hold(`${prefix} ${key}`, ref);
  const summary = await make(ref);
  if (key !== undefined) sys.remember(`${prefix} ${key}`, ref, nowMs);
  return { value: { ref }, summary, ref };
}

/**
 * The ten digits a request on file holds for a number a text came from: only a North American number in E.164
 * ("+15555550177" is 5555550177), matched exactly (the engine's sameNumber); null for any other ("+445555550177").
 */
export function usNumber(from: string): string | null {
  const ten = from.replace(/\D/g, '').slice(-10);
  return from.startsWith('+1') && ten.length === 10 && sameNumber(from, `+1${ten}`) ? ten : null;
}

/** The ten digits of a number, as a callback number holds them ("+15555550177" is 5555550177). */
export const tenDigits = (n: string): string => n.replace(/\D/g, '').slice(-10);

/** A time as the log and the page keep it (ISO). */
export const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * A text: sent through the server's sender where there is one and a number to send to, else printed (the
 * server and the text CLI print; the tests and the regression stay quiet). Kept whole on the systems; its
 * summary, which the trace and the audit show, has the number by its last four and `masked` for its words.
 * The key (the write's) is the sender's too, so a text repeated after a restart is not sent twice.
 */
export async function sendText(sys: Systems, texts: Texts | undefined, nowMs: number, ref: string, to: string, body: string, masked: string, opts: { media?: string[]; key?: string } = {}): Promise<string> {
  return (await deliver(sys, texts, nowMs, ref, to, body, masked, opts)).line;
}

/** A text's statuses that mean it did not go: refused by a limit or the page's allow-list, failed, or only printed. */
export const NOT_SENT: readonly string[] = ['failed', 'limited', 'refused', 'printed'];

/** sendText, with the text as kept (its status: whether it went, NOT_SENT). */
export async function deliver(sys: Systems, texts: Texts | undefined, nowMs: number, ref: string, to: string, body: string, masked: string, opts: { media?: string[]; key?: string } = {}): Promise<{ text: Text; line: string }> {
  const media = opts.media !== undefined && opts.media.length > 0 ? { media: opts.media } : {};
  const shown = to === '' ? 'no number' : last4(to);
  if (texts === undefined || to === '') {
    const text: Text = { ref, at: iso(nowMs), to, text: body, ...media, status: 'printed' };
    sys.keep('text', text, nowMs);
    const line = `text to ${shown} (printed, not sent${to === '' ? `: ${SHOP_PHONE} unset` : ''}): ${masked}${opts.media !== undefined && opts.media.length > 0 ? ` [${opts.media.length} photo${opts.media.length === 1 ? '' : 's'}]` : ''}`;
    if (printing) console.log(`[wheelshop] ${line}`);
    return { text, line };
  }
  const r = await texts.send({ to, body, ...media, ...(opts.key !== undefined ? { key: opts.key } : {}) });
  const text: Text = { ref, at: iso(nowMs), to, text: body, ...media, status: r.status };
  sys.keep('text', text, nowMs);
  return { text, line: `text to ${shown}: ${r.status}${r.error !== undefined ? ` (${r.error})` : ''}` };
}

/** The params every call a form makes carries: its fields by name (and a booking's account first). */
const REQUEST = ['callerName', 'vehicle', 'wheels', 'damage', 'diamondCut', 'day', 'window', 'callbackNumber', 'textOk'];
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
    run(call, sys, { idempotencyKey, tc }) {
      const s = sys as Systems;
      return once(s, idempotencyKey, 'R', s.requests.length, tc.nowMs, (ref) => {
        // Kept, and on file by its callback number, so a photo texted in from it is matched to this request.
        s.keep('request', { ...call.params, ref, at: iso(tc.nowMs) }, tc.nowMs);
        return `request ${ref} for ${call.params.day ?? ''} ${call.params.window ?? ''}`;
      });
    },
    check: REF,
  },

  // The caller is asked to reply with a photo. The gate lets this run only where the caller said yes to being
  // texted (business.yaml's `when` on textOk): this code never checks the consent itself.
  send_photo_link: {
    params: REQUEST,
    idempotent: true,
    async run(call, sys, { idempotencyKey, texts, tc }) {
      const s = sys as Systems;
      const to = call.params.callbackNumber ?? '';
      const body = textLine('photoRequest');
      return onceAsync(s, idempotencyKey, 'P', s.texts.length, tc.nowMs, (ref) => sendText(s, texts, tc.nowMs, ref, to, body, body, idempotencyKey !== undefined ? { key: idempotencyKey } : {}));
    },
    check: REF,
  },

  notify_owner_request: {
    params: REQUEST,
    idempotent: true,
    async run(call, sys, { idempotencyKey, texts, env, tc }) {
      const s = sys as Systems;
      const p = call.params;
      const vars = { kind: 'request', who: nameWords(p.callerName ?? ''), details: requestDetails(p), day: dayWords(p.day ?? ''), window: p.window ?? '' };
      return onceAsync(s, idempotencyKey, 'N', s.texts.length, tc.nowMs, (ref) =>
        sendText(s, texts, tc.nowMs, ref, env(SHOP_PHONE) ?? '', ownerSummary({ ...vars, callbackNumber: p.callbackNumber ?? '' }), ownerSummary({ ...vars, callbackNumber: last4(p.callbackNumber ?? '') }), idempotencyKey !== undefined ? { key: idempotencyKey } : {}));
    },
    check: REF,
  },

  book: {
    params: BOOKING,
    idempotent: true,
    run(call, sys, { idempotencyKey, tc }) {
      const s = sys as Systems;
      const p = call.params;
      // The calendar refuses a window without room for the cars, as a real one would (the gate does not
      // know the calendar): nothing is booked, and its reply is no reference, so the call is handed off.
      const repeat = idempotencyKey !== undefined && s.written.has(`B ${idempotencyKey}`);
      if (!repeat && s.roomIn(p.day ?? '', p.window ?? '') < (COUNTS[p.cars ?? ''] ?? 1)) {
        return { value: { full: true }, summary: `${p.day ?? ''} ${p.window ?? ''}: no room for ${p.cars ?? ''} cars, not booked` };
      }
      return once(s, idempotencyKey, 'B', s.bookings.length, tc.nowMs, (ref) => {
        // Kept, and its cars counted into the window.
        s.keep('booking', { ...p, ref, at: iso(tc.nowMs) }, tc.nowMs);
        return `booking ${ref}: ${p.cars ?? ''} cars for ${p.account ?? ''}, ${p.day ?? ''} ${p.window ?? ''}`;
      });
    },
    check: REF,
  },

  notify_owner_booking: {
    params: BOOKING,
    idempotent: true,
    async run(call, sys, { idempotencyKey, texts, env, tc }) {
      const s = sys as Systems;
      const p = call.params;
      const account = accountOf(p.account ?? '');
      const summary = ownerSummary({ kind: 'booking', who: account.name, callbackNumber: account.number, details: `${p.cars ?? ''} cars, ${p.vehicles ?? ''}`, day: dayWords(p.day ?? ''), window: p.window ?? '' });
      // The account's own number is the business's record, not a caller's: in the summary whole.
      return onceAsync(s, idempotencyKey, 'N', s.texts.length, tc.nowMs, (ref) => sendText(s, texts, tc.nowMs, ref, env(SHOP_PHONE) ?? '', summary, summary, idempotencyKey !== undefined ? { key: idempotencyKey } : {}));
    },
    check: REF,
  },

  callback: {
    params: ['callbackNumber'],
    idempotent: true,
    async run(call, sys, { idempotencyKey, texts, env, tc }) {
      const s = sys as Systems;
      const number = call.params.callbackNumber ?? '';
      return onceAsync(s, idempotencyKey, 'C', s.callbacks.length, tc.nowMs, async (ref) => {
        s.keep('callback', { ...call.params, ref, at: iso(tc.nowMs) }, tc.nowMs);
        await sendText(s, texts, tc.nowMs, ref, env(SHOP_PHONE) ?? '', textLine('callbackNote', { number, ref }), textLine('callbackNote', { number: last4(number), ref }), idempotencyKey !== undefined ? { key: idempotencyKey } : {});
        return `callback note ${ref} for ${last4(number)}`;
      });
    },
    check: REF,
  },
};

/**
 * A text that came in to the shop's number (App.onText). First the holds whose time is up lapse; then a text
 * with words from the number a quote is waiting on is a reply to it, read by the decision model (src/quotes.ts
 * replyToQuote), and one to a quote lapsed lately goes to the shop to call (replyToLapsed). Otherwise it is sent on to the shop's phone as it came, its photos
 * attached by their URLs (the engine fetches none), the caller's words cut to FORWARD_MAX. From a number with
 * a request on file in the last week, with a line naming the request, and, where it brought a photo and the
 * request said yes to being texted and is not yet quoted, the caller thanked in the shop's words; from
 * any other number, as a text with no request on file. A text with no photo is sent on too, and not answered,
 * so a word like STOP is never answered with a promise of a price (Twilio answers STOP and HELP itself). With no
 * sender, or no SHOP_PHONE, each is printed.
 */
export async function onText(m: IncomingText, ctx: TextContext): Promise<void> {
  const s = ctx.sys as Systems;
  // The holds whose time is up lapse first (src/quotes.ts), so a reply is read against the quote as it stands.
  await lapseDue(s, ctx.texts, ctx.env, ctx.nowMs);
  // A request on file only for the number exactly, a North American one in E.164 (usNumber).
  const number = usNumber(m.from);
  const found = number === null ? undefined : s.onFile.get(number);
  const recent = found !== undefined && ctx.nowMs - found.atMs <= ON_FILE_MS ? found : undefined;
  // A reply to a quote the shop texted this number (waiting, or lapsed lately).
  const quote = quoteFor(s, m.from, ctx.nowMs);
  const media = m.media.map((x) => x.url);
  // Kept whole for the shop page, with the request it was matched to.
  const request = quote?.request ?? recent?.ref;
  s.keep('received', { ref: `I${101 + s.received.length}`, at: iso(ctx.nowMs), from: m.from, text: m.body, media, ...(request !== undefined ? { request } : {}) }, ctx.nowMs);
  if (quote !== undefined && m.body.trim() !== '') {
    // Only a quote that is waiting is read by the decision model; a reply to a lapsed one goes to the shop to call.
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

/** A text forwarded to the shop: the shop's line, then the caller's own words as they came, cut to FORWARD_MAX. */
export function forwardBody(line: string, said: string): string {
  const words = said.trim();
  const room = FORWARD_MAX - line.length - 2;
  return words === '' ? line : `${line}: ${words.length > room ? `${words.slice(0, room - 1)}…` : words}`;
}

/** A request's values, as the gate grid sends them (its textOk given by each case). */
const MATRIX_REQUEST = { callerName: 'Jordan Lee', vehicle: '2020 BMW 3 Series', wheels: 'one', damage: 'curb rash', diamondCut: 'yes', day: '2026-11-12', window: 'morning', callbackNumber: '5555550177' };

/** The app's TypeScript parts: its tools, its systems and the gate grid's people. */
export const code: AppCode = {
  slots: {},
  forms: {},
  tools: TOOLS,
  systems: () => ({ sys: new Systems(), lookups: { ownerOf: () => null, scopeOf: () => [] } }),
  onText,
  // The shop page, /wheelshop/shop, behind the console's sign-in; mounting it opens the shop's log (SHOP_DATA_DIR).
  pages: shopPages,
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
        request_textOk: { value: 'yes', display: 'yes' },
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
        // The text asking for a photo, with the caller's yes to being texted and with a no: the gate's consent rule.
        send_photo_link: { consented: { ...MATRIX_REQUEST, textOk: 'yes' }, declined: { ...MATRIX_REQUEST, textOk: 'no' } },
      },
      values: {
        callerName: 'Jordan Lee', vehicle: '2020 BMW 3 Series', wheels: 'one', damage: 'curb rash', diamondCut: 'yes',
        day: '2026-11-12', window: 'morning', callbackNumber: '5555550177', textOk: 'yes', cars: 'three', vehicles: '2019 Civic, Tacoma, 2021 Model 3',
      },
    }),
  },
};

/** The app: the folder joined with the code above. */
export const app = defineApp(APP_DIR, code, { codeFile: 'src/app.ts' });
