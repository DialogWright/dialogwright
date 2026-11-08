import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, startServer, type AnswerMap, type IncomingText, type QuestionMap, type RunningServer, type TextContext, type Texts, type ToolDef, type ToolReply } from 'dialogwright';
import { fakeTextProvider, type FakeSent } from 'dialogwright/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { Systems, TOOLS, onText } from './app';
import { QUOTE_QUESTIONS, accepts, cutoffOf, holdUntilOf, lapseDue, offeredSlots, parsePrice, priceWords, sendQuote } from './quotes';
import { SHOP_LOG_FILE, ShopLog } from './shopLog';
import { formToken, shopPageHtml, shopRoute, shopView } from './shopPage';

/**
 * Quote and confirm (src/quotes.ts, DESIGN.md "Quote and confirm"): the shop quotes a request from its page,
 * the window held; the customer's reply, read by the decision model (a fake here: no test asks a model), books
 * it or goes to the shop; the hold lapses at its time. Every name and number is invented (the 555 range).
 */

const TZ = 'America/Los_Angeles';
const HOUR = 60 * 60 * 1000;
/** Monday, November 9, 2026, 8:05 in the morning in Los Angeles. */
const T0 = Date.parse('2026-11-09T16:05:00Z');
const SHOP = '+15555550190';
const REQUEST = { callerName: 'jordan lee', vehicle: '2020 BMW 3 Series', wheels: 'one', damage: 'curb rash', diamondCut: 'yes', day: '2026-11-12', window: 'morning', callbackNumber: '5555550177', textOk: 'yes' };
const QUOTE_TEXT = 'Example Wheel Works: your quote for the wheel on your 2020 BMW 3 Series is $180. We can take it Thursday, Nov 12, drop off by 8 in the morning, ready by about noon. Reply CONFIRM to book it.';

const dirs: string[] = [];
let running: RunningServer | null = null;
afterEach(async () => {
  await running?.close();
  running = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'wheelshop-quotes-'));
  dirs.push(d);
  return d;
}

async function run(sys: Systems, tool: string, params: Record<string, string>, key: string, nowMs = T0): Promise<ToolReply> {
  const ctx = { idempotencyKey: key, env: () => undefined, tc: { nowMs } };
  return (TOOLS[tool] as ToolDef).run({ tool, params }, sys, ctx as unknown as Parameters<ToolDef['run']>[2]);
}

/** A sender that takes every text (no test reaches Twilio). */
function sender(): { texts: Texts; sent: FakeSent[] } {
  const provider = fakeTextProvider();
  return { texts: { send: (t) => provider.send({ ...t, from: '+15555550100' }) }, sent: provider.sent };
}

/** A fake decision model: these answers for every asking, each asking's questions and `about` kept. */
function model(acceptsQuote: number, asksChange: number): { decide: TextContext['decide']; asked: { questions: QuestionMap; about: Readonly<Record<string, string>> }[] } {
  const asked: { questions: QuestionMap; about: Readonly<Record<string, string>> }[] = [];
  return {
    asked,
    decide: async (questions, about = {}) => {
      asked.push({ questions, about });
      return { acceptsQuote: { type: 'noul', noul: acceptsQuote }, asksChange: { type: 'noul', noul: asksChange } } satisfies AnswerMap;
    },
  };
}

const message = (body: string, from = '+15555550177', media: string[] = []): IncomingText => ({ id: 'SM1', from, to: '+15555550100', body, media: media.map((url) => ({ url, contentType: 'image/jpeg' })), provider: 'twilio' });
const ctx = (sys: Systems, texts: Texts, decide: TextContext['decide'], nowMs: number): TextContext => ({ texts, env: (n) => (n === 'SHOP_PHONE' ? SHOP : undefined), sys, nowMs, decide });

/** A request on file and a quote for it: $180 for its own window (Thursday morning), sent at `at`. */
async function quoted(sys: Systems, texts: Texts, at = T0, request = REQUEST): Promise<void> {
  await run(sys, 'request', request, 'k-r1', at);
  const sent = await sendQuote(sys, texts, { request: 'R101', version: '0', price: '180', slot: `${request.day} ${request.window}` }, at, TZ);
  expect(sent.ok).toBe(true);
}

