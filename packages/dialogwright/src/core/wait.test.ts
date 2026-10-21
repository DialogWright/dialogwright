import { beforeEach, describe, expect, it } from 'vitest';
import { plan, resolve, type TurnContext, type TurnResult } from './turn';
import { newSession, type Session } from './session';
import { DEFAULT_THRESHOLDS } from './thresholds';
import { silenceEvent, speechEvent, startEvent } from '../channel/events';
import { choice, noul } from '../testing/answers';
import type { AnswerMap } from '../jev/types';
import { answerHeuristically } from '../jev/heuristicStub';
import { demoTools } from './tools';
import { VOICE_RELAY } from '../channel/caps';
import { useTestkit } from '../testing/apps';
import { registerApp } from './app/registry';
import type { App } from './app/types';
import { testkitApp } from '../testing/testkit';
import { DEFAULT_CALLER_WAIT_MS, noInputWaitOf } from '../server/adapter';
import { enginePrompts } from '../define/check';
import type { LoadedConfig } from '../define/load';

/**
 * The `wait` intent (core/app/validate.ts CONTROL_INTENTS): a caller who asks for a moment ("hold on, let
 * me grab a pen") is told to take their time (`wait_ack`), the voice line waits CALLER_WAIT_MS for them,
 * and what they say next that answers nothing (a silence, "okay, I'm ready") hears the question they were
 * on again, with no attempt counted. On the testkit, with the intent added.
 */

useTestkit();

const WAITING = 'testkit-wait';
const NO_LINE = 'testkit-wait-no-line';
const WAIT_INTENT = { criteria: 'Asks the line to wait a moment, as in hold on, give me a second, let me grab a pen', label: 'a moment', kind: 'control' as const };
const withWait = (id: string, line: boolean): App => ({
  ...testkitApp,
  id,
  intents: { ...testkitApp.intents, wait: WAIT_INTENT },
  prompts: line
    ? { ...testkitApp.prompts, manifest: { ...testkitApp.prompts.manifest, wait_ack: { text: 'Sure, take your time.', interruptible: true } } }
    : testkitApp.prompts,
});
registerApp(withWait(WAITING, true));
registerApp(withWait(NO_LINE, false));

let tc: TurnContext;
beforeEach(() => {
  tc = { nowMs: 0, todayIso: '2026-09-18', thresholds: { ...DEFAULT_THRESHOLDS }, tools: demoTools() };
});

function turn(session: Session, text: string, over: AnswerMap = {}): TurnResult {
  const questions = plan(session, speechEvent(text), tc).questions ?? {};
  const answers: AnswerMap = {};
  for (const [id, q] of Object.entries(questions)) answers[id] = answerHeuristically(id, q, text.toLowerCase(), tc.todayIso);
  return resolve(session, speechEvent(text), { ...answers, ...over }, tc);
}

/** At the account number's question, a step-up for a delivery window. */
function atAccountQuestion(app = WAITING): TurnResult {
  const started = resolve(newSession('s', 0, VOICE_RELAY, undefined, app), startEvent(), null, tc).session;
  const asked = turn(started, 'book a delivery window for tomorrow morning');
  expect(asked.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_accountId' });
  return asked;
}

const HOLD_ON: AnswerMap = { intent: choice({ wait: 0.95, none: 0.05 }) };

describe('a caller who asks for a moment', () => {
  it('is told to take their time, and the question they were on stays theirs', () => {
    const asked = atAccountQuestion();
    const held = turn(asked.session, 'hold on, let me find it', HOLD_ON);
    expect(held.decision).toEqual({ kind: 'replay', text: 'Sure, take your time.' });
    expect(held.session.takingTime).toBe(true);
    expect(held.session.promptedFor).toBe('accountId');
    expect(held.session.lastPromptId).toBe('ask_accountId');
    expect(held.session.slots.accountId!.attempts).toBe(0);
  });

  it('a silence after it hears the question again, uncounted, and the moment is over', () => {
    const held = turn(atAccountQuestion().session, 'hold on', HOLD_ON);
    const quiet = resolve(held.session, silenceEvent(), null, tc);
    expect(quiet.decision).toEqual({ kind: 'replay', text: held.session.lastPromptText });
    expect(quiet.session.takingTime).toBeUndefined();
    expect(quiet.session.slots.accountId!.attempts).toBe(0);
    expect(quiet.session.intentAttempts).toBe(0);
    // The next silence is a silence as any other: the no-input line and the question, counted.
    const again = resolve(quiet.session, silenceEvent(), null, tc);
    expect(again.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_accountId', acks: [{ promptId: 'no_input', vars: {} }] });
    expect(again.session.slots.accountId!.attempts).toBe(1);
  });

  it('"okay, I\'m ready" hears the question again, uncounted', () => {
    const held = turn(atAccountQuestion().session, 'hold on', HOLD_ON);
    const ready = turn(held.session, "okay, I'm ready");
    expect(ready.decision).toEqual({ kind: 'replay', text: held.session.lastPromptText });
    expect(ready.session.slots.accountId!.attempts).toBe(0);
    expect(ready.session.takingTime).toBeUndefined();
  });

  it('the answer, when it comes, fills as on any turn', () => {
    const held = turn(atAccountQuestion().session, 'hold on', HOLD_ON);
    const answered = turn(held.session, 'five five five zero one two three four');
    expect(answered.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_dob' });
    expect(answered.session.slots.accountId!.value).toBe('55501234');
  });

  it('an app with the intent and no wait_ack line hears the question again, as a repeat', () => {
    const asked = atAccountQuestion(NO_LINE);
    const held = turn(asked.session, 'hold on', HOLD_ON);
    expect(held.decision).toEqual({ kind: 'replay', text: asked.session.lastPromptText });
    expect(held.session.takingTime).toBeUndefined();
  });

  it('the check asks for wait_ack where an app has the wait intent, and only there', () => {
    const config = (intents: Record<string, unknown>) => ({ app: {}, intents: { intents, menu: [] }, forms: { forms: {} }, policy: { actions: {} } }) as unknown as LoadedConfig;
    expect(enginePrompts(config({ wait: WAIT_INTENT })).map((n) => n.id)).toContain('wait_ack');
    expect(enginePrompts(config({})).map((n) => n.id)).not.toContain('wait_ack');
  });
});

describe('the voice line\'s wait after it', () => {
  it('is CALLER_WAIT_MS (30 s unless set), never less than the usual wait, and nothing with the wait off', () => {
    expect(noInputWaitOf({ noInputMs: 7000 }, {})).toBe(7000);
    expect(noInputWaitOf({ noInputMs: 7000 }, { takingTime: true })).toBe(DEFAULT_CALLER_WAIT_MS);
    expect(DEFAULT_CALLER_WAIT_MS).toBe(30_000);
    expect(noInputWaitOf({ noInputMs: 7000, callerWaitMs: 45_000 }, { takingTime: true })).toBe(45_000);
    expect(noInputWaitOf({ noInputMs: 7000, callerWaitMs: 1000 }, { takingTime: true })).toBe(7000);
    expect(noInputWaitOf({ noInputMs: 0 }, { takingTime: true })).toBe(0);
  });
});
