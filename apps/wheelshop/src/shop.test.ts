import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, startServer, type IncomingText, type RunningServer, type TextContext, type ToolCall, type ToolDef, type ToolReply } from 'dialogwright';
import { afterEach, describe, expect, it } from 'vitest';
import { Systems, TOOLS, onText } from './app';
import { SHOP_LOG_FILE, ShopLog } from './shopLog';
import { shopPageHtml, shopView } from './shopPage';

/**
 * The shop's records on file (src/shopLog.ts) and the shop page (src/shopPage.ts): what is kept is read back
 * whole after a restart, the page shows it, and the page is never public. Every name and number is invented
 * (the 555 range); every photo URL is a made-up Twilio media path.
 */

const dirs: string[] = [];
let running: RunningServer | null = null;
afterEach(async () => {
  await running?.close();
  running = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'wheelshop-shop-'));
  dirs.push(d);
  return d;
}

/** Runs a tool with a write key and a clock, as the gate does once it allows the call. */
async function run(sys: Systems, tool: string, params: Record<string, string>, key: string, nowMs: number): Promise<ToolReply> {
  const call: ToolCall = { tool, params };
  const ctx = { idempotencyKey: key, env: () => undefined, tc: { nowMs } };
  return (TOOLS[tool] as ToolDef).run(call, sys, ctx as unknown as Parameters<ToolDef['run']>[2]);
}

const T0 = Date.parse('2026-11-09T16:05:00Z');
const MIN = 60_000;
const PHOTO = 'https://api.twilio.com/2010-04-01/Accounts/AC0/Messages/MM0/Media/ME0';
const REQUEST = { callerName: 'jordan lee', vehicle: '2020 BMW 3 Series', wheels: 'one', damage: 'curb rash', diamondCut: 'yes', day: '2026-11-12', window: 'morning', callbackNumber: '5555550177', textOk: 'yes' };
const LATER = { ...REQUEST, callerName: 'casey morgan', vehicle: '2018 Audi A4', wheels: 'two', diamondCut: 'not_sure', day: '2026-11-13', window: 'afternoon', callbackNumber: '5555550188', textOk: 'no' };
const BOOKING = { account: 'rivergate_motors', cars: 'three', vehicles: '2019 Civic, Tacoma, 2021 Model 3', day: '2026-11-11', window: 'morning' };
const message = (from: string, body: string, media: string[] = []): IncomingText => ({ id: 'SM0', from, to: '+15555550100', body, media: media.map((url) => ({ url, contentType: 'image/jpeg' })), provider: 'twilio' });
const textCtx = (sys: Systems, nowMs: number): TextContext => ({ env: () => undefined, sys, nowMs });

/** A day of the line: two requests, a booking, a callback note, the texts each sends (printed: no sender), and a photo texted back. */
async function aDay(sys: Systems): Promise<void> {
  await run(sys, 'request', REQUEST, 'k-r1', T0);
  await run(sys, 'send_photo_link', REQUEST, 'k-p1', T0);
  await run(sys, 'book', BOOKING, 'k-b1', T0 + 10 * MIN);
  await run(sys, 'callback', { callbackNumber: '5555550199' }, 'k-c1', T0 + 20 * MIN);
  await run(sys, 'request', LATER, 'k-r2', T0 + 30 * MIN);
  await onText(message('+15555550177', 'front left', [PHOTO]), textCtx(sys, T0 + 40 * MIN));
}

/** What a Systems holds, for comparing one with another. */
const held = (s: Systems) => ({
  requests: s.requests, bookings: s.bookings, callbacks: s.callbacks, texts: s.texts, received: s.received,
  booked: [...s.booked], onFile: [...s.onFile], written: [...s.written],
});

