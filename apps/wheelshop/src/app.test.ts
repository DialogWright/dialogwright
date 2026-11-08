import { fileURLToPath } from 'node:url';
import { checkApp, formatProblem, type ToolCall, type ToolDef, type ToolReply } from 'dialogwright';
import { danglingReferences, expectAppMap, expectPolicyCard, expectPolicyMatrix, policyInvariants, runRuleExamples } from 'dialogwright/testing';
import { describe, expect, it } from 'vitest';
import { APP_DIR, Systems, TOOLS, app, code, ownerSummary } from './app';

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
    expect(app.agent?.forms.booking?.then).toEqual(['book', 'notify_owner_booking']);
    expect(app.agent?.forms.callback?.then).toEqual(['callback']);
    // The day's free windows reach the model on both forms that ask for a day.
    expect(app.agent?.sees).toEqual({ request_day: 'availability', booking_day: 'availability' });
  });

  it('has an action for every tool, and no other but the engine\'s two for recognizing an account', () => {
    expect(Object.keys(app.policy.toolLevel).sort()).toEqual([...Object.keys(code.tools), 'lookupAccount', 'recognizeAccount'].sort());
  });

  it('keeps the price line fixed, promising no link before the request is confirmed', () => {
    const price = app.agent?.facts.fixed.price ?? '';
    expect(price).toMatch(/^Sam quotes every job from a photo/);
    expect(price).toMatch(/Once I've sent him your request/);
    expect(price).not.toMatch(/\d/);
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

/** Runs a tool with a write key, as the gate does once it allows the call. */
function run(sys: Systems, tool: string, params: Record<string, string>, key?: string): ToolReply {
  const call: ToolCall = { tool, params };
  return (TOOLS[tool] as ToolDef).run(call, sys, (key === undefined ? {} : { idempotencyKey: key }) as unknown as Parameters<ToolDef['run']>[2]) as ToolReply;
}

const REQUEST = { callerName: 'jordan lee', vehicle: '2020 BMW 3 Series', wheels: 'one', damage: 'curb rash', diamondCut: 'yes', day: '2026-11-12', window: 'morning', callbackNumber: '5555550177' };
const BOOKING = { account: 'rivergate_motors', cars: 'three', vehicles: '2019 Civic, Tacoma, 2021 Model 3', day: '2026-11-11', window: 'morning' };

describe('the stand-in calendar', () => {
  const free = (sys: Systems, day: string) => run(sys, 'availability', { day }).value;

  it('has two windows each weekday, none at the weekend, and its reply passes the closed check the model is shown it by', () => {
    const sys = new Systems();
    expect(free(sys, '2026-11-12')).toEqual({ day: '2026-11-12', windows: ['morning', 'afternoon'] });
    expect(free(sys, '2026-11-14')).toEqual({ day: '2026-11-14', windows: [] });
    for (const day of ['2026-11-12', '2026-11-13', '2026-11-14']) expect(TOOLS.availability!.check!(free(sys, day))).toBe(true);
    expect(TOOLS.availability!.check!({ day: '2026-11-12', windows: ['evening'] })).toBe(false);
    expect(TOOLS.availability!.check!({ day: 'Thursday', windows: ['morning'] })).toBe(false);
  });

  it('starts with Friday morning full (a standing drop-off), so the demo has a full window to meet', () => {
    expect(free(new Systems(), '2026-11-13')).toEqual({ day: '2026-11-13', windows: ['afternoon'] });
  });

  it('fills a window by the cars booked into it, up to its capacity in business.yaml', () => {
    const sys = new Systems();
    run(sys, 'book', { ...BOOKING, cars: 'two' }, 'k-1');
    expect(free(sys, '2026-11-11')).toEqual({ day: '2026-11-11', windows: ['morning', 'afternoon'] });
    run(sys, 'book', { ...BOOKING, cars: 'one' }, 'k-2');
    expect(free(sys, '2026-11-11')).toEqual({ day: '2026-11-11', windows: ['afternoon'] });
  });

  it('refuses a booking without room for its cars, as a real calendar would: nothing booked, and no reference, so the reply fails its check', () => {
    const sys = new Systems();
    const full = run(sys, 'book', { ...BOOKING, day: '2026-11-13', window: 'morning' }, 'k-1');
    expect(TOOLS.book!.check!(full.value)).toBe(false);
    expect(sys.bookings).toEqual([]);
    const tooMany = run(sys, 'book', { ...BOOKING, cars: 'four' }, 'k-2');
    expect(TOOLS.book!.check!(tooMany.value)).toBe(false);
    expect(sys.bookings).toEqual([]);
    // A booking repeated for its key after it filled the window is the same booking, not refused.
    run(sys, 'book', BOOKING, 'k-3');
    expect(TOOLS.book!.check!(run(sys, 'book', BOOKING, 'k-3').value)).toBe(true);
    expect(sys.bookings).toHaveLength(1);
  });

  it('takes no room for a request: Sam confirms its window with the quote', () => {
    const sys = new Systems();
    run(sys, 'request', { ...REQUEST, day: '2026-11-11' }, 'k-1');
    expect(free(sys, '2026-11-11')).toEqual({ day: '2026-11-11', windows: ['morning', 'afternoon'] });
  });
});

describe('the writes and the texts', () => {
  it('does each write once for its key, whatever is repeated', () => {
    const sys = new Systems();
    const first = run(sys, 'book', BOOKING, 'k-1');
    const again = run(sys, 'book', BOOKING, 'k-1');
    expect(again.ref).toBe(first.ref);
    expect(sys.bookings).toHaveLength(1);
    expect(sys.booked.get('2026-11-11 morning')).toBe(3);
    expect(run(sys, 'book', BOOKING, 'k-2').ref).not.toBe(first.ref);
    for (const tool of ['request', 'send_photo_link', 'notify_owner_request', 'callback']) {
      const before = sys.texts.length + sys.requests.length + sys.callbacks.length;
      const params = tool === 'callback' ? { callbackNumber: '5555550177' } : REQUEST;
      const a = run(sys, tool, params, `once-${tool}`);
      const b = run(sys, tool, params, `once-${tool}`);
      expect(b.ref, tool).toBe(a.ref);
      // Each kept once: a callback note is kept, and Sam is texted the number to call.
      expect(sys.texts.length + sys.requests.length + sys.callbacks.length, tool).toBe(before + (tool === 'callback' ? 2 : 1));
      expect(TOOLS[tool]!.check!(a.value), tool).toBe(true);
    }
  });

  it('texts the caller a link to send Sam a photo (printed, not sent), at example.com', () => {
    const sys = new Systems();
    run(sys, 'send_photo_link', REQUEST, 'k-1');
    expect(sys.texts).toEqual([{ ref: 'P101', to: '5555550177', text: 'Example Wheel Works: send Sam a photo of the damage at https://example.com/photo/P101' }]);
  });

  it('texts Sam the summary in business.yaml\'s fixed words, the caller\'s number whole in the text and by its last four in the record', () => {
    const sys = new Systems();
    const reply = run(sys, 'notify_owner_request', REQUEST, 'k-1');
    expect(sys.texts.at(-1)).toEqual({ ref: 'N101', to: '+15555550100', text: 'New request from Jordan Lee (5555550177): 2020 BMW 3 Series, curb rash, one wheel, diamond cut. Drop-off: Thursday, November 12, morning.' });
    expect(reply.summary).toContain('(...0177)');
    expect(reply.summary).not.toContain('5555550177');
    run(sys, 'notify_owner_booking', BOOKING, 'k-2');
    expect(sys.texts.at(-1)?.text).toBe('New booking from Rivergate Motors (5555550142): three cars, 2019 Civic, Tacoma, 2021 Model 3. Drop-off: Wednesday, November 11, morning.');
  });

  it('fills only the template\'s own placeholders', () => {
    expect(ownerSummary({ kind: 'request', who: 'Casey Morgan', callbackNumber: '5555550123', details: 'Civic, curb rash', day: 'Friday, November 13', window: 'afternoon' }))
      .toBe('New request from Casey Morgan (5555550123): Civic, curb rash. Drop-off: Friday, November 13, afternoon.');
  });

  it('keeps a callback note, and tells Sam the number to call', () => {
    const sys = new Systems();
    const reply = run(sys, 'callback', { callbackNumber: '5555550177' }, 'k-1');
    expect(sys.callbacks).toEqual([{ callbackNumber: '5555550177', ref: 'C101' }]);
    expect(sys.texts).toEqual([{ ref: 'C101', to: '+15555550100', text: 'Call back 5555550177 (callback note C101).' }]);
    expect(reply.summary).toBe('callback note C101 for ...0177');
  });
});
