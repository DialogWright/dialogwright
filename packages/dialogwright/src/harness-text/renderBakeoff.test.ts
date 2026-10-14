import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { resetAppsForTest } from '../core/app/registry';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { JevClientError } from '../jev/types';
import { SHORT_TMP } from '../testing/shortTmp';
import { envForModel, guardFresh, parseModelSpecs, parsePrices, type BakeoffReport } from './renderBakeoff';
import { bakeoffCommand, BAKEOFF_USAGE, type BakeoffIo } from './renderBakeoffCommand';
import { loadRenderCassette } from '../render/cassette';
import { FakeRenderClient } from '../render/fake';
import type { RenderAct } from '../render/types';

/**
 * `render:bakeoff`: the render models compared on an app's own lines. No test asks a model: the
 * providers are a fetch written here (answering as Anthropic and OpenRouter document, with the fake
 * renderer's wording), the decision model is the message fixture's recording with the heuristic stub
 * answering what it lacks (the drift checks of a new wording), and the recordings go to a copy of
 * the fixture's. The replay tables the fixture's own committed recording.
 */

const PACKAGE_DIR = fileURLToPath(new URL('../../', import.meta.url));
const MESSAGE = join(PACKAGE_DIR, 'src/testing/message');
const RECORDED = join(MESSAGE, 'fixtures/recorded');
const KEY = 'sk-ant-test-not-a-real-key-0001';
const OR_KEY = 'sk-or-test-not-a-real-key-0002';
const JEV_KEY = 'ts-test-not-a-real-key-0003';
const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
// The command registers the app folder's app as the default, as it is in its own process.
beforeEach(() => resetAppsForTest());

function io(extra: Partial<BakeoffIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const it: BakeoffIo = { out: (l) => out.push(l), err: (l) => err.push(l), invokedFrom: PACKAGE_DIR, env: {}, chdir: () => {}, ...extra };
  return { io: it, out, err, all: () => [...out, ...err].join('\n') };
}

/** A copy of the message fixture's recordings, to record into. */
function recordedCopy(): string {
  const dir = mkdtempSync(join(SHORT_TMP, 'dialogwright-bakeoff-'));
  scratch.push(dir);
  cpSync(RECORDED, dir, { recursive: true });
  return dir;
}

/**
 * The providers, as a fetch: each line worded as the fake renderer words it (from the act the request
 * carries), Anthropic's and OpenRouter's answers in their own shapes. A model named `claude-missing`
 * answers 404, as a wrong id does, with the key in its message (which must never reach the output).
 */
function fakeProviders(opts: { delayMs?: number; failing?: Set<string>; failSpans?: { on: boolean } } = {}) {
  const sent: { url: string; model: string; headers: Record<string, string>; reasoning?: unknown }[] = [];
  const fake = new FakeRenderClient();
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init!.body)) as { model: string; system?: string; reasoning?: unknown; messages: { role: string; content: string }[] };
    sent.push({ url: String(url), model: body.model, headers: init!.headers as Record<string, string>, ...(body.reasoning !== undefined ? { reasoning: body.reasoning } : {}) });
    if (opts.failing?.has(body.model)) return new Response(JSON.stringify({ error: { code: 400, message: 'Provider returned error', metadata: { provider_name: 'Example', raw: 'Reasoning is mandatory for this endpoint and cannot be disabled.' } } }), { status: 400 });
    if (body.model === 'claude-missing') return new Response(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `model: claude-missing (key ${KEY})` } }), { status: 404 });
    const act = JSON.parse(body.messages.at(-1)!.content) as RenderAct;
    if (opts.failSpans?.on === true && (act as { kind?: string }).kind === 'span') return new Response(JSON.stringify({ error: { type: 'overloaded_error', message: 'Overloaded' } }), { status: 529 });
    const g = await fake.generate({ promptId: 'line', act, key: '' }, new AbortController().signal);
    // A slow provider, which stops when the request is aborted (as fetch does).
    if (opts.delayMs !== undefined) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, opts.delayMs);
        init!.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    }
    const answer = String(url).includes('anthropic.com')
      ? { model: body.model, content: [{ type: 'text', text: g.text }], stop_reason: 'end_turn', usage: { input_tokens: 400, output_tokens: 20 } }
      : { model: body.model, choices: [{ message: { content: g.text }, finish_reason: 'stop' }], usage: { prompt_tokens: 400, completion_tokens: 20 } };
    return new Response(JSON.stringify(answer), { status: 200 });
  }) as typeof fetch;
  return { fetchFn, sent };
}

