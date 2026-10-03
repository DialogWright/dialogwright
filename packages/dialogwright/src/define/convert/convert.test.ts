import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { IdentityConfig, PolicyTables } from '../../core/app/types';
import { checkApp } from '../check';
import { main, type Io } from '../cli';
import { compileIdentity, compilePolicy } from '../policyFile';
import { defineApp } from '../defineApp';
import { LIBRARY_DIR, libraryCode } from '../fixture/app';
import { identitySchema, policySchema } from '../schema/index';
import { comparable } from '../__fixtures__/frozen/comparable';
import { FROZEN_LIBRARY_POLICY } from '../__fixtures__/frozen/library';
import { FROZEN_TESTKIT_IDENTITY, FROZEN_TESTKIT_POLICY } from '../__fixtures__/frozen/testkit';
import { FROZEN_VALID_IDENTITY, FROZEN_VALID_POLICY } from '../__fixtures__/frozen/valid';
import { ConvertError, convertFolder, convertTables, toText } from './convertPolicy';

/**
 * `dialogwright policy:convert`: each app the repository has, converted from its old files (or, for
 * the testkit, from its tables), gives the files that app now runs from, less what is said in
 * words (an action's `say`) and the comments; what it writes compiles to the tables the app ran before; and what
 * it cannot say, it reports.
 */

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, '..', '__fixtures__');
const LEGACY = join(FIXTURES, 'legacy');
const COMMITTED = {
  library: join(here, '..', 'fixture'),
  valid: join(FIXTURES, 'valid'),
  testkit: join(here, '..', '..', 'testing', 'testkit'),
} as const;

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dialogwright-convert-'));
  scratch.push(dir);
  return dir;
}

/** A file's parsed data, without what only words add: an action's `say`. */
function dataOf(text: string): Record<string, any> {
  const data = parse(text) as Record<string, any>;
  for (const action of Object.values<Record<string, unknown>>(data.actions ?? {})) delete action.say;
  return data;
}
/** The file an app runs from today, which the converter's output must be (less the words an author adds). */
const committed = (app: keyof typeof COMMITTED, file: 'policy' | 'identity'): string => readFileSync(join(COMMITTED[app], `${file}.yaml`), 'utf8');


/** A compiled identity as the old shape had it: without what only identity.yaml says (the levels' names, and the ladder's other parts). */
function oldShape(identity: IdentityConfig): Partial<IdentityConfig> {
  const old = ['subjectKind', 'delegateKind', 'factorSlots', 'verifyTool', 'codeTool', 'sendCodeTool', 'sendCodeParams', 'failedPromptId'];
  return Object.fromEntries(Object.entries(identity).filter(([k]) => old.includes(k)));
}