describe('the hold\'s deadlines', () => {
  it('6 pm the day before the drop-off, in the time zone, through a change of the clocks', () => {
    expect(new Date(cutoffOf('2026-11-12', TZ)).toISOString()).toBe('2026-11-12T02:00:00.000Z');
    // The clocks went back on Sunday, November 1, 2026, and forward on Sunday, March 8.
    expect(new Date(cutoffOf('2026-11-02', TZ)).toISOString()).toBe('2026-11-02T02:00:00.000Z');
    expect(new Date(cutoffOf('2026-03-09', TZ)).toISOString()).toBe('2026-03-09T01:00:00.000Z');
    expect(new Date(cutoffOf('2026-11-12', 'America/New_York')).toISOString()).toBe('2026-11-11T23:00:00.000Z');
  });

  it('a hold ends 24 hours after the quote, or at the cutoff, whichever comes first', () => {
    expect(new Date(holdUntilOf(T0, '2026-11-12', TZ)).toISOString()).toBe('2026-11-10T16:05:00.000Z');
    expect(new Date(holdUntilOf(Date.parse('2026-11-11T17:00:00Z'), '2026-11-12', TZ)).toISOString()).toBe('2026-11-12T02:00:00.000Z');
  });

  it('reads a price as the shop types it, in cents, and says it as a customer reads it', () => {
    expect(['180', '$180', ' 180.5 ', '1,250.50', '0', '-5', '18O', '12.345', ''].map(parsePrice)).toEqual([18000, 18000, 18050, 125050, null, null, null, null, null]);
    expect([18000, 18050, 125000].map(priceWords)).toEqual(['$180', '$180.50', '$1,250']);
  });
});

