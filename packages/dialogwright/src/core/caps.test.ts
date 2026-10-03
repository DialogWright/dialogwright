import { beforeEach, describe, expect, it } from 'vitest';
import { plan, resolve, type TurnContext } from './turn';
import { newSession, cloneSession, type Session } from './session';
import { DEFAULT_THRESHOLDS } from './thresholds';
import { signedInEvent, speechEvent, startEvent } from '../channel/events';
import { VOICE_RELAY, WEB_CHAT, type Channel } from '../channel/caps';
import { choice, noul, score } from '../testing/answers';
import type { AnswerMap } from '../jev/types';
import { demoTools } from './tools';
import { useTestkit } from '../testing/apps';
import { testkitApp } from '../testing/testkit';
import { registerApp } from './app/registry';
import { awaitingSignIn } from './lifecycle';
import { CUSTOMERS } from '../testing/testkit/domain/data';
import { customerPrincipal } from '../testing/testkit/domain/principals';

useTestkit();

/**
 * The core decides by what a channel can do, never by its name. Every channel here is made up:
 * none is called 'voice' or 'chat', so a branch on the name would take the voice path for all of them.
 */
const KIOSK: Channel = { kind: 'kiosk', caps: { ...VOICE_RELAY.caps, keypad: false } };
const PORTAL: Channel = { kind: 'portal', caps: { ...WEB_CHAT.caps } };
const TEXT_ONLY: Channel = { kind: 'sms-ish', caps: { ...VOICE_RELAY.caps, speech: false } };
const SPEAKER: Channel = { kind: 'speaker', caps: { ...WEB_CHAT.caps, speech: true } };

let tc: TurnContext;
beforeEach(() => {
  tc = { nowMs: 0, todayIso: '2026-09-18', thresholds: { ...DEFAULT_THRESHOLDS }, tools: demoTools() };
});

function answers(over: AnswerMap = {}): AnswerMap {
  return {
    addressedToSystem: noul(0.95), intelligible: noul(0.95), utteranceComplete: noul(0.9), wantsHuman: noul(0.05),
    rephrasingLastTurn: noul(0.1), confusedByPrompt: noul(0.1), spokeAMenuNumber: noul(0.05),
    frustration: score({ none: 0.8, mild: 0.15, high: 0.05 }),
    intent: choice({ none: 0.9, other: 0.1 }),
    containsAccountId: noul(0.05),
    dobGiven: noul(0.05),
    ...over,
  };
}
const NOMATCH = { intent: choice({ none: 0.7, other: 0.3 }) };

const started = (c: Channel): Session => resolve(newSession('t', 0, c), startEvent(), null, tc).session;
function say(s: Session, text: string, over: AnswerMap) {
  const event = speechEvent(text);
  expect(plan(s, event, tc).needsModel).toBe(true);
  return resolve(s, event, answers(over), tc);
}

describe('the session carries its channel', () => {
  it('records the kind and a copy of the capabilities', () => {
    const s = newSession('t', 0, KIOSK);
    expect(s.channel).toBe('kiosk');
    expect(s.caps).toEqual(KIOSK.caps);
    expect(s.caps).not.toBe(KIOSK.caps);
    expect(newSession('t', 0, VOICE_RELAY)).toMatchObject({ channel: 'voice', caps: VOICE_RELAY.caps });
    expect(newSession('t', 0, WEB_CHAT)).toMatchObject({ channel: 'chat', caps: WEB_CHAT.caps });
  });

  it('copies the capabilities when a session is cloned', () => {
    const s = newSession('t', 0, KIOSK);
    const c = cloneSession(s);
    expect(c.caps).toEqual(s.caps);
    expect(c.caps).not.toBe(s.caps);
  });
});

describe('keypad: false', () => {
  it('re-asks with the open prompt where voice gets the keypad menu', () => {
    const walk = (c: Channel) => {
      let r = say(started(c), 'blah', NOMATCH);
      r = say(r.session, 'blah', NOMATCH);
      return r;
    };
    expect(walk(VOICE_RELAY).decision).toMatchObject({ kind: 'prompt', promptId: 'nomatch_dtmf_menu' });
    const kiosk = walk(KIOSK);
    expect(kiosk.decision).toMatchObject({ kind: 'prompt', promptId: 'nomatch_open' });
    expect(kiosk.session.menuActive).toBe(false);
    const last = say(kiosk.session, 'blah', NOMATCH);
    expect(last.decision).toMatchObject({ kind: 'handoff', reason: 'max-attempts' });
  });

  it('says it is slow without the keypad hint, where voice hints at it', () => {
    const slow = (c: Channel) => resolve(started(c), speechEvent('hello'), null, tc, { name: 'JevClientError', message: 'timeout' });
    expect(slow(VOICE_RELAY).decision).toMatchObject({ promptId: 'system_slow_dtmf_hint' });
    expect(slow(KIOSK).decision).toMatchObject({ promptId: 'system_slow_chat' });
  });
});