/** The decision model a recording run asks what the fixture's recording lacks (the drift checks of a new wording): the heuristic stub. */
const stubDecision = (): HeuristicStubClient => new HeuristicStubClient({ todayIso: '2026-09-18' });

describe('the models named', () => {
  it('reads anthropic and openrouter entries, an Anthropic one with its thinking and effort', () => {
    expect(parseModelSpecs(['anthropic:claude-haiku-5-5,openrouter:vendor/small:free', 'anthropic:claude-haiku-5-5:adaptive:low', 'openrouter:openai/gpt-oss-120b:low,openrouter:vendor/small:free:omit,anthropic:claude-opus-5-5:medium'])).toEqual([
      { entry: 'anthropic:claude-haiku-5-5', provider: 'anthropic', model: 'claude-haiku-5-5' },
      { entry: 'openrouter:vendor/small:free', provider: 'openrouter', model: 'vendor/small:free' },
      { entry: 'anthropic:claude-haiku-5-5:adaptive:low', provider: 'anthropic', model: 'claude-haiku-5-5', thinking: 'adaptive', effort: 'low' },
      { entry: 'openrouter:openai/gpt-oss-120b:low', provider: 'openrouter', model: 'openai/gpt-oss-120b', effort: 'low' },
      { entry: 'openrouter:vendor/small:free:omit', provider: 'openrouter', model: 'vendor/small:free', thinking: 'omit' },
      { entry: 'anthropic:claude-opus-5-5:medium', provider: 'anthropic', model: 'claude-opus-5-5', effort: 'medium' },
    ]);
    expect(() => parseModelSpecs([])).toThrow(/names no model/);
    expect(() => parseModelSpecs(['claude-haiku-5-5'])).toThrow(/start it with its provider/);
    expect(() => parseModelSpecs(['anthropic:claude-haiku-5-5:thinking'])).toThrow('"anthropic:claude-haiku-5-5:thinking": after the model give its thinking (disabled, between-tools, adaptive, omit) and its effort (low, medium, high), either or both, got "thinking"');
    expect(() => parseModelSpecs(['anthropic:claude-haiku-5-5:adaptive:max'])).toThrow(/got "adaptive:max"/);
    expect(() => parseModelSpecs(['anthropic:a', 'anthropic:a'])).toThrow(/named twice/);
  });

  it('runs each model with its own provider, model and thinking, never another\'s from the environment', () => {
    const env = { RENDER_THINKING: 'adaptive', RENDER_EFFORT: 'high', ANTHROPIC_API_KEY: KEY };
    expect(envForModel({ entry: 'x', provider: 'anthropic', model: 'claude-haiku-5-5' }, env)).toEqual({ ANTHROPIC_API_KEY: KEY, RENDER_PROVIDER: 'anthropic', RENDER_MODEL: 'claude-haiku-5-5' });
    expect(envForModel({ entry: 'x', provider: 'anthropic', model: 'm', thinking: 'omit', effort: 'low' }, {})).toMatchObject({ RENDER_THINKING: 'omit', RENDER_EFFORT: 'low' });
  });

  it('knows the default model\'s price, and takes any other\'s from --price', () => {
    const prices = parsePrices(['claude-sonnet-5-5=1,5']);
    expect(prices.get('claude-haiku-5-5')).toEqual({ input: 0.1, output: 0.5 });
    expect(prices.get('claude-sonnet-5-5')).toEqual({ input: 1, output: 5 });
    expect(() => parsePrices(['claude-sonnet-5-5=1'])).toThrow(/--price/);
  });
});

