import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { runScenario, type Scenario, type ScenarioRun } from '../harness-text/runner';
import { loadCorpus } from '../jev/corpus';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { spokenText } from '../prompts/render';
import { registerApp, resetAppsForTest } from './app/registry';
import type { App } from './app/types';
import { DEFAULT_THRESHOLDS } from './thresholds';
import type { TurnResult } from './turn';
import { mockCodeVerifier } from './tools';
import { validateApp } from './app/validate';
import { appMapText } from '../testing/appMap';
import { checkAppFully } from '../define/check';
import { formatProblem } from '../define/problems';
import { recognizedCode } from '../testing/recognized/app';
import { GREETING, recognizedVariants, replace } from '../testing/recognized/variant';

/**
 * Per-slot retries on an identity factor (design 2026-10-09-per-slot-retries, review fixes): a factor
 * that runs out, asked at the greeting or during a form's step-up, and a form an outcome enters that
 * needs identity. On the recognized fixture (an account number and a date of birth, a caller-ID match).
 */

const TODAY = '2026-10-08';
const AVERY = '+15555550142';
const STATUS = 'I want to check on my request';
const REPORT = "I'd like to report a problem";

const variants = recognizedVariants();
afterAll(() => variants.remove());

const LINES = '  dob_unclear:\n    text: No matter, we can do without it for now.\n    interruptible: false\n';
/** The fixture (or its greeting variant) with the date of birth's retries `slot` added under its type. */
function variant(id: string, slot: string, greeting = false, more: Record<string, (t: string) => string> = {}): App {
  const files: Record<string, (t: string) => string> = {
    'app.yaml': replace('id: recognized', `id: ${id}`),
    'slots.yaml': replace('dob:\n  type: birthdate\n', `dob:\n  type: birthdate\n${slot}`),
    'prompts.yaml': (t) => `${t}${LINES}`,
  };
  if (greeting) {
    files['identity.yaml'] = GREETING['identity.yaml']!;
    files['prompts.yaml'] = (t) => GREETING['prompts.yaml']!(`${t}${LINES}`);
    files['fixtures/corpus.jsonl'] = GREETING['fixtures/corpus.jsonl']!;
  }
  for (const [file, change] of Object.entries(more)) {
    const first = files[file];
    files[file] = first === undefined ? change : (t) => change(first(t));
  }
  return variants.variant(files, recognizedCode);
}

let current: App;
function use(app: App): void {
  resetAppsForTest();
  registerApp(app);
  current = app;
}

async function call(app: App, callerNumber: string | undefined, ...steps: Scenario['steps']): Promise<ScenarioRun> {
  use(app);
  const lines = loadCorpus(join(variants.dirOf(app), 'fixtures', 'corpus.jsonl'), app);
  const client = new FixtureStubClient(lines, { sharpness: DEFAULT_THRESHOLDS.STUB_SHARPNESS, fallback: new HeuristicStubClient({ todayIso: TODAY }) });
  const scenario: Scenario = { id: 'call', steps, expect: { decision: 'any' }, ...(callerNumber !== undefined ? { callerNumber } : {}) };
  return runScenario(scenario, { client, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, now: () => 0, tools: { ...app.systems(), codes: mockCodeVerifier } });
}
const promptOf = (t: TurnResult): string | undefined => ('promptId' in t.decision ? t.decision.promptId : undefined);
const prompts = (r: ScenarioRun): (string | undefined)[] => r.runs.map((x) => promptOf(x.result));
const last = (r: ScenarioRun): TurnResult => r.runs.at(-1)!.result;
const SILENCE = { silence: true as const };

