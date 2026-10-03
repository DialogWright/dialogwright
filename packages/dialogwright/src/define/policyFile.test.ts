import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { PolicyMatrix, PolicyTables, RoleAccess } from '../core/app/types';
import type { GateLookups, Principal, RuleContext, RuleOutcome } from '../gate/types';
import { compareGateGrid, formatGateGridMismatches, gateGridInput, legacyGateEvaluator, type GateGridInput } from '../testing/gateGrid';
import { testkitApp } from '../testing/testkit/index';
import { TESTKIT_POLICY } from '../testing/testkit/domain/policy';
import { TESTKIT_TOOLS } from '../testing/testkit/domain/tools';
import { SLOTS as TESTKIT_SLOTS } from '../testing/testkit/domain/slots/index';
import { checkAppFully } from './check';
import { AppDefinitionError, defineApp, legacyIdentityConfig, legacyPolicyTables, type AppCode } from './defineApp';
import { defineIdentity, definePolicy } from './definePolicy';
import { LIBRARY_DIR, LIBRARY_SLOTS, LIBRARY_TOOLS, libraryApp, libraryCode } from './fixture/app';
import { isLegacyIdentity, isLegacyPolicy, loadAppFolder } from './load';
import { compileIdentity, compilePolicy, DEFAULT_MAX_ATTEMPTS } from './policyFile';
import type { Problem } from './problems';
import { policySchema, identitySchema } from './schema/index';

/**
 * The new policy.yaml and identity.yaml compile to exactly the tables each app runs today: the
 * testkit's (written in TypeScript), the library fixture's and the valid fixture's (old-shape YAML).
 * Each app's files in the new shape are under __fixtures__/converted (the clinic's are in its own
 * package, with its own proof). Functions are compared by what they return: the role wording over
 * every role, tool and access, the custom rules by identity. Then the gate grid runs the legacy
 * evaluator over the compiled tables against the legacy tables: not one decision may differ.
 */

const CONVERTED = join(__dirname, '__fixtures__', 'converted');
const VALID = join(__dirname, '__fixtures__', 'valid');
const converted = (app: string, file: 'policy' | 'identity'): string => join(CONVERTED, app, `${file}.yaml`);
const read = (app: string, file: 'policy' | 'identity'): Record<string, unknown> => parse(readFileSync(converted(app, file), 'utf8')) as Record<string, unknown>;

const ACCESS: readonly RoleAccess[] = ['allow', 'refuse', 'person'];

/** The tables with the role wording as its lines over every role and tool the tables name (and one they do not): comparable with toEqual. */
function comparable(tables: PolicyTables, alsoRoles: readonly string[] = []): unknown {
  const { wording, ...rest } = tables;
  if (!wording) return rest;
  const { role, ...words } = wording;
  if (!role) return { ...rest, wording: words };
  const roles = [...new Set([...Object.values(tables.roles ?? {}).flatMap((r) => Object.keys(r)), ...alsoRoles, 'someone'])];
  const tools = [...Object.keys(tables.rulesFor), 'someTool'];
  const lines = roles.flatMap((r) => tools.flatMap((t) => ACCESS.map((a) => `${r} ${t} ${a}: ${role(r, t, a)}`)));
  return { ...rest, wording: { ...words, role: lines } };
}

/** The grid of the app's matrix, the legacy evaluator over `compiled` against the same over the legacy tables. */
function gridMismatches(input: GateGridInput, compiled: PolicyTables): string[] {
  const mismatches = compareGateGrid(input, legacyGateEvaluator({ policy: compiled, subjectKind: input.subjectKind }));
  return mismatches.length === 0 ? [] : [formatGateGridMismatches(mismatches)];
}

