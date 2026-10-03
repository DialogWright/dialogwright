import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { IdentityConfig, PolicyMatrix, PolicyTables } from '../core/app/types';
import { compiledPolicyOf, sourceOf } from '../gate/compiled';
import type { GateLookups, Principal, RuleContext, RuleOutcome } from '../gate/types';
import { compareGateGrid, formatGateGridMismatches, gateGridInput, legacyGateEvaluator, type GateGridInput } from '../testing/gateGrid';
import { testkitApp } from '../testing/testkit/index';
import { TESTKIT_CUSTOM_RULES, TESTKIT_IDENTITY, TESTKIT_POLICY } from '../testing/testkit/domain/policy';
import { checkAppFully } from './check';
import { AppDefinitionError, defineApp } from './defineApp';
import { defineIdentity, definePolicy } from './definePolicy';
import { defineRule } from '../gate/defineRule';
import { LIBRARY_DIR, libraryApp, libraryCode } from './fixture/app';
import { loadAppFolder } from './load';
import { compileIdentity, compilePolicy } from './policyFile';
import type { Problem } from './problems';
import { policySchema, identitySchema } from './schema/index';
import { comparable } from './__fixtures__/frozen/comparable';
import { FROZEN_LIBRARY_POLICY } from './__fixtures__/frozen/library';
import { FROZEN_TESTKIT_IDENTITY, FROZEN_TESTKIT_POLICY } from './__fixtures__/frozen/testkit';
import { FROZEN_VALID_IDENTITY, FROZEN_VALID_POLICY } from './__fixtures__/frozen/valid';

/**
 * Compile equality: each app's policy.yaml and identity.yaml (the testkit's, the library's and the
 * valid fixture's, here; the clinic's and a private app's in their own packages) compile to exactly the
 * tables the app ran before it had them in this shape. Those tables are frozen as test data
 * (__fixtures__/frozen), with the old files they came from (__fixtures__/legacy), so the proof
 * stands without the old shape: policyFile.test.ts compiles the files and compares, convert.test.ts
 * converts the old files and compares. Functions are compared by what they return: the role wording
 * over every role, tool and access, the custom rules by identity. Then the gate grid runs the
 * evaluator over the frozen tables against the same over the compiled ones: not one decision may
 * differ.
 */

const VALID = join(__dirname, '__fixtures__', 'valid');

/**
 * The grid of the app's matrix, the evaluator over the frozen tables against the same over
 * `compiled`, and against the gate that reads the named rules `compiled` was compiled from.
 */
function gridMismatches(input: GateGridInput, compiled: PolicyTables): string[] {
  const gate = compiledPolicyOf(compiled, input.subjectKind);
  expect(gate.source).toBe(sourceOf(compiled));
  return [legacyGateEvaluator({ policy: compiled, subjectKind: input.subjectKind }), gate.evaluate].flatMap((candidate) => {
    const mismatches = compareGateGrid(input, candidate);
    return mismatches.length === 0 ? [] : [formatGateGridMismatches(mismatches)];
  });
}

/** The keys of the identity configuration the old file shape had. */
const OLD_IDENTITY_KEYS: readonly string[] = ['subjectKind', 'delegateKind', 'factorSlots', 'verifyTool', 'codeTool', 'sendCodeTool', 'sendCodeParams', 'failedPromptId'];

/** A compiled identity as the old shape had it, and what only identity.yaml can say (the ladder's other parts). */
function splitLadder(identity: Partial<IdentityConfig>): { rest: Record<string, unknown>; ladder: Record<string, unknown> } {
  const entries = Object.entries(identity);
  return { rest: Object.fromEntries(entries.filter(([k]) => OLD_IDENTITY_KEYS.includes(k))), ladder: Object.fromEntries(entries.filter(([k]) => !OLD_IDENTITY_KEYS.includes(k))) };
}

