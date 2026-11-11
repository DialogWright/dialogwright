import { describeDay, parseIso, sameNumber, type ConverseApp, type Texts } from 'dialogwright';
import { ShopLog, type ShopEntry } from './shopLog';
import { SHOP_TEXTS } from './shopTexts';

/**
 * The shop's systems, stand-ins until the owner says what the shop uses (copied from the agent-mode wheel shop,
 * apps/wheelshop, which plan 3 removes): the shop's fake calendar (the drop-off windows of agent.yaml's
 * calendar, each with its capacity, less the cars booked, the requests waiting for a quote and the quotes
 * holding a window), the requests, bookings and callback notes kept, the texts sent and received, the quotes
 * the shop sends from its page, and each write's key, so a write repeated is done once. In memory, and in the
 * shop's log once the server opens it (openLog, SHOP_DATA_DIR).
 *
 * A request takes a place in the window its caller picked until the shop quotes it; the quote's hold then
 * stands for it (src/quotes.ts), and a dealership's booking takes a place per car. A standing dealership
 * drop-off fills every Friday morning, so the demo has a full window to meet.
 */

/** A choice's words as a count ("three" is 3). */
export const COUNTS: Readonly<Record<string, number>> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };

const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

/** What the systems take from agent.yaml: the calendar's days and windows, the business's time zone and the accounts. */
export interface ShopConfig {
  readonly days: readonly string[];
  readonly windows: readonly { readonly name: string; readonly label: string; readonly capacity: number }[];
  readonly timeZone: string;
  readonly accounts: readonly { readonly name: string; readonly numbers: readonly string[] }[];
}

/** The shop's configuration from its agent.yaml. */
export function shopConfigOf(b: ConverseApp['business']): ShopConfig {
  return {
    days: (b.sources.calendar?.days ?? []).map((d) => d.trim().toLowerCase()),
    windows: b.sources.calendar?.windows ?? [],
    timeZone: b.business.timezone ?? 'UTC',
    accounts: b.sources.accounts ?? [],
  };
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
  /** 6 pm the day before the drop-off (ISO), in the business's time zone: the last moment it may be booked. */
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

/** A drop-off window free on a day, as check_availability returns it: its id (`<day>:<window>`), how it is said, and how many cars it can still take. */
export interface ShopSlot {
  readonly id: string;
  readonly label: string;
  readonly room: number;
}

/** The most characters a text forwarded to the shop carries: under a long SMS's 1,600, the caller's words cut to fit. */
export const FORWARD_MAX = 1500;

/** How long a request is matched to a text from its number: a week. */
export const ON_FILE_MS = 7 * 24 * 60 * 60 * 1000;

/** The setting the shop's phone is read from (the app's own settings; never agent.yaml): unset, the shop's texts are printed. */
export const SHOP_PHONE = 'SHOP_PHONE';

/** One of the shop's texts (src/shopTexts.ts), its placeholders filled: a fixed line, never a generated one. */
export function textLine(name: keyof typeof SHOP_TEXTS, vars: Readonly<Record<string, string>> = {}): string {
  return SHOP_TEXTS[name].replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_whole, v: string) => vars[v] ?? '');
}

/** Whether the texts are printed to the log (the server turns it on; the tests stay quiet). */
let printing = false;
export function printTexts(on: boolean): void {
  printing = on;
}

