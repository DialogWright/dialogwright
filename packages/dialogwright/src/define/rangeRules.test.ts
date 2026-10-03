import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { VOICE_RELAY } from '../channel/caps';
import { speechEvent, startEvent } from '../channel/events';
import { registerApp } from '../core/app/registry';
import type { App, PolicyTables } from '../core/app/types';
import type { Session } from '../core/session';
import { validateApp } from '../core/app/validate';
import { newSession } from '../core/session';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { mockCodeVerifier } from '../core/tools';
import { resolve, type TurnContext, type TurnResult } from '../core/turn';
import { compiledPolicyOf, sourceOf } from '../gate/compiled';
import { evaluateCall } from '../gate/policy';
import { ANONYMOUS } from '../gate/principal';
import type { GateDecision, GateLookups } from '../gate/types';
import type { AnswerMap } from '../jev/types';
import { choice, noul, score } from '../testing/answers';
import { gateGridInput, gridUnexercised, legacyGateEvaluator, runGateGrid } from '../testing/gateGrid';
import { gateEvaluator } from '../testing/shadowGate';
import { AppDefinitionError, defineApp } from './defineApp';
import { definePolicy } from './definePolicy';
import { LIBRARY_DIR, libraryCode, libraryPolicyMatrix, LibrarySystems } from './fixture/app';
import type { Problem } from './problems';

/**
 * The range rules from the file's side: policy.yaml's dateInRange and limit, checked (their shapes,
 * the lookups their references call, the params they read), compiled to the gate, refused by
 * validateApp where only tables name them, run in a whole call of an app built by defineApp, and put
 * through the gate grid. The legacy evaluator does not know them, so the grid has no reference for an
 * app that uses one: it checks that the gate is stable and fails closed instead.
 */

const problemsOf = (build: () => unknown): string[] => {
  try {
    build();
  } catch (error) {
    if (!(error instanceof AppDefinitionError)) throw error;
    return error.problems.map((p: Problem) => `${p.path}: ${p.message} -> ${p.fix}`);
  }
  return [];
};

/** The two tools, each with the params its calls may carry (ToolDef.params). */
const TOOLS = { refundOrder: { params: ['orderId', 'amount', 'returnDate', 'pickupDate'] }, returnItem: { params: [] } };
const LOOKUPS = ['orderTotal', 'returnWindow', 'order'];
const refund = (rules: unknown[]) => ({ actions: { refundOrder: { level: 0, rules }, returnItem: { level: 0, rules: [] } } });
const policyWith = (rules: unknown[], lookups: readonly string[] = LOOKUPS): string[] => problemsOf(() => definePolicy(refund(rules), { tools: TOOLS, lookups }));

