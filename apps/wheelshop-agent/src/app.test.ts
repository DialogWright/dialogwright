import { checkApp, formatProblem, type JevClient } from 'dialogwright';
import { converseTestCall, fakeConverseModel, fakeTextProvider, type ConverseModelEvent } from 'dialogwright/testing';
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

/** A decision model that reads "yes" in the caller's words as a yes, and anything else as a no. */
const yesJev: JevClient = {
  async ask(req) {
    const yes = /\byes\b/i.test(String((req.state as { said?: unknown }).said ?? ''));
    return {
      answers: { confirmsYes: { type: 'noul', noul: yes ? 0.95 : 0.05 }, confirmsNo: { type: 'noul', noul: yes ? 0.05 : 0.9 } },
      model: 'fake', usage: { inputTokens: 0, outputTokens: 0, estimated: true }, latencyMs: 1, source: 'jev',
    };
  },
};

const REQUEST = { name: 'Dana Example', vehicle: '2019 Honda Civic', wheels: 'one', damage: 'curb rash', finish: 'painted all over', slot: `${TUESDAY}:morning`, callbackNumber: '555 555 0111' };

/** The model's side of a request: a lookup, the request called, then a reply after the caller's answer. */
const requestScript = (textOk: string): ConverseModelEvent[][] => [
  [text('Let me check Tuesday. '), call('c1', 'check_availability', { day: TUESDAY }), done('tool')],
  [call('c2', 'send_request', { ...REQUEST, textOk }), done('tool')],
  [text('Thanks, it is in.'), done()],
];

function shop(textOk: string, callerNumber?: string) {
  const provider = fakeTextProvider();
  const { app, sys } = wheelshop({ now: () => NOW, env: () => undefined });
  const c = converseTestCall(app, { model: fakeConverseModel(requestScript(textOk)), jev: yesJev, now: () => new Date(NOW), texts: provider, env: { SHOP_PHONE }, ...(callerNumber !== undefined ? { callerNumber } : {}) });
  return { c, sys, provider };
}

describe('send_request', () => {
  it('is read back in the shop\'s words and, on the yes, books the slot, texts the caller for a photo and the shop a summary', async () => {
    const { c, sys, provider } = shop('yes');
    expect(await c.start()).toEqual(['Example Wheel Works, how can we help?']);
    const room = sys.roomIn(TUESDAY, 'morning');
    expect(await c.say('I curbed my Civic, can I bring it in Tuesday morning?')).toEqual([
      'Let me check Tuesday. ',
      'Here\'s your request: Dana Example, your 2019 Honda Civic, damage: curb rash, on one of its wheels, finish: painted all over, dropping off Tuesday, November 17, morning, by 8. We\'ll reach you on the number ending in 0111, and texts there are OK: yes. Is that right?',
    ]);
    expect(sys.requests).toEqual([]);
    expect(provider.sent).toEqual([]);

    expect(await c.say('yes, that is right')).toEqual(['Thanks, it is in.']);
    expect(sys.requests).toMatchObject([{ ref: 'R101', callerName: 'Dana Example', vehicle: '2019 Honda Civic', wheels: 'one', damage: 'curb rash', diamondCut: 'no', finish: 'painted all over', day: TUESDAY, window: 'morning', callbackNumber: '5555550111', textOk: 'yes' }]);
    expect(sys.roomIn(TUESDAY, 'morning')).toBe(room - 1);
    expect(provider.sent.map((t) => [t.to, t.body])).toEqual([
      [RETAIL, 'Thanks for your request with Example Wheel Works. Reply to this text with a photo of the damaged wheel and we\'ll send you a price. Reply STOP to opt out.'],
      [SHOP_PHONE, 'New request from Dana Example (5555550111): 2019 Honda Civic, curb rash, one wheel. Drop-off: Tuesday, November 17, morning.'],
    ]);
    const gate = c.audit.filter((r) => r.type === 'gate').map((r) => `${String(r.detail.tool)} ${String(r.detail.verdict)}`);
    expect(gate).toEqual(['check_availability ALLOW', 'send_request BLOCK', 'send_request ALLOW', 'send_photo_request ALLOW', 'notify_shop_request ALLOW']);
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
    const { sys } = wheelshop({ now: () => NOW, env: () => undefined });
    expect(sys.free('2026-11-14')).toEqual([]);
    expect(sys.free('2026-11-13').map((s) => s.id)).toEqual(['2026-11-13:afternoon']);
    expect(sys.free('2026-11-10')).toEqual([]);
    expect(sys.free(TUESDAY)).toEqual([
      { id: `${TUESDAY}:morning`, label: 'Tuesday, November 17, morning, by 8', room: 3 },
      { id: `${TUESDAY}:afternoon`, label: 'Tuesday, November 17, afternoon, by noon', room: 3 },
    ]);
  });
});

