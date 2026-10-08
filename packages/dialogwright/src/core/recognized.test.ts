import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { loadScenarios, runCorpusEntry, runScenario, type Scenario, type ScenarioRun } from '../harness-text/runner';
import { loadCorpus, parseCorpus } from '../jev/corpus';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import type { JevClient, JevRequest } from '../jev/types';
import { spokenText } from '../prompts/render';
import { registerApp, resetAppsForTest } from './app/registry';
import type { App } from './app/types';
import type { AppCode } from '../define/defineApp';
import { DEFAULT_THRESHOLDS } from './thresholds';
import { appTurnContext, slotContext, type TurnResult } from './turn';
import { sessionRoundTrip } from '../testing/sessionRoundTrip';
import { RECOGNIZED_DIR, recognizedApp, recognizedCode } from '../testing/recognized/app';
import { CODE, GREETING, codeCode, recognizedVariants, replace } from '../testing/recognized/variant';
import { proposalsCode, type ProposalFacts } from '../testing/proposals/app';
import { GREETING as PROPOSAL_GREETING, proposalsVariants } from '../testing/proposals/variant';
import { proposalsApp } from '../testing/proposals/app';
import { textingApp } from '../testing/texting/app';
import { callbackApp } from '../testing/callback/app';
import { screenedApp } from '../testing/screened/app';
import { testkitApp } from '../testing/testkit';
import { mockCodeVerifier } from './tools';
import { redactRecordSlots } from '../trace/redact';
import { redactRecord } from '../server/dashboard/events';
import { buildQuestions } from './questions';
import { newSession } from './session';
import { VOICE_RELAY } from '../channel/caps';

/**
 * A caller-ID match as the identifier (identity.yaml's level 1 `callerId`, FactsConfig.callerMatch):
 * on a call from a number the call-start lookup matched to one account, the caller is asked only for
 * the date of birth, which verifies it with the account the match found, through the same verify tool
 * and gate. On the engine's fixture for it, Example Account Line (src/testing/recognized). "Different
 * account", a no or a failed check fall back to the account number and the date of birth, and the
 * match is not used again on the call. Never identity on its own.
 */

const TODAY = '2026-10-08';
const FIXTURES = join(RECOGNIZED_DIR, 'fixtures');
const corpus = loadCorpus(join(FIXTURES, 'corpus.jsonl'), recognizedApp);

function stub(asked: JevRequest[] = [], lines = corpus): JevClient {
  const inner = new FixtureStubClient(lines, { sharpness: DEFAULT_THRESHOLDS.STUB_SHARPNESS, fallback: new HeuristicStubClient({ todayIso: TODAY }) });
  return { ask: (req) => { asked.push(req); return inner.ask(req); } };
}

function use(app: App): void {
  resetAppsForTest();
  registerApp(app);
}

beforeEach(() => use(recognizedApp));

/** On file for Avery's account alone. */
const AVERY = '+15555550142';
/** On file for two accounts: no single match. */
const SHARED = '+15555550144';
/** Not on file. */
const NOT_ON_FILE = '+15555550199';
const STATUS = 'I want to check on my request';
const REPORT = "I'd like to report a problem";
const AVERY_DOB = 'April twelfth nineteen eighty';
const WRONG_DOB = 'June first nineteen ninety';
const MORGAN_ID = 'five five five zero five six seven eight';
const MORGAN_DOB = 'June fourteenth nineteen seventy five';
const MATCH = "I see an account associated with the number you're calling from. To access it, please tell me your date of birth, or say different account.";

interface CallOptions {
  callerNumber?: string;
  as?: string;
  asked?: JevRequest[];
  lines?: typeof corpus;
}

/** A call: the greeting, then each step in turn. */
async function call(o: CallOptions, ...steps: Scenario['steps']): Promise<ScenarioRun> {
  const scenario: Scenario = {
    id: 'call', steps, expect: { decision: 'any' },
    ...(o.callerNumber !== undefined ? { callerNumber: o.callerNumber } : {}),
    ...(o.as !== undefined ? { as: o.as } : {}),
  };
  return runScenario(scenario, { client: stub(o.asked, o.lines), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, now: () => 0, tools: { ...recognizedApp.systems(), codes: mockCodeVerifier } });
}
const says = (...lines: string[]): Scenario['steps'] => lines.map((say) => ({ say }));

