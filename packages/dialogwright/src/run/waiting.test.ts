import { afterAll, describe, expect, it } from 'vitest';
import { registerApp, resetAppsForTest } from '../core/app/registry';
import type { App, ToolContext, ToolDef, ToolReply } from '../core/app/types';
import type { ToolCall } from '../gate/types';
import { TOOLS, textingApp, textingCode } from '../testing/texting/app';
import { both, replace, textingVariants } from '../testing/texting/variant';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { testkitApp } from '../testing/testkit';
import { goldenRuns, type GoldenRuns } from '../testing/goldenRuns';
import { loadScenarios, runScenario, type ScenarioRunOptions } from '../harness-text/runner';
import { scenariosDir, defaultCorpusFile } from './fixtures';
import { buildClient, buildThresholds } from './client';
import { REGRESS_TODAY } from '../harness-text/baseline';
import { sayText, type Action } from '../channel/actions';
import { runTurn, type RunOptions, type TurnRun } from './turn';
import { ASYNC_WITHOUT_RUNNER, ToolLate, memoKey, newToolMemo, startPass, throughMemo } from '../core/toolWait';
import { resolve } from '../core/turn';
import { callTool, newTurnOut } from '../core/lifecycle';
import { newSession } from '../core/session';
import { startEvent, withCallerNumber } from '../channel/events';
import { VOICE_RELAY, WEB_CHAT } from '../channel/caps';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { demoTools } from '../core/tools';

/** The testkit with each tool's reply a promise, `delayMs` later; every run counted by its tool. */
function asyncTestkit(over: Partial<App> = {}, delayMs = 0, runs?: Map<string, number>, hang?: string): App {
  const tools = Object.fromEntries(Object.entries(testkitApp.tools).map(([name, def]): [string, ToolDef] => [name, {
    ...def,
    run: (call, sys, ctx) => {
      runs?.set(name, (runs.get(name) ?? 0) + 1);
      if (name === hang) return new Promise<ToolReply>(() => undefined);
      // The tool runs once its reply comes: a promise that settles on a later tick, as a request does.
      return new Promise<ToolReply>((res, rej) => setTimeout(() => {
        try {
          res(def.run(call, sys, ctx) as ToolReply);
        } catch (err) {
          rej(err);
        }
      }, delayMs));
    },
  }]));
  return { ...testkitApp, tools, ...over };
}

/** The testkit as it is, every run counted by its tool. */
function countedTestkit(runs: Map<string, number>): App {
  const tools = Object.fromEntries(Object.entries(testkitApp.tools).map(([name, def]): [string, ToolDef] => [name, {
    ...def,
    run: (call, sys, ctx) => {
      runs.set(name, (runs.get(name) ?? 0) + 1);
      return def.run(call, sys, ctx);
    },
  }]));
  return { ...testkitApp, tools };
}

function use(app: App): void {
  resetAppsForTest();
  registerApp(app);
}

/** What a turn decided and said, and what it recorded: every part a tool's timing may not change. */
function decided(run: TurnRun): unknown {
  const { result } = run;
  return { decision: result.decision, actions: result.actions, gateEvents: result.gateEvents, effects: result.effects, audit: result.audit, kb: result.kb, session: { ...result.session, startedAtMs: 0 } };
}

function decisions(runs: GoldenRuns): unknown[] {
  return runs.sections.map((s) => ({ heading: s.heading, turns: s.runs.map(decided) }));
}

