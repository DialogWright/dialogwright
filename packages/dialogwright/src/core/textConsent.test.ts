import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { runScenario, type Scenario, type ScenarioRun } from '../harness-text/runner';
import { loadCorpus } from '../jev/corpus';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import type { JevClient, JevRequest } from '../jev/types';
import { spokenText } from '../prompts/render';
import { registerApp, resetAppsForTest } from './app/registry';
import type { App } from './app/types';
import { DEFAULT_THRESHOLDS } from './thresholds';
import type { TurnResult } from './turn';
import { textConsentOf } from '../index';
import { sessionRoundTrip } from '../testing/sessionRoundTrip';
import { TEXTING_DIR, textingApp } from '../testing/texting/app';
import { CONSENT, CONSENT_AND_PROPOSAL, CONSENT_SPANISH, proposingCode, textingVariants } from '../testing/texting/variant';
import { callbackApp } from '../testing/callback/app';
import { proposalsApp } from '../testing/proposals/app';
import { screenedApp } from '../testing/screened/app';
import { testkitApp } from '../testing/testkit';

/**
 * Consent to text for the whole call (design 2026-10-08-offer-answers-and-consent, item 3): app.yaml's
 * `textConsent: { covers }`, asked once after the greeting on a call (`consent_texts`, with `{last4}`).
 * Granted, each slot it covers is filled with the caller's number, confirmed, with no question, and an
 * `offer` row (`answer: consent`) records each use; declined or unknown, each slot asks its own offer.
 * The grant itself is a `consent` row. On the texting fixture's consent variant (src/testing/texting):
 * two numbers to text, `textTo` and `alertTo`, both covered.
 */

const TODAY = '2026-10-08';
const MOBILE = '+15555550142';
const LANDLINE = '+15555550143';
const OPENER = ["I'd like to open a request", "it's about an order"] as const;
const CONSENT_LINE = 'Can I text you helpful links during this call, at the number ending in 0142?';

const variants = textingVariants();
afterAll(() => variants.remove());
const consent = variants.variant(CONSENT);
const withProposal = variants.variant(CONSENT_AND_PROPOSAL, proposingCode);
const corpusOf = (app: App) => loadCorpus(join(app === textingApp ? TEXTING_DIR : variants.dirOf(app), 'fixtures', 'corpus.jsonl'), app);

function stub(app: App, asked: JevRequest[] = []): JevClient {
  const inner = new FixtureStubClient(corpusOf(app), { sharpness: DEFAULT_THRESHOLDS.STUB_SHARPNESS, fallback: new HeuristicStubClient({ todayIso: TODAY }) });
  return { ask: (req) => { asked.push(req); return inner.ask(req); } };
}

let current: App = consent;
function use(app: App): void {
  current = app;
  resetAppsForTest();
  registerApp(app);
}
beforeEach(() => use(consent));

interface CallOptions {
  callerNumber?: string;
  as?: string;
}

/** A call: the greeting, then each step in turn. */
async function call(o: CallOptions, ...steps: Scenario['steps']): Promise<ScenarioRun> {
  const scenario: Scenario = {
    id: 'call', steps, expect: { decision: 'any' },
    ...(o.callerNumber !== undefined ? { callerNumber: o.callerNumber } : {}),
    ...(o.as !== undefined ? { as: o.as } : {}),
  };
  return runScenario(scenario, { client: stub(current), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, now: () => 0 });
}
const says = (...lines: string[]): Scenario['steps'] => lines.map((say) => ({ say }));
const fromMobile = (...steps: Scenario['steps']): Promise<ScenarioRun> => call({ callerNumber: MOBILE }, ...steps);

const last = (r: ScenarioRun): TurnResult => r.runs.at(-1)!.result;
const heard = (t: TurnResult): string => spokenText(current, t.decision);
const promptOf = (t: TurnResult): string | undefined => ('promptId' in t.decision ? t.decision.promptId : undefined);
const prompts = (r: ScenarioRun): (string | undefined)[] => r.runs.map((x) => promptOf(x.result));
const rows = (r: ScenarioRun, type: string) => r.runs.flatMap((x) => x.result.audit.filter((d) => d.type === type).map((d) => d.detail));
const gates = (r: ScenarioRun): string[] => r.runs.flatMap((x) => x.result.gateEvents.map((e) => `${e.decision.call.tool}:${e.decision.verdict}`));

