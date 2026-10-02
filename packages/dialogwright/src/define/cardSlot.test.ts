import { describe, expect, it } from 'vitest';
import { ANONYMOUS } from '../gate/principal';
import { VOICE_RELAY } from '../channel/caps';
import { keyEvents, speechEvent, startEvent } from '../channel/events';
import { registerApp } from '../core/app/registry';
import { handoff } from '../core/decision';
import { newSession } from '../core/session';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { resolve, type TurnContext, type TurnResult } from '../core/turn';
import { mockCodeVerifier } from '../core/tools';
import { spokenText } from '../prompts/render';
import { choice, noul, score } from '../testing/answers';
import { testSlotContext as ctx } from '../testing/slots';
import type { AnswerMap } from '../jev/types';
import { cardSlot, libraryApp } from './fixture/app';

/** The library's card slot (fixture/app.ts): a value no list holds, detected, picked as a span and checked in code. */
describe('the library card slot', () => {
  const SAID = 'my card is five five five two zero four one seven';
  /** The answers to the slot's three questions: a number said, this span of it, said whole. */
  const heard = (span: string, p = 0.9, given = 0.95, complete = 0.9): AnswerMap => ({
    cardGiven: noul(given),
    cardSpan: choice({ [span]: p, none: 1 - p }),
    cardComplete: noul(complete),
  });

  it('asks whether a number is said, which span of the words it is, and whether it was said whole', () => {
    const q = cardSlot.questions(ctx(SAID));
    expect(Object.keys(q)).toEqual(['cardGiven', 'cardSpan', 'cardComplete']);
    expect(q.cardGiven!.type).toBe('noul');
    const span = q.cardSpan!;
    expect(span.type).toBe('choice');
    if (span.type === 'choice') {
      expect(Object.keys(span.criteria)).toEqual([...ctx(SAID).candidateSpans, 'none']);
      expect(span.criteria).toHaveProperty(['five five five two zero four one seven']);
    }
  });

  it('fills the span\'s digits, silently when the model is sure of the span', () => {
    expect(cardSlot.fill(heard('five five five two zero four one seven'), ctx(SAID))).toEqual({
      kind: 'filled', value: '55520417', display: '55520417', confidence: 0.9, confirm: 'none',
    });
    // digits as written are digits too
    expect(cardSlot.fill(heard('5552 0417'), ctx('it is 5552 0417'))).toMatchObject({ kind: 'filled', value: '55520417' });
  });

  it('asks to be acknowledged when the model is less sure of the span, and refuses a span it is unsure of', () => {
    const t = DEFAULT_THRESHOLDS;
    const between = (t.SLOT_CHOICE_CONFIRM + t.SLOT_CHOICE_FILL) / 2;
    expect(cardSlot.fill(heard('five five five two zero four one seven', between), ctx(SAID))).toMatchObject({ kind: 'filled', confirm: 'implicit' });
    const unsure = { ...heard('x'), cardSpan: choice({ 'five five five two zero four one seven': 0.4, 'zero four one seven': 0.35, none: 0.25 }) };
    expect(cardSlot.fill(unsure, ctx(SAID))).toEqual({ kind: 'invalid', reason: 'low_confidence', raw: '' });
  });

  it('is absent when no card number is said, so a turn about something else leaves it alone', () => {
    expect(cardSlot.fill({ cardGiven: noul(0.1), cardSpan: choice({ none: 1 }), cardComplete: noul(0.4) }, ctx('when are you open'))).toEqual({ kind: 'absent' });
    // and when the answers are not there at all
    expect(cardSlot.fill({}, ctx('when are you open'))).toEqual({ kind: 'absent' });
  });

  it('is invalid when the caller trails off or no span is the number', () => {
    expect(cardSlot.fill(heard('five five five two', 0.9, 0.95, 0.2), ctx('it is five five five two'))).toEqual({ kind: 'invalid', reason: 'incomplete', raw: '' });
    expect(cardSlot.fill({ ...heard('x'), cardSpan: choice({ none: 0.9, 'five five': 0.1 }) }, ctx('five five'))).toEqual({ kind: 'invalid', reason: 'no_span', raw: '' });
  });

  it('is invalid, with its own re-ask, when the digits are not eight', () => {
    expect(cardSlot.fill(heard('five five five two zero four one'), ctx('five five five two zero four one'))).toEqual({
      kind: 'invalid', reason: 'length', raw: '5552041', retryPromptId: 'ask_card_length',
    });
  });

  it('takes eight keypad digits, and nothing else', () => {
    expect(cardSlot.dtmf!.length).toBe(8);
    expect(cardSlot.dtmf!.parse('55520417', ctx(''))).toEqual({ value: '55520417', display: '55520417' });
    expect(cardSlot.dtmf!.parse('5552041#', ctx(''))).toBeNull();
  });
});

