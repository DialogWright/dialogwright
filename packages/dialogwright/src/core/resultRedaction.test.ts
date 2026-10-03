import { beforeAll, describe, expect, it } from 'vitest';
import { speechEvent, startEvent, type SessionEvent } from '../channel/events';
import { WEB_CHAT } from '../channel/caps';
import { spokenText } from '../prompts/render';
import { choice, noul } from '../testing/answers';
import { useTestkit } from '../testing/apps';
import { testkitApp } from '../testing/testkit';
import { CUSTOMERS, STAFF } from '../testing/testkit/domain/data';
import { parcelsFact } from '../testing/testkit/domain/facts';
import { agentPrincipal, customerPrincipal } from '../testing/testkit/domain/principals';
import type { ParcelSystems, ParcelView } from '../testing/testkit/domain/systems';
import { buildTraceRecord } from '../trace/writer';
import { redactRecord, type DashboardEvent } from '../server/dashboard/events';
import { consoleMetaOf } from '../server/dashboard/meta';
import { configure, reduce } from '../server/dashboard/view.js';
import type { AnswerMap } from '../jev/types';
import { ANONYMOUS } from '../gate/principal';
import type { Principal } from '../gate/types';
import { registerApp } from './app/registry';
import { validateApp } from './app/validate';
import type { App, CompletionContext } from './app/types';
import { callTool, newTurnOut, RESULT_UNREDACTABLE } from './lifecycle';
import { redactResult, redactedSummary, withheldFields } from './resultRedaction';
import { newSession, type Session } from './session';
import { DEFAULT_THRESHOLDS } from './thresholds';
import { demoTools } from './tools';
import { plan, resolve, type TurnContext, type TurnResult } from './turn';

/**
 * Redaction per principal (policy.yaml `redact:`): the testkit withholds a parcel's safe place from
 * a depot agent, except a clerk, and the engine strips it in callTool, after the tool runs and before
 * anything else sees the value. A customer acting for themselves sees the whole parcel.
 */

useTestkit();

const VIEWER = agentPrincipal(STAFF[0]!);
const CLERK = agentPrincipal(STAFF[1]!);
const SAM = customerPrincipal(CUSTOMERS[1]!, 2);
/** Sam's one parcel, and where it may be left: what a viewer must never see. */
const PARCEL = '7201';
const SAFE_PLACE = 'in the porch';

const ctx = (): TurnContext => ({ nowMs: 0, todayIso: '2026-09-18', thresholds: { ...DEFAULT_THRESHOLDS }, tools: demoTools() });

const getParcel = testkitApp.tools.getParcel!;
/** The testkit with a getParcel that wraps the parcel and says its safe place in its summary and its record: a careless tool. */
const CHATTY: App = {
  ...testkitApp,
  id: 'redact-chatty',
  tools: {
    ...testkitApp.tools,
    getParcel: {
      ...getParcel,
      run: (c, sys, x) => {
        const parcel = getParcel.run(c, sys, x).value as ParcelView;
        return { value: { parcel }, summary: `${parcel.status}, left ${parcel.safePlace} (not "${parcel.safePlace}way")`, ref: `${parcel.number}:${parcel.safePlace}` };
      },
    },
  },
};
/** The testkit with a getParcel that returns its parcel as text: nothing can be stripped from it. */
const STRINGY: App = { ...testkitApp, id: 'redact-stringy', tools: { ...testkitApp.tools, getParcel: { ...getParcel, run: (c, sys, x) => ({ value: JSON.stringify(getParcel.run(c, sys, x).value), summary: 'text' }) } } };
registerApp(CHATTY);
registerApp(STRINGY);

function call(principal: Principal, tool: string, params: Record<string, string>, tc = ctx(), appId?: string) {
  const s = newSession('r', 0, WEB_CHAT, principal, appId);
  const out = newTurnOut();
  const outcome = callTool(s, { tool, params }, tc, out);
  return { outcome, events: out.gateEvents, tc };
}