describe('the consent question', () => {
  it('is asked once, right after the greeting, by the last four digits, in place of the open question', async () => {
    const start = (await fromMobile()).runs[0]!.result;
    expect(start.decision).toMatchObject({ kind: 'prompt', promptId: 'consent_texts', target: 'intent', vars: { last4: '0142' }, options: ['yes', 'no'], acks: [{ promptId: 'greeting_offer', vars: {} }] });
    expect(heard(start)).toBe(`Thanks for calling Example Requests. ${CONSENT_LINE}`);
    expect(start.session.pendingConfirmation).toMatchObject({ target: 'slot', slot: 'textTo', offered: true, at: 'greeting', consent: true });
    // Nothing is decided yet, and nothing is filled.
    expect(textConsentOf(start.session)).toBeNull();
    expect(start.session.slots.textTo!.value).toBeNull();
    expect(rows(await fromMobile(), 'consent')).toEqual([]);
  });

  it('a yes is the grant: the open question follows, and the consent row records it', async () => {
    const r = await fromMobile(...says('sure, go ahead and text me'));
    const t = last(r);
    expect(promptOf(t)).toBe('greet_after_offer');
    expect(textConsentOf(t.session)).toBe('granted');
    expect(t.session.pendingConfirmation).toBeNull();
    expect(rows(r, 'consent')).toEqual([{ scope: 'call', granted: true, promptId: 'consent_texts', said: CONSENT_LINE, last4: '0142', by: 'speech', locale: 'en-US' }]);
    // A grant is not an offer settled, and fills nothing yet.
    expect(rows(r, 'offer')).toEqual([]);
    expect(t.session.slots.textTo!.value).toBeNull();
  });

  it('a no is declined, and its row says so', async () => {
    const r = await fromMobile(...says("no, don't text me"));
    expect(promptOf(last(r))).toBe('greet_after_offer');
    expect(textConsentOf(last(r).session)).toBe('declined');
    expect(rows(r, 'consent')).toMatchObject([{ scope: 'call', granted: false, by: 'speech' }]);
  });

  it('a request instead leaves it unknown, not asked again, and the request goes on', async () => {
    const r = await fromMobile(...says('actually, I need to open a request about a bill'));
    const t = last(r);
    expect(textConsentOf(t.session)).toBe('unknown');
    expect(rows(r, 'consent')).toMatchObject([{ scope: 'call', granted: null }]);
    // Each slot asks its own offer.
    expect(t.decision).toMatchObject({ promptId: 'offer_textTo', acks: [{ promptId: 'ack_intent' }] });
    expect(t.session.slots.topic!.value).toBe('bill');
  });

  it('unanswered twice leaves it unknown, and the open question is asked', async () => {
    const r = await fromMobile({ silence: true }, { silence: true });
    expect(prompts(r)).toEqual(['consent_texts', 'consent_texts', 'greet_after_offer']);
    expect(textConsentOf(last(r).session)).toBe('unknown');
    expect(rows(r, 'consent')).toMatchObject([{ granted: null, by: null }]);
  });

  it('takes a 1 alone and a 2 alone on the keypad, once the keys stop or with #', async () => {
    const one = await fromMobile({ dtmf: '1' }, { silence: true });
    expect(prompts(one)).toEqual(['consent_texts', undefined, 'greet_after_offer']);
    expect(textConsentOf(last(one).session)).toBe('granted');
    expect(rows(one, 'consent')).toMatchObject([{ granted: true, by: 'keypad' }]);
    expect(gates(one)).toEqual(['findCallerByPhone:ALLOW']);
    const two = await fromMobile({ dtmf: '2#' });
    expect(prompts(two)).toEqual(['consent_texts', undefined, 'greet_after_offer']);
    expect(textConsentOf(last(two).session)).toBe('declined');
    expect(rows(two, 'consent')).toMatchObject([{ granted: false, by: 'keypad' }]);
  });

  it('a number keyed at it is asked again once, nothing recorded, and no key reaches the menu', async () => {
    for (const keys of [[{ dtmf: '2125550199' }, { silence: true }], [{ dtmf: '2125550199#' }]] as Scenario['steps'][]) {
      const r = await fromMobile(...keys);
      expect(r.runs.slice(1, -1).every((x) => x.result.decision.kind === 'ignore'), JSON.stringify(keys)).toBe(true);
      expect(promptOf(last(r)), JSON.stringify(keys)).toBe('consent_texts');
      expect(textConsentOf(last(r).session)).toBeNull();
      expect(last(r).session.menuActive).toBe(false);
      expect(rows(r, 'consent')).toEqual([]);
      expect(gates(r)).toEqual(['findCallerByPhone:ALLOW']);
    }
    const then = await fromMobile({ dtmf: '2125550199' }, { silence: true }, { dtmf: '1' }, { silence: true });
    expect(textConsentOf(last(then).session)).toBe('granted');
    expect(rows(then, 'consent')).toMatchObject([{ granted: true, by: 'keypad' }]);
  });

  it('is not asked with the number withheld, on a call with none, from a number the app will not offer, nor on a chat', async () => {
    for (const o of [{ callerNumber: 'anonymous' }, {}, { callerNumber: LANDLINE }] as CallOptions[]) {
      const r = await call(o, ...says(...OPENER));
      expect(promptOf(r.runs[0]!.result), JSON.stringify(o)).toBe('greeting');
      expect(textConsentOf(last(r).session), JSON.stringify(o)).toBeNull();
      expect(rows(r, 'consent'), JSON.stringify(o)).toEqual([]);
    }
    const chat = await call({ as: 'web', callerNumber: MOBILE }, ...says(OPENER[0]));
    expect(promptOf(chat.runs[0]!.result)).toBe('greeting_chat');
    expect(textConsentOf(last(chat).session)).toBeNull();
  });
});