describe('a quote sent', () => {
  it('texts the customer the quote in business.yaml\'s words, holds the window, and shows the request quoted and waiting', async () => {
    const sys = new Systems();
    const { texts, sent } = sender();
    await run(sys, 'request', REQUEST, 'k-r1');
    expect(sys.roomIn('2026-11-12', 'morning')).toBe(3);
    const r = await sendQuote(sys, texts, { request: 'R101', version: '0', price: '$180', slot: '2026-11-12 morning' }, T0, TZ);
    expect(r).toMatchObject({ ok: true, repeat: false, quote: { ref: 'Q101', request: 'R101', price: '18000', day: '2026-11-12', window: 'morning', to: '5555550177', holdUntil: '2026-11-10T16:05:00.000Z', cutoff: '2026-11-12T02:00:00.000Z' } });
    expect(sent.map((t) => [t.to, t.body])).toEqual([['5555550177', QUOTE_TEXT]]);
    // The window is held: one car less room, for the dealerships' calendar too.
    expect(sys.roomIn('2026-11-12', 'morning')).toBe(2);
    expect(sys.requestStatus(sys.requests[0]!)).toBe('quoted');
    const html = shopPageHtml(shopView(sys, { nowMs: T0, timeZone: TZ }), { brand: { name: 'Example Wheel Works', mark: 'EW' }, timeZone: TZ, nowMs: T0, nonce: 'n', logFile: null, quoteForm: { action: '/wheelshop/shop/quote', token: () => 't' } });
    expect(html).toContain('<span class="badge state-quoted">Quoted, waiting</span>');
    expect(html).toContain('Quoted $180 for Thursday, Nov 12, morning (Q101): waiting for CONFIRM, held until <time datetime="2026-11-10T16:05:00.000Z">Tue, Nov 10, 8:05 AM</time>. Texted: queued.');
    expect(html).toContain('<span class="state">Quoted, waiting<span class="count">1</span></span>');
    expect(html).toContain('<span class="badge">1 of 3 cars, 1 held</span>');
  });

  it('a double submit of one form quotes once: the same quote, no second text', async () => {
    const sys = new Systems();
    const { texts, sent } = sender();
    await run(sys, 'request', REQUEST, 'k-r1');
    const form = { request: 'R101', version: '0', price: '180', slot: '2026-11-12 morning' };
    const [a, b] = await Promise.all([sendQuote(sys, texts, form, T0, TZ), sendQuote(sys, texts, form, T0, TZ)]);
    const c = await sendQuote(sys, texts, form, T0 + 1000, TZ);
    expect([a, b, c].map((x) => x.ok && x.quote.ref)).toEqual(['Q101', 'Q101', 'Q101']);
    expect([b, c].map((x) => x.ok && x.repeat)).toEqual([true, true]);
    expect(sys.quotes).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sys.roomIn('2026-11-12', 'morning')).toBe(2);
  });

  it('a new quote (the next version) supersedes the one waiting, its hold moved', async () => {
    const sys = new Systems();
    const { texts } = sender();
    await quoted(sys, texts);
    // An old form (version 0) again with other values is not a new quote; the next version is.
    expect(await sendQuote(sys, texts, { request: 'R101', version: '1', price: '200', slot: '2026-11-12 afternoon' }, T0 + HOUR, TZ)).toMatchObject({ ok: true, quote: { ref: 'Q102' } });
    expect(sys.statusOf(sys.quotes[0]!)).toBe('superseded');
    expect([sys.roomIn('2026-11-12', 'morning'), sys.roomIn('2026-11-12', 'afternoon')]).toEqual([3, 2]);
    expect(await sendQuote(sys, texts, { request: 'R101', version: '1', price: '200', slot: '2026-11-12 morning' }, T0 + HOUR, TZ)).toMatchObject({ ok: true, repeat: true, quote: { ref: 'Q102' } });
    expect(await sendQuote(sys, texts, { request: 'R101', version: '5', price: '200', slot: '2026-11-12 morning' }, T0 + HOUR, TZ)).toMatchObject({ ok: false, status: 409 });
  });

  it('offers only windows with room on days the shop opens whose 6 pm the day before is still to come, and refuses any other', async () => {
    const sys = new Systems();
    const { texts } = sender();
    await run(sys, 'request', REQUEST, 'k-r1');
    await run(sys, 'book', { account: 'rivergate_motors', cars: 'three', vehicles: 'Civic, Tacoma, Model 3', day: '2026-11-12', window: 'afternoon' }, 'k-b1');
    const offered = offeredSlots(sys, 'R101', T0, TZ).map((x) => x.value);
    // Monday's cutoff (Sunday 6 pm) has passed; the weekend is closed; Friday morning is the standing drop-off; Thursday afternoon is booked full.
    expect(offered.slice(0, 7)).toEqual(['2026-11-10 morning', '2026-11-10 afternoon', '2026-11-11 morning', '2026-11-11 afternoon', '2026-11-12 morning', '2026-11-13 afternoon', '2026-11-16 morning']);
    for (const slot of ['2026-11-12 afternoon', '2026-11-13 morning', '2026-11-09 afternoon', '2026-11-14 morning', 'tomorrow']) {
      expect(await sendQuote(sys, texts, { request: 'R101', version: '0', price: '180', slot }, T0, TZ), slot).toMatchObject({ ok: false, status: 409 });
    }
    expect(await sendQuote(sys, texts, { request: 'R101', version: '0', price: 'about 180', slot: '2026-11-12 morning' }, T0, TZ)).toMatchObject({ ok: false, status: 400 });
    expect(sys.quotes).toEqual([]);
  });

  it('a request whose caller said no to texts is never texted a quote: the page says to call them, with the number', async () => {
    const sys = new Systems();
    const { texts, sent } = sender();
    await run(sys, 'request', { ...REQUEST, textOk: 'no' }, 'k-r1');
    expect(await sendQuote(sys, texts, { request: 'R101', version: '0', price: '180', slot: '2026-11-12 morning' }, T0, TZ)).toEqual({ ok: false, status: 409, why: 'The caller asked not to be texted: call them to quote.' });
    expect(sent).toEqual([]);
    expect(sys.quotes).toEqual([]);
    const html = shopPageHtml(shopView(sys, { nowMs: T0, timeZone: TZ }), { brand: { name: 'Example Wheel Works', mark: 'EW' }, timeZone: TZ, nowMs: T0, nonce: 'n', logFile: null, quoteForm: { action: '/wheelshop/shop/quote', token: () => 't' } });
    expect(html).toContain('The caller asked not to be texted: call them to quote, at <a class="tel" href="tel:+15555550177">(555) 555-0177</a>.');
    expect(html).not.toContain('<form class="quote"');
  });
});