const last = (r: ScenarioRun): TurnResult => r.runs.at(-1)!.result;
const heard = (t: TurnResult, app: App = recognizedApp): string => spokenText(app, t.decision);
const promptOf = (t: TurnResult): string | undefined => ('promptId' in t.decision ? t.decision.promptId : undefined);
const prompts = (r: ScenarioRun): (string | undefined)[] => r.runs.map((x) => promptOf(x.result));
const rows = (r: ScenarioRun, type: string) => r.runs.flatMap((x) => x.result.audit.filter((d) => d.type === type).map((d) => d.detail));
const verifyCalls = (r: ScenarioRun) => r.runs.flatMap((x) => x.result.gateEvents.filter((e) => e.decision.call.tool === 'verifyCustomer'));

describe('the caller-ID question: the worked example', () => {
  it('is asked in place of the account number when identity is needed, naming nothing of the account', async () => {
    const r = await call({ callerNumber: AVERY }, ...says(STATUS));
    // The greeting is as always: on-need asks nothing until something needs level 1.
    expect(promptOf(r.runs[0]!.result)).toBe('greeting');
    const t = last(r);
    expect(t.decision).toMatchObject({ kind: 'prompt', promptId: 'identity_caller_match', target: 'dob', vars: {} });
    expect(heard(t)).toBe(`Sure, I can help you check on a request. ${MATCH}`);
    expect(t.session.callerMatch).toBe('offered');
    expect(t.session.slots.accountId!.value).toBeNull();
    expect(t.session.stepUp).toMatchObject({ need: 1 });
    expect(rows(r, 'identity_caller_match')).toEqual([{ outcome: 'offered', callerNumber: '...0142' }]);
  });

  it('the date of birth verifies, with the account the match found, through the same check', async () => {
    const r = await call({ callerNumber: AVERY }, ...says(STATUS, AVERY_DOB));
    const t = last(r);
    expect(t.session.principal).toEqual({ kind: 'customer', level: 1, id: '55501234', first: 'Avery', via: 'caller-id' });
    expect(heard(t)).toBe("Thank you, Avery. You're verified. Your latest request, P100, is open. Is there anything else I can help with?");
    expect(t.session.callerMatch).toBe('verified');
    // The account number was filled from the match, not said: a value and no display.
    expect(t.session.slots.accountId).toMatchObject({ value: '55501234', display: null, by: 'caller-id' });
    expect(t.session.slots.dob).toMatchObject({ value: '1980-04-12' });
    expect(t.session.slots.dob!.by).toBeUndefined();
    // The verify call is a gate event as any other, its params recorded as the slots' redact says.
    const [verify] = verifyCalls(r);
    expect(verify!.decision).toMatchObject({ verdict: 'ALLOW', call: { tool: 'verifyCustomer', params: { accountId: '...1234', dob: '•' } } });
    expect(t.session.identityAttempts).toEqual({ factors: 0, code: 0 });
  });

  it('the audit: the app\'s identity row says how, and the engine\'s row says verified, never the identifier', async () => {
    const r = await call({ callerNumber: AVERY }, ...says(STATUS, AVERY_DOB));
    expect(rows(r, 'identity')).toEqual([{ factor: 'account_id_dob', pass: true, level: 1, via: 'caller-id' }]);
    expect(rows(r, 'identity_caller_match')).toEqual([{ outcome: 'offered', callerNumber: '...0142' }, { outcome: 'verified', callerNumber: '...0142' }]);
    const audit = JSON.stringify(r.runs.map((x) => x.result.audit));
    expect(audit).not.toContain('55501234');
    expect(audit).not.toContain('5555550142');
    // The turn's rows in order: the check, then what it settled.
    const types = last(r).audit.map((d) => d.type);
    expect(types.indexOf('identity')).toBeLessThan(types.indexOf('identity_caller_match'));
  });

  it('a date given on the way in verifies with the match, with no question asked', async () => {
    const r = await call({ callerNumber: AVERY }, ...says('I want to check on my request, my birthday is April twelfth nineteen eighty'));
    expect(last(r).session.principal).toMatchObject({ level: 1, id: '55501234', via: 'caller-id' });
    expect(rows(r, 'identity_caller_match')).toEqual([{ outcome: 'verified', callerNumber: '...0142' }]);
  });

  it('an account number the caller says themselves is theirs to verify: the match does not replace it', async () => {
    const r = await call({ callerNumber: AVERY }, ...says('I want to check on my request, my account is five five five zero five six seven eight', MORGAN_DOB));
    expect(prompts(r)).toEqual(['greeting', 'ask_dob', 'anything_else']);
    expect(last(r).session.principal).toMatchObject({ level: 1, id: '55505678' });
    expect(last(r).session.principal).not.toHaveProperty('via');
    expect(rows(r, 'identity_caller_match')).toEqual([]);
  });
});