describe('who has fields withheld', () => {
  it('a delegate by kind, a role by its own row, never a subject or an anonymous caller', () => {
    expect(withheldFields(testkitApp, VIEWER, 'getParcel')).toEqual(['safePlace']);
    expect(withheldFields(testkitApp, VIEWER, 'listParcels')).toEqual(['safePlace']);
    // The clerk's own row replaces the kind's: nothing is withheld from a clerk.
    expect(withheldFields(testkitApp, CLERK, 'getParcel')).toEqual([]);
    // A party of the kind with no role, or a role with no row of its own, gets the kind's.
    const { role: _role, ...roleless } = VIEWER;
    expect(withheldFields(testkitApp, roleless, 'getParcel')).toEqual(['safePlace']);
    expect(withheldFields(testkitApp, { ...VIEWER, role: 'supervisor' }, 'getParcel')).toEqual(['safePlace']);
    // A tool the policy does not redact, a subject and an anonymous caller: nothing.
    expect(withheldFields(testkitApp, VIEWER, 'getAccount')).toEqual([]);
    expect(withheldFields(testkitApp, SAM, 'getParcel')).toEqual([]);
    expect(withheldFields(testkitApp, ANONYMOUS, 'getParcel')).toEqual([]);
  });

  it('a party the policy has no row for at all sees none of the fields a tool declares (fail closed)', () => {
    const visitor = { kind: 'visitor', level: 2 as const, id: 'V-1', first: 'Robin' };
    // Another kind that is neither the subject nor the delegate: every field the tool declares.
    expect(withheldFields(testkitApp, visitor, 'getParcel')).toEqual(['safePlace']);
    expect(withheldFields(testkitApp, { ...visitor, role: 'guide' }, 'listParcels')).toEqual(['safePlace']);
    // A tool that declares none has none to withhold.
    expect(withheldFields(testkitApp, visitor, 'getAccount')).toEqual([]);
    // An app with no redact table at all: a delegate sees none of the declared fields.
    const { redact: _redact, ...policy } = testkitApp.policy;
    const bare: App = { ...testkitApp, policy };
    expect(withheldFields(bare, VIEWER, 'getParcel')).toEqual(['safePlace']);
    expect(withheldFields(bare, SAM, 'getParcel')).toEqual([]);
    expect(withheldFields(bare, ANONYMOUS, 'getParcel')).toEqual([]);
    // A kind with a row for some tools has the policy's word for the others: nothing withheld there.
    expect(withheldFields({ ...testkitApp, policy: { ...testkitApp.policy, redact: { agent: { getParcel: ['safePlace'] } } } }, VIEWER, 'listParcels')).toEqual([]);
  });
});

