import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { identityTools, reachOf, unreachedActions } from '../core/app/reach';
import { AppDefinitionError, defineApp } from './defineApp';
import { libraryCode, LIBRARY_DIR } from './fixture/app';
import { formatProblem } from './problems';

/**
 * Which actions the forms reach (core/app/reach.ts, forms.yaml's `calls`), and what `check` and
 * defineApp say about it: a form says which actions its hooks call, or none does; each is a tool;
 * and an action no form lists and the identity flow does not call is one nothing can reach.
 */

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** The library's forms.yaml with each form's `calls` line added after its hooks. */
function withCalls(calls: Record<string, string | null>): string {
  let text = readFileSync(join(LIBRARY_DIR, 'forms.yaml'), 'utf8');
  for (const [form, list] of Object.entries(calls)) {
    if (list === null) continue;
    const at = text.indexOf(`  ${form}:`);
    const hooks = text.indexOf('    hooks:', at);
    const end = text.indexOf('\n', hooks);
    text = `${text.slice(0, end)}\n    calls: ${list}${text.slice(end)}`;
  }
  return text;
}

/** The problems defineApp finds in a copy of the library folder with this forms.yaml, one formatted line each. */
function problemsWith(forms: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'dialogwright-reach-'));
  scratch.push(dir);
  cpSync(LIBRARY_DIR, dir, { recursive: true, filter: (src) => !src.endsWith('.ts') });
  writeFileSync(join(dir, 'forms.yaml'), forms);
  try {
    defineApp(dir, libraryCode);
  } catch (error) {
    if (error instanceof AppDefinitionError) return error.problems.map(formatProblem);
    throw error;
  }
  return [];
}

describe('forms.yaml calls: the library folder', () => {
  const all = { renew_loan: '[renewLoan]', check_hold: '[findHold]', check_loans: '[listLoans]' };

  it('has no problem when every form says what it calls and every action is reached', () => {
    expect(problemsWith(withCalls(all))).toEqual([]);
  });

  it('has no problem when no form says: the app does not say where its calls are made', () => {
    expect(problemsWith(withCalls({}))).toEqual([]);
  });

  it('asks a form that leaves calls out to say, when another does', () => {
    const lines = problemsWith(withCalls({ ...all, check_hold: null }));
    expect(lines).toEqual([
      'forms.yaml:8:3  forms.check_hold  form "check_hold" does not say which actions it calls, though other forms do  ->  add "calls: [<the tools its hooks call>]" to it ("calls: []" for none): every form says, or none does',
      'policy.yaml:8:3  actions.findHold  action "findHold" is reached by no form: no form\'s calls list it, and the identity flow does not call it  ->  add "findHold" to the calls of the form whose hooks call it in forms.yaml, or delete the action from policy.yaml and the tool from app.ts (code.tools.findHold)',
    ]);
  });

  it('refuses a call to a tool the code does not define, with the near match', () => {
    const lines = problemsWith(withCalls({ ...all, check_loans: '[listLoan]' }));
    expect(lines[0]).toBe('forms.yaml:17:13  forms.check_loans.calls[0]  form "check_loans" calls "listLoan", which is not a tool in the code  ->  rename it to "listLoans", or add it to the app\'s tools in app.ts (code.tools.listLoan), or delete it from this list');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^policy\.yaml:\d+:3  actions\.listLoans  action "listLoans" is reached by no form/);
  });

  it('reports the action no form reaches, with where to add it', () => {
    const lines = problemsWith(withCalls({ ...all, check_loans: '[]' }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^policy\.yaml:\d+:3  actions\.listLoans  action "listLoans" is reached by no form: no form's calls list it, and the identity flow does not call it  ->  add "listLoans" to the calls of the form whose hooks call it in forms\.yaml/);
  });
});

describe('reachOf and unreachedActions', () => {
  const forms = { a: { calls: ['read', 'write'] }, b: { calls: [] }, c: {} };

  it('says whether any form declares its calls, which do not, and what the declared ones reach', () => {
    expect(reachOf(forms)).toEqual({ declared: true, undeclared: ['c'], reached: new Set(['read', 'write']) });
    expect(reachOf({ a: {}, b: {} })).toEqual({ declared: false, undeclared: [], reached: new Set() });
  });

  it('leaves the identity flow\'s tools out: it calls them, not a form', () => {
    const identity = { verifyTool: 'verify', codeTool: 'check', sendCodeTool: 'send' };
    expect(identityTools(identity)).toEqual(['verify', 'check', 'send']);
    expect(identityTools({ verifyTool: 'verify' } as typeof identity)).toEqual(['verify']);
    expect(identityTools(undefined)).toEqual([]);
    expect(unreachedActions(['verify', 'send', 'check', 'read', 'write', 'orphan'], forms, identity)).toEqual(['orphan']);
  });

  it('reports nothing for an app whose forms do not say: nothing is known', () => {
    expect(unreachedActions(['read', 'orphan'], { a: {}, b: {} }, undefined)).toEqual([]);
  });
});
