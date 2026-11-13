import { checkApp, formatProblem, type AnswerMap, type ConverseApp, type JevClient } from 'dialogwright';
import { converseTestCall, fakeConverseModel, fakeTextProvider, type ConverseModelEvent } from 'dialogwright/testing';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_DIR, wheelshop } from './app';

/**
 * Example Wheel Works on the converse runtime: a conversation run turn by turn on the app's own agent.yaml,
 * code and gate, its model a script (no real model) and its calendar the shop's fake one. A request is read
 * back and sent on the caller's yes, booking its drop-off window, texting the caller for a photo only with
 * their yes to texts, and texting the shop a summary; a dealership recognised by its number books its cars.
 * Every name and number is invented (the 555 range).
 */

const NOW = Date.parse('2026-11-11T15:00:00Z'); // a Wednesday, 10 a.m. at the shop
const TUESDAY = '2026-11-17';
const THURSDAY = '2026-11-12';
const SHOP_PHONE = '+15555550199';
const RETAIL = '+15555550111';
const DEALER = '+15555550142';

const text = (delta: string): ConverseModelEvent => ({ type: 'text', delta });
const call = (id: string, name: string, args: Record<string, unknown>): ConverseModelEvent => ({ type: 'tool_call', id, name, args });
const done = (stop: 'end' | 'tool' = 'end'): ConverseModelEvent => ({ type: 'done', stop, usage: { inputTokens: 100, outputTokens: 10 } });

type JevRequest = Parameters<JevClient['ask']>[0];

/** What the model's first round is when a turn's route changes the journey: asked alongside the routing, then dropped unsaid. */
const DROPPED: ConverseModelEvent = { type: 'text', delta: 'Never said.' };
const dropped = (): ConverseModelEvent[][] => [[DROPPED, done()]];

/**
 * A decision model that reads "yes" in the caller's words as a yes (anything else a no), and routes a turn by
 * its words among the journeys it is offered: a wish to talk to a person is the callback, a lone "yes" or
 * "no" carries on, a dealership's trade-ins the dealer booking, a car or a wheel the repair request, and
 * anything else none. It records what it was asked.
 */
function routingJev(): JevClient & { asked: JevRequest[] } {
  const asked: JevRequest[] = [];
  return {
    asked,
    async ask(req) {
      asked.push(req);
      const said = String((req.state as { said?: unknown }).said ?? '');
      const answers: AnswerMap = {};
      if (Object.hasOwn(req.questions, 'task')) {
        const open = Object.keys((req.questions.task as { criteria: Record<string, string | null> }).criteria).filter((k) => k !== 'none');
        const pick = /\bperson\b|call me|call back|callback/i.test(said) ? 'callback' : /trade-in/i.test(said) ? 'dealer_booking' : /civic|wheel|curb|tuesday|afternoon|photo/i.test(said) ? 'repair_request' : 'none';
        const choice = pick === 'none' || open.includes(pick) ? pick : 'none';
        const probabilities = Object.fromEntries([...open, 'none'].map((k) => [k, k === choice ? 0.9 : 0.05]));
        answers.task = { type: 'choice', choice, probabilities, confidence: 0.9 };
        if (Object.hasOwn(req.questions, 'drops')) answers.drops = { type: 'noul', noul: 0.1 };
        if (Object.hasOwn(req.questions, 'again')) answers.again = { type: 'noul', noul: 0.1 };
      } else {
        const yes = /\byes\b/i.test(said);
        answers.confirmsYes = { type: 'noul', noul: yes ? 0.95 : 0.05 };
        answers.confirmsNo = { type: 'noul', noul: yes ? 0.05 : 0.9 };
      }
      return { answers, model: 'fake', usage: { inputTokens: 0, outputTokens: 0, estimated: true }, latencyMs: 1, source: 'jev' };
    },
  };
}
const routeAsks = (j: { asked: JevRequest[] }): JevRequest[] => j.asked.filter((r) => Object.hasOwn(r.questions, 'task'));
const toolNames = (m: { requests: readonly unknown[] }, i = -1): string[] => (m.requests.at(i) as { tools: { name: string }[] }).tools.map((t) => t.name);

const REQUEST = { name: 'Dana Example', vehicle: '2019 Honda Civic', wheels: 'one', damage: 'curb rash', finish: 'painted', slot: `${TUESDAY}:morning`, callbackNumber: '555 555 0111' };

