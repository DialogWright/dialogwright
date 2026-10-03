import { describe, expect, it } from 'vitest';
import { useTestkit } from '../testing/apps';
import { signedInEvent, startEvent } from '../channel/events';
import { VOICE_RELAY, WEB_CHAT } from '../channel/caps';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { demoTools } from '../core/tools';
import { resolve, type TurnContext } from '../core/turn';
import { auditDrafts } from '../core/audit';
import { registerApp } from '../core/app/registry';
import type { App, PolicyTables, ToolDef } from '../core/app/types';
import { validateApp } from '../core/app/validate';
import { newSession } from '../core/session';
import { ANONYMOUS, raise } from './principal';
import { namedDecision } from '../testing/gateGrid';
import { compiledPolicyOf } from './compiled';
import { evaluateCall as legacyEvaluate } from './policy';
import { isAnonymous, isParty, type GateDecision, type GateFacts, type GateLookups, type Party, type Principal, type RuleContext, type RuleOutcome, type ToolCall } from './types';

/**
 * The gate's generic paths, run against a small clinic that is not the testkit: its subject kind is
 * `patient`, and a caregiver acts for patients with a role. What the scope rule compares, who may step up, what
 * the role rule allows and the words on each line all come from the clinic's tables.
 */

useTestkit();

/**
 * The gate both ways: the legacy evaluator over the tables, and the compiled gate the lifecycle runs
 * (for these hand-written tables, the tables read as named rules, gate/compiled.ts programFromTables).
 * Every test here holds the two to the same whole decision (the legacy evaluator records R1..R7 and
 * R0, the gate the rules' names, so the legacy decision goes through the shadow gate's id map), and
 * checks the compiled one.
 */
function evaluateCall(call: ToolCall, p: Principal, f: GateFacts, lk: GateLookups, policy: PolicyTables, subjectKind: string): GateDecision {
  const legacy = legacyEvaluate(call, p, f, lk, policy, subjectKind);
  const compiled = compiledPolicyOf(policy, subjectKind).evaluate(call, p, f, lk);
  expect(compiled).toStrictEqual(namedDecision(legacy));
  return compiled;
}

const ANA: Party = { kind: 'patient', level: 1, id: 'P-1001', first: 'Ana', contact: { phoneLast4: '0101' } };
const ANA2: Party = { ...ANA, level: 2 };
const caregiver = (role: string, level: 1 | 2 = 2): Party => ({ kind: 'caregiver', level, id: 'C-77', first: 'Cam', name: 'Cam Lee', role, attrs: { ward: 'north' } });

/** Visits and their patients; caregivers see the north ward's patients. */
const VISITS: Readonly<Record<string, string>> = { 'V-1': 'P-1001', 'V-2': 'P-2002' };
const LOCKED = new Set(['P-2002']);

interface ClinicLookups extends GateLookups {
  chartLocked(patientId: string): boolean;
}

const lookups: ClinicLookups = {
  ownerOf: (visit) => (Object.hasOwn(VISITS, visit) ? VISITS[visit]! : null),
  scopeOf: (p) => (p.level === 0 ? [] : p.kind === 'patient' ? [p.id] : p.attrs?.ward === 'north' ? ['P-1001', 'P-2002'] : []),
  chartLocked: (id) => LOCKED.has(id),
};

/** The clinic's own rule: a chart may be written only while it is open. */
function chartOpen(c: RuleContext): RuleOutcome {
  const id = c.call.params.patientId ?? '';
  const pass = !(c.lk as ClinicLookups).chartLocked(id);
  const result = { id: 'CHART_OPEN', description: 'The chart is open for changes', compared: `chart ${id} ${pass ? 'open' : 'locked'}`, pass };
  return pass ? { result } : { result, fail: { verdict: 'BLOCK', reason: 'chart-locked' } };
}

const POLICY: PolicyTables = {
  toolLevel: { verifyPatient: 0, verifyCode: 1, sendCode: 1, readChart: 1, getVisit: 2, updateChart: 2, unscoped: 1 },
  purposeLevel: {},
  rulesFor: {
    verifyPatient: ['R6'],
    verifyCode: ['R1', 'R6'],
    sendCode: ['R1', 'R2'],
    readChart: ['R1', 'R2'],
    getVisit: ['R1', 'R2'],
    updateChart: ['R1', 'R5', 'R2', 'CHART_OPEN'],
    unscoped: ['R1', 'R2'],
  },
  serviceFields: {},
  confirmedFields: [],
  maxAttempts: 3,
  roles: { updateChart: { nurse: 'allow', scribe: 'person', viewer: 'refuse' } },
  subjects: {
    sendCode: { param: 'patientId' },
    readChart: { param: 'patientId' },
    getVisit: { param: 'visit', via: 'record' },
    updateChart: { param: 'patientId' },
  },
  customRules: { CHART_OPEN: chartOpen },
};