describe('policy.yaml: the range rules checked', () => {
  it('a valid policy compiles, each range rule under its name, and the gate reads its parameters', () => {
    const rules = [
      { fields: ['orderId', 'amount', 'returnDate'] },
      { limit: { field: 'amount', min: 0.01, max: 'orderTotal(orderId)' } },
      { dateInRange: { field: 'returnDate', notBefore: 'order(orderId).deliveredOn', notAfter: 'today', within: 'returnWindow(orderId)', reasons: { outsideWindow: 'late-return' }, verdicts: { outsideWindow: 'NEEDS_HUMAN' } } },
    ];
    expect(policyWith(rules)).toEqual([]);
    const tables = definePolicy(refund(rules), { tools: TOOLS, lookups: LOOKUPS });
    expect(tables.rulesFor.refundOrder).toEqual(['R7', 'limit', 'dateInRange']);
    expect(sourceOf(tables)?.actions.refundOrder?.rules[2]).toEqual({
      rule: 'dateInRange',
      field: 'returnDate',
      notBefore: { kind: 'lookup', ref: { lookup: 'order', param: 'orderId', field: 'deliveredOn' } },
      notAfter: { kind: 'today' },
      within: { lookup: 'returnWindow', param: 'orderId' },
      reasons: { outsideWindow: 'late-return' },
      verdicts: { outsideWindow: 'NEEDS_HUMAN' },
    });
    const relative = definePolicy(refund([{ dateInRange: { field: 'returnDate', notBefore: 'today-7', notAfter: 'today+30' } }]), { tools: TOOLS, lookups: LOOKUPS });
    expect(sourceOf(relative)?.actions.refundOrder?.rules[0]).toEqual({ rule: 'dateInRange', field: 'returnDate', notBefore: { kind: 'today', days: -7 }, notAfter: { kind: 'today', days: 30 } });
    expect(sourceOf(tables)?.actions.refundOrder?.rules[1]).toEqual({ rule: 'limit', field: 'amount', min: { kind: 'number', value: '0.01' }, max: { kind: 'lookup', ref: { lookup: 'orderTotal', param: 'orderId' } } });
    // Two range rules of one kind may hold two params, one each; the same param twice is one rule listed twice.
    expect(policyWith([{ dateInRange: { field: 'returnDate', notAfter: 'today' } }, { dateInRange: { field: 'pickupDate', notBefore: 'today' } }])).toEqual([]);
    expect(policyWith([{ limit: { field: 'amount', max: 5 } }, { limit: { field: 'amount', min: 1 } }])).toEqual([
      'actions.refundOrder.rules[1]: the rule "limit: amount" is listed twice -> delete one of the two: a rule runs once per action',
    ]);
  });

  it('a rule with no bound, or literal bounds the wrong way round, never decides anything useful', () => {
    expect(policyWith([{ dateInRange: { field: 'returnDate' } }, { limit: { field: 'amount' } }])).toEqual([
      'actions.refundOrder.rules[0].dateInRange: the rule names no bound: write "notBefore", "notAfter" or "within" -> add "notAfter: today", or another bound',
      'actions.refundOrder.rules[1].limit: the rule names no bound: write "min" or "max" -> add "max: <a number or a reference>"',
    ]);
    expect(policyWith([{ dateInRange: { field: 'returnDate', notBefore: '2026-12-01', notAfter: '2026-01-01' } }, { limit: { field: 'amount', min: 10, max: '9.99' } }])).toEqual([
      'actions.refundOrder.rules[0].dateInRange.notBefore: notBefore (2026-12-01) is after notAfter (2026-01-01), so no value is within both -> swap them, or correct the one that is wrong',
      'actions.refundOrder.rules[1].limit.min: min (10) is after max (9.99), so no value is within both -> swap them, or correct the one that is wrong',
    ]);
    // Two bounds that both count from today are ordered too; a date and a number of days from today are not (today moves).
    expect(policyWith([{ dateInRange: { field: 'returnDate', notBefore: 'today+30', notAfter: 'today+7' } }])).toEqual([
      'actions.refundOrder.rules[0].dateInRange.notBefore: notBefore (today+30) is after notAfter (today+7), so no value is within both -> swap them, or correct the one that is wrong',
    ]);
    expect(policyWith([{ dateInRange: { field: 'returnDate', notBefore: 'today+1', notAfter: 'today' } }])).toHaveLength(1);
    expect(policyWith([{ dateInRange: { field: 'returnDate', notBefore: 'today-7', notAfter: 'today+30' } }])).toEqual([]);
    expect(policyWith([{ dateInRange: { field: 'returnDate', notBefore: '2099-01-01', notAfter: 'today+30' } }])).toEqual([]);
  });

  it('a bound that is not a date, a number or a reference; a reference to what it may not reach', () => {
    const problems = policyWith([
      { dateInRange: { field: 'returnDate', notAfter: '2026-02-30', notBefore: 'yesterday', within: 'returnWindow(order id)' } },
      { limit: { field: 'amount', min: '1,000', max: 'order(orderId).constructor' } },
    ]);
    expect(problems).toEqual([
      'actions.refundOrder.rules[0].dateInRange.notBefore: "yesterday" is not a reference: write <lookup>(<param>), or <lookup>(<param>).<field>, each a plain word with no spaces; a date bound is "today", today+N or today-N, a date (yyyy-mm-dd) or a reference -> write "today", a number of days from today such as today+30 or today-7, a date such as 2026-01-31, or <lookup>(<param>) or <lookup>(<param>).<field>: a lookup the app\'s code declares (code.lookups), called with one of the action\'s params',
      'actions.refundOrder.rules[0].dateInRange.notAfter: "2026-02-30" is not a day the calendar has -> write "today", a number of days from today such as today+30 or today-7, a date such as 2026-01-31, or <lookup>(<param>) or <lookup>(<param>).<field>: a lookup the app\'s code declares (code.lookups), called with one of the action\'s params',
      'actions.refundOrder.rules[0].dateInRange.within: "returnWindow(order id)" is not a reference: write <lookup>(<param>), or <lookup>(<param>).<field>, each a plain word with no spaces -> write <lookup>(<param>) or <lookup>(<param>).<field>: a lookup the app\'s code declares (code.lookups), called with one of the action\'s params',
      'actions.refundOrder.rules[1].limit.min: "1,000" is not a reference: write <lookup>(<param>), or <lookup>(<param>).<field>, each a plain word with no spaces; a number bound is a number or a reference -> write a number such as 100 or 0.01, or <lookup>(<param>) or <lookup>(<param>).<field>: a lookup the app\'s code declares (code.lookups), called with one of the action\'s params',
      'actions.refundOrder.rules[1].limit.max: the field "constructor" is a name every object has (from Object.prototype), not a field a lookup returns; a number bound is a number or a reference -> write a number such as 100 or 0.01, or <lookup>(<param>) or <lookup>(<param>).<field>: a lookup the app\'s code declares (code.lookups), called with one of the action\'s params',
    ]);
    const fix = 'write "today", a number of days from today such as today+30 or today-7, a date such as 2026-01-31, or <lookup>(<param>) or <lookup>(<param>).<field>: a lookup the app\'s code declares (code.lookups), called with one of the action\'s params';
    expect(policyWith([{ dateInRange: { field: 'returnDate', notBefore: 'today-0', notAfter: 'today + 30' } }])).toEqual([
      `actions.refundOrder.rules[0].dateInRange.notBefore: "today-0" is not a number of days from today: write today+N or today-N, N a whole number from 1 to 3660, with no spaces and no leading zero -> ${fix}`,
      `actions.refundOrder.rules[0].dateInRange.notAfter: "today + 30" is not a number of days from today: write today+N or today-N, N a whole number from 1 to 3660, with no spaces and no leading zero -> ${fix}`,
    ]);
    for (const text of ['today+3661', 'today+030', 'today+1.5', 'today+30d', 'today+']) {
      expect(policyWith([{ dateInRange: { field: 'returnDate', notAfter: text } }]), text).toEqual([
        `actions.refundOrder.rules[0].dateInRange.notAfter: "${text}" is not a number of days from today: write today+N or today-N, N a whole number from 1 to 3660, with no spaces and no leading zero -> ${fix}`,
      ]);
    }
    for (const text of ['toString(orderId)', '__proto__(orderId)', 'prototype(orderId)', 'scopeOf(orderId)', 'ownerOf(orderId)', 'order(orderId).__proto__', 'order(orderId).total.cents']) {
      expect(policyWith([{ limit: { field: 'amount', max: text } }]), text).toHaveLength(1);
    }
  });

  it('a bad shape: an unknown key, a verdict that is not BLOCK or NEEDS_HUMAN, a window\'s reason with no window, a field that is no param name', () => {
    expect(policyWith([
      { dateInRange: { field: 'returnDate', notAfter: 'today', verdicts: { outOfRange: 'STEP_UP', outsideWindow: 'NEEDS_HUMAN' }, reasons: { outsideWindow: 'late' }, notafter: 'today' } },
      { limit: { field: 'refund amount', max: 5, verdicts: { invalid: 'NEEDS_HUMAN' } } },
    ])).toEqual([
      'actions.refundOrder.rules[0].dateInRange.verdicts.outOfRange: "outOfRange" is "STEP_UP", which is not allowed here; it must be one of "BLOCK", "NEEDS_HUMAN" -> use one of "BLOCK", "NEEDS_HUMAN"',
      'actions.refundOrder.rules[0].dateInRange.notafter: unknown key "notafter" under actions.refundOrder.rules[0].dateInRange -> rename "notafter" to "notAfter"',
      'actions.refundOrder.rules[0].dateInRange.reasons.outsideWindow: the rule has no "within", so it is never outside a window -> delete it, or add "within: <lookup>(<param>)"',
      'actions.refundOrder.rules[0].dateInRange.verdicts.outsideWindow: the rule has no "within", so it is never outside a window -> delete it, or add "within: <lookup>(<param>)"',
      'actions.refundOrder.rules[1].limit.field: "refund amount" is not a valid id: it must start with a letter and use only letters, digits and underscores -> rename it using only letters, digits and underscores, starting with a letter (for example "ask_name" or "patientId")',
      'actions.refundOrder.rules[1].limit.verdicts.invalid: unknown key "invalid" under actions.refundOrder.rules[1].limit.verdicts -> delete "invalid"; the keys allowed under actions.refundOrder.rules[1].limit.verdicts are outOfRange',
    ]);
    expect(policyWith(['limit', { limit: 5 }]).map((p) => p.split(' -> ')[0])).toEqual([
      'actions.refundOrder.rules[0]: the limit rule takes parameters, so it is written as a map',
      'actions.refundOrder.rules[1].limit: "limit" must be a map, but is a number (5)',
    ]);
  });

  it('a lookup the code does not declare, and a param the action does not send', () => {
    expect(policyWith([{ limit: { field: 'amount', max: 'orderTotl(orderId)' } }])).toEqual([
      'actions.refundOrder.rules[0].limit.max: orderTotl(orderId) calls the lookup "orderTotl", which the code does not declare -> rename it to "orderTotal", or add "orderTotl" to code.lookups and a function of that name to the gate\'s lookups (code.systems), or correct the reference',
    ]);
    expect(policyWith([{ limit: { field: 'amount', max: 'orderTotal(orderId)' } }], [])).toHaveLength(1);
    expect(policyWith([
      { confirmed: ['orderId', 'amount'] },
      { limit: { field: 'amont', max: 'orderTotal(order)' } },
    ])).toEqual([
      'actions.refundOrder.rules[1].limit.field: "amont" is not a param "refundOrder" sends (its confirmed rule lists orderId, amount) -> rename it to "amount", or name one of those, or add "amont" to its confirmed rule',
      'actions.refundOrder.rules[1].limit.max: orderTotal(order) reads "order", which is not a param "refundOrder" sends (its confirmed rule lists orderId, amount) -> rename it to "orderId", or call the lookup with one of those, or add "order" to its confirmed rule',
    ]);
    // With no fields or confirmed rule, the params an action sends are the ones its tool lists (ToolDef.params).
    expect(policyWith([{ limit: { field: 'amonut', max: 'orderTotal(ordrId)' } }])).toEqual([
      'actions.refundOrder.rules[0].limit.field: "amonut" is not a param "refundOrder" sends (its tool lists orderId, amount, returnDate, pickupDate) -> rename it to "amount", or name one of those, or add "amonut" to code.tools.refundOrder.params',
      'actions.refundOrder.rules[0].limit.max: orderTotal(ordrId) reads "ordrId", which is not a param "refundOrder" sends (its tool lists orderId, amount, returnDate, pickupDate) -> rename it to "orderId", or call the lookup with one of those, or add "ordrId" to code.tools.refundOrder.params',
    ]);
    // And with neither, they are not known: nothing to check them against.
    expect(problemsOf(() => definePolicy(refund([{ limit: { field: 'anything', max: 'orderTotal(whatever)' } }]), { lookups: LOOKUPS }))).toEqual([]);
  });

  it('the code\'s lookups are plain words of its own; an app\'s own rule may not take a range rule\'s name', () => {
    expect(problemsOf(() => definePolicy(refund([]), { tools: TOOLS, lookups: ['orderTotal', 'constructor', 'scopeOf', 'order total'] }))).toEqual([
      'code.lookups[1]: "constructor" is a name every object has (from Object.prototype), not one of the app\'s lookups -> name a function of the gate\'s lookups with a plain word of its own, in code.lookups',
      'code.lookups[2]: "scopeOf" is one of the gate\'s own lookups, which take a record id or a caller, not a param\'s value -> name a function of the gate\'s lookups with a plain word of its own, in code.lookups',
      'code.lookups[3]: "order total" is not a plain word (a letter, then letters, digits and underscores) -> name a function of the gate\'s lookups with a plain word of its own, in code.lookups',
    ]);
    const rule = () => ({ result: { id: 'limit', description: 'x', compared: 'x', pass: true } });
    expect(problemsOf(() => definePolicy(refund([{ custom: 'limit' }]), { tools: TOOLS, customRules: { limit: rule } }))).toEqual([
      'actions.refundOrder.rules[0].custom: "custom: limit" is a built-in rule\'s name, which would run that rule without its parameters -> write the built-in rule by its name ("limit" with its parameters), or give the app\'s rule an id of its own',
      'code.customRules.limit: custom rule "limit" has a built-in rule\'s id -> rename it in code.customRules.limit and in the "custom:" rules that name it; "limit" is a built-in rule written by its name with its parameters',
    ]);
  });
});