describe('stripping a value', () => {
  it('sets each field to null on a copy of an object, and says so', () => {
    const record = { number: '1', note: 'private', other: 'kept' };
    const r = redactResult('getRecord', record, ['note', 'missing']);
    expect(r).toEqual({ value: { number: '1', note: null, other: 'kept', missing: null }, redacted: true, withheld: ['private'] });
    expect(record.note).toBe('private');
  });

  it('strips each object of a list, and leaves a null item alone', () => {
    const r = redactResult('listRecords', [{ id: 'a', note: 'x' }, null, { id: 'b', note: 'y' }], ['note']);
    expect(r).toEqual({ value: [{ id: 'a', note: null }, null, { id: 'b', note: null }], redacted: true, withheld: ['x', 'y'] });
  });

  it('withholds nothing from nothing: no fields, a null value, an empty list', () => {
    const v = { note: 'x' };
    expect(redactResult('getRecord', v, [])).toEqual({ value: v, redacted: false, withheld: [] });
    expect(redactResult('getRecord', null, ['note'])).toEqual({ value: null, redacted: false, withheld: [] });
    expect(redactResult('getRecord', undefined, ['note'])).toEqual({ value: undefined, redacted: false, withheld: [] });
    expect(redactResult('listRecords', [], ['note'])).toEqual({ value: [], redacted: false, withheld: [] });
  });

  it('refuses a value it cannot strip a field from, so it never goes on whole', () => {
    expect(() => redactResult('getRecord', 'note: private', ['note'])).toThrow('tool "getRecord" returned a string, so the fields the policy withholds (note) cannot be stripped from it: a tool with fields (ToolDef.fields) returns an object or a list of objects');
    expect(() => redactResult('listRecords', ['private'], ['note'])).toThrow('tool "listRecords" returned a list holding a string, so the fields the policy withholds (note) cannot be stripped from it');
  });

  it('strips a field at any depth: in a wrapper\'s list, in a nested object, own keys only', () => {
    const wrapper = { items: [{ safePlace: 'porch', n: 1 }], total: 1 };
    expect(redactResult('t', wrapper, ['safePlace'])).toEqual({ value: { items: [{ safePlace: null, n: 1 }], total: 1, safePlace: null }, redacted: true, withheld: ['porch'] });
    expect(wrapper.items[0]!.safePlace).toBe('porch');
    expect(redactResult('t', { parcel: { safePlace: 'porch', inner: { safePlace: ['side', 'gate'] } } }, ['safePlace'])).toEqual({
      value: { parcel: { safePlace: null, inner: { safePlace: null } }, safePlace: null }, redacted: true, withheld: ['porch', 'side', 'gate'],
    });
    // A field an object has only from its prototype is not its own, and stays where it is.
    const proto = Object.create({ safePlace: 'inherited' }) as Record<string, unknown>;
    proto.n = 1;
    const r = redactResult('t', { inner: proto }, ['safePlace']).value as { inner: Record<string, unknown> };
    expect(Object.keys(r.inner)).toEqual(['n']);
  });

  it('copies a shared object once and a cycle as a cycle, keeps a class\'s prototype, and leaves a date as it is', () => {
    class Box { constructor(public safePlace: string, public label: string) {} }
    const shared = { safePlace: 'porch' };
    const cyclic: Record<string, unknown> = { safePlace: 'shed' };
    cyclic.self = cyclic;
    const when = new Date(0);
    const r = redactResult('t', { a: shared, b: shared, c: cyclic, box: new Box('garage', 'x'), when }, ['safePlace']);
    const v = r.value as { a: object; b: object; c: Record<string, unknown>; box: Box; when: Date };
    expect(v.a).toBe(v.b);
    expect(v.a).toEqual({ safePlace: null });
    expect(v.c.self).toBe(v.c);
    expect(v.c.safePlace).toBeNull();
    expect(v.box).toBeInstanceOf(Box);
    expect(v.box).toMatchObject({ safePlace: null, label: 'x' });
    expect(v.when).toBe(when);
    expect([...r.withheld].sort()).toEqual(['garage', 'porch', 'shed']);
    // A date as the whole value is copied, never changed.
    expect(redactResult('t', when, ['safePlace']).value).toEqual({ safePlace: null });
    expect(when).not.toHaveProperty('safePlace');
  });

  it('refuses a Map or a Set below a result it withholds from: its contents are where the keys do not reach', () => {
    expect(() => redactResult('t', { m: new Map([['safePlace', 'porch']]) }, ['safePlace'])).toThrow('tool "t" returned a Map inside its result');
    expect(() => redactResult('t', [{ s: new Set(['porch']) }], ['safePlace'])).toThrow('tool "t" returned a Set inside its result');
  });

  it('notes what was withheld after the tool\'s own summary', () => {
    expect(redactedSummary('in_transit', ['safePlace', 'note'])).toBe('in_transit; redacted: safePlace, note');
    expect(redactedSummary('', ['note'])).toBe('redacted: note');
  });
});