/** The model's side of a request: a lookup, the request called, then a reply after the caller's answer. */
const requestScript = (textOk: string): ConverseModelEvent[][] => [
  [text('Let me check Tuesday. '), call('c1', 'check_availability', { day: TUESDAY }), done('tool')],
  [call('c2', 'send_request', { ...REQUEST, textOk }), done('tool')],
  [text('Thanks, it is in.'), done()],
];

function shop(textOk: string, callerNumber?: string) {
  const provider = fakeTextProvider();
  const { app, sys } = wheelshop({ now: () => NOW });
  const c = converseTestCall(app, { model: fakeConverseModel([...dropped(), ...requestScript(textOk)]), jev: routingJev(), now: () => new Date(NOW), texts: provider, env: { SHOP_PHONE }, ...(callerNumber !== undefined ? { callerNumber } : {}) });
  return { c, sys, provider };
}

describe('send_request', () => {
  it('is read back in the shop\'s words and, on the yes, books the slot, texts the caller for a photo and the shop a summary', async () => {
    const { c, sys, provider } = shop('yes');
    expect(await c.start()).toEqual(['Thanks for calling Example Wheel Works, where we make damaged wheels look new again. We can price a repair and set up a drop-off, or have someone from the shop call you back. How can we help?']);
    const room = sys.roomIn(TUESDAY, 'morning');
    expect(await c.say('I curbed my Civic, can I bring it in Tuesday morning?')).toEqual([
      'Let me check Tuesday. ',
      'Here\'s your request: Dana Example, your 2019 Honda Civic, damage: curb rash, on one of its wheels, finish: painted, dropping off Tuesday, November 17, morning, by 8. We\'ll reach you on 555 555 0111, and texts there are OK: yes. Is that right?',
    ]);
    expect(sys.requests).toEqual([]);
    expect(provider.sent).toEqual([]);

    expect(await c.say('yes, that is right')).toEqual(['Thanks, it is in.']);
    expect(sys.requests).toMatchObject([{ ref: 'R101', callerName: 'Dana Example', vehicle: '2019 Honda Civic', wheels: 'one', damage: 'curb rash', diamondCut: 'no', finish: 'painted', day: TUESDAY, window: 'morning', callbackNumber: '5555550111', textOk: 'yes' }]);
    expect(sys.roomIn(TUESDAY, 'morning')).toBe(room - 1);
    expect(provider.sent.map((t) => [t.to, t.body])).toEqual([
      [RETAIL, 'Thanks for your request with Example Wheel Works. Reply to this text with a photo of the damaged wheel and we\'ll send you a price. Reply STOP to opt out.'],
      [SHOP_PHONE, 'New request from Dana Example (5555550111): 2019 Honda Civic, curb rash, one wheel. Drop-off: Tuesday, November 17, morning.'],
    ]);
    const gate = c.audit.filter((r) => r.type === 'gate').map((r) => `${String(r.detail.tool)} ${String(r.detail.verdict)}`);
    expect(gate).toEqual(['check_availability ALLOW', 'send_request BLOCK', 'send_request ALLOW', 'send_photo_request ALLOW', 'notify_shop_request ALLOW']);
    // Each result is recorded beside its gate row: the request's reference among them.
    expect(c.audit.filter((r) => r.type === 'tool_result').map((r) => String(r.detail.summary))).toContainEqual('request R101 sent for 2026-11-17 morning');
  });

  it('reads a caller\'s note back, and keeps it with the request and in the shop\'s summary', async () => {
    const provider = fakeTextProvider();
    const { app, sys } = wheelshop({ now: () => NOW });
    const script: ConverseModelEvent[][] = [
      ...dropped(),
      [call('c1', 'check_availability', { day: TUESDAY }), done('tool')],
      [call('c2', 'send_request', { ...REQUEST, textOk: 'no', notes: "can't send a photo, call instead" }), done('tool')],
      [text('Thanks, it is in.'), done()],
    ];
    const c = converseTestCall(app, { model: fakeConverseModel(script), jev: routingJev(), now: () => new Date(NOW), texts: provider, env: { SHOP_PHONE } });
    await c.start();
    const [readBack] = await c.say('Tuesday morning please, but I cannot send a photo');
    expect(readBack).toContain('texts there are OK: no. A note for the shop: can\'t send a photo, call instead. Is that right?');
    await c.say('yes');
    expect(sys.requests).toMatchObject([{ ref: 'R101', notes: "can't send a photo, call instead" }]);
    expect(provider.sent.map((t) => [t.to, t.body])).toEqual([
      [SHOP_PHONE, "New request from Dana Example (5555550111): 2019 Honda Civic, curb rash, one wheel; note: can't send a photo, call instead. Drop-off: Tuesday, November 17, morning."],
    ]);
  });

  it('offers the model no follow-on: the photo text and the shop\'s summary run only after the request\'s yes', async () => {
    const model = fakeConverseModel([...dropped(), [text('Hello.'), done()]]);
    const { app } = wheelshop({ now: () => NOW });
    const c = converseTestCall(app, { model, jev: routingJev(), now: () => new Date(NOW) });
    await c.start();
    await c.say('I curbed my Civic');
    expect(toolNames(model)).toEqual(['check_availability', 'send_request', 'end_call']);
  });

  it('texts the caller nothing without their yes to texts: the gate refuses the photo request (no-consent), and the shop still gets its summary', async () => {
    const { c, sys, provider } = shop('no');
    await c.start();
    await c.say('I curbed my Civic, can I bring it in Tuesday morning?');
    await c.say('yes');
    expect(sys.requests).toHaveLength(1);
    expect(provider.sent.map((t) => t.to)).toEqual([SHOP_PHONE]);
    const refused = c.audit.find((r) => r.type === 'gate' && r.detail.tool === 'send_photo_request')!;
    expect(refused.detail).toMatchObject({ verdict: 'BLOCK', reason: 'no-consent' });
  });

  it('sends nothing when the caller does not say yes to the read-back', async () => {
    const { c, sys, provider } = shop('yes');
    await c.start();
    await c.say('I curbed my Civic, can I bring it in Tuesday morning?');
    await c.say('no, it is the afternoon');
    expect(sys.requests).toEqual([]);
    expect(provider.sent).toEqual([]);
  });

  it('offers no window on a day the shop is closed, and none on the standing Friday-morning drop-off', async () => {
    const { sys } = wheelshop({ now: () => NOW });
    expect(sys.free('2026-11-14')).toEqual([]);
    expect(sys.free('2026-11-13').map((s) => s.id)).toEqual(['2026-11-13:afternoon']);
    expect(sys.free('2026-11-10')).toEqual([]);
    expect(sys.free(TUESDAY)).toEqual([
      { id: `${TUESDAY}:morning`, label: 'Tuesday, November 17, morning, by 8', room: 3 },
      { id: `${TUESDAY}:afternoon`, label: 'Tuesday, November 17, afternoon, by noon', room: 3 },
    ]);
  });
});

