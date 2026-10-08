import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadScenarios, runScenario, type Scenario, type ScenarioRun } from '../harness-text/runner';
import { loadCorpus } from '../jev/corpus';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import type { JevClient, JevRequest } from '../jev/types';
import { spokenText } from '../prompts/render';
import { registerApp, resetAppsForTest } from './app/registry';
import { gateOf } from './app/lookup';
import type { App } from './app/types';
import { DEFAULT_THRESHOLDS } from './thresholds';
import { newSession } from './session';
import { resolve, CALLER_LOOKUP_PURPOSE, type TurnContext, type TurnResult } from './turn';
import { startEvent, withCalledNumber, withCallerNumber } from '../channel/events';
import { VOICE_RELAY } from '../channel/caps';
import { mockCodeVerifier } from './tools';
import { compileGate } from '../gate/compiled';
import { AuditLog } from '../audit/log';
import { verifyChain } from '../audit/verify';
import type { AuditEntry } from '../audit/types';
import { callerOf, calledOf, hintsCallerNumber, keptCalledNumber, keptCallerNumber, standInCallerNumber, usesCalledNumber, usesCallerNumber } from './callerNumber';
import { redactRecordSlots } from '../trace/redact';
import { redactDeep, redactRecord } from '../server/dashboard/events';
import { TEXTING_DIR, TextingSystems, textingApp, type TextingFacts } from '../testing/texting/app';
import { CALLBACK_DIR, callbackApp } from '../testing/callback/app';
import { screenedApp } from '../testing/screened/app';
import { testkitApp } from '../testing/testkit';
import { isAnonymous } from '../gate/types';

/**
 * The number the caller is calling from, used by the app (app.yaml's `callerNumber: { use: hint }`):
 * kept for the app's code (callerOf, calledOf), looked up once at call start through the gate, offered
 * for an optional text slot (`onNo`, `ifNone: skip`, App.callerOffer), and every settled offer an
 * `offer` row in the audit's hash chain. On the engine's fixture for it, Example Requests
 * (src/testing/texting). It is a hint, never identity: nothing here changes who the caller is.
 */

const TODAY = '2026-10-07';
const FIXTURES = join(TEXTING_DIR, 'fixtures');
const corpus = loadCorpus(join(FIXTURES, 'corpus.jsonl'), textingApp);
const callbackCorpus = loadCorpus(join(CALLBACK_DIR, 'fixtures', 'corpus.jsonl'), callbackApp);

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** The fixture stub over a corpus, each request it was asked kept in `asked`. */
function stub(asked: JevRequest[] = [], c = corpus): JevClient {
  const inner = new FixtureStubClient(c, { sharpness: DEFAULT_THRESHOLDS.STUB_SHARPNESS, fallback: new HeuristicStubClient({ todayIso: TODAY }) });
  return { ask: (req) => { asked.push(req); return inner.ask(req); } };
}

function use(app: App): void {
  resetAppsForTest();
  registerApp(app);
}

beforeEach(() => use(textingApp));

const MOBILE = '+15555550142';
const LANDLINE = '+15555550143';
/** Not on file; the line-type lookup says it is a mobile. */
const LOOKED_UP_MOBILE = '+15555550144';
const CALLED = '+15555550100';
const OPENER = ["I'd like to open a request", "it's about an order"] as const;

interface CallOptions {
  callerNumber?: string;
  calledNumber?: string;
  as?: string;
  asked?: JevRequest[];
  audit?: AuditLog;
  client?: JevClient;
}

/** A call: the greeting, then each step in turn. */
async function call(o: CallOptions, ...steps: Scenario['steps']): Promise<ScenarioRun> {
  const scenario: Scenario = {
    id: 'call', steps, expect: { decision: 'any' },
    ...(o.callerNumber !== undefined ? { callerNumber: o.callerNumber } : {}),
    ...(o.calledNumber !== undefined ? { calledNumber: o.calledNumber } : {}),
    ...(o.as !== undefined ? { as: o.as } : {}),
  };
  return runScenario(scenario, { client: o.client ?? stub(o.asked), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, now: () => 0, ...(o.audit ? { audit: o.audit } : {}) });
}
const says = (...lines: string[]): Scenario['steps'] => lines.map((say) => ({ say }));

