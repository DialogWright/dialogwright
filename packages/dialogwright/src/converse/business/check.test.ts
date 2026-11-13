import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { checkAppFully } from '../../define/check';
import { formatProblem } from '../../define/problems';
import { CALLBACK_DIR, callbackCode } from '../../testing/callback/app';
import { ACCOUNT_JOURNEYS_YAML, JOURNEYS_YAML, LEAVE_NOTE_ACTION } from '../../testing/converse/journeys';
import { agentBusinessProblems } from './load';
import { ROUTING_DEFAULTS } from './schema';

/**
 * `pnpm check` and agent.yaml: a converse app's folder (app.yaml's mode: converse) has its agent.yaml
 * validated with its app.yaml; a scripted app's folder with none is unchanged (one with an agent.yaml is
 * refused: define/converseCheck.test.ts).
 */

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixture', 'agent.yaml');
const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

async function problemsOf(agent: string | null): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), 'dialogwright-agent-'));
  scratch.push(dir);
  if (agent === null) {
    cpSync(CALLBACK_DIR, dir, { recursive: true, filter: (src) => !src.endsWith('.ts') });
    return (await checkAppFully(dir, { code: callbackCode, fixturesRoot: PACKAGE_DIR })).problems.map(formatProblem);
  }
  writeFileSync(join(dir, 'app.yaml'), '# yaml-language-server: $schema=../schemas/app.schema.json\nid: example\nmode: converse\n');
  writeFileSync(join(dir, 'agent.yaml'), agent);
  return (await checkAppFully(dir)).problems.map(formatProblem);
}

describe('pnpm check and agent.yaml', () => {
  const text = readFileSync(FIXTURE, 'utf8');

  it('an app with no agent.yaml is unchanged', async () => {
    expect(await problemsOf(null)).toEqual([]);
  });

  it('a valid agent.yaml adds no problem', async () => {
    expect(await problemsOf(text)).toEqual([]);
  });

  it('a file without the schema line is refused, with the line to write', async () => {
    const out = await problemsOf(text.split('\n').slice(1).join('\n'));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^agent\.yaml:1:1  \(file\)  agent\.yaml does not start with the schema line .*->  make the first line "# yaml-language-server: \$schema=.*agent\.schema\.json"/);
  });

  it('a mistake is printed at its line with a path and a fix', async () => {
    const out = await problemsOf(text.replace('then: [notify]', 'then: [nothing]'));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^agent\.yaml:\d+:\d+  actions\.book\.then\[0\]  "nothing" is no action .*->  /);
  });
});