describe('"different account" or a no', () => {
  it('sets the match aside and asks the account number, after the optional line', async () => {
    for (const said of ['different account', "no, that's not me"]) {
      const r = await call({ callerNumber: AVERY }, ...says(STATUS, said));
      const t = last(r);
      expect(promptOf(t), said).toBe('ask_accountId');
      expect(heard(t), said).toBe("Okay, let's find your account. What's your eight digit account number?");
      expect(t.session.callerMatch, said).toBe('declined');
      expect(t.session.identityAttempts.factors, said).toBe(0);
      expect(rows(r, 'identity_caller_match').map((d) => d.outcome), said).toEqual(['offered', 'declined']);
    }
  });

  it('then the normal ladder verifies the other account, with no via', async () => {
    const r = await call({ callerNumber: AVERY }, ...says(STATUS, 'different account', MORGAN_ID, MORGAN_DOB));
    expect(prompts(r)).toEqual(['greeting', 'identity_caller_match', 'ask_accountId', 'ask_dob', 'anything_else']);
    expect(last(r).session.principal).toEqual({ kind: 'customer', level: 1, id: '55505678', first: 'Morgan' });
    expect(rows(r, 'identity')).toEqual([{ factor: 'account_id_dob', pass: true, level: 1 }]);
  });

  it('without identity_caller_declined in prompts.yaml, the account number is asked alone', async () => {
    const variants = recognizedVariants();
    try {
      const plain = variants.variant({
        'app.yaml': replace('id: recognized', 'id: recognized-plain'),
        'prompts.yaml': replace("  identity_caller_declined:\n    text: Okay, let's find your account.\n    interruptible: false\n", ''),
      });
      use(plain);
      const t = last(await call({ callerNumber: AVERY }, ...says(STATUS, 'different account')));
      expect(heard(t, plain)).toBe("What's your eight digit account number?");
    } finally {
      variants.remove();
    }
  });

  it('the match is not asked again on the call: a missed answer at the account number walks its own ladder', async () => {
    const r = await call({ callerNumber: AVERY }, ...says(STATUS, 'different account', 'hmm, which account is that'));
    expect(promptOf(last(r))).toBe('ask_accountId_retry');
    expect(last(r).session.callerMatch).toBe('declined');
  });
});

describe('a failed check', () => {
  it('counts one attempt, empties the factors, sets the match aside and asks the account number', async () => {
    const r = await call({ callerNumber: AVERY }, ...says(STATUS, WRONG_DOB));
    const t = last(r);
    expect(promptOf(t)).toBe('ask_accountId');
    expect(heard(t)).toBe("I couldn't match those details. Let's try again. What's your eight digit account number?");
    expect(t.session.identityAttempts.factors).toBe(1);
    expect(t.session.callerMatch).toBe('failed');
    expect(t.session.slots.accountId).toMatchObject({ value: null, display: null });
    expect(t.session.slots.accountId!.by).toBeUndefined();
    expect(t.session.slots.dob!.value).toBeNull();
    expect(rows(r, 'identity')).toEqual([{ factor: 'account_id_dob', pass: false, level: 0 }]);
    expect(rows(r, 'identity_caller_match').map((d) => d.outcome)).toEqual(['offered', 'failed']);
  });

  it('then both factors verify as on any call', async () => {
    const r = await call({ callerNumber: AVERY }, ...says(STATUS, WRONG_DOB, MORGAN_ID, MORGAN_DOB));
    expect(prompts(r)).toEqual(['greeting', 'identity_caller_match', 'ask_accountId', 'ask_dob', 'anything_else']);
    expect(last(r).session.principal).toMatchObject({ id: '55505678' });
    expect(last(r).session.principal).not.toHaveProperty('via');
  });
});