describe('the customer\'s reply', () => {
  it('CONFIRM, read by the decision model as a yes, books the held window, texts the customer and the shop, and the card shows booked', async () => {
    const sys = new Systems();
    const { texts, sent } = sender();
    await quoted(sys, texts);
    const m = model(0.97, 0.02);
    await onText(message('CONFIRM'), ctx(sys, texts, m.decide, T0 + HOUR));
    // The model was asked the app's typed questions, with the quote and the word it asked for.
    expect(m.asked).toEqual([{ questions: QUOTE_QUESTIONS, about: { quote: QUOTE_TEXT, replyWord: 'CONFIRM' } }]);
    expect(sent.slice(1).map((t) => [t.to, t.body])).toEqual([
      ['+15555550177', "You're booked with Example Wheel Works for Thursday, Nov 12, drop off by 8 in the morning, ready by about noon. Thanks, see you then."],
      [SHOP, 'Booked from quote Q101: Jordan Lee, ...0177, 2020 BMW 3 Series, Thursday, Nov 12, morning, $180 (B101).'],
    ]);
    expect(sys.bookings).toMatchObject([{ ref: 'B101', quote: 'Q101', request: 'R101', cars: 'one', vehicles: '2020 BMW 3 Series', day: '2026-11-12', window: 'morning', price: '18000' }]);
    expect(sys.statusOf(sys.quotes[0]!)).toBe('booked');
    // The hold is now the booking: one car in the window, not two.
    expect(sys.roomIn('2026-11-12', 'morning')).toBe(2);
    const html = shopPageHtml(shopView(sys, { nowMs: T0 + HOUR, timeZone: TZ }), { brand: { name: 'Example Wheel Works', mark: 'EW' }, timeZone: TZ, nowMs: T0 + HOUR, nonce: 'n', logFile: null, quoteForm: { action: '/wheelshop/shop/quote', token: () => 't' } });
    expect(html).toContain('<span class="badge state-booked">Booked</span>');
    expect(html).toContain('Booked Thursday, Nov 12, morning at $180 (B101, from Q101).');
    // It joins the bookings by day and window, and the card has no form any more.
    expect(html).toContain('<strong>Jordan Lee (quote Q101, $180)</strong> · 1 car: 2020 BMW 3 Series');
    expect(html).not.toContain('<form class="quote"');
    // A second yes books nothing more: the quote is booked, so it is a text like any other.
    await onText(message('CONFIRM'), ctx(sys, texts, m.decide, T0 + 2 * HOUR));
    expect(sys.bookings).toHaveLength(1);
    expect(sent.at(-1)!.body).toBe('Text from Jordan Lee, ...0177, about their 2020 BMW 3 Series request.: CONFIRM');
  });

  it('"can we do Wednesday instead?" is forwarded to the shop, and the hold stays', async () => {
    const sys = new Systems();
    const { texts, sent } = sender();
    await quoted(sys, texts);
    await onText(message('can we do Wednesday instead?'), ctx(sys, texts, model(0.04, 0.95).decide, T0 + HOUR));
    expect(sent.slice(1).map((t) => [t.to, t.body])).toEqual([[SHOP, 'Reply from Jordan Lee, ...0177: can we do Wednesday instead?']]);
    expect(sys.bookings).toEqual([]);
    expect(sys.statusOf(sys.quotes[0]!)).toBe('waiting');
    expect(sys.roomIn('2026-11-12', 'morning')).toBe(2);
  });

  it('a yes the model reads as also asking a change, a reading under the bar, or no reading at all, books nothing', () => {
    expect(accepts({ acceptsQuote: { type: 'noul', noul: 0.9 }, asksChange: { type: 'noul', noul: 0.92 } })).toBe(false);
    expect(accepts({ acceptsQuote: { type: 'noul', noul: 0.6 }, asksChange: { type: 'noul', noul: 0.1 } })).toBe(false);
    expect(accepts(null)).toBe(false);
    expect(accepts({ acceptsQuote: { type: 'noul', noul: 0.7 }, asksChange: { type: 'noul', noul: 0.1 } })).toBe(true);
  });

  it('a yes for a window that filled after the hold lapsed is refused, and the shop told to call', async () => {
    const sys = new Systems();
    const { texts, sent } = sender();
    await quoted(sys, texts);
    // The hold lapses at 24 hours (Tuesday 8:05 am), and a dealership then fills Thursday morning.
    await lapseDue(sys, texts, (n) => (n === 'SHOP_PHONE' ? SHOP : undefined), T0 + 24 * HOUR);
    await run(sys, 'book', { account: 'rivergate_motors', cars: 'three', vehicles: 'Civic, Tacoma, Model 3', day: '2026-11-12', window: 'morning' }, 'k-b1', T0 + 25 * HOUR);
    await onText(message('Confirm!'), ctx(sys, texts, model(0.95, 0.03).decide, T0 + 26 * HOUR));
    expect(sent.at(-1)).toMatchObject({ to: SHOP, body: 'Jordan Lee, ...0177 replied to book quote Q101, but Thursday, Nov 12, morning is full now, so call them. They wrote: Confirm!' });
    expect(sys.bookings.map((b) => b.account)).toEqual(['rivergate_motors']);
    expect(sys.statusOf(sys.quotes[0]!)).toBe('lapsed');
  });

  it('a yes after the hold lapsed books it while the window has room and its 6 pm the day before is to come; after that the shop is told to call', async () => {
    const sys = new Systems();
    const { texts, sent } = sender();
    await quoted(sys, texts);
    await onText(message('yes confirm'), ctx(sys, texts, model(0.95, 0.03).decide, T0 + 30 * HOUR));
    expect(sys.bookings).toMatchObject([{ quote: 'Q101' }]);
    // A quote for Tuesday morning, whose cutoff (Monday 6 pm) passes before the yes.
    const late = new Systems();
    const l = sender();
    await quoted(late, l.texts, T0, { ...REQUEST, day: '2026-11-10' });
    await onText(message('CONFIRM'), ctx(late, l.texts, model(0.95, 0.03).decide, Date.parse('2026-11-10T03:00:00Z')));
    expect(late.bookings).toEqual([]);
    expect(l.sent.at(-1)!.body).toBe('Jordan Lee, ...0177 replied to book quote Q101 after it lapsed, so call them. They wrote: CONFIRM');
  });

  it('a photo texted after the quote is sent on, and the caller not promised a price again', async () => {
    const sys = new Systems();
    const { texts, sent } = sender();
    await quoted(sys, texts);
    const photo = 'https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/MM1/Media/ME1';
    const m = model(0.97, 0.02);
    await onText(message('', '+15555550177', [photo]), ctx(sys, texts, m.decide, T0 + HOUR));
    expect(m.asked).toEqual([]);
    expect(sent.slice(1).map((t) => t.to)).toEqual([SHOP]);
  });
});