describe('check_availability', () => {
  it('says why a window is not offered: its drop-off time passed today (never full), or full; and a closed or past day as one entry', () => {
    // Today, Thursday at 1 pm: both of today's windows have passed their drop-off times.
    const { sys } = wheelshop({ now: () => Date.parse('2026-11-12T18:00:00Z') });
    expect(sys.availability('2026-11-12')).toEqual([
      { window: 'Thursday, November 12, morning, by 8', offered: false, why: 'its drop-off time has passed today (the window is not full)' },
      { window: 'Thursday, November 12, afternoon, by noon', offered: false, why: 'its drop-off time has passed today (the window is not full)' },
    ]);
    // Friday morning is taken by the standing drop-off: full, never "passed".
    expect(sys.availability('2026-11-13')).toEqual([
      { window: 'Friday, November 13, morning, by 8', offered: false, why: 'full' },
      { id: '2026-11-13:afternoon', label: 'Friday, November 13, afternoon, by noon', room: 3 },
    ]);
    expect(sys.availability('2026-11-14')).toEqual([{ day: 'Saturday, November 14', offered: false, why: 'the shop is closed that day; it takes cars on monday, tuesday, wednesday, thursday, friday' }]);
    expect(sys.availability('2026-11-10')).toEqual([{ day: 'Tuesday, November 10', offered: false, why: 'that day has passed' }]);
  });
});

