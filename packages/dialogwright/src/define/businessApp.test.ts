import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { gateOf } from '../core/app/lookup';
import type { App, Completion, CompletionContext } from '../core/app/types';
import type { GateFacts, ToolCall } from '../gate/types';
import { registerApp, resetAppsForTest } from '../core/app/registry';
import { newSession } from '../core/session';
import { VOICE_RELAY } from '../channel/caps';
import { confirmationHash } from '../gate/lines';
import { ANONYMOUS } from '../gate/principal';
import type { Principal } from '../gate/types';
import type { LibrarySlotSpec } from '../slots/types';
import { parseCorpus } from '../jev/corpus';
import { mockCodeVerifier } from '../core/tools';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import type { JevClient } from '../jev/types';
import { runScenario, type ScenarioRun } from '../harness-text/runner';
import { spokenText } from '../prompts/render';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import type { TurnResult } from '../core/turn';
import { expectAppMap, expectPolicyCard, expectPolicyMatrix, policyInvariants, runRuleExamples } from '../testing/index';
import { factsOf } from './business';
import { BUSINESS_TOOLS } from './businessFiles';
import { checkApp } from './check';
import { AppDefinitionError, defineApp, type AppCode } from './defineApp';
import { businessSchema } from './schema/business';
import { BUSINESS_FIXTURE_DIR, businessFixtureApp, businessFixtureCode, TOOLS } from './__fixtures__/business/app';

/**
 * The app the engine builds from business.yaml (an app in agent mode), on the fixture business (an
 * invented library): its intents, forms, slots, prompts, policy and identity, App.mode and App.agent,
 * the gate's decisions for an unknown caller and for an account recognized by the number it calls
 * from, and its three read-back pages, written with `pnpm policy:matrix`, `policy:card` and
 * `app:diagram` on __fixtures__/business.
 */

const app = businessFixtureApp;
const business = businessSchema.parse(parse(readFileSync(join(BUSINESS_FIXTURE_DIR, 'business.yaml'), 'utf8')));
const TODAY = '2026-11-09';
const ACCOUNT_NUMBER = '+15555550142';

resetAppsForTest();
registerApp(app);

/** The gate's decision on a call, for a principal, with the facts given. */
function decide(call: ToolCall, p: Principal, facts: Partial<GateFacts> = {}) {
  return gateOf(app).evaluate(call, p, { attempts: 0, confirmedHash: null, todayIso: TODAY, ...facts }, app.systems().lookups);
}

const HOLD = { patronName: 'Avery Lane', title: 'The Quiet Harbor', copies: 'two', format: 'print', day: '2026-11-12', window: 'morning', callbackNumber: '5555550144' };
const confirmedHold = confirmationHash(HOLD, Object.keys(HOLD));

