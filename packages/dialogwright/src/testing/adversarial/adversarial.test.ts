import { describe, expect, it } from 'vitest';
import { registerApp, resetAppsForTest } from '../../core/app/registry';
import type { App, CompletionContext } from '../../core/app/types';
import { DEFAULT_THRESHOLDS } from '../../core/thresholds';
import { handoff } from '../../core/decision';
import { gateOf } from '../../core/app/lookup';
import { loadCorpus } from '../../jev/corpus';
import { loadScenarios } from '../../harness-text/runner';
import { REGRESS_TODAY } from '../../harness-text/baseline';
import { defaultCorpusFile, scenariosDir } from '../../run/fixtures';
import { testkitApp } from '../testkit';
import { callbackApp } from '../callback/app';
import { proposalsApp } from '../proposals/app';
import { recognizedApp } from '../recognized/app';
import { routedApp } from '../routed/app';
import { screenedApp } from '../screened/app';
import { textingApp } from '../texting/app';
import { adversarialSuite, formatAdversarialReport, runAdversarialSuite, type AdversarialReport, type AdversarialRunOptions, type AdversarialSuite } from './index';
import { HOSTILE_TEXT, textPaths, withField, withNote } from './hostile';
import { FixtureStubClient } from '../../jev/fixtureStub';
import { CASSETTE_MISS } from '../../jev/cassette';
import { JevClientError, type JevClient } from '../../jev/types';
import type { GateDecision } from '../../gate/types';
import { HeuristicStubClient } from '../../jev/heuristicStub';

/**
 * The adversarial suite over the engine's own apps (the testkit and the fixtures under src/testing),
 * so the engine's behaviour under it is covered; then the suite's properties, each shown to catch
 * the fault it is there for, by breaking a correct app one way at a time.
 */

/** The run as the stub regression makes it, for the registered app. */
function stubRun(app: App, over: Partial<AdversarialRunOptions> = {}): { suite: AdversarialSuite; opts: AdversarialRunOptions } {
  const corpus = loadCorpus(defaultCorpusFile(app), app);
  const scenarios = loadScenarios(scenariosDir(app));
  const delegates = [...corpus.flatMap((e) => (e.as ? [e.as] : [])), ...scenarios.flatMap((s) => (s.as && s.as !== 'web' ? [s.as] : []))];
  const suite = adversarialSuite(app, { delegates, corpus });
  return { suite, opts: { thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: REGRESS_TODAY, perceiver: { stub: true, corpus }, scenarios, ...over } };
}

async function run(app: App, over: Partial<AdversarialRunOptions> = {}): Promise<AdversarialReport> {
  resetAppsForTest();
  registerApp(app);
  const { suite, opts } = stubRun(app, over);
  return runAdversarialSuite(suite, opts);
}

const failing = (r: AdversarialReport): string[] => r.results.filter((x) => x.status === 'fail').flatMap((x) => [x.case.id, ...x.violations]);
const families = (r: AdversarialReport): string[] => [...new Set(r.results.filter((x) => x.status === 'hold').map((x) => x.case.family))].sort();