describe('render:bakeoff --replay', () => {
  it('tables the committed recording with no key, and a model with no cassette as not recorded', async () => {
    const r = io();
    expect(await bakeoffCommand([MESSAGE, '--replay', '--models', 'anthropic:claude-sonnet-5-5:disabled,anthropic:claude-haiku-5-5,anthropic:claude-sonnet-5-5', '--by-line'], r.io)).toBe(0);
    const table = r.out.join('\n');
    expect(table).toMatch(/^anthropic:claude-haiku-5-5\s+36\s+27 \(75%\)\s+9 \(25%\)\s+drift 9\s+not measured\s+-\s+\$\d/m);
    expect(table).toMatch(/^anthropic:claude-sonnet-5-5\s+-\s+-\s+-\s+not recorded/m);
    // A thinking the model refuses (as the server refuses it at start): that model reported, the run going on.
    expect(table).toMatch(/^anthropic:claude-sonnet-5-5:disabled\s+-\s+-\s+-\s+refused/m);
    expect(table).toContain('anthropic:claude-sonnet-5-5:disabled: refused, nothing asked: thinking disabled is refused by claude-sonnet-5-5: it cannot turn thinking off that way (its way is between-tools)');
    expect(table).toContain('anthropic:claude-sonnet-5-5: not recorded (no src/testing/message/fixtures/recorded/render/claude-sonnet-5-5.jsonl)');
    // By line: the line that fell back, with a wording the drift check refused.
    expect(table).toMatch(/^ {2}ask_caller\s+10 tried, 1 generated, 9 fell back: drift 9 {2}e\.g\. drift: ".+"$/m);
    expect(table).toMatch(/^ {2}confirm_take_message\.summary\s+8 tried, 8 generated, 0 fell back$/m);
    // Nothing was recorded: the cassettes are as committed.
    expect(existsSync(join(RECORDED, 'render', 'claude-sonnet-5-5.jsonl'))).toBe(false);
  });

  it('--json: the report alone on stdout', async () => {
    const r = io();
    expect(await bakeoffCommand([MESSAGE, '--replay', '--json', '--models', 'anthropic:claude-haiku-5-5'], r.io), r.all()).toBe(0);
    expect(r.out).toHaveLength(1);
    const report = JSON.parse(r.out[0]!) as BakeoffReport;
    expect(report).toMatchObject({ app: 'message', decisionModel: 'jev-1.13.0', replay: true, budgetMs: { voice: 700, chat: 1500 } });
    expect(report.models[0]).toMatchObject({ status: 'ran', tried: 36, generated: 27, fellBack: { drift: 9 }, untried: 7, wording: { measured: 0, p50: null }, decisionMisses: { turns: 0, checks: 0 } });
    expect(report.models[0]!.byLine).toBeUndefined();
  });
});

