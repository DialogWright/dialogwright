import { beforeEach, describe, expect, it } from 'vitest';
import { plan, resolve, type TurnContext, type TurnResult } from './turn';
import { newSession, type Session } from './session';
import { DEFAULT_THRESHOLDS } from './thresholds';
import { speechEvent, startEvent } from '../channel/events';
import { VOICE_RELAY } from '../channel/caps';
import { choice, noul, score } from '../testing/answers';
import type { AnswerMap } from '../jev/types';
import { localePromptEntry, promptText, spokenText, wordingsOf } from '../prompts/render';
import { lineOf, segmentsOf, wordingId } from '../prompts/segments';
import { demoTools } from './tools';
import { useTestkit } from '../testing/apps';
import { registerApp } from './app/registry';
import type { App } from './app/types';
import { validateApp } from './app/validate';
import { testkitApp } from '../testing/testkit';

/**
 * The acknowledgement a request starts with (ack_intent): said again for a request made again unless
 * the app skips it (app.yaml's ackIntent.repeat), and said in its other wordings in turn (prompts.yaml's
 * variants): the maintainer's decision after a live call, 2026-10-17, where three coverage questions
 * each heard "Sure, I can help you check coverage." first.
 */
useTestkit();

function context(): TurnContext {
  return { nowMs: 0, todayIso: '2026-09-18', thresholds: { ...DEFAULT_THRESHOLDS }, tools: demoTools() };
}
let tc: TurnContext = context();
beforeEach(() => {
  tc = context();
});

const WORDINGS = ['Happy to help you {intentLabel}.', "Of course, let's {intentLabel}."] as const;
const ACK = testkitApp.prompts.manifest.ack_intent!;
const withVariants = (variants: readonly string[] = WORDINGS): App['prompts'] => ({ ...testkitApp.prompts, manifest: { ...testkitApp.prompts.manifest, ack_intent: { ...ACK, variants } } });

const SAY_APP = 'testkit-ack-say';
const SKIP_APP = 'testkit-ack-skip';
const ROTATE_APP = 'testkit-ack-rotate';
const BOTH_APP = 'testkit-ack-both';
registerApp({ ...testkitApp, id: SAY_APP });
registerApp({ ...testkitApp, id: SKIP_APP, ackIntent: { repeat: 'skip' } });
registerApp({ ...testkitApp, id: ROTATE_APP, prompts: withVariants() });
registerApp({ ...testkitApp, id: BOTH_APP, ackIntent: { repeat: 'skip' }, prompts: withVariants() });

function answers(over: AnswerMap = {}): AnswerMap {
  return {
    addressedToSystem: noul(0.95), intelligible: noul(0.95), utteranceComplete: noul(0.9), wantsHuman: noul(0.05),
    rephrasingLastTurn: noul(0.1), confusedByPrompt: noul(0.1), spokeAMenuNumber: noul(0.05),
    frustration: score({ none: 0.8, mild: 0.15, high: 0.05 }),
    intent: choice({ none: 0.9, other: 0.1 }),
    containsAccountId: noul(0.05), dobGiven: noul(0.05),
    deliveryPart: choice({ none: 0.95, morning: 0.05 }), expectedDateMode: choice({ none: 0.95, weekday: 0.05 }),
    describesParcel: noul(0.05),
    ...over,
  };
}
const intent = (i: string) => choice({ [i]: 0.95, none: 0.05 });
const REPLACING = choice({ replacing: 0.9, answering: 0.05, adding: 0.05 });

function started(app: string): Session {
  return resolve(newSession('s', 0, VOICE_RELAY, undefined, app), startEvent(), null, tc).session;
}

function say(session: Session, text: string, over: AnswerMap): TurnResult {
  const event = speechEvent(text);
  expect(plan(session, event, tc).needsModel).toBe(true);
  return resolve(session, event, answers(over), tc);
}

/** Three requests in turn, each replacing the one before: a parcel tracked, a missing one reported, then the tracking again. */
function threeRequests(app: string): TurnResult[] {
  const one = say(started(app), 'where is my parcel', { intent: intent('track_parcel') });
  const two = say(one.session, 'actually i want to report a missing parcel', { intent: intent('report_missing'), intentChange: REPLACING });
  const three = say(two.session, 'no, track my parcel after all', { intent: intent('track_parcel'), intentChange: REPLACING });
  return [one, two, three];
}
const ackIds = (r: TurnResult): string[] => (r.decision.kind === 'prompt' ? r.decision.acks.map((a) => a.promptId) : []);

