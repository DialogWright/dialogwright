import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { checkAppFully } from './check';
import { formatProblem } from './problems';
import type { AppCode } from './defineApp';
import { defineSlot, SlotConfigError } from '../slots/defineSlot';
import { TEXTING_DIR, textingCode } from '../testing/texting/app';

/**
 * What `check` says of the number the caller is calling from as an app uses it: app.yaml's
 * `callerNumber` (its `use`, and a lookup that is an action whose tool takes the number alone), the
 * text offer's `onNo` and `ifNone` (and a summary line that would read a slot left empty), and the
 * warnings, which `check` prints and never counts: a lookup above level 0, its number recorded as it
 * is, a callerNumber rule in an app that keeps no number, and one on a param no slot offering it holds.
 */

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A copy of the fixture's YAML, each file changed by its function. */
function folder(files: Record<string, (text: string) => string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'dialogwright-hint-'));
  scratch.push(dir);
  cpSync(TEXTING_DIR, dir, { recursive: true, filter: (src) => !src.endsWith('.ts') });
  for (const [file, change] of Object.entries(files)) writeFileSync(join(dir, file), change(readFileSync(join(dir, file), 'utf8')));
  return dir;
}

async function checked(dir: string, code: AppCode = textingCode): Promise<{ problems: string[]; warnings: string[] }> {
  const r = await checkAppFully(dir, { code, fixturesRoot: PACKAGE_DIR });
  return { problems: r.problems.map(formatProblem), warnings: (r.warnings ?? []).map(formatProblem) };
}

const replace = (from: string, to: string) => (text: string): string => {
  if (!text.includes(from)) throw new Error(`not in the file: ${from}`);
  return text.replace(from, to);
};

describe('the fixture', () => {
  it('passes check with no problem and no warning', async () => {
    expect(await checkAppFully(TEXTING_DIR, { code: textingCode, fixturesRoot: PACKAGE_DIR })).toEqual({ problems: [], codeChecked: true });
  });
});

describe('app.yaml\'s callerNumber', () => {
  it('takes use: hint only', async () => {
    const { problems } = await checked(folder({ 'app.yaml': replace('  use: hint', '  use: identity') }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('callerNumber.use');
    expect(problems[0]).toContain('the only value allowed is "hint"');
  });

  it('refuses a key it does not have', async () => {
    const { problems } = await checked(folder({ 'app.yaml': replace('  called: true', '  calling: true') }));
    expect(problems.join('\n')).toContain('unknown key "calling"');
  });

  it('needs the lookup to be an action of the policy', async () => {
    const { problems } = await checked(folder({ 'app.yaml': replace('lookup: findCallerByPhone', 'lookup: findCallerByPhon') }));
    // The action it meant is then reached by nothing, which is said too.
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('app.yaml');
    expect(problems[0]).toContain('the call-start lookup "findCallerByPhon" is not an action in policy.yaml');
    expect(problems[0]).toContain('rename it to "findCallerByPhone"');
    expect(problems[1]).toContain('action "findCallerByPhone" is reached by no form');
  });

  it('needs the lookup\'s tool to take the number as its one param', async () => {
    const code: AppCode = { ...textingCode, tools: { ...textingCode.tools, findCallerByPhone: { ...textingCode.tools.findCallerByPhone!, params: ['callerNumber', 'topic'] } } };
    const { problems } = await checked(folder(), code);
    expect(problems.join('\n')).toContain('the tool "findCallerByPhone" is the call-start lookup (app.yaml\'s callerNumber.lookup), which is called with one param, callerNumber, but it lists callerNumber, topic');
  });

  it('counts the lookup as reached at call start, by no form', async () => {
    const { problems } = await checked(folder({ 'forms.yaml': replace('calls: [openRequest, sendUpdates, lineType]', 'calls: [openRequest, sendUpdates]') }));
    // lineType is reached by no form now; the lookup is reached at call start.
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('action "lineType" is reached by no form');
  });
});

describe('the text offer\'s options', () => {
  it('take ask or skip, under callerNumber only', () => {
    const textTo = { type: 'digits', noun: 'mobile number', length: 10 } as const;
    expect(defineSlot('textTo', { ...textTo, callerNumber: { countryCode: '1', onNo: 'skip', ifNone: 'skip' } }).callerNumber).toMatchObject({ onNo: 'skip', ifNone: 'skip' });
    // ask, the default, is as if it were not written.
    const asks = defineSlot('textTo', { ...textTo, callerNumber: { countryCode: '1', onNo: 'ask', ifNone: 'ask' } }).callerNumber!;
    expect(['onNo' in asks, 'ifNone' in asks]).toEqual([false, false]);
    expect(() => defineSlot('textTo', { ...textTo, callerNumber: { countryCode: '1', onNo: 'drop' } })).toThrow(SlotConfigError);
    expect(() => defineSlot('textTo', { ...textTo, onNo: 'skip' })).toThrow(SlotConfigError);
  });

  it('refuses a summary line that names a slot that may be left empty', async () => {
    const { problems } = await checked(folder({ 'prompts.yaml': replace('That\'s a request about {topic}, with no texts.', 'That\'s a request about {topic}, texts to {textTo}.') }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('prompts.confirm_open_request.text');
    expect(problems[0]).toContain('the summary of the form "open_request" names {textTo}, but the slot may be left empty (its callerNumber says onNo: skip)');
    expect(problems[0]).toContain('onSummaryRead');
  });
});

describe('the warnings', () => {
  it('a lookup above level 0, which no caller not yet proven can run', async () => {
    const { warnings } = await checked(folder({ 'policy.yaml': replace('  findCallerByPhone:\n    say: look up the line type of the number calling\n    level: 0', '  findCallerByPhone:\n    say: look up the line type of the number calling\n    level: 1') }));
    expect(warnings.join('\n')).toContain('the action "findCallerByPhone" is the call-start lookup (app.yaml\'s callerNumber.lookup), which runs before anyone is verified, but it needs level 1, so the gate always refuses it');
  });

  it('the lookup\'s number recorded as it is', async () => {
    const { problems, warnings } = await checked(folder({ 'policy.yaml': replace('  callerNumber: last4', '  callerNumber: keep') }));
    expect(problems).toEqual([]);
    expect(warnings).toEqual([expect.stringContaining('the call-start lookup\'s param, the number the caller is calling from, is recorded as it is (keep)')]);
  });

  it('a callerNumber rule in an app that keeps no caller\'s number, which refuses every call', async () => {
    const dir = folder({
      'app.yaml': replace('callerNumber:\n  use: hint\n  called: true\n  lookup: findCallerByPhone\n', ''),
      'slots.yaml': replace("  callerNumber:\n    countryCode: '1'\n    onNo: skip\n    ifNone: skip\n", ''),
    });
    const { warnings } = await checked(dir, { ...textingCode, callerOffer: undefined });
    const always = warnings.filter((w) => w.includes('the app keeps no caller\'s number'));
    // The two lookups' rules refuse every call; the text's passes a confirmed number, so it is not one.
    expect(always.map((w) => /callerNumber rule of "(\w+)"/.exec(w)![1])).toEqual(['findCallerByPhone', 'lineType']);
  });

  it('a callerNumber rule on a param that is no slot offering the number, compared digit for digit', async () => {
    const { warnings } = await checked(folder({ 'policy.yaml': replace('      - callerNumber: { field: textTo, else: confirmed }', '      - callerNumber: { field: topic, else: confirmed }') }));
    expect(warnings).toEqual([expect.stringContaining('"topic" is no slot that offers the caller\'s number, so the rule compares it with the number as the carrier sent it, digit for digit')]);
  });
});