describe('render:bakeoff, recording (fake providers)', () => {
  it('records each model into its own cassette, tables them, stops a model whose every request fails, and never prints a key', async () => {
    const dir = recordedCopy();
    const { fetchFn, sent } = fakeProviders();
    const env = { ANTHROPIC_API_KEY: KEY, OPENROUTER_API_KEY: OR_KEY, TYPESAFE_API_KEY: JEV_KEY };
    const r = io({ env, fetchFn, recordedDir: dir, decisionModel: stubDecision() });
    const out = join(dir, 'bakeoff.md');
    const code = await bakeoffCommand([MESSAGE, '--models', 'anthropic:claude-test-5-5,openrouter:vendor/small,anthropic:claude-missing', '--price', 'claude-test-5-5=1,5', '--out', out, '--by-line'], r.io);
    expect(code, r.all()).toBe(0);
    // Each model asked through its own provider, with its own key in its own header.
    expect(new Set(sent.map((s) => `${s.url} ${s.model}`))).toEqual(new Set(['https://api.anthropic.com/v1/messages claude-test-5-5', 'https://openrouter.ai/api/v1/chat/completions vendor/small', 'https://api.anthropic.com/v1/messages claude-missing']));
    expect(sent.filter((s) => s.model === 'vendor/small').every((s) => s.headers.authorization === `Bearer ${OR_KEY}`)).toBe(true);
    const table = r.out.join('\n');
    expect(table).toMatch(/^anthropic:claude-test-5-5\s+36\s+\d+ \(\d+%\)/m);
    expect(table).toMatch(/^openrouter:vendor\/small\s+36\s+/m);
    // A wrong model id: stopped early, with why.
    expect(table).toMatch(/^anthropic:claude-missing\s+5\s+0 \(0%\)\s+5 \(100%\)\s+error 5 \(anthropic: HTTP 404 not_found_error\)/m);
    // With the API's own words (scrubbed: the key it echoed is masked), in the notes and by line.
    expect(table).toContain('anthropic:claude-missing: stopped after 5 lines, every one a failed request: anthropic: HTTP 404 not_found_error (model: claude-missing (key •))');
    expect(table).toMatch(/^ {2}ask_caller\s+3 tried, 0 generated, 3 fell back: error 3 {2}e\.g\. error: "anthropic: HTTP 404 not_found_error: model: claude-missing \(key •\)"$/m);
    expect(sent.filter((s) => s.model === 'claude-missing')).toHaveLength(5);
    // The price given is used; a model with none says so.
    expect(table).toContain('openrouter:vendor/small: wording ');
    expect(table).toContain('no price given (--price vendor/small=<input>,<output>)');
    // Each recorded, with how long its wordings took.
    const test = loadRenderCassette(join(dir, 'render', 'claude-test-5-5.jsonl'));
    expect(test.size).toBe(12);
    expect([...test.values()].every((l) => typeof l.latencyMs === 'number')).toBe(true);
    expect(existsSync(join(dir, 'render', 'vendor__small.jsonl'))).toBe(true);
    expect(existsSync(join(dir, 'render', 'claude-missing.jsonl'))).toBe(false);
    // The drift checks of each model's wordings are kept beside its cassette; the app's own recording is only read.
    expect(existsSync(join(dir, 'render', 'checks', 'claude-test-5-5', 'jev-1.13.0.jsonl'))).toBe(true);
    expect(readFileSync(join(dir, 'jev-1.13.0.jsonl'), 'utf8')).toBe(readFileSync(join(RECORDED, 'jev-1.13.0.jsonl'), 'utf8'));
    expect(table).toMatch(/^anthropic:claude-test-5-5\s+.*\s\d+ \/ \d+\s+0 of 12\s+\$\d/m);
    // The Markdown page: the same table.
    const page = readFileSync(out, 'utf8');
    expect(page).toMatch(/^\| anthropic:claude-test-5-5 \| 36 \| /m);
    expect(page).toContain('## anthropic:claude-test-5-5, by line');
    // No key anywhere it printed or wrote.
    for (const k of [KEY, OR_KEY, JEV_KEY]) {
      expect(r.all()).not.toContain(k);
      expect(page).not.toContain(k);
      expect(readFileSync(join(dir, 'render', 'claude-test-5-5.jsonl'), 'utf8')).not.toContain(k);
    }

    // Tabled again from the cassettes alone, with no key and no request: the same counts and latencies.
    const before = sent.length;
    const again = io({ env: {}, fetchFn, recordedDir: dir, decisionModel: stubDecision() });
    expect(await bakeoffCommand([MESSAGE, '--replay', '--json', '--models', 'anthropic:claude-test-5-5,openrouter:vendor/small,anthropic:claude-missing'], again.io)).toBe(0);
    expect(sent.length).toBe(before);
    const replayed = JSON.parse(again.out[0]!) as BakeoffReport;
    const recorded = r.out.join('\n');
    expect(replayed.models.map((m) => m.status)).toEqual(['ran', 'ran', 'not-recorded']);
    expect(replayed.models[0]!.wording.measured).toBe(12);
    expect(recorded).toContain(`${replayed.models[0]!.wording.p50!.toFixed(0)} / ${replayed.models[0]!.wording.p95!.toFixed(0)}`);
    expect(replayed.models[0]).toMatchObject({ tried: 36, decisionMisses: { turns: 0, checks: 0 } });
  }, 60_000);

  it('counts the wordings that would have run past the app\'s RENDER_TIMEOUT_MS on a call', async () => {
    const dir = recordedCopy();
    const { fetchFn } = fakeProviders({ delayMs: 60 });
    const r = io({ env: { OPENROUTER_API_KEY: OR_KEY, TYPESAFE_API_KEY: JEV_KEY, RENDER_TIMEOUT_MS: '50' }, fetchFn, recordedDir: dir, decisionModel: stubDecision() });
    expect(await bakeoffCommand([MESSAGE, '--json', '--models', 'openrouter:vendor/slow'], r.io), r.all()).toBe(0);
    const report = JSON.parse(r.out[0]!) as BakeoffReport;
    expect(report.budgetMs).toEqual({ voice: 50, chat: 50 });
    // Measured in full under the generous budget, so none fell back as a timeout; every one over the call's.
    const m = report.models[0]!;
    expect(m.fellBack.timeout).toBeUndefined();
    expect(m.wording.measured).toBe(12);
    expect(m.wording.overBudget).toBe(12);
    expect(m.wording.p50!).toBeGreaterThanOrEqual(50);
  }, 60_000);
});