describe('each app converts to the files it runs from', () => {
  it('the library fixture, from its old policy.yaml: nothing dropped', () => {
    const converted = convertFolder(join(LEGACY, 'library'));
    expect(Object.keys(converted.files)).toEqual(['policy.yaml']);
    expect(dataOf(converted.files['policy.yaml']!)).toEqual(dataOf(committed('library', 'policy')));
    expect(converted.dropped).toEqual([]);
    expect(converted.unplaced).toEqual([]);
    const policy = compilePolicy(policySchema.parse(parse(converted.files['policy.yaml']!)), { customRules: libraryCode.customRules! });
    expect(comparable(policy)).toEqual(comparable({ ...FROZEN_LIBRARY_POLICY, customRules: libraryCode.customRules! }));
  });

  it('the valid fixture: its old rows that no rule reads are dropped, and each is reported', () => {
    const converted = convertFolder(join(LEGACY, 'valid'));
    expect(Object.keys(converted.files)).toEqual(['policy.yaml', 'identity.yaml']);
    expect(dataOf(converted.files['policy.yaml']!)).toEqual(dataOf(committed('valid', 'policy')));
    expect(converted.dropped).toEqual([
      'subjects.cancelAppointment (patientId): "cancelAppointment" runs no scope rule (R2), so nothing reads it',
      'serviceFields.cancelAppointment (provider, date): "cancelAppointment" runs no fields rule (R7), so nothing reads it',
      'roles.findAppointment (viewer: allow, clerk: allow): "findAppointment" runs no role rule (R5), so nothing reads it',
      'roles.cancelAppointment (viewer: refuse, clerk: person): "cancelAppointment" runs no role rule (R5), so nothing reads it',
      'rolePersonReason (staff-cancel): no role rule hands a call to a person, so no call goes to a person for that reason',
    ]);
    const identity = parse(converted.files['identity.yaml']!);
    expect(identity).toEqual(parse(committed('valid', 'identity')));
    const compiled = compileIdentity(identitySchema.parse(identity));
    expect(oldShape(compiled.identity)).toEqual(FROZEN_VALID_IDENTITY);
    expect(compiled.maxAttempts).toBe(FROZEN_VALID_POLICY.maxAttempts);
    // What compiles is the old tables less the dropped rows (the roles stay in identity.yaml, which the role wording's lines are over).
    const policy = compilePolicy(policySchema.parse(parse(converted.files['policy.yaml']!)), { maxAttempts: compiled.maxAttempts });
    const { subjects, serviceFields, roles, rolePersonReason, ...kept } = FROZEN_VALID_POLICY;
    void roles;
    void rolePersonReason;
    expect(comparable(policy, ['viewer', 'clerk'])).toEqual(comparable({ ...kept, subjects: { findAppointment: subjects.findAppointment! }, serviceFields: {} } as PolicyTables, ['viewer', 'clerk']));
    expect(serviceFields).toEqual({ cancelAppointment: ['provider', 'date'] });
  });

  it('the testkit, from its TypeScript tables (no comments to keep): its custom rule is named, not carried', () => {
    const converted = convertTables(FROZEN_TESTKIT_POLICY as PolicyTables, { ...FROZEN_TESTKIT_IDENTITY, sendCodeParams: () => ({}) });
    expect(dataOf(toText(converted.policy))).toEqual(dataOf(committed('testkit', 'policy')));
    expect(parse(toText(converted.identity!))).toEqual(parse(committed('testkit', 'identity')));
    expect(converted.dropped).toEqual([]);
    const compiled = compileIdentity(identitySchema.parse(parse(toText(converted.identity!))));
    expect(oldShape(compiled.identity)).toEqual(FROZEN_TESTKIT_IDENTITY);
    const policy = compilePolicy(policySchema.parse(parse(toText(converted.policy))), { maxAttempts: compiled.maxAttempts });
    expect(comparable(policy)).toEqual(comparable(FROZEN_TESTKIT_POLICY));
  });

  it('a round trip: the old library files in a folder, converted in place, load, check and build the same app', async () => {
    const dir = temp();
    cpSync(LIBRARY_DIR, dir, { recursive: true, filter: (src) => !src.endsWith('.ts') });
    writeFileSync(join(dir, 'policy.yaml'), readFileSync(join(LEGACY, 'library', 'policy.yaml'), 'utf8'));
    const { io, out } = cli(dir);
    expect(await main(['policy:convert', dir], io)).toBe(0);
    expect(out).toEqual(['wrote policy.yaml']);
    expect(readFileSync(join(dir, 'policy.yaml'), 'utf8')).toMatch(/^# yaml-language-server: \$schema=.*schemas\/policy\.schema\.json\nactions:\n/);
    expect(await checkApp(dir, { code: libraryCode })).toEqual([]);
    expect(comparable(defineApp(dir, libraryCode).policy)).toEqual(comparable({ ...FROZEN_LIBRARY_POLICY, customRules: libraryCode.customRules! }));
  });
});

// ---------------------------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------------------------

const OLD = `# yaml-language-server: $schema=../old/path/policy.schema.json
# An app's policy: the header stays at the top.
toolLevel:
  # reading is open to anyone who has verified
  getRecord: 1
  fileRequest: 2 # filing needs the code
  sendCode: 1
  checkCode: 1
  checkFactors: 0
  getOld: 1

# What each tool runs.
rulesFor:
  getRecord: [R1, R2]
  fileRequest: [R1, R5, R2, R3, R4, R7]
  sendCode: [R1]
  checkCode: [R1, R6]
  checkFactors: [R6]

subjects:
  getRecord: { param: recordId, via: record }
  fileRequest: { param: accountId }
  getOld:
    # a row nothing reads
    param: accountId

# R3: what a confirmed write carries.
confirmedFields: [accountId, note]

serviceFields:
  # what the downstream desk may receive
  fileRequest: [note]

# Three tries.
maxAttempts: 4

roles:
  # a viewer may not file; a clerk may with a person
  fileRequest: { viewer: refuse, clerk: person }

rolePersonReason: staff-filing

# Reporting needs the code from the start.
purposeLevel:
  # the one purpose
  file_request: 2
`;
const OLD_IDENTITY = `# yaml-language-server: $schema=../old/path/identity.schema.json
# Who the app serves.
subjectKind: customer
# The party who acts for them.
delegateKind: agent
# What a step-up asks.
factorSlots: [accountId, dob]
verifyTool: checkFactors
# The code.
codeTool: checkCode
sendCodeTool: sendCode
`;

describe('policy:convert keeps the comments the new shape has a place for', () => {
  const dir = temp();
  writeFileSync(join(dir, 'policy.yaml'), OLD);
  writeFileSync(join(dir, 'identity.yaml'), OLD_IDENTITY);
  const converted = convertFolder(dir);
  const policy = converted.files['policy.yaml']!;
  const identity = converted.files['identity.yaml']!;

  it('the header stays at the top, under the schema line of where the file will be', () => {
    expect(policy.split('\n').slice(0, 3)).toEqual([expect.stringMatching(/^# yaml-language-server: \$schema=.*schemas\/policy\.schema\.json$/), "# An app's policy: the header stays at the top.", 'actions:']);
    expect(policy).not.toContain('old/path');
    expect(identity.split('\n').slice(0, 3)).toEqual([expect.stringMatching(/^# yaml-language-server: \$schema=.*schemas\/identity\.schema\.json$/), '# Who the app serves.', 'principals:']);
  });

  it('a comment by a tool\'s row goes before its action; one before a section goes before the section\'s first action', () => {
    expect(policy).toContain('  # reading is open to anyone who has verified\n  getRecord:');
    // filing: its own trailing comment, the confirmed list's comment, the service fields' and the roles' comments, once each.
    const filing = policy.slice(policy.indexOf('  # filing needs the code'), policy.indexOf('  sendCode:'));
    expect(filing.split('\n').filter((l) => l.trim().startsWith('#'))).toEqual([
      '  # filing needs the code',
      '  # R3: what a confirmed write carries.',
      '  # what the downstream desk may receive',
      '  # a viewer may not file; a clerk may with a person',
    ]);
    expect(policy).toContain('# Reporting needs the code from the start.\npurposes:\n  # the one purpose\n  file_request: { level: 2 }');
  });

  it('the old maxAttempts\'s comment goes before attempts; an identity key\'s before its level', () => {
    expect(identity).toContain('# Three tries.\nattempts: 4');
    expect(identity).toContain('  # The party who acts for them.\n  delegates:');
    expect(identity).toContain('  # What a step-up asks.\n  1: ');
    expect(identity).toContain('  # The code.\n  2: ');
  });

  it('what cannot be placed is reported: a comment on a whole table, and one on a dropped row', () => {
    expect(converted.unplaced).toEqual([
      'rulesFor: "What each tool runs." (it describes the whole table, which the actions replace)',
      'subjects.getOld: "a row nothing reads" (its row is dropped)',
    ]);
    expect(converted.dropped).toEqual([
      'toolLevel.getOld (1): "getOld" has no row under rulesFor, so it can never be called',
      'subjects.getOld (accountId): "getOld" has no row under rulesFor, so it can never be called',
    ]);
  });

  it('the result is valid: it loads under the schemas, and compiles to the old tables', () => {
    const compiled = compileIdentity(identitySchema.parse(parse(identity)));
    expect(compiled.maxAttempts).toBe(4);
    const tables = compilePolicy(policySchema.parse(parse(policy)), { maxAttempts: compiled.maxAttempts });
    expect(tables.rulesFor.fileRequest).toEqual(['R1', 'R5', 'R2', 'R3', 'R4', 'R7']);
    expect(tables.roles).toEqual({ fileRequest: { viewer: 'refuse', clerk: 'person' } });
    expect(tables.rolePersonReason).toBe('staff-filing');
    expect(tables.serviceFields).toEqual({ fileRequest: ['note'] });
    expect(tables.confirmedFields).toEqual(['accountId', 'note']);
    expect(tables.purposeLevel).toEqual({ file_request: 2 });
  });
});

// ---------------------------------------------------------------------------------------------
// What cannot be converted, and what is already converted
// ---------------------------------------------------------------------------------------------

describe('policy:convert refuses what it cannot write, and says how to fix the old file', () => {
  const folder = (policy: string, identity?: string): string => {
    const dir = temp();
    writeFileSync(join(dir, 'policy.yaml'), policy);
    if (identity) writeFileSync(join(dir, 'identity.yaml'), identity);
    return dir;
  };
  const base = 'toolLevel: { a: 1 }\nconfirmedFields: []\nmaxAttempts: 3\n';
  const problems = (policy: string): string[] => {
    try {
      convertFolder(folder(policy));
    } catch (error) {
      if (error instanceof ConvertError) return [...error.problems];
      throw error;
    }
    return [];
  };

  it('R2 with no subject, R3 with no fields, R5 with no roles', () => {
    expect(problems(`${base}rulesFor: { a: [R1, R2, R3, R5] }\n`)).toEqual([
      'rulesFor.a: "a" runs R2 but has no row under subjects, so the rule can only refuse; the scope rule needs the param that names the subject -> add "a: { param: <the param> }" under subjects, or take R2 out of its rules',
      'rulesFor.a: "a" runs R3, but confirmedFields is empty, so the rule blocks every call; the confirmed rule needs at least one field -> list the fields in confirmedFields, or take R3 out of its rules',
      'rulesFor.a: "a" runs R5 but has no roles row, so only a subject passes it; the role rule needs the roles it governs -> add "a: { <role>: allow | refuse | person }" under roles, or take R5 out of its rules',
    ]);
  });

  it('a file that is not valid, with the line the loader would give', () => {
    expect(problems('toolLevel: { a: 3 }\nrulesFor: {}\nconfirmedFields: []\nmaxAttempts: 3\n')).toEqual([expect.stringMatching(/^policy\.yaml:1:\d+  toolLevel\.a  /)]);
  });

  it('files in neither shape, and a mix of the two', () => {
    expect(problems('colour: red\n')).toEqual([expect.stringContaining('in neither shape')]);
    const mixed = folder(`${base}rulesFor: { a: [R1] }\n`, 'principals: { subject: customer }\nlevels: {}\nattempts: 3\n');
    expect(() => convertFolder(mixed)).toThrow(/identity\.yaml is in the new shape and policy\.yaml in the old|policy\.yaml is in the old shape and identity\.yaml in the new one/);
  });

  it('files already in the new shape are left alone', () => {
    const dir = folder('actions:\n  a: { level: 1, rules: [identity] }\n');
    expect(convertFolder(dir)).toEqual({ files: {}, dropped: [], unplaced: [], alreadyNew: ['policy.yaml'] });
  });

  it('a max-attempts that no identity check counts is dropped, and said', () => {
    const converted = convertFolder(folder('toolLevel: { a: 0 }\nrulesFor: { a: [R1] }\nconfirmedFields: []\nmaxAttempts: 5\n'));
    expect(converted.dropped).toEqual(['maxAttempts (5): the app has no identity file, so no identity check counts tries; the attempts live in identity.yaml']);
  });
});

describe('policy:convert from tables', () => {
  const tables = (over: Partial<PolicyTables> = {}): PolicyTables => ({
    toolLevel: { a: 1 },
    purposeLevel: {},
    rulesFor: { a: ['R1', 'R5'] },
    serviceFields: {},
    confirmedFields: [],
    maxAttempts: 3,
    roles: { a: { clerk: 'person', viewer: 'allow' } },
    subjects: {},
    ...over,
  });

  it('a role wording that is a template over {role} and {tool} becomes templates; the engine\'s own words are left out', () => {
    const converted = convertTables(tables({ wording: { role: (role, tool, access) => (access === 'person' ? `${role} hands ${tool} to a person` : `role ${role} may ${tool}: ${access === 'allow' ? 'yes' : 'no'}`) } }));
    expect(parse(toText(converted.policy)).wording).toEqual({ role: { person: '{role} hands {tool} to a person' } });
    expect(converted.dropped).toEqual([]);
  });

  it('a role wording that is not a template is dropped, and said', () => {
    const converted = convertTables(tables({ wording: { role: (role, _tool, access) => (access === 'allow' ? `${role.toUpperCase()} yes` : `${role} no`) } }));
    expect(parse(toText(converted.policy)).wording).toEqual({ role: { refuse: '{role} no', person: '{role} no' } });
    expect(converted.dropped).toEqual(['wording.role (allow): the function is not a template over {role} and {tool}, so its line cannot be written in the file; write wording.role.allow by hand']);
  });

  it('--sign-in adds what the old shape cannot say', () => {
    const identity = { subjectKind: 'customer', factorSlots: ['a'], verifyTool: 'v', codeTool: 'c', sendCodeTool: 's' };
    expect(parse(toText(convertTables(tables({ roles: undefined, rulesFor: { a: ['R1'] } }), identity, { signIn: true }).identity!)).signIn).toEqual({ level: 2 });
    expect(parse(toText(convertTables(tables({ roles: undefined, rulesFor: { a: ['R1'] } }), identity).identity!)).signIn).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------------------------

function cli(cwd: string): { io: Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l), cwd }, out, err };
}

describe('dialogwright policy:convert', () => {
  const oldFolder = (): string => {
    const dir = temp();
    cpSync(join(LEGACY, 'valid'), dir, { recursive: true });
    return dir;
  };

  it('converts a folder in place and reports each dropped row, exit 0', async () => {
    const dir = oldFolder();
    const { io, out, err } = cli(dir);
    expect(await main(['policy:convert', '.'], io)).toBe(0);
    expect(err).toEqual([]);
    expect(out.slice(0, 2)).toEqual(['wrote policy.yaml', 'wrote identity.yaml']);
    expect(out.slice(2)).toHaveLength(5);
    expect(out.slice(2).every((l) => l.startsWith('dropped '))).toBe(true);
    expect(dataOf(readFileSync(join(dir, 'policy.yaml'), 'utf8'))).toEqual(dataOf(committed('valid', 'policy')));
    // Converting again has nothing to do.
    const again = cli(dir);
    expect(await main(['policy:convert', '.'], again.io)).toBe(0);
    expect(again.out).toEqual(['policy.yaml is already in the new shape: left alone', 'identity.yaml is already in the new shape: left alone']);
  });

  it('--out writes elsewhere and leaves the folder alone; --dry-run writes nothing', async () => {
    const dir = oldFolder();
    const before = readFileSync(join(dir, 'policy.yaml'), 'utf8');
    const target = join(temp(), 'new');
    expect(await main(['policy:convert', dir, '--out', target], cli(dir).io)).toBe(0);
    expect(existsSync(join(target, 'identity.yaml'))).toBe(true);
    expect(readFileSync(join(dir, 'policy.yaml'), 'utf8')).toBe(before);
    const other = temp();
    const dry = cli(dir);
    expect(await main(['policy:convert', dir, '--out', other, '--dry-run'], dry.io)).toBe(0);
    expect(existsSync(join(other, 'policy.yaml'))).toBe(false);
    expect(dry.out[0]).toMatch(/^policy\.yaml: would write /);
    expect(dry.out.filter((l) => l.startsWith('dropped '))).toHaveLength(5);
  });

  it('--from-tables reads a module\'s policy and identity, and writes beside it (or to --out)', async () => {
    const dir = temp();
    const module = join(dir, 'tables.mjs');
    writeFileSync(
      module,
      `export const policy = ${JSON.stringify(FROZEN_LIBRARY_POLICY)};\nexport const identity = undefined;\n`,
    );
    const { io, out } = cli(dir);
    expect(await main(['policy:convert', '--from-tables', 'tables.mjs', '--sign-in'], io)).toBe(0);
    expect(out).toEqual(['wrote policy.yaml']);
    expect(dataOf(readFileSync(join(dir, 'policy.yaml'), 'utf8')).actions.renewLoan).toEqual({ level: 0, rules: ['identity', { confirmed: ['book'] }] });
    // A module with no policy.
    writeFileSync(join(dir, 'empty.mjs'), 'export const other = 1;\n');
    const bad = cli(dir);
    expect(await main(['policy:convert', '--from-tables', 'empty.mjs'], bad.io)).toBe(1);
    expect(bad.err).toEqual([expect.stringContaining('exports no `policy`')]);
  });

  it('a folder it cannot convert: the problems on stderr, exit 1, nothing written; a command it does not understand: exit 2', async () => {
    const dir = temp();
    writeFileSync(join(dir, 'policy.yaml'), 'toolLevel: { a: 1 }\nrulesFor: { a: [R2] }\nconfirmedFields: []\nmaxAttempts: 3\n');
    const { io, out, err } = cli(dir);
    expect(await main(['policy:convert', dir], io)).toBe(1);
    expect(out).toEqual([]);
    expect(err).toHaveLength(1);
    expect(readFileSync(join(dir, 'policy.yaml'), 'utf8')).toContain('toolLevel');
    for (const args of [[], ['x', 'y'], ['--bogus'], ['--out'], ['x', '--from-tables', 'm']]) {
      const bad = cli(dir);
      expect(await main(['policy:convert', ...args], bad.io)).toBe(2);
      expect(bad.err[0]).toContain('usage: dialogwright check');
    }
    mkdirSync(join(dir, 'empty'));
    expect(await main(['policy:convert', join(dir, 'empty')], cli(dir).io)).toBe(1);
  });
});