describe('compile equality: the testkit', () => {
  const frozen: PolicyTables = { ...FROZEN_TESTKIT_POLICY, customRules: TESTKIT_CUSTOM_RULES };

  it('policy.yaml compiles to the tables the testkit wrote by hand, its custom rule the testkit\'s own function', () => {
    expect(comparable(TESTKIT_POLICY)).toEqual(comparable(frozen));
    expect(TESTKIT_POLICY.customRules!.R8).toBe(TESTKIT_CUSTOM_RULES.R8);
    expect(testkitApp.policy).toBe(TESTKIT_POLICY);
  });

  it('identity.yaml compiles to the testkit\'s identity, its sendCodeParams the code\'s', () => {
    const { sendCodeParams, ...compiled } = TESTKIT_IDENTITY;
    const { rest, ladder } = splitLadder(compiled);
    expect(rest).toEqual(FROZEN_TESTKIT_IDENTITY);
    // What the old shape could not say: the code's length, the levels' names, the sign-in, the delegates' roles, the attempts.
    expect(ladder).toEqual({ codeLength: 6, levelNames: { 1: 'verified', 2: 'confirmed by code' }, signInLevel: 2, delegateRoles: ['viewer', 'clerk'], maxAttempts: 3 });
    expect(typeof sendCodeParams).toBe('function');
    expect(testkitApp.identity).toBe(TESTKIT_IDENTITY);
    expect(TESTKIT_POLICY.maxAttempts).toBe(3);
  });

  it('gate grid: the compiled tables decide every case as the frozen ones, whole decision for whole decision', () => {
    expect(gridMismatches({ ...gateGridInput(testkitApp), policy: frozen }, TESTKIT_POLICY)).toEqual([]);
  });
});

describe('compile equality: the library fixture', () => {
  it('policy.yaml compiles to the tables the old file gave', () => {
    expect(comparable(libraryApp.policy)).toEqual(comparable({ ...FROZEN_LIBRARY_POLICY, customRules: libraryCode.customRules! }));
    expect(definePolicy(join(LIBRARY_DIR, 'policy.yaml'), { tools: libraryCode.tools, slots: libraryApp.slots, customRules: libraryCode.customRules! })).toEqual(libraryApp.policy);
  });

  it('gate grid: no case decided otherwise', () => {
    expect(gridMismatches({ ...gateGridInput(libraryApp), policy: { ...FROZEN_LIBRARY_POLICY, customRules: libraryCode.customRules! } }, libraryApp.policy)).toEqual([]);
  });
});

/** A stand-in for the valid fixture's own rule, which has no code: refuses a booking on a day already taken. */
const noDoubleBooking = (c: RuleContext): RuleOutcome => {
  const pass = c.call.params.date !== 'taken';
  const result = { id: 'no-double-booking', description: 'The slot is free', compared: pass ? 'free' : 'taken', pass };
  return pass ? { result } : { result, fail: { verdict: 'BLOCK', reason: 'taken' } };
};

