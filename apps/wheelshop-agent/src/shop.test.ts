import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostRouting, loadConfig, startServer, type IncomingText, type RunningServer, type TextContext, type Texts } from 'dialogwright';
import { fakeConverseModel } from 'dialogwright/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { shopOnText, shopTools, wheelshop } from './app';
import type { Systems } from './shop';
import { SHOP_LOG_FILE, ShopLog } from './shopLog';
import { shopPageHtml, shopView } from './shopPage';
import { newSystems, run } from './testShop';

/**
 * The shop's records on file (src/shopLog.ts) and the shop page (src/shopPage.ts), copied with the code from the
 * agent-mode wheel shop: what is kept is read back whole after a restart, the page shows it, and the page is
 * never public. Every name and number is invented
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


const T0 = Date.parse('2026-11-09T16:05:00Z');
const MIN = 60_000;
const PHOTO = 'https://api.twilio.com/2010-04-01/Accounts/AC0/Messages/MM0/Media/ME0';
const REQUEST = { name: 'Jordan Lee', vehicle: '2020 BMW 3 Series', wheels: 'one', damage: 'curb rash', finish: 'diamond cut', slot: '2026-11-12:morning', callbackNumber: '+15555550177', textOk: 'yes' };
const LATER = { ...REQUEST, name: 'Casey Morgan', vehicle: '2018 Audi A4', wheels: 'two', finish: 'not sure', slot: '2026-11-13:afternoon', callbackNumber: '+15555550188', textOk: 'no' };
const BOOKING = { account: 'Rivergate Motors', cars: 'three', slot: '2026-11-11:morning' };
const message = (from: string, body: string, media: string[] = []): IncomingText => ({ id: 'SM0', from, to: '+15555550100', body, media: media.map((url) => ({ url, contentType: 'image/jpeg' })), provider: 'twilio' });
const textCtx = (nowMs: number): TextContext => ({ env: () => undefined, sys: undefined, nowMs, decide: async () => null });
const onText = (sys: Systems, m: IncomingText, ctx: TextContext): Promise<void> => shopOnText(sys, m, ctx);

/** A day of the line: two requests, a booking, a callback note, the texts each sends (printed: no sender), and a photo texted back. */
async function aDay(sys: Systems): Promise<void> {
  await run(sys, 'send_request', REQUEST, 'k-r1', T0);
  await run(sys, 'send_photo_request', { callbackNumber: REQUEST.callbackNumber, textOk: 'yes' }, 'k-p1', T0);
  await run(sys, 'book_dealer', BOOKING, 'k-b1', T0 + 10 * MIN);
  await run(sys, 'leave_callback', { name: 'Avery Sample', callbackNumber: '+15555550199', about: 'a wheel left last week' }, 'k-c1', T0 + 20 * MIN);
  await run(sys, 'send_request', LATER, 'k-r2', T0 + 30 * MIN);
  await onText(sys, message('+15555550177', 'front left', [PHOTO]), textCtx(T0 + 40 * MIN));
}

/** What a Systems holds, for comparing one with another. */
const held = (s: Systems) => ({
  requests: s.requests, bookings: s.bookings, callbacks: s.callbacks, texts: s.texts, received: s.received,
  booked: [...s.booked], onFile: [...s.onFile], written: [...s.written],
});