describe('tools that wait on a system', () => {
  it('decide every scripted call of the testkit exactly as tools that reply at once, each run once a turn', async () => {
    const syncRuns = new Map<string, number>();
    use(countedTestkit(syncRuns));
    const sync = await goldenRuns('stub');
    const runs = new Map<string, number>();
    use(asyncTestkit({}, 0, runs));
    const waiting = await goldenRuns('stub');
    expect(decisions(waiting)).toEqual(decisions(sync));
    // Every call that waited is in its turn's record, and no turn ran a tool more often than it made calls.
    const records = waiting.sections.flatMap((s) => s.runs.map((r) => r.record));
    const waited = records.flatMap((r) => r.waited?.calls ?? []);
    expect(waited.length).toBeGreaterThan(0);
    expect(waited.every((c) => c.outcome === 'replied')).toBe(true);
    // Each tool ran as often as with replies at once (the turns' calls, and the seeds' of the corpus entries).
    expect(Object.fromEntries(runs)).toEqual(Object.fromEntries(syncRuns));
    // A pass for each call that waited, and one more.
    for (const r of records) if (r.waited) expect(r.waited.passes).toBe(r.waited.calls.length + 1);
    // A turn whose tools all replied at once is as it was: no record of waiting.
    use(testkitApp);
    const again = await goldenRuns('stub');
    expect(again.sections.flatMap((s) => s.runs).every((r) => r.record.waited === undefined)).toBe(true);
  }, 120_000);

  it('says the hold line before the turn\'s reply, through the channel\'s early lines, and the trace says so', async () => {
    const prompts = { ...testkitApp.prompts, manifest: { ...testkitApp.prompts.manifest, lookup_hold: { text: 'One second while I look that up.', interruptible: false } } };
    use(asyncTestkit({ prompts, waiting: { line: 'lookup_hold' } }, 20));
    const said: string[] = [];
    const turns: TurnRun[] = [];
    const turn = async (...args: Parameters<NonNullable<ScenarioRunOptions['turn']>>): Promise<TurnRun> => {
      const early = (lines: readonly Action[]): boolean => {
        said.push(`early: ${sayText(lines)}`);
        return true;
      };
      const run = await runTurn(args[0], args[1], { ...args[2], early });
      said.push(`turn: ${sayText(run.result.actions)}`);
      turns.push(run);
      return run;
    };
    const scenario = loadScenarios(scenariosDir()).find((s) => s.steps.length > 2)!;
    const thresholds = buildThresholds([]);
    await runScenario(scenario, { client: buildClient('stub', defaultCorpusFile(), thresholds, REGRESS_TODAY), thresholds, todayIso: REGRESS_TODAY, now: () => 0, turn });
    const held = turns.filter((t) => t.record.waited?.hold !== undefined);
    expect(held.length).toBeGreaterThan(0);
    for (const t of held) expect(t.record.waited!.hold).toMatchObject({ promptId: 'lookup_hold', said: true });
    // Each hold line goes before the reply of its own turn.
    const at = said.indexOf('early: One second while I look that up.');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(said[at + 1]).toMatch(/^turn: /);
  }, 60_000);

  it('says no hold line for a reply quicker than afterMs', async () => {
    const prompts = { ...testkitApp.prompts, manifest: { ...testkitApp.prompts.manifest, lookup_hold: { text: 'One second while I look that up.', interruptible: false } } };
    use(asyncTestkit({ prompts, waiting: { line: 'lookup_hold', afterMs: 5_000 } }, 0));
    const waiting = await goldenRuns('stub');
    const records = waiting.sections.flatMap((s) => s.runs.map((r) => r.record));
    expect(records.some((r) => r.waited !== undefined)).toBe(true);
    expect(records.every((r) => r.waited?.hold === undefined)).toBe(true);
  }, 120_000);
});

