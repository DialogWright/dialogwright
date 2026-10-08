import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { checkAppFully } from './check';
import { loadAppFolder } from './load';
import { formatProblem } from './problems';
import { main, type Io } from './cli';
import { defineApp, type AppCode } from './defineApp';
import { validateApp } from '../core/app/validate';
import { SCREENED_DIR, screenedApp, screenedCode } from '../testing/screened/app';
import { PROPOSALS_DIR, proposalsCode } from '../testing/proposals/app';
import { CHECKING } from '../testing/proposals/variant';

/**
 * What `check` says of a form's checks (./formChecks.ts): the refusals, which defineApp makes too,
 * and the warnings, which only `check` prints and never counts.
 */

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A copy of the fixture's YAML, each file changed by its function. */
function folder(files: Record<string, (text: string) => string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'dialogwright-checks-'));
  scratch.push(dir);
  cpSync(SCREENED_DIR, dir, { recursive: true, filter: (src) => !src.endsWith('.ts') });
  for (const [file, change] of Object.entries(files)) writeFileSync(join(dir, file), change(readFileSync(join(dir, file), 'utf8')));
  return dir;
}

/** A copy of the proposals fixture's YAML (an app with identity), each file changed by its function. */
function proposalsFolder(files: Record<string, (text: string) => string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'dialogwright-checks-'));
  scratch.push(dir);
  cpSync(PROPOSALS_DIR, dir, { recursive: true, filter: (src) => !src.endsWith('.ts') });
  for (const [file, change] of Object.entries(files)) writeFileSync(join(dir, file), change(readFileSync(join(dir, file), 'utf8')));
  return dir;
}

async function checked(dir: string, code: AppCode = screenedCode): Promise<{ problems: string[]; warnings: string[] }> {
  const r = await checkAppFully(dir, { code, fixturesRoot: PACKAGE_DIR });
  return { problems: r.problems.map(formatProblem), warnings: (r.warnings ?? []).map(formatProblem) };
}

const replace = (from: string, to: string) => (text: string): string => {
  if (!text.includes(from)) throw new Error(`not in the file: ${from}`);
  return text.replace(from, to);
};

describe('the fixture', () => {
  it('passes check with no problem and no warning', async () => {
    expect(await checkAppFully(SCREENED_DIR, { code: screenedCode, fixturesRoot: PACKAGE_DIR })).toEqual({ problems: [], codeChecked: true });
  });

  it('builds: its forms carry their checks, its policy marks the three checks', () => {
    expect(screenedApp.forms.book_visit!.checks!.map((c) => [c.action, c.with, c.on])).toEqual([
      ['checkUrgency', ['howUrgent'], { urgent: { then: 'handoff' } }],
      ['checkOwner', ['ownership'], { 'not-owner': { say: 'decline_renter', then: 'end' } }],
      ['checkArea', ['town'], { 'out-of-area': { say: 'decline_out_of_area', then: 'end' } }],
    ]);
    expect(screenedApp.forms.book_visit!.checksPassed).toBe('visit_qualifies');
    expect(screenedApp.forms.urgent).not.toHaveProperty('checks');
    expect(screenedApp.forms.urgent).not.toHaveProperty('checksPassed');
  });
});