describe('book_dealer', () => {
  const VEHICLES = 'a 2021 BMW 3 Series, a 2020 Audi A4 and a 2022 Kia Sorento, all four wheels';
  const dealerScript = (cars = 'three', last = 'You are booked in.'): ConverseModelEvent[][] => [
    [call('c0', 'recognise_caller', {}), call('c1', 'check_availability', { day: THURSDAY }), done('tool')],
    [call('c2', 'book_dealer', { account: 'Rivergate Motors', cars, vehicles: VEHICLES, slot: `${THURSDAY}:morning` }), done('tool')],
    [text(last), done()],
  ];

  it('books the cars of the account the caller\'s number is on file for, and texts the shop a summary', async () => {
    const provider = fakeTextProvider();
    const { app, sys } = wheelshop({ now: () => NOW });
    const c = converseTestCall(app, { model: fakeConverseModel(dealerScript()), jev: routingJev(), callerNumber: DEALER, channel: 'voice', now: () => new Date(NOW), texts: provider, env: { SHOP_PHONE } });
    await c.start();
    expect(c.state.caller.account).toBe('Rivergate Motors');
    expect(await c.say('Rivergate Motors, three trade-ins tomorrow morning')).toEqual([`So that's Rivergate Motors, three in all: ${VEHICLES}, dropping off Thursday, November 12, morning, by 8. Shall we book it?`]);
    expect(await c.say('yes')).toEqual(['You are booked in.']);
    expect(sys.bookings).toMatchObject([{ ref: 'B101', account: 'Rivergate Motors', cars: 'three', vehicles: VEHICLES, day: THURSDAY, window: 'morning' }]);
    expect(sys.roomIn(THURSDAY, 'morning')).toBe(0);
    expect(provider.sent.map((t) => [t.to, t.body])).toEqual([[SHOP_PHONE, `New booking from Rivergate Motors (5555550142): three cars, ${VEHICLES}. Drop-off: Thursday, November 12, morning.`]]);
  });

  it('never offers the dealership tools to a caller on no account: a book_dealer it calls is refused, with no gate row and no read-back', async () => {
    const { app, sys } = wheelshop({ now: () => NOW });
    const c = converseTestCall(app, { model: fakeConverseModel(dealerScript('three', 'We can send the shop a request instead.')), jev: routingJev(), callerNumber: RETAIL, now: () => new Date(NOW), env: { SHOP_PHONE } });
    await c.start();
    expect(c.state.caller.account).toBeNull();
    expect(await c.say('This is Rivergate Motors, three trade-ins tomorrow morning')).toEqual(['We can send the shop a request instead.']);
    expect(sys.bookings).toEqual([]);
    // A dealership request from a number on no account fits none of the journeys open to it: the turn is unclear, so
    // the first round (asked before the route was known) is asked again with the lookups only, and book_dealer is refused.
    expect(c.traces.at(-1)!.route).toMatchObject({ outcome: 'root', unclear: 1, restarted: true });
    expect(c.traces.at(-1)!.tools).toMatchObject([{ name: 'book_dealer', outcome: 'refused' }]);
    expect(c.audit.filter((r) => r.type === 'gate').map((r) => r.detail.tool)).not.toContain('book_dealer');
  });

  it('refuses, before any read-back, an account other than the one recognise_caller returned for the number calling', async () => {
    const { app, sys } = wheelshop({ now: () => NOW });
    const script: ConverseModelEvent[][] = [
      [call('c0', 'recognise_caller', {}), call('c1', 'check_availability', { day: THURSDAY }), done('tool')],
      [call('c2', 'book_dealer', { account: 'Northside Auto Sales', cars: 'one', vehicles: VEHICLES, slot: `${THURSDAY}:morning` }), done('tool')],
      [text('I can only book for the account this number is on.'), done()],
    ];
    const c = converseTestCall(app, { model: fakeConverseModel(script), jev: routingJev(), callerNumber: DEALER, now: () => new Date(NOW), env: { SHOP_PHONE } });
    await c.start();
    expect(c.state.journey).toMatchObject({ active: 'dealer_booking' });
    expect(await c.say('Northside Auto Sales, one trade-in tomorrow morning')).toEqual(['I can only book for the account this number is on.']);
    expect(sys.bookings).toEqual([]);
    expect(c.traces.at(-1)!.tools).toMatchObject([{ name: 'recognise_caller', outcome: 'ran' }, { name: 'check_availability', outcome: 'ran' }, { name: 'book_dealer', outcome: 'invalid' }]);
    expect(c.audit.filter((r) => r.type === 'gate').map((r) => r.detail.tool)).not.toContain('book_dealer');
    expect(c.state.pending).toBeNull();
  });

  it('books nothing where the window has no room for every car now: the shop\'s calendar refuses it, and says how many it can take', async () => {
    const { app, sys } = wheelshop({ now: () => NOW });
    const c = converseTestCall(app, { model: fakeConverseModel(dealerScript('three', 'That window has filled.')), jev: routingJev(), callerNumber: DEALER, now: () => new Date(NOW), env: { SHOP_PHONE } });
    await c.start();
    await c.say('Rivergate Motors, three trade-ins tomorrow morning');
    // Another booking takes a place in the window between the read-back and the yes.
    sys.keep('booking', { ref: 'B900', at: new Date(NOW).toISOString(), account: 'Northside Auto Sales', cars: 'one', vehicles: '', day: THURSDAY, window: 'morning' }, NOW);
    expect(await c.say('yes')).toEqual(['That window has filled.']);
    expect(sys.bookings.map((b) => b.ref)).toEqual(['B900']);
    expect(c.traces.at(-1)!.tools).toMatchObject([{ name: 'book_dealer', outcome: 'failed', reason: expect.stringContaining('has room for 2 now, not 3') }]);
  });
});

