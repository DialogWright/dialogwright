import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { speechEvent, startEvent, type SessionEvent } from '../channel/events';
import { WEB_CHAT } from '../channel/caps';
import { definePolicy } from '../define/definePolicy';
import { defineRule } from '../gate/defineRule';
import type { GateDecision, ToolCall } from '../gate/types';
import { choice, noul } from '../testing/answers';
import { testkitApp } from '../testing/testkit';
import { CUSTOMERS } from '../testing/testkit/domain/data';
import { TESTKIT_CUSTOM_RULES } from '../testing/testkit/domain/policy';
import { customerPrincipal } from '../testing/testkit/domain/principals';
import { buildTraceRecord } from '../trace/writer';
import { redactRecordSlots } from '../trace/redact';
import { redactRecord, type DashboardEvent } from '../server/dashboard/events';
import { consoleMetaOf } from '../server/dashboard/meta';
import { configure, reduce } from '../server/dashboard/view.js';
import type { AnswerMap } from '../jev/types';
import { registerApp, resetAppsForTest } from './app/registry';
import type { App, AuditMask, CompletionContext, ToolDef } from './app/types';
import { describeCall } from './audit';
import { callTool, newTurnOut } from './lifecycle';
import { AUDIT_MASKS, recordedValue, recordingOf, redactCall, scrubbedDrafts, scrubberFor } from './recording';
import { policyAudit } from '../define/schema/policy';
import { newSession, type Session } from './session';
import { DEFAULT_THRESHOLDS } from './thresholds';
import { demoTools } from './tools';
import { plan, resolve, type TurnContext, type TurnResult } from './turn';

/**
 * What is recorded of a call's params (core/recording.ts): each param that is no redacted slot as
 * policy.yaml's `audit:` declares it, in every sink (the gate event, the trace, the console and the
 * audit), and the same masks over the free text recorded beside the call: the rules' lines (an
 * app's own rule's and a built-in's that repeat a value), the tool's summary and record, and the
 * tool's own audit rows.
 */

const SAM = customerPrincipal(CUSTOMERS[1]!, 2);
/** A day nothing else in the testkit holds, so a sink that has it got it from the call. */
const RAW_DAY = '2031-02-17';

const TESTKIT_DIR = fileURLToPath(new URL('../testing/testkit/', import.meta.url));
const TESTKIT_POLICY_FILE = parse(readFileSync(`${TESTKIT_DIR}policy.yaml`, 'utf8')) as { actions: Record<string, { rules: unknown[] }>; audit: Record<string, string> };

/** An app's own rule that repeats the raw day in its description and its line, as is and in capitals: what a careless rule writes. */
const echo = defineRule({
  id: 'echo',
  description: 'The day is one to look at',
  run: (c) => {
    const day = c.call.params.deliveryDay ?? '';
    const compared = `day ${day} (${day.toUpperCase()}) part ${c.call.params.deliveryPart ?? ''}`;
    return day === 'never' ? { pass: false, compared, verdict: 'BLOCK', reason: 'echo' } : { pass: true, compared };
  },
  examples: [
    { name: 'a day', call: { params: { accountId: SAM.id, deliveryDay: RAW_DAY, deliveryPart: 'morning' } }, principal: SAM, expect: { verdict: 'ALLOW' } },
    { name: 'no day', call: { params: { accountId: SAM.id, deliveryDay: 'never', deliveryPart: 'morning' } }, principal: SAM, expect: { verdict: 'BLOCK', reason: 'echo' } },
  ],
});

/** The raw day the tool was last handed: what a careless audit hook copies into its rows. */
let handed = '';
const getWindows: ToolDef = {
  params: ['accountId', 'deliveryDay', 'deliveryPart'],
  run(call, _sys, { out }) {
    handed = call.params.deliveryDay ?? '';
    // A careless tool: its summary, its record and a downstream request all carry the raw day.
    out.effects.push({ kind: 'service', service: 'depot', params: { deliveryDay: handed } });
    return { value: { open: true }, summary: `window open on ${handed}`, ref: `W-${handed}` };
  },
  audit: ({ call, summary, ref }) => [{ type: 'window_checked', detail: { day: handed, recorded: call.params.deliveryDay ?? null, days: [handed, 'another day'], summary, ref: ref ?? null, open: true } }],
};

/**
 * The testkit with the delivery day recorded as `how`, a getWindows that repeats it everywhere it
 * can, and its action running the echo rule and a dateInRange rule (whose line shows the value),
 * built through definePolicy so check passes on it. Its tracking form's completion asks for a window.
 */
