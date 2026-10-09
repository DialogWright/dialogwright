import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { choice, noul, score } from '../testing/answers';
import { registerApp, resetAppsForTest } from './app/registry';
import type { App } from './app/types';
import { listenOf } from './app/lookup';
import { formLabel } from './app/intents';
import { DEFAULT_THRESHOLDS } from './thresholds';
import { closeForm, newSession, setForm, type Session } from './session';
import { plan, resolve, type TurnContext, type TurnResult } from './turn';
import { speechEvent, startEvent } from '../channel/events';
import { VOICE_RELAY } from '../channel/caps';
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
    // The booking lists the ownership check too: its pass carried, so the gate is not asked again.
    expect(Object.keys(t.session.checked ?? {})).toEqual(['checkOwner']);
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
