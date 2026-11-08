import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { fakeAgent } from '../agent/fake';
import type { AgentAnswer } from '../agent/types';
import { VOICE_RELAY } from '../channel/caps';
import { speechEvent, startEvent, withCallerNumber, type SessionEvent } from '../channel/events';
import { BUSINESS_FIXTURE_DIR, businessFixtureCode } from '../define/__fixtures__/business/app';
import { defineApp } from '../define/defineApp';
import { ANONYMOUS } from '../gate/principal';
import { noulAnswer } from '../jev/distributions';
import { HeuristicStubClient } from '../jev/heuristicStub';
import type { JevClient, JevRequest, JevResponse } from '../jev/types';
import { runTurn, type TurnRun } from '../run/turn';
import type { App, ToolDef } from './app/types';
import { registerApp, resetAppsForTest } from './app/registry';
import { DEFAULT_THRESHOLDS } from './thresholds';
import { mockCodeVerifier } from './tools';
import { newSession, type Session } from './session';

/**
 * A choice of yes and no the line has just asked, in agent mode (core/agentTurn.ts yesNoRead; the agent-mode
 * design's call 49): the decision model is asked its yes or no that turn, as at a read-back, and a clear
 * reading fills the field, ahead of the agent's own value for it. A live call: "Yeah. That's fine." at the
 * consent question, the agent proposing `submit` and giving no value, and the question asked again. The
 * fixture library with a consent field (`textOk`) on its hold, as define/businessWhen.test.ts builds it.
 * No model is called.
 */

const TODAY = '2026-11-09'; // a Monday
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const BASE = parse(readFileSync(join(BUSINESS_FIXTURE_DIR, 'business.yaml'), 'utf8')) as Record<string, any>;

function consentApp(): App {
  const dir = mkdtempSync(join(tmpdir(), 'agent-yes-no-'));
  dirs.push(dir);
  cpSync(BUSINESS_FIXTURE_DIR, dir, { recursive: true });
  const b = structuredClone(BASE);
  b.request.fields.push({
    name: 'textOk', type: 'choice', options: ['yes', 'no'], question: 'Is it OK if we text you at that number?',
    says: { yes: { readBack: "and we'll text you at", done: "We'll text you when it's ready." }, no: { readBack: "and we'll call you at", done: "We'll call you when it's ready." } },
  });
  b.request.readBack = "Here's the hold: {patronName}, {copies} of {title} {format}, collected {day} in the {window}, {textOk} {callbackNumber}. Is that right?";
  b.request.done = 'Thanks, {patronName}. {textOk}';
  b.request.then = ['placeHold', { tool: 'notifyDesk', when: { field: 'textOk', is: 'yes', reason: 'no-consent' } }];
  writeFileSync(join(dir, 'business.yaml'), stringify(b));
  const params = ['patronName', 'title', 'copies', 'format', 'day', 'window', 'callbackNumber', 'textOk'];
  const tools: Record<string, ToolDef> = {
    ...businessFixtureCode.tools,
    placeHold: { ...businessFixtureCode.tools.placeHold!, params },
    notifyDesk: { ...businessFixtureCode.tools.notifyDesk!, params },
  };
  return defineApp(dir, { ...businessFixtureCode, tools }, { codeFile: 'app.ts' });
}

let app: App;
beforeAll(() => {
  resetAppsForTest();
  app = consentApp();
  registerApp(app);
});

/** The decision model: the heuristic stub, the request read by keyword, and the yes or no by the readings `yesNo` gives for the words. */
function jev(yesNo: Record<string, [number, number]>): JevClient & { asked: JevRequest[] } {
  const asked: JevRequest[] = [];
  return {
    asked,
    async ask(req: JevRequest): Promise<JevResponse> {
      asked.push(req);
      const stub = new HeuristicStubClient({ todayIso: TODAY, app });
      const r = await stub.ask(req);
      const text = (req.state as { asr?: { text?: string } }).asr?.text ?? '';
      const answers = { ...r.answers };
      const reading = yesNo[text];
      if (reading !== undefined && req.questions.confirmsYes !== undefined) {
        answers.confirmsYes = noulAnswer(reading[0]);
        answers.confirmsNo = noulAnswer(reading[1]);
      }
      return { ...r, answers };
    },
  };
}

const said = (reply: string, values: [string, string, string][] = [], action = 'none'): AgentAnswer => ({
  reply, values: values.map(([field, value, words]) => ({ field, value, words })), action, fromFacts: false,
});

