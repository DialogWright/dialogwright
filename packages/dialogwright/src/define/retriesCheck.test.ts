import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { checkAppFully } from './check';
import { formatProblem } from './problems';
import type { AppCode } from './defineApp';
import { SCREENED_DIR, screenedApp, screenedCode } from '../testing/screened/app';
import { PROPOSALS_DIR, proposalsApp, proposalsCode } from '../testing/proposals/app';
import { validateApp } from '../core/app/validate';
import { moveCycles } from '../core/app/next';
import type { App } from '../core/app/types';
import type { SlotSpec } from '../core/slots/types';

/**
 * What `check` and validateApp say of a slot's retries (design 2026-10-09-per-slot-retries, decision
 * 6): refusals of a broken app only (an outcome that enters a form there is not, or the slot's own; a
 * line it says that prompts.yaml lacks; skip on an identity factor or a slot its summary names), and
 * warnings of what is likely a mistake (a check that reads a slot that may be skipped; a numbered line
 * the ladder never reaches).
 */

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function folder(files: Record<string, (text: string) => string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'dialogwright-retries-check-'));
  scratch.push(dir);
  cpSync(SCREENED_DIR, dir, { recursive: true, filter: (src) => !src.endsWith('.ts') });
  for (const [file, change] of Object.entries(files)) writeFileSync(join(dir, file), change(readFileSync(join(dir, file), 'utf8')));
  return dir;
}

async function checked(files: Record<string, (text: string) => string>, code: AppCode = screenedCode): Promise<{ problems: string[]; warnings: string[] }> {
  const r = await checkAppFully(folder(files), { code, fixturesRoot: PACKAGE_DIR });
  return { problems: r.problems.map(formatProblem), warnings: (r.warnings ?? []).map(formatProblem) };
}

const replace = (from: string, to: string) => (text: string): string => {
  if (!text.includes(from)) throw new Error(`not in the file: ${from}`);
  return text.replace(from, to);
};
/** slots.yaml with `lines` added under the slot `slot` (after its `type:` line). */
const onSlot = (slot: string, lines: string) => replace(`${slot}:\n  type: choice\n`, `${slot}:\n  type: choice\n${lines}`);
const addPrompts = (lines: Record<string, string>) => (t: string): string => `${t}${Object.entries(lines).map(([id, text]) => `  ${id}:\n    text: ${text}\n    interruptible: true\n`).join('')}`;

describe('check passes what is well made', () => {
  it('attempts, a skip on a slot no summary names, a form there is, a handoff with its line', async () => {
    expect(await checked({
      'slots.yaml': (t) => onSlot('howUrgent', '  attempts: 4\n')(onSlot('ownership', '  onMaxAttempts: { then: handoff, reason: owner-unclear }\n')(onSlot('problem', '  onMaxAttempts: { say: problem_unclear, then: form, form: urgent }\n')(t))),
      'prompts.yaml': addPrompts({ problem_unclear: 'Sorry, I could not make out the problem.', handoff_owner_unclear: 'Let me get someone to help.' }),
    })).toEqual({ problems: [], warnings: [] });
  });
});

