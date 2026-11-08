import { fileURLToPath } from 'node:url';
import { checkApp, formatProblem, type IncomingText, type TextContext, type Texts, type ToolCall, type ToolDef, type ToolReply } from 'dialogwright';
import { danglingReferences, expectAppMap, expectPolicyCard, expectPolicyMatrix, fakeTextProvider, policyInvariants, runRuleExamples, type FakeSent } from 'dialogwright/testing';
import { describe, expect, it } from 'vitest';
import { APP_DIR, ON_FILE_MS, Systems, TOOLS, app, code, onText, ownerSummary } from './app';

describe('the app folder', () => {
  it('passes dialogwright check: business.yaml, the code and the corpus agree', async () => {
    expect((await checkApp(APP_DIR, { code })).map(formatProblem)).toEqual([]);
  });

  it('is Example Wheel Works, in agent mode on Mercury 3, with the adversarial suite on', () => {
    expect(app.id).toBe('wheelshop');
    expect(app.brand?.name).toBe('Example Wheel Works');
    expect(app.mode).toBe('agent');
    expect(app.agent?.model).toEqual({ provider: 'inception', model: 'mercury-3', effort: 'instant' });
    expect(app.adversarial).toBe(true);
  });

  it('has the three forms business.yaml defines, the callback note as the person form', () => {
    expect(Object.keys(app.agent?.forms ?? {})).toEqual(['request', 'booking', 'callback']);
    expect(app.personForm?.form).toBe('callback');
    // A form's write is the first tool of its then; a tool follows one form.
    expect(app.agent?.forms.request?.then).toEqual(['request', 'send_photo_link', 'notify_owner_request']);
    // The text asking for a photo only with the caller's yes to being texted: the gate's rule, refused as no-consent.
    expect(app.agent?.forms.request?.when).toEqual({ send_photo_link: { field: 'textOk', is: 'yes', reason: 'no-consent' } });
    expect(app.onText).toBeDefined();
    expect(app.agent?.forms.booking?.then).toEqual(['book', 'notify_owner_booking']);
    expect(app.agent?.forms.callback?.then).toEqual(['callback']);
    // The day's free windows reach the model on both forms that ask for a day.
    expect(app.agent?.sees).toEqual({ request_day: 'availability', booking_day: 'availability' });
  });

  it('has an action for every tool, and no other but the engine\'s two for recognizing an account', () => {
    expect(Object.keys(app.policy.toolLevel).sort()).toEqual([...Object.keys(code.tools), 'lookupAccount', 'recognizeAccount'].sort());
  });

  it('keeps the price line fixed, promising no text before the request is confirmed', () => {
    const price = app.agent?.facts.fixed.price ?? '';
    expect(price).toMatch(/^We quote every job from a photo/);
    expect(price).toMatch(/Once your request is in, we can text you/);
    expect(price).toMatch(/reply to our text with a photo/);
    expect(price).not.toMatch(/link|\d/);
  });
});

describe('the policy read back', () => {
  // The three pages are generated, reviewed and committed with business.yaml: after a change to it or to
  // the tools, run the command a failure names, read the diff as a change in what the agent may do, and
  // commit it. Never rewrite one only to make a test pass.
  const page = (file: string): string => fileURLToPath(new URL(`../${file}`, import.meta.url));

  it('holds to the policy invariants on the gate grid', () => expect(policyInvariants(app).violations).toEqual([]));

  it('has no custom rule whose examples the gate disagrees with', () => expect(runRuleExamples(app)).toEqual([]));

  it('policy.matrix is what the gate decides', () => {
    expectPolicyMatrix(app, page('policy.matrix'), `pnpm policy:matrix ${APP_DIR}`);
  });

  it('POLICY.md is the policy card the app generates', () => {
    expectPolicyCard(app, page('POLICY.md'), `pnpm policy:card ${APP_DIR}`);
  });

  it('APP-MAP.md is the app map the app generates', () => {
    expectAppMap(app, page('APP-MAP.md'), `pnpm app:diagram ${APP_DIR}`);
  });

  it('has no dangling reference: every form is started by an intent and every action is reached', () => {
    expect(danglingReferences(app)).toEqual([]);
  });
});