describe('the app built from business.yaml', () => {
  it('is in agent mode, with the facts, the sample replies, the forms, what the model sees and the model', () => {
    expect(app.mode).toBe('agent');
    expect(app.agent!.facts).toEqual(factsOf(business));
    expect(app.agent!.examples).toEqual(business.business.examples);
    expect(app.agent!.sees).toEqual({ booking_day: 'roomAvailability' });
    expect(app.agent!.model).toEqual({ provider: 'inception', model: 'mercury-3', effort: 'instant' });
    expect(Object.keys(app.agent!.forms)).toEqual(['request', 'booking', 'callback']);
    expect(app.agent!.forms.booking).toMatchObject({ for: 'accounts', then: ['bookRoom'] });
    expect(app.agent!.forms.request!.fields.find((f) => f.name === 'format')).toEqual({
      name: 'format', slot: 'request_format', type: 'choice', about: 'Whether they want the large print edition.', options: ['print', 'large print', 'not sure'], required: false,
    });
  });

  it('has an intent for each form, the person (the callback), repeat, done, other and none, and no keypad menu', () => {
    expect(Object.keys(app.intents)).toEqual(['request', 'booking', 'callback', 'agent', 'repeat_prompt', 'done', 'other', 'none']);
    expect(app.intents.request).toMatchObject({ kind: 'form', label: 'place a hold' });
    expect(app.intents.booking).toMatchObject({ kind: 'form', label: 'book the study room' });
    expect(app.menu).toEqual([]);
  });

  it('every field is a library slot of its type, with its check, held in <form>_<field>', () => {
    for (const [name, form] of Object.entries(app.agent!.forms)) {
      expect(app.forms[name]!.slots).toEqual(form.fields.map((f) => f.slot));
      for (const f of form.fields) {
        const spec = app.slots[f.slot] as LibrarySlotSpec;
        expect(spec.type, f.slot).toBe(f.type);
        expect(typeof spec.check, f.slot).toBe('function');
      }
    }
    // A choice field takes its options by their words, and the windows by their names.
    expect((app.slots.request_copies as LibrarySlotSpec).config).toMatchObject({ options: { one: { say: 'one' }, two: { say: 'two' }, three: { say: 'three' } } });
    expect(Object.keys((app.slots.booking_window as LibrarySlotSpec).config as { options: object }).length).toBeGreaterThan(0);
    expect(Object.keys(((app.slots.booking_window as LibrarySlotSpec).config as { options: Record<string, unknown> }).options)).toEqual(['morning', 'afternoon']);
    // The number the caller is calling from is offered for a callback number.
    expect(app.slots.request_callbackNumber!.callerNumber).toBeDefined();
    // The account, recognized by the number calling: a choice of the accounts, never a form's.
    expect(Object.keys(((app.slots.account as LibrarySlotSpec).config as { options: Record<string, unknown> }).options)).toEqual(['rivergate_book_club', 'northside_readers']);
  });

  it('the read-back prompt is the readBack with its placeholders, each the field\'s slot', () => {
    expect(app.forms.request!.summaryPromptId).toBe('readback_request');
    expect(app.prompts.manifest.readback_request!.text).toBe("Here's the hold: {request_patronName}, {request_copies} of {request_title}, collected {request_day} in the {request_window}, and we'll call you at {request_callbackNumber}. Is that right?");
    expect(app.prompts.manifest.readback_booking!.text).toBe('So that\'s the study room for {account}, {booking_people} people, {booking_day} in the {booking_window}. Shall I book it?');
    expect(app.prompts.manifest.done_booking!.text).toBe("You're booked for {booking_day}, {booking_window}. Thanks.");
  });

  it('asks each field by its own question, and says the fixed lines word for word: none is generated', () => {
    expect(app.prompts.manifest.ask_request_day!.text).toBe('What day would you like to collect it?');
    expect(app.prompts.manifest.ask_booking_day!.text).toBe('What day would you like the room?');
    expect(app.prompts.manifest.price!.text).toBe(business.prices!.say);
    expect(app.prompts.manifest.handoff_live_agent!.text).toBe(business.handoff);
    expect(app.prompts.manifest.goodbye!.text).toBe(business.closing);
    expect(app.generated).toBeUndefined();
  });

  it('every action has its say, and every param its audit entry', () => {
    const source = gateOf(app).source;
    for (const [tool, action] of Object.entries(source.actions)) expect(action.say, tool).toBeTruthy();
    const audit = app.policy.audit ?? {};
    for (const [tool, def] of Object.entries(app.tools)) for (const param of def.params ?? []) expect(audit[param], `${tool}.${param}`).toBeDefined();
    expect(audit).toMatchObject({ callbackNumber: 'last4', callerNumber: 'last4', title: 'keep', account: 'keep' });
  });
});

