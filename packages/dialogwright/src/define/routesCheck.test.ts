import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { checkAppFully } from './check';
import { formatProblem } from './problems';
import { defineApp, type AppCode } from './defineApp';
import { CALLBACK_DIR, callbackCode } from '../testing/callback/app';
import { validateApp } from '../core/app/validate';
import type { App } from '../core/app/types';

/**
 * What `check` says of routes.yaml, app.yaml's hours and onStart (design 2026-10-09-routes, decision 10):
 * it refuses what names something the app does not have (a form, a slot, a call data key, a prompt, a
 * schedule, a predicate, a locale, a tool), a point that does not end with its else, a then its point
 * does not take, a condition that can never hold where it is (a reason in a route, a form at start, hours
 * the app does not have, the number called where the app does not keep it), and a start hook the YAML and
 * the code disagree on; it warns of what may be meant. Which routes, in what order, are the app's.
 */

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const HEADER = '# yaml-language-server: $schema=../../../schemas/routes.schema.json\n';

/** The callback fixture with this routes.yaml (and app.yaml changed as asked). */
function folder(routes: string | null, appYaml: (text: string) => string = (t) => t): string {
  const dir = mkdtempSync(join(tmpdir(), 'dialogwright-routes-'));
  scratch.push(dir);
  cpSync(CALLBACK_DIR, dir, { recursive: true, filter: (src) => !src.endsWith('.ts') });
  if (routes !== null) writeFileSync(join(dir, 'routes.yaml'), HEADER + routes);
  writeFileSync(join(dir, 'app.yaml'), appYaml(readFileSync(join(dir, 'app.yaml'), 'utf8')));
  return dir;
}

async function resultOf(routes: string | null, appYaml?: (text: string) => string, code: AppCode = callbackCode): Promise<{ problems: string[]; warnings: string[] }> {
  const r = await checkAppFully(folder(routes, appYaml), { code, fixturesRoot: PACKAGE_DIR });
  return { problems: r.problems.map(formatProblem), warnings: (r.warnings ?? []).map(formatProblem) };
}

const HOURS = `
hours:
  timezone: America/New_York
  weekly: { mon-fri: ["08:00-18:00"] }
  schedules:
    billing: { weekly: { mon-fri: ["09:00-17:00"] } }
`;

describe('a routes.yaml that is right', () => {
  const routes = `start:
  - when: { hours: closed }
    say: no_input
    then: end
  - when: [{ callData: queue, is: priority }, { named: vip }]
    then: handoff
    reason: live-agent
  - else: continue
afterForm:
  request_callback:
    - when: { slot: reason, is: order }
      say: ask_intent
      then: anything-else
    - else: { then: continue }
`;
  const code: AppCode = { ...callbackCode, predicates: { vip: () => true } };

  it('passes check, and builds App.routes: each when a list of conditions, the else last', async () => {
    expect(await resultOf(routes, (t) => t + HOURS, code)).toEqual({ problems: [], warnings: [] });
    const app = defineApp(folder(routes, (t) => t + HOURS), code);
    expect(app.routes).toEqual({
      start: [
        { when: [{ kind: 'hours', open: false }], outcome: { say: 'no_input', then: 'end' } },
        { when: [{ kind: 'callData', key: 'queue', test: { is: 'priority' } }, { kind: 'named', predicate: 'vip' }], outcome: { then: 'handoff', reason: 'live-agent' } },
        { when: [], outcome: { then: 'continue' }, else: true },
      ],
      afterForm: {
        request_callback: [
          { when: [{ kind: 'slot', key: 'reason', test: { is: 'order' } }], outcome: { say: 'ask_intent', then: 'anything-else' } },
          { when: [], outcome: { then: 'continue' }, else: true },
        ],
      },
    });
    expect(app.hours).toEqual({ timezone: 'America/New_York', weekly: { 'mon-fri': ['08:00-18:00'] }, schedules: { billing: { weekly: { 'mon-fri': ['09:00-17:00'] } } } });
    expect(app.predicates).toBe(code.predicates);
  });

  it('an app with no routes.yaml has no routes, and checks as it did', async () => {
    expect(defineApp(folder(null), callbackCode).routes).toBeUndefined();
    expect(await resultOf(null)).toEqual({ problems: [], warnings: [] });
  });
});