describe('signIn', () => {
  const ALEX = customerPrincipal(CUSTOMERS[0]!, 2);
  const parked = (c: Channel) => say(started(c), 'where is my parcel please', { intent: choice({ track_parcel: 0.95, none: 0.05 }) });

  it('ignores a sign-in where the channel cannot sign in, and accepts it where it can', () => {
    const kiosk = resolve(started(KIOSK), signedInEvent(ALEX), null, tc);
    expect(kiosk.session.principal.level).toBe(0);
    expect(kiosk.decision).toMatchObject({ kind: 'ignore' });
    const portal = resolve(started(PORTAL), signedInEvent(ALEX), null, tc);
    expect(portal.session.principal).toMatchObject({ kind: 'customer', level: 2 });
    expect(portal.decision).toMatchObject({ promptId: 'signin_ready' });
  });

  it('asks the portal to sign in, and the kiosk for a spoken account ID', () => {
    expect(parked(PORTAL).decision).toMatchObject({ promptId: 'signin_required' });
    expect(parked(KIOSK).decision).toMatchObject({ promptId: 'ask_accountId' });
  });

  it('resumes a parked request on the portal once signed in', () => {
    const r = resolve(parked(PORTAL).session, signedInEvent(ALEX), null, tc);
    expect(r.session.entered).toBe('track_parcel');
    expect(r.decision).toMatchObject({ promptId: 'ask_parcelSelect' });
  });
});

describe('speech: false', () => {
  it('greets with the chat greeting, whatever the channel is called', () => {
    expect(resolve(newSession('t', 0, TEXT_ONLY), startEvent(), null, tc).decision).toMatchObject({ promptId: 'greeting_chat' });
    expect(resolve(newSession('t', 0, VOICE_RELAY), startEvent(), null, tc).decision).toMatchObject({ promptId: 'greeting' });
    expect(resolve(newSession('t', 0, SPEAKER), startEvent(), null, tc).decision).toMatchObject({ promptId: 'greeting' });
  });

  it('greets a signed-in customer by name', () => {
    const customer = newSession('t', 0, TEXT_ONLY, customerPrincipal(CUSTOMERS[0]!, 2));
    expect(resolve(customer, startEvent(), null, tc).decision).toMatchObject({ promptId: 'greeting_chat_signed_in' });
  });

  it('says the chat goodbye at the end, and the spoken one where the channel speaks', () => {
    const bye = (c: Channel) => say(started(c), "no, that's all", { intent: choice({ done: 0.95, none: 0.05 }) });
    expect(bye(TEXT_ONLY).decision).toMatchObject({ kind: 'complete', promptId: 'goodbye_chat' });
    expect(bye(VOICE_RELAY).decision).toMatchObject({ kind: 'complete', promptId: 'goodbye' });
    expect(bye(SPEAKER).decision).toMatchObject({ kind: 'complete', promptId: 'goodbye' });
  });
});

describe('signIn: an app that takes none', () => {
  // The testkit with no sign-in in its identity: a web chat caller can neither give the factors (they
  // are never asked on a channel that signs callers in) nor sign in (the app ignores the event).
  const { signInLevel: _none, ...identity } = testkitApp.identity!;
  registerApp({ ...testkitApp, id: 'nosignin', identity });
  const startedHere = (c: Channel): Session => resolve(newSession('t', 0, c, undefined, 'nosignin'), startEvent(), null, tc).session;
  const parkedHere = (c: Channel) => say(startedHere(c), 'where is my parcel please', { intent: choice({ track_parcel: 0.95, none: 0.05 }) });

  it('hands a chat caller who needs identity to a person, rather than asking them to sign in again and again', () => {
    const r = parkedHere(PORTAL);
    expect(r.decision).toMatchObject({ kind: 'handoff', reason: 'needs-human' });
    expect(awaitingSignIn(r.session)).toBe(false);
  });

  it('ignores a sign-in, and still asks a caller on the phone for the factors', () => {
    expect(resolve(startedHere(PORTAL), signedInEvent(customerPrincipal(CUSTOMERS[0]!, 2)), null, tc).decision).toMatchObject({ kind: 'ignore' });
    expect(parkedHere(KIOSK).decision).toMatchObject({ promptId: 'ask_accountId' });
  });
});