describe('no match: the normal ladder', () => {
  it('a number not on file, none, a withheld one, a number two accounts share, and a chat', async () => {
    for (const o of [{ callerNumber: NOT_ON_FILE }, {}, { callerNumber: 'anonymous' }, { callerNumber: SHARED }] as CallOptions[]) {
      const r = await call(o, ...says(STATUS));
      expect(promptOf(last(r)), JSON.stringify(o)).toBe('ask_accountId');
      expect(last(r).session.callerMatch, JSON.stringify(o)).toBeUndefined();
      expect(rows(r, 'identity_caller_match'), JSON.stringify(o)).toEqual([]);
    }
  });

  it('a hook that throws, or a match that is not a string, is no match', async () => {
    for (const callerMatch of [() => { throw new Error('55501234'); }, () => ({ accountId: '' }), () => ({ other: '55501234' })]) {
      const code: AppCode = { ...recognizedCode, facts: { ...recognizedCode.facts!, callerMatch: callerMatch as never } };
      const app = { ...recognizedApp, facts: code.facts } as App;
      use(app);
      const r = await call({ callerNumber: AVERY }, ...says(STATUS));
      expect(promptOf(last(r))).toBe('ask_accountId');
    }
  });

  it('a report needs no identity, so nothing is asked whatever the number', async () => {
    const r = await call({ callerNumber: AVERY }, ...says(REPORT, 'nothing is working at all', 'yes, file it'));
    expect(prompts(r)).toEqual(['greeting', 'ask_problem', 'confirm_report_problem', 'anything_else']);
    expect(rows(r, 'identity_caller_match')).toEqual([]);
  });
});

describe('the model request', () => {
  it('asks whether the caller turned the match down only at the question, and never asks for the account number there', async () => {
    const asked: JevRequest[] = [];
    await call({ callerNumber: AVERY, asked }, ...says(STATUS, AVERY_DOB));
    const [opening, answer] = asked;
    expect(Object.keys(opening!.questions)).not.toContain('callerMatchDeclined');
    expect(Object.keys(answer!.questions)).toContain('callerMatchDeclined');
    expect(Object.keys(answer!.questions).some((id) => id.startsWith('accountId'))).toBe(false);
    expect(Object.keys(answer!.questions).some((id) => id.startsWith('dob'))).toBe(true);
  });

  it('after "different account", every factor listens again and the question is not asked', async () => {
    const asked: JevRequest[] = [];
    await call({ callerNumber: AVERY, asked }, ...says(STATUS, 'different account', MORGAN_ID));
    const atAccount = asked.at(-1)!;
    expect(Object.keys(atAccount.questions)).not.toContain('callerMatchDeclined');
    expect(Object.keys(atAccount.questions).some((id) => id.startsWith('accountId'))).toBe(true);
  });

  it('never carries the identifier the match found', async () => {
    const asked: JevRequest[] = [];
    await call({ callerNumber: AVERY, asked }, ...says(STATUS, AVERY_DOB, 'that\'s all, thanks'));
    const state = JSON.stringify(asked);
    for (const never of ['55501234', '5550 1234', '1234"']) expect(state, never).not.toContain(never);
  });

  it('is what it always was for every app without callerId', () => {
    for (const app of [testkitApp, screenedApp, callbackApp, textingApp, proposalsApp]) {
      use(app);
      const s = newSession('q', 0, VOICE_RELAY, undefined, app.id);
      s.callerMatch = 'offered';
      s.promptedFor = app.identity?.factorSlots[1] ?? null;
      expect(Object.keys(buildQuestions(s, slotContext(s, '', appTurnContext(app, { nowMs: 0, todayIso: TODAY, thresholds: { ...DEFAULT_THRESHOLDS }, tools: { ...app.systems(), codes: mockCodeVerifier } })))), app.id).not.toContain('callerMatchDeclined');
      expect(app.identity?.callerId, app.id).toBeUndefined();
      expect(app.facts?.callerMatch, app.id).toBeUndefined();
    }
  });
});