describe('the refusals', () => {
  it('a point without its else, an else before the end, a rule with no when', async () => {
    const { problems } = await resultOf(`start:
  - else: continue
  - when: { callData: queue, is: priority }
    then: continue
`);
    expect(problems).toEqual([
      expect.stringContaining('routes.yaml:3:5  start[0]  is the else, and 1 rule follows it, which is never taken  ->  move the else to the end'),
      expect.stringContaining('routes.yaml:4:5  start[1]  is the last rule, and the point ends with no else'),
    ]);
    // The schema's: a rule with no when that is not the else (the folder does not load, so nothing else is said).
    expect((await resultOf('afterIdentity:\n  - then: continue\n')).problems).toEqual([expect.stringContaining('routes.yaml:3:5  afterIdentity[0]  a rule names no when, and is not the else')]);
  });

  it('what a rule names that the app does not have', async () => {
    const { problems } = await resultOf(`start:
  - when: { callData: tier, is: gold }
    say: no_such_line
    then: form
    form: no_such_form
  - when: { hours: open }
    then: continue
  - when: { called: env.SPANISH_LINE }
    then: locale
    locale: es
  - when: { named: vip }
    then: continue
  - else: continue
afterForm:
  request_callback:
    - when: { slot: severity, is: danger }
      then: form
      form: request_callback
    - else: continue
  no_form:
    - else: continue
`);
    expect(problems.join('\n')).toContain('start[0].when.callData  callData key "tier" is not defined');
    expect(problems.join('\n')).toContain('start[0].say  prompt "no_such_line" is not in prompts.yaml');
    expect(problems.join('\n')).toContain('start[0].form  form "no_such_form" is not defined');
    expect(problems.join('\n')).toContain('start[1].when.hours  app.yaml has no hours, so this condition never holds');
    expect(problems.join('\n')).toContain('start[2].when.called  the app does not keep the number called, so this condition never holds  ->  add callerNumber: { use: hint, called: true } to app.yaml');
    expect(problems.join('\n')).toContain('start[2].locale  "es" is not a locale of this app');
    expect(problems.join('\n')).toContain('start[3].when.named  the code has no predicate "vip"');
    expect(problems.join('\n')).toContain('afterForm.request_callback[0].when.slot  slot "severity" is not defined');
    expect(problems.join('\n')).toContain('afterForm.request_callback[0].form  a route after "request_callback" enters "request_callback" again');
    expect(problems.join('\n')).toContain('afterForm.no_form  form "no_form" is not defined');
  });

  it('a then its point does not take, and conditions that never hold where they are', async () => {
    const { problems } = await resultOf(`start:
  - when: { reason: live-agent }
    say: no_input
    then: anything-else
  - when: { form: request_callback }
    then: continue
  - else: { say: no_input, then: anything-else }
`);
    expect(problems.join('\n')).toContain('start[0].when.reason  a reason condition holds only where a handoff is being chosen');
    expect(problems.join('\n')).toContain('start[0].then  then: anything-else is not taken at start');
    expect(problems.join('\n')).toContain('start[1].when.form  a form condition never holds at start');
    expect(problems.join('\n')).toContain('start[2].else.then  then: anything-else is not taken at start');
  });

  it('a schedule that is not one of the hours\'', async () => {
    const { problems } = await resultOf(`start:
  - when: { hours: closed, schedule: night }
    say: no_input
    then: end
  - else: continue
`, (t) => t + HOURS);
    expect(problems.join('\n')).toContain('start[0].when.schedule  schedule "night" is not one of app.yaml\'s hours.schedules  ->  name one of billing');
  });

  it('the schema\'s own: what each then needs, and the else holding its outcome', async () => {
    const { problems } = await resultOf(`start:
  - when: { hours: closed }
    then: end
  - when: { hours: closed }
    then: locale
  - when: { hours: open }
    then: continue
    reason: x
  - else: continue
    say: no_input
`, (t) => t + HOURS);
    expect(problems.join('\n')).toContain('start[0]  then: end says a line first, and this route names none');
    expect(problems.join('\n')).toContain('start[1]  then: locale switches the language, and this route names none');
    expect(problems.join('\n')).toContain('start[2].reason  a reason names the handoff line, and this route does not hand off');
    expect(problems.join('\n')).toContain('start[3].say  the else holds its outcome itself, and "say" is beside it');
  });

  it('a start hook the YAML and the code disagree on, and a call it makes that is no tool', async () => {
    const yamlOnly = await resultOf(null, (t) => `${t}\nonStart: { calls: [requestCallback, lookupStatus] }\n`);
    expect(yamlOnly.problems.join('\n')).toContain('app.yaml has onStart, and the code has no start hook');
    expect(yamlOnly.problems.join('\n')).toContain('onStart.calls[1]  onStart calls "lookupStatus", which is not a tool in the code');
    const codeOnly = await resultOf(null, undefined, { ...callbackCode, onStart: () => {} });
    expect(codeOnly.problems.join('\n')).toContain('the code has a start hook, and app.yaml has no onStart');
    expect((await resultOf(null, (t) => `${t}\nonStart: {}\n`, { ...callbackCode, onStart: () => {} })).problems).toEqual([]);
  });

  it('the hours themselves, at their lines', async () => {
    const { problems } = await resultOf(null, (t) => `${t}\nhours:\n  timezone: Mars/Olympus\n  weekly: { weekdays: ["08:00-18:00"] }\n`);
    expect(problems.join('\n')).toContain('hours.timezone  "Mars/Olympus" is not a time zone this platform knows');
    expect(problems.join('\n')).toContain('hours.weekly.weekdays  "weekdays" is not a day or a range of days');
  });
});