const last = (r: ScenarioRun): TurnResult => r.runs.at(-1)!.result;
const heard = (t: TurnResult): string => spokenText(appOfRun(), t.decision);
const appOfRun = (): App => textingApp;
const promptOf = (t: TurnResult): string | undefined => ('promptId' in t.decision ? t.decision.promptId : undefined);
const gates = (r: ScenarioRun): string[] => r.runs.flatMap((x) => x.result.gateEvents.map((e) => `${e.decision.call.tool}:${e.decision.verdict}`));
const offers = (r: ScenarioRun) => r.runs.flatMap((x) => x.result.audit.filter((d) => d.type === 'offer').map((d) => d.detail));

const OFFER = "Can I text you updates at the number you're calling from, ending in 0142?";

/** The texting fixture as another app: its id, and what `change` makes of it. */
function variant(id: string, change: (app: App) => Partial<App>): App {
  return { ...textingApp, id, ...change(textingApp) } as App;
}

/** The texting fixture with the text slot's offer options replaced. */
function withOffer(id: string, options: { onNo?: 'skip'; ifNone?: 'skip' }): App {
  return variant(id, (app) => {
    const spec = app.slots.textTo!;
    return { slots: { ...app.slots, textTo: { ...spec, callerNumber: { take: spec.callerNumber!.take, ...options } } } };
  });
}

describe('app.yaml\'s callerNumber, off by default', () => {
  it('is read into the App as written, with `called` only when true', () => {
    expect(textingApp.callerNumber).toEqual({ use: 'hint', called: true, lookup: 'findCallerByPhone' });
    for (const app of [testkitApp, screenedApp, callbackApp]) expect(app.callerNumber, app.id).toBeUndefined();
  });

  it('keeps the number for an app that opts in, whether or not a slot can offer it; no other app keeps it without a slot', () => {
    expect([hintsCallerNumber(textingApp), usesCallerNumber(textingApp), usesCalledNumber(textingApp)]).toEqual([true, true, true]);
    for (const app of [testkitApp, screenedApp]) expect([app.id, usesCallerNumber(app), usesCalledNumber(app)]).toEqual([app.id, false, false]);
    expect([usesCallerNumber(callbackApp), usesCalledNumber(callbackApp)]).toEqual([true, false]);
    // Any usable number: another country's too, which no slot of the app takes.
    expect(keptCallerNumber(textingApp, '+445555550142')).toBe('+445555550142');
    expect(keptCallerNumber(callbackApp, '+445555550142')).toBeUndefined();
    // Never a withheld one, nor anything that is no number.
    for (const raw of ['anonymous', '+7378742833', '', 'sip:caller@example.com', undefined]) expect(keptCallerNumber(textingApp, raw), String(raw)).toBeUndefined();
    expect(keptCalledNumber(textingApp, CALLED)).toBe(CALLED);
    expect(keptCalledNumber(callbackApp, CALLED)).toBeUndefined();
    expect(keptCalledNumber(textingApp, undefined)).toBeUndefined();
  });

  it('an app with neither the block nor an offer slot keeps nothing of either number its start event carries', () => {
    use(screenedApp);
    const tc: TurnContext = { nowMs: 0, todayIso: TODAY, thresholds: { ...DEFAULT_THRESHOLDS }, tools: { ...screenedApp.systems(), codes: mockCodeVerifier } };
    const base = newSession('s', 0, VOICE_RELAY, undefined, 'screened');
    const a = resolve(base, withCalledNumber(withCallerNumber(startEvent(), MOBILE), CALLED), null, tc);
    const b = resolve(base, startEvent(), null, tc);
    expect(a.session).toEqual(b.session);
    expect(a.audit).toEqual(b.audit);
    expect(a.gateEvents).toEqual([]);
    expect('callerNumber' in a.session || 'calledNumber' in a.session).toBe(false);
  });

  it('an app that opts in with use: hint alone sends the model exactly what a call from no number sends', async () => {
    // The fixture with no lookup and no offer: the number is kept for the code, and nothing else changes.
    const hintOnly = variant('texting-hint', (app) => ({ callerNumber: { use: 'hint' }, slots: { ...app.slots, textTo: { ...app.slots.textTo!, callerNumber: undefined } } }));
    use(hintOnly);
    const steps = says(...OPENER, 'five five five five five five zero one nine nine');
    const askedWith: JevRequest[] = [];
    const askedWithout: JevRequest[] = [];
    const withNumber = await call({ callerNumber: MOBILE, asked: askedWith }, ...steps);
    await call({ asked: askedWithout }, ...steps);
    expect(JSON.stringify(askedWith)).toBe(JSON.stringify(askedWithout));
    expect(JSON.stringify(askedWith)).not.toContain('0142');
    expect(withNumber.runs[0]!.result.session.callerNumber).toBe(MOBILE);
    expect(withNumber.runs[0]!.result.gateEvents).toEqual([]);
  });
});