describe('the trace, the console and the prompt variables', () => {
  it('show the identifier no more than a spoken one: masked as the slot\'s redact says, and in no line or variable', async () => {
    const r = await call({ callerNumber: AVERY }, ...says(STATUS, AVERY_DOB));
    // The raw record has it (the session's slot, the verify call): the trace writer and the console mask it.
    expect(JSON.stringify(r.runs.map((x) => x.record))).toContain('55501234');
    for (const run of r.runs) {
      expect(JSON.stringify(redactRecordSlots(run.record, 'length'))).not.toContain('55501234');
      expect(JSON.stringify(redactRecord(run.record))).not.toContain('55501234');
      const d = run.result.decision;
      if (d.kind === 'prompt') {
        expect(JSON.stringify(d.vars)).not.toContain('1234');
        expect(JSON.stringify(d.acks)).not.toContain('1234');
      }
      expect(JSON.stringify(run.result.actions)).not.toContain('1234');
    }
  });
});

describe('the retry ladder at the question', () => {
  it('a silence asks the caller-ID question again; a missed answer walks the date of birth\'s own ladder', async () => {
    const r = await call({ callerNumber: AVERY }, ...says(STATUS), { silence: true }, { say: 'hmm, which account is that' });
    expect(prompts(r)).toEqual(['greeting', 'identity_caller_match', 'identity_caller_match', 'ask_dob_dtmf']);
    expect(heard(r.runs[2]!.result)).toBe(`I didn't hear anything. ${MATCH}`);
    // The match still stands at the retry: a date there verifies with it.
    const later = await call({ callerNumber: AVERY }, ...says(STATUS, 'hmm, which account is that', AVERY_DOB));
    expect(last(later).session.principal).toMatchObject({ via: 'caller-id' });
  });

  it('a date keyed at the question verifies as one said', async () => {
    const r = await call({ callerNumber: AVERY }, ...says(STATUS), ...'04121980'.split('').map((dtmf) => ({ dtmf })));
    expect(last(r).session.principal).toMatchObject({ level: 1, id: '55501234', via: 'caller-id' });
  });
});

