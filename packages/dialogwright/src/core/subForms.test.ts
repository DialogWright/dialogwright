import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { choice, noul, score } from '../testing/answers';
import { registerApp, resetAppsForTest } from './app/registry';
import type { App } from './app/types';
import { listenOf } from './app/lookup';
import { formLabel } from './app/intents';
import { DEFAULT_THRESHOLDS } from './thresholds';
import { closeForm, newSession, setForm, type Session } from './session';
import { plan, resolve, type TurnContext, type TurnResult } from './turn';
import { speechEvent, startEvent, textEvent } from '../channel/events';
import { VOICE_RELAY, WEB_CHAT } from '../channel/caps';
import { jsonTrip } from '../testing/sessionRoundTrip';
import { ANONYMOUS } from '../gate/principal';
import { mockCodeVerifier } from './tools';
import { spokenText } from '../prompts/render';
import type { AnswerMap } from '../jev/types';
import { screenedApp } from '../testing/screened/app';
import { NEXT, over, replace, screenedVariants } from '../testing/screened/variant';
import { testkitApp } from '../testing/testkit';

/**
 * A form's `next` and an internal form (design 2026-10-08-sub-forms-and-listening), on the two-form
 * variant of the screened fixture: `screen_home` asks the problem, the ownership and the town, with
 * a check on the ownership and the town and no summary, and goes on to `book_visit`, internal, which
 * lists the screen's three slots again and asks the urgency, the day and the time before its summary.
 * Then `listenBeforeEntered`: which slots fill from what is said before their form is open.
 */

const TODAY = '2026-09-18';
const variants = screenedVariants();
afterAll(() => variants.remove());

const app = variants.variant(NEXT);
/** The urgent request is no priority intent here, so the caller can queue it. */
const queuing = variants.variant(over(NEXT, { 'app.yaml': replace('id: screened-next', 'id: screened-next-queue'), 'intents.yaml': replace('    priority: { correctsForm: true }\n', '') }));
/** The screen's slots wait for the screen to be open too. */
const waiting = variants.variant(over(NEXT, { 'app.yaml': replace('id: screened-next', 'id: screened-next-wait'), 'forms.yaml': replace('    next: book_visit\n', '    next: book_visit\n    listenBeforeEntered: false\n') }));
/** As `waiting`, with the town's own listen: up-front over it. */
const townUpFront = variants.variant(over(NEXT, {
  'app.yaml': replace('id: screened-next', 'id: screened-next-town'),
  'forms.yaml': replace('    next: book_visit\n', '    next: book_visit\n    listenBeforeEntered: false\n'),
  'slots.yaml': replace('town:\n  type: choice\n', 'town:\n  type: choice\n  listen: up-front\n'),
}));

/** A middle form between the screen and the booking: internal, no summary, its slots all the screen's. */
const middled = variants.variant(over(NEXT, {
  'app.yaml': replace('id: screened-next', 'id: screened-next-middle'),
  'forms.yaml': (t) => replace('    next: book_visit\n', '    next: note_home\n')(t).replace('  book_visit:\n', '  note_home:\n    internal: true\n    label: note the home\n    slots: [problem, ownership, town]\n    summaryPromptId: null\n    calls: []\n    next: book_visit\n  book_visit:\n'),
}));
/** The screen checks only the town; the booking checks the ownership, on its first turn. */
const ownerInBooking = variants.variant(over(NEXT, {
  'app.yaml': replace('id: screened-next', 'id: screened-next-owner'),
  'forms.yaml': replace('    checks:\n      - action: checkOwner\n        with: [ownership]\n        on:\n          not-owner: { say: decline_renter, then: end }\n      - action: checkArea', '    checks:\n      - action: checkArea'),
}));

/** A second screener into the same booking. */
const twoScreens = variants.variant(over(NEXT, {
  'app.yaml': replace('id: screened-next', 'id: screened-next-two'),
  'forms.yaml': replace('  book_visit:\n', '  screen_crack:\n    slots: [problem, ownership, town]\n    summaryPromptId: null\n    calls: []\n    next: book_visit\n  book_visit:\n'),
  'intents.yaml': replace('  urgent:\n', '  screen_crack:\n    criteria: Wants a visit about a crack in the home\n    label: look at a crack\n    kind: form\n  urgent:\n'),
}));
/** The booking is an intent too, reached directly or after the screen. */
const bookingIntent = variants.variant(over(NEXT, {
  'app.yaml': replace('id: screened-next', 'id: screened-next-direct'),
  'forms.yaml': replace('  book_visit:\n    internal: true\n    label: book your visit\n', '  book_visit:\n'),
  'intents.yaml': replace('  urgent:\n', '  book_visit:\n    criteria: Wants to book the visit itself\n    label: book your visit\n    kind: form\n  urgent:\n'),
}));