describe('the accessors', () => {
  const tc = (): TurnContext => ({ nowMs: 0, todayIso: TODAY, thresholds: { ...DEFAULT_THRESHOLDS }, tools: { ...textingApp.systems(), codes: mockCodeVerifier } });

  it('give the app the number calling, with its last four, and the number called', () => {
    const t = resolve(newSession('s', 0, VOICE_RELAY, undefined, 'texting'), withCalledNumber(withCallerNumber(startEvent(), ' +1 (555) 555-0142 '), CALLED), null, tc());
    expect(callerOf(t.session)).toEqual({ number: MOBILE, last4: '0142' });
    expect(calledOf(t.session)).toBe(CALLED);
  });

  it('are null on a call with no number, on a chat, and for an app that does not opt in', async () => {
    expect(callerOf(resolve(newSession('s', 0, VOICE_RELAY, undefined, 'texting'), startEvent(), null, tc()).session)).toBeNull();
    const chat = await call({ as: 'web', callerNumber: MOBILE, calledNumber: CALLED }, ...says(OPENER[0]));
    expect([callerOf(last(chat).session), calledOf(last(chat).session)]).toEqual([null, null]);
    // The callback fixture keeps the number for its offer only: it is no number for the app's code.
    use(callbackApp);
    const offering = await call({ callerNumber: MOBILE, client: stub([], callbackCorpus) });
    expect(offering.runs[0]!.result.session.callerNumber).toBe(MOBILE);
    expect(callerOf(offering.runs[0]!.result.session)).toBeNull();
    // An app that keeps the caller's number but not the one called.
    const noCalled = variant('texting-no-called', () => ({ callerNumber: { use: 'hint', lookup: 'findCallerByPhone' } }));
    use(noCalled);
    const r = await call({ callerNumber: MOBILE, calledNumber: CALLED });
    expect([callerOf(r.runs[0]!.result.session)?.last4, calledOf(r.runs[0]!.result.session), 'calledNumber' in r.runs[0]!.result.session]).toEqual(['0142', null, false]);
  });
});