describe('the refusals', () => {
  it('a check whose action policy.yaml does not have', async () => {
    const dir = folder({ 'forms.yaml': replace('action: checkArea', 'action: checkAre') });
    expect((await checked(dir)).problems).toContain('forms.yaml:19:17  forms.book_visit.checks[2].action  form "book_visit" checks "checkAre", which is not an action in policy.yaml  ->  rename it to "checkArea", or add "checkAre:" under actions in policy.yaml with "check: true", its level and its rules');
  });

  it('a check whose action has a tool, not check: true', async () => {
    const dir = folder({ 'forms.yaml': replace('action: checkArea', 'action: bookVisit') });
    const { problems } = await checked(dir);
    expect(problems).toContain('forms.yaml:19:17  forms.book_visit.checks[2].action  form "book_visit" checks "bookVisit", which is an action with a tool, not a check  ->  add "check: true" to actions.bookVisit in policy.yaml (and delete its tool from the code), or check an action that has it');
    // checkArea is now named by no form's checks.
    expect(problems).toContain('policy.yaml:20:3  actions.checkArea  check "checkArea" is named by no form\'s checks, so the gate is never asked it  ->  add "- action: checkArea" with the slots it reads to the checks of a form in forms.yaml, or delete the action');
  });

  it('a slot the form does not have', async () => {
    const dir = folder({ 'forms.yaml': replace('with: [town]', 'with: [tow]') });
    expect((await checked(dir)).problems).toContain('forms.yaml:20:16  forms.book_visit.checks[2].with[0]  check "checkArea" reads "tow", which is not one of form "book_visit"\'s slots  ->  rename it to "town", or add "tow" to the form\'s slots');
  });

  it('a check action that runs the confirmed rule', async () => {
    const dir = folder({
      'policy.yaml': replace('      - oneOf: { field: ownership, values: [own], reason: not-owner }\n  checkArea:', '      - oneOf: { field: ownership, values: [own], reason: not-owner }\n      - confirmed: [problem, ownership, town, howUrgent, visitDay, timeOfDay]\n  checkArea:'),
    });
    const { problems } = await checked(dir);
    expect(problems).toContain('policy.yaml:20:9  actions.checkOwner.rules[2]  check "checkOwner" runs the confirmed rule, but nothing is confirmed part-way through a form, so it would refuse every time  ->  delete the rule: the write the form makes at its completion holds what the caller confirmed');
  });

  it('a list rule of a check on a param no check of it sends, and a value a choice slot does not have', async () => {
    const dir = folder({
      'policy.yaml': (t) => replace('field: town, values: [millbrook, cedar_falls, ashford, riverton], reason: out-of-area }\n  bookVisit:', 'field: postcode, values: [millbrook], reason: out-of-area }\n  bookVisit:')(t)
        .replace('values: [own], reason: not-owner }\n  checkArea:', 'values: [owner], reason: not-owner }\n  checkArea:'),
    });
    const { problems } = await checked(dir);
    expect(problems).toEqual([
      'policy.yaml:19:45  actions.checkOwner.rules[1].oneOf.values[0]  "owner" is not an option of the choice slot "ownership" (own, rent), so the param never carries it  ->  rename it to "own", or list the option\'s id as slots.yaml has it, or add "owner" to the slot\'s options',
      'policy.yaml:26:25  actions.checkArea.rules[1].oneOf.field  check "checkArea" holds "postcode", which no form\'s check of it reads (with: town), so it would refuse every time  ->  add "postcode" to the check\'s `with` in forms.yaml',
    ]);
  });

  it('a line a check says that prompts.yaml does not have, in any locale', async () => {
    const dir = folder({
      'forms.yaml': (t) => replace('say: decline_renter', 'say: decline_tenant')(t).replace('checksPassed: visit_qualifies', 'checksPassed: visit_ok').replace('urgent: { then: handoff }', 'urgent: { then: handoff, reason: office }'),
    });
    const { problems } = await checked(dir);
    expect(problems).toEqual([
      'forms.yaml:14:44  forms.book_visit.checks[0].on.urgent.reason  prompt "handoff_office" is not in prompts.yaml  ->  add "handoff_office:" to prompts.yaml with its text and interruptible',
      'forms.yaml:18:29  forms.book_visit.checks[1].on.not-owner.say  prompt "decline_tenant" is not in prompts.yaml  ->  rename it to "decline_renter", or add "decline_tenant:" to prompts.yaml with its text and interruptible',
      'forms.yaml:23:19  forms.book_visit.checksPassed  prompt "visit_ok" is not in prompts.yaml  ->  rename it to "visit_booked", or add "visit_ok:" to prompts.yaml with its text and interruptible',
    ]);
  });

  it('a read-back a check outcome or a slot names that prompts.yaml does not have, and a confirmValues value that is not an option', async () => {
    const dir = folder({
      'forms.yaml': replace('out-of-area: { say: decline_out_of_area, then: end }', 'out-of-area: { confirm: check_area, say: decline_out_of_area, then: end }'),
      'slots.yaml': replace('ownership:\n  type: choice\n', 'ownership:\n  type: choice\n  confirmValues: [rent]\n'),
    });
    const { problems } = await checked(dir);
    expect(problems).toEqual([
      'forms.yaml:22:35  forms.book_visit.checks[2].on.out-of-area.confirm  prompt "check_area" is not in prompts.yaml  ->  add "check_area:" to prompts.yaml with its text and interruptible',
      'prompts.yaml:6:1  prompts  prompt "confirm_ownership" is missing from prompts.yaml; the engine says it when it reads the slot "ownership" back for a yes when it is "rent" (its confirmValues), and gives it {ownership}  ->  add "confirm_ownership:" with its text (it may use {ownership}) and interruptible to prompts.yaml',
    ]);
    const unknown = folder({ 'slots.yaml': replace('ownership:\n  type: choice\n', 'ownership:\n  type: choice\n  confirmValues: [renter]\n') });
    expect((await checked(unknown)).problems).toEqual([
      'slots.yaml:18:19  ownership.confirmValues[0]  confirmValues names "renter", which is not one of the slot\'s options (own, rent)  ->  name an option by its key, as `options` writes it, or delete it from confirmValues',
    ]);
  });

  it('a read-back with both lines: no problem, and a check outcome carries it', async () => {
    const lines = '  confirm_ownership:\n    text: Just to check, {ownership}?\n    interruptible: true\n  check_area:\n    text: Just to check, the home is in {town}?\n    interruptible: true\n';
    const dir = folder({
      'forms.yaml': replace('out-of-area: { say: decline_out_of_area, then: end }', 'out-of-area: { confirm: check_area, say: decline_out_of_area, then: end }'),
      'slots.yaml': replace('ownership:\n  type: choice\n', 'ownership:\n  type: choice\n  confirmValues: [rent]\n'),
      'prompts.yaml': (t) => `${t}${lines}`,
    });
    expect(await checked(dir)).toEqual({ problems: [], warnings: [] });
    // The read-back line is held to the slot's own variable, as any line a slot declares.
    const wrong = folder({
      'slots.yaml': replace('ownership:\n  type: choice\n', 'ownership:\n  type: choice\n  confirmValues: [rent]\n'),
      'prompts.yaml': (t) => `${t}  confirm_ownership:\n    text: Just to check, {town}?\n    interruptible: true\n`,
    });
    expect((await checked(wrong)).problems.join('\n')).toMatch(/confirm_ownership.*\{town\}/);
  });

  it('a check action with a tool in the code', async () => {
    const code: AppCode = { ...screenedCode, tools: { ...screenedCode.tools, checkOwner: { params: ['ownership'], run: () => ({ value: null, summary: 'x' }) } } };
    const { problems } = await checked(folder(), code);
    expect(problems).toContain('policy.yaml:15:12  actions.checkOwner.check  action "checkOwner" is a check, which has no tool, but the code defines a tool "checkOwner"  ->  delete the tool from app.ts (code.tools.checkOwner), since a check runs nothing, or delete "check: true" to make it an action with a tool');
  });

  it('the schema: an ending with no line, a reason that hands off nothing, a check listed twice, checksPassed with no checks', () => {
    const dir = folder({
      'forms.yaml': (t) => t
        .replace('not-owner: { say: decline_renter, then: end }', 'not-owner: { then: end, reason: office }')
        .replace('      - action: checkArea', '      - action: checkOwner\n        with: [ownership]\n      - action: checkArea')
        .replace('    calls: []', '    calls: []\n    checksPassed: visit_qualifies'),
    });
    expect(loadAppFolder(dir).problems.map(formatProblem)).toEqual([
      'forms.yaml:18:11  forms.book_visit.checks[1].on.not-owner  then: end says a line first, and this outcome names none  ->  add "say: <a prompt id in prompts.yaml>" with the line the caller hears',
      'forms.yaml:18:43  forms.book_visit.checks[1].on.not-owner.reason  a reason names the handoff line, and this outcome does not hand off  ->  delete "reason", or write "then: handoff"',
      'forms.yaml:19:17  forms.book_visit.checks[2].action  the check "checkOwner" is listed twice  ->  delete one of the two: a check runs once per change of what it reads',
      'forms.yaml:31:19  forms.urgent.checksPassed  the form has no checks, so checksPassed is never said  ->  delete "checksPassed", or add "checks:" to the form',
    ]);
  });

  it('defineApp refuses what check refuses', () => {
    const dir = folder({ 'forms.yaml': replace('with: [town]', 'with: [tow]') });
    expect(() => defineApp(dir, screenedCode)).toThrow(/check "checkArea" reads "tow", which is not one of form "book_visit"'s slots/);
  });

  it('validateApp, the backstop: a check that is not a check of the policy, or reads a slot the form does not have', () => {
    const form = screenedApp.forms.book_visit!;
    expect(() => validateApp({ ...screenedApp, forms: { ...screenedApp.forms, book_visit: { ...form, checks: [{ action: 'bookVisit', with: ['town'] }] } } })).toThrow(/checks "bookVisit", which is not a check of the policy/);
    expect(() => validateApp({ ...screenedApp, forms: { ...screenedApp.forms, book_visit: { ...form, checks: [{ action: 'checkArea', with: ['postcode'] }] } } })).toThrow(/reads "postcode", which is not one of its slots/);
  });
});

describe('the warnings', () => {
  it('a check above the level the form\'s entry proves, and a check on an identity factor: warned, never refused', async () => {
    const dir = proposalsFolder(CHECKING);
    const { problems, warnings } = await checked(dir, proposalsCode);
    expect(problems).toEqual([]);
    expect(warnings).toEqual([
      'forms.yaml:15:16  forms.report_problem.checks[1].with[0]  check "checkAge" reads "dob", an identity factor; it holds a value only once the caller has given it during verification, so the check does not run before then  ->  nothing to do if that is meant (an age check on a date of birth); otherwise check one of the form\'s own slots',
      'policy.yaml:36:12  actions.checkProblem.level  check "checkProblem" of form "report_problem" needs identity level 1, which the form\'s entry does not prove first; the caller will be asked to verify when the check runs  ->  nothing to do if that is meant; otherwise set it to 0, or give the form an entry call with a purpose of level 1 (policy.yaml purposes: report_problem: { level: 1 })',
    ]);
    // defineApp builds it, and validateApp takes a check that reads an identity factor the form does not list.
    expect(defineApp(dir, proposalsCode).forms.report_problem!.checks!.map((c) => c.with)).toEqual([['problem'], ['dob']]);
  });

  it('an `on` reason the check never refuses for, and a rule the write does not hold the caller to: printed, never counted', async () => {
    const dir = folder({
      'forms.yaml': replace('out-of-area: { say: decline_out_of_area, then: end }', 'out-of-town: { say: decline_out_of_area, then: end }'),
      'policy.yaml': replace('      - oneOf: { field: town, values: [millbrook, cedar_falls, ashford, riverton], reason: out-of-area }\n      - confirmed:', '      - confirmed:'),
    });
    const { problems, warnings } = await checked(dir);
    expect(problems).toEqual([]);
    expect(warnings).toEqual([
      'forms.yaml:22:11  forms.book_visit.checks[2].on.out-of-town  check "checkArea" never refuses for "out-of-town" (its rules refuse for "identity", "out-of-area", "value-missing"), so this outcome never applies  ->  give it as the reason of the rule that refuses (a list or range rule\'s `reason`), or delete it',
      'policy.yaml:26:9  actions.checkArea.rules[1]  check "checkArea" holds form "book_visit" to "oneOf: town", which no action the form calls (bookVisit) runs, so the write would not hold what the check held  ->  add "oneOf: town" to the rules of the action the form writes with, so the completion still refuses what the check refused',
    ]);
    // The command prints them and exits 0; under --json they go to stderr and the JSON is the problems.
    writeFileSync(join(dir, 'app.ts'), `export { code } from ${JSON.stringify(join(SCREENED_DIR, 'app.ts'))};\n`);
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = { out: (l) => out.push(l), err: (l) => err.push(l), cwd: PACKAGE_DIR };
    expect(await main(['check', dir], io)).toBe(0);
    expect(out.filter((l) => l.startsWith('warning: '))).toHaveLength(2);
    out.length = 0;
    expect(await main(['check', '--json', dir], io)).toBe(0);
    expect(JSON.parse(out.join('\n'))).toEqual([]);
    expect(err.filter((l) => l.startsWith('warning: '))).toHaveLength(2);
  });
});