function probe(how: AuditMask): App {
  const file = structuredClone(TESTKIT_POLICY_FILE);
  file.actions.getWindows!.rules.push({ custom: 'echo' }, { dateInRange: { field: 'deliveryDay', notAfter: '2099-12-31' } });
  file.audit = { ...file.audit, deliveryDay: how };
  const tools = { ...testkitApp.tools, getWindows };
  const customRules = { ...TESTKIT_CUSTOM_RULES, echo };
  const policy = definePolicy(file, { identity: `${TESTKIT_DIR}identity.yaml`, tools, slots: testkitApp.slots, customRules });
  const track = testkitApp.forms.track_parcel!;
  return {
    ...testkitApp,
    id: `record-${how}`,
    tools,
    policy,
    forms: {
      ...testkitApp.forms,
      track_parcel: {
        ...track,
        complete: (c: CompletionContext) => {
          c.callTool({ tool: 'getWindows', params: { accountId: SAM.id, deliveryDay: RAW_DAY, deliveryPart: 'morning' } });
          return { kind: 'said', acks: [...c.acks] };
        },
      },
    },
  };
}

const ctx = (): TurnContext => ({ nowMs: 0, todayIso: '2026-09-18', thresholds: { ...DEFAULT_THRESHOLDS }, tools: demoTools() });

const base: AnswerMap = {
  addressedToSystem: noul(0.95), intelligible: noul(0.95), utteranceComplete: noul(0.9), wantsHuman: noul(0.02),
  rephrasingLastTurn: noul(0.05), confusedByPrompt: noul(0.05), spokeAMenuNumber: noul(0.02), triedSelfService: noul(0.05),
  intentTentative: noul(0.05), intent: choice({ none: 0.9, other: 0.1 }),
};

/** Sam tracks a parcel on the probe (the probe the default app, as a server's one app is): every sink, as text. */
function tracked(app: App) {
  resetAppsForTest();
  registerApp(app);
  configure(consoleMetaOf(app));
  const tc = ctx();
  const turns: { event: SessionEvent; result: TurnResult }[] = [];
  let s: Session = newSession('r', 0, WEB_CHAT, SAM, app.id);
  const start = startEvent();
  turns.push({ event: start, result: resolve(s, start, null, tc) });
  s = turns[0]!.result.session;
  const asked = speechEvent('where is the parcel');
  plan(s, asked, tc);
  turns.push({ event: asked, result: resolve(s, asked, { ...base, intent: choice({ track_parcel: 0.93, none: 0.07 }) }, tc) });
  const records = turns.map(({ event, result }) => buildTraceRecord({
    result, event, questions: null, response: null, error: null, timing: { planMs: 0, askMs: 0, resolveMs: 0, totalMs: 0 }, ts: '2026-09-18T10:00:00.000Z', pricePerMtok: 0,
  }));
  const events: DashboardEvent[] = [{ type: 'call_started', callSid: 'r', at: 0, from: '…0001', todayIso: '2026-09-18', thresholds: DEFAULT_THRESHOLDS }];
  turns.forEach(({ result }, i) => {
    events.push({ type: 'turn', callSid: 'r', at: i, record: redactRecord(records[i]!), spoken: '' });
    events.push({ type: 'audit', callSid: 'r', at: i, entries: result.audit.map((d, seq) => ({ ...d, seq, at: '2026-09-18T10:00:00.000Z', callId: 'r', channel: 'chat', prevHash: '', hash: '' })) });
  });
  const window = turns.flatMap(({ result }) => result.gateEvents).find((e) => e.decision.call.tool === 'getWindows');
  return {
    window,
    audit: turns.flatMap(({ result }) => result.audit),
    sinks: {
      gateEvents: JSON.stringify(turns.flatMap(({ result }) => result.gateEvents)),
      // What the trace writer writes (TraceWriter: the record with its slots and side effects masked).
      trace: JSON.stringify(records.map((r) => redactRecordSlots(r, 'length'))),
      console: JSON.stringify([events, reduce(events, {})]),
      audit: JSON.stringify(turns.flatMap(({ result }) => result.audit)),
    },
  };
}

/** What each declaration records of the raw day, in the call and wherever a text repeats it. */
const SHOWN: Record<Exclude<AuditMask, 'keep'>, { call: string | undefined; text: string }> = {
  last4: { call: '...2-17', text: '...2-17' },
  mask: { call: '•', text: '•' },
  length: { call: '<10 chars>', text: '<10 chars>' },
  secret: { call: undefined, text: '•' },
};