describe('validateApp: the same refusals for an app built in code', () => {
  const base = (): App => defineApp(folder(null), callbackCode);
  it('a missing else, an unknown form, a then the point does not take', () => {
    const app = base();
    expect(() => validateApp({ ...app, routes: { start: [{ when: [{ kind: 'hours', open: false }], outcome: { then: 'continue' } }] } })).toThrow('routes: is the last rule, and the point ends with no else (routes.start.0)');
    expect(() => validateApp({ ...app, routes: { start: [{ when: [], outcome: { then: 'form', form: 'nowhere' }, else: true }] } })).toThrow('routes: form "nowhere" is not defined (routes.start.0.form)');
    expect(() => validateApp({ ...app, routes: { start: [{ when: [], outcome: { then: 'anything-else', say: 'no_input' }, else: true }] } })).toThrow('then: anything-else is not taken at start');
    expect(() => validateApp({ ...app, routes: { start: [{ when: [{ kind: 'weather' } as never], outcome: { then: 'continue' } }, { when: [], outcome: { then: 'continue' }, else: true }] } })).toThrow('has kind "weather"');
    expect(() => validateApp({ ...app, predicates: { vip: 'yes' as never } })).toThrow('predicate "vip" is not a function');
    expect(() => validateApp({ ...app, hours: { timezone: 'Nowhere', weekly: {} } })).toThrow('hours: "Nowhere" is not a time zone');
    expect(() => validateApp({ ...app, routes: { start: [{ when: [], outcome: { then: 'continue' }, else: true }] } })).not.toThrow();
  });
});

describe('the routed fixture (src/testing/routed)', () => {
  it('passes check with nothing to warn of', async () => {
    const { ROUTED_DIR, routedCode } = await import('../testing/routed/app');
    expect(await checkAppFully(ROUTED_DIR, { code: routedCode, fixturesRoot: PACKAGE_DIR })).toEqual({ problems: [], codeChecked: true });
  });

  it('warns of a route into a form needing a level the point cannot have reached, and of a fact the facts do not start with', async () => {
    const { ROUTED_DIR, routedCode } = await import('../testing/routed/app');
    const dir = mkdtempSync(join(tmpdir(), 'dialogwright-routes-'));
    scratch.push(dir);
    cpSync(ROUTED_DIR, dir, { recursive: true, filter: (src) => !src.endsWith('.ts') });
    const routes = readFileSync(join(dir, 'routes.yaml'), 'utf8')
      .replace('  - when: { named: vip }\n    then: handoff\n    reason: vip\n', '  - when: { named: vip }\n    then: form\n    form: check_status\n')
      .replace('{ fact: outage, is: true }', '{ fact: notice.outage, is: true }');
    writeFileSync(join(dir, 'routes.yaml'), routes);
    // A start route into a form says the welcome first (greeting_offer), in every locale.
    for (const file of ['prompts.yaml', 'locale/es/prompts.yaml']) writeFileSync(join(dir, file), `${readFileSync(join(dir, file), 'utf8')}  greeting_offer:\n    text: Thanks for calling.\n    interruptible: false\n`);
    const r = await checkAppFully(dir, { code: routedCode, fixturesRoot: PACKAGE_DIR });
    expect(r.problems.map(formatProblem)).toEqual([]);
    expect((r.warnings ?? []).map(formatProblem)).toEqual([
      expect.stringContaining('routes.yaml:13:11  start[1].form  the route enters "check_status", which needs identity level 1, and at start the caller is at level 0: the form will ask for it first'),
      expect.stringContaining('start[2].when.fact  the facts\' initial value has no "notice", so this fact is set only if the app\'s code adds it'),
    ]);
  });
});