const HOLD = 'I would like to place a hold on The Quiet Harbor';
const DETAILS = 'Avery Lane, two copies in regular print, Thursday morning, and call me at 555 555 0144';
const SCRIPT: Record<string, AgentAnswer> = {
  [HOLD]: said('Happy to help with that. What name is it under?', [['title', 'The Quiet Harbor', 'The Quiet Harbor']]),
  [DETAILS]: said('Thanks, Avery.', [
    ['patronName', 'Avery Lane', 'Avery Lane'],
    ['copies', 'two', 'two copies'],
    ['format', 'print', 'regular print'],
    ['day', '2026-11-12', 'Thursday'],
    ['window', 'morning', 'morning'],
    ['callbackNumber', '5555550144', '555 555 0144'],
  ]),
};

/** A call to the consent question, then `words` answered by `answer` and read by `reading` (yes, no). */
async function atConsent(words: string, answer: AgentAnswer, reading: [number, number]): Promise<{ asked: TurnRun; last: TurnRun; jevAsked: JevRequest[] }> {
  const tools = { ...app.systems(), codes: mockCodeVerifier };
  const j = jev({ [words]: reading });
  const script = { ...SCRIPT, [words]: answer };
  const agent = fakeAgent((ctx) => {
    const heard = ctx.conversation.at(-1)!.text;
    const out = script[heard];
    if (out === undefined) throw new Error(`no answer scripted for "${heard}"`);
    return out;
  });
  const opts = { client: j, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, now: () => 0, tools, agent: { client: agent } };
  let session: Session = newSession('S-yes-no', 0, VOICE_RELAY, ANONYMOUS, app.id);
  const runs: TurnRun[] = [];
  const run = async (event: SessionEvent): Promise<void> => {
    const r = await runTurn(session, event, opts);
    runs.push(r);
    session = r.result.session;
  };
  await run(withCallerNumber(startEvent(), '+15555550199'));
  for (const text of [HOLD, DETAILS, words]) await run(speechEvent(text));
  return { asked: runs.at(-2)!, last: runs.at(-1)!, jevAsked: j.asked };
}

const promptOf = (r: TurnRun): string | undefined => ('promptId' in r.result.decision ? r.result.decision.promptId : undefined);

describe('a choice of yes and no the line has just asked, in agent mode (call 49)', () => {
  it('"Yeah. That\'s fine." with an answer that leaves the field out: the decision model\'s yes fills it, and the read-back is said', async () => {
    const c = await atConsent("Yeah. That's fine.", said('Great, let me read that back.', [], 'submit'), [0.95, 0.02]);
    expect(promptOf(c.asked)).toBe('ask_request_textOk');
    // The yes or no was asked on that turn only.
    expect(Object.keys(c.jevAsked.at(-1)!.questions)).toEqual(expect.arrayContaining(['confirmsYes', 'confirmsNo']));
    expect(Object.keys(c.jevAsked.at(-2)!.questions)).not.toContain('confirmsYes');
    expect(c.last.result.session.slots.request_textOk).toMatchObject({ value: 'yes', by: 'decision-model', confirmed: false });
    expect(promptOf(c.last)).toBe('readback_request');
    expect(c.last.record.agent).toMatchObject({ yesNo: { field: 'textOk', option: 'yes', yes: 0.95, no: 0.02, at: DEFAULT_THRESHOLDS.CONFIRM_YES } });
    expect(c.last.record.agent!.values).toContainEqual(expect.objectContaining({ field: 'textOk', value: 'yes', outcome: 'accepted', by: 'decision-model' }));
  });

  it('a clear no fills no, ahead of the agent\'s own yes (its reply, written with it, not said)', async () => {
    const c = await atConsent('No, please just call me.', said('Great, we will text you.', [['textOk', 'yes', 'please just call me']]), [0.03, 0.93]);
    expect(c.last.result.session.slots.request_textOk).toMatchObject({ value: 'no', by: 'decision-model' });
    expect(c.last.record.agent!.values.filter((v) => v.field === 'textOk')).toEqual([expect.objectContaining({ value: 'no', by: 'decision-model' })]);
    expect(promptOf(c.last)).toBe('readback_request');
  });

  it('an unclear reading leaves it to the agent: its value where it gave one, the question again where it gave none', async () => {
    const given = await atConsent('I guess so, sure', said('Okay.', [['textOk', 'yes', 'I guess so, sure']]), [0.5, 0.2]);
    expect(given.last.result.session.slots.request_textOk).toMatchObject({ value: 'yes', by: 'agent' });
    expect(given.last.record.agent!.yesNo).toBeUndefined();
    const none = await atConsent('hmm, what was that', said('Sorry, is it OK if we text you?'), [0.1, 0.1]);
    expect(none.last.result.session.slots.request_textOk!.value).toBeNull();
    expect(promptOf(none.last)).toBe('ask_request_textOk');
  });
});