describe('compile equality: the testkit', () => {
  const policy = compilePolicy(policySchema.parse(read('testkit', 'policy')), {
    maxAttempts: compileIdentity(identitySchema.parse(read('testkit', 'identity'))).maxAttempts,
    customRules: TESTKIT_POLICY.customRules!,
  });

  it('policy.yaml compiles to TESTKIT_POLICY, its custom rule the same function', () => {
    expect(comparable(policy)).toEqual(comparable(TESTKIT_POLICY));
    expect(policy.customRules!.R8).toBe(TESTKIT_POLICY.customRules!.R8);
  });

  it('identity.yaml compiles to the testkit\'s identity, its sendCodeParams the code\'s', () => {
    const { identity, maxAttempts } = compileIdentity(identitySchema.parse(read('testkit', 'identity')), { sendCodeParams: testkitApp.identity!.sendCodeParams! });
    expect(identity).toEqual(testkitApp.identity);
    expect(identity.sendCodeParams).toBe(testkitApp.identity!.sendCodeParams);
    expect(maxAttempts).toBe(TESTKIT_POLICY.maxAttempts);
  });

  it('definePolicy and defineIdentity, from the paths and checked against the code, give the same', () => {
    const tables = definePolicy(converted('testkit', 'policy'), { identity: converted('testkit', 'identity'), tools: TESTKIT_TOOLS, slots: TESTKIT_SLOTS, customRules: TESTKIT_POLICY.customRules! });
    expect(comparable(tables)).toEqual(comparable(TESTKIT_POLICY));
    const identity = defineIdentity(converted('testkit', 'identity'), { policy: converted('testkit', 'policy'), tools: TESTKIT_TOOLS, slots: TESTKIT_SLOTS, prompts: ['identity_failed'], sendCodeParams: testkitApp.identity!.sendCodeParams! });
    expect(identity).toEqual(testkitApp.identity);
  });

  it('gate grid: the compiled tables decide every case as the legacy ones, whole decision for whole decision', () => {
    expect(gridMismatches(gateGridInput(testkitApp), policy)).toEqual([]);
  });
});

describe('compile equality: the library fixture', () => {
  const policy = compilePolicy(policySchema.parse(read('library', 'policy')), { customRules: libraryCode.customRules! });

  it('policy.yaml compiles to the tables defineApp builds from the old-shape file', () => {
    expect(comparable(policy)).toEqual(comparable(libraryApp.policy));
    expect(policy.maxAttempts).toBe(DEFAULT_MAX_ATTEMPTS);
    expect(definePolicy(converted('library', 'policy'), { tools: LIBRARY_TOOLS, slots: LIBRARY_SLOTS, customRules: libraryCode.customRules! })).toEqual(policy);
  });

  it('gate grid: no case decided otherwise', () => {
    expect(gridMismatches(gateGridInput(libraryApp), policy)).toEqual([]);
  });

  it('as the folder\'s own policy.yaml, defineApp builds the same app', () => {
    const dir = scratchCopy(LIBRARY_DIR, { 'policy.yaml': readFileSync(converted('library', 'policy'), 'utf8').replace('../../../../../schemas/', '../../../schemas/') });
    expect(comparable(defineApp(dir, libraryCode).policy)).toEqual(comparable(libraryApp.policy));
  });
});

/** A stand-in for the valid fixture's own rule, which has no code: refuses a booking on a day already taken. */
const noDoubleBooking = (c: RuleContext): RuleOutcome => {
  const pass = c.call.params.date !== 'taken';
  const result = { id: 'no-double-booking', description: 'The slot is free', compared: pass ? 'free' : 'taken', pass };
  return pass ? { result } : { result, fail: { verdict: 'BLOCK', reason: 'taken' } };
};