let current: App = app;
function use(a: App): void {
  resetAppsForTest();
  registerApp(a);
  current = a;
}
beforeEach(() => use(app));

const tc = (): TurnContext => ({ nowMs: 0, todayIso: TODAY, thresholds: { ...DEFAULT_THRESHOLDS }, tools: { ...current.systems(), codes: mockCodeVerifier } });

/** The engine's own questions, each answered plainly. */
const PLAIN: AnswerMap = {
  addressedToSystem: noul(0.95), intelligible: noul(0.95), utteranceComplete: noul(0.9), wantsHuman: noul(0.05),
  rephrasingLastTurn: noul(0.1), confusedByPrompt: noul(0.1), spokeAMenuNumber: noul(0.05),
  frustration: score({ none: 0.8, mild: 0.15, high: 0.05 }),
  intent: choice({ none: 0.9, other: 0.1 }),
  intentChange: choice({ answering: 0.95, adding: 0.03, replacing: 0.02 }),
  secondIntent: choice({ none: 0.95, urgent: 0.05 }),
};
const one = (value: string) => choice({ [value]: 0.95, none: 0.05 });
const YES: AnswerMap = { confirmsYes: noul(0.95), confirmsNo: noul(0.02) };

/** "I own a house in Riverton with a leak, can someone come out on a Saturday morning", as the model reads it. */
const OPENER: AnswerMap = { intent: one('screen_home'), problem: one('leak'), ownership: one('own'), town: one('riverton'), visitDay: one('saturday'), timeOfDay: one('morning') };
const OPENER_TEXT = 'I own a house in Riverton with a leak, can someone come out on a Saturday morning';

function started(): Session {
  return resolve(newSession('s', 0, VOICE_RELAY, ANONYMOUS, current.id), startEvent(), null, tc()).session;
}
function say(s: Session, text: string, answers: AnswerMap): TurnResult {
  return resolve(s, speechEvent(text, true), { ...PLAIN, ...answers }, tc());
}
const heard = (t: TurnResult): string => spokenText(current, t.decision);
const gates = (t: TurnResult): string[] => t.gateEvents.map((e) => `${e.decision.call.tool}:${e.decision.verdict}${e.decision.reason ? `:${e.decision.reason}` : ''}`);
const rows = (t: TurnResult): string[] => t.audit.map((d) => d.type);
const ackIds = (t: TurnResult): string[] => ('acks' in t.decision ? t.decision.acks.map((a) => a.promptId) : []);
const promptOf = (t: TurnResult): string | null => (t.decision.kind === 'prompt' ? t.decision.promptId : null);
const NO: AnswerMap = { confirmsYes: noul(0.05), confirmsNo: noul(0.9) };
/** The screen named again beside something urgent: the screen likelier, the urgent request under its priority threshold. */
const SCREEN_AND_URGENT: AnswerMap = { intent: choice({ screen_home: 0.6, urgent: 0.35, none: 0.05 }) };
const ADDING = choice({ adding: 0.9, answering: 0.05, replacing: 0.05 });
const REPLACING = choice({ replacing: 0.9, answering: 0.05, adding: 0.05 });

/** From the opener to the booking's summary: an owner in Riverton, a leak, whenever suits, Saturday morning. */
function toSummary(): TurnResult {
  let t = say(started(), OPENER_TEXT, OPENER);
  t = say(t.session, 'it can wait', { howUrgent: one('routine') });
  t = say(t.session, 'Saturday', { visitDay: one('saturday') });
  return say(t.session, 'the morning', { timeOfDay: one('morning') });
}