describe('the call-start lookup', () => {
  it('is made once, before the greeting, through the gate as the caller not yet proven, and its result goes to the facts', async () => {
    const r = await call({ callerNumber: MOBILE }, ...says(...OPENER));
    const start = r.runs[0]!.result;
    expect(promptOf(start)).toBe('greeting');
    expect(start.gateEvents).toHaveLength(1);
    const lookup = start.gateEvents[0]!;
    expect(lookup.decision).toMatchObject({ verdict: 'ALLOW', call: { tool: 'findCallerByPhone', purpose: CALLER_LOOKUP_PURPOSE } });
    expect(CALLER_LOOKUP_PURPOSE).toBe('caller-lookup');
    // The param as recorded: by its last four (policy.yaml's audit: callerNumber: last4).
    expect(lookup.decision.call.params).toEqual({ callerNumber: '...0142' });
    expect(lookup.decision.rules.map((x) => [x.id, x.pass])).toEqual([['identity', true], ['callerNumber', true]]);
    expect((start.session.facts as TextingFacts).lineType).toBe('mobile');
    expect(isAnonymous(start.session.principal)).toBe(true);
    // Once per call: no later turn looks the number up again.
    expect(gates(r).filter((g) => g.startsWith('findCallerByPhone'))).toEqual(['findCallerByPhone:ALLOW']);
    // The audit: the gate row, masked, and the tool's own row, after the call's start.
    expect(start.audit.map((d) => d.type)).toEqual(['call_started', 'gate', 'tool_result']);
    expect(JSON.stringify(start.audit)).not.toContain('5555550142');
  });

  it('keeps nothing for a number not on file', async () => {
    const start = (await call({ callerNumber: LOOKED_UP_MOBILE })).runs[0]!.result;
    expect(start.gateEvents.map((e) => e.decision.verdict)).toEqual(['ALLOW']);
    expect(start.gateEvents[0]!.summary).toBe('no line on file');
    expect(start.session.facts).toEqual({});
  });

  it('a refusal is silent: the greeting as always, nothing kept, and the call goes on as one without a number', async () => {
    const gate = gateOf(textingApp);
    const a = gate.source.actions.findCallerByPhone!;
    const refusing = compileGate({ ...gate.source, actions: { ...gate.source.actions, findCallerByPhone: { ...a, rules: [...a.rules, { rule: 'noneOf', field: 'callerNumber', values: [MOBILE] }] } } }, gate.tables, gate.subjectKind, gate.identityTools);
    use(variant('texting-refused', () => ({ gate: refusing })));
    const r = await call({ callerNumber: MOBILE }, ...says(...OPENER));
    const start = r.runs[0]!.result;
    expect(start.decision).toEqual(resolve(newSession('s', 0, VOICE_RELAY, undefined, 'texting-refused'), startEvent(), null, { nowMs: 0, todayIso: TODAY, thresholds: { ...DEFAULT_THRESHOLDS }, tools: { ...textingApp.systems(), codes: mockCodeVerifier } }).decision);
    expect(start.gateEvents.map((e) => `${e.decision.verdict} ${e.decision.reason}`)).toEqual(['BLOCK one-of']);
    expect(start.session.facts).toEqual({});
    expect(start.session.ended).toBe(false);
    // With no line type kept, the offer asks the line-type lookup instead.
    expect(gates(r)).toContain('lineType:ALLOW');
  });

  it('is not made on a call with no usable number, nor on a chat', async () => {
    for (const from of [undefined, 'anonymous', '+7378742833']) {
      const start = (await call(from === undefined ? {} : { callerNumber: from })).runs[0]!.result;
      expect(start.gateEvents, String(from)).toEqual([]);
    }
    const chat = await call({ as: 'web', callerNumber: MOBILE });
    expect(chat.runs[0]!.result.gateEvents).toEqual([]);
  });

  it('is not made for an app that names none', async () => {
    use(variant('texting-no-lookup', () => ({ callerNumber: { use: 'hint' } })));
    const start = (await call({ callerNumber: MOBILE })).runs[0]!.result;
    expect(start.gateEvents).toEqual([]);
    expect(start.session.callerNumber).toBe(MOBILE);
  });
});

