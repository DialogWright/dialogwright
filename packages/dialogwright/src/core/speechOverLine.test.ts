import { beforeEach, describe, expect, it } from 'vitest';
import { resolve, type TurnContext, type TurnResult } from './turn';
import { newSession, type Session } from './session';
import { DEFAULT_THRESHOLDS } from './thresholds';
import { speechEvent, startEvent, type UserSpeech } from '../channel/events';
import { choice, noul, score } from '../testing/answers';
import type { AnswerMap } from '../jev/types';
import { demoTools } from './tools';
import { VOICE_RELAY } from '../channel/caps';
import { registerApp, resetAppsForTest } from './app/registry';
import { registerTestkit } from '../testing/testkit';
import { ANONYMOUS } from '../gate/principal';
import { PLACE_APP_ID, placeApp } from '../testing/placeApp';

/**
 * Speech over a line the caller could not interrupt (UserSpeech.overLine, SPEECH_OVER_LINE=unless-miss): a
 * turn on it that would be a miss is set aside as side speech is (core/turn.ts overLineMiss), at every
 * question and every rung; one that answers is acted on. The place app: one form asking where a problem is.
 */

beforeEach(() => {
  resetAppsForTest();
  registerApp(placeApp());
  registerTestkit();
});

const tc = (): TurnContext => ({ nowMs: 0, todayIso: '2026-11-05', thresholds: { ...DEFAULT_THRESHOLDS }, tools: demoTools() });

function answers(over: AnswerMap = {}): AnswerMap {
  return {
    addressedToSystem: noul(0.95), intelligible: noul(0.95), utteranceComplete: noul(0.9), wantsHuman: noul(0.05),
    rephrasingLastTurn: noul(0.05), confusedByPrompt: noul(0.05), spokeAMenuNumber: noul(0.02),
    frustration: score({ none: 0.9, mild: 0.08, high: 0.02 }),
    intent: choice({ none: 0.9, other: 0.1 }),
    intentChange: choice({ answering: 0.95, adding: 0.03, replacing: 0.02 }),
    confirmsYes: noul(0.02), confirmsNo: noul(0.02),
    ...over,
  };
}

const REPORT: AnswerMap = { intent: choice({ report: 0.95, none: 0.05 }) };

function started(): Session {
  return resolve(newSession('s', 0, VOICE_RELAY, ANONYMOUS, PLACE_APP_ID), startEvent(), null, tc()).session;
}

/** Words over a line (`over`), or not, with the model's answers. */
function say(session: Session, text: string, over: boolean, a: AnswerMap = {}): TurnResult {
  const event: UserSpeech = over ? { ...speechEvent(text), overLine: true } : speechEvent(text);
  return resolve(session, event, answers(a), tc());
}

/** Set aside: nothing said, the session exactly as it was, the gate row that says why. */
function expectSetAside(r: TurnResult, before: Session): void {
  expect(r.decision).toEqual({ kind: 'ignore' });
  expect(r.actions).toEqual([]);
  expect(r.setAside).toBe('speech-over-line');
  expect(r.session).toEqual(before);
  expect(r.rows.filter((g) => g.decided)).toEqual([{ gate: 'speechOverLine', value: null, threshold: null, passed: false, outcome: 'set_aside', decided: true }]);
  expect(r.gateEvents).toEqual([]);
  expect(r.effects).toEqual([]);
}

const promptOf = (r: TurnResult): string | null => (r.decision.kind === 'prompt' ? r.decision.promptId : null);