/** What a tool is run with in these tests: its write key, the app's settings, and the sender (none, so each text is printed). */
interface Ctx {
  key?: string;
  env?: Record<string, string>;
  texts?: Texts;
  nowMs?: number;
}

/** Runs a tool with a write key, as the gate does once it allows the call. */
async function run(sys: Systems, tool: string, params: Record<string, string>, key?: string, ctx: Ctx = {}): Promise<ToolReply> {
  const call: ToolCall = { tool, params };
  const c = { ...(key === undefined ? {} : { idempotencyKey: key }), env: (n: string) => ctx.env?.[n], ...(ctx.texts !== undefined ? { texts: ctx.texts } : {}), tc: { nowMs: ctx.nowMs ?? 0 } };
  return (TOOLS[tool] as ToolDef).run(call, sys, c as unknown as Parameters<ToolDef['run']>[2]);
}

/** A sender that takes every text and answers queued: the engine's fake, through the recording the server gives an app. */
function sender(): { texts: Texts; sent: FakeSent[] } {
  const provider = fakeTextProvider();
  return { texts: { send: (t) => provider.send({ ...t, from: '+15555550100' }) }, sent: provider.sent };
}

const REQUEST = { callerName: 'jordan lee', vehicle: '2020 BMW 3 Series', wheels: 'one', damage: 'curb rash', diamondCut: 'yes', day: '2026-11-12', window: 'morning', callbackNumber: '5555550177', textOk: 'yes' };
const BOOKING = { account: 'rivergate_motors', cars: 'three', vehicles: '2019 Civic, Tacoma, 2021 Model 3', day: '2026-11-11', window: 'morning' };
const SHOP = '+15555550190';

describe('the stand-in calendar', () => {
  const free = async (sys: Systems, day: string) => (await run(sys, 'availability', { day })).value;

  it('has two windows each weekday, none at the weekend, and its reply passes the closed check the model is shown it by', async () => {
    const sys = new Systems();
    expect(await free(sys, '2026-11-12')).toEqual({ day: '2026-11-12', windows: ['morning', 'afternoon'] });
    expect(await free(sys, '2026-11-14')).toEqual({ day: '2026-11-14', windows: [] });
    for (const day of ['2026-11-12', '2026-11-13', '2026-11-14']) expect(TOOLS.availability!.check!(await free(sys, day))).toBe(true);
    expect(TOOLS.availability!.check!({ day: '2026-11-12', windows: ['evening'] })).toBe(false);
    expect(TOOLS.availability!.check!({ day: 'Thursday', windows: ['morning'] })).toBe(false);
  });

  it('starts with Friday morning full (a standing drop-off), so the demo has a full window to meet', async () => {
    expect(await free(new Systems(), '2026-11-13')).toEqual({ day: '2026-11-13', windows: ['afternoon'] });
  });

  it('fills a window by the cars booked into it, up to its capacity in business.yaml', async () => {
    const sys = new Systems();
    await run(sys, 'book', { ...BOOKING, cars: 'two' }, 'k-1');
    expect(await free(sys, '2026-11-11')).toEqual({ day: '2026-11-11', windows: ['morning', 'afternoon'] });
    await run(sys, 'book', { ...BOOKING, cars: 'one' }, 'k-2');
    expect(await free(sys, '2026-11-11')).toEqual({ day: '2026-11-11', windows: ['afternoon'] });
  });

  it('refuses a booking without room for its cars, as a real calendar would: nothing booked, and no reference, so the reply fails its check', async () => {
    const sys = new Systems();
    const full = await run(sys, 'book', { ...BOOKING, day: '2026-11-13', window: 'morning' }, 'k-1');
    expect(TOOLS.book!.check!(full.value)).toBe(false);
    expect(sys.bookings).toEqual([]);
    const tooMany = await run(sys, 'book', { ...BOOKING, cars: 'four' }, 'k-2');
    expect(TOOLS.book!.check!(tooMany.value)).toBe(false);
    expect(sys.bookings).toEqual([]);
    // A booking repeated for its key after it filled the window is the same booking, not refused.
    await run(sys, 'book', BOOKING, 'k-3');
    expect(TOOLS.book!.check!((await run(sys, 'book', BOOKING, 'k-3')).value)).toBe(true);
    expect(sys.bookings).toHaveLength(1);
  });

  it('takes no room for a request: the shop confirms its window with the quote', async () => {
    const sys = new Systems();
    await run(sys, 'request', { ...REQUEST, day: '2026-11-11' }, 'k-1');
    expect(await free(sys, '2026-11-11')).toEqual({ day: '2026-11-11', windows: ['morning', 'afternoon'] });
  });
});