describe('render:bakeoff, an OpenRouter model\'s reasoning', () => {
  it('sends an OpenRouter entry\'s reasoning, records it apart, and says why a model refuses a setting in the API\'s own words', async () => {
    const dir = recordedCopy();
    const { fetchFn, sent } = fakeProviders({ failing: new Set(['vendor/always-reasons']) });
    const r = io({ env: { OPENROUTER_API_KEY: OR_KEY, TYPESAFE_API_KEY: JEV_KEY }, fetchFn, recordedDir: dir, decisionModel: stubDecision() });
    expect(await bakeoffCommand([MESSAGE, '--models', 'openrouter:vendor/think:low,openrouter:vendor/always-reasons'], r.io), r.all()).toBe(0);
    expect(sent.filter((s) => s.model === 'vendor/think').every((s) => JSON.stringify(s.reasoning) === JSON.stringify({ effort: 'low', exclude: true }))).toBe(true);
    // Reasoning off, in OpenRouter's documented form.
    expect(sent.filter((s) => s.model === 'vendor/always-reasons').every((s) => JSON.stringify(s.reasoning) === JSON.stringify({ effort: 'none' }))).toBe(true);
    expect(existsSync(join(dir, 'render', 'vendor__think.thinking-adaptive.effort-low.jsonl'))).toBe(true);
    const table = r.out.join('\n');
    expect(table).toMatch(/^openrouter:vendor\/think \(thinking adaptive, effort low\)\s+36\s+/m);
    expect(table).toContain('openrouter:vendor/always-reasons: stopped after 5 lines, every one a failed request: openrouter: HTTP 400 (Provider returned error (Example: Reasoning is mandatory for this endpoint and cannot be disabled.))');
  }, 60_000);
});