describe('a covered text moment', () => {
  it('granted: every slot the consent covers is filled with the caller\'s number, confirmed, with no question', async () => {
    const r = await fromMobile(...says('sure, go ahead and text me', ...OPENER));
    const t = last(r);
    expect(prompts(r)).toEqual(['consent_texts', 'greet_after_offer', 'ask_topic', 'confirm_open_request_text']);
    expect(t.session.slots.textTo).toMatchObject({ value: '5555550142', display: '555 555 0142', confirmed: true });
    expect(t.session.slots.alertTo).toMatchObject({ value: '5555550142', confirmed: true });
    // One offer row for each use of the grant, by the line the caller said yes to, and one consent row.
    expect(rows(r, 'offer')).toEqual([
      { slot: 'textTo', source: 'caller-number', promptId: 'consent_texts', said: CONSENT_LINE, answer: 'consent', by: null, last4: '0142', locale: 'en-US' },
      { slot: 'alertTo', source: 'caller-number', promptId: 'consent_texts', said: CONSENT_LINE, answer: 'consent', by: null, last4: '0142', locale: 'en-US' },
    ]);
    expect(rows(r, 'consent')).toHaveLength(1);
    // Who the caller is does not change.
    expect(t.session.principal).toEqual({ kind: 'anonymous', level: 0 });
  });

  it('granted with the request in the same breath, the request goes on', async () => {
    const r = await fromMobile(...says("sure, and I'd like to open a request", OPENER[1]));
    expect(prompts(r)).toEqual(['consent_texts', 'ask_topic', 'confirm_open_request_text']);
    expect(textConsentOf(last(r).session)).toBe('granted');
  });

  it('the summary still reads the number back whole, and the callerNumber rule passes it as the caller\'s own', async () => {
    const r = await fromMobile(...says('sure, go ahead and text me', ...OPENER, 'yes, open it'));
    expect(heard(r.runs[3]!.result)).toBe("That's a request about an order, with updates texted to 555 555 0142. Shall I open it?");
    expect(gates(r)).toEqual(['findCallerByPhone:ALLOW', 'openRequest:ALLOW', 'sendUpdates:ALLOW']);
    const send = r.runs.flatMap((x) => x.result.gateEvents).find((e) => e.decision.call.tool === 'sendUpdates')!;
    expect(send.decision.rules.find((x) => x.id === 'callerNumber')).toMatchObject({ pass: true, compared: 'textTo is the caller\'s number' });
  });

  it('records the line the caller said yes to, as said then, after the call moves to another language', async () => {
    use(variants.variant(CONSENT_SPANISH));
    const r = await fromMobile(...says('sure, go ahead and text me', 'can we continue in Spanish', ...OPENER));
    expect(last(r).session.locale).toBe('es');
    expect(promptOf(last(r))).toBe('confirm_open_request_text');
    expect(rows(r, 'offer').map((d) => [d.slot, d.said, d.locale])).toEqual([['textTo', CONSENT_LINE, 'en-US'], ['alertTo', CONSENT_LINE, 'en-US']]);
    expect(rows(r, 'consent')).toMatchObject([{ said: CONSENT_LINE, locale: 'en-US' }]);
  });

  it('declined: each slot asks its own offer, accepted or declined as always', async () => {
    const r = await fromMobile(...says("no, don't text me", ...OPENER, 'yes, please text me', 'yes, alerts too'));
    expect(prompts(r)).toEqual(['consent_texts', 'greet_after_offer', 'ask_topic', 'offer_textTo', 'offer_alertTo', 'confirm_open_request_text']);
    expect(rows(r, 'offer').map((d) => [d.slot, d.answer])).toEqual([['textTo', 'yes'], ['alertTo', 'yes']]);
  });

  it('a slot reopened at the summary is asked its own question, not filled again', async () => {
    const r = await fromMobile(...says('sure, go ahead and text me', ...OPENER, 'no, the text number is wrong'));
    expect(promptOf(last(r))).toBe('ask_textTo');
    expect(last(r).session.slots.textTo!.value).toBeNull();
  });
});