describe('the writes and the texts', () => {
  it('does each write once for its key, whatever is repeated', async () => {
    const sys = new Systems();
    const first = await run(sys, 'book', BOOKING, 'k-1');
    const again = await run(sys, 'book', BOOKING, 'k-1');
    expect(again.ref).toBe(first.ref);
    expect(sys.bookings).toHaveLength(1);
    expect(sys.booked.get('2026-11-11 morning')).toBe(3);
    expect((await run(sys, 'book', BOOKING, 'k-2')).ref).not.toBe(first.ref);
    for (const tool of ['request', 'send_photo_link', 'notify_owner_request', 'callback']) {
      const before = sys.texts.length + sys.requests.length + sys.callbacks.length;
      const params = tool === 'callback' ? { callbackNumber: '5555550177' } : REQUEST;
      const a = await run(sys, tool, params, `once-${tool}`);
      const b = await run(sys, tool, params, `once-${tool}`);
      expect(b.ref, tool).toBe(a.ref);
      // Each kept once: a callback note is kept, and the shop is texted the number to call.
      expect(sys.texts.length + sys.requests.length + sys.callbacks.length, tool).toBe(before + (tool === 'callback' ? 2 : 1));
      expect(TOOLS[tool]!.check!(a.value), tool).toBe(true);
    }
  });

  it('texts the caller, in business.yaml\'s words, to reply with a photo of the damage, through the sender with the write\'s key', async () => {
    const sys = new Systems();
    const { texts, sent } = sender();
    const reply = await run(sys, 'send_photo_link', REQUEST, 'k-1', { texts });
    expect(sent).toEqual([{ from: '+15555550100', to: '5555550177', body: "Thanks for your request with Example Wheel Works. Reply to this text with a photo of the damaged wheel and we'll send you a price.", key: 'k-1' }]);
    expect(reply.summary).toBe('text to ...0177: queued');
  });

  it('with no sender, prints the text rather than send it', async () => {
    const sys = new Systems();
    const reply = await run(sys, 'send_photo_link', REQUEST, 'k-1');
    expect(sys.texts).toEqual([{ ref: 'P101', to: '5555550177', text: "Thanks for your request with Example Wheel Works. Reply to this text with a photo of the damaged wheel and we'll send you a price.", status: 'printed' }]);
    expect(reply.summary).toMatch(/^text to \.\.\.0177 \(printed, not sent\)/);
  });

  it('texts the shop\'s phone (SHOP_PHONE) the summary in business.yaml\'s fixed words, the caller\'s number whole in the text and by its last four in the record', async () => {
    const sys = new Systems();
    const { texts, sent } = sender();
    const reply = await run(sys, 'notify_owner_request', REQUEST, 'k-1', { texts, env: { SHOP_PHONE: SHOP } });
    expect(sent.at(-1)).toMatchObject({ to: SHOP, body: 'New request from Jordan Lee (5555550177): 2020 BMW 3 Series, curb rash, one wheel, diamond cut. Drop-off: Thursday, November 12, morning.' });
    expect(reply.summary).not.toContain('5555550177');
    await run(sys, 'notify_owner_booking', BOOKING, 'k-2', { texts, env: { SHOP_PHONE: SHOP } });
    expect(sent.at(-1)?.body).toBe('New booking from Rivergate Motors (5555550142): three cars, 2019 Civic, Tacoma, 2021 Model 3. Drop-off: Wednesday, November 11, morning.');
  });

  it('with SHOP_PHONE unset, prints the shop\'s summary, the caller\'s number by its last four in what it says of it', async () => {
    const sys = new Systems();
    const { texts, sent } = sender();
    const reply = await run(sys, 'notify_owner_request', REQUEST, 'k-1', { texts });
    expect(sent).toEqual([]);
    expect(sys.texts.at(-1)).toMatchObject({ to: '', status: 'printed' });
    expect(reply.summary).toContain('SHOP_PHONE unset');
    expect(reply.summary).toContain('(...0177)');
    expect(reply.summary).not.toContain('5555550177');
  });

  it('fills only the template\'s own placeholders', () => {
    expect(ownerSummary({ kind: 'request', who: 'Casey Morgan', callbackNumber: '5555550123', details: 'Civic, curb rash', day: 'Friday, November 13', window: 'afternoon' }))
      .toBe('New request from Casey Morgan (5555550123): Civic, curb rash. Drop-off: Friday, November 13, afternoon.');
  });

  it('keeps a callback note, and tells the shop the number to call', async () => {
    const sys = new Systems();
    const { texts, sent } = sender();
    const reply = await run(sys, 'callback', { callbackNumber: '5555550177' }, 'k-1', { texts, env: { SHOP_PHONE: SHOP } });
    expect(sys.callbacks).toEqual([{ callbackNumber: '5555550177', ref: 'C101' }]);
    expect(sent).toEqual([{ from: '+15555550100', to: SHOP, body: 'Call back 5555550177 (callback note C101).', key: 'k-1' }]);
    expect(reply.summary).toBe('callback note C101 for ...0177');
  });
});

