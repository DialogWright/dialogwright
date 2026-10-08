import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { checkAppFully } from './check';
import { formatProblem } from './problems';
import { defineApp, type AppCode } from './defineApp';
import { RECOGNIZED_DIR, recognizedCode } from '../testing/recognized/app';
import { GREETING } from '../testing/recognized/variant';
import { validateApp } from '../core/app/validate';
import { recognizedApp } from '../testing/recognized/app';

/**
 * What `check` says of a caller-ID match as the identifier (identity.yaml's level 1 `callerId`): it
 * names factors of level 1 and never all of them, it needs app.yaml's call-start lookup and the code's
 * facts.callerMatch, and the engine's lines for it (`identity_caller_match`; `identity_caller_declined`
 * is optional; with `ask: greeting`, the greeting's two lines as for a proposal there).
 */

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A copy of the fixture's YAML, each file changed by its function. */
function folder(files: Record<string, (text: string) => string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'dialogwright-recognized-'));
  scratch.push(dir);
  cpSync(RECOGNIZED_DIR, dir, { recursive: true, filter: (src) => !src.endsWith('.ts') });
  for (const [file, change] of Object.entries(files)) writeFileSync(join(dir, file), change(readFileSync(join(dir, file), 'utf8')));
  return dir;
}

async function checked(dir: string, code: AppCode = recognizedCode): Promise<{ problems: string[]; warnings: string[] }> {
  const r = await checkAppFully(dir, { code, fixturesRoot: PACKAGE_DIR });
  return { problems: r.problems.map(formatProblem), warnings: (r.warnings ?? []).map(formatProblem) };
}

const replace = (from: string, to: string) => (text: string): string => {
  if (!text.includes(from)) throw new Error(`not in the file: ${from}`);
  return text.replace(from, to);
};

const MATCH_LINE = "  identity_caller_match:\n    text: I see an account associated with the number you're calling from. To access it, please tell me your date of birth, or say different account.\n    interruptible: true\n";
const DECLINED_LINE = "  identity_caller_declined:\n    text: Okay, let's find your account.\n    interruptible: false\n";

describe('the fixture', () => {
  it('passes check with no problem and no warning, and so does its greeting variant', async () => {
    expect(await checkAppFully(RECOGNIZED_DIR, { code: recognizedCode, fixturesRoot: PACKAGE_DIR })).toEqual({ problems: [], codeChecked: true });
    expect(await checked(folder(GREETING))).toEqual({ problems: [], warnings: [] });
  });
});

describe('callerId', () => {
  it('refuses a slot that is not a factor of level 1', async () => {
    const { problems } = await checked(folder({ 'identity.yaml': replace('identifies: [accountId]', 'identifies: [acountId]') }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('identity.yaml');
    expect(problems[0]).toContain('levels["1"].callerId.identifies[0]');
    expect(problems[0]).toContain('"acountId" is not one of level 1\'s factors (accountId, dob)');
    expect(problems[0]).toContain('accountId');
  });

  it('refuses identifying every factor: the match alone would verify', async () => {
    const { problems } = await checked(folder({ 'identity.yaml': replace('identifies: [accountId]', 'identifies: [accountId, dob]') }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('callerId identifies every factor of level 1, so the caller-ID match alone would verify the caller');
    expect(problems[0]).toContain('leave at least one factor to be asked');
  });

  it('refuses it without app.yaml\'s call-start lookup', async () => {
    const { problems } = await checked(folder({ 'app.yaml': replace('  lookup: findAccountByPhone\n', '') }));
    expect(problems.join('\n')).toContain('callerId takes the match from the call-start lookup, but app.yaml has no callerNumber lookup');
    const noBlock = await checked(folder({ 'app.yaml': replace('callerNumber:\n  use: hint\n  lookup: findAccountByPhone\n', '') }));
    expect(noBlock.problems.join('\n')).toContain('app.yaml has no callerNumber lookup');
  });

  it('refuses it without the code\'s facts.callerMatch', async () => {
    const { callerMatch: _callerMatch, ...facts } = recognizedCode.facts!;
    const { problems } = await checked(folder(), { ...recognizedCode, facts });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('callerId takes the match from the facts, but the code has no facts.callerMatch');
    expect(problems[0]).toContain('returning { accountId }');
  });

  it('takes on-need or greeting only', async () => {
    const { problems } = await checked(folder({ 'identity.yaml': replace('ask: on-need', 'ask: always') }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('levels["1"].callerId.ask');
    const defaulted = await checked(folder({ 'identity.yaml': replace('      ask: on-need\n', '') }));
    expect(defaulted).toEqual({ problems: [], warnings: [] });
  });

  it('needs identity_caller_match, which is given nothing; identity_caller_declined is optional', async () => {
    const missing = await checked(folder({ 'prompts.yaml': replace(MATCH_LINE, '') }));
    expect(missing.problems).toHaveLength(1);
    expect(missing.problems[0]).toContain('prompt "identity_caller_match" is missing');
    expect(missing.problems[0]).not.toContain('gives it');
    expect(await checked(folder({ 'prompts.yaml': replace(DECLINED_LINE, '') }))).toEqual({ problems: [], warnings: [] });
  });

  it('asked at the greeting, needs greeting_offer and greet_after_offer', async () => {
    const missing = await checked(folder({ ...GREETING, 'prompts.yaml': (t) => t }));
    expect(missing.problems).toHaveLength(2);
    expect(missing.problems.join('\n')).toContain('prompt "greeting_offer" is missing');
    expect(missing.problems.join('\n')).toContain('the caller-ID question (identity.yaml callerId ask: greeting)');
    expect(missing.problems.join('\n')).toContain('prompt "greet_after_offer" is missing');
  });

  it('an app without it needs none of its lines', async () => {
    const without = await checked(folder({
      'identity.yaml': replace('    callerId:\n      identifies: [accountId]\n      ask: on-need\n', ''),
      'prompts.yaml': (t) => replace(DECLINED_LINE, '')(replace(MATCH_LINE, '')(t)),
    }));
    expect(without).toEqual({ problems: [], warnings: [] });
  });

  it('defineApp refuses what check refuses, and validateApp holds an app written in code to the same', () => {
    expect(() => defineApp(folder({ 'identity.yaml': replace('identifies: [accountId]', 'identifies: [accountId, dob]') }), recognizedCode)).toThrow(/identifies every factor/);
    expect(() => validateApp({ ...recognizedApp, identity: { ...recognizedApp.identity!, callerId: { identifies: ['accountId', 'dob'], ask: 'on-need' } } })).toThrow(/identifies every factor/);
    expect(() => validateApp({ ...recognizedApp, identity: { ...recognizedApp.identity!, callerId: { identifies: ['place'], ask: 'on-need' } } })).toThrow(/"place", which is not a factor/);
    const { callerMatch: _callerMatch, ...facts } = recognizedApp.facts!;
    expect(() => validateApp({ ...recognizedApp, facts })).toThrow(/needs facts.callerMatch/);
    const { lookup: _lookup, ...callerNumber } = recognizedApp.callerNumber!;
    expect(() => validateApp({ ...recognizedApp, callerNumber })).toThrow(/needs a call-start lookup/);
    expect(() => validateApp(recognizedApp)).not.toThrow();
  });
});