describe('an identity factor that runs out', () => {
  beforeEach(() => resetAppsForTest());

  it('at the greeting, with anything-else: identity is set aside and the open question follows, not "anything else?"', async () => {
    const app = variant('rg-dob-greeting', '  attempts: 1\n  onMaxAttempts: { say: dob_unclear, then: anything-else }\n', true);
    const r = await call(app, AVERY, SILENCE);
    expect(prompts(r)).toEqual(['identity_caller_match', 'greet_after_offer']);
    const t = last(r);
    expect(t.decision).toMatchObject({ acks: [{ promptId: 'no_input' }, { promptId: 'dob_unclear' }] });
    expect(spokenText(current, t.decision)).toBe("I didn't hear anything. No matter, we can do without it for now. What can I help you with today?");
    expect(t.session.stepUp).toBeNull();
    expect(t.session.callerMatch).toBeUndefined();
    expect(t.session.form).toBeNull();
    expect(t.exhausted).toEqual({ slot: 'dob', attempts: 1, outcome: 'anything-else' });
  });

  it('during a form\'s step-up, with anything-else: the form closes uncompleted and identity with it', async () => {
    const app = variant('rg-dob-stepup', '  attempts: 1\n  onMaxAttempts: { say: dob_unclear, then: anything-else }\n');
    const r = await call(app, AVERY, { say: STATUS }, SILENCE);
    expect(prompts(r)).toEqual(['greeting', 'identity_caller_match', 'anything_else']);
    const t = last(r);
    expect(t.decision).toMatchObject({ acks: [{ promptId: 'no_input' }, { promptId: 'dob_unclear' }] });
    expect([t.session.form, t.session.stepUp, t.session.callerMatch, t.session.completed]).toEqual([null, null, undefined, []]);
    expect(t.session.slots.dob).toMatchObject({ value: null, attempts: 0 });
  });

  it('during a form\'s step-up, with then: form, to a form anyone may use', async () => {
    const app = variant('rg-dob-form', '  attempts: 1\n  onMaxAttempts: { say: dob_unclear, then: form, form: report_problem }\n');
    const r = await call(app, AVERY, { say: STATUS }, SILENCE);
    const t = last(r);
    expect(t.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_problem', acks: [{ promptId: 'no_input' }, { promptId: 'dob_unclear' }, { promptId: 'bridge_next' }] });
    expect([t.session.form, t.session.stepUp]).toEqual(['report_problem', null]);
  });

  it('enters an internal form, which is reached (validateApp, check) and drawn under identity on the app map', async () => {
    const app = variant('rg-dob-internal', '  onMaxAttempts: { say: dob_unclear, then: form, form: front_desk }\n', false, {
      'forms.yaml': (t) => `${t}  front_desk:\n    internal: true\n    label: talk to the front desk\n    slots: []\n    summaryPromptId: null\n    calls: []\n    next: report_problem\n`,
    });
    expect(() => validateApp(app)).not.toThrow();
    const checked = await checkAppFully(variants.dirOf(app), { code: recognizedCode });
    expect(checked.problems.map(formatProblem)).toEqual([]);
    expect((checked.warnings ?? []).map(formatProblem)).toEqual([]);
    const map = appMapText(app);
    expect(map).toContain('After identity (`dob` runs out): the internal form `front_desk`');
    expect(map).toContain('after("After<br/>identity, as dob runs out")');
    expect(map).toContain('## When an identity factor runs out');
    expect(map).toContain('x_dob>"When it runs out<br/>say dob_unclear, form front_desk"]');
  });

  it('check warns of a factor whose outcome enters a form that needs identity: it would ask the factor again', async () => {
    const app = variant('rg-dob-loop', '  onMaxAttempts: { then: form, form: check_status }\n');
    const checked = await checkAppFully(variants.dirOf(app), { code: recognizedCode });
    expect(checked.problems.map(formatProblem)).toEqual([]);
    const warnings = (checked.warnings ?? []).map(formatProblem);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('dob.onMaxAttempts.form');
    expect(warnings[0]).toContain('the identity factor "dob" goes, when it runs out of attempts, to the form "check_status", which needs identity level 1');
  });
});

describe('an outcome into a form whose entry needs identity', () => {
  it('enters it, and its entry asks for identity as any entry does', async () => {
    const app = variant('rg-problem-status', '', false, {
      'slots.yaml': replace('problem:\n  type: choice\n', 'problem:\n  type: choice\n  attempts: 1\n  onMaxAttempts: { then: form, form: check_status }\n'),
    });
    const r = await call(app, undefined, { say: REPORT }, SILENCE);
    const t = last(r);
    expect(t.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_accountId', acks: [{ promptId: 'no_input' }, { promptId: 'bridge_next' }] });
    expect(t.session.form).toBe('check_status');
    expect(t.session.stepUp).toMatchObject({ need: 1 });
  });
});