describe('render:bakeoff --fresh', () => {
  /** A copy of the fixture's recordings, the fake providers, and a run of the bake-off on them. */
  function setup(opts: { isAppCassette?: (path: string) => boolean } = {}) {
    const dir = recordedCopy();
    const failing = new Set<string>();
    const failSpans = { on: false };
    const { fetchFn, sent } = fakeProviders({ failing, failSpans });
    const run = async (models: string, ...args: string[]) => {
      const r = io({ env: { ANTHROPIC_API_KEY: KEY, TYPESAFE_API_KEY: JEV_KEY }, fetchFn, recordedDir: dir, decisionModel: stubDecision(), isAppCassette: opts.isAppCassette ?? (() => false) });
      const code = await bakeoffCommand([MESSAGE, '--models', models, ...args], r.io);
      return { code, r, table: r.out.join('\n') };
    };
    return { dir, failing, failSpans, sent, run, cassette: join(dir, 'render', 'claude-test-5-5.jsonl') };
  }

  it('asks every line again into a file beside the cassette, put over it only when the run completes with every line answered', async () => {
    const { run, sent, failing, failSpans, cassette } = setup();
    expect((await run('anthropic:claude-test-5-5')).code).toBe(0);
    const asked = sent.length;
    // Again without --fresh: every line replays, nothing is asked.
    expect((await run('anthropic:claude-test-5-5')).code).toBe(0);
    expect(sent.length).toBe(asked);
    // --fresh: every line asked again, the cassette replaced (its 12 lines, not 24), nothing left beside it.
    const first = readFileSync(cassette, 'utf8');
    const kept = await run('anthropic:claude-test-5-5', '--fresh');
    expect(kept.code).toBe(0);
    expect(sent.length).toBe(asked * 2);
    expect(kept.table).toContain(`anthropic:claude-test-5-5: --fresh: every line asked again, recorded into ${cassette}`);
    expect(loadRenderCassette(cassette).size).toBe(12);
    expect(readFileSync(cassette, 'utf8').trim().split('\n')).toHaveLength(12);
    expect(readFileSync(cassette, 'utf8')).not.toBe(first);
    expect(existsSync(`${cassette}.fresh`)).toBe(false);
    // Only the bake-off's own recordings carry a latency, with the budget they were recorded under.
    expect([...loadRenderCassette(cassette).values()].every((l) => typeof l.latencyMs === 'number' && l.budgetMs === 30_000)).toBe(true);

    // A fresh run in which some requests fail (the spans, overloaded): not kept, the cassette as it was.
    const before = readFileSync(cassette, 'utf8');
    failSpans.on = true;
    const partly = await run('anthropic:claude-test-5-5', '--fresh');
    expect(partly.code).toBe(0);
    expect(partly.table).toMatch(/^anthropic:claude-test-5-5\s+36\s+28 \(78%\)\s+8 \(22%\)\s+error 8 \(anthropic: HTTP 529 overloaded_error\)/m);
    expect(partly.table).toContain(`anthropic:claude-test-5-5: --fresh: not kept (error 8): ${cassette} is as it was, the fresh recording discarded; the table is the fresh run's`);
    expect(partly.table).toContain('anthropic:claude-test-5-5: error anthropic: HTTP 529 overloaded_error: Overloaded');
    expect(readFileSync(cassette, 'utf8')).toBe(before);
    expect(existsSync(`${cassette}.fresh`)).toBe(false);
    failSpans.on = false;

    // A fresh run that is stopped (every request refused): the same.
    failing.add('claude-test-5-5');
    const stopped = await run('anthropic:claude-test-5-5', '--fresh');
    expect(stopped.table).toContain('anthropic:claude-test-5-5: --fresh: not kept (stopped (anthropic: HTTP 400))');
    expect(readFileSync(cassette, 'utf8')).toBe(before);
    failing.delete('claude-test-5-5');

    // A partial file an interrupted run left: said first, in a replay as in a recording; a fresh run starts it again.
    writeFileSync(`${cassette}.fresh`, before.split('\n')[0]! + '\n');
    const replayed = await run('anthropic:claude-test-5-5', '--replay');
    expect(replayed.code).toBe(0);
    expect(replayed.table).toContain(`anthropic:claude-test-5-5: an interrupted --fresh run left ${cassette}.fresh (partial, never tabled); delete it`);
    expect(replayed.table).toMatch(/^anthropic:claude-test-5-5\s+36\s+34 \(94%\)\s+0 \(0%\)\s+said exactly 2/m);
    const again = await run('anthropic:claude-test-5-5', '--fresh');
    expect(again.table).toContain('this fresh run replaced it');
    expect(existsSync(`${cassette}.fresh`)).toBe(false);
    expect(loadRenderCassette(cassette).size).toBe(12);
  }, 120_000);

  it('keeps the app\'s own cassette, recording a fresh run under the comparison\'s name, unless --replace-app-cassette', async () => {
    const { run, cassette, dir } = setup({ isAppCassette: (path) => path.endsWith('claude-test-5-5.jsonl') });
    expect((await run('anthropic:claude-test-5-5')).code).toBe(0);
    const app = readFileSync(cassette, 'utf8');
    const comparison = join(dir, 'render', 'claude-test-5-5.bakeoff.jsonl');
    const fresh = await run('anthropic:claude-test-5-5', '--fresh');
    expect(fresh.code).toBe(0);
    expect(readFileSync(cassette, 'utf8')).toBe(app);
    expect(loadRenderCassette(comparison).size).toBe(12);
    expect(fresh.table).toContain(`recorded into ${comparison}`);
    // From then on the comparison is what the bake-off tables.
    const json = await run('anthropic:claude-test-5-5', '--replay', '--json');
    expect((JSON.parse(json.r.out[0]!) as BakeoffReport).models[0]!.cassette).toBe(comparison);
    // --replace-app-cassette: the app's own replaced, and said what that does to its regression.
    const replaced = await run('anthropic:claude-test-5-5', '--fresh', '--replace-app-cassette');
    expect(replaced.code).toBe(0);
    expect(readFileSync(cassette, 'utf8')).not.toBe(app);
    expect(replaced.table).toContain('anthropic:claude-test-5-5: replaced the app\'s own cassette: the app\'s recording has no drift checks of the new wordings');
    expect((await run('anthropic:claude-test-5-5', '--replace-app-cassette')).code).toBe(2);
  }, 120_000);

  it('on SIGINT or SIGTERM a fresh run\'s partial file is deleted and the process exits, the cassette untouched', () => {
    const dir = recordedCopy();
    const partial = join(dir, 'x.jsonl.fresh');
    writeFileSync(partial, '{}\n');
    const exits: number[] = [];
    const before = process.listeners('SIGTERM').length;
    const unguard = guardFresh(partial, (code) => void exits.push(code));
    const handler = process.listeners('SIGTERM').at(-1) as () => void;
    handler();
    expect(existsSync(partial)).toBe(false);
    expect(exits).toEqual([143]);
    unguard();
    expect(process.listeners('SIGTERM').length).toBe(before);
  });
});