describe('callTool withholds the fields, once, for a delegate and not for a subject', () => {
  it('a viewer reads a parcel without its safe place; the system of record keeps it', () => {
    const { outcome, events, tc } = call(VIEWER, 'getParcel', { parcel: PARCEL });
    expect(outcome.decision.verdict).toBe('ALLOW');
    expect(outcome.value).toEqual({ number: PARCEL, item: 'a coffee grinder', status: 'in_transit', day: '2026-09-22', safePlace: null });
    expect(outcome.redacted).toEqual(['safePlace']);
    expect(events.map((e) => e.summary)).toEqual(['in_transit; redacted: safePlace']);
    expect((tc.tools.sys as ParcelSystems).getParcel(PARCEL)?.safePlace).toBe(SAFE_PLACE);
  });

  it('a list: every parcel without its safe place', () => {
    const { outcome, events } = call(VIEWER, 'listParcels', { accountId: '55501234' });
    const parcels = outcome.value as ParcelView[];
    expect(parcels.map((p) => p.number)).toEqual(['7101', '7102', '7103']);
    expect(parcels.map((p) => p.safePlace)).toEqual([null, null, null]);
    expect(outcome.redacted).toEqual(['safePlace']);
    expect(events[0]!.summary).toBe('3 parcels; redacted: safePlace');
  });

  it('a clerk (the role\'s own row) and the customer themselves see the whole parcel, with no note', () => {
    for (const who of [CLERK, SAM]) {
      const { outcome, events } = call(who, 'getParcel', { parcel: PARCEL });
      expect((outcome.value as ParcelView).safePlace).toBe(SAFE_PLACE);
      expect(outcome).not.toHaveProperty('redacted');
      expect(events[0]!.summary).toBe('in_transit');
    }
  });

  it('masks a withheld value wherever the tool\'s summary or the record it names repeats it', () => {
    const { outcome, events } = call(VIEWER, 'getParcel', { parcel: PARCEL }, ctx(), CHATTY.id);
    expect(outcome.value).toEqual({ parcel: expect.objectContaining({ number: PARCEL, safePlace: null }), safePlace: null });
    expect(events[0]!.summary).toBe('in_transit, left • (not "in the porchway"); redacted: safePlace');
    expect(events[0]!.ref).toBe(`${PARCEL}:•`);
    expect(JSON.stringify(events)).not.toContain(SAFE_PLACE + '"');
  });

  it('a result that cannot be stripped never goes on: the call that ran is recorded, and a person takes it', () => {
    const { outcome, events } = call(VIEWER, 'getParcel', { parcel: PARCEL }, ctx(), STRINGY.id);
    expect(outcome).toEqual({ decision: expect.objectContaining({ verdict: 'NEEDS_HUMAN', reason: RESULT_UNREDACTABLE }), value: null });
    expect(events).toHaveLength(1);
    expect(events[0]!.decision.verdict).toBe('ALLOW');
    expect(events[0]!.summary).toBe('result not recorded: the fields withheld from this caller (safePlace) could not be stripped from it');
    expect(JSON.stringify(events)).not.toContain(SAFE_PLACE);
  });

  it('a refused call has nothing to withhold', () => {
    const { outcome, events } = call(VIEWER, 'getParcel', { parcel: '7301' });
    expect(outcome).toEqual({ decision: expect.objectContaining({ verdict: 'BLOCK' }), value: null });
    expect(events[0]!.summary).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Every sink: the testkit's tracking form with hooks that hand on everything they are given (to the
// facts and to a line), run as real turns; then the trace, the console and the audit built from them.
// ---------------------------------------------------------------------------------------------

const seen: { hook: string; value: unknown }[] = [];
/** The session's facts as the completion found them (the form's close clears the parcel list after). */
let factsAtCompletion = '';
const track = testkitApp.forms.track_parcel!;
const PROBE: App = {
  ...testkitApp,
  id: 'redact-probe',
  forms: {
    ...testkitApp.forms,
    track_parcel: {
      ...track,
      // Staff read Sam's parcels too, so the entry call (the list) runs for them as for Sam.
      principalEntry: undefined,
      entry: () => ({ tool: 'listParcels', params: { accountId: CUSTOMERS[1]!.id } }),
      onEntry: (s, value) => {
        seen.push({ hook: 'onEntry', value });
        track.onEntry!(s, value);
      },
      complete: (c: CompletionContext) => {
        const outcome = c.callTool({ tool: 'getParcel', params: { parcel: c.s.slots.parcelSelect!.value ?? '' } });
        seen.push({ hook: 'complete', value: outcome });
        factsAtCompletion = JSON.stringify(c.s.facts);
        const parcel = outcome.value as ParcelView;
        // A careless hook would say the safe place: it says whatever it was handed.
        return { kind: 'said', acks: [...c.acks, { promptId: 'parcel_status_in_transit', vars: { parcel: parcel.number, item: String(parcel.safePlace), day: 'Tuesday' } }] };
      },
    },
  },
};

beforeAll(() => {
  registerApp(PROBE);
  configure(consoleMetaOf(PROBE));
});

const base: AnswerMap = {
  addressedToSystem: noul(0.95), intelligible: noul(0.95), utteranceComplete: noul(0.9), wantsHuman: noul(0.02),
  rephrasingLastTurn: noul(0.05), confusedByPrompt: noul(0.05), spokeAMenuNumber: noul(0.02), triedSelfService: noul(0.05),
  intentTentative: noul(0.05), intent: choice({ none: 0.9, other: 0.1 }),
};

/** Sam's parcel tracked on the probe app by `principal`: every turn, and what each sink was given. */
function tracked(principal: Principal) {
  seen.length = 0;
  factsAtCompletion = '';
  const tc = ctx();
  const turns: { event: SessionEvent; result: TurnResult }[] = [];
  let s: Session = newSession('p', 0, WEB_CHAT, principal, PROBE.id);
  const start = startEvent();
  turns.push({ event: start, result: resolve(s, start, null, tc) });
  s = turns[0]!.result.session;
  const asked = speechEvent('where is the parcel');
  plan(s, asked, tc);
  turns.push({ event: asked, result: resolve(s, asked, { ...base, intent: choice({ track_parcel: 0.93, none: 0.07 }) }, tc) });
  const last = turns.at(-1)!.result;
  const records = turns.map(({ event, result }) => buildTraceRecord({
    result, event, questions: null, response: null, error: null, timing: { planMs: 0, askMs: 0, resolveMs: 0, totalMs: 0 }, ts: '2026-09-18T10:00:00.000Z', pricePerMtok: 0,
  }));
  // The console: what the observer publishes (the record, redacted again, and the turn's line), and the audit batches.
  const events: DashboardEvent[] = [{ type: 'call_started', callSid: 'p', at: 0, from: '…0001', todayIso: '2026-09-18', thresholds: DEFAULT_THRESHOLDS }];
  turns.forEach(({ result }, i) => {
    events.push({ type: 'turn', callSid: 'p', at: i, record: redactRecord(records[i]!), spoken: spokenText(PROBE, result.decision) });
    events.push({ type: 'audit', callSid: 'p', at: i, entries: result.audit.map((d, seq) => ({ ...d, seq, at: '2026-09-18T10:00:00.000Z', callId: 'p', channel: 'chat', prevHash: '', hash: '' })) });
  });
  return {
    last,
    hooks: JSON.stringify(seen),
    facts: factsAtCompletion,
    line: `${JSON.stringify(last.decision)} ${spokenText(PROBE, last.decision)}`,
    gateEvents: JSON.stringify(turns.flatMap(({ result }) => result.gateEvents)),
    trace: JSON.stringify(records),
    console: JSON.stringify([events, reduce(events, {})]),
    audit: JSON.stringify(turns.flatMap(({ result }) => result.audit)),
  };
}

describe('a withheld field reaches no sink', () => {
  it('a viewer: not the hooks, the facts, the line, the gate events, the trace, the console or the audit', () => {
    const t = tracked(VIEWER);
    expect(t.last.decision).toMatchObject({ promptId: 'anything_else', acks: [{ promptId: 'ack_intent' }, { promptId: 'parcel_status_in_transit', vars: { parcel: PARCEL, item: 'null' } }] });
    expect(seen.map((x) => x.hook)).toEqual(['onEntry', 'complete']);
    expect(seen[0]!.value).toEqual([expect.objectContaining({ number: PARCEL, safePlace: null })]);
    expect(seen[1]!.value).toMatchObject({ value: { number: PARCEL, safePlace: null }, redacted: ['safePlace'] });
    expect(parcelsFact(JSON.parse(t.facts))).toEqual([expect.objectContaining({ number: PARCEL, safePlace: null })]);
    for (const [sink, text] of Object.entries({ hooks: t.hooks, facts: t.facts, line: t.line, gateEvents: t.gateEvents, trace: t.trace, console: t.console, audit: t.audit })) {
      expect(text, sink).not.toContain(SAFE_PLACE);
    }
    // The record of the call says what was withheld: the gate events, so the trace, the console and the audit.
    for (const [sink, text] of Object.entries({ gateEvents: t.gateEvents, trace: t.trace, console: t.console, audit: t.audit })) {
      expect(text, sink).toContain('1 parcel; redacted: safePlace');
      expect(text, sink).toContain('in_transit; redacted: safePlace');
    }
  });

  it('the customer themselves, and a clerk: the same hooks are handed the whole parcel, so the probe would show a leak', () => {
    for (const who of [SAM, CLERK]) {
      const t = tracked(who);
      expect(t.last.decision).toMatchObject({ acks: [{ promptId: 'ack_intent' }, { promptId: 'parcel_status_in_transit', vars: { item: SAFE_PLACE } }] });
      expect(t.hooks).toContain(SAFE_PLACE);
      expect(t.facts).toContain(SAFE_PLACE);
      expect(t.line).toContain(SAFE_PLACE);
      expect(t.gateEvents).not.toContain('redacted:');
    }
  });
});

describe('an app built in code fails closed when its redaction cannot hold (validateApp)', () => {
  const withRedact = (redact: NonNullable<App['policy']['redact']>, tools: App['tools'] = testkitApp.tools): App => ({ ...testkitApp, id: 'redact-bad', tools, policy: { ...testkitApp.policy, redact } });

  it('a field the tool does not declare, a kind that is not the delegate kind, the subject kind, a role the kind does not have', () => {
    expect(() => validateApp(withRedact({ agent: { getParcel: ['item'] } }))).toThrow('app "redact-bad": policy redacts "item" of "getParcel" for "agent", which the tool does not declare (ToolDef.fields)');
    expect(() => validateApp(withRedact({ staff: { getParcel: ['safePlace'] } }))).toThrow('app "redact-bad": policy redacts for "staff", which is not the identity\'s delegate kind');
    expect(() => validateApp(withRedact({ customer: { getParcel: ['safePlace'] } }))).toThrow('app "redact-bad": policy redacts for "customer", the subject kind: a subject acting for themselves is never redacted');
    expect(() => validateApp(withRedact({ 'agent.driver': { getParcel: [] } }))).toThrow('app "redact-bad": policy redacts for "agent.driver": "driver" is not a role of "agent"');
    const { fields: _fields, ...bare } = testkitApp.tools.getParcel!;
    expect(() => validateApp(withRedact({ agent: { getParcel: ['safePlace'] } }, { ...testkitApp.tools, getParcel: bare }))).toThrow('policy redacts "safePlace" of "getParcel" for "agent", which the tool does not declare');
    expect(() => validateApp(withRedact({ agent: { getParcel: ['safePlace'] } }))).not.toThrow();
  });
});