const facts: GateFacts = { attempts: 0, confirmedHash: null, todayIso: '2026-10-02' };
const gate = (call: ToolCall, p: Principal, policy: PolicyTables = POLICY) => evaluateCall(call, p, facts, lookups, policy, 'patient');
const r = (call: ToolCall, p: Principal, id: string, policy?: PolicyTables) => gate(call, p, policy).rules.find((x) => x.id === id);

const NEUTRAL_SCOPE = 'The record belongs to someone this caller may see';

describe('scope, by the app\'s subjects table', () => {
  it('compares a subject named by param with the caller\'s scope, in neutral words', () => {
    const own = gate({ tool: 'readChart', params: { patientId: 'P-1001' } }, ANA);
    expect(own.verdict).toBe('ALLOW');
    expect(own.rules.at(-1)).toEqual({ id: 'scope', pass: true, description: NEUTRAL_SCOPE, compared: 'subject ...1001 · caller may see ...1001 only' });
    const other = gate({ tool: 'readChart', params: { patientId: 'P-2002' } }, ANA);
    expect(other).toMatchObject({ verdict: 'BLOCK', reason: 'scope' });
    expect(other.rules.at(-1)).toMatchObject({ pass: false, compared: 'subject ...2002 · caller may see ...1001 only' });
    expect(r({ tool: 'readChart', params: {} }, ANA, 'scope')).toMatchObject({ pass: false, compared: 'subject missing · caller may see ...1001 only' });
  });

  it('resolves a subject named by a record to its owner, and fails closed on an unknown one', () => {
    expect(gate({ tool: 'getVisit', params: { visit: 'V-1' } }, ANA2).verdict).toBe('ALLOW');
    const other = gate({ tool: 'getVisit', params: { visit: 'V-2' } }, ANA2);
    expect(other).toMatchObject({ verdict: 'BLOCK', reason: 'scope' });
    expect(other.rules.at(-1)).toMatchObject({ description: NEUTRAL_SCOPE, compared: 'record owner ...2002 · caller may see ...1001 only' });
    expect(r({ tool: 'getVisit', params: { visit: 'V-9' } }, ANA2, 'scope')).toMatchObject({ pass: false, compared: 'record owner unknown · caller may see ...1001 only' });
    expect(r({ tool: 'getVisit', params: { visit: '' } }, ANA2, 'scope')).toMatchObject({ pass: false, compared: 'record owner unknown · caller may see ...1001 only' });
  });

  it('lets a party acting for subjects see those in its scope', () => {
    const d = gate({ tool: 'getVisit', params: { visit: 'V-2' } }, caregiver('nurse'));
    expect(d.verdict).toBe('ALLOW');
    expect(d.rules.at(-1)).toMatchObject({ compared: 'record owner ...2002 · caller may see ...1001, ...2002' });
  });

  it('BLOCKs a tool that runs scope with no row in the subjects table (fails closed)', () => {
    const d = gate({ tool: 'unscoped', params: { patientId: 'P-1001' } }, ANA);
    expect(d).toMatchObject({ verdict: 'BLOCK', reason: 'scope' });
    expect(d.rules.at(-1)).toMatchObject({ id: 'scope', pass: false, compared: 'tool unscoped names no subject · caller may see ...1001 only' });
  });

  it('words its lines in the app\'s terms when the app gives them', () => {
    const worded: PolicyTables = {
      ...POLICY,
      wording: {
        scope: { subject: { param: "The chart is the patient's own" }, delegate: { record: 'The visit is for a patient on the caller\'s ward' } },
        recordOwner: 'visit of',
        subject: 'patient',
      },
    };
    expect(r({ tool: 'readChart', params: { patientId: 'P-1001' } }, ANA, 'scope', worded)).toMatchObject({ description: "The chart is the patient's own", compared: 'patient ...1001 · caller may see ...1001 only' });
    expect(r({ tool: 'getVisit', params: { visit: 'V-1' } }, caregiver('nurse'), 'scope', worded)).toMatchObject({ description: "The visit is for a patient on the caller's ward", compared: 'visit of ...1001 · caller may see ...1001, ...2002' });
    // A case the app's wording leaves out keeps the neutral line.
    expect(r({ tool: 'getVisit', params: { visit: 'V-1' } }, ANA2, 'scope', worded)).toMatchObject({ description: NEUTRAL_SCOPE });
  });
});