describe('journeys', () => {
  const base = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'testing', 'converse', 'agent.yaml'), 'utf8');
  const withJourneys = base + LEAVE_NOTE_ACTION + JOURNEYS_YAML;
  const changed = (from: string, to: string, source: string = withJourneys): string => {
    expect(source).toContain(from);
    return source.replace(from, to);
  };
  const problemsOf = (t: string) => agentBusinessProblems(t).problems;
  const only = (t: string) => {
    const out = problemsOf(t);
    expect(out).toHaveLength(1);
    return out[0]!;
  };

  it('the fixture with journeys is valid, with and without accounts', () => {
    expect(problemsOf(withJourneys)).toEqual([]);
    expect(problemsOf(base + LEAVE_NOTE_ACTION + ACCOUNT_JOURNEYS_YAML)).toEqual([]);
  });

  it('a journey names an action that does not exist', () => {
    const p = only(changed('actions: [availability, book]', 'actions: [book, nothing]'));
    expect(p.path).toBe('journeys.visit.actions[1]');
    expect(p.fix).toMatch(/name one of the actions/);
  });

  it('the root names a change action', () => {
    const p = only(changed('root:\n', 'root:\n  actions: [book]\n'));
    expect(p.path).toBe('root.actions[0]');
    expect(p.fix).toMatch(/lookups only/);
  });

  it('a journey names a follow-on', () => {
    const t = changed('    audit: { name: length, phone: last4 }\n  leave_note:', '    then: [leave_note]\n    audit: { name: length, phone: last4 }\n  leave_note:')
      .replace('actions: [leave_note]', 'actions: [availability, book, leave_note]');
    const out = problemsOf(t).filter((x) => x.path.startsWith('journeys'));
    // the follow-on leave_note is named by the note journey at index 2
    expect(out.map((x) => x.path)).toEqual(['journeys.note.actions[2]']);
    expect(out[0]!.fix).toMatch(/follow-on/);
  });

  it('a change action no journey names', () => {
    const p = only(changed('    actions: [leave_note]\n', '    actions: []\n'));
    expect(p.path).toBe('actions.leave_note');
    expect(p.fix).toMatch(/add "leave_note" to a journey/);
  });

  it('startAt below switchAt is refused; at it, or alone with no journeys, is not', () => {
    const p = only(withJourneys + 'routing:\n  switchAt: 0.7\n  startAt: 0.6\n');
    expect(p.path).toBe('routing.startAt');
    expect(p.fix).toMatch(/raise startAt/);
    expect(problemsOf(withJourneys + 'routing:\n  switchAt: 0.7\n  startAt: 0.7\n')).toEqual([]);
    expect(problemsOf(base + 'routing:\n  switchAt: 0.9\n')).toEqual([]);
  });

  it('a journey greeting needs a start', () => {
    const t = base + LEAVE_NOTE_ACTION + ACCOUNT_JOURNEYS_YAML;
    expect(problemsOf(changed('    start: { account: recognised }\n', '    start: { account: recognised }\n    greeting: { en: "Welcome back." }\n', t))).toEqual([]);
    const p = only(changed('    for: { account: none }\n', '    for: { account: none }\n    greeting: { en: "Hello." }\n', t));
    expect(p.path).toBe('journeys.visit.greeting');
    expect(p.fix).toMatch(/add start/);
  });

  it('journeys need lines.unclear; without journeys it is optional, and business.line is optional text', () => {
    const p = only(changed(/^ {2}unclear:.*\n/m.exec(withJourneys)![0], '', withJourneys));
    expect(p.path).toBe('lines.unclear');
    expect(p.fix).toMatch(/lines\.unclear/);
    expect(problemsOf(base.replace(/^ {2}unclear:.*\n/m, '') + LEAVE_NOTE_ACTION)).toEqual([]);
    expect(problemsOf(changed('  name: ', '  line: This line is how we book.\n  name: ', withJourneys))).toEqual([]);
  });

  it('an unnamed change is no problem where there are no journeys', () => {
    expect(problemsOf(base + LEAVE_NOTE_ACTION)).toEqual([]);
  });

  it('completes names an action the journey does not list, or a lookup', () => {
    const notListed = only(changed('    actions: [availability, book]\n', '    completes: [leave_note]\n    actions: [availability, book]\n'));
    expect(notListed.path).toBe('journeys.visit.completes[0]');
    expect(notListed.fix).toMatch(/name one of its actions/);
    const lookup = only(changed('    actions: [availability, book]\n', '    completes: [availability]\n    actions: [availability, book]\n'));
    expect(lookup.path).toBe('journeys.visit.completes[0]');
    expect(lookup.fix).toMatch(/change action/);
  });

  it('two journeys say start', () => {
    const t = base + LEAVE_NOTE_ACTION + ACCOUNT_JOURNEYS_YAML;
    expect(problemsOf(t)).toEqual([]);
    const p = only(changed('    when: The caller wants to speak with someone, or wants a call back.\n', '    start: { account: recognised }\n    when: The caller wants to speak with someone, or wants a call back.\n', t));
    expect(p.path).toBe('journeys.note.start');
    expect(p.fix).toMatch(/keep "start" on one journey/);
  });

  it('start where for says account: none', () => {
    const t = base + LEAVE_NOTE_ACTION + ACCOUNT_JOURNEYS_YAML;
    const p = only(changed('    for: { account: none }\n', '    for: { account: none }\n    start: { account: recognised }\n', t).replace('    start: { account: recognised }\n    goal: Book the account', '    goal: Book the account'));
    expect(p.path).toBe('journeys.visit.start');
    expect(p.fix).toMatch(/account: recognised/);
  });

  it('an app without journeys gets no journey problems and its value has no journeys key, with routing defaults', () => {
    const r = agentBusinessProblems(base);
    expect(r.problems).toEqual([]);
    expect(r.value).not.toHaveProperty('journeys');
    expect(r.value).not.toHaveProperty('root');
    expect(r.value!.routing).toEqual({ switchAt: 0.6, startAt: 0.7, timeoutMs: 400 });
    expect(ROUTING_DEFAULTS).toEqual({ switchAt: 0.6, startAt: 0.7, timeoutMs: 400 });
  });

  it('a journey with an empty when or goal is refused', () => {
    expect(problemsOf(changed('when: The caller wants a visit booked, or wants to know about one.', 'when: ""')).map((x) => x.path)).toEqual(['journeys.visit.when']);
    expect(problemsOf(changed('goal: Leave a note asking for a call back, read back and confirmed by the caller.', 'goal: ""')).map((x) => x.path)).toEqual(['journeys.note.goal']);
  });
});

describe('opening hours', () => {
  const base = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'testing', 'converse', 'agent.yaml'), 'utf8');
  const withOpen = (open: string) => base.replace('business:\n', `business:\n  open:\n${open}`);
  const problemsOf = (t: string) => agentBusinessProblems(t).problems;
  it('a good schedule is valid, and the value carries it', () => {
    const r = agentBusinessProblems(withOpen('    weekly: { mon-fri: ["08:00-17:00"] }\n    closed: [2026-12-25]\n'));
    expect(r.problems).toEqual([]);
    expect(r.value!.business.open).toEqual({ weekly: { 'mon-fri': ['08:00-17:00'] }, closed: ['2026-12-25'] });
  });
  it('a bad day, range or date is refused at its path', () => {
    const out = problemsOf(withOpen('    weekly: { monday: ["8-5"], tue: ["09:00-09:00"] }\n    closed: [2026-13-01]\n'));
    expect(out.map((p) => p.path)).toEqual(['business.open.weekly.monday', 'business.open.weekly.monday[0]', 'business.open.weekly.tue[0]', 'business.open.closed[0]']);
  });
  it('greetingAfterHours needs business.open', () => {
    const line = '  greetingAfterHours: { en: "We are closed." }\n';
    const without = base.replace('lines:\n', `lines:\n${line}`);
    const p = problemsOf(without);
    expect(p).toHaveLength(1);
    expect(p[0]!.path).toBe('lines.greetingAfterHours');
    expect(p[0]!.fix).toMatch(/business\.open/);
    expect(problemsOf(withOpen('    weekly: { mon: ["08:00-17:00"] }\n').replace('lines:\n', `lines:\n${line}`))).toEqual([]);
  });
});