describe('tables and the legacy evaluator', () => {
  const tables = (): PolicyTables => definePolicy(refund([{ limit: { field: 'amount', max: 'orderTotal(orderId)' } }]), { tools: TOOLS, lookups: LOOKUPS });
  const lookups = { ownerOf: () => null, scopeOf: () => [], orderTotal: () => 50 } as GateLookups;
  const call = { tool: 'refundOrder', params: { amount: '20', orderId: 'ORD-1234' } };
  const facts = { attempts: 0, confirmedHash: null, todayIso: '2026-10-02' };

  it('the gate decides by the file; the legacy evaluator, which does not know the rule, BLOCKs (no shadow reference)', () => {
    const t = tables();
    expect(compiledPolicyOf(t, '').evaluate(call, ANONYMOUS, facts, lookups).verdict).toBe('ALLOW');
    expect(evaluateCall(call, ANONYMOUS, facts, lookups, t, '')).toMatchObject({ verdict: 'BLOCK', reason: 'unknown-rule' });
    // Tables copied and changed lose the file they came from: the range rule reads as an unknown one, and fails closed.
    const copied: PolicyTables = { ...t };
    expect(compiledPolicyOf(copied, '').evaluate(call, ANONYMOUS, facts, lookups)).toMatchObject({ verdict: 'BLOCK', reason: 'unknown-rule' });
  });

  it('validateApp refuses tables that name a range rule without the file that gives its parameters', () => {
    const base = defineApp(LIBRARY_DIR, libraryCode);
    const t = base.policy;
    const handWritten: PolicyTables = { ...t, rulesFor: { ...t.rulesFor, listLoans: ['R1', 'limit'] } };
    expect(() => validateApp({ ...base, policy: handWritten })).toThrow('policy for tool "listLoans" names the rule "limit" without its parameters, which only policy.yaml gives');
  });
});