describe('identity, by the app\'s subject kind', () => {
  it('steps a subject or an anonymous caller up, and BLOCKs a party who is not a subject below the level', () => {
    expect(gate({ tool: 'readChart', params: { patientId: '' } }, ANONYMOUS)).toMatchObject({ verdict: 'STEP_UP', needLevel: 1 });
    expect(gate({ tool: 'getVisit', params: { visit: 'V-1' } }, ANA)).toMatchObject({ verdict: 'STEP_UP', needLevel: 2 });
    const d = gate({ tool: 'getVisit', params: { visit: 'V-1' } }, caregiver('nurse', 1));
    expect(d).toMatchObject({ verdict: 'BLOCK', reason: 'identity' });
    expect(d.rules).toEqual([{ id: 'identity', description: 'Identity strong enough for this action', compared: 'identity.level 1 >= 2', pass: false }]);
  });

  it('decides by the subject kind it is given, not by any kind of its own', () => {
    // The same caregiver, were caregivers the app's subjects, would be stepped up instead.
    const d = evaluateCall({ tool: 'getVisit', params: { visit: 'V-1' } }, caregiver('nurse', 1), facts, lookups, POLICY, 'caregiver');
    expect(d).toMatchObject({ verdict: 'STEP_UP', needLevel: 2 });
  });
});

describe('role, by the app\'s roles table', () => {
  const call: ToolCall = { tool: 'updateChart', params: { patientId: 'P-1001' } };

  it('allows, refuses or hands to a person by role, in neutral words', () => {
    expect(r(call, caregiver('nurse'), 'role')).toMatchObject({ pass: true, compared: 'role nurse may updateChart: yes' });
    expect(gate(call, caregiver('nurse')).verdict).toBe('ALLOW');
    expect(gate(call, caregiver('viewer'))).toMatchObject({ verdict: 'BLOCK', reason: 'role' });
    expect(r(call, caregiver('viewer'), 'role')).toMatchObject({ pass: false, compared: 'role viewer may updateChart: no' });
    expect(gate(call, caregiver('scribe'))).toMatchObject({ verdict: 'NEEDS_HUMAN', reason: 'role-person' });
    expect(r(call, caregiver('scribe'), 'role')).toMatchObject({ pass: false, compared: 'role scribe may updateChart: with a person' });
  });

  it('refuses a role with no row; passes a subject with no role, and refuses any other party with none', () => {
    expect(gate(call, caregiver('porter'))).toMatchObject({ verdict: 'BLOCK', reason: 'role' });
    expect(r(call, ANA2, 'role')).toEqual({ id: 'role', description: 'The caller\'s role allows this action', compared: 'role patient', pass: true });
    // A caregiver built without a role acts for patients with no rights a role would give: it fails closed.
    const { role: _none, ...roleless } = caregiver('nurse');
    expect(gate(call, roleless)).toMatchObject({ verdict: 'BLOCK', reason: 'role' });
    expect(r(call, roleless, 'role')).toEqual({ id: 'role', description: 'The caller\'s role allows this action', compared: 'role caregiver: none', pass: false });
  });

  it('takes the app\'s reason and words for its lines', () => {
    const own: PolicyTables = { ...POLICY, rolePersonReason: 'charting-desk', wording: { role: (role, tool, access) => `${role}/${tool}/${access}` } };
    expect(gate(call, caregiver('scribe'), own)).toMatchObject({ verdict: 'NEEDS_HUMAN', reason: 'charting-desk' });
    expect(r(call, caregiver('viewer'), 'role', own)).toMatchObject({ compared: 'viewer/updateChart/refuse' });
  });
});