describe('the hold lapses', () => {
  it('24 hours after the quote: the window released, the shop told, the card lapsed; not a minute before', async () => {
    const sys = new Systems();
    const { texts, sent } = sender();
    await quoted(sys, texts);
    const env = (n: string): string | undefined => (n === 'SHOP_PHONE' ? SHOP : undefined);
    expect(await lapseDue(sys, texts, env, T0 + 24 * HOUR - 60_000)).toEqual([]);
    expect((await lapseDue(sys, texts, env, T0 + 24 * HOUR)).map((q) => q.ref)).toEqual(['Q101']);
    expect(sent.at(-1)).toMatchObject({ to: SHOP, body: 'Quote Q101 for Jordan Lee, ...0177 lapsed with no reply: Thursday, Nov 12, morning is free again.' });
    expect(sys.roomIn('2026-11-12', 'morning')).toBe(3);
    expect(sys.requestStatus(sys.requests[0]!)).toBe('lapsed');
    // Once: the next check finds nothing to lapse.
    expect(await lapseDue(sys, texts, env, T0 + 25 * HOUR)).toEqual([]);
    expect(sent.filter((t) => t.body.includes('lapsed'))).toHaveLength(1);
  });

  it('at 6 pm the day before the drop-off where that comes first', async () => {
    const sys = new Systems();
    const { texts } = sender();
    // Sent Wednesday at 9 am for Thursday: the hold ends Wednesday at 6 pm, not Thursday at 9 am.
    const at = Date.parse('2026-11-11T17:00:00Z');
    await quoted(sys, texts, at);
    const env = (): undefined => undefined;
    expect(await lapseDue(sys, texts, env, Date.parse('2026-11-12T01:59:00Z'))).toEqual([]);
    expect((await lapseDue(sys, texts, env, Date.parse('2026-11-12T02:00:00Z'))).map((q) => q.ref)).toEqual(['Q101']);
  });

  it('on the page\'s route: as the page is drawn, and on the server\'s sweep, by its clock', async () => {
    const sys = new Systems();
    const { texts, sent } = sender();
    await quoted(sys, texts);
    let now = T0 + HOUR;
    const route = shopRoute(sys, { brand: { name: 'Example Wheel Works', mark: 'EW' }, timeZone: TZ, now: () => now, texts, env: (n) => (n === 'SHOP_PHONE' ? SHOP : undefined) });
    route.sweep!();
    await Promise.all(route.tails!());
    expect(sys.statusOf(sys.quotes[0]!)).toBe('waiting');
    now = T0 + 24 * HOUR;
    route.sweep!();
    await Promise.all(route.tails!());
    expect(sys.statusOf(sys.quotes[0]!)).toBe('lapsed');
    expect(sent.at(-1)!.body).toContain('lapsed with no reply');
  });

  it('survives a restart: the hold read back from the log lapses when its time comes, and the lapse is on file', async () => {
    const dir = scratch();
    const before = new Systems();
    before.openLog(dir);
    const { texts } = sender();
    await quoted(before, texts);
    const after = new Systems();
    after.openLog(dir);
    expect(after.statusOf(after.quotes[0]!)).toBe('waiting');
    expect(after.roomIn('2026-11-12', 'morning')).toBe(2);
    await lapseDue(after, texts, () => undefined, T0 + 24 * HOUR);
    const third = new Systems();
    third.openLog(dir);
    expect(third.statusOf(third.quotes[0]!)).toBe('lapsed');
    expect(third.roomIn('2026-11-12', 'morning')).toBe(3);
  });
});