describe('check refuses a broken outcome', () => {
  it('a form that is not in forms.yaml, with the closest offered', async () => {
    const { problems } = await checked({ 'slots.yaml': onSlot('problem', '  onMaxAttempts: { then: form, form: urgnt }\n') });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('problem.onMaxAttempts.form');
    expect(problems[0]).toContain('the slot "problem" goes, when it runs out of attempts, to "urgnt", which is not a form in forms.yaml');
    expect(problems[0]).toContain('"urgent"');
  });

  it('a form that asks the slot itself', async () => {
    const { problems } = await checked({ 'slots.yaml': onSlot('problem', '  onMaxAttempts: { then: form, form: book_visit }\n') });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('to the form "book_visit", which asks it too');
  });

  it('a say that prompts.yaml lacks, and a handoff reason whose line it lacks', async () => {
    const { problems } = await checked({ 'slots.yaml': onSlot('ownership', '  onMaxAttempts: { say: owner_unclear, then: handoff, reason: owner-unclear }\n') });
    expect(problems.map((p) => p.split('  ')[1]).sort()).toEqual(['ownership.onMaxAttempts.reason', 'ownership.onMaxAttempts.say']);
    expect(problems.join('\n')).toContain('prompt "handoff_owner_unclear" is not in prompts.yaml');
    expect(problems.join('\n')).toContain('prompt "owner_unclear" is not in prompts.yaml');
  });

  it('end and anything-else with no say, and a reason without handoff (the schema)', async () => {
    const end = await checked({ 'slots.yaml': onSlot('ownership', '  onMaxAttempts: { then: end }\n') });
    expect(end.problems.join('\n')).toContain('then: end says a line first, and this outcome names none');
    const reason = await checked({ 'slots.yaml': onSlot('ownership', '  onMaxAttempts: { then: skip, reason: x }\n') });
    expect(reason.problems.join('\n')).toContain('a reason names the handoff line, and this outcome does not hand off');
  });

  it('skip on a slot its form\'s summary names', async () => {
    const { problems } = await checked({ 'slots.yaml': onSlot('problem', '  onMaxAttempts: skip\n') });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('the summary of the form "book_visit" names {problem}, but the slot may be left empty (its onMaxAttempts skips it)');
  });

  it('a code slot\'s attempts and onMaxAttempts out of shape', async () => {
    const problem: SlotSpec = { ...(screenedApp.slots.problem as SlotSpec), attempts: 0, onMaxAttempts: 'end' as never };
    const code: AppCode = { ...screenedCode, slots: { problem } };
    const asCode = (t: string): string => t.slice(0, t.indexOf('problem:\n')) + 'problem:\n  type: code\n' + t.slice(t.indexOf('ownership:\n'));
    const { problems } = await checked({ 'slots.yaml': asCode }, code);
    expect(problems).toHaveLength(2);
    expect(problems.join('\n')).toContain('the slot "problem" says attempts: 0, which must be at least 1');
    expect(problems.join('\n')).toContain('the slot "problem" says onMaxAttempts: "end": "end" is written out, with what it needs (the line said)');
  });

  it('a code slot\'s lines, in every locale the engine asks them of', async () => {
    const problem: SlotSpec = { ...(screenedApp.slots.problem as SlotSpec), onMaxAttempts: { say: 'problem_unclear', then: 'handoff', reason: 'problem-unclear' } };
    const code: AppCode = { ...screenedCode, slots: { problem } };
    const asCode = (t: string): string => t.slice(0, t.indexOf('problem:\n')) + 'problem:\n  type: code\n' + t.slice(t.indexOf('ownership:\n'));
    const { problems } = await checked({ 'slots.yaml': asCode }, code);
    expect(problems.join('\n')).toContain('prompt "problem_unclear" is missing from prompts.yaml; the engine says it when the slot "problem" runs out of attempts');
    expect(problems.join('\n')).toContain('prompt "handoff_problem_unclear" is missing from prompts.yaml');
  });

  it('skip on an identity factor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dialogwright-retries-check-'));
    scratch.push(dir);
    cpSync(PROPOSALS_DIR, dir, { recursive: true, filter: (src) => !src.endsWith('.ts') });
    writeFileSync(join(dir, 'slots.yaml'), replace('dob:\n  type: birthdate\n', 'dob:\n  type: birthdate\n  onMaxAttempts: skip\n')(readFileSync(join(dir, 'slots.yaml'), 'utf8')));
    const problems = (await checkAppFully(dir, { code: proposalsCode, fixturesRoot: PACKAGE_DIR })).problems.map(formatProblem);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('the slot "dob" is an identity factor (identity.yaml), but it is skipped when it runs out of attempts, so verification could never finish');
  });

  it('a check\'s outcome to a form there is not, or to its own', async () => {
    const unknown = await checked({ 'forms.yaml': replace('out-of-area: { say: decline_out_of_area, then: end }', 'out-of-area: { say: decline_out_of_area, then: form, form: elsewhere }') });
    expect(unknown.problems).toHaveLength(1);
    expect(unknown.problems[0]).toContain('check "checkArea" goes for "out-of-area" to "elsewhere", which is not a form in forms.yaml');
    const own = await checked({ 'forms.yaml': replace('out-of-area: { say: decline_out_of_area, then: end }', 'out-of-area: { say: decline_out_of_area, then: form, form: book_visit }') });
    expect(own.problems).toHaveLength(1);
    expect(own.problems[0]).toContain('to its own form "book_visit"');
  });
});

describe('check warns, never refuses', () => {
  it('a check that reads a slot that may be skipped', async () => {
    const r = await checked({ 'slots.yaml': onSlot('ownership', '  onMaxAttempts: skip\n') });
    expect(r.problems).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('check "checkOwner" reads "ownership", which may be left empty (its onMaxAttempts skips it)');
  });

  it('a numbered line the slot\'s ladder never reaches', async () => {
    const reached = await checked({ 'slots.yaml': onSlot('town', '  attempts: 4\n'), 'prompts.yaml': addPrompts({ ask_town_retry2: 'Two.', ask_town_noinput3: 'Three.' }) });
    expect(reached).toEqual({ problems: [], warnings: [] });
    const r = await checked({ 'prompts.yaml': addPrompts({ ask_town_retry2: 'Two.', ask_town_retry3: 'Three.', ask_town_noinput0: 'Zero.' }) });
    expect(r.problems).toEqual([]);
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings.join('\n')).toContain('the line "ask_town_retry3" is said at the slot "town"\'s failure 3, which its ladder never reaches: it re-asks at failures 1 to 2 (attempts: 3)');
    expect(r.warnings.join('\n')).toContain('"ask_town_noinput0"');
  });
});