describe('an app\'s own rule', () => {
  it('runs in the order rulesFor lists it, with the lookups the app gave', () => {
    const open = gate({ tool: 'updateChart', params: { patientId: 'P-1001' } }, caregiver('nurse'));
    expect(open.verdict).toBe('ALLOW');
    expect(open.rules.map((x) => [x.id, x.pass])).toEqual([['identity', true], ['role', true], ['scope', true], ['CHART_OPEN', true]]);
    const locked = gate({ tool: 'updateChart', params: { patientId: 'P-2002' } }, caregiver('nurse'));
    expect(locked).toMatchObject({ verdict: 'BLOCK', reason: 'chart-locked' });
    expect(locked.rules.at(-1)).toEqual({ id: 'CHART_OPEN', description: 'The chart is open for changes', compared: 'chart P-2002 locked', pass: false });
  });

  it('is unknown to an app that does not define it: the gate BLOCKs', () => {
    const { customRules: _none, ...without } = POLICY;
    const d = gate({ tool: 'updateChart', params: { patientId: 'P-1001' } }, caregiver('nurse'), without);
    expect(d).toMatchObject({ verdict: 'BLOCK', reason: 'unknown-rule' });
    expect(d.rules.at(-1)).toMatchObject({ id: 'CHART_OPEN', compared: 'rule CHART_OPEN unknown', pass: false });
  });
});

describe('raise', () => {
  it('raises one of the app\'s subjects to level 2, and no one else', () => {
    expect(raise(ANA, 2, 'patient')).toEqual({ ...ANA, level: 2 });
    expect(raise(caregiver('nurse', 1), 2, 'patient')).toBeNull();
    expect(raise(ANONYMOUS, 2, 'patient')).toBeNull();
  });
});

const run: ToolDef = { run: () => ({ value: null, summary: '' }) };

/** The clinic as an App: only what validateApp and the audit read. */
const clinic = (policy: Partial<PolicyTables> = {}, id = 'clinic'): App => ({
  id,
  intents: Object.fromEntries(['agent', 'repeat_prompt', 'done'].map((i) => [i, { criteria: '', label: i, kind: 'control' as const }])),
  menu: [],
  forms: {},
  slots: {},
  identity: { subjectKind: 'patient', factorSlots: [], verifyTool: 'verifyPatient', codeTool: 'verifyCode', sendCodeTool: 'sendCode' },
  tools: Object.fromEntries(Object.keys(POLICY.rulesFor).map((t) => [t, run])),
  policy: { ...POLICY, subjects: { ...POLICY.subjects, unscoped: { param: 'patientId' } }, ...policy },
  systems: () => ({ sys: null, lookups }),
  prompts: { manifest: {}, tags: {} },
});