describe('the shop\'s log, round trip', () => {
  it('every new record is read back whole: a quote, a quote superseded, a lapse and a booking from a quote', async () => {
    const dir = scratch();
    const sys = new Systems();
    sys.openLog(dir);
    const { texts } = sender();
    await quoted(sys, texts);
    await sendQuote(sys, texts, { request: 'R101', version: '1', price: '200', slot: '2026-11-12 afternoon' }, T0 + HOUR, TZ);
    await onText(message('CONFIRM'), ctx(sys, texts, model(0.97, 0.02).decide, T0 + 2 * HOUR));
    await run(sys, 'request', { ...REQUEST, callerName: 'casey morgan', callbackNumber: '5555550188' }, 'k-r2', T0 + 3 * HOUR);
    await sendQuote(sys, texts, { request: 'R102', version: '0', price: '95.50', slot: '2026-11-16 morning' }, T0 + 3 * HOUR, TZ);
    await lapseDue(sys, texts, () => undefined, T0 + 27 * HOUR);
    const back = new Systems();
    expect(back.openLog(dir).skipped).toBe(0);
    const held = (s: Systems) => ({ quotes: s.quotes, ends: [...s.quoteEnds], bookings: s.bookings, booked: [...s.booked], written: [...s.written], texts: s.texts });
    expect(held(back)).toEqual(held(sys));
    expect(back.quotes.map((q) => [q.ref, back.statusOf(q)])).toEqual([['Q101', 'superseded'], ['Q102', 'booked'], ['Q103', 'lapsed']]);
    expect(ShopLog.read(join(dir, SHOP_LOG_FILE)).lines.map((l) => l.kind).filter((k) => k.startsWith('quote'))).toEqual(['quote', 'quote', 'quote', 'quote_state']);
  });
});