// ---------------------------------------------------------------------------------------------
// An app that uses both, built by defineApp: the library with a renewal that carries a due date and a fee
// ---------------------------------------------------------------------------------------------

/** What a renewal carries, by book: the new due date and the fee, as the library's code works them out. */
const RENEWAL: Readonly<Record<string, { due: string; fee: string }>> = {
  quiet_orchard: { due: '2026-10-02', fee: '0.50' },
  river_atlas: { due: '2026-10-02', fee: '2.50' },
  clockwork_garden: { due: '2026-12-01', fee: '0.50' },
};
/** The library's renewal terms, by book: the window a new due date may fall in, and the most a renewal may cost. */
const TERMS: Readonly<Record<string, { window: { start: string; end: string | null }; feeCap: string }>> = {
  quiet_orchard: { window: { start: '2026-09-18', end: '2026-10-16' }, feeCap: '1.00' },
  river_atlas: { window: { start: '2026-09-18', end: '2026-10-16' }, feeCap: '1.00' },
  clockwork_garden: { window: { start: '2026-09-18', end: '2026-10-16' }, feeCap: '1.00' },
};

const RANGE_POLICY = `# yaml-language-server: $schema=../../../schemas/policy.schema.json
actions:
  renewLoan:
    level: 0
    rules:
      - identity
      - confirmed: [book, due, fee]
      - dateInRange:
          field: due
          notBefore: today
          within: renewWindow(book)
          reasons: { outsideWindow: renew-window }
          verdicts: { outsideWindow: NEEDS_HUMAN }
      - limit: { field: fee, min: 0, max: renewTerms(book).feeCap, reasons: { outOfRange: fee-cap } }
  findHold:
    level: 0
    rules:
      - identity
      - custom: known-branch
  listLoans:
    level: 0
    rules: [identity]
audit:
  book: keep
  branch: keep
  due: keep
  fee: keep
`;

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function rangeApp(): App {
  const dir = mkdtempSync(join(tmpdir(), 'dw-range-'));
  dirs.push(dir);
  cpSync(LIBRARY_DIR, dir, { recursive: true });
  writeFileSync(join(dir, 'app.yaml'), readFileSync(join(dir, 'app.yaml'), 'utf8').replace(/^id: library$/m, 'id: library-range'));
  writeFileSync(join(dir, 'policy.yaml'), RANGE_POLICY);
  const renewParams = (s: Session): Record<string, string> => {
    const book = s.slots.book?.value ?? '';
    const terms = Object.hasOwn(RENEWAL, book) ? RENEWAL[book]! : { due: '', fee: '' };
    return { book, due: terms.due, fee: terms.fee };
  };
  const termsOf = (book: string) => (Object.hasOwn(TERMS, book) ? TERMS[book]! : null);
  return defineApp(dir, {
    ...libraryCode,
    // A renewal carries its new due date and its fee beside the book.
    tools: { ...libraryCode.tools, renewLoan: { ...libraryCode.tools.renewLoan!, params: ['book', 'due', 'fee'] } },
    lookups: ['renewWindow', 'renewTerms'],
    systems: () => ({
      sys: new LibrarySystems(),
      lookups: { ownerOf: () => null, scopeOf: () => [], renewWindow: (book: string) => termsOf(book)?.window ?? null, renewTerms: (book: string) => termsOf(book) } as GateLookups,
    }),
    forms: {
      ...libraryCode.forms,
      renew_loan: {
        confirmedParams: renewParams,
        complete(c) {
          const { s, acks } = c;
          s.confirmedHash = s.pendingHash;
          const params = renewParams(s);
          const { decision } = c.callTool({ tool: 'renewLoan', params });
          s.confirmedHash = null;
          if (decision.verdict !== 'ALLOW') return c.refusal(decision);
          s.pendingHash = null;
          return { kind: 'said', acks: [...acks, { promptId: 'renewed', vars: { book: s.slots.book?.display ?? '', due: params.due ?? '' } }] };
        },
      },
    },
    testing: {
      policyMatrix: () => ({
        ...libraryPolicyMatrix(),
        todayIso: '2026-09-18',
        calls: {
          ...libraryPolicyMatrix().calls,
          renewLoan: {
            ok: { book: 'quiet_orchard', ...RENEWAL.quiet_orchard! },
            onBounds: { book: 'quiet_orchard', due: '2026-10-16', fee: '1.00' },
            overFee: { book: 'river_atlas', ...RENEWAL.river_atlas! },
            late: { book: 'clockwork_garden', ...RENEWAL.clockwork_garden! },
            past: { book: 'quiet_orchard', due: '2026-09-01', fee: '0.50' },
            badDate: { book: 'quiet_orchard', due: 'next week', fee: '0.50' },
            badFee: { book: 'quiet_orchard', due: '2026-10-02', fee: '50 cents' },
            unknownBook: { book: 'no_such_book', due: '2026-10-02', fee: '0.50' },
          },
        },
      }),
    },
  });
}