describe('check warns of forms that send each other round in a loop', () => {
  it('through a check\'s outcome and a next, beside next alone (which nextCycles refuses)', async () => {
    const r = await checked({
      'forms.yaml': (t) => `${replace('out-of-area: { say: decline_out_of_area, then: end }', 'out-of-area: { say: decline_out_of_area, then: form, form: recheck }')(t)}  recheck:\n    internal: true\n    label: check the town again\n    slots: [town]\n    summaryPromptId: null\n    calls: []\n    next: book_visit\n`,
    });
    expect(r.problems).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('forms.book_visit  the forms go round in a loop by their outcomes (then: form) and next: book_visit -> recheck -> book_visit');
  });

  it('moveCycles finds each loop once, and only one that goes by an outcome', () => {
    const forms = {
      a: { slots: ['x'], next: 'b' },
      b: { slots: [], checks: [{ on: { no: { then: 'form', form: 'a' } } }] },
      c: { slots: ['y'], next: 'd' },
      d: { slots: [] },
      e: { slots: [] },
    };
    const y = { y: { then: 'form', form: 'e' } };
    expect(moveCycles(forms, y)).toEqual([['a', 'b']]);
    expect(moveCycles({ ...forms, e: { slots: [], next: 'c' } }, y)).toEqual([['a', 'b'], ['c', 'e']]);
    expect(moveCycles({ a: { slots: [], next: 'b' }, b: { slots: [], next: 'a' } }, {})).toEqual([]);
  });

});

describe('validateApp', () => {
  /** The fixture with its problem slot changed (its town already goes to the office's call). */
  const withProblem = (slot: Partial<SlotSpec>): App => ({ ...screenedApp, id: 'retries-validate', slots: { ...screenedApp.slots, problem: { ...(screenedApp.slots.problem as SlotSpec), ...slot } } });

  it('passes an app with retries well made', () => {
    expect(() => validateApp(withProblem({ attempts: 4, onMaxAttempts: { then: 'form', form: 'urgent' } }))).not.toThrow();
    expect(() => validateApp(withProblem({ onMaxAttempts: 'skip' }))).not.toThrow();
  });

  it('refuses attempts out of range, an outcome of no known shape, and one to a form there is not or that asks the slot', () => {
    expect(() => validateApp(withProblem({ attempts: 0 }))).toThrow('slot "problem" says attempts: 0, which is not a whole number from 1 to 10');
    expect(() => validateApp(withProblem({ attempts: 11 }))).toThrow('not a whole number from 1 to 10');
    expect(() => validateApp(withProblem({ onMaxAttempts: 'end' as never }))).toThrow('slot "problem" says onMaxAttempts: "end"');
    expect(() => validateApp(withProblem({ onMaxAttempts: { then: 'end' } }))).toThrow('slot "problem" ends with end when it runs out of attempts and says no line');
    expect(() => validateApp(withProblem({ onMaxAttempts: { then: 'form', form: 'nowhere' } }))).toThrow('to the unknown form "nowhere"');
    expect(() => validateApp(withProblem({ onMaxAttempts: { then: 'form', form: 'book_visit' } }))).toThrow('to the form "book_visit", which asks it too');
    expect(() => validateApp(withProblem({ onMaxAttempts: { then: 'skip', reason: 'x' } as never }))).toThrow('names a handoff reason for an outcome that does not hand off');
  });

  it('refuses a check\'s outcome to a form there is not, or its own', () => {
    const checks = (form: string) => screenedApp.forms.book_visit!.checks!.map((c) => (c.action === 'checkArea' ? { ...c, on: { 'out-of-area': { then: 'form' as const, form } } } : c));
    const app = (form: string): App => ({ ...screenedApp, id: 'retries-validate-check', forms: { ...screenedApp.forms, book_visit: { ...screenedApp.forms.book_visit!, checks: checks(form) } } });
    expect(() => validateApp(app('urgent'))).not.toThrow();
    expect(() => validateApp(app('nowhere'))).toThrow('to the unknown form "nowhere"');
    expect(() => validateApp(app('book_visit'))).toThrow('to its own form');
  });

  it('an internal form an outcome enters is reached', () => {
    const forms = { ...screenedApp.forms, front_desk: { slots: ['visitDay'], summaryPromptId: null, internal: true, label: 'talk to the desk', complete: () => ({ kind: 'said' as const, acks: [] }) } };
    const app = (slot: Partial<SlotSpec>): App => ({ ...withProblem(slot), forms });
    expect(() => validateApp(app({}))).toThrow('internal form "front_desk" is reached by no form\'s next, and no outcome or route enters it');
    expect(() => validateApp(app({ onMaxAttempts: { then: 'form', form: 'front_desk' } }))).not.toThrow();
  });

  it('refuses skip on an identity factor', () => {
    const app: App = { ...proposalsApp, id: 'retries-validate-factor', slots: { ...proposalsApp.slots, dob: { ...(proposalsApp.slots.dob as SlotSpec), onMaxAttempts: 'skip' } } };
    expect(() => validateApp(app)).toThrow('slot "dob" is an identity factor, which may not be skipped');
  });
});
