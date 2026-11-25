import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { variableChecks } from '../server/doctor';
import { accountByNumber, accountNumbersOf, accountSettingsOf } from './accountNumbers';
import { businessContentProblems } from './business';
import { appYamlEnvReferences } from './envReferences';
import { businessSchema, type BusinessYaml } from './schema/business';
import { BUSINESS_FIXTURE_DIR } from './__fixtures__/business/app';

/**
 * An account's number that names a setting (business.yaml's `accounts[].numbers`: `env.<NAME>`; the agent-mode
 * design's call 50): read from the app's own settings, at call time and as the server starts; unset, left out
 * with a note; set, an E.164 number; one number on file for one account only; named on the policy card, never
 * its value. The fixture library with a setting on its first club. Numbers invented, 555 range.
 */

const SETTING = 'CLUB_TEST_LINE';
const TESTER = '+15555550177';
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const BASE = parse(readFileSync(join(BUSINESS_FIXTURE_DIR, 'business.yaml'), 'utf8')) as Record<string, any>;

function folderWith(edit: (b: Record<string, any>) => void): string {
  const dir = mkdtempSync(join(tmpdir(), 'account-numbers-'));
  dirs.push(dir);
  cpSync(BUSINESS_FIXTURE_DIR, dir, { recursive: true });
  const b = structuredClone(BASE);
  edit(b);
  writeFileSync(join(dir, 'business.yaml'), stringify(b));
  return dir;
}

const withSetting = (b: Record<string, any>): void => {
  b.accounts[0].numbers.push(`env.${SETTING}`);
};

const DIR = folderWith(withSetting);

describe("an account's number read from a setting (call 50)", () => {
  it('the schema takes env.<NAME> beside a number written out, and refuses a name of another shape', () => {
    const accounts = (numbers: string[]) => businessSchema.safeParse({ ...BASE, accounts: [{ name: 'Rivergate Book Club', numbers }] });
    expect(accounts(['+15555550142', `env.${SETTING}`]).success).toBe(true);
    expect(accounts(['env.club_line']).success).toBe(false);
    expect(accounts(['env.']).success).toBe(false);
    expect(accounts(['5555550142']).success).toBe(false);
  });

  it('counts in the uniqueness check as a number written out', () => {
    const b = businessSchema.parse({ ...BASE, accounts: [{ name: 'Rivergate Book Club', numbers: [`env.${SETTING}`] }, { name: 'Northside Readers', numbers: ['+15555550150', `env.${SETTING}`] }] }) as BusinessYaml;
    const messages: string[] = [];
    businessContentProblems(b, (_path, message) => messages.push(message));
    expect(messages).toContainEqual(expect.stringContaining(`the setting env.${SETTING} is on file for "Rivergate Book Club" too`));
  });

  it('reads each setting: unset left out, set to an E.164 number taken, anything else named; a number on two accounts named', () => {
    const accounts = { club: ['+15555550142', `env.${SETTING}`], readers: ['+15555550150'] };
    expect(accountNumbersOf(accounts, () => undefined)).toMatchObject({ numbers: [{ account: 'club', number: '+15555550142' }, { account: 'readers', number: '+15555550150' }], unset: [SETTING], invalid: [], clashes: [] });
    expect(accountNumbersOf(accounts, () => ` ${TESTER} `).numbers).toContainEqual({ account: 'club', number: TESTER, variable: SETTING });
    expect(accountNumbersOf(accounts, () => '555 0177').invalid).toEqual([SETTING]);
    expect(accountNumbersOf(accounts, () => '+15555550150').clashes).toHaveLength(1);
    expect(accountByNumber(accounts, () => TESTER).get(TESTER)).toBe('club');
    expect(accountSettingsOf(accounts)).toEqual([{ account: 'club', variable: SETTING }]);
  });

  it('pnpm diagnose and a host read the setting as the app\'s own; unset is no failure', () => {
    expect(appYamlEnvReferences(DIR)).toContainEqual({ path: 'accounts.0.numbers.2', variable: SETTING, file: 'business.yaml', kind: 'account' });
    const unset = variableChecks(DIR, {}).find((c) => c.message.includes(SETTING))!;
    expect(unset.status).toBe('ok');
    expect(variableChecks(DIR, { [SETTING]: 'not a number' }).find((c) => c.message.includes(SETTING))!.status).toBe('fail');
  });
});