describe('compile equality: the valid fixture', () => {
  const loaded = loadAppFolder(VALID).config!;
  const legacyPolicy = loaded.policy;
  const legacyIdentity = loaded.identity!;
  if (!isLegacyPolicy(legacyPolicy) || !isLegacyIdentity(legacyIdentity)) throw new Error('the valid fixture is no longer in the old shape: delete this proof');
  const legacy = legacyPolicyTables(legacyPolicy, { customRules: { 'no-double-booking': noDoubleBooking } } as unknown as AppCode);
  const { identity, maxAttempts } = compileIdentity(identitySchema.parse(read('valid', 'identity')));
  const policy = compilePolicy(policySchema.parse(read('valid', 'policy')), { maxAttempts, customRules: { 'no-double-booking': noDoubleBooking } });

  it('identity.yaml compiles to the old file\'s identity', () => {
    expect(identity).toEqual(legacyIdentityConfig(legacyIdentity, {} as AppCode));
    expect(maxAttempts).toBe(legacyPolicy.maxAttempts);
  });

  it('policy.yaml compiles to the old tables, less the rows no rule reads (which the new shape cannot say)', () => {
    const { subjects, serviceFields, roles, rolePersonReason, ...kept } = legacy;
    // What is dropped: cancelAppointment's subject and service fields (it runs neither R2 nor R7) and
    // the roles of two tools that do not run R5, with their reason.
    expect({ subjects, serviceFields, roles, rolePersonReason }).toEqual({
      subjects: { findAppointment: { param: 'bookingId', via: 'record' }, cancelAppointment: { param: 'patientId' } },
      serviceFields: { cancelAppointment: ['provider', 'date'] },
      roles: { findAppointment: { viewer: 'allow', clerk: 'allow' }, cancelAppointment: { viewer: 'refuse', clerk: 'person' } },
      rolePersonReason: 'staff-cancel',
    });
    // Each dropped row belongs to a tool whose rules never read it.
    expect(legacy.rulesFor.cancelAppointment).toEqual(['R1', 'R3']);
    expect(legacy.rulesFor.findAppointment).toEqual(['R1', 'R2']);
    expect(comparable(policy)).toEqual(comparable({ ...kept, subjects: { findAppointment: subjects.findAppointment! }, serviceFields: {} } as PolicyTables));
    // The role wording stays (it is wording, not a row): the same lines as the old file's, for the roles the old file named.
    expect(comparable(policy, ['viewer', 'clerk'])).toMatchObject({ wording: (comparable(legacy) as { wording: object }).wording });
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
    const input: GateGridInput = { policy: legacy, subjectKind: identity.subjectKind, lookups, matrix, tools: ['verifyPatient', 'sendCode', 'verifyCode'] };
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
const RULES = { 'not-twice': noDoubleBooking };

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

  it('confirmed lists that differ (Decision 5), and role reasons that differ (Decision 4)', () => {
    expect(actionsWith({ sendCode: { level: 1, rules: ['identity', { confirmed: ['note', 'accountId'] }] } })).toEqual([
      'actions.sendCode.rules[1].confirmed: the confirmed fields of "sendCode" (note, accountId) differ from those of "fileRequest" (accountId, note); until a form names the action it writes, every confirmed rule of an app names the same fields in the same order (a read-back\'s hash is taken once, over one list) -> write [accountId, note] here, as "fileRequest" has it',
    ]);
    const role = (reason?: string) => ({ role: { viewer: 'allow', clerk: 'person', ...(reason ? { reason } : {}) } });
    expect(actionsWith({ getRecord: { level: 1, rules: ['identity', role('staff-filing')] }, sendCode: { level: 1, rules: ['identity', role('staff-sending')] } })).toEqual([
      'actions.fileRequest.rules[1].role: the role rule of "fileRequest" hands the call to a person for the reason "role-person", and that of "getRecord" for "staff-filing"; for now every role rule of an app gives the same reason (the gate\'s tables hold one) -> give this rule "reason: staff-filing", as "getRecord" has it',
      'actions.sendCode.rules[1].role.reason: the role rule of "sendCode" hands the call to a person for the reason "staff-sending", and that of "getRecord" for "staff-filing"; for now every role rule of an app gives the same reason (the gate\'s tables hold one) -> give this rule "reason: staff-filing", as "getRecord" has it',
    ]);
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
    expect(identityWith({ levels: { 1: IDENTITY.levels[1] } })).toEqual([
      'levels: the ladder has no level 2; for now the engine\'s step-up always ends with the one-time code, so an app that verifies callers needs it -> add "2: { name: <its name>, factors: [{ otp: { length: 6 } }], send: <the tool that sends the code>, verify: <the tool that checks it> }" under levels',
    ]);
  });

  it('a sign-in that does not prove the top level, a code of another length, two delegate kinds, attempts with no identity.yaml', () => {
    expect(identityWith({ signIn: { level: 1 } })).toEqual([
      'signIn.level: a sign-in proves level 1, but the top of the ladder is level 2; a sign-in proves the top level -> write "level: 2"',
    ]);
    expect(identityWith({ levels: { ...IDENTITY.levels, 2: { ...IDENTITY.levels[2], factors: [{ otp: { length: 8 } }] } } })).toEqual([
      'levels["2"].factors[0].otp.length: a one-time code of 8 digits is not supported yet: the engine reads 6 -> write 6, or leave length out',
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
      'actions.getRecord.rules[0]: "identiy" is not a rule; the rules are identity, scope, role, confirmed, attempts, fields, custom (custom names one of the app\'s own) -> rename it to "identity"',
      'actions.getRecord.rules[1].scop: "scop" is not a rule; the rules are identity, scope, role, confirmed, attempts, fields, custom (custom names one of the app\'s own) -> rename it to "scope"',
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

  it('a file in the old shape is refused outside an app folder', () => {
    expect(problemsOf(() => definePolicy({ toolLevel: {}, rulesFor: {}, confirmedFields: [], maxAttempts: 3 }))).toEqual([
      '(file): policy.yaml has the old shape (toolLevel, rulesFor, ...), which only an app folder reads, until every app is converted -> write it in the new shape: it starts with "actions:", each tool with its level and rules, for example "actions: { getRecord: { level: 1, rules: [identity] } }"',
    ]);
  });
});

describe('the checks in an app folder: located, and the old shape warned of', () => {
  const POLICY_YAML = readFileSync(converted('library', 'policy'), 'utf8').replace('../../../../../schemas/', '../../../schemas/');

  it('the library with its policy.yaml in the new shape: no problems and no warning; in the old one, a warning', async () => {
    const dir = scratchCopy(LIBRARY_DIR, { 'policy.yaml': POLICY_YAML });
    expect(await checkAppFully(dir, { code: libraryCode })).toEqual({ problems: [], warnings: [], codeChecked: true });
    const old = await checkAppFully(LIBRARY_DIR, { code: libraryCode });
    expect(old.warnings.map((w) => `${w.file}: ${w.message}`)).toEqual(['policy.yaml: policy.yaml has the old shape (toolLevel, rulesFor, ...), which is read only until every app is converted']);
  });

  it('a problem points at its line', async () => {
    const dir = scratchCopy(LIBRARY_DIR, { 'policy.yaml': POLICY_YAML.replace('custom: known-branch', 'custom: known-branches').replace('level: 0', 'level: 1') });
    const { problems } = await checkAppFully(dir, { code: libraryCode });
    expect(problems.map((p) => `${p.file}:${p.line}:${p.column} ${p.path} ${p.message}`)).toEqual([
      'policy.yaml:4:1 actions custom rule "known-branch" (code.customRules["known-branch"]) is not named by any action\'s rules, so it never runs',
      'policy.yaml:6:12 actions.renewLoan.level action "renewLoan" needs identity level 1, but the app has no identity.yaml, so no caller can reach it',
      'policy.yaml:14:17 actions.findHold.rules[1].custom custom rule "known-branches" is not defined in the code',
    ]);
  });

  it('the valid fixture with both files in the new shape: its YAML checks as the old files do, without the warnings; a failed line it lacks is found where identity.yaml names it', async () => {
    const files = { 'policy.yaml': readFileSync(converted('valid', 'policy'), 'utf8'), 'identity.yaml': readFileSync(converted('valid', 'identity'), 'utf8') };
    const old = await checkAppFully(scratchCopy(VALID, {}));
    const fresh = await checkAppFully(scratchCopy(VALID, files));
    expect(old.warnings.map((w) => w.file)).toEqual(['policy.yaml', 'identity.yaml']);
    expect(fresh.warnings).toEqual([]);
    // The same problems, but where identity.yaml names its failed line, and the handoff line for the
    // old file's role reason, which no rule of the new file reads (a dropped row).
    const moved = old.problems
      .filter((p) => !p.message.includes('handoff_staff_cancel'))
      .map((p) => ({ ...p, message: p.message.replace('(failedPromptId)', '(levels["1"].failedPrompt)') }));
    expect(old.problems.length - moved.length).toBe(2); // prompts.yaml's and the fr locale's
    expect(fresh.problems).toEqual(moved);
    const config = loadAppFolder(scratchCopy(VALID, files)).config!;
    expect(isLegacyPolicy(config.policy) || isLegacyIdentity(config.identity!)).toBe(false);
    const renamed = await checkAppFully(scratchCopy(VALID, { ...files, 'identity.yaml': files['identity.yaml'].replace('failedPrompt: identity_failed', 'failedPrompt: identity_missed') }));
    expect(renamed.problems.filter((p) => p.message.includes('identity_missed')).map((p) => `${p.file}:${p.line} ${p.message}`)).toEqual([
      'prompts.yaml:2 prompt "identity_missed" is missing from prompts.yaml; identity.yaml:8 (levels["1"].failedPrompt) says it',
      'locale/fr/prompts.yaml:1 prompt "identity_missed" is missing from the fr prompts; identity.yaml:8 (levels["1"].failedPrompt) says it',
    ]);
  });

  it('a folder whose policy.yaml and identity.yaml are in different shapes does not load', () => {
    const dir = scratchCopy(VALID, { 'identity.yaml': readFileSync(converted('valid', 'identity'), 'utf8') });
    expect(loadAppFolder(dir).problems.map((p) => `${p.file} ${p.message}`)).toEqual([
      'policy.yaml policy.yaml has the old shape and identity.yaml the new one, and the two are read together (the roles and levels the policy names are the identity file\'s)',
    ]);
  });
});