describe('the gate, for an unknown caller and for an account', () => {
  it('an unknown caller may request but not book', () => {
    expect(decide({ tool: 'placeHold', params: HOLD }, ANONYMOUS, { confirmedHash: confirmedHold }).verdict).toBe('ALLOW');
    // Nothing is placed that the caller did not confirm at the read-back.
    expect(decide({ tool: 'placeHold', params: HOLD }, ANONYMOUS)).toMatchObject({ verdict: 'BLOCK', reason: 'confirmation' });
    const room = { account: 'rivergate_book_club', people: 'four', day: '2026-11-12', window: 'morning' };
    expect(decide({ tool: 'bookRoom', params: room }, ANONYMOUS, { confirmedHash: confirmationHash(room, Object.keys(room)) })).toMatchObject({ verdict: 'STEP_UP' });
  });

  it('the account the call-start lookup found is the only one recognized, and an account may book its own room only', () => {
    // The call-start lookup, through the gate, held to the number calling.
    const lookup = { tool: BUSINESS_TOOLS.lookup, params: { callerNumber: ACCOUNT_NUMBER } };
    expect(decide(lookup, ANONYMOUS, { callerNumber: ACCOUNT_NUMBER }).verdict).toBe('ALLOW');
    expect(decide({ ...lookup, params: { callerNumber: '+15555550199' } }, ANONYMOUS, { callerNumber: ACCOUNT_NUMBER })).toMatchObject({ verdict: 'BLOCK', reason: 'not-caller-number' });
    const sys = app.systems().sys;
    const s = newSession('S-0', 0, VOICE_RELAY, ANONYMOUS, app.id);
    s.callerNumber = ACCOUNT_NUMBER;
    const ctx = { s } as never;
    const found = app.tools[BUSINESS_TOOLS.lookup]!.run(lookup, sys, ctx) as { value: unknown };
    expect(found.value).toEqual({ accounts: ['rivergate_book_club'] });
    expect((app.tools[BUSINESS_TOOLS.lookup]!.run({ ...lookup, params: { callerNumber: '+15555550199' } }, sys, ctx) as { value: unknown }).value).toBeNull();
    app.facts!.fromCallerLookup!(s.facts, found.value);
    expect(app.facts!.callerMatch!(s.facts)).toEqual({ account: 'rivergate_book_club' });
    const recognize = (account: string): unknown => (app.tools[BUSINESS_TOOLS.recognize]!.run({ tool: BUSINESS_TOOLS.recognize, params: { account } }, sys, ctx) as { value: unknown }).value;
    // An account said, not filled by the match, is no account.
    Object.assign(s.slots.account!, { value: 'rivergate_book_club', display: null });
    expect(recognize('rivergate_book_club')).toEqual({ ok: false });
    // Filled by the match: recognized.
    Object.assign(s.slots.account!, { value: 'rivergate_book_club', display: null, by: 'caller-id' });
    expect(recognize('rivergate_book_club')).toEqual({ ok: true, principal: { kind: 'account', level: 1, id: 'rivergate_book_club', first: 'Rivergate Book Club' } });
    // Another account than the number's, even one on file, is no account.
    Object.assign(s.slots.account!, { value: 'northside_readers', by: 'caller-id' });
    expect(recognize('northside_readers')).toEqual({ ok: false });
    // The account books its own room, once it confirmed the read-back; never another account's.
    const club: Principal = { kind: 'account', level: 1, id: 'rivergate_book_club', first: 'Rivergate Book Club' };
    const room = { account: 'rivergate_book_club', people: 'four', day: '2026-11-12', window: 'morning' };
    expect(decide({ tool: 'bookRoom', params: room }, club, { confirmedHash: confirmationHash(room, Object.keys(room)) }).verdict).toBe('ALLOW');
    expect(decide({ tool: 'bookRoom', params: room }, club)).toMatchObject({ verdict: 'BLOCK', reason: 'confirmation' });
    const other = { ...room, account: 'northside_readers' };
    expect(decide({ tool: 'bookRoom', params: other }, club, { confirmedHash: confirmationHash(other, Object.keys(other)) })).toMatchObject({ verdict: 'BLOCK', reason: 'scope' });
  });

  it('a caller claiming to be an account from a number not on file stays anonymous: no match, and book is refused', () => {
    const facts = app.facts!.initial();
    app.facts!.fromCallerLookup!(facts, null);
    expect(app.facts!.callerMatch!(facts)).toBeNull();
    const room = { account: 'rivergate_book_club', people: 'four', day: '2026-11-12', window: 'morning' };
    expect(decide({ tool: 'bookRoom', params: room }, ANONYMOUS, { confirmedHash: confirmationHash(room, Object.keys(room)) }).verdict).not.toBe('ALLOW');
  });
});