/** The ISO date of `ms` in a time zone. */
function localDay(ms: number, timeZone: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(ms).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/**
 * The app's systems: one per app (the server's, shared by every call, by onText and by the shop page; a test
 * its own). Built before agent.yaml is joined to the code, so its configuration is given once that is read
 * (configure). Replace these with clients for the shop's real calendar once the owner says what the shop uses.
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
  /** The requests on file by the ten digits of their callback number, so a photo texted in is matched to its request. */
  readonly onFile = new Map<string, OnFile>();
  /** The cars booked into each window on this calendar, by `<day> <window>`. */
  readonly booked = new Map<string, number>();
  /** The reference each write's key was given. */
  readonly written = new Map<string, string>();
  /** The quotes the shop sent from its page, in order (src/quotes.ts). */
  readonly quotes: Quote[] = [];
  /** What became of each quote that is no longer waiting, by its reference. */
  readonly quoteEnds = new Map<string, QuoteState>();
  private cfg: ShopConfig | null = null;

  constructor(readonly now: () => number = () => Date.now()) {}

  /** The calendar's days and windows, the time zone and the accounts, from agent.yaml. */
  configure(cfg: ShopConfig): void {
    this.cfg = cfg;
  }

  get config(): ShopConfig {
    if (this.cfg === null) throw new Error('the shop\'s systems are used before agent.yaml was read (Systems.configure)');
    return this.cfg;
  }

  /** The drop-off windows by name, in agent.yaml's order. */
  get windowNames(): string[] {
    return this.config.windows.map((w) => w.name);
  }

  /** How many cars a window takes (agent.yaml's capacity); none for a window it does not have. */
  capacityOf(window: string): number {
    return this.config.windows.find((w) => w.name === window)?.capacity ?? 0;
  }

  /** A window as a customer reads it: agent.yaml's label for it ("morning, by 8"). */
  windowSays(window: string): string {
    return this.config.windows.find((w) => w.name === window)?.label ?? window;
  }

  /** Whether the shop works on a day (agent.yaml's calendar days). */
  opensOn(day: string): boolean {
    return this.config.days.includes(WEEKDAY_NAMES[new Date(parseIso(day)).getUTCDay()]!);
  }

  /** The stand-in calendar's one booking already in: a standing dealership drop-off that fills every Friday morning. */
  standingCars(day: string, window: string): number {
    return WEEKDAY_NAMES[new Date(parseIso(day)).getUTCDay()] === 'friday' && window === 'morning' ? this.capacityOf('morning') : 0;
  }

  /** An account by its name: its name and the first number written out for it (one read from a setting, a tester's phone, is never in a summary). */
  accountOf(name: string): { name: string; number: string } {
    const a = this.config.accounts.find((x) => x.name === name);
    const number = a?.numbers.find((n) => !n.startsWith('env.')) ?? '';
    return { name: a?.name ?? name, number: number.replace(/^\+1/, '') };
  }

  /** Where the records are kept: the log's file, or null for memory alone. */
  get logFile(): string | null {
    return this.log?.file ?? null;
  }

  /**
   * Keeps the records in the log in `dir` from now on, after reading back what it holds (the shop page does
   * this once, as the app is made). Returns how many records were read (a write's key is not one), how many
   * lines skipped, and any warning about the folder. Opened once: a second call does nothing.
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

  /** The requests waiting in a window for their first quote: each holds the place its caller picked until the shop quotes it. */
  waiting(day: string, window: string): number {
    return this.requests.filter((r) => r.day === day && r.window === window && this.quotesOf(r.ref).length === 0).length;
  }

  /** The windows with room left on a day: none on a day the shop is closed. */
  freeWindows(day: string): string[] {
    if (!this.opensOn(day)) return [];
    return this.windowNames.filter((w) => this.roomIn(day, w) > 0);
  }

  /** The cars a window has room for on a day, after the standing drop-off, the bookings, the requests waiting for a quote and the quotes holding it: none on a day the shop is closed or in a window it does not have. */
  roomIn(day: string, window: string): number {
    if (!this.opensOn(day) || !this.windowNames.includes(window)) return 0;
    return this.capacityOf(window) - this.standingCars(day, window) - (this.booked.get(`${day} ${window}`) ?? 0) - this.held(day, window) - this.waiting(day, window);
  }

  /** The business's today (ISO), in its time zone. */
  today(): string {
    return localDay(this.now(), this.config.timeZone);
  }

  /** The shop's fake calendar: the windows with room on a day from today on, each with its id, how it is said and its room. */
  free(day: string): ShopSlot[] {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < this.today()) return [];
    return this.freeWindows(day).map((w) => ({ id: `${day}:${w}`, label: `${dayWords(day)}, ${this.windowSays(w)}`, room: this.roomIn(day, w) }));
  }
}

/** A slot's id (`<day>:<window>`) as its day and window. */
export function slotParts(slot: string): { day: string; window: string } {
  const at = slot.indexOf(':');
  return at < 0 ? { day: slot, window: '' } : { day: slot.slice(0, at), window: slot.slice(at + 1) };
}

/** A number as it is recorded and printed: by its last four ("...0177"). */
export const last4 = (digits: string): string => `...${digits.replace(/\D/g, '').slice(-4)}`;

/** The shop's summary of a request or booking (SHOP_TEXTS.summary), filled: a fixed template, never a generated line. */
export function ownerSummary(vars: Readonly<Record<string, string>>): string {
  return textLine('summary', vars);
}