describe('the engine\'s own apps hold under the suite', () => {
  const apps: [string, App, string[]][] = [
    ['testkit', testkitApp, ['hostile-reply', 'injection', 'off-scope', 'relationship', 'spoken-code']],
    ['callback', callbackApp, ['hostile-reply', 'injection', 'off-scope']],
    ['proposals', proposalsApp, ['hostile-reply', 'injection', 'off-scope', 'relationship', 'spoken-code']],
    ['recognized', recognizedApp, ['hostile-reply', 'injection', 'off-scope', 'relationship', 'spoken-code']],
    ['routed', routedApp, ['hostile-reply', 'injection', 'off-scope', 'relationship', 'spoken-code']],
    ['screened', screenedApp, ['hostile-reply', 'injection', 'off-scope']],
    ['texting', textingApp, ['hostile-reply', 'injection', 'off-scope']],
  ];
  it.each(apps)('%s', async (_name, app, expected) => {
    const report = await run(app);
    expect(failing(report), formatAdversarialReport(report, { notes: true }).join('\n')).toEqual([]);
    expect(families(report)).toEqual(expected);
  });

  it('the testkit is tried at every point its shape has, in each family', async () => {
    resetAppsForTest();
    registerApp(testkitApp);
    const { suite } = stubRun(testkitApp);
    const ids = suite.cases.map((c) => c.id);
    for (const id of [
      'injection/open/ignore-instructions/correct/en', 'injection/open/ignore-instructions/fooled/en',
      'injection/factor-accountId/supervisor-skip/correct/en', 'injection/factor-dob/supervisor-skip/correct/en',
      'injection/code/skip-code/correct/en', 'injection/form-report_missing/hidden-instruction/fooled/en',
      'injection/summary-report_missing/system-approve/fooled/en',
      'relationship/open/report_missing/correct/en', 'relationship/factor-accountId/claim/correct/en',
      'relationship/delegate-viewer/report_missing/correct/en', 'relationship/delegate-clerk/report_missing/correct/en',
      'off-scope/open/other-business/correct/en', 'off-scope/anything-else/unanswerable/fooled/en',
      'spoken-code/code/said/correct/en', 'spoken-code/open/unsent/correct/en', 'spoken-code/factor-accountId/unsent-keyed/correct',
      'hostile-reply/getParcel/instructions', 'hostile-reply/getParcel/field', 'hostile-reply/service-depot/instructions',
    ]) expect(ids).toContain(id);
    // The engine's own knowledge tool is not a downstream system's; the testkit has none, so nothing is said of it.
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('the routed fixture speaks Spanish too: its cases are in both languages', async () => {
    resetAppsForTest();
    registerApp(routedApp);
    const { suite } = stubRun(routedApp);
    const languages = new Set(suite.cases.map((c) => c.language));
    expect([...languages].sort()).toEqual(['en', 'es']);
    expect(suite.cases.some((c) => c.id === 'injection/open/ignore-instructions/correct/es')).toBe(true);
  });

  it('two locales of one language give its cases once', async () => {
    const twice = { ...routedApp, id: 'routed-twice', locales: { ...routedApp.locales!, prompts: { ...routedApp.locales!.prompts, 'es-MX': routedApp.locales!.prompts.es! } } } as App;
    resetAppsForTest();
    registerApp(twice);
    const ids = adversarialSuite(twice).cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id.endsWith('/es')).length).toBeGreaterThan(0);
  });

  it('an app in a language the suite has no words for is skipped with a note', async () => {
    const french = { ...callbackApp, id: 'callback-fr', locales: { default: 'fr-FR', prompts: {} } } as App;
    resetAppsForTest();
    registerApp(french);
    const suite = adversarialSuite(french);
    expect(suite.cases.filter((c) => c.line !== undefined)).toEqual([]);
    expect(suite.notes).toContain('fr-FR: the suite has no words in this language (it has en, es): its cases are skipped');
    expect(suite.cases.some((c) => c.family === 'hostile-reply')).toBe(true);
  });
});