describe('the caller-ID question at the greeting (ask: greeting)', () => {
  const variants = recognizedVariants();
  afterAll(() => variants.remove());
  const greeting = variants.variant(GREETING);
  const lines = loadCorpus(join(variants.dirOf(greeting), 'fixtures', 'corpus.jsonl'), greeting);
  beforeEach(() => use(greeting));
  const heardIn = (t: TurnResult): string => spokenText(greeting, t.decision);
  const ASK = 'What can I help you with today?';

  it('a call from a matched number opens on it, in place of the open question', async () => {
    const r = await call({ callerNumber: AVERY, lines });
    const t = last(r);
    expect(t.decision).toMatchObject({ kind: 'prompt', promptId: 'identity_caller_match', target: 'dob', vars: {} });
    expect(heardIn(t)).toBe(`Thanks for calling Example Account Line. ${MATCH}`);
    expect(t.session.stepUp).toMatchObject({ at: 'greeting', need: 1 });
    expect(t.session.form).toBeNull();
    expect(rows(r, 'identity_caller_match')).toEqual([{ outcome: 'offered', callerNumber: '...0142' }]);
  });

  it('with no match the greeting is as always', async () => {
    for (const o of [{ callerNumber: NOT_ON_FILE }, { callerNumber: SHARED }, {}] as CallOptions[]) {
      const t = last(await call({ ...o, lines }));
      expect(promptOf(t), JSON.stringify(o)).toBe('greeting');
      expect(t.session.stepUp, JSON.stringify(o)).toBeNull();
    }
  });

  it('a date verifies, and the open question follows; a protected request then asks nothing more', async () => {
    const r = await call({ callerNumber: AVERY, lines }, ...says(`it's ${AVERY_DOB}`, STATUS));
    const verified = r.runs[1]!.result;
    expect(promptOf(verified)).toBe('greet_after_offer');
    expect(heardIn(verified)).toBe(`Thank you, Avery. You're verified. ${ASK}`);
    expect(verified.session.principal).toMatchObject({ level: 1, via: 'caller-id' });
    expect(verified.session.stepUp).toBeNull();
    expect(heardIn(last(r))).toContain('Your latest request, P100, is open.');
  });

  it('"different account" asks every factor at once, then the open question', async () => {
    const r = await call({ callerNumber: AVERY, lines }, ...says("it's a different account", MORGAN_ID, MORGAN_DOB));
    expect(prompts(r)).toEqual(['identity_caller_match', 'ask_accountId', 'ask_dob', 'greet_after_offer']);
    expect(heardIn(r.runs[1]!.result)).toBe("Okay, let's find your account. What's your eight digit account number?");
    expect(last(r).session.principal).toEqual({ kind: 'customer', level: 1, id: '55505678', first: 'Morgan' });
    expect(last(r).session.form).toBeNull();
  });

  it('a request instead goes on, and the match is kept for when identity is needed', async () => {
    const r = await call({ callerNumber: AVERY, lines }, ...says('I just want to report a problem', 'nothing is working at all', 'yes, file it', 'and can you check on my request', AVERY_DOB));
    expect(prompts(r)).toEqual(['identity_caller_match', 'ask_problem', 'confirm_report_problem', 'anything_else', 'identity_caller_match', 'anything_else']);
    expect(last(r).session.principal).toMatchObject({ via: 'caller-id' });
  });

  it('a wrong date asks every factor, from the first, with the failed line', async () => {
    const r = await call({ callerNumber: AVERY, lines }, ...says(WRONG_DOB));
    expect(promptOf(last(r))).toBe('ask_accountId');
    expect(last(r).session.callerMatch).toBe('failed');
    expect(last(r).session.identityAttempts.factors).toBe(1);
  });

  it('corpus lines at it are seeded with the question just asked', async () => {
    const outcome = async (id: string) => (await runCorpusEntry(lines.find((e) => e.id === id)!, { client: stub([], lines), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, now: () => 0 })).outcome;
    expect(await outcome('gm-01')).toMatchObject({ promptId: 'greet_after_offer', principalLevel: 1 });
    expect(await outcome('gm-02')).toMatchObject({ promptId: 'ask_accountId', principalLevel: 0 });
    expect(await outcome('gm-03')).toMatchObject({ promptId: 'ask_problem', form: 'report_problem' });
  });
});

describe('beside a proposal at the greeting', () => {
  // The proposals fixture with the caller-ID question at the greeting as well: its lookup returns the
  // account too, and its facts read the match from it.
  const variants = proposalsVariants();
  afterAll(() => variants.remove());
  const code: AppCode = {
    ...proposalsCode,
    tools: {
      ...proposalsCode.tools,
      findAccountByPhone: { params: ['callerNumber'], run: (c) => (c.params.callerNumber === AVERY ? { value: { serviceAddress: '22 Alder Street', accountId: '55501234' }, summary: 'found' } : { value: null, summary: 'none' }) },
    },
    facts: {
      ...proposalsCode.facts!,
      fromCallerLookup(f, value) {
        const v = value as { serviceAddress: string; accountId: string };
        Object.assign(f, { serviceAddress: v.serviceAddress, accountId: v.accountId });
      },
      callerMatch: (f) => (typeof (f as ProposalFacts & { accountId?: string }).accountId === 'string' ? { accountId: (f as { accountId: string }).accountId } : null),
    },
  };
  const both = variants.variant({
    ...PROPOSAL_GREETING,
    'app.yaml': (t) => PROPOSAL_GREETING['app.yaml']!(t).replace('id: proposals-greeting', 'id: proposals-both'),
    'identity.yaml': replace('failedPrompt: identity_failed }', 'failedPrompt: identity_failed, callerId: { identifies: [accountId], ask: greeting } }'),
    'prompts.yaml': (t) => `${PROPOSAL_GREETING['prompts.yaml']!(t)}  identity_caller_match:\n    text: ${MATCH}\n    interruptible: true\n`,
  }, code);
  const lines = loadCorpus(join(variants.dirOf(both), 'fixtures', 'corpus.jsonl'), both);
  beforeEach(() => use(both));

  it('the caller-ID question wins at the greeting, and the proposal is made at its slot instead', async () => {
    const r = await call({ callerNumber: AVERY, lines }, ...says(REPORT));
    expect(prompts(r)).toEqual(['identity_caller_match', 'offer_place']);
    expect(r.runs[0]!.result.session.greetingOffered).toBeUndefined();
    expect(r.runs[0]!.result.session.pendingConfirmation).toBeNull();
  });
});