describe('the tool memo', () => {
  it('runs a call once, keeps its reply for the next pass, and makes a call made twice two runs', () => {
    const memo = newToolMemo();
    let ran = 0;
    const start = (): ToolReply => ({ value: ++ran, summary: 'ok' });
    const call = { tool: 't', params: { b: '2', a: '1' } };
    startPass(memo);
    expect(throughMemo(memo, memoKey(memo, call, undefined), 't', start, (r) => r, () => [])).toEqual({ run: { value: 1, summary: 'ok' }, effects: [] });
    expect(throughMemo(memo, memoKey(memo, call, undefined), 't', start, (r) => r, () => [])).toEqual({ run: { value: 2, summary: 'ok' }, effects: [] });
    startPass(memo);
    // The params' order does not make another call.
    expect(throughMemo(memo, memoKey(memo, { tool: 't', params: { a: '1', b: '2' } }, undefined), 't', start, (r) => r, () => [])).toMatchObject({ run: { value: 1 } });
    expect(ran).toBe(2);
  });

  it('counts a reply later than the timeout as a tool that threw', async () => {
    const memo = newToolMemo(20);
    startPass(memo);
    const key = memoKey(memo, { tool: 'slow', params: {} }, undefined);
    expect(throughMemo(memo, key, 'slow', () => new Promise<ToolReply>(() => undefined), (r) => r, () => [])).toEqual({ pending: true });
    await (memo.runs.get(key) as { settled: Promise<void> }).settled;
    startPass(memo);
    expect(() => throughMemo(memo, memoKey(memo, { tool: 'slow', params: {} }, undefined), 'slow', () => ({ value: 1, summary: '' }), (r) => r, () => [])).toThrow(ToolLate);
  });

  it('refuses a tool that returns a promise on a turn no runner waits for', () => {
    use(asyncTestkit());
    const s = newSession('s', 0, VOICE_RELAY);
    const tc = { nowMs: 0, todayIso: '2026-09-18', thresholds: { ...DEFAULT_THRESHOLDS }, tools: demoTools() };
    // The greeting calls no tool; a call to one that returns a promise is refused, with no memo to keep it.
    expect(() => resolve(s, startEvent(), null, tc)).not.toThrow();
    expect(() => callTool(s, { tool: 'verifyCustomer', params: { accountId: '55500001', dob: '1980-01-01' } }, tc, newTurnOut())).toThrow(ASYNC_WITHOUT_RUNNER);
  });
});

describe('a tool that does not reply in time', () => {
  it('fails the turn as a tool that threw, and the call goes on to a person', async () => {
    const thresholds = buildThresholds([]);
    const opts = { client: buildClient('stub', defaultCorpusFile(), thresholds, REGRESS_TODAY), thresholds, todayIso: REGRESS_TODAY, now: () => 0 };
    use(testkitApp);
    const scenarios = loadScenarios(scenariosDir());
    // A scripted call that looks a parcel up.
    let found: { id: string; turn: number } | null = null;
    for (const s of scenarios) {
      const r = await runScenario(s, opts);
      const at = r.runs.findIndex((run) => run.result.gateEvents.some((e) => e.decision.call.tool === 'getParcel' && e.decision.verdict === 'ALLOW'));
      if (at >= 0) {
        found = { id: s.id, turn: at };
        break;
      }
    }
    expect(found).not.toBeNull();
    use(asyncTestkit({ waiting: { timeoutMs: 30 } }, 0, undefined, 'getParcel'));
    const scenario = scenarios.find((s) => s.id === found!.id)!;
    await expect(runScenario(scenario, opts)).rejects.toThrow(ToolLate);
  }, 60_000);
});