describe('render:bakeoff, what a run counts and when it stops', () => {
  it('a wording past the bake-off\'s own budget is a timeout, counted over the call budget and at that budget', async () => {
    const dir = recordedCopy();
    const { fetchFn } = fakeProviders({ delayMs: 150 });
    const r = io({ env: { OPENROUTER_API_KEY: OR_KEY, TYPESAFE_API_KEY: JEV_KEY }, fetchFn, recordedDir: dir, decisionModel: stubDecision(), recordBudgetMs: 60 });
    expect(await bakeoffCommand([MESSAGE, '--models', 'openrouter:vendor/slow'], r.io), r.all()).toBe(0);
    const table = r.out.join('\n');
    expect(table).toMatch(/^openrouter:vendor\/slow\s+36\s+0 \(0%\)\s+36 \(100%\)\s+timeout 36\s+60 \/ 60\s+12 of 12 \(12 past 60 ms\)/m);
    expect(table).toContain('openrouter:vendor/slow: 12 wordings ran past the bake-off\'s own 60 ms (timeout): counted over the call budget, and at 60 ms in the percentiles');
  }, 60_000);

  it('the decision model failing out stops the comparison, the models before it still tabled', async () => {
    const dir = recordedCopy();
    // No recording of the decision model: every turn asks it, and it fails once the first model has run.
    rmSync(join(dir, 'jev-1.13.0.jsonl'));
    const stub = stubDecision();
    let failing = false;
    const flaky = { ask: (req: Parameters<HeuristicStubClient['ask']>[0]) => (failing ? Promise.reject(new JevClientError('the decision model is down')) : stub.ask(req)) };
    const { fetchFn } = fakeProviders();
    const r = io({ env: { ANTHROPIC_API_KEY: KEY, TYPESAFE_API_KEY: JEV_KEY }, fetchFn, recordedDir: dir, decisionModel: flaky });
    r.io.err = (line) => {
      r.err.push(line);
      if (line.includes('anthropic:claude-test-5-5: scenario 7/7')) failing = true;
    };
    const code = await bakeoffCommand([MESSAGE, '--models', 'anthropic:claude-test-5-5,anthropic:claude-second-5-5'], r.io);
    const table = r.out.join('\n');
    expect(code).toBe(1);
    expect(table).toMatch(/^anthropic:claude-test-5-5\s+\d+\s+/m);
    expect(table).not.toMatch(/^anthropic:claude-second-5-5/m);
    expect(table).toMatch(/^the comparison stopped: anthropic:claude-second-5-5: the decision model failed 3 turns running: .*; the models before it are tabled$/m);
  }, 60_000);

  it('two entries that name one recording are refused', async () => {
    const r = io();
    expect(await bakeoffCommand([MESSAGE, '--replay', '--models', 'anthropic:claude-haiku-5-5,anthropic:claude-haiku-5-5:disabled'], r.io)).toBe(2);
    expect(r.err[0]).toContain('"anthropic:claude-haiku-5-5" and "anthropic:claude-haiku-5-5:disabled" name the same recording');
  });
});

