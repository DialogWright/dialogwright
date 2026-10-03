import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { VOICE_RELAY, WEB_CHAT } from '../channel/caps';
import { keyEvents, signedInEvent, speechEvent, startEvent } from '../channel/events';
import { defineIdentity, definePolicy } from '../define/definePolicy';
import type { AnswerMap } from '../jev/types';
import { choice, noul, score } from '../testing/answers';
import { useTestkit } from '../testing/apps';
import { testkitApp } from '../testing/testkit';
import { CUSTOMERS } from '../testing/testkit/domain/data';
import { accountIdOf } from '../testing/testkit/domain/forms';
import { TESTKIT_CUSTOM_RULES } from '../testing/testkit/domain/policy';
import { customerPrincipal } from '../testing/testkit/domain/principals';
import { SLOTS } from '../testing/testkit/domain/slots';
import { TESTKIT_TOOLS } from '../testing/testkit/domain/tools';
import manifest from '../testing/testkit/prompts/manifest.json';
import { codeLengthOf, hasCode } from './app/lookup';
import { registerApp } from './app/registry';
import type { App } from './app/types';
import { validateApp } from './app/validate';
import { newSession, type Session } from './session';
import { maskCodeEvent } from './spokenCode';
import { DEFAULT_THRESHOLDS } from './thresholds';
import { demoTools } from './tools';
import { resolve, type TurnContext, type TurnResult } from './turn';

/**
 * The identity ladder as identity.yaml writes it, run end to end on copies of the testkit: a one-time
 * code of 4 and of 8 digits (keyed to its length, checked, said aloud and reissued), and a ladder of
 * one rung (no code: a full verify ends at level 1, and nothing sends a code). Each copy is compiled
 * from the testkit's own policy.yaml and identity.yaml, edited as an author would edit them.
 */
useTestkit();

type Yaml = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const TESTKIT = (file: string): Yaml => parse(readFileSync(fileURLToPath(new URL(`../testing/testkit/${file}`, import.meta.url)), 'utf8')) as Yaml;

/** A copy of the testkit, its files edited, registered under `id`. */
function variant(id: string, edit: { identity?(file: Yaml): void; policy?(file: Yaml): void; dropTools?: readonly string[] }): App {
  const identityFile = TESTKIT('identity.yaml');
  const policyFile = TESTKIT('policy.yaml');
  edit.identity?.(identityFile);
  edit.policy?.(policyFile);
  const tools = Object.fromEntries(Object.entries(TESTKIT_TOOLS).filter(([tool]) => !(edit.dropTools ?? []).includes(tool)));
  const policy = definePolicy(policyFile, { identity: identityFile, tools, slots: SLOTS, customRules: TESTKIT_CUSTOM_RULES });
  const identity = defineIdentity(identityFile, { policy: policyFile, tools, slots: SLOTS, prompts: manifest, sendCodeParams: (s) => ({ accountId: accountIdOf(s) }) });
  const { gate: _, ...rest } = testkitApp;
  const app: App = { ...rest, id, identity, policy, tools };
  registerApp(app);
  return app;
}

const codeOf = (length: number) => (file: Yaml): void => {
  file.levels[2].factors = [{ otp: { length } }];
};

const FOUR = variant('testkit-code4', { identity: codeOf(4) });
const EIGHT = variant('testkit-code8', { identity: codeOf(8) });
/** No level 2: no code tools, every action at level 1 or below, and a sign-in that proves level 1. */
const ONE_RUNG = variant('testkit-one-rung', {
  identity: (file) => {
    delete file.levels[2];
    file.signIn = { level: 1 };
  },
  policy: (file) => {
    delete file.actions.verifyCode;
    delete file.actions.sendCode;
    for (const action of Object.values(file.actions) as Yaml[]) if (action.level === 2) action.level = 1;
    file.purposes.report_missing.level = 1;
  },
  dropTools: ['verifyCode', 'sendCode'],
});

function context(): TurnContext {
  return { nowMs: 0, todayIso: '2026-09-18', thresholds: { ...DEFAULT_THRESHOLDS }, tools: demoTools() };
}
let tc: TurnContext = context();
beforeEach(() => {
  tc = context();
});