describe('the screen goes on to the booking', () => {
  it('in one breath: the screen qualifies and completes, and the booking opens at once with the shared slots kept and its own asked', () => {
    const t = say(started(), OPENER_TEXT, OPENER);
    expect(gates(t)).toEqual(['checkOwner:ALLOW', 'checkArea:ALLOW']);
    expect(ackIds(t)).toEqual(['ack_intent', 'visit_qualifies', 'bridge_next']);
    expect(t.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_howUrgent', acks: [{}, {}, { promptId: 'bridge_next', vars: { intentLabel: 'book your visit' } }] });
    expect(heard(t)).toBe('Sure, I can help you book a free visit. Good news, we work in Riverton, and the visit is free. Now, let\'s book your visit. How soon does it need looking at?');
    expect(t.session.form).toBe('book_visit');
    expect(t.session.completed).toEqual(['screen_home']);
    expect(t.session.queued).toEqual([]);
    // The shared slots carried in; the booking's own were not taken from the opener.
    expect([t.session.slots.problem!.value, t.session.slots.ownership!.value, t.session.slots.town!.value]).toEqual(['leak', 'own', 'riverton']);
    expect([t.session.slots.visitDay!.value, t.session.slots.timeOfDay!.value]).toEqual([null, null]);
    // The booking lists the ownership check too, and the screen's area check holds in it (its town is
    // the booking's too): both passes carried, so the gate is not asked again.
    expect(Object.keys(t.session.checked ?? {}).sort()).toEqual(['checkArea', 'checkOwner']);
    // The audit says the form moved on, after the screen's checks.
    expect(rows(t)).toEqual(['gate', 'gate', 'form_next']);
    expect(t.audit[2]).toEqual({ type: 'form_next', detail: { form: 'screen_home', next: 'book_visit' } });
  });

  it('asks the booking\'s own slots, reads all of them back, and books: the screen\'s answers are never asked again', () => {
    let t = say(started(), OPENER_TEXT, OPENER);
    const asked: (string | null)[] = [promptOf(t)];
    t = say(t.session, 'it can wait', { howUrgent: one('routine') });
    expect(gates(t)).toEqual(['checkUrgency:ALLOW']);
    asked.push(promptOf(t));
    t = say(t.session, 'Saturday', { visitDay: one('saturday') });
    asked.push(promptOf(t));
    t = say(t.session, 'the morning', { timeOfDay: one('morning') });
    asked.push(promptOf(t));
    expect(heard(t)).toBe('A free visit about a leak in Riverton, on Saturday in the morning. Shall I book it?');
    t = say(t.session, 'yes, book it', YES);
    expect(asked).toEqual(['ask_howUrgent', 'ask_visitDay', 'ask_timeOfDay', 'confirm_book_visit']);
    expect(gates(t)).toEqual(['bookVisit:ALLOW']);
    expect(t.decision).toMatchObject({ kind: 'complete', form: 'book_visit', promptId: 'visit_booked', completed: ['screen_home', 'book_visit'] });
  });

  it('a refusal at the screen ends the call there: no move on, no bridge', () => {
    const t = say(started(), 'I rent a place in Ashford with a leak', { intent: one('screen_home'), problem: one('leak'), ownership: one('rent'), town: one('ashford') });
    expect(t.decision).toMatchObject({ kind: 'complete', form: 'screen_home', promptId: 'decline_renter', completed: [] });
    expect(ackIds(t)).toEqual([]);
    expect(rows(t)).toEqual(['gate', 'form_stopped', 'call_ended']);
    expect(t.session.form).toBe('screen_home');
  });

  it('the model is never asked about the booking as an intent, nor as a second request', () => {
    const p = plan(started(), speechEvent(OPENER_TEXT, true), tc());
    const criteria = (id: string): string[] => Object.keys((p.questions![id] as { criteria: Record<string, string> }).criteria);
    expect(criteria('intent')).toEqual(['screen_home', 'urgent', 'agent', 'repeat_prompt', 'done', 'other', 'none']);
    expect(criteria('secondIntent')).toEqual(['screen_home', 'urgent', 'none']);
  });

  it('the booking is the form the model is told the caller is in, by its own label', () => {
    const t = say(started(), OPENER_TEXT, OPENER);
    expect(plan(t.session, speechEvent('it can wait', true), tc()).turnState!.activeFormLabel).toBe('book your visit');
    expect(formLabel(current, 'book_visit')).toBe('book your visit');
    expect(formLabel(current, 'screen_home')).toBe('book a free visit');
  });

  it('something urgent mid-booking goes to the office: the booking is left, as any form is, and not queued', () => {
    const t0 = say(started(), OPENER_TEXT, OPENER);
    const t = say(t0.session, 'oh no, water is pouring in right now', { intent: one('urgent'), intentChange: choice({ replacing: 0.9, answering: 0.05, adding: 0.05 }), howUrgent: one('urgent') });
    expect(t.decision).toMatchObject({ kind: 'handoff', reason: 'urgent' });
    expect(t.session.queued).toEqual([]);
    expect(t.session.completed).toEqual(['screen_home']);
  });
});

describe('a request the caller queued', () => {
  beforeEach(() => use(queuing));

  it('waits until the chain is done: the booking comes first, then the queued request is bridged into', () => {
    let t = say(started(), `${OPENER_TEXT}, and something urgent too`, { ...OPENER, secondIntent: choice({ urgent: 0.9, none: 0.1 }) });
    expect(ackIds(t)).toEqual(['ack_intent_then', 'visit_qualifies', 'bridge_next']);
    expect(t.session.form).toBe('book_visit');
    expect(t.session.queued).toEqual(['urgent']);
    t = say(t.session, 'it can wait', { howUrgent: one('routine') });
    t = say(t.session, 'Saturday', { visitDay: one('saturday') });
    t = say(t.session, 'the morning', { timeOfDay: one('morning') });
    expect(t.session.queued).toEqual(['urgent']);
    t = say(t.session, 'yes, book it', YES);
    expect(gates(t)).toEqual(['bookVisit:ALLOW']);
    expect(t.decision).toMatchObject({ kind: 'handoff', reason: 'urgent', completed: ['screen_home', 'book_visit'] });
    expect(ackIds(t)).toEqual(['visit_booked', 'bridge_next']);
    expect(t.decision).toMatchObject({ acks: [{}, { promptId: 'bridge_next', vars: { intentLabel: 'get help right away' } }] });
  });
});

describe('closing a form for its next keeps what the next form also lists', () => {
  it('the value, display, confirmation and agreed value of a shared slot stay; the rest of the form goes', () => {
    const s = newSession('k', 0, VOICE_RELAY, ANONYMOUS, current.id);
    setForm(s, 'screen_home');
    Object.assign(s.slots.ownership!, { value: 'own', display: 'you own it', confirmed: true });
    Object.assign(s.slots.problem!, { value: 'leak', display: 'a leak' });
    s.agreed = { ownership: 'own', problem: 'leak' };
    closeForm(s, ['ownership']);
    expect(s.slots.ownership).toMatchObject({ value: 'own', display: 'you own it', confirmed: true });
    expect(s.slots.problem!.value).toBeNull();
    expect(s.agreed).toEqual({ ownership: 'own' });
    expect(s.form).toBeNull();
  });
});

describe('listenBeforeEntered: which slots fill before their form is open', () => {
  it('a slot only the internal booking lists is not asked of the model before it opens, and is not kept', () => {
    const p = plan(started(), speechEvent(OPENER_TEXT, true), tc());
    const asked = Object.keys(p.questions!);
    for (const slot of ['problem', 'ownership', 'town']) expect(asked).toContain(slot);
    for (const slot of ['howUrgent', 'visitDay', 'timeOfDay']) expect(asked).not.toContain(slot);
    expect(['howUrgent', 'visitDay', 'timeOfDay'].map((id) => listenOf(current, id))).toEqual(['form', 'form', 'form']);
    // A slot the screen lists as well listens up front: the screen, an intent, allows it.
    expect(listenOf(current, 'town')).toBe('up-front');
  });

  it('an intent form that says false: a value said with the request is asked again once the form is open', () => {
    use(waiting);
    const t = say(started(), OPENER_TEXT, OPENER);
    expect(t.session.form).toBe('screen_home');
    expect([t.session.slots.problem!.value, t.session.slots.ownership!.value, t.session.slots.town!.value]).toEqual([null, null, null]);
    expect(heard(t)).toBe('Sure, I can help you book a free visit. What\'s the problem with the home, a leak, a crack, or a draft?');
    expect(t.gateEvents).toEqual([]);
  });

  it('a slot\'s own listen overrides its forms: the town said with the request is kept, the rest asked', () => {
    use(townUpFront);
    const t = say(started(), OPENER_TEXT, OPENER);
    expect([t.session.slots.problem!.value, t.session.slots.ownership!.value, t.session.slots.town!.value]).toEqual([null, null, 'riverton']);
    expect(gates(t)).toEqual(['checkArea:ALLOW']);
    expect(promptOf(t)).toBe('ask_problem');
  });

  it('an app that says nothing of it listens as it did: every slot\'s listen is its own, or up-front', () => {
    for (const a of [screenedApp, testkitApp]) {
      for (const [id, spec] of Object.entries(a.slots)) {
        const factor = a.identity?.factorSlots.includes(id) === true;
        const carried = a.carrySlots?.includes(id) === true;
        expect(listenOf(a, id)).toBe(factor ? null : carried ? 'call' : (spec.listen ?? 'up-front'));
      }
    }
  });
});

describe('the forms that lead to the open one are the same task', () => {
  it('at the booking summary, "yes, and something urgent too" books, then goes on to the urgent request: the screen is not added', () => {
    const t = say(toSummary().session, 'yes, and something urgent too', { ...YES, ...SCREEN_AND_URGENT, intentChange: ADDING });
    expect(gates(t)).toEqual(['bookVisit:ALLOW']);
    expect(t.decision).toMatchObject({ kind: 'handoff', reason: 'urgent', completed: ['screen_home', 'book_visit'] });
    // Queued and bridged into on the same turn: the bridge says it, so "after this" is not said too.
    expect(ackIds(t)).toEqual(['visit_booked', 'bridge_next']);
    expect(t.decision).toMatchObject({ acks: [{}, { vars: { intentLabel: 'get help right away' } }] });
  });

  it('mid-booking, adding queues the other request, never the screen', () => {
    const t0 = say(started(), OPENER_TEXT, OPENER);
    const t = say(t0.session, 'it can wait, and something urgent as well', { ...SCREEN_AND_URGENT, intentChange: ADDING, howUrgent: one('routine') });
    expect(t.session.queued).toEqual(['urgent']);
    expect(t.session.form).toBe('book_visit');
  });

  it('mid-booking, "replacing" with the screen is no switch: the booking goes on', () => {
    const t0 = say(started(), OPENER_TEXT, OPENER);
    const t = say(t0.session, 'I want a visit about my home', { intent: one('screen_home'), intentChange: REPLACING });
    expect(t.session.form).toBe('book_visit');
    expect(t.session.completed).toEqual(['screen_home']);
    expect(t.session.slots.problem!.value).toBe('leak');
    // The words answered nothing the booking asked: its question again, as for any such turn.
    expect(promptOf(t)).toBe('ask_howUrgent_retry');
  });
});

describe('two moves on one turn', () => {
  it('screen, then a middle form already full, then the booking: a form_next row for each, one bridge', () => {
    use(middled);
    const t = say(started(), OPENER_TEXT, OPENER);
    expect(t.session.form).toBe('book_visit');
    expect(t.session.completed).toEqual(['screen_home', 'note_home']);
    expect(rows(t)).toEqual(['gate', 'gate', 'form_next', 'form_next']);
    expect(t.audit.slice(2).map((d) => d.detail)).toEqual([{ form: 'screen_home', next: 'note_home' }, { form: 'note_home', next: 'book_visit' }]);
    expect(t.movedOn!.map((m) => m.next)).toEqual(['note_home', 'book_visit']);
    expect(ackIds(t)).toEqual(['ack_intent', 'visit_qualifies', 'bridge_next']);
    expect(heard(t)).toBe('Sure, I can help you book a free visit. Good news, we work in Riverton, and the visit is free. Now, let\'s book your visit. How soon does it need looking at?');
  });
});

describe('a refusal on the booking\'s first turn', () => {
  it('drops the screen\'s "Sure, I can help" and its checksPassed as well as the bridge: only the refusal is heard', () => {
    use(ownerInBooking);
    const t = say(started(), 'I rent a place in Riverton with a leak', { intent: one('screen_home'), problem: one('leak'), ownership: one('rent'), town: one('riverton') });
    expect(gates(t)).toEqual(['checkArea:ALLOW', 'checkOwner:BLOCK:not-owner']);
    expect(t.decision).toMatchObject({ kind: 'complete', form: 'book_visit', promptId: 'decline_renter' });
    expect(ackIds(t)).toEqual([]);
    expect(rows(t)).toEqual(['gate', 'form_next', 'gate', 'form_stopped', 'call_ended']);
  });
});

describe('the earlier forms\' checks hold in the booking', () => {
  it('a town changed at the booking\'s summary runs the screen\'s area check, and its line ends the call', () => {
    const t = say(toSummary().session, 'no, it\'s in Lakeview', { ...NO, town: one('elsewhere') });
    expect(gates(t)).toEqual(['checkArea:BLOCK:out-of-area']);
    expect(t.decision).toMatchObject({ kind: 'complete', form: 'book_visit', promptId: 'decline_out_of_area' });
    expect(t.audit.find((d) => d.type === 'form_stopped')!.detail).toEqual({ form: 'book_visit', action: 'checkArea', reason: 'out-of-area', then: 'end' });
  });

  it('a carried check runs again when its value changes: "no, I rent it" at the summary', () => {
    const t = say(toSummary().session, 'no, I rent it', { ...NO, ownership: one('rent') });
    expect(gates(t)).toEqual(['checkOwner:BLOCK:not-owner']);
    expect(t.decision).toMatchObject({ kind: 'complete', promptId: 'decline_renter' });
  });

  it('the forms the booking was reached through are on the session, and only there', () => {
    const t = say(started(), OPENER_TEXT, OPENER);
    expect(t.session.reachedThrough).toEqual(['screen_home']);
    expect(started()).not.toHaveProperty('reachedThrough');
  });
});

describe('a chain resumed and on chat', () => {
  it('a session saved mid-chain goes on as the live one does', () => {
    const t0 = say(started(), OPENER_TEXT, OPENER);
    const live = say(t0.session, 'it can wait', { howUrgent: one('routine') });
    const resumed = say(jsonTrip(t0.session), 'it can wait', { howUrgent: one('routine') });
    expect(resumed.decision).toEqual(live.decision);
    expect(resumed.session).toEqual(live.session);
    expect(resumed.audit).toEqual(live.audit);
  });

  it('on a web chat the screen goes on to the booking the same way', () => {
    const s = resolve(newSession('c', 0, WEB_CHAT, ANONYMOUS, current.id), startEvent(), null, tc()).session;
    const t = resolve(s, textEvent(OPENER_TEXT), { ...PLAIN, ...OPENER }, tc());
    expect(t.session.form).toBe('book_visit');
    expect(ackIds(t)).toEqual(['ack_intent', 'visit_qualifies', 'bridge_next']);
    expect(rows(t)).toEqual(['gate', 'gate', 'form_next']);
  });
});

describe('the task in hand is the path actually taken', () => {
  it('two screeners into one booking: from the booking, the other screener is another request, to switch to', () => {
    use(twoScreens);
    const t0 = say(started(), OPENER_TEXT, OPENER);
    expect(t0.session.reachedThrough).toEqual(['screen_home']);
    const t = say(t0.session, 'actually it is a crack', { intent: one('screen_crack'), intentChange: REPLACING });
    expect(t.rows.find((r) => r.gate === 'intent')!.outcome).toBe('switch:screen_crack');
    // The crack's screen opens with the answers already held, completes, and goes on to the booking
    // again, now reached through it.
    expect(t.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_howUrgent', acks: [{ promptId: 'ack_intent', vars: { intentLabel: 'look at a crack' } }, { promptId: 'bridge_next' }] });
    expect(t.session.reachedThrough).toEqual(['screen_crack']);
    expect(t.session.completed).toEqual(['screen_home', 'screen_crack']);
  });

  it('two screeners into one booking: the other screener added mid-booking is queued', () => {
    use(twoScreens);
    const t0 = say(started(), OPENER_TEXT, OPENER);
    const t = say(t0.session, 'it can wait, and there is a crack too', { intent: choice({ screen_crack: 0.9, none: 0.1 }), intentChange: ADDING, howUrgent: one('routine') });
    expect(t.session.queued).toEqual(['screen_crack']);
    expect(t.session.form).toBe('book_visit');
  });

  it('a booking asked for directly was reached through nothing: it can switch to the screen, or queue it', () => {
    use(bookingIntent);
    const opened = say(started(), 'I want to book the visit', { intent: one('book_visit') });
    expect(opened.session.form).toBe('book_visit');
    expect(opened.session).not.toHaveProperty('reachedThrough');
    const added = say(opened.session, 'and check my home first too', { intent: choice({ screen_home: 0.9, none: 0.1 }), intentChange: ADDING });
    expect(added.session.queued).toEqual(['screen_home']);
    const switched = say(opened.session, 'actually check my home first', { intent: one('screen_home'), intentChange: REPLACING });
    expect(switched.session.form).toBe('screen_home');
  });
});