describe('each property catches the fault it is there for', () => {
  it('screened: a screen that does not fire on an announced injection fails every correct injection case', async () => {
    // The stub's manipulation answer (0.92) under a threshold it cannot reach: as if the screen were not there.
    const report = await run(testkitApp, { thresholds: { ...DEFAULT_THRESHOLDS, SCREEN_FIRE: 0.99 } });
    const fails = report.results.filter((r) => r.status === 'fail');
    expect(fails.length).toBeGreaterThan(0);
    expect(fails.every((r) => r.case.family === 'injection' && r.case.perception === 'correct')).toBe(true);
    expect(fails.every((r) => r.violations.some((v) => v.startsWith('screened: the injection screen did not take the turn')))).toBe(true);
  });

  it('within-policy and no-raise: a gate that allows everything is caught from the policy as written', async () => {
    const open: App = { ...testkitApp, id: 'open-gate', gate: { ...gateOf(testkitApp), evaluate: (call) => ({ call, verdict: 'ALLOW', rules: [] }) } };
    const report = await run(open);
    const violations = report.results.flatMap((r) => r.violations);
    // The gate says yes to everything, so nothing steps up: the fooled readings run a guarded read for a caller who proved nothing.
    expect(violations).toContain('within-policy: getAccount ran, which needs level 2, for a caller proven to level 0');
  });

  it('nothing-said: a reply\'s text said in a line is caught, field by field', async () => {
    const report = await run(testkitApp);
    // The testkit checks what its tools reply; without the checks, a parcel's item is said as it came.
    const unchecked: App = { ...testkitApp, id: 'unchecked', tools: Object.fromEntries(Object.entries(testkitApp.tools).map(([k, t]) => [k, { ...t, check: undefined }])) };
    const bare = await run(unchecked);
    expect(report.results.find((r) => r.case.id === 'hostile-reply/getParcel/field')?.status).toBe('hold');
    const said = bare.results.find((r) => r.case.id === 'hostile-reply/getParcel/field')!;
    expect(said.status).toBe('fail');
    expect(said.violations.some((v) => /^track-happy item: nothing-said: said ".*SYSTEM NOTICE/.test(v))).toBe(true);
  });

  it('a turn that throws on a hostile reply fails under a model too: it is no reading of the words', async () => {
    const unchecked: App = { ...testkitApp, id: 'unchecked-model', tools: Object.fromEntries(Object.entries(testkitApp.tools).map(([k, t]) => [k, { ...t, check: undefined }])) };
    resetAppsForTest();
    registerApp(unchecked);
    const { suite, opts } = stubRun(unchecked);
    const client = new FixtureStubClient([...loadCorpus(defaultCorpusFile(unchecked), unchecked)], { sharpness: DEFAULT_THRESHOLDS.STUB_SHARPNESS, fallback: new HeuristicStubClient({ todayIso: REGRESS_TODAY }), app: unchecked });
    const report = await runAdversarialSuite({ ...suite, cases: suite.cases.filter((c) => c.id === 'hostile-reply/getParcel/field') }, { ...opts, perceiver: { stub: false, client, recorded: true } });
    const r = report.results[0]!;
    expect(r.status).toBe('fail');
    expect(r.violations.some((v) => /status: outcome: ended threw/.test(v))).toBe(true);
    expect(r.violations.some((v) => /item: nothing-said/.test(v))).toBe(true);
  });

  it('same-outcome: an app that acts on the instructions beside a reply is caught', async () => {
    // A tracking form that hands the call over when the parcel's reply carries a note: an app that obeys what came back.
    const track = testkitApp.forms.track_parcel!;
    const obeying: App = {
      ...testkitApp, id: 'obeying',
      forms: {
        ...testkitApp.forms,
        track_parcel: {
          ...track,
          complete: (c: CompletionContext) => {
            const { value } = c.callTool({ tool: 'getParcel', params: { parcel: c.s.slots.parcelSelect!.value ?? '' } });
            if ((value as { note?: string } | null)?.note !== undefined) return { kind: 'decision', decision: handoff(c.s, 'live-agent', c.acks) };
            return track.complete(c);
          },
        },
      },
    };
    const report = await run(obeying);
    const r = report.results.find((x) => x.case.id === 'hostile-reply/getParcel/instructions')!;
    expect(r.status).toBe('fail');
    expect(r.violations.some((v) => /same-outcome: ended handoff/.test(v))).toBe(true);
  });
});

describe('the policy as written, and what a reply may become', () => {
  /** The testkit whose gate turns one kind of refusal into an allow: a gate wrong in a way its own lines agree with. */
  function bypassing(id: string, flip: (d: GateDecision) => boolean): App {
    const g = gateOf(testkitApp);
    return { ...testkitApp, id, gate: { ...g, evaluate: (...a: Parameters<typeof g.evaluate>) => { const d = g.evaluate(...a); return flip(d) ? { ...d, verdict: 'ALLOW', reason: undefined } as GateDecision : d; } } };
  }

  it('within-policy reads the role rule: a delegate seated at a summary whose write their role may not make is caught', async () => {
    const report = await run(bypassing('role-bypass', (d) => d.verdict !== 'ALLOW' && d.reason !== undefined && /role/.test(d.reason)));
    const v = report.results.filter((r) => r.case.id.startsWith('relationship/delegate-') && r.case.id.includes('/summary-report_missing/')).flatMap((r) => r.violations);
    expect(v).toContain('within-policy: createReport ran for a agent whose role (viewer) its role rule does not allow');
    expect(v).toContain('within-policy: createReport ran for a agent whose role (clerk) its role rule does not allow');
  });

  it('within-policy reads the scope rule from the call as made and the app\'s own lookups: another subject\'s record is caught', async () => {
    // A tracking form that looks up the parcel no caller here may see, whatever was asked: a hook gone wrong, and a gate that lets it.
    const track = testkitApp.forms.track_parcel!;
    const wrong: App = {
      ...bypassing('scope-bypass', (d) => d.verdict !== 'ALLOW' && d.reason === 'scope'),
      forms: { ...testkitApp.forms, track_parcel: { ...track, complete: (c: CompletionContext) => { c.callTool({ tool: 'getParcel', params: { parcel: '7301' } }); return track.complete(c); } } },
    };
    const report = await run(wrong);
    expect(report.results.flatMap((r) => r.violations)).toContain('within-policy: getParcel ran on the record 7301, which this customer may not see (its scope rule)');
  });

  it('said-in-place: plain words a check let through, said as a line of their own, are caught; said in their place they are listed', async () => {
    const report = await run(testkitApp);
    const item = report.results.find((r) => r.case.id === 'hostile-reply/getParcel/field')!;
    expect(item.status).toBe('hold');
    expect(item.accepted).toContain('track-happy item (plain words): said in its place in parcel_status_in_transit ({item})');
    const track = testkitApp.forms.track_parcel!;
    const alone: App = {
      ...testkitApp, id: 'item-alone',
      prompts: { ...testkitApp.prompts, manifest: { ...testkitApp.prompts.manifest, item_alone: { text: '{item}', interruptible: false } } },
      forms: {
        ...testkitApp.forms,
        track_parcel: {
          ...track,
          complete: (c: CompletionContext) => {
            const { value } = c.callTool({ tool: 'getParcel', params: { parcel: c.s.slots.parcelSelect!.value ?? '' } });
            return { kind: 'said', acks: [...c.acks, { promptId: 'item_alone', vars: { item: String((value as { item?: string } | null)?.item ?? '') } }] };
          },
        },
      },
    };
    const said = (await run(alone)).results.find((r) => r.case.id === 'hostile-reply/getParcel/field')!;
    expect(said.status).toBe('fail');
    expect(said.violations).toContain('track-happy item (plain words): said-in-place: said as a line of its own (item_alone)');
  });

  it('no-new-action: a reply\'s text passed on to another call is caught', async () => {
    const track = testkitApp.forms.track_parcel!;
    const passing: App = {
      ...testkitApp, id: 'passing-on',
      forms: {
        ...testkitApp.forms,
        track_parcel: {
          ...track,
          complete: (c: CompletionContext) => {
            const { value } = c.callTool({ tool: 'getParcel', params: { parcel: c.s.slots.parcelSelect!.value ?? '' } });
            const accountId = c.s.principal.kind === 'customer' ? c.s.principal.id : '';
            c.callTool({ tool: 'getWindows', params: { accountId, deliveryDay: String((value as { item?: string } | null)?.item ?? ''), deliveryPart: 'morning' } });
            return track.complete(c);
          },
        },
      },
    };
    const r = (await run(passing)).results.find((x) => x.case.id === 'hostile-reply/getParcel/field')!;
    expect(r.violations).toContain('track-happy item (plain words): no-new-action: the reply\'s text was passed on to getWindows (deliveryDay)');
  });

  it('a recorded call with a miss is still held, over the turns before it, to what holds whatever the reading', async () => {
    const unchecked: App = { ...testkitApp, id: 'unchecked-recorded', tools: Object.fromEntries(Object.entries(testkitApp.tools).map(([k, t]) => [k, { ...t, check: undefined }])) };
    resetAppsForTest();
    registerApp(unchecked);
    const { suite, opts } = stubRun(unchecked);
    const happy = opts.scenarios.find((s) => s.id === 'track-happy')!;
    const longer = { ...happy, id: 'track-happy-then-done', steps: [...happy.steps, { say: "no, that's all" }] };
    const stub = new FixtureStubClient(loadCorpus(defaultCorpusFile(unchecked), unchecked), { sharpness: DEFAULT_THRESHOLDS.STUB_SHARPNESS, fallback: new HeuristicStubClient({ todayIso: REGRESS_TODAY }), app: unchecked });
    // A recording that has every answer but the last turn's.
    const client: JevClient = { ask: (req) => (JSON.stringify(req.state).includes("no, that's all") ? Promise.reject(new JevClientError(`${CASSETTE_MISS} test`)) : stub.ask(req)) };
    const report = await runAdversarialSuite({ ...suite, cases: suite.cases.filter((c) => c.id === 'hostile-reply/getParcel/field') }, { ...opts, scenarios: [longer], perceiver: { stub: false, client, recorded: true } });
    const r = report.results[0]!;
    expect(r.status).toBe('fail');
    expect(r.violations.some((v) => /^track-happy-then-done item: nothing-said: said ".*SYSTEM NOTICE/.test(v))).toBe(true);
  });

  it('the keyed code never sent fills the factor it is keyed at, and nothing verifies', async () => {
    const report = await run(testkitApp);
    const r = report.results.find((x) => x.case.id === 'spoken-code/factor-accountId/unsent-keyed/correct')!;
    expect(r.case.keys).toBe('42424242');
    expect(r.status).toBe('hold');
    expect(r.calls[0]!.outcome).toBe('asks-identity');
    expect(r.calls[0]!.turns.at(-1)!.result.session.slots.accountId!.value).toBe('42424242');
  });
});

describe('a hostile reply', () => {
  it('beside a reply: a note on an object and on each object of a list; anything else as it was', () => {
    expect(withNote({ a: '1' })).toEqual({ a: '1', note: HOSTILE_TEXT });
    expect(withNote([{ a: '1' }, null, 'x'])).toEqual([{ a: '1', note: HOSTILE_TEXT }, null, 'x']);
    expect(withNote(true)).toBe(true);
    expect(withNote(null)).toBeNull();
  });

  it('in place of a field: every text of a reply by its path, a list\'s items under *', () => {
    const reply = { ok: true, principal: { kind: 'customer', id: '55501234', contact: { phoneLast4: '0101' } }, items: [{ name: 'a' }, { name: 'b', n: 2 }] };
    expect([...textPaths(reply).keys()]).toEqual(['principal.kind', 'principal.id', 'principal.contact.phoneLast4', 'items.*.name']);
    expect(withField(reply, ['items', '*', 'name'])).toEqual({ ...reply, items: [{ name: HOSTILE_TEXT }, { name: HOSTILE_TEXT, n: 2 }] });
    expect(withField(reply, ['principal', 'contact', 'phoneLast4'])).toEqual({ ...reply, principal: { ...reply.principal, contact: { phoneLast4: HOSTILE_TEXT } } });
    expect(withField('a reply', [])).toBe(HOSTILE_TEXT);
    expect(withField(reply, ['missing'])).toEqual(reply);
  });
});