describe('the text offer', () => {
  it('is made by the last four digits, in place of the slot\'s question, for a mobile', async () => {
    const t = last(await call({ callerNumber: MOBILE }, ...says(...OPENER)));
    expect(t.decision).toMatchObject({ kind: 'prompt', promptId: 'offer_textTo', target: 'textTo', vars: { last4: '0142' } });
    expect(heard(t)).toBe(OFFER);
    expect(t.session.slots.textTo).toMatchObject({ value: null });
  });

  it('a yes fills the slot with the number, and changes neither who the caller is nor their level', async () => {
    const t = last(await call({ callerNumber: MOBILE }, ...says(...OPENER, 'yes, please text me')));
    expect(t.session.slots.textTo).toMatchObject({ value: '5555550142', confirmed: true });
    expect(promptOf(t)).toBe('confirm_open_request_text');
    expect(t.session.principal).toEqual({ kind: 'anonymous', level: 0 });
    expect(t.session.identityAttempts).toEqual({ factors: 0, code: 0 });
  });

  it('a no leaves the slot empty, declined, and the form goes on (onNo: skip)', async () => {
    const t = last(await call({ callerNumber: MOBILE }, ...says(...OPENER, 'no thanks')));
    expect(t.session.slots.textTo).toMatchObject({ value: null, declined: true, attempts: 0 });
    expect(promptOf(t)).toBe('confirm_open_request');
    expect(heard(t)).toBe("That's a request about an order, with no texts. Shall I open it?");
  });

  it('"that\'s my landline" is a no', async () => {
    const t = last(await call({ callerNumber: MOBILE }, ...says(...OPENER, "that's my landline")));
    expect(t.session.slots.textTo).toMatchObject({ value: null, declined: true });
  });

  it('a no with ask (the default) asks the slot\'s own question, with no attempt counted', async () => {
    use(withOffer('texting-ask', { ifNone: 'skip' }));
    const t = last(await call({ callerNumber: MOBILE }, ...says(...OPENER, 'no thanks')));
    expect(promptOf(t)).toBe('ask_textTo');
    expect(t.session.slots.textTo).toMatchObject({ value: null, attempts: 0 });
    expect(t.session.slots.textTo!.declined).toBeUndefined();
  });

  it('a number said with the no, or in place of a yes or no, fills the slot as said', async () => {
    for (const said of ['no, text my cell, five five five five five five zero one nine nine', 'text five five five five five five zero one nine nine instead']) {
      const t = last(await call({ callerNumber: MOBILE }, ...says(...OPENER, said)));
      expect(t.session.slots.textTo, said).toMatchObject({ value: '5555550199' });
      expect(t.session.slots.textTo!.declined, said).toBeUndefined();
      expect(promptOf(t), said).toBe('confirm_open_request_text');
    }
  });

  it('unanswered, the end of the offer\'s ladder leaves the slot empty with skip, and goes on with no handoff', async () => {
    const r = await call({ callerNumber: MOBILE }, ...says(...OPENER), { silence: true }, { silence: true });
    expect(r.runs.map((x) => promptOf(x.result))).toEqual(['greeting', 'ask_topic', 'offer_textTo', 'offer_textTo', 'confirm_open_request']);
    expect(last(r).session.slots.textTo).toMatchObject({ value: null, declined: true });
    expect(last(r).decision.kind).toBe('prompt');
  });

  it('unanswered with ask, the end of the ladder closes the offer and the slot\'s own ladder takes over', async () => {
    use(withOffer('texting-ask-unanswered', { ifNone: 'skip' }));
    const r = await call({ callerNumber: MOBILE }, ...says(...OPENER), { silence: true }, { silence: true });
    expect(promptOf(last(r))).toBe('ask_textTo_dtmf');
    expect(last(r).session.slots.textTo!.declined).toBeUndefined();
  });

  it('is refused by the app for a landline: no offer, and the slot is left empty (ifNone: skip)', async () => {
    const r = await call({ callerNumber: LANDLINE }, ...says(...OPENER));
    expect(r.runs.map((x) => promptOf(x.result))).not.toContain('offer_textTo');
    expect(last(r).session.slots.textTo).toMatchObject({ value: null, declined: true });
    expect(promptOf(last(r))).toBe('confirm_open_request');
    // The call-start lookup said landline: the hook needed no lookup of its own.
    expect(gates(r)).toEqual(['findCallerByPhone:ALLOW']);
  });

  it('the hook may ask a gated line-type lookup for a number the call-start lookup did not know, once', async () => {
    const r = await call({ callerNumber: LOOKED_UP_MOBILE }, ...says(...OPENER, 'yes, please text me', 'yes, open it'));
    expect(gates(r)).toEqual(['findCallerByPhone:ALLOW', 'lineType:ALLOW', 'openRequest:ALLOW', 'sendUpdates:ALLOW']);
    const lineType = r.runs.flatMap((x) => x.result.gateEvents).find((e) => e.decision.call.tool === 'lineType')!;
    expect(lineType.decision.call.params).toEqual({ callerNumber: '...0144' });
  });

  it('a hook that refuses with ifNone ask leaves the slot to be asked', async () => {
    use(withOffer('texting-landline-ask', { onNo: 'skip' }));
    const t = last(await call({ callerNumber: LANDLINE }, ...says(...OPENER)));
    expect(promptOf(t)).toBe('ask_textTo');
  });

  it('with no number to offer, ifNone: skip leaves the slot empty, and ifNone: ask asks it', async () => {
    for (const o of [{ callerNumber: 'anonymous' }, {}, { as: 'web' }] as CallOptions[]) {
      const t = last(await call(o, ...says(...OPENER)));
      expect(promptOf(t), JSON.stringify(o)).toBe('confirm_open_request');
      expect(t.session.slots.textTo, JSON.stringify(o)).toMatchObject({ value: null, declined: true });
    }
    use(withOffer('texting-none-asks', { onNo: 'skip' }));
    expect(promptOf(last(await call({}, ...says(...OPENER))))).toBe('ask_textTo');
  });

  it('a declined slot reopened at the summary is asked, never offered', async () => {
    const r = await call({ callerNumber: MOBILE }, ...says(...OPENER, 'no thanks', 'no, the text number is wrong'));
    const t = last(r);
    expect(promptOf(t)).toBe('ask_textTo');
    expect(t.session.slots.textTo!.declined).toBeUndefined();
    const none = last(await call({}, ...says(...OPENER, 'no, the text number is wrong')));
    expect(promptOf(none)).toBe('ask_textTo');
  });
});