describe('validateApp, on the gate\'s tables', () => {
  it('accepts a rule id that is a built-in or the app\'s own', () => {
    expect(() => validateApp(clinic())).not.toThrow();
  });

  it('refuses a rule id that is neither a built-in nor the app\'s own', () => {
    expect(() => validateApp(clinic({ rulesFor: { ...POLICY.rulesFor, readChart: ['R1', 'R9'] } }))).toThrow(/tool "readChart" names unknown rule "R9"/);
    // R4 is not the gate's: an app that names it must define it.
    expect(() => validateApp(clinic({ rulesFor: { ...POLICY.rulesFor, readChart: ['R1', 'R4'] } }))).toThrow(/unknown rule "R4"/);
    const { customRules: _none, ...without } = POLICY;
    expect(() => validateApp({ ...clinic(), policy: { ...without, subjects: { ...POLICY.subjects, unscoped: { param: 'patientId' } } } })).toThrow(/unknown rule "CHART_OPEN"/);
  });

  it('refuses an app rule that takes a built-in\'s id', () => {
    expect(() => validateApp(clinic({ customRules: { CHART_OPEN: chartOpen, R2: chartOpen } }))).toThrow(/custom rule "R2" has a built-in rule's id/);
  });

  it('refuses an app rule that takes a built-in rule\'s name or `unlisted`, as it does a legacy id', () => {
    for (const id of ['identity', 'scope', 'confirmed', 'role', 'attempts', 'fields', 'dateInRange', 'limit', 'unlisted']) {
      expect(() => validateApp(clinic({ customRules: { CHART_OPEN: chartOpen, [id]: chartOpen } })), id).toThrow(new RegExp(`custom rule "${id}" has a built-in rule's id`));
    }
  });

  it('refuses a tool that runs scope with no subject, and a subject for a tool with no rules', () => {
    expect(() => validateApp(clinic({ subjects: POLICY.subjects }))).toThrow(/tool "unscoped" runs R2 but names no subject/);
    expect(() => validateApp(clinic({ subjects: { ...POLICY.subjects, unscoped: { param: 'x' }, ghost: { param: 'x' } } }))).toThrow(/subject for tool "ghost", which has no rules/);
  });

  it('refuses a subject kind that is not a lowercase word', () => {
    for (const kind of ['Patient', 'pa-tient', '1patient', '']) {
      expect(() => validateApp({ ...clinic(), identity: { ...clinic().identity!, subjectKind: kind } })).toThrow(/is not a lowercase word/);
    }
  });

  it('refuses an app rule that is not a function, or that takes R0 or unlisted', () => {
    expect(() => validateApp(clinic({ customRules: { CHART_OPEN: 'yes' as never } }))).toThrow(/custom rule "CHART_OPEN" is not a function/);
    expect(() => validateApp(clinic({ customRules: { CHART_OPEN: chartOpen, R0: chartOpen } }))).toThrow(/custom rule "R0" has a built-in rule's id/);
  });

  it('refuses a subject row with no param or an unknown via', () => {
    const subjects = { ...POLICY.subjects, unscoped: { param: 'patientId' } };
    expect(() => validateApp(clinic({ subjects: { ...subjects, readChart: { param: 'patientId', via: 'owner' as never } } }))).toThrow(/subject for tool "readChart" has an unknown via "owner"/);
    expect(() => validateApp(clinic({ subjects: { ...subjects, readChart: { param: '' } } }))).toThrow(/subject for tool "readChart" names no param/);
  });

  it('refuses "anonymous", or a word the audit records a subject beside, as the subject kind', () => {
    for (const kind of ['anonymous', 'level']) {
      expect(() => validateApp({ ...clinic(), identity: { ...clinic().identity!, subjectKind: kind } })).toThrow(new RegExp(`subjectKind "${kind}" is reserved`));
    }
  });
});

describe('the audit names a subject by the app\'s word for them', () => {
  registerApp(clinic({}, 'clinic-audit'));
  const started = (p: Principal) => {
    const s = newSession('c', 0, VOICE_RELAY, p, 'clinic-audit');
    return auditDrafts({ before: s, after: s, event: startEvent(), decision: { kind: 'prompt', promptId: 'greeting', vars: {}, acks: [], target: 'intent', options: [] }, gateEvents: [], kb: null, screen: null, quarantined: false });
  };

  it('keys a subject\'s masked id by their kind, and names anyone else by kind and level only', () => {
    expect(started(ANA)).toEqual([{ type: 'call_started', detail: { channel: 'voice', principal: 'patient', level: 1, patient: '...1001' } }]);
    expect(started(caregiver('nurse'))).toEqual([{ type: 'call_started', detail: { channel: 'voice', principal: 'caregiver', level: 2 } }]);
  });
});

describe('the gate fails closed on what an app hands it', () => {
  const call: ToolCall = { tool: 'updateChart', params: { patientId: 'P-1001' } };
  const nurse = caregiver('nurse');
  const withRule = (rule: (c: RuleContext) => RuleOutcome): PolicyTables => ({ ...POLICY, customRules: { CHART_OPEN: rule } });
  const line = { description: 'd', compared: 'c' };

  it('BLOCKs an app rule whose outcome does not hold together', () => {
    const invalid = [
      () => ({ result: { id: 'CHART_OPEN', ...line, pass: false }, fail: { verdict: 'ALLOW' } }),
      () => ({ result: { id: 'CHART_OPEN', ...line, pass: false }, fail: {} }),
      () => ({ result: { id: 'CHART_OPEN', ...line, pass: false } }),
      () => ({ result: { id: 'CHART_OPEN', ...line, pass: true }, fail: { verdict: 'BLOCK', reason: 'x' } }),
      () => undefined,
      () => ({ result: { id: 'CHART_OPEN', pass: true } }),
    ] as unknown as Array<(c: RuleContext) => RuleOutcome>;
    for (const rule of invalid) {
      const d = gate(call, nurse, withRule(rule));
      expect(d).toMatchObject({ verdict: 'BLOCK', reason: 'rule-invalid' });
      expect(d.rules.at(-1)).toEqual({ id: 'CHART_OPEN', description: 'A rule that answers as the gate needs', compared: 'rule CHART_OPEN answered invalidly', pass: false });
    }
  });

  it('stamps an app rule\'s line with its own id, and takes only the decision\'s fields from its failure', () => {
    const posing = gate(call, nurse, withRule(() => ({ result: { id: 'scope', ...line, pass: true } })));
    expect(posing.verdict).toBe('ALLOW');
    expect(posing.rules.at(-1)).toEqual({ id: 'CHART_OPEN', ...line, pass: true });
    const smuggling = (() => ({ result: { id: 'CHART_OPEN', ...line, pass: false }, fail: { verdict: 'NEEDS_HUMAN', reason: 'r', call: { tool: 'x', params: {} }, rules: [] } })) as unknown as (c: RuleContext) => RuleOutcome;
    const d = gate(call, nurse, withRule(smuggling));
    expect(d).toEqual({ call, rules: [...d.rules.slice(0, -1), { id: 'CHART_OPEN', ...line, pass: false }], verdict: 'NEEDS_HUMAN', reason: 'r' });
    expect(d.rules.map((x) => x.id)).toEqual(['identity', 'role', 'scope', 'CHART_OPEN']);
  });

  it('BLOCKs a rule that throws, an app\'s own or a built-in over the app\'s lookups', () => {
    const d = gate(call, nurse, withRule(() => { throw new Error('boom'); }));
    expect(d).toMatchObject({ verdict: 'BLOCK', reason: 'rule-error' });
    expect(d.rules.at(-1)).toEqual({ id: 'CHART_OPEN', description: 'A rule the gate could run', compared: 'rule CHART_OPEN threw', pass: false });
    const throwing: GateLookups = { ownerOf: () => { throw new Error('down'); }, scopeOf: () => { throw new Error('down'); } };
    const viaScope = evaluateCall({ tool: 'readChart', params: { patientId: 'P-1001' } }, ANA, facts, throwing, POLICY, 'patient');
    expect(viaScope).toMatchObject({ verdict: 'BLOCK', reason: 'rule-error' });
    expect(viaScope.rules.at(-1)).toMatchObject({ id: 'scope', compared: 'rule scope threw' });
    const viaOwner = evaluateCall({ tool: 'getVisit', params: { visit: 'V-1' } }, ANA2, facts, { ...lookups, ownerOf: throwing.ownerOf }, POLICY, 'patient');
    expect(viaOwner).toMatchObject({ verdict: 'BLOCK', reason: 'rule-error' });
  });

  it('treats an empty owner or subject as none', () => {
    const blank: GateLookups = { ownerOf: () => '', scopeOf: () => [''] };
    const byRecord = evaluateCall({ tool: 'getVisit', params: { visit: 'V-1' } }, ANA2, facts, blank, POLICY, 'patient');
    expect(byRecord).toMatchObject({ verdict: 'BLOCK', reason: 'scope' });
    expect(byRecord.rules.at(-1)).toMatchObject({ compared: 'record owner unknown · caller may see ... only' });
    expect(evaluateCall({ tool: 'readChart', params: { patientId: '' } }, ANA, facts, blank, POLICY, 'patient')).toMatchObject({ verdict: 'BLOCK', reason: 'scope' });
  });

  it('finds no rules for a tool named after an object property: R0', () => {
    for (const tool of ['constructor', 'toString', '__proto__']) {
      const d = gate({ tool, params: {} }, ANA2);
      expect(d).toMatchObject({ verdict: 'BLOCK', reason: 'unknown-tool' });
      expect(d.rules).toEqual([{ id: 'unlisted', description: 'The action is on the approved list', compared: `tool ${tool} not in policy`, pass: false }]);
    }
  });
});

describe('isAnonymous and isParty', () => {
  it('tell a proven party from the anonymous caller and from anything malformed', () => {
    expect(isAnonymous(ANONYMOUS)).toBe(true);
    expect(isAnonymous(ANA)).toBe(false);
    expect(isParty(ANA)).toBe(true);
    expect(isParty(caregiver('nurse'))).toBe(true);
    for (const bad of [ANONYMOUS, null, undefined, 'P-1001', { ...ANA, id: '' }, { ...ANA, level: 0 }, { ...ANA, level: 3 }, { ...ANA, kind: 'anonymous' }, { kind: 'patient', level: 1, first: 'Ana' }]) {
      expect(isParty(bad)).toBe(false);
    }
  });

  it('a portal sign-in that is not a proven party is ignored', () => {
    const tc: TurnContext = { nowMs: 0, todayIso: '2026-10-02', thresholds: { ...DEFAULT_THRESHOLDS }, tools: demoTools() };
    const web = resolve(newSession('w', 0, WEB_CHAT), startEvent(), null, tc).session;
    for (const bad of [{ kind: 'customer', level: 2, id: '', first: 'X' }, { kind: 'anonymous', level: 2, id: '55501234', first: 'X' }]) {
      const r = resolve(web, signedInEvent(bad as Party), null, tc);
      expect(r.decision).toEqual({ kind: 'ignore' });
      expect(r.session.principal).toEqual(ANONYMOUS);
      expect(r.audit).toEqual([]);
    }
  });
});