describe('the shop\'s records on file (SHOP_DATA_DIR)', () => {
  it('keeps every record with its time, and reads all of it back after a restart: the records, the windows\' room, the requests on file and each write\'s key', async () => {
    const dir = join(scratch(), 'shop');
    const before = newSystems();
    expect(before.openLog(dir)).toEqual({ read: 0, skipped: 0, warnings: [] });
    await aDay(before);
    const after = newSystems();
    const opened = after.openLog(dir);
    expect(opened.skipped).toBe(0);
    expect(held(after)).toEqual(held(before));
    expect(after.requests.map((r) => r.at)).toEqual(['2026-11-09T16:05:00.000Z', '2026-11-09T16:35:00.000Z']);
    expect(after.booked.get('2026-11-11 morning')).toBe(3);
    // Each line carries its version and when it was written.
    for (const line of ShopLog.read(join(dir, SHOP_LOG_FILE)).lines) expect(line).toMatchObject({ v: 1, at: expect.stringMatching(/^2026-11-09T/) });
    // A write repeated after the restart, with its key, is done once; a photo texted in still finds its request.
    expect((await run(after, 'send_request', REQUEST, 'k-r1', T0 + 50 * MIN)).summary).toBe('R101 (already done)');
    expect(after.requests).toHaveLength(2);
    await onText(after, message('+15555550177', '', [PHOTO]), textCtx(T0 + 60 * MIN));
    expect(after.received.at(-1)).toMatchObject({ request: 'R101', from: '+15555550177' });
    // And it is on file for the next start too.
    const third = newSystems();
    third.openLog(dir);
    expect(third.received).toHaveLength(2);
  });

  it('is the server account\'s alone: the folder mode 700, the file mode 600', async () => {
    if (process.platform === 'win32') return;
    const dir = join(scratch(), 'shop');
    const sys = newSystems();
    sys.openLog(dir);
    await run(sys, 'send_request', REQUEST, 'k-r1', T0);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, SHOP_LOG_FILE)).mode & 0o777).toBe(0o600);
  });

  it('skips a line cut short by a crash, counts it, and writes the next record on a line of its own', async () => {
    const dir = scratch();
    const first = newSystems();
    first.openLog(dir);
    await run(first, 'send_request', REQUEST, 'k-r1', T0);
    appendFileSync(join(dir, SHOP_LOG_FILE), '{"v":1,"at":"2026-11-09T16:06:00.000Z","kind":"requ');
    const second = newSystems();
    expect(second.openLog(dir)).toEqual({ read: 1, skipped: 1, warnings: [] });
    await run(second, 'send_request', LATER, 'k-r2', T0 + MIN);
    const third = newSystems();
    expect(third.openLog(dir)).toEqual({ read: 2, skipped: 1, warnings: [] });
    expect(third.requests.map((r) => r.ref)).toEqual(['R101', 'R102']);
  });

  it('skips a line whose fields are not of their types, as a torn one is, and counts it', async () => {
    const dir = scratch();
    const first = newSystems();
    first.openLog(dir);
    await run(first, 'send_request', REQUEST, 'k-r1', T0);
    for (const bad of [
      { v: 1, at: '2026-11-09T16:06:00.000Z', kind: 'request', record: { ref: 'R9', at: '2026-11-09T16:06:00.000Z', callerName: 5 } },
      { v: 1, at: '2026-11-09T16:06:00.000Z', kind: 'text', record: { ref: 'T9', at: '2026-11-09T16:06:00.000Z', to: '5555550177', text: 'hi', status: 'queued', media: [7] } },
      { v: 1, at: '2026-11-09T16:06:00.000Z', kind: 'received', record: { ref: 'I9', at: '2026-11-09T16:06:00.000Z', from: '+15555550177', text: 'hi', media: 'https://api.twilio.com/x' } },
      { v: 1, at: 7, kind: 'written', name: 'R k', ref: 'R9' },
      { v: 1, at: '2026-11-09T16:06:00.000Z', kind: 'written', name: 'R k', ref: 9 },
      { v: 1, at: '2026-11-09T16:06:00.000Z', kind: 'deleted', record: { ref: 'R1', at: '' } },
    ]) appendFileSync(join(dir, SHOP_LOG_FILE), `${JSON.stringify(bad)}\n`);
    const second = newSystems();
    expect(second.openLog(dir)).toEqual({ read: 1, skipped: 6, warnings: [] });
    expect(second.requests.map((r) => r.ref)).toEqual(['R101']);
    expect(second.written.has('R k')).toBe(false);
  });

  it('tightens a folder of its own that others may read to 700, and never writes through a symbolic link', async () => {
    if (process.platform === 'win32') return;
    const dir = join(scratch(), 'open');
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    newSystems().openLog(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    // shop.jsonl a link to a file elsewhere: refused, and the file it points to untouched.
    const linked = join(scratch(), 'linked');
    const elsewhere = join(scratch(), 'elsewhere.txt');
    writeFileSync(elsewhere, 'not the shop\'s\n');
    mkdirSync(linked, { mode: 0o700 });
    symlinkSync(elsewhere, join(linked, SHOP_LOG_FILE));
    expect(() => newSystems().openLog(linked)).toThrow(/is a symbolic link: the shop's log is never written through one/);
    expect(readFileSync(elsewhere, 'utf8')).toBe('not the shop\'s\n');
  });

  it('files a text\'s key only once it is sent: a repeat in the same turn is caught, and after a crash in flight the text is sent again', async () => {
    const dir = scratch();
    const sys = newSystems();
    sys.openLog(dir);
    let release!: () => void;
    const sent: string[] = [];
    const texts: Texts = { send: (t) => new Promise((r) => { sent.push(t.to); release = () => r({ id: 'SM1', status: 'queued' }); }) };
    const photo = { callbackNumber: REQUEST.callbackNumber, textOk: 'yes' };
    const first = run(sys, 'send_photo_request', photo, 'k-p1', T0, { texts });
    // In flight: the key is held in memory (a repeat does nothing), and nothing is on file yet.
    expect((await run(sys, 'send_photo_request', photo, 'k-p1', T0, { texts })).summary).toBe('P101 (already done)');
    expect(ShopLog.read(join(dir, SHOP_LOG_FILE)).lines).toEqual([]);
    // A server that stopped here would send it again: nothing on file says it was sent.
    const crashed = newSystems();
    crashed.openLog(dir);
    expect(crashed.written.size).toBe(0);
    release();
    await first;
    expect(sent).toEqual(['+15555550177']);
    expect(ShopLog.read(join(dir, SHOP_LOG_FILE)).lines.map((l) => l.kind)).toEqual(['text', 'written']);
  });

  it('with no folder set, keeps everything in memory and writes nothing, as before', async () => {
    const sys = newSystems();
    await aDay(sys);
    expect(sys.logFile).toBeNull();
    expect(sys.requests).toHaveLength(2);
  });
});