describe('render:bakeoff refuses', () => {
  it('to record in CI, and without the keys each model and the drift checks need, naming the variables and never a value', async () => {
    const ci = io({ env: { CI: 'true', ANTHROPIC_API_KEY: KEY, TYPESAFE_API_KEY: JEV_KEY } });
    expect(await bakeoffCommand([MESSAGE, '--models', 'anthropic:claude-haiku-5-5'], ci.io)).toBe(1);
    expect(ci.err.join('\n')).toContain('it does not record in CI');
    // In CI, a replay is fine.
    const ciReplay = io({ env: { CI: 'true' } });
    expect(await bakeoffCommand([MESSAGE, '--replay', '--models', 'anthropic:claude-haiku-5-5'], ciReplay.io)).toBe(0);

    const keys = io({ env: { ANTHROPIC_API_KEY: KEY } });
    expect(await bakeoffCommand([MESSAGE, '--models', 'anthropic:claude-haiku-5-5,openrouter:vendor/small'], keys.io)).toBe(1);
    const said = keys.err.join('\n');
    expect(said).toContain('TYPESAFE_API_KEY (the decision model: its drift checks of every line)');
    expect(said).toContain('OPENROUTER_API_KEY (openrouter:vendor/small)');
    expect(said).not.toContain('ANTHROPIC_API_KEY');
    expect(said).not.toContain(KEY);
    expect(said).toContain('--replay');
  });

  it('a command line it does not understand, a folder that is not an app, and an app that generates no line', async () => {
    const none = io();
    expect(await bakeoffCommand([MESSAGE, '--replay'], none.io)).toBe(2);
    expect(none.err[0]).toContain('names no model');
    expect(none.err[0]).toContain(BAKEOFF_USAGE);
    const bad = io();
    expect(await bakeoffCommand([MESSAGE, '--replay', '--models', 'haiku'], bad.io)).toBe(2);
    const folder = io();
    expect(await bakeoffCommand([PACKAGE_DIR, '--replay', '--models', 'anthropic:claude-haiku-5-5'], folder.io)).toBe(2);
    expect(folder.err[0]).toContain('is not an app folder');
    const plain = io();
    expect(await bakeoffCommand([join(PACKAGE_DIR, 'src/testing/callback'), '--replay', '--models', 'anthropic:claude-haiku-5-5'], plain.io)).toBe(1);
    expect(plain.err[0]).toContain('generates no line');
  });
});
