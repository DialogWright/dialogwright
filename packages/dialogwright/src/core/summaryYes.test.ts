import { beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { runScenario } from '../harness-text/runner';
import { loadCorpus } from '../jev/corpus';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import type { AnswerMap } from '../jev/types';
import { choice, noul, score } from '../testing/answers';
import { MESSAGE_DIR, messageApp, type MessageSystems } from '../testing/message/app';
import { registerApp, resetAppsForTest } from './app/registry';
import type { Session } from './session';
import { DEFAULT_THRESHOLDS } from './thresholds';
import { appTurnContext, plan, resolve, type TurnContext, type TurnResult } from './turn';
import { mockCodeVerifier, type Tools } from './tools';
import { speechEvent } from '../channel/events';

/**
 * A yes to a form's summary is an acceptance (live findings item 28). On a live call the secretary's
 * read-back was answered "yes": the confirmation gate read it as a yes (confirmsYes 0.98, confirmsNo
 * 0.01) with no detail named (changeSlot none), but the message slot's own question read messageGiven
 * 0.60, over its bar, and the summary's correcting fill put "yes" in the message. The read-back was
 * said again ("as you said it: yes"), and the next yes delivered "yes" as the message. Here on the
 * engine's message fixture, the turn resolved by hand with the live call's answers.
 */

const TODAY = '2026-09-18';
const MESSAGE = 'please call me about the March invoice before Friday, I think we were charged twice for the same delivery';

const corpus = loadCorpus(join(MESSAGE_DIR, 'fixtures', 'corpus.jsonl'), messageApp);
const client = new FixtureStubClient(corpus, { sharpness: DEFAULT_THRESHOLDS.STUB_SHARPNESS, fallback: new HeuristicStubClient({ todayIso: TODAY, app: messageApp }), app: messageApp });

beforeEach(() => {
  resetAppsForTest();
  registerApp(messageApp);
});

/** The engine's own questions, each answered plainly, for a turn resolved by hand. */
const PLAIN: AnswerMap = {
  addressedToSystem: noul(0.95), intelligible: noul(0.95), utteranceComplete: noul(0.9), wantsHuman: noul(0.05),
  rephrasingLastTurn: noul(0.1), confusedByPrompt: noul(0.1), spokeAMenuNumber: noul(0.05),
  frustration: score({ none: 0.8, mild: 0.15, high: 0.05 }), intent: choice({ none: 0.9, other: 0.1 }),
  intentChange: choice({ answering: 0.95, adding: 0.03, replacing: 0.02 }),
};

/** The live turn's reading of "yes": a clear yes, no detail named, and the message's own question over its bar. */
const LIVE_YES: AnswerMap = { ...PLAIN, confirmsYes: noul(0.98), confirmsNo: noul(0.01), changeSlot: choice({ none: 0.96, message: 0.02, recipient: 0.01, caller: 0.005, phone: 0.005 }), messageGiven: noul(0.6), messageChanged: noul(0.1) };

/** A call taken to the read-back on the stub: the message for Dana, from Morgan Lee, with its callback number. */
async function atReadBack(): Promise<{ session: Session; tools: Tools }> {
  const tools: Tools = { ...messageApp.systems(), codes: mockCodeVerifier };
  const r = await runScenario(
    { id: 'to-read-back', steps: [{ say: 'can I leave a message for Dana' }, { say: "it's Morgan Lee" }, { say: 'five five five five five five zero one four two' }, { say: MESSAGE }], expect: { decision: 'any' } },
    { client, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, now: () => 0, tools },
  );
  const last = r.runs.at(-1)!.result;
  expect(last.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_take_message' });
  expect(last.session.pendingConfirmation).toMatchObject({ target: 'form', form: 'take_message' });
  return { session: last.session, tools };
}

const turnContext = (tools: Tools): TurnContext => appTurnContext(messageApp, { nowMs: 0, todayIso: TODAY, thresholds: { ...DEFAULT_THRESHOLDS }, tools });

function say(session: Session, tools: Tools, text: string, answers: AnswerMap): TurnResult {
  return resolve(session, speechEvent(text, true), answers, turnContext(tools));
}

const delivered = (tools: Tools) => (tools.sys as MessageSystems).messages;

describe('a yes to the summary is an acceptance (live findings item 28)', () => {
  it('the live turn: a clear yes, no detail named, the message slot reading 0.60: the form completes with the message as the caller said it', async () => {
    const { session, tools } = await atReadBack();
    const t = say(session, tools, 'yes', LIVE_YES);
    expect(t.decision).toMatchObject({ kind: 'complete', promptId: 'message_taken' });
    expect(t.gateEvents.map((e) => `${e.decision.call.tool}:${e.decision.verdict}`)).toEqual(['leaveMessage:ALLOW']);
    expect(delivered(tools)).toEqual([expect.objectContaining({ recipient: 'dana', message: MESSAGE })]);
    expect(t.session.slots.message!.value).toBe(MESSAGE);
  });

  it('a yes with a new value for another detail ("yes, but it\'s for Lee") still corrects it, and the summary is read again; the message stays', async () => {
    const { session, tools } = await atReadBack();
    const t = say(session, tools, "yes, but it's for Lee", { ...LIVE_YES, recipient: choice({ lee: 0.95, dana: 0.03, none: 0.02 }) });
    expect(t.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_take_message' });
    expect(t.session.slots.recipient!.value).toBe('lee');
    expect(t.session.slots.message!.value).toBe(MESSAGE);
    expect(delivered(tools)).toEqual([]);
  });

  it('a yes that names another detail to change ("yes, but the number\'s wrong"): that detail alone is corrected, and the message stays', async () => {
    const { session, tools } = await atReadBack();
    const t = say(session, tools, "yes, but the number's wrong", { ...LIVE_YES, changeSlot: choice({ phone: 0.9, none: 0.1 }) });
    expect(t.session.slots.message!.value).toBe(MESSAGE);
    // What the message was delivered as, here, is what the caller accepted. (That a clear yes which names a
    // detail with no new value goes on to complete, rather than reopen it, is the gates' verdict as before:
    // the confirmation gate decides a yes before changeSlot is read. Item 28 leaves it as it was.)
    expect(delivered(tools).map((m) => m.message)).not.toContain("yes, but the number's wrong");
    // And named with its new value ("yes, but it's for Lee, not Dana"): the recipient corrected, the message kept.
    const again = await atReadBack();
    const r = say(again.session, again.tools, "yes, but it's for Lee, not Dana", { ...LIVE_YES, changeSlot: choice({ recipient: 0.9, none: 0.1 }), recipient: choice({ lee: 0.95, none: 0.05 }) });
    expect(r.session.slots.recipient!.value).toBe('lee');
    expect(r.session.slots.message!.value).toBe(MESSAGE);
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_take_message' });
    expect(delivered(again.tools)).toEqual([]);
  });

  it('a no with new words for the message corrects it, as before', async () => {
    const { session, tools } = await atReadBack();
    const t = say(session, tools, 'no, tell her the boiler inspection moved', { ...PLAIN, confirmsYes: noul(0.02), confirmsNo: noul(0.95), changeSlot: choice({ none: 0.95, message: 0.05 }), messageGiven: noul(0.9) });
    expect(t.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_take_message' });
    expect(t.session.slots.message!.value).toBe('no, tell her the boiler inspection moved');
    expect(delivered(tools)).toEqual([]);
  });

  it('a yes that names the message as the detail to change (changeSlot) still corrects it, as before', async () => {
    const { session, tools } = await atReadBack();
    const t = say(session, tools, 'yes, but change the message to call me tomorrow', { ...LIVE_YES, changeSlot: choice({ message: 0.9, none: 0.1 }), messageGiven: noul(0.9) });
    expect(t.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_take_message' });
    expect(t.session.slots.message!.value).toBe('yes, but change the message to call me tomorrow');
    expect(delivered(tools)).toEqual([]);
  });
});

describe('a yes with new words for the message (the text type\'s changed question; the maintainer\'s decision, 2026-10-14)', () => {
  const MOVED = "yes but tell her it's moved to Thursday";

  it('is asked at the read-back of the summary only: the message\'s changed question goes with that request and no other', async () => {
    const { session, tools } = await atReadBack();
    const asked = plan(session, speechEvent('yes', true), turnContext(tools)).questions!;
    expect(asked.messageChanged).toMatchObject({ type: 'noul' });
    expect(asked.messageChanged!.type === 'noul' && asked.messageChanged!.instructions).toContain('add to or change the message the caller wants to leave?');
    // At the message's own question, and anywhere else on the call, it is not asked.
    const r = await runScenario(
      { id: 'to-message', steps: [{ say: 'can I leave a message for Dana' }, { say: "it's Morgan Lee" }, { say: 'five five five five five five zero one four two' }], expect: { decision: 'any' } },
      { client, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, now: () => 0, tools: { ...messageApp.systems(), codes: mockCodeVerifier } },
    );
    for (const run of r.runs) expect(Object.keys(run.record.questions ?? {})).not.toContain('messageChanged');
    expect(Object.keys(plan(r.runs.at(-1)!.result.session, speechEvent(MOVED, true), turnContext(tools)).questions!)).not.toContain('messageChanged');
  });

  it('"yes but tell her it\'s moved to Thursday", the question at 0.9: the words are added after the message, read again, then passed on with both', async () => {
    const { session, tools } = await atReadBack();
    const t = say(session, tools, MOVED, { ...LIVE_YES, messageGiven: noul(0.9), messageChanged: noul(0.9) });
    expect(t.session.slots.message!.value).toBe(`${MESSAGE}. ${MOVED}`);
    expect(t.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_take_message' });
    expect(delivered(tools)).toEqual([]);
    // The yes to the read-back with the new words passes them on.
    const yes = say(t.session, tools, 'yes', LIVE_YES);
    expect(yes.decision).toMatchObject({ kind: 'complete', promptId: 'message_taken' });
    expect(delivered(tools)).toEqual([expect.objectContaining({ message: `${MESSAGE}. ${MOVED}` })]);
  });

  it('the live "yes", the question at 0.1 and messageGiven 0.6: the message is kept and passed on', async () => {
    const { session, tools } = await atReadBack();
    const t = say(session, tools, 'yes', { ...LIVE_YES, messageGiven: noul(0.6), messageChanged: noul(0.1) });
    expect(t.decision).toMatchObject({ kind: 'complete', promptId: 'message_taken' });
    expect(delivered(tools)).toEqual([expect.objectContaining({ message: MESSAGE })]);
  });
});

describe('the changed question on the other turns of a pending summary changes nothing (live findings item 28, review fixes)', () => {
  const NO = { ...PLAIN, confirmsYes: noul(0.02), confirmsNo: noul(0.95), changeSlot: choice({ none: 0.95, message: 0.05 }) };
  /** The turn resolved twice, the message's changed question read high and low: the same turn either way. */
  function bothWays(session: Session, tools: Tools, text: string, answers: AnswerMap): TurnResult {
    const high = say(structuredClone(session), tools, text, { ...answers, messageChanged: noul(0.95) });
    const low = say(structuredClone(session), tools, text, { ...answers, messageChanged: noul(0.05) });
    expect(high.decision).toEqual(low.decision);
    expect(high.session.slots).toEqual(low.session.slots);
    expect(high.session.pendingConfirmation).toEqual(low.session.pendingConfirmation);
    return high;
  }

  it('the no after the read-back (read_back_exact said), then the no at it (ask_change asked), then the new words at ask_change', async () => {
    const { session, tools } = await atReadBack();
    const first = bothWays(session, tools, "no, that's not quite what I said", { ...NO, messageGiven: noul(0.1) });
    expect(first.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_take_message', acks: [{ promptId: 'read_back_exact' }] });
    // The question is still asked on these turns: the summary is pending.
    expect(Object.keys(plan(first.session, speechEvent('no', true), turnContext(tools)).questions!)).toContain('messageChanged');
    const second = bothWays(first.session, tools, 'no', { ...NO, messageGiven: noul(0.1) });
    expect(second.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_change' });
    expect(second.session.slots.message!.value).toBe(MESSAGE);
    const words = 'tell her the boiler inspection moved to Tuesday';
    const third = bothWays(second.session, tools, words, { ...PLAIN, confirmsYes: noul(0.1), confirmsNo: noul(0.1), changeSlot: choice({ none: 0.95, message: 0.05 }), messageGiven: noul(0.9) });
    expect(third.session.slots.message!.value).toBe(words);
  });
});