const BASE: AnswerMap = {
  addressedToSystem: noul(0.95), intelligible: noul(0.95), utteranceComplete: noul(0.9), wantsHuman: noul(0.05),
  rephrasingLastTurn: noul(0.1), confusedByPrompt: noul(0.1), spokeAMenuNumber: noul(0.05),
  frustration: score({ none: 0.8, mild: 0.15, high: 0.05 }),
  intent: choice({ none: 0.9, other: 0.1 }),
  intentChange: choice({ answering: 0.95, adding: 0.03, replacing: 0.02 }),
  cardGiven: noul(0.05), cardSpan: choice({ none: 1 }), cardComplete: noul(0.4),
};

describe('an app that uses both, built by defineApp', () => {
  const app = rangeApp();
  registerApp(app);
  const tc = (): TurnContext => ({ nowMs: 0, todayIso: '2026-09-18', thresholds: { ...DEFAULT_THRESHOLDS }, tools: { ...app.systems(), codes: mockCodeVerifier } });

  /** A renewal asked for and confirmed: the gate's decision on it, and what the turn did. */
  function renew(book: string): { decision: GateDecision; turn: TurnResult } {
    const t = tc();
    const say = (r: TurnResult, text: string, over: AnswerMap): TurnResult => resolve(r.session, speechEvent(text, true), { ...BASE, ...over }, t);
    const start = resolve(newSession(`range-${book}`, 0, VOICE_RELAY, ANONYMOUS, app.id), startEvent(), null, t);
    const asked = say(start, `renew ${book}`, { intent: choice({ renew_loan: 0.95, none: 0.05 }), book: choice({ [book]: 0.9, none: 0.1 }) });
    const turn = say(asked, 'yes please', { confirmsYes: noul(0.95), confirmsNo: noul(0.05), changeSlot: choice({ none: 0.95, book: 0.05 }) });
    const events = turn.gateEvents.filter((e) => e.decision.call.tool === 'renewLoan');
    expect(events).toHaveLength(1);
    return { decision: events[0]!.decision, turn };
  }

  it('allows a renewal within the window and under the fee cap, each rule with its line', () => {
    const { decision, turn } = renew('quiet_orchard');
    expect(decision.verdict).toBe('ALLOW');
    expect(decision.rules.slice(2)).toEqual([
      { id: 'dateInRange', description: 'The date in due is within its bounds', compared: 'due on or after today 2026-09-18, within renewWindow(book ...hard) 2026-09-18..2026-10-16', pass: true },
      { id: 'limit', description: 'The number in fee is within its limits', compared: 'fee at least 0, at most renewTerms(book ...hard).feeCap 1.00', pass: true },
    ]);
    expect(turn.decision.kind).not.toBe('handoff');
  });

  it('refuses a renewal over the fee cap (BLOCK, its own reason), and hands one past the window to a person', () => {
    const over = renew('river_atlas').decision;
    expect({ verdict: over.verdict, reason: over.reason, last: over.rules.at(-1) }).toEqual({
      verdict: 'BLOCK', reason: 'fee-cap', last: { id: 'limit', description: 'The number in fee is within its limits', compared: 'fee above renewTerms(book ...tlas).feeCap 1.00', pass: false },
    });
    const late = renew('clockwork_garden');
    expect({ verdict: late.decision.verdict, reason: late.decision.reason, compared: late.decision.rules.at(-1)?.compared }).toEqual({
      verdict: 'NEEDS_HUMAN', reason: 'renew-window', compared: 'due outside renewWindow(book ...rden) 2026-09-18..2026-10-16',
    });
    expect(late.turn.decision.kind).toBe('handoff');
  });

  it('on the gate grid: decides the same twice, never allows what fails a bound, and exercises both rules passing and failing', () => {
    const input = gateGridInput(app);
    const gate = gateEvaluator(app);
    const grid = runGateGrid(input, gate);
    expect(isDeepStrictEqual(grid, runGateGrid(input, gateEvaluator(app)))).toBe(true);
    const renewals = grid.points.filter((p) => p.case.tool === 'renewLoan');
    expect(renewals.length).toBeGreaterThan(0);
    // Allowed: only exact calls of the in-bounds param sets, with a matching confirmation, and every rule passed.
    for (const { case: c, decision } of renewals) {
      if (decision.verdict !== 'ALLOW') continue;
      expect(['ok', 'onBounds'], c.key).toContain(c.params);
      expect(c.fields, c.key).toBe('exact');
      expect(c.confirmation, c.key).toBe('match');
      expect(decision.rules.map((r) => r.id)).toEqual(['identity', 'confirmed', 'dateInRange', 'limit']);
      expect(decision.rules.every((r) => r.pass)).toBe(true);
    }
    // Fails closed: a value that is not a date or a number, a bound past, an unknown book: never allowed, and the right verdict where the range rule decided.
    const expected: Record<string, { verdict: string; reason: string }> = {
      overFee: { verdict: 'BLOCK', reason: 'fee-cap' },
      late: { verdict: 'NEEDS_HUMAN', reason: 'renew-window' },
      past: { verdict: 'BLOCK', reason: 'date-range' },
      badDate: { verdict: 'BLOCK', reason: 'not-a-date' },
      badFee: { verdict: 'BLOCK', reason: 'not-a-number' },
      unknownBook: { verdict: 'NEEDS_HUMAN', reason: 'renew-window' },
    };
    for (const { case: c, decision } of renewals) {
      if (!Object.hasOwn(expected, c.params)) continue;
      expect(decision.verdict, c.key).not.toBe('ALLOW');
      const last = decision.rules.at(-1)!;
      if (last.id === 'dateInRange' || last.id === 'limit') expect({ verdict: decision.verdict, reason: decision.reason }, c.key).toEqual(expected[c.params]);
    }
    expect(gridUnexercised(input, grid).filter((u) => / (dateInRange|limit) /.test(u))).toEqual([]);
    // The legacy evaluator has no reference for this app: it does not know the range rules, so it BLOCKs every renewal that reaches one.
    const legacy = runGateGrid(input, legacyGateEvaluator(input)).points.filter((p) => p.case.tool === 'renewLoan' && p.decision.rules.some((r) => r.id === 'dateInRange'));
    expect(legacy.length).toBeGreaterThan(0);
    expect(legacy.every((p) => p.decision.verdict === 'BLOCK' && p.decision.reason === 'unknown-rule')).toBe(true);
  });
});