describe('a text that comes in (onText)', () => {
  const PHOTO = 'https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/MM1/Media/ME1';
  const message = (from: string, body: string, media: string[] = []): IncomingText => ({ id: 'SM1', from, to: '+15555550100', body, media: media.map((url) => ({ url, contentType: 'image/jpeg' })), provider: 'twilio' });
  const ctx = (sys: Systems, texts: Texts | undefined, nowMs = 1000): TextContext => ({ ...(texts !== undefined ? { texts } : {}), env: (n) => (n === 'SHOP_PHONE' ? SHOP : undefined), sys, nowMs });

  it('a photo from a number with a recent request goes to the shop with a line naming the request, and the caller is thanked', async () => {
    const sys = new Systems();
    await run(sys, 'request', REQUEST, 'k-1', { nowMs: 0 });
    const { texts, sent } = sender();
    await onText(message('+15555550177', '', [PHOTO]), ctx(sys, texts));
    expect(sent).toEqual([
      { from: '+15555550100', to: SHOP, body: 'Photo from Jordan Lee, ...0177, for their 2020 BMW 3 Series request.', media: [PHOTO] },
      { from: '+15555550100', to: '+15555550177', body: "Got it, thanks. We'll text you a price soon." },
    ]);
  });

  it('the caller\'s own words follow the line', async () => {
    const sys = new Systems();
    await run(sys, 'request', REQUEST, 'k-1');
    const { texts, sent } = sender();
    await onText(message('+15555550177', 'front left wheel', [PHOTO]), ctx(sys, texts));
    expect(sent[0]!.body).toBe('Photo from Jordan Lee, ...0177, for their 2020 BMW 3 Series request.: front left wheel');
  });

  it('a text with no photo is sent on too, and not answered', async () => {
    const sys = new Systems();
    await run(sys, 'request', REQUEST, 'k-1');
    const { texts, sent } = sender();
    await onText(message('+15555550177', 'Can I come Friday instead?'), ctx(sys, texts));
    expect(sent).toEqual([{ from: '+15555550100', to: SHOP, body: 'Text from Jordan Lee, ...0177, about their 2020 BMW 3 Series request.: Can I come Friday instead?' }]);
  });

  it('a text from a number with no request on file (or one older than a week) is sent on as such, and not answered', async () => {
    const sys = new Systems();
    await run(sys, 'request', REQUEST, 'k-1', { nowMs: 0 });
    const { texts, sent } = sender();
    await onText(message('+15555550133', '', [PHOTO]), ctx(sys, texts));
    await onText(message('+15555550177', '', [PHOTO]), ctx(sys, texts, ON_FILE_MS + 1));
    expect(sent).toEqual([
      { from: '+15555550100', to: SHOP, body: 'Text from ...0133 (no request on file).', media: [PHOTO] },
      { from: '+15555550100', to: SHOP, body: 'Text from ...0177 (no request on file).', media: [PHOTO] },
    ]);
  });

  it('with no sender, prints what it would send', async () => {
    const sys = new Systems();
    await onText(message('+15555550133', 'hello'), ctx(sys, undefined));
    expect(sys.texts).toEqual([{ ref: 'T101', to: SHOP, text: 'Text from ...0133 (no request on file).: hello', status: 'printed' }]);
  });
});