describe('leave_callback', () => {
  it('keeps the note and texts the shop to call back, on the caller\'s yes', async () => {
    const provider = fakeTextProvider();
    const { app, sys } = wheelshop({ now: () => NOW });
    const script: ConverseModelEvent[][] = [...dropped(), [call('c1', 'leave_callback', { name: 'Avery Sample', callbackNumber: 'caller', about: 'a wheel left last week' }), done('tool')], [text('Someone will call you.'), done()]];
    const c = converseTestCall(app, { model: fakeConverseModel(script), jev: routingJev(), callerNumber: '+15555550114', now: () => new Date(NOW), texts: provider, env: { SHOP_PHONE } });
    await c.start();
    expect(await c.say('I would rather talk to a person')).toEqual(['We\'ll have someone from the shop call Avery Sample back on the number you\'re calling from, ending in 0114 about a wheel left last week. Is that right?']);
    await c.say('yes');
    expect(sys.callbacks).toMatchObject([{ ref: 'C101', name: 'Avery Sample', callbackNumber: '5555550114', about: 'a wheel left last week' }]);
    expect(provider.sent.map((t) => [t.to, t.body])).toEqual([[SHOP_PHONE, 'Call back Avery Sample at 5555550114 about a wheel left last week (callback note C101).']]);
  });
});