function answers(over: AnswerMap = {}): AnswerMap {
  return {
    addressedToSystem: noul(0.95), intelligible: noul(0.95), utteranceComplete: noul(0.9), wantsHuman: noul(0.05),
    rephrasingLastTurn: noul(0.1), confusedByPrompt: noul(0.1), spokeAMenuNumber: noul(0.05),
    frustration: score({ none: 0.8, mild: 0.15, high: 0.05 }),
    intent: choice({ none: 0.9, other: 0.1 }),
    containsAccountId: noul(0.05), dobGiven: noul(0.05),
    deliveryPart: choice({ none: 0.95, morning: 0.05 }), expectedDateMode: choice({ none: 0.95, weekday: 0.05 }), describesParcel: noul(0.05),
    ...over,
  };
}
const ANSWERING = choice({ answering: 0.95, adding: 0.03, replacing: 0.02 });
const ID_TEXT = 'five five five zero one two three four';
const ID_ANSWERS: AnswerMap = { containsAccountId: noul(0.95), accountIdComplete: noul(0.95), accountIdSpan: choice({ [ID_TEXT]: 0.9, none: 0.1 }) };
const DOB_ANSWERS: AnswerMap = { dobGiven: noul(0.95), dobMonth: choice({ april: 0.9 }), dobDay: choice({ '12': 0.9 }), dobYear: choice({ 'nineteen eighty five': 0.9, none: 0.1 }) };
const TRACK = { intent: choice({ track_parcel: 0.95, none: 0.05 }) };

const started = (app: App, channel = VOICE_RELAY): Session => resolve(newSession('s', 0, channel, undefined, app.id), startEvent(), null, tc).session;
const say = (s: Session, text: string, over: AnswerMap): TurnResult => resolve(s, speechEvent(text), answers(over), tc);
function keys(s: Session, digits: string): TurnResult {
  let r = resolve(s, keyEvents(digits[0]!)[0]!, null, tc);
  for (const f of keyEvents(digits.slice(1))) r = resolve(r.session, f, null, tc);
  return r;
}
/** "Where is my parcel" (level 2 in the testkit), the account ID, then the birthday. */
function identified(app: App): TurnResult {
  const opener = say(started(app), 'where is my parcel', TRACK);
  const id = say(opener.session, ID_TEXT, { intentChange: ANSWERING, ...ID_ANSWERS });
  return say(id.session, 'april twelfth nineteen eighty five', { intentChange: ANSWERING, ...DOB_ANSWERS });
}
const tools = (r: TurnResult): string[] => r.gateEvents.map((g) => `${g.decision.call.tool}:${g.decision.verdict}`);

describe('the one-time code\'s length, from identity.yaml', () => {
  it('compiles otp.length onto the code path, and leaves the testkit at the default 6', () => {
    expect([FOUR.identity!.codeLength, EIGHT.identity!.codeLength, testkitApp.identity!.codeLength]).toEqual([4, 8, 6]);
    expect([codeLengthOf(FOUR), codeLengthOf(EIGHT), codeLengthOf(testkitApp)]).toEqual([4, 8, 6]);
  });

  for (const [app, code] of [[FOUR, '2468'], [EIGHT, '13572468']] as const) {
    it(`a full step-up through a ${code.length}-digit code: keyed to its length, checked once, level 2`, () => {
      const atCode = identified(app);
      expect(atCode.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_otp', acks: [{ promptId: 'identity_verified' }] });
      expect(tools(atCode)).toEqual(['verifyCustomer:ALLOW', 'sendCode:ALLOW']);
      expect(atCode.session.promptedFor).toBe('otp');
      // One digit short is still collecting: no call, no level.
      const short = keys(atCode.session, code.slice(0, -1));
      expect(short.decision).toEqual({ kind: 'ignore' });
      expect(short.gateEvents).toEqual([]);
      expect(short.session.dtmfBuffer).toBe(code.slice(0, -1));
      const done = keys(short.session, code.slice(-1));
      expect(tools(done)[0]).toBe('verifyCode:ALLOW');
      expect(done.decision).toMatchObject({ kind: 'prompt', acks: [{ promptId: 'otp_verified' }] });
      expect(done.session.principal.level).toBe(2);
      expect(done.session.dtmfBuffer).toBe('');
      // The code is in no slot, no gate event and no audit row.
      expect(JSON.stringify(done.session.slots)).not.toContain(code);
      expect(JSON.stringify([done.gateEvents, done.audit])).not.toContain(code);
    });

    it(`a wrong ${code.length}-digit code counts against the code's attempts, not the factors'`, () => {
      const wrong = `${code.slice(0, -1)}1`;
      const r = keys(identified(app).session, wrong);
      expect(tools(r)).toEqual(['verifyCode:ALLOW']);
      expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'otp_failed' });
      expect(r.session.identityAttempts).toEqual({ factors: 0, code: 1 });
      expect(r.session.principal.level).toBe(1);
    });
  }

  it('a 4-digit code said aloud is masked from three digits on, and reissued with a code_spoken row', () => {
    const atCode = identified(FOUR).session;
    // Three of four digits is most of the code: masked for a 4-digit code, as it would not be for the default 6.
    const heard = maskCodeEvent(atCode.promptedFor, speechEvent('it is one two three'), codeLengthOf(FOUR));
    expect(heard).toMatchObject({ text: 'it is [code]' });
    expect(maskCodeEvent(atCode.promptedFor, speechEvent('it is one two three'), codeLengthOf(testkitApp))).toMatchObject({ text: 'it is one two three' });
    const r = resolve(atCode, heard, answers(), tc);
    expect(r.decision).toMatchObject({ kind: 'prompt', promptId: 'otp_spoken_reissued' });
    expect(tools(r)).toEqual(['sendCode:ALLOW']);
    expect(r.audit.filter((a) => a.type === 'code_spoken')).toEqual([{ type: 'code_spoken', detail: { masked: true, reissued: true } }]);
    expect(r.session.slots.accountId!.value).toBe('55501234');
  });
});