/** A name as the shop reads it, each word capitalised ("jordan lee" is Jordan Lee). */
export const nameWords = (name: string): string => name.replace(/(^|[\s'-])(\p{Ll})/gu, (_m, b: string, c: string) => b + c.toUpperCase());

/** A day as the shop reads it ("Wednesday, November 11"). */
export const dayWords = (iso: string): string => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? describeDay(iso) : iso);

/**
 * A write done once for its key: `make` runs the first time and its reference is kept; a call repeated
 * with the same key returns the same reference and does nothing again.
 */
export function once(sys: Systems, key: string | undefined, prefix: string, count: number, nowMs: number, make: (ref: string) => string): { summary: string; ref: string } {
  const seen = key === undefined ? undefined : sys.written.get(`${prefix} ${key}`);
  if (seen !== undefined) return { summary: `${seen} (already done)`, ref: seen };
  const ref = `${prefix}${101 + count}`;
  const summary = make(ref);
  if (key !== undefined) sys.remember(`${prefix} ${key}`, ref, nowMs);
  return { summary, ref };
}

/** `once` for a write that waits on a system (a text): its key taken before it waits, so a repeat on the same turn does nothing again. */
export async function onceAsync(sys: Systems, key: string | undefined, prefix: string, count: number, nowMs: number, make: (ref: string) => Promise<string>): Promise<{ summary: string; ref: string }> {
  const seen = key === undefined ? undefined : sys.written.get(`${prefix} ${key}`);
  if (seen !== undefined) return { summary: `${seen} (already done)`, ref: seen };
  const ref = `${prefix}${101 + count}`;
  // Held before it waits, so a repeat on the same turn does nothing again; on file only once the write is done,
  // so a crash in flight leaves no key on file and the write (a text) is made again after the restart.
  if (key !== undefined) sys.hold(`${prefix} ${key}`, ref);
  const summary = await make(ref);
  if (key !== undefined) sys.remember(`${prefix} ${key}`, ref, nowMs);
  return { summary, ref };
}

/**
 * The ten digits a request on file holds for a number a text came from: only a North American number in E.164
 * ("+15555550177" is 5555550177), matched exactly (the engine's sameNumber); null for any other ("+445555550177").
 */
export function usNumber(from: string): string | null {
  const ten = from.replace(/\D/g, '').slice(-10);
  return from.startsWith('+1') && ten.length === 10 && sameNumber(from, `+1${ten}`) ? ten : null;
}

/** The ten digits of a number, as a callback number is kept ("+15555550177" is 5555550177). */
export const tenDigits = (n: string): string => n.replace(/\D/g, '').slice(-10);

/** A time as the log and the page keep it (ISO). */
export const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * A text: sent through the server's sender where there is one and a number to send to, else printed (the
 * server prints; the tests stay quiet). Kept whole on the systems; its summary, which the model is shown, has
 * the number by its last four and `masked` for its words. The key (the write's) is the sender's too, so a
 * text repeated after a restart is not sent twice.
 */
export async function sendText(sys: Systems, texts: Texts | null | undefined, nowMs: number, ref: string, to: string, body: string, masked: string, opts: { media?: string[]; key?: string } = {}): Promise<string> {
  return (await deliver(sys, texts, nowMs, ref, to, body, masked, opts)).line;
}

/** A text's statuses that mean it did not go: refused by a limit or the page's allow-list, failed, or only printed. */
export const NOT_SENT: readonly string[] = ['failed', 'limited', 'refused', 'printed'];

/** sendText, with the text as kept (its status: whether it went, NOT_SENT). */
export async function deliver(sys: Systems, texts: Texts | null | undefined, nowMs: number, ref: string, to: string, body: string, masked: string, opts: { media?: string[]; key?: string } = {}): Promise<{ text: Text; line: string }> {
  const media = opts.media !== undefined && opts.media.length > 0 ? { media: opts.media } : {};
  const shown = to === '' ? 'no number' : last4(to);
  if (texts === undefined || texts === null || to === '') {
    const text: Text = { ref, at: iso(nowMs), to, text: body, ...media, status: 'printed' };
    sys.keep('text', text, nowMs);
    const line = `text to ${shown} (printed, not sent${to === '' ? `: ${SHOP_PHONE} unset` : ''}): ${masked}${opts.media !== undefined && opts.media.length > 0 ? ` [${opts.media.length} photo${opts.media.length === 1 ? '' : 's'}]` : ''}`;
    if (printing) console.log(`[wheelshop-agent] ${line}`);
    return { text, line };
  }
  const r = await texts.send({ to, body, ...media, ...(opts.key !== undefined ? { key: opts.key } : {}) });
  const text: Text = { ref, at: iso(nowMs), to, text: body, ...media, status: r.status };
  sys.keep('text', text, nowMs);
  return { text, line: `text to ${shown}: ${r.status}${r.error !== undefined ? ` (${r.error})` : ''}` };
}

/** A text forwarded to the shop: the shop's line, then the caller's own words as they came, cut to FORWARD_MAX. */
export function forwardBody(line: string, said: string): string {
  const words = said.trim();
  const room = FORWARD_MAX - line.length - 2;
  return words === '' ? line : `${line}: ${words.length > room ? `${words.slice(0, room - 1)}…` : words}`;
}