describe('level 2 still needs the code', () => {
  const variants = recognizedVariants();
  afterAll(() => variants.remove());
  const withCode = variants.variant(CODE, codeCode);

  it('the match and the date of birth reach level 1, and the code is sent and asked for', async () => {
    use(withCode);
    const r = await call({ callerNumber: AVERY }, ...says(STATUS, AVERY_DOB));
    const t = last(r);
    expect(promptOf(t)).toBe('ask_otp');
    expect(heard(t, withCode)).toMatch(/^Thank you, Avery\. You're verified\. I've texted a six-digit code to the phone ending in/);
    expect(t.session.principal).toMatchObject({ level: 1, via: 'caller-id' });
    expect(r.runs.flatMap((x) => x.result.gateEvents.map((e) => `${e.decision.call.tool}:${e.decision.verdict}`))).toContain('sendCode:ALLOW');
  });
});

describe('a verify tool cannot claim the caller-ID route', () => {
  it('a principal it returns with via is believed without it', async () => {
    const tools = { ...recognizedCode.tools!, verifyCustomer: { ...recognizedCode.tools!.verifyCustomer!, run: () => ({ value: { ok: true, principal: { kind: 'customer', level: 1, id: '55505678', first: 'Morgan', via: 'caller-id' } }, summary: 'verified' }) } };
    use({ ...recognizedApp, tools } as App);
    const r = await call({ callerNumber: NOT_ON_FILE }, ...says(STATUS, MORGAN_ID, MORGAN_DOB));
    expect(last(r).session.principal).toEqual({ kind: 'customer', level: 1, id: '55505678', first: 'Morgan' });
  });
});

describe('the fixture\'s corpus at the question', () => {
  it('is seeded with the question just asked on a step-up, and replays the date, a no and words that answer neither', async () => {
    const outcome = async (id: string) => (await runCorpusEntry(corpus.find((e) => e.id === id)!, { client: stub(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, now: () => 0 })).outcome;
    expect(await outcome('cm-01')).toMatchObject({ promptId: 'anything_else', principalLevel: 1 });
    expect(await outcome('cm-02')).toMatchObject({ promptId: 'ask_accountId', principalLevel: 0 });
    expect(await outcome('cm-03')).toMatchObject({ promptId: 'ask_accountId', principalLevel: 0 });
    expect(await outcome('cm-04')).toMatchObject({ promptId: 'ask_accountId', principalLevel: 0 });
    expect(await outcome('cm-05')).toMatchObject({ promptId: 'ask_dob_retry', principalLevel: 0 });
  });

  it('refuses a yes there: the question asks for a factor', () => {
    const yes = '{"id":"x","text":"yes","intent":"none","context":"check_status","prompted":"dob","confirm":"yes"}';
    expect(() => parseCorpus(yes, recognizedApp)).toThrow(/asks for a factor, not a yes/);
  });
});

describe('the fixture\'s scripted calls', () => {
  const scenarios: Scenario[] = loadScenarios(join(FIXTURES, 'scenarios'));
  it('has one for each case', () => {
    expect(scenarios.map((s) => s.id)).toEqual([
      'match-verified', 'match-different-account', 'match-wrong-date', 'no-match-not-on-file', 'no-match-withheld', 'no-match-shared-number', 'report-needs-no-identity',
    ]);
  });
  for (const scenario of scenarios) {
    it(`${scenario.id} meets its expectation`, async () => {
      const r = await runScenario(scenario, { client: stub(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, now: () => 0 });
      expect(r.mismatches).toEqual([]);
      expect(r.pass).toBe(true);
    });
  }
});

describe('a saved session resumes exactly, on the fixture', () => {
  it('runs every corpus entry and scripted call as the live session does, at every turn', async () => {
    const report = await sessionRoundTrip('stub');
    expect(report.mismatches).toEqual([]);
    expect(report.turns).toBeGreaterThan(40);
  }, 60_000);
});

