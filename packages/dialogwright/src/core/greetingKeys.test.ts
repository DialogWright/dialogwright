import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { runScenario, type Scenario } from '../harness-text/runner';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { registerApp, resetAppsForTest } from './app/registry';
import type { App } from './app/types';
import { DEFAULT_THRESHOLDS } from './thresholds';
import { mockCodeVerifier } from './tools';
import { newSession, type Session } from './session';
import { resolve, type TurnContext, type TurnResult } from './turn';
import { keyEvents, startEvent } from '../channel/events';
import { VOICE_RELAY } from '../channel/caps';
import { ANONYMOUS } from '../gate/principal';
import { CONSENT, textingVariants } from '../testing/texting/variant';
import { GREETING as PROPOSAL, proposalsVariants } from '../testing/proposals/variant';
import { GREETING as CALLER_ID, recognizedVariants } from '../testing/recognized/variant';
import { spanishSwitchVariants } from '../testing/spanishSwitch';

/**
 * Where a key the menu takes from the greeting on (MenuEntry.fromGreeting) is not taken: anywhere the
 * caller is not at the open question. Each row is a call in that state, on the fixture that makes it
 * (the call's opening offer: the consent to text, a proposal at the greeting, the caller-ID question),
 * or a session set in it (identity under way at the greeting, a downstream answer awaited, the
 * frustration ladder's offer of a person); the key is the 0 (agent), listening from the greeting, so a
 * key taken would end the call with a person.
 */

const TODAY = '2026-10-13';
/** On file in each fixture: the number its opening offer is made for. */
const ON_FILE = '+15555550142';
/** The 0 (agent) of a fixture's menu, taken from the greeting on. */
const ZERO_LISTENS = { 'intents.yaml': (t: string) => t.replace('  - digit: "0"\n    intent: agent', '  - digit: "0"\n    intent: agent\n    fromGreeting: true') };

const texting = textingVariants();
const proposals = proposalsVariants();
const recognized = recognizedVariants();
const library = spanishSwitchVariants();
afterAll(() => {
  texting.remove();
  proposals.remove();
  recognized.remove();
  library.remove();
});

/** The call to `app` from the number on file: its start, then the 0 pressed at once. */
async function zeroAtOffer(app: App): Promise<{ start: TurnResult; key: TurnResult }> {
  resetAppsForTest();
  registerApp(app);
  const scenario: Scenario = { id: 'zero', steps: [{ dtmf: '0' }], expect: { decision: 'any' }, callerNumber: ON_FILE };
  const r = await runScenario(scenario, { client: new HeuristicStubClient({ todayIso: TODAY }), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, now: () => 0, tools: { ...app.systems(), codes: mockCodeVerifier } });
  return { start: r.runs[0]!.result, key: r.runs.at(-1)!.result };
}

describe('a key from the greeting is not taken at the call\'s opening offer', () => {
  const rows: [string, () => App, (s: Session) => unknown][] = [
    ['the consent to text (app.yaml textConsent)', () => texting.variant({ ...CONSENT, ...ZERO_LISTENS }), (s) => s.pendingConfirmation?.target === 'slot' && s.pendingConfirmation.consent],
    ['a proposal at the greeting (a slot\'s offerAt: greeting)', () => proposals.variant({ ...PROPOSAL, ...ZERO_LISTENS }), (s) => s.pendingConfirmation?.target === 'slot' && s.pendingConfirmation.at],
    ['the caller-ID question (identity.yaml callerId, ask: greeting)', () => recognized.variant({ ...CALLER_ID, ...ZERO_LISTENS }), (s) => s.stepUp?.at],
  ];
  for (const [name, build, offered] of rows) {
    it(name, async () => {
      const app = build();
      expect(app.menu.find((m) => m.digit === '0')?.fromGreeting).toBe(true);
      const { start, key } = await zeroAtOffer(app);
      // The offer was made in place of the open question...
      expect(offered(start.session)).toBeTruthy();
      // ...and the 0 is not the menu's there: no person, no menu key recorded.
      expect(key.menuKey).toBeUndefined();
      expect(key.decision.kind).not.toBe('handoff');
      expect(key.session.ended).toBe(false);
    });
  }
});

describe('a key from the greeting is not taken where the session is not at the open question', () => {
  const app = library.build('library-exclusions', [], { menuListens: 'greeting' });
  beforeEach(() => {
    resetAppsForTest();
    registerApp(app);
  });
  const tc = (): TurnContext => ({ nowMs: 0, todayIso: TODAY, thresholds: { ...DEFAULT_THRESHOLDS }, tools: { ...app.systems(), codes: mockCodeVerifier } });
  const started = (): Session => resolve(newSession('exclusions', 0, VOICE_RELAY, ANONYMOUS, app.id), startEvent(), null, tc()).session;
  const zero = (s: Session): TurnResult => resolve(s, keyEvents('0')[0]!, null, tc());

  it('takes the 0 at the open question itself (the control)', () => {
    expect(zero(started()).decision).toMatchObject({ kind: 'handoff', reason: 'live-agent' });
  });

  const rows: [string, (s: Session) => Session][] = [
    ['identity under way at the greeting (a step-up at: greeting)', (s) => ({ ...s, stepUp: { call: { tool: 'checkLoans', params: {} }, need: 1, at: 'greeting' } })],
    ['a downstream service\'s answer awaited', (s) => ({ ...s, pendingService: 'catalog' })],
    ['the frustration ladder\'s offer of a person', (s) => ({ ...s, promptedFor: 'confirm', pendingConfirmation: { target: 'transfer', attempts: 0 } })],
    ['an unsure intent\'s confirmation', (s) => ({ ...s, pendingConfirmation: { target: 'intent', intent: 'renew_loan', answers: {}, text: 'renew' } })],
  ];
  for (const [name, set] of rows) {
    it(name, () => {
      const key = zero(set(started()));
      expect(key.menuKey).toBeUndefined();
      expect(key.decision).not.toMatchObject({ kind: 'handoff', reason: 'live-agent' });
    });
  }
});