describe('the acknowledgement of a request (ack_intent)', () => {
  it('is said every time in one wording by default, and the session keeps nothing for it', () => {
    const [one, two, three] = threeRequests(SAY_APP);
    expect(one!.session.form).toBe('track_parcel');
    expect(two!.session.form).toBe('report_missing');
    expect(three!.session.form).toBe('track_parcel');
    for (const r of [one!, two!, three!]) expect(ackIds(r)).toEqual(['ack_intent']);
    expect(three!.session.acknowledged).toBeUndefined();
    expect(three!.session.ackIntentSaid).toBeUndefined();
  });

  it('is not said for a request made again where the app skips it (ackIntent.repeat: skip): the form\'s question comes straight', () => {
    const [one, two, three] = threeRequests(SKIP_APP);
    expect(ackIds(one!)).toEqual(['ack_intent']);
    expect(ackIds(two!)).toEqual(['ack_intent']);
    expect(three!.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_accountId', acks: [] });
    expect(three!.session.acknowledged).toEqual(['track_parcel', 'report_missing']);
    expect(spokenText(testkitApp, three!.decision)).toBe(promptText(testkitApp, 'ask_accountId', {}));
  });

  it('is said in its other wordings in turn (prompts.yaml variants), by how many times the call has said it, and back to the first', () => {
    const [one, two, three] = threeRequests(ROTATE_APP);
    expect([one!, two!, three!].map(ackIds)).toEqual([['ack_intent'], ['ack_intent.v2'], ['ack_intent.v3']]);
    expect(three!.session.ackIntentSaid).toBe(3);
    const app = { ...testkitApp, prompts: withVariants() };
    expect(spokenText(app, two!.decision)).toMatch(/^Happy to help you report a missing parcel\. /);
    expect(spokenText(app, three!.decision)).toMatch(/^Of course, let's track a parcel\. /);
    const four = say(three!.session, 'actually report a missing parcel', { intent: intent('report_missing'), intentChange: REPLACING });
    expect(ackIds(four)).toEqual(['ack_intent']);
  });

  it('with both, rotates over the requests acknowledged and skips the one made again without using up a wording', () => {
    const [one, two, three] = threeRequests(BOTH_APP);
    expect([one!, two!, three!].map(ackIds)).toEqual([['ack_intent'], ['ack_intent.v2'], []]);
    expect(three!.session.ackIntentSaid).toBe(2);
  });

  it('is the same on a replay of the same turns (never at random)', () => {
    const a = threeRequests(ROTATE_APP).map(ackIds);
    const b = threeRequests(ROTATE_APP).map(ackIds);
    expect(a).toEqual(b);
  });
});

describe('a line\'s wordings (prompts.yaml variants)', () => {
  const app: App = { ...testkitApp, prompts: withVariants() };

  it('names each wording past the first by its line and number, and back', () => {
    expect(wordingId('ack_intent', 1)).toBe('ack_intent');
    expect(wordingId('ack_intent', 3)).toBe('ack_intent.v3');
    expect(lineOf('ack_intent.v3')).toBe('ack_intent');
    expect(lineOf('ack_intent')).toBe('ack_intent');
    expect(lineOf('ack_intent.exact')).toBe('ack_intent.exact');
  });

  it('says a wording as its own text, with the line\'s barge-in, and gives each its own clips', () => {
    expect(wordingsOf(app, 'ack_intent')).toBe(3);
    expect(wordingsOf(testkitApp, 'ack_intent')).toBe(1);
    expect(localePromptEntry(app, 'ack_intent.v2').entry).toEqual({ text: WORDINGS[0], interruptible: ACK.interruptible });
    expect(promptText(app, 'ack_intent.v3', { intentLabel: 'track a parcel' })).toBe("Of course, let's track a parcel.");
    const segments = segmentsOf(app.prompts.manifest) as Record<string, unknown>;
    expect(segments['ack_intent.v2']).toEqual([{ kind: 'fixed', id: 'ack_intent.v2.0', text: 'Happy to help you' }, { kind: 'var', name: 'intentLabel' }, { kind: 'fixed', id: 'ack_intent.v2.1', text: '.' }]);
  });

  it('says a locale\'s own wordings, and its text where it gives fewer than the wording asked for', () => {
    const es: App = { ...app, locales: { default: 'en-US', prompts: { es: { ack_intent: { text: 'Claro, puedo ayudarle a {intentLabel}.', interruptible: false } } } } };
    expect(wordingsOf(es, 'ack_intent', 'es')).toBe(1);
    expect(promptText(es, 'ack_intent.v2', { intentLabel: 'rastrear un paquete' }, 'es')).toBe('Claro, puedo ayudarle a rastrear un paquete.');
    // A locale that leaves the line out says the default's, its wordings included.
    const none: App = { ...app, locales: { default: 'en-US', prompts: { es: {} } } };
    expect(wordingsOf(none, 'ack_intent', 'es')).toBe(3);
  });

  it('is refused by validateApp on another line, with other variables, or on a generated line, and an unknown repeat', () => {
    const line = (id: string, variants: readonly string[]): App => ({ ...testkitApp, prompts: { ...testkitApp.prompts, manifest: { ...testkitApp.prompts.manifest, [id]: { ...testkitApp.prompts.manifest[id]!, variants } } } });
    expect(() => validateApp(app)).not.toThrow();
    expect(() => validateApp(line('anything_else', ['Anything more?']))).toThrow('the line "anything_else" has variants, which only ack_intent may have');
    expect(() => validateApp(line('ack_intent', ['Happy to help.']))).toThrow('the line "ack_intent" has the variant "Happy to help.", whose variables are not its text\'s');
    expect(() => validateApp(line('ack_intent', []))).toThrow('the line "ack_intent" has an empty list of variants');
    expect(() => validateApp({ ...testkitApp, ackIntent: { repeat: 'never' as never } })).toThrow('ackIntent.repeat "never" is not "say" or "skip"');
  });
});