describe('the shop\'s records on file (SHOP_DATA_DIR)', () => {
  it('keeps every record with its time, and reads all of it back after a restart: the records, the windows\' room, the requests on file and each write\'s key', async () => {
    const dir = join(scratch(), 'shop');
    const before = new Systems();
    expect(before.openLog(dir)).toEqual({ read: 0, skipped: 0 });
    await aDay(before);
    const after = new Systems();
    const opened = after.openLog(dir);
    expect(opened.skipped).toBe(0);
    expect(held(after)).toEqual(held(before));
    expect(after.requests.map((r) => r.at)).toEqual(['2026-11-09T16:05:00.000Z', '2026-11-09T16:35:00.000Z']);
    expect(after.booked.get('2026-11-11 morning')).toBe(3);
    // Each line carries its version and when it was written.
    for (const line of ShopLog.read(join(dir, SHOP_LOG_FILE)).lines) expect(line).toMatchObject({ v: 1, at: expect.stringMatching(/^2026-11-09T/) });
    // A write repeated after the restart, with its key, is done once; a photo texted in still finds its request.
    expect((await run(after, 'request', REQUEST, 'k-r1', T0 + 50 * MIN)).summary).toBe('R101 (already done)');
    expect(after.requests).toHaveLength(2);
    await onText(message('+15555550177', '', [PHOTO]), textCtx(after, T0 + 60 * MIN));
    expect(after.received.at(-1)).toMatchObject({ request: 'R101', from: '+15555550177' });
    // And it is on file for the next start too.
    const third = new Systems();
    third.openLog(dir);
    expect(third.received).toHaveLength(2);
  });

  it('is the server account\'s alone: the folder mode 700, the file mode 600', async () => {
    if (process.platform === 'win32') return;
    const dir = join(scratch(), 'shop');
    const sys = new Systems();
    sys.openLog(dir);
    await run(sys, 'request', REQUEST, 'k-r1', T0);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, SHOP_LOG_FILE)).mode & 0o777).toBe(0o600);
  });

  it('skips a line cut short by a crash, counts it, and writes the next record on a line of its own', async () => {
    const dir = scratch();
    const first = new Systems();
    first.openLog(dir);
    await run(first, 'request', REQUEST, 'k-r1', T0);
    appendFileSync(join(dir, SHOP_LOG_FILE), '{"v":1,"at":"2026-11-09T16:06:00.000Z","kind":"requ');
    const second = new Systems();
    expect(second.openLog(dir)).toEqual({ read: 1, skipped: 1 });
    await run(second, 'request', LATER, 'k-r2', T0 + MIN);
    const third = new Systems();
    expect(third.openLog(dir)).toEqual({ read: 2, skipped: 1 });
    expect(third.requests.map((r) => r.ref)).toEqual(['R101', 'R102']);
  });

  it('with no folder set, keeps everything in memory and writes nothing, as before', async () => {
    const sys = new Systems();
    await aDay(sys);
    expect(sys.logFile).toBeNull();
    expect(sys.requests).toHaveLength(2);
  });
});