describe('a ladder of one rung (identity.yaml with level 1 only)', () => {
  it('compiles with no code: no code tools, no length, one name', () => {
    const identity = ONE_RUNG.identity!;
    expect(hasCode(identity)).toBe(false);
    expect([identity.codeTool, identity.sendCodeTool, identity.codeLength]).toEqual([undefined, undefined, undefined]);
    expect(identity.levelNames).toEqual({ 1: 'verified' });
    expect(identity.signInLevel).toBe(1);
  });

  it('a full verify ends at level 1, the request goes on, and no code is ever sent or asked for', () => {
    const r = identified(ONE_RUNG);
    expect(tools(r)).toEqual(['verifyCustomer:ALLOW', 'listParcels:ALLOW']);
    expect(r.session.principal.level).toBe(1);
    expect(r.session.promptedFor).not.toBe('otp');
    expect(r.session.codeSent).toBe(false);
    expect(r.decision).toMatchObject({ kind: 'prompt', acks: [{ promptId: 'identity_verified' }] });
    expect(r.session.stepUp).toBeNull();
  });

  it('refuses at registration anything that needs level 2, and a sign-in above level 1', () => {
    const listParcels2 = { ...ONE_RUNG, id: 'one-rung-2', policy: { ...ONE_RUNG.policy, toolLevel: { ...ONE_RUNG.policy.toolLevel, listParcels: 2 as const } } };
    expect(() => validateApp(listParcels2)).toThrow('app "one-rung-2": tool "listParcels" needs identity level 2, and the identity\'s ladder stops at level 1 (it has no one-time code)');
    const purpose2 = { ...ONE_RUNG, policy: { ...ONE_RUNG.policy, purposeLevel: { report_missing: 2 as const } } };
    expect(() => validateApp(purpose2)).toThrow('purpose "report_missing" needs identity level 2');
    expect(() => validateApp({ ...ONE_RUNG, identity: { ...ONE_RUNG.identity!, signInLevel: 2 } })).toThrow('identity signInLevel 2 is not the top of the ladder (1)');
    expect(() => validateApp({ ...ONE_RUNG, identity: { ...ONE_RUNG.identity!, codeTool: 'verifyCustomer' } })).toThrow('identity names a codeTool but no sendCodeTool');
  });

  it('a web chat sign-in proves level 1, as identity.yaml says; one at level 2 is not one', () => {
    const alex = CUSTOMERS[0]!;
    const web = started(ONE_RUNG, WEB_CHAT);
    expect(resolve(web, signedInEvent(customerPrincipal(alex, 2)), null, tc).decision).toEqual({ kind: 'ignore' });
    const r = resolve(web, signedInEvent(customerPrincipal(alex, 1)), null, tc);
    expect(r.session.principal).toMatchObject({ kind: 'customer', level: 1, id: alex.id });
    expect(r.audit).toContainEqual({ type: 'identity', detail: { factor: 'portal_sign_in', pass: true, level: 1, customer: '...1234' } });
  });
});

describe('sign-in by capability', () => {
  it('an app whose identity.yaml has no signIn takes none; the testkit\'s says level 2', () => {
    expect(testkitApp.identity!.signInLevel).toBe(2);
    const NO_SIGN_IN = variant('testkit-no-signin', { identity: (file) => delete file.signIn });
    expect(NO_SIGN_IN.identity!.signInLevel).toBeUndefined();
    const alex = customerPrincipal(CUSTOMERS[0]!, 2);
    const r = resolve(started(NO_SIGN_IN, WEB_CHAT), signedInEvent(alex), null, tc);
    expect(r.decision).toEqual({ kind: 'ignore' });
    expect(r.audit).toEqual([]);
    // The same event on the testkit, whose file says a sign-in proves level 2.
    expect(resolve(started(testkitApp, WEB_CHAT), signedInEvent(alex), null, tc).session.principal).toEqual(alex);
  });
});