describe('a call through the core', () => {
  const corpus = parseCorpus([
    '{"id":"bk-01","text":"I would like to book the study room for four of us tomorrow morning","intent":"booking","context":"no_form","labels":{"booking_people":"four","booking_dayMode":"relative_day","booking_dayRelative":"tomorrow","booking_window":"morning"}}',
    '{"id":"bk-02","text":"This is Rivergate Book Club, I would like to book the study room","intent":"booking","context":"no_form"}',
    '{"id":"bk-03","text":"yes, book it","intent":"none","context":"confirm_booking","confirm":"yes"}',
    '{"id":"pp-01","text":"can I talk to a person","intent":"agent","context":"no_form"}',
  ].join('\n'), app);
  const client: JevClient = new FixtureStubClient(corpus, { sharpness: DEFAULT_THRESHOLDS.STUB_SHARPNESS, fallback: new HeuristicStubClient({ todayIso: TODAY }) });
  const call = (callerNumber: string | undefined, ...said: string[]): Promise<ScenarioRun> => runScenario(
    { id: 'call', steps: said.map((say) => ({ say })), expect: { decision: 'any' }, ...(callerNumber !== undefined ? { callerNumber } : {}) },
    { client, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, now: () => 0, tools: { ...app.systems(), codes: mockCodeVerifier } },
  );
  const promptOf = (t: TurnResult): string | undefined => ('promptId' in t.decision ? t.decision.promptId : undefined);
  const heard = (t: TurnResult): string => spokenText(app, t.decision);
  const calls = (r: ScenarioRun, tool: string) => r.runs.flatMap((x) => x.result.gateEvents.filter((e) => e.decision.call.tool === tool));

  it('a matched number is recognized at call start with nothing asked, and books straight in once it confirms the read-back', async () => {
    const r = await call(ACCOUNT_NUMBER, 'I would like to book the study room for four of us tomorrow morning', 'yes, book it');
    const [greeted, asked, booked] = r.runs.map((x) => x.result);
    // The greeting is as always: the account is recognized behind it, by the match alone, through the gate.
    expect(promptOf(greeted!)).toBe('greeting');
    expect(greeted!.session.principal).toEqual({ kind: 'account', level: 1, id: 'rivergate_book_club', first: 'Rivergate Book Club', via: 'caller-id' });
    expect(calls(r, BUSINESS_TOOLS.recognize).map((e) => e.decision.verdict)).toEqual(['ALLOW']);
    // The read-back names the account by its name.
    expect(promptOf(asked!)).toBe('readback_booking');
    expect(heard(asked!)).toContain("So that's the study room for Rivergate Book Club, four people, ");
    expect(promptOf(booked!)).toBe('anything_else');
    expect(heard(booked!)).toContain("You're booked for ");
    expect(calls(r, 'bookRoom').map((e) => e.decision.verdict)).toEqual(['ALLOW']);
    // The account was never asked: no line of the call is a question for it.
    expect(r.runs.flatMap((x) => x.result.decision.kind === 'prompt' ? [x.result.decision.promptId] : [])).not.toContain('ask_account');
  });

  it('an unmatched caller saying the account\'s name cannot book: told so, and begun on the request, with no step-up question', async () => {
    const r = await call('+15555550199', 'This is Rivergate Book Club, I would like to book the study room');
    const t = r.runs.at(-1)!.result;
    expect(t.session.principal).toEqual(ANONYMOUS);
    expect(t.session.form).toBe('request');
    expect(heard(t)).toBe("Bookings are for our account holders; I can send a request instead. What's your name?");
    // The name said is never taken for the account.
    expect(t.session.slots.account!.value).toBeNull();
    expect(calls(r, BUSINESS_TOOLS.recognize)).toEqual([]);
    expect(calls(r, 'bookRoom')).toEqual([]);
  });

  it('a caller who asks for a person is told the handoff line and begun on the callback note', async () => {
    const r = await call('+15555550199', 'can I talk to a person');
    const t = r.runs.at(-1)!.result;
    expect(t.session.form).toBe('callback');
    expect(heard(t)).toBe("I'll have someone from the desk call you back. Is the number you're calling from, ending in 0199, the best one to reach you?");
  });
});