describe('the call\'s start, behind its welcome', () => {
  const variants = textingVariants();
  afterAll(() => variants.remove());

  /** The texting fixture with its call-start lookup a request `delayMs` long, the welcome said while it runs, and the thinking sound after it. */
  function slowLookup(delayMs: number, waiting: string): App {
    const lookup = TOOLS.findCallerByPhone!;
    const code = { ...textingCode, tools: { ...TOOLS, findCallerByPhone: { ...lookup, run: (call: ToolCall, sys: unknown, ctx: ToolContext) => new Promise<ToolReply>((res) => setTimeout(() => res(lookup.run(call, sys, ctx) as ToolReply), delayMs)) } } };
    return variants.variant({
      'app.yaml': both(replace('id: texting', `id: texting-wait-${delayMs}`), (t) => `${t}\nwaiting:\n${waiting}`),
      'prompts.yaml': replace('  greeting:\n', '  welcome_hold:\n    text: Thanks for calling. This call may be recorded.\n    interruptible: false\n  greeting:\n'),
    }, code);
  }

  it('says the welcome at once, the greeting once the lookup is in, and keeps what the lookup found', async () => {
    use(textingApp);
    const sync = await runTurn(newSession('s', 0, VOICE_RELAY), withCallerNumber(startEvent(), '+15555550142'), startOpts());
    use(slowLookup(40, '  start: welcome_hold\n'));
    const said: string[] = [];
    const run = await runTurn(newSession('s', 0, VOICE_RELAY), withCallerNumber(startEvent(), '+15555550142'), { ...startOpts(), early: (lines) => (said.push(sayText(lines)), true) });
    expect(said).toEqual(['Thanks for calling. This call may be recorded.']);
    expect(sayText(run.result.actions)).toBe(sayText(sync.result.actions));
    expect(run.result.session.facts).toEqual(sync.result.session.facts);
    expect(run.record.waited).toMatchObject({ calls: [{ tool: 'findCallerByPhone', outcome: 'replied' }], passes: 2, hold: { promptId: 'welcome_hold', said: true } });
  });

  it('plays the thinking sound after the welcome, one clip at a time, until the lookup is in', async () => {
    use(slowLookup(150, '  start: welcome_hold\n  sound: thinking\n'));
    const said: string[] = [];
    const render = { clips: new Map([['thinking', 'thinking.wav']]), audioBase: 'https://h/audio/' };
    const playMs = (lines: readonly Action[]): number => (lines.some((a) => a.type === 'say' && a.parts.some((p) => 'audio' in p)) ? 30 : 20);
    const early = (lines: readonly Action[]): boolean => {
      said.push(lines.map((a) => (a.type === 'say' ? a.parts.map((p) => ('audio' in p ? `[${p.audio}]` : p.text)).join(' ') : a.type)).join(' '));
      return true;
    };
    const run = await runTurn(newSession('s', 0, VOICE_RELAY), withCallerNumber(startEvent(), '+15555550142'), { ...startOpts(), render, playMs, early });
    expect(said[0]).toBe('Thanks for calling. This call may be recorded.');
    const sounds = said.slice(1);
    expect(sounds.length).toBeGreaterThanOrEqual(2);
    expect(sounds.every((s) => s === '[https://h/audio/thinking.wav]')).toBe(true);
    expect(run.record.waited?.sounds).toBe(sounds.length);
  });

  it('refuses a waiting line that prompts.yaml does not have, for the app and for a tool', () => {
    expect(() => variants.variant({ 'app.yaml': both(replace('id: texting', 'id: texting-no-line'), (t) => `${t}\nwaiting:\n  line: lookup_hold\n`) })).toThrow(/waiting\.line\s+prompt "lookup_hold" is not in prompts.yaml/);
    const lookup = TOOLS.findCallerByPhone!;
    expect(() => variants.variant({ 'app.yaml': replace('id: texting', 'id: texting-no-tool-line') }, { ...textingCode, tools: { ...TOOLS, findCallerByPhone: { ...lookup, waiting: { line: 'booking_hold' } } } })).toThrow(/tool "findCallerByPhone" names the waiting line "booking_hold", which is not in prompts.yaml/);
  });

  it('waits on nothing at a chat\'s start (no number to look up), and records the welcome as due and not said where the channel says nothing early', async () => {
    use(slowLookup(40, '  start: welcome_hold\n  sound: thinking\n'));
    const render = { clips: new Map([['thinking', 'thinking.wav']]), audioBase: 'https://h/audio/' };
    const chat = await runTurn(newSession('s', 0, WEB_CHAT), startEvent(), { ...startOpts(), render, playMs: () => 10, early: () => true });
    expect(chat.record.waited).toBeUndefined();
    const harness = await runTurn(newSession('s', 0, VOICE_RELAY), withCallerNumber(startEvent(), '+15555550142'), startOpts());
    expect(harness.record.waited?.hold).toMatchObject({ promptId: 'welcome_hold', said: false });
    expect(harness.record.waited?.sounds).toBeUndefined();
  });
});

function startOpts(): RunOptions {
  return { client: new HeuristicStubClient(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18', now: () => 0 };
}
