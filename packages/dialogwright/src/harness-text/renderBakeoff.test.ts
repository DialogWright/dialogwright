import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { resetAppsForTest } from '../core/app/registry';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { SHORT_TMP } from '../testing/shortTmp';
import { envForModel, parseModelSpecs, parsePrices, type BakeoffReport } from './renderBakeoff';
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
function fakeProviders(opts: { delayMs?: number } = {}) {
  const sent: { url: string; model: string; headers: Record<string, string> }[] = [];
  const fake = new FakeRenderClient();
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init!.body)) as { model: string; system?: string; messages: { role: string; content: string }[] };
    sent.push({ url: String(url), model: body.model, headers: init!.headers as Record<string, string> });
    if (body.model === 'claude-missing') return new Response(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `model: claude-missing (key ${KEY})` } }), { status: 404 });
    const act = JSON.parse(body.messages.at(-1)!.content) as RenderAct;
    const g = await fake.generate({ promptId: 'line', act, key: '' }, new AbortController().signal);
    if (opts.delayMs !== undefined) await new Promise((r) => setTimeout(r, opts.delayMs));
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
    expect(parseModelSpecs(['anthropic:claude-haiku-5-5,openrouter:vendor/small:free', 'anthropic:claude-haiku-5-5:adaptive:low'])).toEqual([
      { entry: 'anthropic:claude-haiku-5-5', provider: 'anthropic', model: 'claude-haiku-5-5' },
      { entry: 'openrouter:vendor/small:free', provider: 'openrouter', model: 'vendor/small:free' },
      { entry: 'anthropic:claude-haiku-5-5:adaptive:low', provider: 'anthropic', model: 'claude-haiku-5-5', thinking: 'adaptive', effort: 'low' },
    ]);
    expect(() => parseModelSpecs([])).toThrow(/names no model/);
    expect(() => parseModelSpecs(['claude-haiku-5-5'])).toThrow(/start it with its provider/);
    expect(() => parseModelSpecs(['anthropic:claude-haiku-5-5:thinking'])).toThrow(/its thinking must be/);
    expect(() => parseModelSpecs(['anthropic:claude-haiku-5-5:adaptive:max'])).toThrow(/its effort must be/);
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
    expect(await bakeoffCommand([MESSAGE, '--replay', '--models', 'anthropic:claude-haiku-5-5,anthropic:claude-sonnet-5-5', '--by-line'], r.io)).toBe(0);
    const table = r.out.join('\n');
    expect(table).toMatch(/^anthropic:claude-haiku-5-5\s+36\s+26 \(72%\)\s+10 \(28%\)\s+drift 10\s+not measured\s+-\s+\$\d/m);
    expect(table).toMatch(/^anthropic:claude-sonnet-5-5\s+-\s+-\s+-\s+not recorded/m);
    expect(table).toContain('anthropic:claude-sonnet-5-5: not recorded (no src/testing/message/fixtures/recorded/render/claude-sonnet-5-5.jsonl)');
    // By line: the line that fell back, with a wording the drift check refused.
    expect(table).toMatch(/^ {2}ask_caller\s+10 tried, 0 generated, 10 fell back: drift 10 {2}e\.g\. drift: ".+"$/m);
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
    expect(report.models[0]).toMatchObject({ status: 'ran', tried: 36, generated: 26, fellBack: { drift: 10 }, untried: 7, wording: { measured: 0, p50: null }, decisionMisses: { turns: 0, checks: 0 } });
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
    expect(table).toContain('anthropic:claude-missing: stopped after 5 lines, every one a failed request: anthropic: HTTP 404 not_found_error');
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