describe('journeys', () => {
  it('starts a dealership call in the dealer booking, before the caller speaks, and offers it its own actions', async () => {
    const model = fakeConverseModel([[text('Hello.'), done()]]);
    const { app } = wheelshop({ now: () => NOW });
    const jev = routingJev();
    const c = converseTestCall(app, { model, jev, callerNumber: DEALER, now: () => new Date(NOW) });
    await c.start();
    expect(c.state.journey).toMatchObject({ active: 'dealer_booking', phase: 'working' });
    await c.say('three trade-ins for tomorrow');
    expect(toolNames(model)).toEqual(['recognise_caller', 'check_availability', 'book_dealer', 'end_call']);
    // The repair request is closed to an account, so it is not among the options the decision model is asked.
    expect(Object.keys((routeAsks(jev)[0]!.questions.task as { criteria: object }).criteria)).toEqual(['dealer_booking', 'callback', 'question', 'none']);
  });

  it('never offers book_dealer to a caller on no account, nor asks about the dealer booking', async () => {
    const model = fakeConverseModel([...dropped(), [text('Hello.'), done()]]);
    const { app } = wheelshop({ now: () => NOW });
    const jev = routingJev();
    const c = converseTestCall(app, { model, jev, callerNumber: RETAIL, now: () => new Date(NOW) });
    await c.start();
    expect(c.state.journey).toMatchObject({ active: null });
    await c.say('I curbed my Civic, can I bring it in Tuesday?');
    expect(c.state.journey).toMatchObject({ active: 'repair_request' });
    expect(toolNames(model)).not.toContain('book_dealer');
    expect(toolNames(model)).not.toContain('recognise_caller');
    expect(Object.keys((routeAsks(jev)[0]!.questions.task as { criteria: object }).criteria)).toEqual(['repair_request', 'callback', 'question', 'none']);
  });

  it('refuses a book_dealer the model calls in a request, as not offered, and sends nothing', async () => {
    const { app, sys } = wheelshop({ now: () => NOW });
    const script: ConverseModelEvent[][] = [...dropped(), [call('c1', 'book_dealer', { account: 'Rivergate Motors', cars: 'one', vehicles: 'a car', slot: `${THURSDAY}:morning` }), done('tool')], [text('We can send the shop a request instead.'), done()]];
    const c = converseTestCall(app, { model: fakeConverseModel(script), jev: routingJev(), callerNumber: RETAIL, now: () => new Date(NOW), env: { SHOP_PHONE } });
    await c.start();
    expect(await c.say('I curbed my Civic, can I bring it in Thursday?')).toEqual(['We can send the shop a request instead.']);
    expect(sys.bookings).toEqual([]);
    expect(c.traces.at(-1)!.tools).toMatchObject([{ name: 'book_dealer', outcome: 'refused', reason: expect.stringContaining('is not available') }]);
  });

  it('greets a caller on no account as a receptionist, and a recognised dealership with a booking question', async () => {
    const { app } = wheelshop({ now: () => NOW });
    const retail = converseTestCall(app, { model: fakeConverseModel([]), jev: routingJev(), callerNumber: RETAIL, now: () => new Date(NOW) });
    expect(await retail.start()).toEqual(['Thanks for calling Example Wheel Works, where we make damaged wheels look new again. We can price a repair and set up a drop-off, or have someone from the shop call you back. How can we help?']);
    const dealer = converseTestCall(app, { model: fakeConverseModel([]), jev: routingJev(), callerNumber: DEALER, now: () => new Date(NOW) });
    expect(await dealer.start()).toEqual(['Example Wheel Works, hi. Booking some cars in today?']);
  });

  it('answers a turn it cannot follow with the model\'s guidance and the lookups alone, and ends on the third in a row with the shop\'s line', async () => {
    const { app, sys } = wheelshop({ now: () => NOW });
    const guide = (): ConverseModelEvent[] => [text('We can price a wheel repair or take a callback note.'), done()];
    const model = fakeConverseModel([...dropped(), guide(), ...dropped(), guide(), ...dropped()]);
    const c = converseTestCall(app, { model, jev: routingJev(), callerNumber: RETAIL, now: () => new Date(NOW), env: { SHOP_PHONE } });
    await c.start();
    expect(await c.say('mumble mumble')).toEqual(['We can price a wheel repair or take a callback note.']);
    expect(toolNames(model)).toEqual(['end_call']);
    expect(await c.say('hmm hm')).toEqual(['We can price a wheel repair or take a callback note.']);
    const said = await c.say('uh huh');
    expect(said).toEqual(['Sorry, this line can only help with a wheel repair or a callback. Call us back any time.']);
    expect(model.requests).toHaveLength(5); // two turns' dropped round and guidance, and none on the third
    expect(sys.bookings).toEqual([]);
  });

  it('moves a confirmed request to the after phase, withdrawing send_request', async () => {
    const provider = fakeTextProvider();
    const { app } = wheelshop({ now: () => NOW });
    const model = fakeConverseModel([...dropped(), ...requestScript('yes'), [text('Anything else?'), done()]]);
    const c = converseTestCall(app, { model, jev: routingJev(), now: () => new Date(NOW), texts: provider, env: { SHOP_PHONE } });
    await c.start();
    await c.say('I curbed my Civic, can I bring it in Tuesday morning?');
    expect(c.state.journey).toMatchObject({ active: 'repair_request', phase: 'working' });
    await c.say('yes, that is right');
    expect(c.state.journey).toMatchObject({ active: 'repair_request', phase: 'after', done: ['repair_request'] });
    expect(toolNames(model)).toEqual(['check_availability', 'end_call']);
    await c.say('what is the parking like?');
    expect(toolNames(model)).toEqual(['check_availability', 'end_call']);
  });
});