describe('a declared param is recorded as declared, in every sink', () => {
  beforeEach(() => {
    handed = '';
  });

  for (const how of ['last4', 'mask', 'length', 'secret'] as const) {
    it(`${how}: the call, the rules' lines, the summary, the record and the tool's own rows; never the raw day`, () => {
      const { window, audit, sinks } = tracked(probe(how));
      const shown = SHOWN[how];
      expect(window?.decision.verdict).toBe('ALLOW');
      expect(handed).toBe(RAW_DAY);
      // The gate event: the call as declared (a secret one left out), each line with the day masked.
      expect(window!.decision.call.params).toEqual({ accountId: '...5678', ...(shown.call === undefined ? {} : { deliveryDay: shown.call }), deliveryPart: 'morning' });
      expect(window!.decision.rules.slice(-2).map((r) => `${r.id}: ${r.compared}`)).toEqual([
        `echo: day ${shown.text} (${shown.text}) part morning`,
        // A built-in range rule names the field, never its value.
        'dateInRange: deliveryDay on or before 2099-12-31',
      ]);
      expect(window!.summary).toBe(`window open on ${shown.text}`);
      expect(window!.ref).toBe(`W-${shown.text}`);
      // The audit: the gate row's call and lines, and the tool's own row, masked where it repeats the raw day.
      const gate = audit.find((d) => d.type === 'gate' && d.detail.tool === 'getWindows')!;
      expect(gate.detail.call).toBe(describeCall(window!.decision.call));
      expect(audit.find((d) => d.type === 'window_checked')!.detail).toEqual({
        day: shown.text, recorded: shown.call ?? null, days: [shown.text, 'another day'], summary: `window open on ${shown.text}`, ref: `W-${shown.text}`, open: true,
      });
      for (const [sink, text] of Object.entries(sinks)) expect(text, sink).not.toContain(RAW_DAY);
    });
  }

  it('keep: recorded as it is everywhere, so the probe would show a leak', () => {
    const { window, audit, sinks } = tracked(probe('keep'));
    expect(window!.decision.call.params.deliveryDay).toBe(RAW_DAY);
    expect(window!.decision.rules.at(-2)!.compared).toBe(`day ${RAW_DAY} (${RAW_DAY}) part morning`);
    expect(window!.summary).toBe(`window open on ${RAW_DAY}`);
    expect(audit.find((d) => d.type === 'window_checked')!.detail.day).toBe(RAW_DAY);
    for (const [sink, text] of Object.entries(sinks)) expect(text, sink).toContain(RAW_DAY);
  });

  it('a refused call is recorded as declared too, its lines masked', () => {
    const app = probe('mask');
    resetAppsForTest();
    registerApp(app);
    const out = newTurnOut();
    const s = newSession('r', 0, WEB_CHAT, SAM, app.id);
    const { decision } = callTool(s, { tool: 'getWindows', params: { accountId: SAM.id, deliveryDay: '2199-01-01', deliveryPart: 'morning' } }, ctx(), out);
    expect(decision.verdict).toBe('BLOCK');
    expect(decision.call.params.deliveryDay).toBe('•');
    expect(decision.rules.at(-2)!.compared).toBe('day • (•) part morning');
    expect(decision.rules.at(-1)!.compared).toBe('deliveryDay after 2099-12-31');
    expect(JSON.stringify(out.gateEvents)).not.toContain('2199-01-01');
  });
});

describe('the masks', () => {
  const app = (audit: Record<string, AuditMask>): Pick<App, 'slots' | 'policy'> => ({ slots: testkitApp.slots, policy: { ...testkitApp.policy, audit } });

  it('are the five policy.yaml may name', () => {
    expect(policyAudit.valueType.options).toEqual(AUDIT_MASKS);
  });

  it('a redacted slot by its setting, then audit:, then as it is', () => {
    const a = app({ parcel: 'last4', note: 'secret' });
    expect(['accountId', 'dob', 'missingNote', 'parcel', 'note', 'deliveryDay', 'other'].map((p) => recordingOf(a, p))).toEqual(['last4', 'mask', 'length', 'last4', 'secret', 'keep', 'keep']);
  });

  it('each kind of a value, and of an empty one', () => {
    expect((['last4', 'mask', 'length', 'secret', 'keep'] as const).map((h) => recordedValue(h, 'PX-55519876'))).toEqual(['...9876', '•', '<11 chars>', null, 'PX-55519876']);
    expect((['last4', 'mask', 'length', 'secret', 'keep'] as const).map((h) => recordedValue(h, ''))).toEqual(['', '', '<0 chars>', null, '']);
  });

  it('a call: each param as declared, a secret one left out with its name', () => {
    const call: ToolCall = { tool: 't', params: { accountId: '55501234', parcel: 'PX-55519876', note: 'hold it', deliveryDay: RAW_DAY }, purpose: 'p' };
    expect(redactCall(app({ parcel: 'mask', note: 'secret' }), call)).toEqual({ tool: 't', params: { accountId: '...1234', parcel: '•', deliveryDay: RAW_DAY }, purpose: 'p' });
  });
});