describe('the shop page', () => {
  const OPTIONS = { brand: { name: 'Example Wheel Works', mark: 'EW' }, timeZone: 'America/Los_Angeles', nowMs: T0 + 90 * MIN, nonce: 'bm9uY2U=', logFile: '/srv/shop/shop.jsonl' };

  it('shows the requests newest first, each with the number to call back whole, the car and the drop-off, and the photos texted back', async () => {
    const sys = newSystems();
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
    const sys = newSystems();
    await aDay(sys);
    // A second dealership's car into Friday morning, whose standing drop-off fills it.
    await run(sys, 'book_dealer', { account: 'Northside Auto Sales', cars: 'one', slot: '2026-11-11:afternoon' }, 'k-b2', T0 + 70 * MIN);
    const html = shopPageHtml(shopView(sys), OPTIONS);
    expect(html).toContain('<h3>Wednesday, November 11, morning</h3><span class="badge full">3 of 3 cars · full</span>');
    expect(html).toContain('<strong>Rivergate Motors</strong> · 3 cars <span class="meta">B101');
    expect(html.indexOf('November 11, morning')).toBeLessThan(html.indexOf('November 11, afternoon'));
  });

  it('shows the texts sent and received, newest first, with the numbers whole, the words and the status, and the callback notes', async () => {
    const sys = newSystems();
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

  it('escapes everything a caller gave, shows no photo that is not at Twilio\'s media URL, and says so when it is empty', async () => {
    const sys = newSystems();
    await run(sys, 'send_request', { ...REQUEST, callerName: '<script>alert(1)</script>', vehicle: '"><img src=x onerror=alert(1)>' }, 'k-r1', T0);
    await onText(sys, message('+15555550177', '<b>hi</b>', ['javascript:alert(1)', 'https://evil.example/2010-04-01/Media/ME1', 'http://api.twilio.com/x', `${PHOTO}" onerror="x`]), textCtx(T0 + MIN));
    const html = shopPageHtml(shopView(sys), OPTIONS);
    expect(html).not.toContain('evil.example');
    expect(html).not.toContain('http://api.twilio.com');
    expect(html).not.toContain('<img src=');
    expect(html).not.toContain('onerror="x');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<b>hi</b>');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('&lt;b&gt;hi&lt;/b&gt;');
    const none = shopPageHtml(shopView(newSystems()), { ...OPTIONS, logFile: null });
    for (const line of ['No requests yet.', 'No bookings yet.', 'No texts yet.', 'No callback notes yet.', 'Kept in memory: a restart of the server loses these']) expect(none, line).toContain(line);
  });
});

describe('the shop page on the server', () => {
  /** Through a tunnel: the headers it adds, addressed to the public name. */
  const TUNNEL = { 'x-forwarded-for': '203.0.113.9', host: 'shop.example.com' };

  /** The app's server, the app made with `env` as its settings (the shop page reads them as it is made), its model a script. */
  async function start(env: Record<string, string>): Promise<{ base: string; logs: string[]; dir: string }> {
    const dir = scratch();
    const logs: string[] = [];
    const settings = {
      PUBLIC_HOST: 'shop.example.com', VOICE_PROVIDERS: 'none', CHAT: 'on', CHAT_ALLOWED_ORIGINS: 'https://shop.example.com', PORT: '0',
      TRACE_DIR: join(dir, 'traces'), AUDIT_DIR: join(dir, 'audit'), AUDIO_DIR: dir, JEV_CLIENT: 'stub', TIMEZONE: 'America/Los_Angeles',
      CONSOLE_LINK_FILE: join(dir, 'link', 'link.json'), ...env,
    };
    const { app } = wheelshop();
    const apps = hostRouting({ apps: [{ id: app.id, app, dir: app.dir, env: settings, own: [], ignored: [] }], numbers: [], defaultApp: app.id, env: settings });
    running = await startServer(loadConfig(settings), { host: '127.0.0.1', log: (l) => logs.push(l), env: settings, apps, converseModel: () => fakeConverseModel([]) });
    return { base: `http://127.0.0.1:${running.port}`, logs, dir };
  }

  it('reads the records on file back as it starts, and shows them on this machine; through the tunnel there is no such page', async () => {
    const shop = join(scratch(), 'shop');
    const before = newSystems();
    before.openLog(shop);
    await aDay(before);
    const { base, logs } = await start({ SHOP_DATA_DIR: shop });
    expect(logs.some((l) => l.endsWith(`shop page: 9 records read back from ${join(shop, SHOP_LOG_FILE)}`))).toBe(true);
    const local = await fetch(`${base}/wheelshop-agent/shop`);
    expect(local.status).toBe(200);
    expect(local.headers.get('content-security-policy')).toContain("img-src https:");
    expect(local.headers.get('referrer-policy')).toBe('no-referrer');
    const html = await local.text();
    expect(html).toContain('(555) 555-0177');
    // No sign-in on this server: nothing to sign out of.
    expect(html).not.toContain('Sign out');
    expect(html).toContain(PHOTO);
    const tunnelled = await fetch(`${base}/wheelshop-agent/shop`, { headers: TUNNEL });
    expect(tunnelled.status).toBe(404);
    expect(await tunnelled.text()).not.toContain('555');
    expect(logs.join('\n')).toContain('/wheelshop-agent/shop local only');
  });

  it('with SHOP_DATA_DIR unset, says the records are in memory', async () => {
    const { base, logs } = await start({});
    expect(logs).toContainEqual(expect.stringMatching(/^WARNING: .*shop page: SHOP_DATA_DIR unset, so the shop's records are kept in memory, and a restart of the server loses them$/));
    expect((await fetch(`${base}/wheelshop-agent/shop`)).status).toBe(200);
  });

  it('with the console\'s sign-in (CONSOLE_AUTH=token), refuses a browser not signed in, from the tunnel or this machine, and opens it to one signed in with a link', async () => {
    const shop = join(scratch(), 'shop');
    const before = newSystems();
    before.openLog(shop);
    await aDay(before);
    const { base, dir } = await start({ SHOP_DATA_DIR: shop, CONSOLE_AUTH: 'token' });
    for (const headers of [TUNNEL, {}]) {
      const res = await fetch(`${base}/wheelshop-agent/shop`, { headers, redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/dashboard/login?next=%2Fwheelshop-agent%2Fshop');
      expect(await res.text()).not.toContain('555');
    }
    // The owner's sign-in link (what pnpm console:link prints), opened through the tunnel, with the page as where to go next.
    const link = JSON.parse(readFileSync(join(dir, 'link', 'link.json'), 'utf8')) as { url: string };
    const code = new URL(link.url).searchParams.get('code')!;
    const signIn = await fetch(`${base}/dashboard/login`, {
      method: 'POST', redirect: 'manual',
      headers: { ...TUNNEL, 'content-type': 'application/x-www-form-urlencoded', origin: 'https://shop.example.com' },
      body: new URLSearchParams({ code, next: '/wheelshop-agent/shop' }).toString(),
    });
    expect(signIn.status).toBe(303);
    expect(signIn.headers.get('location')).toBe('/wheelshop-agent/shop');
    const cookie = signIn.headers.getSetCookie().find((c) => c.includes('Path=/wheelshop-agent/shop'))!.split(';')[0]!;
    const page = await fetch(`${base}/wheelshop-agent/shop`, { headers: { ...TUNNEL, cookie } });
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("form-action 'self'");
    const html = await page.text();
    expect(html).toContain('(555) 555-0177');
    // Sign out, from the page: the session is refused from then on.
    expect(html).toContain('<form class="out" method="post" action="/dashboard/logout"><button type="submit">Sign out</button></form>');
    const out = await fetch(`${base}/dashboard/logout`, { method: 'POST', redirect: 'manual', headers: { ...TUNNEL, cookie, origin: 'https://shop.example.com' } });
    expect(out.status).toBe(303);
    expect((await fetch(`${base}/wheelshop-agent/shop`, { headers: { ...TUNNEL, cookie }, redirect: 'manual' })).status).toBe(302);
  });
});

describe('a drop-off window\'s last time (agent.yaml\'s until, in the shop\'s zone)', () => {
  // The shop is in America/New_York (UTC-5 in November); 2026-11-10 is a Tuesday, 2026-11-11 a Wednesday.
  const at = (iso: string) => newSystems(Date.parse(iso));
  it('offers today\'s morning window until 8 and its afternoon window until noon, local time', () => {
    expect(at('2026-11-10T12:30:00Z').free('2026-11-10').map((w) => w.id)).toEqual(['2026-11-10:morning', '2026-11-10:afternoon']);
    expect(at('2026-11-10T13:30:00Z').free('2026-11-10').map((w) => w.id)).toEqual(['2026-11-10:afternoon']);
    expect(at('2026-11-10T17:00:00Z').free('2026-11-10').map((w) => w.id)).toEqual(['2026-11-10:afternoon']);
    expect(at('2026-11-10T17:01:00Z').free('2026-11-10')).toEqual([]);
  });
  it('leaves a later day whole at any hour of today', () => {
    expect(at('2026-11-10T21:00:00Z').free('2026-11-11').map((w) => w.id)).toEqual(['2026-11-11:morning', '2026-11-11:afternoon']);
  });
  it('refuses a request or a booking into a window that is over, and takes a later day\'s', async () => {
    const sys = at('2026-11-10T19:00:00Z');
    await expect(run(sys, 'send_request', { ...REQUEST, slot: '2026-11-10:morning' }, 'k-late', Date.parse('2026-11-10T19:00:00Z'))).rejects.toThrow(/has room for 0 now/);
    await expect(run(sys, 'book_dealer', { ...BOOKING, cars: 'one', slot: '2026-11-10:afternoon' }, 'k-late2', Date.parse('2026-11-10T19:00:00Z'))).rejects.toThrow(/has room for 0 now/);
    await run(sys, 'send_request', { ...REQUEST, slot: '2026-11-11:morning' }, 'k-next', Date.parse('2026-11-10T19:00:00Z'));
  });
});