describe('a form\'s completion, written by the engine', () => {
  it('calls the form\'s then in order through the gate, with its values by field name, then says its done line', () => {
    const s = newSession('S-1', 0, VOICE_RELAY, ANONYMOUS, app.id);
    for (const [field, value] of Object.entries(HOLD)) Object.assign(s.slots[`request_${field}`]!, { value, display: value });
    s.pendingHash = 'hash';
    const calls: ToolCall[] = [];
    const c = {
      s,
      acks: [],
      callTool: (call: ToolCall) => {
        calls.push(call);
        return { decision: { verdict: 'ALLOW' }, value: { ok: true } };
      },
      refusal: () => ({ kind: 'refused', acks: [] }) as Completion,
    } as unknown as CompletionContext;
    expect(app.forms.request!.confirmedParams!(s)).toEqual(HOLD);
    const done = app.forms.request!.complete!(c);
    expect(calls).toEqual([{ tool: 'placeHold', params: HOLD }, { tool: 'notifyDesk', params: HOLD }]);
    expect(done).toMatchObject({ kind: 'said', acks: [{ promptId: 'done_request', vars: { request_patronName: 'Avery Lane' } }] });
  });

  it('the booking\'s read-back and done line say the recognized account\'s name as {account}', () => {
    const club = { kind: 'account', level: 1, id: 'rivergate_book_club', first: 'Rivergate Book Club', via: 'caller-id' } as const;
    const s = newSession('S-3', 0, VOICE_RELAY, club, app.id);
    s.pendingHash = 'hash';
    expect(app.forms.booking!.onSummaryRead!({ s, acks: [] } as never)).toEqual({ vars: { account: 'Rivergate Book Club' } });
    const c = { s, acks: [], callTool: () => ({ decision: { verdict: 'ALLOW' }, value: { ok: true } }), refusal: () => ({ kind: 'refused', acks: [] }) } as unknown as CompletionContext;
    expect(app.forms.booking!.complete!(c)).toMatchObject({ kind: 'said', acks: [{ promptId: 'done_booking', vars: { account: 'Rivergate Book Club' } }] });
    // A caller not recognized has no account to name.
    expect(app.forms.booking!.onSummaryRead!({ s: newSession('S-4', 0, VOICE_RELAY, ANONYMOUS, app.id), acks: [] } as never)).toEqual({ vars: {} });
  });

  it('stops at a refusal, and reads the summary again when the values changed after it', () => {
    const s = newSession('S-2', 0, VOICE_RELAY, ANONYMOUS, app.id);
    s.pendingHash = 'hash';
    const c = {
      s,
      acks: [],
      callTool: () => ({ decision: { verdict: 'BLOCK', reason: 'confirmation' }, value: null }),
      refusal: () => ({ kind: 'refused', acks: [] }) as Completion,
    } as unknown as CompletionContext;
    expect(app.forms.callback!.complete!(c)).toEqual({ kind: 'reconfirm', acks: [] });
  });
});