describe('the gate\'s callerNumber rule on the fixture', () => {
  it('passes the caller\'s own number, and another the caller heard read back and said yes to', async () => {
    expect(gates(await call({ callerNumber: MOBILE }, ...says(...OPENER, 'yes, please text me', 'yes, open it')))).toContain('sendUpdates:ALLOW');
    const other = await call({ callerNumber: MOBILE }, ...says(...OPENER, 'no, text my cell, five five five five five five zero one nine nine', 'yes, open it'));
    const send = other.runs.flatMap((x) => x.result.gateEvents).find((e) => e.decision.call.tool === 'sendUpdates')!;
    expect(send.decision.verdict).toBe('ALLOW');
    expect(send.decision.rules.find((x) => x.id === 'callerNumber')).toMatchObject({ pass: true, compared: 'textTo is not the caller\'s number, but a number the caller confirmed' });
    expect(JSON.stringify(send.decision)).not.toContain('5555550199');
  });
});

describe('the offer audit row', () => {
  it('is written once for each settled offer, with the line as said, the answer and how it was given', async () => {
    expect(offers(await call({ callerNumber: MOBILE }, ...says(...OPENER, 'yes, please text me')))).toEqual([
      { slot: 'textTo', source: 'caller-number', promptId: 'offer_textTo', said: OFFER, answer: 'yes', by: 'speech', last4: '0142', locale: 'en-US' },
    ]);
    expect(offers(await call({ callerNumber: MOBILE }, ...says(...OPENER, 'no thanks'))).map((d) => d.answer)).toEqual(['no']);
    expect(offers(await call({ callerNumber: MOBILE }, ...says(...OPENER, 'no, text my cell, five five five five five five zero one nine nine'))).map((d) => d.answer)).toEqual(['other']);
    expect(offers(await call({ callerNumber: MOBILE }, ...says(...OPENER), { dtmf: '5555550199' }))).toMatchObject([{ answer: 'other', by: 'keypad' }]);
    expect(offers(await call({ callerNumber: MOBILE }, ...says(...OPENER), { silence: true }, { silence: true }))).toMatchObject([{ answer: 'none', by: null }]);
    // An offer re-asked is not settled, and one never made writes nothing.
    expect(offers(await call({ callerNumber: MOBILE }, ...says(...OPENER, 'hmm, which one')))).toEqual([]);
    expect(offers(await call({ callerNumber: LANDLINE }, ...says(...OPENER)))).toEqual([]);
  });

  it('comes before the gate rows of the turn that answered it, and is in the day\'s hash chain', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dialogwright-offer-'));
    scratch.push(dir);
    const audit = new AuditLog(dir, () => Date.parse(`${TODAY}T12:00:00Z`));
    const r = await call({ callerNumber: MOBILE, audit }, ...says(...OPENER, 'yes, please text me', 'yes, open it'));
    const entries: AuditEntry[] = r.runs.flatMap((x) => x.audit);
    const offer = entries.filter((e) => e.type === 'offer');
    expect(offer).toHaveLength(1);
    expect(offer[0]!.detail).toMatchObject({ answer: 'yes', said: OFFER });
    const file = join(dir, readdirSync(dir)[0]!);
    expect(verifyChain(file)).toEqual({ ok: true, entries: entries.length });
    // The answer changed after the fact, the chain breaks at it.
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    const at = lines.findIndex((l) => l.includes('"type":"offer"'));
    expect(at).toBeGreaterThan(0);
    lines[at] = lines[at]!.replace('"answer":"yes"', '"answer":"no"');
    writeFileSync(file, `${lines.join('\n')}\n`);
    expect(verifyChain(file)).toMatchObject({ ok: false, brokenAt: at + 1, why: 'hash mismatch' });
  });

  it('is written for the callback offer too, its answer what the caller said', async () => {
    use(callbackApp);
    const r = await call({ callerNumber: MOBILE, client: stub([], callbackCorpus) }, ...says('can someone call me back', 'Jordan Avery', "yes, that's fine"));
    expect(offers(r)).toEqual([
      { slot: 'phone', source: 'caller-number', promptId: 'offer_phone', said: "Is the number you're calling from, ending in 0142, the best one to reach you?", answer: 'yes', by: 'speech', last4: '0142', locale: 'en-US' },
    ]);
    const no = await call({ callerNumber: MOBILE, client: stub([], callbackCorpus) }, ...says('can someone call me back', 'Jordan Avery', 'no'));
    expect(offers(no).map((d) => d.answer)).toEqual(['no']);
  });
});