describe('the free text beside a call: a rule cannot leak a masked param', () => {
  const app: Pick<App, 'slots' | 'policy'> = { slots: testkitApp.slots, policy: { ...testkitApp.policy, audit: { parcel: 'last4', pin: 'secret', code: 'length', tag: 'mask' } } };
  const call: ToolCall = { tool: 't', params: { accountId: '55501234', parcel: 'PX-55519876', pin: '4321', code: 'Blue Fox', tag: 'z', deliveryDay: RAW_DAY } };
  const scrub = scrubberFor(app, call)!;

  it('every raw value of a param recorded masked or never, as it is or in another case, the longest first', () => {
    expect(scrub('owner 55501234 parcel PX-55519876 pin 4321 code blue fox, BLUE FOX')).toBe('owner ...1234 parcel ...9876 pin • code <8 chars>, <8 chars>');
    // A value kept is left alone, and so is everything else.
    expect(scrub(`day ${RAW_DAY} · identity.level 2 >= 2`)).toBe(`day ${RAW_DAY} · identity.level 2 >= 2`);
  });

  it('a value is masked as a whole token, never inside a longer word or number', () => {
    expect(scrub('pin 4321, pin:4321 (4321) pin 43210 and x4321')).toBe('pin •, pin:• (•) pin 43210 and x4321');
    expect(scrub('Blue Foxes, blue fox.')).toBe('Blue Foxes, <8 chars>.');
  });

  it('a value too short to tell from the line\'s own words is not looked for (the recorded call still masks it)', () => {
    // A one-letter tag: no "c•ller", no "m•y".
    expect(scrub('the zone of z: caller may see ...1234 only')).toBe('the zone of z: caller may see ...1234 only');
    const short = scrubberFor(app, { tool: 't', params: { tag: 'a', pin: '1' } });
    expect(short).toBeNull();
    expect(redactCall(app, { tool: 't', params: { tag: 'a', pin: '1' } }).params).toEqual({ tag: '•' });
    // Three characters and more are looked for.
    expect(scrubberFor(app, { tool: 't', params: { pin: '123' } })!('identity.level 1 >= 2 · pin 123')).toBe('identity.level 1 >= 2 · pin •');
  });

  it('its limit: a value reshaped (reformatted, split, partly quoted) is not recognised', () => {
    expect(scrub('parcel PX 5551 9876, or 55519876')).toBe('parcel PX 5551 9876, or 55519876');
  });

  it('no scrub when nothing is masked: a call of kept params, or of empty ones', () => {
    expect(scrubberFor(app, { tool: 't', params: { deliveryDay: RAW_DAY, other: 'x' } })).toBeNull();
    expect(scrubberFor(app, { tool: 't', params: { parcel: '', pin: '' } })).toBeNull();
  });

  it('a tool\'s own rows: every string, and every string of a list; anything else, and a row that is not one, as it is', () => {
    const rows = scrubbedDrafts([
      { type: 'row', detail: { parcel: 'PX-55519876', list: ['4321', 'kept'], n: 4321, flag: true, none: null } },
      null as never,
    ], scrub);
    expect(rows).toEqual([{ type: 'row', detail: { parcel: '...9876', list: ['•', 'kept'], n: 4321, flag: true, none: null } }, null]);
  });

  it('an app\'s own rule run through the lifecycle: its description and line masked, the gate\'s decision unchanged', () => {
    const peek = (c: { call: ToolCall }) => ({ result: { id: 'peek', description: `parcel ${c.call.params.parcel}`, compared: `pin ${c.call.params.pin}`, pass: true } });
    const tables = { ...testkitApp.policy, audit: { ...testkitApp.policy.audit, parcel: 'last4' as const, pin: 'secret' as const }, rulesFor: { ...testkitApp.policy.rulesFor, peekTool: ['peek'] }, customRules: { ...testkitApp.policy.customRules, peek } };
    const probeApp: App = { ...testkitApp, id: 'record-peek', policy: tables, tools: { ...testkitApp.tools, peekTool: { params: ['parcel', 'pin'], run: () => ({ value: null, summary: 'peeked' }) } } };
    resetAppsForTest();
    registerApp(probeApp);
    const out = newTurnOut();
    const { decision } = callTool(newSession('r', 0, WEB_CHAT, SAM, probeApp.id), { tool: 'peekTool', params: { parcel: 'PX-55519876', pin: '4321' } }, ctx(), out);
    expect(decision).toMatchObject({ verdict: 'ALLOW', call: { tool: 'peekTool', params: { parcel: '...9876' } }, rules: [{ id: 'peek', description: 'parcel ...9876', compared: 'pin •', pass: true }] } satisfies Partial<GateDecision>);
    expect(decision.call.params).not.toHaveProperty('pin');
  });
});