describe('book_dealer', () => {
  const dealerScript: ConverseModelEvent[][] = [
    [call('c1', 'check_availability', { day: THURSDAY }), done('tool')],
    [call('c2', 'book_dealer', { account: 'Rivergate Motors', cars: 'three', slot: `${THURSDAY}:morning` }), done('tool')],
    [text('You are booked in.'), done()],
  ];

  it('books the cars of the account the caller\'s number is on file for, and texts the shop a summary', async () => {
    const provider = fakeTextProvider();
    const { app, sys } = wheelshop({ now: () => NOW, env: () => undefined });
    const c = converseTestCall(app, { model: fakeConverseModel(dealerScript), jev: yesJev, callerNumber: DEALER, channel: 'voice', now: () => new Date(NOW), texts: provider, env: { SHOP_PHONE } });
    await c.start();
    expect(c.state.caller.account).toBe('Rivergate Motors');
    expect(await c.say('Rivergate Motors, three trade-ins tomorrow morning')).toEqual(['So that\'s Rivergate Motors, three in all, dropping off Thursday, November 12, morning, by 8. Shall we book it?']);
    expect(await c.say('yes')).toEqual(['You are booked in.']);
    expect(sys.bookings).toMatchObject([{ ref: 'B101', account: 'Rivergate Motors', cars: 'three', day: THURSDAY, window: 'morning' }]);
    expect(sys.roomIn(THURSDAY, 'morning')).toBe(0);
    expect(provider.sent.map((t) => [t.to, t.body])).toEqual([[SHOP_PHONE, 'New booking from Rivergate Motors (5555550142): three cars. Drop-off: Thursday, November 12, morning.']]);
  });

  it('books nothing for a caller whose number is on file for no account, whatever account they name', async () => {
    const { app, sys } = wheelshop({ now: () => NOW, env: () => undefined });
    const c = converseTestCall(app, { model: fakeConverseModel(dealerScript), jev: yesJev, callerNumber: RETAIL, now: () => new Date(NOW), env: { SHOP_PHONE } });
    await c.start();
    await c.say('This is Rivergate Motors, three trade-ins tomorrow morning');
    await c.say('yes');
    expect(sys.bookings).toEqual([]);
    expect(c.traces.at(-1)!.tools).toMatchObject([{ name: 'book_dealer', outcome: 'failed' }]);
  });
});

describe('leave_callback', () => {
  it('keeps the note and texts the shop to call back, on the caller\'s yes', async () => {
    const provider = fakeTextProvider();
    const { app, sys } = wheelshop({ now: () => NOW, env: () => undefined });
    const script: ConverseModelEvent[][] = [[call('c1', 'leave_callback', { name: 'Avery Sample', callbackNumber: 'caller', about: 'a wheel left last week' }), done('tool')], [text('Someone will call you.'), done()]];
    const c = converseTestCall(app, { model: fakeConverseModel(script), jev: yesJev, callerNumber: '+15555550114', now: () => new Date(NOW), texts: provider, env: { SHOP_PHONE } });
    await c.start();
    expect(await c.say('I would rather talk to a person')).toEqual(['We\'ll have someone from the shop call Avery Sample back on the number ending in 0114 about a wheel left last week. Is that right?']);
    await c.say('yes');
    expect(sys.callbacks).toMatchObject([{ ref: 'C101', name: 'Avery Sample', callbackNumber: '5555550114', about: 'a wheel left last week' }]);
    expect(provider.sent.map((t) => [t.to, t.body])).toEqual([[SHOP_PHONE, 'Call back Avery Sample at 5555550114 about a wheel left last week (callback note C101).']]);
  });
});

describe('the app folder', () => {
  it('passes pnpm check', async () => {
    expect((await checkApp(APP_DIR)).map(formatProblem)).toEqual([]);
  });
});