describe('the shop page', () => {
  const OPTIONS = { brand: { name: 'Example Wheel Works', mark: 'EW' }, timeZone: 'America/Los_Angeles', nowMs: T0 + 90 * MIN, nonce: 'bm9uY2U=', logFile: '/srv/shop/shop.jsonl' };

  it('shows the requests newest first, each with the number to call back whole, the car and the drop-off, and the photos texted back', async () => {
    const sys = new Systems();
    await aDay(sys);
    const html = shopPageHtml(shopView(sys), OPTIONS);
    expect(html).toContain('<title>Example Wheel Works: the shop</title>');
    expect(html).toContain('<span class="mark" aria-hidden="true">EW</span>');
    // Newest first: Casey Morgan's request came after Jordan Lee's.
    expect(html.indexOf('Casey Morgan')).toBeLessThan(html.indexOf('Jordan Lee'));
    expect(html).toContain('<a class="tel" href="tel:+15555550177">(555) 555-0177</a>');
    for (const shown of ['2020 BMW 3 Series', 'curb rash', '<dt>Diamond cut</dt><dd>Yes</dd>', '<dt>Diamond cut</dt><dd>Not sure</dd>', 'Thursday, November 12, morning', '<dt>OK to text</dt><dd>No</dd>', 'None: the caller asked not to be texted.']) expect(html, shown).toContain(shown);
    // The photo as a thumbnail linking to the full image, with when it came and the caller's words.
    expect(html).toContain(`<a href="${PHOTO}" target="_blank" rel="noopener noreferrer"><img src="${PHOTO}" alt="Photo 1" loading="lazy" referrerpolicy="no-referrer"></a>`);
    expect(html).toContain('<time datetime="2026-11-09T16:45:00.000Z">Mon, Nov 9, 8:45 AM</time> · “front left”');
  });

  it('shows the bookings by day and window, with the dealership, the cars and the window\'s room used', async () => {
    const sys = new Systems();
    await aDay(sys);
    // A second dealership's car into Friday morning, whose standing drop-off fills it.
    await run(sys, 'book', { account: 'northside_auto_sales', cars: 'one', vehicles: 'Corolla', day: '2026-11-11', window: 'afternoon' }, 'k-b2', T0 + 70 * MIN);
    const html = shopPageHtml(shopView(sys), OPTIONS);
    expect(html).toContain('<h3>Wednesday, November 11, morning</h3><span class="badge full">3 of 3 cars · full</span>');
    expect(html).toContain('<strong>Rivergate Motors</strong> · 3 cars: 2019 Civic, Tacoma, 2021 Model 3');
    expect(html.indexOf('November 11, morning')).toBeLessThan(html.indexOf('November 11, afternoon'));
  });

  it('shows the texts sent and received, newest first, with the numbers whole, the words and the status, and the callback notes', async () => {
    const sys = new Systems();
    await aDay(sys);
    const html = shopPageHtml(shopView(sys), OPTIONS);
    const texts = html.slice(html.indexOf('id="texts"'), html.indexOf('id="callbacks"'));
    expect(texts).toContain('From <a class="tel" href="tel:+15555550177">(555) 555-0177</a> <span class="meta">for R101</span>');
    expect(texts).toContain('To <a class="tel" href="tel:+15555550177">(555) 555-0177</a>');
    expect(texts).toContain('Reply to this text with a photo of the damaged wheel');
    expect(texts).toContain('To the shop’s phone (SHOP_PHONE unset)');
    expect(texts).toContain('<span class="badge warn">printed, not sent</span>');
    expect(texts.indexOf('class="received"')).toBeLessThan(texts.indexOf('Reply to this text with a photo'));
    const notes = html.slice(html.indexOf('id="callbacks"'));
    expect(notes).toContain('<a class="tel" href="tel:+15555550199">(555) 555-0199</a>');
    expect(notes).toContain('C101');
  });

  it('escapes everything a caller gave, shows no photo that is not an https URL, and says so when it is empty', async () => {
    const sys = new Systems();
    await run(sys, 'request', { ...REQUEST, callerName: '<script>alert(1)</script>', vehicle: '"><img src=x onerror=alert(1)>' }, 'k-r1', T0);
    await onText(message('+15555550177', '<b>hi</b>', ['javascript:alert(1)']), textCtx(sys, T0 + MIN));
    const html = shopPageHtml(shopView(sys), OPTIONS);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<b>hi</b>');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('&lt;b&gt;hi&lt;/b&gt;');
    const none = shopPageHtml(shopView(new Systems()), { ...OPTIONS, logFile: null });
    for (const line of ['No requests yet.', 'No bookings yet.', 'No texts yet.', 'No callback notes yet.', 'Kept in memory: a restart of the server loses these']) expect(none, line).toContain(line);
  });
});