describe('the app folder', () => {
  it('passes pnpm check', async () => {
    expect((await checkApp(APP_DIR)).map(formatProblem)).toEqual([]);
  });

  it('takes no caller number from a chat\'s context as deployed: only the simulated callers\' own server does (the engine\'s tests hold both)', () => {
    expect(wheelshop({}).app.chat.callerNumberFromContext).toBe(false);
  });

  it('reads no setting as it is made: agent.yaml\'s references wait for the server, and the shop page is made by it', () => {
    const { app } = wheelshop({});
    expect(app.business.sources.accounts!.find((a) => a.name === 'Rivergate Motors')!.numbers).toContain('env.DEALER_TEST_LINE');
    expect(typeof app.pages).toBe('function');
  });

  it('is made fresh for each simulated call, with systems of its own', () => {
    const { app } = wheelshop({ now: () => NOW });
    const again = app.fresh!();
    expect(again).not.toBe(app);
    expect(again.tools.send_request).not.toBe(app.tools.send_request);
  });

  it('keeps a fresh app\'s records in memory alone, whatever SHOP_DATA_DIR says: a simulated call never reads or writes the shop\'s log', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wheelshop-fresh-'));
    const deps = (app: ConverseApp) => ({ app, base: '/wheelshop-agent', env: (n: string) => (n === 'SHOP_DATA_DIR' ? dir : undefined), now: () => NOW, log: () => {}, publicHost: 'localhost', consoleSignIn: false });
    const { app } = wheelshop({ now: () => NOW });
    const fresh = app.fresh!();
    const pages = fresh.pages as (d: ReturnType<typeof deps>) => { warnings?: string[] };
    expect(pages(deps(fresh)).warnings).toContainEqual(expect.stringMatching(/kept in memory/));
    expect(readdirSync(dir)).toEqual([]);
    const own = (app.pages as (d: ReturnType<typeof deps>) => { warnings?: string[] })(deps(app));
    expect(own.warnings ?? []).not.toContainEqual(expect.stringMatching(/kept in memory/));
  });
});

describe('after hours', () => {
  const AFTER_HOURS = 'Thanks for calling Example Wheel Works. We\'re closed right now, but we can price a repair and set up a drop-off, or take a note for the shop to call you back. How can we help?';
  const SATURDAY = Date.parse('2026-11-14T15:00:00Z'); // 10 a.m. at the shop, a Saturday
  const NIGHT = Date.parse('2026-11-12T04:00:00Z'); // 11 p.m. Wednesday at the shop
  const systemOf = (m: { requests: readonly unknown[] }): string => (m.requests.at(-1) as { system: string }).system;

  async function opening(at: number, callerNumber?: string) {
    const model = fakeConverseModel([...dropped(), [text('Hello.'), done()]]);
    const { app } = wheelshop({ now: () => at });
    const c = converseTestCall(app, { model, jev: routingJev(), now: () => new Date(at), env: { SHOP_PHONE }, ...(callerNumber !== undefined ? { callerNumber } : {}) });
    const greeting = await c.start();
    await c.say('I curbed my Civic');
    return { greeting, model };
  }

  it('opens with the after-hours greeting on a Saturday, and tells the model the shop is closed until Monday at 7:30 am', async () => {
    const { greeting, model } = await opening(SATURDAY);
    expect(greeting).toEqual([AFTER_HOURS]);
    expect(systemOf(model)).toContain('The business is closed now; it next opens Monday, November 16, at 7:30 am.');
  });

  it('opens with the after-hours greeting at 11 pm on a weekday', async () => {
    const { greeting, model } = await opening(NIGHT);
    expect(greeting).toEqual([AFTER_HOURS]);
    expect(systemOf(model)).toContain('The business is closed now; it next opens Thursday, November 12, at 7:30 am.');
  });

  it('in opening hours says the usual greeting and that the shop is open until 5:30 pm', async () => {
    const { greeting, model } = await opening(NOW);
    expect(greeting[0]).toMatch(/^Thanks for calling Example Wheel Works, where we make damaged wheels look new again\./);
    expect(systemOf(model)).toContain('The business is open now, until 5:30 pm.');
  });

  it('gives a dealership calling at night the after-hours greeting, not the dealership one', async () => {
    const { greeting } = await opening(NIGHT, DEALER);
    expect(greeting).toEqual([AFTER_HOURS]);
  });

  it('gives a dealership in opening hours its own greeting', async () => {
    const { greeting } = await opening(NOW, DEALER);
    expect(greeting).toEqual(['Example Wheel Works, hi. Booking some cars in today?']);
  });

  it('gives no callback time: the question about it is answered with no set time', async () => {
    const { app } = wheelshop({ now: () => NOW });
    const model = fakeConverseModel([...dropped(), [text('Hello.'), done()]]);
    const c = converseTestCall(app, { model, jev: routingJev(), now: () => new Date(NOW), env: { SHOP_PHONE } });
    await c.start();
    await c.say('I want to talk to a person');
    const system = systemOf(model);
    expect(system).toContain("As soon as the shop can; we don't give a set time.");
    expect(system).toContain('Never say when someone will call back.');
    expect(system).not.toMatch(/working day/i);
  });
});