describe('only one question follows the greeting', () => {
  beforeEach(() => use(withProposal));

  it('consent comes before a proposal at the greeting, which is then made at its slot', async () => {
    const r = await fromMobile(...says('sure, go ahead and text me', OPENER[0]));
    expect(promptOf(r.runs[0]!.result)).toBe('consent_texts');
    expect(r.runs[0]!.result.session.greetingOffered).toBeUndefined();
    expect(prompts(r)).toEqual(['consent_texts', 'greet_after_offer', 'offer_topic']);
  });

  it('with consent not asked (a landline), the proposal is made at the greeting as before', async () => {
    use(variants.variant({ ...CONSENT_AND_PROPOSAL, 'app.yaml': (t) => CONSENT_AND_PROPOSAL['app.yaml']!(t).replace('id: texting-consent-proposal', 'id: texting-consent-proposal-2') }, { ...proposingCode, facts: { ...proposingCode.facts!, offers: () => ({ topic: { value: 'order', display: 'an order' } }) } }));
    const start = (await call({ callerNumber: LANDLINE })).runs[0]!.result;
    expect(promptOf(start)).toBe('offer_topic');
  });
});

describe('the session', () => {
  it('resumes exactly at every turn of the consent calls', async () => {
    const scenario = (id: string, steps: Scenario['steps']): Scenario => ({ id, callerNumber: MOBILE, steps, expect: { decision: 'any' } });
    const report = await sessionRoundTrip('stub', {
      // The consent question's lines, each seeded as just asked (harness-text/runner.ts seedTextConsent).
      corpus: corpusOf(consent).filter((e) => e.id.startsWith('tc-')),
      scenarios: [
        scenario('granted', says('sure, go ahead and text me', ...OPENER, 'yes, open it')),
        scenario('declined', says("no, don't text me", ...OPENER, 'yes, please text me')),
        scenario('unknown', [{ silence: true }, { silence: true }, ...says(...OPENER)]),
      ],
    });
    expect(report.mismatches).toEqual([]);
  }, 60_000);
});

describe('apps without it', () => {
  it('have no textConsent, and their sessions never hold one', async () => {
    for (const app of [testkitApp, screenedApp, callbackApp, textingApp, proposalsApp]) expect(app.textConsent, app.id).toBeUndefined();
    use(textingApp);
    const r = await fromMobile(...says(...OPENER));
    expect(promptOf(r.runs[0]!.result)).toBe('greeting');
    expect('textConsent' in last(r).session).toBe(false);
    expect(rows(r, 'consent')).toEqual([]);
  });
});