describe('speech over a line that would be a miss is set aside', () => {
  it('at the open question: no no-match line, no attempt', () => {
    const s = started();
    expectSetAside(say(s, "i'd like a custom scheduling system okay", true), s);
    // The same words not over a line: the miss it always was.
    const taken = say(s, "i'd like a custom scheduling system okay", false);
    expect(promptOf(taken)).toBe('nomatch_open');
    expect(taken.session.intentAttempts).toBe(1);
  });

  it('words not made out (intelligible under its bar) at the open question', () => {
    const s = started();
    expectSetAside(say(s, 'mmhm rr', true, { intelligible: noul(0.1) }), s);
  });

  it('at the keypad rung: the second miss is not offered the keypad', () => {
    const one = say(started(), 'blah', false).session;
    expect(one.intentAttempts).toBe(1);
    expectSetAside(say(one, 'oh sorry', true), one);
    expect(promptOf(say(one, 'oh sorry', false))).toBe('nomatch_dtmf_menu');
  });

  it('a third over-line miss after two real misses: no one is put through', () => {
    const one = say(started(), 'blah', false).session;
    const two = say(one, 'oh sorry', false);
    expect(promptOf(two)).toBe('nomatch_dtmf_menu');
    expectSetAside(say(two.session, 'i see', true), two.session);
    const taken = say(two.session, 'i see', false);
    expect(taken.decision).toMatchObject({ kind: 'handoff', reason: 'max-attempts' });
  });

  it("at a slot's question: words that give the slot nothing are not re-asked", () => {
    const asked = say(started(), 'i want to report a problem', false, REPORT).session;
    expect(asked.promptedFor).toBe('place');
    expectSetAside(say(asked, 'at', true), asked);
    const taken = say(asked, 'at', false);
    expect(promptOf(taken)).toBe('ask_place_retry');
    expect(taken.session.slots.place?.attempts).toBe(1);
  });

  it('at the summary: words that answer it neither way are not counted', () => {
    const asked = say(started(), 'i want to report a problem', false, REPORT).session;
    const summary = say(asked, '22 Alder Street', false);
    expect(promptOf(summary)).toBe('confirm_report');
    expectSetAside(say(summary.session, 'hang on a sec dave', true), summary.session);
    const taken = say(summary.session, 'hang on a sec dave', false);
    expect(taken.session.pendingConfirmation).toMatchObject({ target: 'form', attempts: 1 });
  });
});

describe('speech over a line that answers is acted on', () => {
  it('a request at the open question', () => {
    const r = say(started(), 'i want to report a problem', true, REPORT);
    expect(r.setAside).toBeUndefined();
    expect(r.session.form).toBe('report');
    expect(promptOf(r)).toBe('ask_place');
  });

  it("a value at a slot's question", () => {
    const asked = say(started(), 'i want to report a problem', false, REPORT).session;
    const r = say(asked, '22 Alder Street', true);
    expect(r.setAside).toBeUndefined();
    expect(r.session.slots.place?.value).toBe('22 Alder Street');
  });

  it('a yes at the summary', () => {
    const asked = say(started(), 'i want to report a problem', false, REPORT).session;
    const summary = say(asked, '22 Alder Street', false).session;
    const r = say(summary, 'yes', true, { confirmsYes: noul(0.95) });
    expect(r.setAside).toBeUndefined();
    expect(r.session.completed).toEqual(['report']);
  });

  it('a request for a person', () => {
    const r = say(started(), 'agent please', true, { wantsHuman: noul(0.95) });
    expect(r.setAside).toBeUndefined();
    expect(r.decision).toMatchObject({ kind: 'handoff', reason: 'live-agent' });
  });

  it('a request to hear it again', () => {
    const r = say(started(), 'can you say that again', true, { intent: choice({ repeat_prompt: 0.95, none: 0.05 }) });
    expect(r.setAside).toBeUndefined();
    expect(r.decision.kind).toBe('replay');
  });

  it('side speech is side speech, as before: its own row decides', () => {
    const r = say(started(), 'honey grab my coat', true, { addressedToSystem: noul(0.1) });
    expect(r.decision.kind).toBe('ignore');
    expect(r.setAside).toBeUndefined();
    expect(r.rows.find((g) => g.decided)?.gate).toBe('addressedToSystem');
  });
});