describe('the trace and the console', () => {
  it('say on the start record whether the number was kept, and mask both numbers there by their last four', async () => {
    const r = await call({ callerNumber: MOBILE, calledNumber: CALLED }, ...says(...OPENER));
    const record = r.runs[0]!.record;
    expect(record.callerNumber).toBe('kept');
    expect(record.event).toMatchObject({ callerNumber: MOBILE, calledNumber: CALLED });
    expect(redactRecordSlots(record, 'length').event).toMatchObject({ type: 'session.start', callerNumber: '...0142', calledNumber: '...0100' });
    expect(redactRecord(record).event).toMatchObject({ callerNumber: '…0142', calledNumber: '…0100' });
    for (const run of r.runs) {
      expect(JSON.stringify(redactRecordSlots(run.record, 'length'))).not.toMatch(/5555550142|5555550100/);
      expect(JSON.stringify(redactRecord(run.record))).not.toMatch(/5555550142|5555550100/);
    }
    expect((await call({ callerNumber: 'anonymous' })).runs[0]!.record.callerNumber).toBe('none');
    expect(redactDeep({ calledNumber: CALLED })).toEqual({ calledNumber: '…0100' });
  });

  it('replay stands a ten-digit number in for an app that keeps the number for its code only', () => {
    const hintOnly = variant('texting-hint-replay', (app) => ({ callerNumber: { use: 'hint' }, slots: { ...app.slots, textTo: { ...app.slots.textTo!, callerNumber: undefined } } }));
    expect(standInCallerNumber(hintOnly, '0142')).toBe('5555550142');
    expect(standInCallerNumber(textingApp, '0142')).toBe('5555550142');
    expect(standInCallerNumber(screenedApp, '0142')).toBeUndefined();
  });
});

describe('the fixture\'s scripted calls', () => {
  const scenarios: Scenario[] = loadScenarios(join(FIXTURES, 'scenarios'));
  it('has one for each case', () => {
    expect(scenarios.map((s) => s.id)).toEqual([
      'text-yes', 'text-no-skips', 'text-no-with-a-number', 'text-unanswered-skips', 'text-landline-not-offered', 'text-line-type-looked-up', 'text-withheld-not-offered', 'text-chat-not-offered', 'text-number-changed-at-the-summary',
    ]);
  });
  for (const scenario of scenarios) {
    it(`${scenario.id} meets its expectation`, async () => {
      const r = await runScenario(scenario, { client: stub(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, now: () => 0 });
      expect(r.mismatches).toEqual([]);
      expect(r.pass).toBe(true);
    });
  }
  it('sends no text but to the number the caller said yes to', async () => {
    const tools = { ...textingApp.systems(), codes: mockCodeVerifier };
    const sys = tools.sys as TextingSystems;
    for (const s of scenarios) await runScenario(s, { client: stub(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, now: () => 0, tools });
    expect(sys.texts.map((x) => x.to)).toEqual(['5555550142', '5555550199', '5555550144', '5555550199']);
  });
});