describe('the shop page on the server', () => {
  /** Through a tunnel: the headers it adds, addressed to the public name. */
  const TUNNEL = { 'x-forwarded-for': '203.0.113.9', host: 'shop.example.com' };

  async function start(env: Record<string, string>): Promise<{ base: string; logs: string[]; dir: string }> {
    const dir = scratch();
    const logs: string[] = [];
    const config = loadConfig({
      PUBLIC_HOST: 'shop.example.com', TWILIO_AUTH_TOKEN: 't', HANDOFF_NUMBER: '+15555550101', PORT: '0', TODAY_OVERRIDE: '2026-11-09',
      TRACE_DIR: join(dir, 'traces'), AUDIT_DIR: join(dir, 'audit'), AUDIO_DIR: dir, JEV_CLIENT: 'stub', TIMEZONE: 'America/Los_Angeles',
      CONSOLE_LINK_FILE: join(dir, 'link', 'link.json'), ...env,
    });
    running = await startServer(config, { host: '127.0.0.1', log: (l) => logs.push(l), env });
    return { base: `http://127.0.0.1:${running.port}`, logs, dir };
  }

  it('reads the records on file back as it starts, and shows them on this machine; through the tunnel there is no such page', async () => {
    const shop = join(scratch(), 'shop');
    const before = new Systems();
    before.openLog(shop);
    await aDay(before);
    const { base, logs } = await start({ SHOP_DATA_DIR: shop });
    expect(logs).toContain(`shop page: 9 records read back from ${join(shop, SHOP_LOG_FILE)}`);
    const local = await fetch(`${base}/wheelshop/shop`);
    expect(local.status).toBe(200);
    expect(local.headers.get('content-security-policy')).toContain("img-src https:");
    expect(local.headers.get('referrer-policy')).toBe('no-referrer');
    const html = await local.text();
    expect(html).toContain('(555) 555-0177');
    expect(html).toContain(PHOTO);
    const tunnelled = await fetch(`${base}/wheelshop/shop`, { headers: TUNNEL });
    expect(tunnelled.status).toBe(404);
    expect(await tunnelled.text()).not.toContain('555');
    expect(logs.join('\n')).toContain('/wheelshop/shop local only');
  });

  it('with SHOP_DATA_DIR unset, says the records are in memory', async () => {
    const { base, logs } = await start({});
    expect(logs).toContain('WARNING: shop page: SHOP_DATA_DIR unset, so the shop\'s records are kept in memory, and a restart of the server loses them');
    expect((await fetch(`${base}/wheelshop/shop`)).status).toBe(200);
  });

  it('with the console\'s sign-in (CONSOLE_AUTH=token), refuses a browser not signed in, from the tunnel or this machine, and opens it to one signed in with a link', async () => {
    const shop = join(scratch(), 'shop');
    const before = new Systems();
    before.openLog(shop);
    await aDay(before);
    const { base, dir } = await start({ SHOP_DATA_DIR: shop, CONSOLE_AUTH: 'token' });
    for (const headers of [TUNNEL, {}]) {
      const res = await fetch(`${base}/wheelshop/shop`, { headers, redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/dashboard/login?next=%2Fwheelshop%2Fshop');
      expect(await res.text()).not.toContain('555');
    }
    // The owner's sign-in link (what pnpm console:link prints), opened through the tunnel, with the page as where to go next.
    const link = JSON.parse(readFileSync(join(dir, 'link', 'link.json'), 'utf8')) as { url: string };
    const code = new URL(link.url).searchParams.get('code')!;
    const signIn = await fetch(`${base}/dashboard/login`, {
      method: 'POST', redirect: 'manual',
      headers: { ...TUNNEL, 'content-type': 'application/x-www-form-urlencoded', origin: 'https://shop.example.com' },
      body: new URLSearchParams({ code, next: '/wheelshop/shop' }).toString(),
    });
    expect(signIn.status).toBe(303);
    expect(signIn.headers.get('location')).toBe('/wheelshop/shop');
    const cookie = signIn.headers.getSetCookie().find((c) => c.includes('Path=/wheelshop/shop'))!.split(';')[0]!;
    const page = await fetch(`${base}/wheelshop/shop`, { headers: { ...TUNNEL, cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('(555) 555-0177');
  });
});