describe('the form on the server', () => {
  const TUNNEL = { 'x-forwarded-for': '203.0.113.9', host: 'shop.example.com' };

  async function start(env: Record<string, string>, now: () => number): Promise<{ base: string; sent: FakeSent[] }> {
    const dir = scratch();
    const shop = join(dir, 'shop');
    const before = new Systems();
    before.openLog(shop);
    await run(before, 'request', REQUEST, 'k-r1', now());
    await run(before, 'request', { ...REQUEST, callerName: 'casey morgan', callbackNumber: '5555550188', textOk: 'no' }, 'k-r2', now());
    const provider = fakeTextProvider();
    const all = { TWILIO_AUTH_TOKEN: 't', SHOP_DATA_DIR: shop, TEXT_FROM: '+15555550100', TWILIO_ACCOUNT_SID: `AC${'4'.repeat(32)}`, SHOP_PHONE: SHOP, ...env };
    const config = loadConfig({
      PUBLIC_HOST: 'shop.example.com', HANDOFF_NUMBER: '+15555550101', PORT: '0', TODAY_OVERRIDE: '2026-11-09',
      TRACE_DIR: join(dir, 'traces'), AUDIT_DIR: join(dir, 'audit'), AUDIO_DIR: dir, JEV_CLIENT: 'stub', TIMEZONE: TZ,
      CONSOLE_LINK_FILE: join(dir, 'link', 'link.json'), ...all,
    });
    running = await startServer(config, { host: '127.0.0.1', log: () => {}, env: all, now, textProvider: provider });
    return { base: `http://127.0.0.1:${running.port}`, sent: provider.sent };
  }

  /** The page's form for a request, as the browser would send it. */
  async function formOf(base: string, request: string): Promise<URLSearchParams> {
    const html = await (await fetch(`${base}/wheelshop/shop`)).text();
    const card = html.slice(html.indexOf(`id="${request}"`));
    const form = card.slice(card.indexOf('<form class="quote"'), card.indexOf('</form>'));
    const value = (name: string): string => new RegExp(`name="${name}" value="([^"]*)"`).exec(form)![1]!;
    const slot = /<option value="([^"]+)" selected>/.exec(form)![1]!;
    return new URLSearchParams({ request: value('request'), version: value('version'), token: value('token'), price: '180', slot });
  }

  const post = (base: string, body: URLSearchParams | string, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(`${base}/wheelshop/shop/quote`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: body.toString() });

  it('sends a quote from the page: POST only, with the form\'s token, once for a double submit, the customer texted', async () => {
    const { base, sent } = await start({}, () => T0);
    const form = await formOf(base, 'R101');
    // The caller's own choice is picked: Thursday morning.
    expect(form.get('slot')).toBe('2026-11-12 morning');
    const res = await post(base, form);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/wheelshop/shop#R101');
    expect(sent.map((t) => [t.to, t.body])).toEqual([['5555550177', QUOTE_TEXT]]);
    // The same form again (a double submit): no second quote, no second text.
    expect((await post(base, form)).status).toBe(303);
    expect(sent).toHaveLength(1);
    const html = await (await fetch(`${base}/wheelshop/shop`)).text();
    expect(html).toContain('Quoted $180 for Thursday, Nov 12, morning (Q101)');
    expect(html).toContain('<h4>Send a new quote</h4>');
  });

  it('refuses a form without its token, a GET, and a body that is not a form; and draws no form for a caller who said no to texts', async () => {
    const { base, sent } = await start({}, () => T0);
    const form = await formOf(base, 'R101');
    for (const token of ['', 'x', formToken(Buffer.alloc(32), 'R101', '0')]) {
      const bad = new URLSearchParams(form);
      bad.set('token', token);
      const res = await post(base, bad);
      expect(res.status, token).toBe(403);
      expect(await res.text()).toContain('This form is out of date or did not come from this page');
    }
    // The token is the request's and version's: one form's token does not send another request's.
    const other = new URLSearchParams(form);
    other.set('request', 'R102');
    expect((await post(base, other)).status).toBe(403);
    const get = await fetch(`${base}/wheelshop/shop/quote`);
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    expect((await post(base, JSON.stringify(Object.fromEntries(form)), { 'content-type': 'application/json' })).status).toBe(415);
    expect(sent).toEqual([]);
    const html = await (await fetch(`${base}/wheelshop/shop`)).text();
    const casey = html.slice(html.indexOf('id="R102"'), html.indexOf('</article>', html.indexOf('id="R102"')));
    expect(casey).not.toContain('<form');
    expect(casey).toContain('call them to quote, at <a class="tel" href="tel:+15555550188">(555) 555-0188</a>');
  });

  it('is never public: through the tunnel it does not exist, and behind the console\'s sign-in a browser not signed in is refused', async () => {
    const local = await start({}, () => T0);
    const form = await formOf(local.base, 'R101');
    expect((await post(local.base, form, TUNNEL)).status).toBe(404);
    await running!.close();
    running = null;
    const signed = await start({ CONSOLE_AUTH: 'token' }, () => T0);
    for (const headers of [TUNNEL, {}]) expect((await post(signed.base, form, headers)).status).toBe(401);
    expect(signed.sent).toEqual([]);
  });
});