describe('the code an agent-mode app writes', () => {
  /** The problems defineApp finds with the fixture folder and this code. */
  const problems = (code: AppCode): string[] => {
    try {
      defineApp(BUSINESS_FIXTURE_DIR, code);
    } catch (error) {
      if (error instanceof AppDefinitionError) return error.problems.map((p) => `${p.file} ${p.path}: ${p.message}`);
      throw error;
    }
    return [];
  };
  const { placeHold: _placeHold, ...withoutPlaceHold } = TOOLS;

  it('a then naming no tool in the code is refused, at its line in business.yaml', () => {
    expect(problems({ ...businessFixtureCode, tools: withoutPlaceHold })).toEqual(['business.yaml request.then[0]: the request calls "placeHold", which is not a tool in the code']);
  });

  it('a sees naming no tool in the code is refused', () => {
    const { roomAvailability: _seen, ...rest } = TOOLS;
    expect(problems({ ...businessFixtureCode, tools: rest })).toEqual(['business.yaml booking.fields[1].sees: the field "day" sees "roomAvailability", which is not a tool in the code']);
  });

  it('a tool whose params are not its form\'s values is refused', () => {
    expect(problems({ ...businessFixtureCode, tools: { ...TOOLS, noteCallback: { ...TOOLS.noteCallback!, params: ['phone'] } } })).toEqual([
      'business.yaml callback.then[0]: the tool "noteCallback" lists the params [phone], but every call the callback makes carries its values, [callbackNumber]',
    ]);
  });

  it('a tool no form calls, a tool of the engine\'s name, form hooks and facts in the code are refused', () => {
    const found = problems({ ...businessFixtureCode, tools: { ...TOOLS, spare: TOOLS.noteCallback!, [BUSINESS_TOOLS.lookup]: TOOLS.noteCallback! }, forms: { request: {} }, facts: { initial: () => ({}), clone: (f) => ({ ...f }) } });
    expect(found).toEqual([
      'app.ts code.tools.spare: the tool "spare" is in the code, but no form of business.yaml calls it (a then) and no field sees it, so it can never be called',
      'app.ts code.tools.lookupAccount: "lookupAccount" is the name of a tool the engine writes for an app in agent mode (the account the number calling is on file for)',
      'app.ts code.facts: an app in agent mode does not write facts: the engine writes the facts of its accounts from business.yaml',
      'app.ts code.forms: an app in agent mode writes no form hooks: the engine writes each form\'s from business.yaml (its read-back\'s values and its then)',
    ]);
  });

  it('pnpm check finds nothing wrong with the fixture', async () => {
    expect(await checkApp(BUSINESS_FIXTURE_DIR)).toEqual([]);
  });
});

describe('the fixture\'s pages', () => {
  const page = (file: string): string => join(BUSINESS_FIXTURE_DIR, file);
  it('its policy keeps the invariants', () => expect(policyInvariants(app as App).violations).toEqual([]));
  it('has no custom rule whose examples the gate disagrees with', () => expect(runRuleExamples(app)).toEqual([]));
  it('policy.matrix', () => expectPolicyMatrix(app, page('policy.matrix')));
  it('POLICY.md', () => expectPolicyCard(app, page('POLICY.md')));
  it('APP-MAP.md', () => expectAppMap(app, page('APP-MAP.md')));

  it('the matrix shows the booking and the callback allowed where the gate allows them, each with its own confirmed values', () => {
    const matrix = readFileSync(page('policy.matrix'), 'utf8');
    const block = (tool: string): string => matrix.slice(matrix.indexOf(`${tool} · `), matrix.indexOf('\n\n', matrix.indexOf(`${tool} · `)));
    expect(block('bookRoom')).toMatch(/subject own, fields exact, confirmed match\s+ALLOW/);
    expect(block('noteCallback')).toMatch(/fields exact, confirmed match\s+ALLOW/);
  });

  it('the policy card says the app is in agent mode, that the conversation is sent to the model, what the model sees, and the forged-number risk', () => {
    const card = readFileSync(page('POLICY.md'), 'utf8');
    expect(card).toContain('## Agent mode');
    expect(card).toContain('**The conversation is sent to the agent model:**');
    expect(card).toContain('| day (`booking_day`) | read the study room\'s free windows near a day (`roomAvailability`) | declared |');
    // Honest about what the model sees: the caller's words as said, and what is masked where.
    expect(card).toContain('the caller\'s words as they said them (a number they say included)');
    expect(card).toContain('A value the records hide (the callback number by its last four) is sent masked where it is listed as collected, and in the conversation history once the line has understood it.');
    expect(card).toContain('callback number by its last four.');
    expect(card).toContain('**Caller ID can be forged:**');
    expect(card).toContain('book the study room (`bookRoom`), still only once the caller confirms its read-back');
  });
});