describe('the library card slot in a call', () => {
  registerApp(libraryApp);
  const tc: TurnContext = { nowMs: 0, todayIso: '2026-09-18', thresholds: { ...DEFAULT_THRESHOLDS }, tools: { ...libraryApp.systems(), codes: mockCodeVerifier } };
  const base: AnswerMap = {
    addressedToSystem: noul(0.95), intelligible: noul(0.95), utteranceComplete: noul(0.9), wantsHuman: noul(0.05),
    rephrasingLastTurn: noul(0.1), confusedByPrompt: noul(0.1), spokeAMenuNumber: noul(0.05),
    frustration: score({ none: 0.8, mild: 0.15, high: 0.05 }),
    intent: choice({ none: 0.9, other: 0.1 }),
    intentChange: choice({ answering: 0.95, adding: 0.03, replacing: 0.02 }),
    cardGiven: noul(0.05), cardSpan: choice({ none: 1 }), cardComplete: noul(0.4),
  };
  const say = (r: TurnResult, text: string, over: AnswerMap = {}): TurnResult => resolve(r.session, speechEvent(text), { ...base, ...over }, tc);
  const key = (r: TurnResult, digits: string): TurnResult => keyEvents(digits).reduce((at, e) => resolve(at.session, e, null, tc), r);
  const said = (r: TurnResult): string => spokenText(libraryApp, r.decision);
  const opened = (id: string): TurnResult => {
    const start = resolve(newSession(id, 0, VOICE_RELAY, ANONYMOUS, libraryApp.id), startEvent(), null, tc);
    return say(start, 'what do I have checked out', { intent: choice({ check_loans: 0.95, none: 0.05 }) });
  };

  it('asks for the card, hears it, and says what is due back next; the tool\'s param is recorded by its last four', () => {
    const asked = opened('library-card');
    expect(said(asked)).toBe("Sure, I can help you check your loans. What's your library card number?");
    const answered = say(asked, 'five five five two zero four one seven', {
      cardGiven: noul(0.95), cardSpan: choice({ 'five five five two zero four one seven': 0.9, none: 0.1 }), cardComplete: noul(0.9),
    });
    expect(said(answered)).toBe('On card 55520417, A Quiet Orchard is due back next, on Friday, September 25. Is there anything else I can help with?');
    expect(answered.gateEvents.map((e) => `${e.decision.call.tool}:${e.decision.verdict}`)).toEqual(['listLoans:ALLOW']);
    expect(answered.gateEvents[0]!.decision.call.params).toEqual({ card: '...0417' });
    // The form is done, so its slot is emptied (it is not one of app.yaml's carrySlots).
    expect(answered.session.slots.card!.value).toBeNull();
  });

  it('is handed over by its last four when the call goes to a person', () => {
    const session = structuredClone(opened('library-card-handoff').session);
    Object.assign(session.slots.card!, { value: '55520417', display: '55520417' });
    expect(handoff(session, 'live-agent').slots).toEqual({ card: '...0417' });
  });

  it('acknowledges a card the model is less sure of before it answers', () => {
    const answered = say(opened('library-card-ack'), 'five five five three one two nine zero', {
      cardGiven: noul(0.95), cardSpan: choice({ 'five five five three one two nine zero': 0.5, none: 0.5 }), cardComplete: noul(0.9),
    });
    expect(said(answered)).toBe("That's card 55531290. There is nothing checked out on card 55531290. Is there anything else I can help with?");
  });

  it('says why at the first miss of length, goes to the keypad at the second miss, and takes the keyed digits', () => {
    const short = say(opened('library-card-keypad'), 'five five five two zero four one', {
      cardGiven: noul(0.95), cardSpan: choice({ 'five five five two zero four one': 0.9, none: 0.1 }), cardComplete: noul(0.9),
    });
    expect(said(short)).toBe('A library card number has eight digits. Please say all eight, one at a time.');
    const missed = say(short, 'um, hang on');
    expect(said(missed)).toBe('Please enter your eight digit library card number on the keypad.');
    const keyed = key(missed, '55529999');
    expect(said(keyed)).toBe("I can't find library card 55529999. Is there anything else I can help with?");
    expect(keyed.gateEvents.map((e) => e.decision.call.params)).toEqual([{ card: '...9999' }]);
  });
});