describe('compile equality: the valid fixture', () => {
  const read = (file: 'policy' | 'identity'): Record<string, unknown> => loadAppFolder(VALID).config![file] as unknown as Record<string, unknown>;
  const { identity, maxAttempts } = compileIdentity(identitySchema.parse(read('identity')));
  const policy = compilePolicy(policySchema.parse(read('policy')), { maxAttempts, customRules: { 'no-double-booking': noDoubleBooking } });
  const frozen: PolicyTables = { ...FROZEN_VALID_POLICY, customRules: { 'no-double-booking': noDoubleBooking } };

  it('identity.yaml compiles to the old file\'s identity', () => {
    const { rest, ladder } = splitLadder(identity);
    expect(rest).toEqual(FROZEN_VALID_IDENTITY);
    expect(ladder).toEqual({ codeLength: 6, levelNames: { 1: 'verified', 2: 'confirmed by code' }, delegateRoles: ['viewer', 'clerk'], maxAttempts: 3 });
    expect(maxAttempts).toBe(FROZEN_VALID_POLICY.maxAttempts);
  });

  it('policy.yaml compiles to the old tables, less the rows no rule reads (which the new shape cannot say)', () => {
    const { subjects, serviceFields, roles, rolePersonReason, ...kept } = frozen;
    // What is dropped: cancelAppointment's subject and service fields (it runs neither the scope nor
    // the fields rule) and the roles of two tools that do not run the role rule, with their reason.
    expect({ subjects, serviceFields, roles, rolePersonReason }).toEqual({
      subjects: { findAppointment: { param: 'bookingId', via: 'record' }, cancelAppointment: { param: 'patientId' } },
      serviceFields: { cancelAppointment: ['provider', 'date'] },
      roles: { findAppointment: { viewer: 'allow', clerk: 'allow' }, cancelAppointment: { viewer: 'refuse', clerk: 'person' } },
      rolePersonReason: 'staff-cancel',
    });
    // Each dropped row belongs to a tool whose rules never read it.
    expect(frozen.rulesFor.cancelAppointment).toEqual(['R1', 'R3']);
    expect(frozen.rulesFor.findAppointment).toEqual(['R1', 'R2']);
    expect(comparable(policy, ['viewer', 'clerk'])).toEqual(comparable({ ...kept, subjects: { findAppointment: subjects.findAppointment! }, serviceFields: {} } as PolicyTables, ['viewer', 'clerk']));
  });

  it('gate grid: the dropped rows decide nothing, so no case is decided otherwise', () => {
    const owners: Record<string, string> = { 'B-1': 'P-1', 'B-2': 'P-2', 'B-3': 'P-3' };
    const lookups: GateLookups = {
      ownerOf: (r) => (Object.hasOwn(owners, r) ? owners[r]! : null),
      scopeOf: (p: Principal) => (p.level === 0 ? [] : p.kind === 'patient' ? [p.id] : p.kind === 'staff' && p.role !== undefined ? ['P-2'] : []),
    };
    const patient = { kind: 'patient', id: 'P-1', first: 'Avery' } as const;
    const staff = (id: string, role?: string) => ({ kind: 'staff', level: 2 as const, id, first: 'Quinn', ...(role === undefined ? {} : { role }) });
    const matrix: PolicyMatrix = {
      principals: {
        subject1: { ...patient, level: 1 },
        subject2: { ...patient, level: 2 },
        delegates: { viewer: staff('S-1', 'viewer'), clerk: staff('S-2', 'clerk') },
        unlistedRole: staff('S-3', 'supervisor'),
        roleless: staff('S-4'),
        otherParty: { kind: 'visitor', level: 2, id: 'V-1', first: 'Robin' },
      },
      records: {
        own: { subject: 'P-1', record: 'B-1' },
        inScope: { subject: 'P-2', record: 'B-2' },
        outOfScope: { subject: 'P-3', record: 'B-3' },
        unknown: { subject: 'P-9', record: 'B-9' },
      },
      calls: { bookAppointment: { free: { name: 'Avery Lane', dob: '1985-04-12', provider: 'lee', date: '2026-10-05', time: '09:00' }, taken: { name: 'Avery Lane', dob: '1985-04-12', provider: 'lee', date: 'taken', time: '09:00' } } },
    };
    const input: GateGridInput = { policy: frozen, subjectKind: identity.subjectKind, lookups, matrix, tools: ['verifyPatient', 'sendCode', 'verifyCode'] };
    expect(gridMismatches(input, policy)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// The checks: each problem, with its message
// ---------------------------------------------------------------------------------------------

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function scratchCopy(from: string, files: Record<string, string | null>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dialogwright-policy-'));
  scratch.push(dir);
  cpSync(from, dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    if (text === null) rmSync(join(dir, file));
    else writeFileSync(join(dir, file), text);
  }
  return dir;
}

/** The problems a definePolicy or defineIdentity call throws, as `path: message -> fix`. */
function problemsOf(build: () => unknown): string[] {
  try {
    build();
  } catch (error) {
    if (!(error instanceof AppDefinitionError)) throw error;
    return error.problems.map((p: Problem) => `${p.path}: ${p.message} -> ${p.fix}`);
  }
  return [];
}

/** A small app's code for the checks: three tools, two slots, one rule of its own. */
const TOOLS = { getRecord: {}, fileRequest: {}, checkFactors: {}, sendCode: {}, checkCode: {} };
const SLOTS = { accountId: {}, note: {}, dob: {} };
/** The small app's own rule, with the examples check requires: a free slot passes, a taken one is refused. */
const CUSTOMER = { kind: 'customer', level: 2, id: '55501234', first: 'Alex' } as const;
const notTwice = defineRule({
  id: 'not-twice',
  description: 'The slot is free',
  run: (c) => (c.call.params.date !== 'taken' ? { pass: true, compared: 'free' } : { pass: false, compared: 'taken', verdict: 'BLOCK', reason: 'taken' }),
  examples: [
    { name: 'a free day', call: { params: { accountId: '55501234', note: 'x', date: 'free' } }, principal: CUSTOMER, expect: { verdict: 'ALLOW' } },
    { name: 'a taken day', call: { params: { accountId: '55501234', note: 'x', date: 'taken' } }, principal: CUSTOMER, expect: { verdict: 'BLOCK', reason: 'taken' } },
  ],
});
const RULES = { 'not-twice': notTwice };

const IDENTITY = {
  principals: { subject: 'customer', delegates: { agent: { roles: ['viewer', 'clerk'] } } },
  levels: {
    1: { name: 'verified', factors: ['accountId', 'dob'], verify: 'checkFactors' },
    2: { name: 'confirmed by code', factors: [{ otp: { length: 6 } }], send: 'sendCode', verify: 'checkCode' },
  },
  attempts: 3,
};
const ACTIONS = {
  getRecord: { level: 1, rules: ['identity', { scope: { record: 'recordId' } }] },
  fileRequest: { level: 2, rules: ['identity', { role: { viewer: 'refuse', clerk: 'person' } }, { scope: { param: 'accountId' } }, { confirmed: ['accountId', 'note'] }, { custom: 'not-twice' }] },
  checkFactors: { level: 0, rules: ['attempts'] },
  sendCode: { level: 1, rules: ['identity', { scope: { param: 'accountId' } }] },
  checkCode: { level: 1, rules: ['identity', 'attempts'] },
};
const POLICY = { actions: ACTIONS };

const policyWith = (over: Record<string, unknown>, identity: Record<string, unknown> | null = IDENTITY): string[] =>
  problemsOf(() => definePolicy({ ...POLICY, ...over }, { ...(identity ? { identity } : {}), tools: TOOLS, slots: SLOTS, customRules: RULES }));
const actionsWith = (actions: Record<string, unknown>, identity: Record<string, unknown> | null = IDENTITY): string[] => policyWith({ actions: { ...ACTIONS, ...actions } }, identity);
/** One action alone, for an app whose only tool it is. */
const soloWith = (action: Record<string, unknown>, identity: Record<string, unknown> | null): string[] =>
  problemsOf(() => definePolicy({ actions: { getRecord: action } }, { ...(identity ? { identity } : {}), tools: { getRecord: {} }, slots: SLOTS }));
const identityWith = (over: Record<string, unknown>): string[] =>
  problemsOf(() => defineIdentity({ ...IDENTITY, ...over }, { policy: POLICY, tools: TOOLS, slots: SLOTS, prompts: ['identity_failed'] }));

describe('the checks', () => {
  it('a small app with both files has no problems, and compiles', () => {
    expect(policyWith({})).toEqual([]);
    expect(identityWith({})).toEqual([]);
    const tables = definePolicy(POLICY, { identity: IDENTITY, tools: TOOLS, slots: SLOTS, customRules: RULES });
    expect(tables.rulesFor).toEqual({ getRecord: ['R1', 'R2'], fileRequest: ['R1', 'R5', 'R2', 'R3', 'not-twice'], checkFactors: ['R6'], sendCode: ['R1', 'R2'], checkCode: ['R1', 'R6'] });
    expect(tables.subjects).toEqual({ getRecord: { param: 'recordId', via: 'record' }, fileRequest: { param: 'accountId' }, sendCode: { param: 'accountId' } });
    expect([tables.confirmedFields, tables.maxAttempts, tables.roles, tables.rolePersonReason]).toEqual([['accountId', 'note'], 3, { fileRequest: { viewer: 'refuse', clerk: 'person' } }, undefined]);
  });

  it('an action that is not a tool, and a tool with no action', () => {
    const { getRecord, ...rest } = ACTIONS;
    expect(policyWith({ actions: { ...rest, getRecrd: getRecord } })).toEqual([
      'actions.getRecrd: tool "getRecrd" is not defined in the code -> rename it to "getRecord", or add it to the app\'s tools in code.tools.getRecrd, or delete this action',
      'actions: tool "getRecord" (code.tools.getRecord) has no entry under actions, so it can never be called -> add "getRecord:" under actions with its level and rules, or delete the tool from code.tools.getRecord',
    ]);
  });

  it('an identity factor that is not a slot; a confirmed or fields param need not be one (a picked time, a record id)', () => {
    expect(actionsWith({ fileRequest: { ...ACTIONS.fileRequest, rules: [...ACTIONS.fileRequest.rules, { fields: ['report', 'note'] }] }, sendCode: { level: 1, rules: ['identity', { confirmed: ['accountId', 'note'] }] } })).toEqual([]);
    expect(actionsWith({ fileRequest: { level: 2, rules: [{ confirmed: ['time'] }, { custom: 'not-twice' }] } })).toEqual([]);
    expect(identityWith({ levels: { ...IDENTITY.levels, 1: { ...IDENTITY.levels[1], factors: ['acountId', 'dob'] } } })).toEqual([
      'levels["1"].factors[0]: slot "acountId" is not defined -> rename it to "accountId", or add it to the app\'s slots',
    ]);
  });

  it('a custom rule the code does not have, and one named by a built-in id', () => {
    expect(actionsWith({ getRecord: { level: 1, rules: ['identity', { custom: 'not-twise' }, { custom: 'R2' }] } })).toEqual([
      'actions.getRecord.rules[1].custom: custom rule "not-twise" is not defined in the code -> rename it to "not-twice", or add it to code.customRules["not-twise"], or delete this rule',
      'actions.getRecord.rules[2].custom: "custom: R2" names a built-in rule\'s id, which would run that rule without its parameters -> write the built-in rule by its name ("scope" with its parameters), or give the app\'s rule an id of its own',
    ]);
  });

  it('a role that identity.yaml does not declare, or with no identity.yaml at all', () => {
    expect(actionsWith({ fileRequest: { ...ACTIONS.fileRequest, rules: ['identity', { role: { viewer: 'refuse', clerc: 'person' } }, { confirmed: ['accountId', 'note'] }, { custom: 'not-twice' }] } })).toEqual([
      'actions.fileRequest.rules[1].role.clerc: role "clerc" is not declared under principals in identity.yaml -> rename it to "clerk", or add it to the roles of a delegate kind under principals.delegates in identity.yaml',
    ]);
    const levelZero = Object.fromEntries(Object.entries(ACTIONS).map(([tool, a]) => [tool, { ...a, level: 0 }]));
    expect(policyWith({ actions: { ...levelZero, checkFactors: { level: 0, rules: [] }, checkCode: { level: 0, rules: ['identity'] } } }, null)).toEqual([
      'actions.fileRequest.rules[1].role.viewer: role "viewer" is named, but the app has no identity.yaml, so no caller has a role -> delete the role rule, or add identity.yaml with the parties who act for subjects and their roles',
      'actions.fileRequest.rules[1].role.clerk: role "clerk" is named, but the app has no identity.yaml, so no caller has a role -> delete the role rule, or add identity.yaml with the parties who act for subjects and their roles',
    ]);
  });

  it('confirmed lists that differ (Decision 5); role reasons that differ are each the rule\'s own (Decision 4)', () => {
    expect(actionsWith({ sendCode: { level: 1, rules: ['identity', { confirmed: ['note', 'accountId'] }] } })).toEqual([
      'actions.sendCode.rules[1].confirmed: the confirmed fields of "sendCode" (note, accountId) differ from those of "fileRequest" (accountId, note); until a form names the action it writes, every confirmed rule of an app names the same fields in the same order (a read-back\'s hash is taken once, over one list) -> write [accountId, note] here, as "fileRequest" has it',
    ]);
    const role = (reason?: string) => ({ role: { viewer: 'allow', clerk: 'person', ...(reason ? { reason } : {}) } });
    expect(actionsWith({ getRecord: { level: 1, rules: ['identity', role('staff-filing')] }, sendCode: { level: 1, rules: ['identity', role('staff-sending')] } })).toEqual([]);
    expect(actionsWith({ getRecord: { level: 1, rules: ['identity', { role: { viewer: 'allow', reason: 'staff-filing' } }] } })).toEqual([
      'actions.getRecord.rules[1].role.reason: the role rule of "getRecord" gives a reason, but no role in it goes to a person, so the reason is never used -> delete the reason, or give a role "person"',
    ]);
  });

  it('a level the ladder does not have: an action or purpose at level 2 with no level 2, at any level above 0 with no identity.yaml', () => {
    const noTwo = { ...IDENTITY, levels: { 1: IDENTITY.levels[1] } };
    expect(policyWith({ purposes: { file_request: { level: 2 } } }, noTwo)).toEqual([
      'actions.fileRequest.level: action "fileRequest" needs identity level 2, but the ladder in identity.yaml has no level 2 -> set it to 1, or add level 2 under levels in identity.yaml',
      'purposes.file_request.level: purpose "file_request" needs identity level 2, but the ladder in identity.yaml has no level 2 -> set it to 1, or add level 2 under levels in identity.yaml',
    ]);
    expect(soloWith({ rules: ['identity'] }, null)).toEqual([
      'actions.getRecord: action "getRecord" has no level, so it needs the highest (2), but the app has no identity.yaml, so no caller can reach it -> add "level: 0", or add identity.yaml so callers can verify',
    ]);
  });

  it('a ladder of one rung (no level 2, so no code) is a ladder: only what needs level 2 is refused', () => {
    const noTwo = { ...IDENTITY, levels: { 1: IDENTITY.levels[1] } };
    expect(identityWith({ levels: { 1: IDENTITY.levels[1] } })).toEqual([]);
    expect(policyWith({}, noTwo)).toEqual([
      'actions.fileRequest.level: action "fileRequest" needs identity level 2, but the ladder in identity.yaml has no level 2 -> set it to 1, or add level 2 under levels in identity.yaml',
    ]);
  });

  it('a sign-in that does not prove the top level, level names blank or the same, two delegate kinds, attempts with no identity.yaml', () => {
    expect(identityWith({ signIn: { level: 1 } })).toEqual([
      'signIn.level: a sign-in proves level 1, but the top of the ladder is level 2; a sign-in proves the top level -> write "level: 2"',
    ]);
    expect(identityWith({ signIn: { level: 2 }, levels: { 1: IDENTITY.levels[1] } })).toEqual([
      'signIn.level: a sign-in proves level 2, but the top of the ladder is level 1; a sign-in proves the top level -> write "level: 1"',
    ]);
    expect(identityWith({ signIn: { level: 1 }, levels: { 1: IDENTITY.levels[1] } })).toEqual([]);
    // A code of any length the schema allows (4 to 8) is the engine's to key.
    for (const length of [4, 8]) expect(identityWith({ levels: { ...IDENTITY.levels, 2: { ...IDENTITY.levels[2], factors: [{ otp: { length } }] } } })).toEqual([]);
    expect(identityWith({ levels: { 1: { ...IDENTITY.levels[1], name: '  ' }, 2: { ...IDENTITY.levels[2], name: 'Verified ' } } })).toEqual([
      'levels["1"].name: level 1\'s name is blank -> name the level, as the console and the policy card will show it (for example "verified")',
    ]);
    expect(identityWith({ levels: { 1: IDENTITY.levels[1], 2: { ...IDENTITY.levels[2], name: ' Verified' } } })).toEqual([
      'levels["2"].name: levels 1 and 2 are both called "Verified" -> give each level a name of its own, so the console and the policy card can tell them apart',
    ]);
    expect(identityWith({ principals: { subject: 'customer', delegates: { agent: { roles: ['viewer'] }, staff: { roles: ['clerk'] } } } })).toEqual([
      'principals.delegates: 2 delegate kinds (agent, staff); one is supported for now (the engine names a party who acts for subjects by one word) -> keep one kind, with every role under it',
    ]);
    expect(soloWith({ level: 0, rules: ['attempts'] }, null)).toEqual([
      'actions.getRecord.rules[0]: the attempts rule counts failed tries at the identity checks, but the app has no identity.yaml, so there are none -> delete the rule, or add identity.yaml',
    ]);
  });

  it('an identity tool that is not a tool, or has no action', () => {
    const { checkCode: _checkCode, ...rest } = ACTIONS;
    expect(problemsOf(() => defineIdentity(IDENTITY, { policy: { actions: rest }, tools: TOOLS, slots: SLOTS }))).toEqual([
      'levels["2"].verify: tool "checkCode" has no entry under actions in policy.yaml -> add "checkCode: { level: 1, rules: [identity, attempts] }" under actions in policy.yaml',
    ]);
    expect(identityWith({ levels: { ...IDENTITY.levels, 1: { ...IDENTITY.levels[1], verify: 'checkFactor' } } })).toEqual([
      'levels["1"].verify: tool "checkFactor" is not defined in the code -> rename it to "checkFactors", or add it to the app\'s tools in code.tools.checkFactor',
    ]);
  });

  it('a misspelt key, rule or parameter is named with the closest one', () => {
    expect(actionsWith({ getRecord: { levle: 1, rules: ['identiy', { scop: { record: 'recordId' } }] } })).toEqual([
      'actions.getRecord.rules[0]: "identiy" is not a rule; the rules are identity, scope, role, confirmed, attempts, fields, dateInRange, limit, custom (custom names one of the app\'s own) -> rename it to "identity"',
      'actions.getRecord.rules[1].scop: "scop" is not a rule; the rules are identity, scope, role, confirmed, attempts, fields, dateInRange, limit, custom (custom names one of the app\'s own) -> rename it to "scope"',
      'actions.getRecord.levle: unknown key "levle" under actions.getRecord -> rename "levle" to "level"',
    ]);
    expect(actionsWith({ getRecord: { level: 1, rules: [{ scope: { parm: 'recordId' } }, { role: { viewer: 'allow', reasn: 'x' } }, { identity: {} }, 'scope'] } })).toEqual([
      'actions.getRecord.rules[0].scope.parm: unknown key "parm" under actions.getRecord.rules[0].scope -> rename "parm" to "param"',
      'actions.getRecord.rules[0].scope: the scope rule names no param: write "param" or "record" -> write "scope: { param: <the subject\'s id param> }", or "scope: { record: <the record id param> }"',
      'actions.getRecord.rules[1].role.reasn: unknown key "reasn" in the role rule -> rename it to "reason"',
      'actions.getRecord.rules[2].identity: the identity rule takes no parameters -> write it as a plain "- identity"',
      'actions.getRecord.rules[3]: the scope rule takes parameters, so it is written as a map -> write "scope: { param: accountId }"',
    ]);
    expect(actionsWith({ getRecord: { level: 1, rules: ['identity', { scope: { record: 'recordId' }, custom: 'not-twice' }, 'identity'] } })).toEqual([
      'actions.getRecord.rules[1]: this entry names 2 rules (scope, custom); a list entry is one rule -> write each rule as its own "- " entry, in the order the gate runs them',
      'actions.getRecord.rules[2]: the rule "identity" is listed twice -> delete one of the two: a rule runs once per action',
    ]);
    expect(identityWith({ principls: IDENTITY.principals })).toEqual([
      'principls: unknown key "principls" in this file -> rename "principls" to "principals"',
    ]);
  });

  it('a file in the old shape is refused, with the command that converts it', () => {
    expect(problemsOf(() => definePolicy({ toolLevel: {}, rulesFor: {}, confirmedFields: [], maxAttempts: 3 }))).toEqual([
      '(file): policy.yaml is in the old shape (toolLevel, rulesFor, ...), which is not read any more -> convert it with "dialogwright policy:convert <app folder>" (or "--from-tables <module>" for tables written in TypeScript), which keeps its decisions and its comments, then check the result: it starts with "actions:", each tool with its level and rules, for example "actions: { getRecord: { level: 1, rules: [identity] } }"',
    ]);
    expect(problemsOf(() => defineIdentity({ subjectKind: 'patient', factorSlots: ['a'], verifyTool: 'v', codeTool: 'c', sendCodeTool: 's' }))).toEqual([
      '(file): identity.yaml is in the old shape (subjectKind, factorSlots, ...), which is not read any more -> convert it with "dialogwright policy:convert <app folder>" (or "--from-tables <module>" for tables written in TypeScript), which keeps its decisions and its comments, then check the result: it starts with "principals:", "levels:" and "attempts:"',
    ]);
  });
});

describe('the checks in an app folder: located', () => {
  const POLICY_YAML = readFileSync(join(LIBRARY_DIR, 'policy.yaml'), 'utf8');

  it('the library: no problems', async () => {
    const { problems, codeChecked } = await checkAppFully(LIBRARY_DIR, { code: libraryCode });
    expect({ problems, codeChecked }).toEqual({ problems: [], codeChecked: true });
  });

  it('a problem points at its line', async () => {
    const dir = scratchCopy(LIBRARY_DIR, { 'policy.yaml': POLICY_YAML.replace('custom: known-branch', 'custom: known-branches').replace('level: 0', 'level: 1') });
    const { problems } = await checkAppFully(dir, { code: libraryCode });
    expect(problems.map((p) => `${p.file}:${p.line}:${p.column} ${p.path} ${p.message}`)).toEqual([
      'policy.yaml:2:1 actions custom rule "known-branch" (code.customRules["known-branch"]) is not named by any action\'s rules, so it never runs',
      'policy.yaml:4:12 actions.renewLoan.level action "renewLoan" needs identity level 1, but the app has no identity.yaml, so no caller can reach it',
      'policy.yaml:12:17 actions.findHold.rules[1].custom custom rule "known-branches" is not defined in the code',
    ]);
  });

  it('the valid fixture: a failed line it lacks is found where identity.yaml names it', async () => {
    const identity = readFileSync(join(VALID, 'identity.yaml'), 'utf8');
    const lacking = await checkAppFully(scratchCopy(VALID, { 'identity.yaml': identity.replace('failedPrompt: identity_failed', 'failedPrompt: identity_missed') }));
    expect(lacking.problems.filter((p) => p.message.includes('identity_missed')).map((p) => `${p.file}:${p.line} ${p.message}`)).toEqual([
      'prompts.yaml:2 prompt "identity_missed" is missing from prompts.yaml; identity.yaml:7 (levels["1"].failedPrompt) says it',
      'locale/fr/prompts.yaml:1 prompt "identity_missed" is missing from the fr prompts; identity.yaml:7 (levels["1"].failedPrompt) says it',
    ]);
  });
});
