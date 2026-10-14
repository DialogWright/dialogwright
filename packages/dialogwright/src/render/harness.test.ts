import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { callbackApp } from '../testing/callback/app';
import { messageApp } from '../testing/message/app';
import { RenderCassette } from './cassette';
import { FakeRenderClient } from './fake';
import { emptyRenderTally, formatRenderTally, harnessRenderer, replayedRenderCassette, replayedRenderProvider, stubRenderer, tallyRender } from './harness';
import { afterAll } from 'vitest';
import { runAll } from '../harness-text/runAll';
import { buildClient } from '../run/client';
import { registerApp, resetAppsForTest } from '../core/app/registry';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { MESSAGE_DIR } from '../testing/message/app';
import { EXACT_FRAME, messageVariants } from '../testing/message/variant';
import type { Scenario } from '../harness-text/runner';
import { ModelRenderClient } from './providers';
import type { TraceRecord } from '../trace/types';

/** How a regression words an app's generated lines, by its client kind, and the line it prints about them. */

describe('harnessRenderer', () => {
  it('none for an app that generates nothing, whatever the kind: its run is as it was', () => {
    for (const kind of ['stub', 'heuristic', 'recorded', 'record', 'jev']) expect(harnessRenderer(kind, callbackApp, '/x', { env: { RENDER_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k' } })).toEqual({ renderer: null, header: [] });
  });

  it('the fake renderer on the stubs, asking no model and reading no key', () => {
    const r = harnessRenderer('stub', messageApp, '/x', { env: {} });
    expect(r.renderer!.client).toBeInstanceOf(FakeRenderClient);
    expect(r.header).toEqual(['generated lines worded by the fake renderer (no model asked)']);
  });

  it('a recorded run replays the render cassette of the model named, Anthropic\'s default with none, no key needed', () => {
    const r = harnessRenderer('recorded', messageApp, '/rec', { env: {} });
    expect(r.renderer!.client).toBeInstanceOf(RenderCassette);
    expect((r.renderer!.client as RenderCassette).path).toBe('/rec/render/claude-haiku-5-5.jsonl');
    expect(harnessRenderer('recorded', messageApp, '/rec', { env: { RENDER_PROVIDER: 'openrouter', RENDER_MODEL: 'vendor/fast' } }).renderer!.client.model).toBe('vendor/fast');
  });

  it('record and jev reach the model with the author\'s key (record through the cassette); fixed with RENDER_PROVIDER unset or --render fixed', () => {
    const env = { RENDER_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-test-not-real' };
    expect(harnessRenderer('record', messageApp, '/rec', { env }).renderer!.client).toBeInstanceOf(RenderCassette);
    expect(harnessRenderer('jev', messageApp, '/rec', { env }).renderer!.client).toBeInstanceOf(ModelRenderClient);
    expect(harnessRenderer('record', messageApp, '/rec', { env: {} })).toEqual({ renderer: null, header: ['generated lines said fixed (RENDER_PROVIDER unset)'] });
    expect(harnessRenderer('stub', messageApp, '/rec', { env, render: 'fixed' })).toEqual({ renderer: null, header: ['generated lines said fixed (--render fixed)'] });
    expect(() => harnessRenderer('stub', messageApp, '/rec', { render: 'fancy' })).toThrow('--render must be fixed');
  });
});

describe('the model an app names in style.yaml (live findings item 27)', () => {
  const named = { ...messageApp, generated: { ...messageApp.generated!, model: { provider: 'openrouter' as const, id: 'google/gemini-3.1-flash-lite-preview' } } };

  it('a recorded run replays its cassette, the environment over it', () => {
    expect(replayedRenderCassette(named, '/rec', {})).toBe('/rec/render/google__gemini-3.1-flash-lite-preview.jsonl');
    expect((harnessRenderer('recorded', named, '/rec', { env: {} }).renderer!.client as RenderCassette).path).toBe('/rec/render/google__gemini-3.1-flash-lite-preview.jsonl');
    expect(replayedRenderCassette(named, '/rec', { RENDER_PROVIDER: 'openrouter', RENDER_MODEL: 'vendor/fast' })).toBe('/rec/render/vendor__fast.jsonl');
    // A stray RENDER_MODEL without RENDER_PROVIDER is not read over the app's model.
    expect(replayedRenderCassette(named, '/rec', { RENDER_MODEL: 'claude-sonnet-5-5' })).toBe('/rec/render/google__gemini-3.1-flash-lite-preview.jsonl');
    // RENDER_PROVIDER naming another provider replaces the app's: its default model, or RENDER_MODEL with it.
    expect(replayedRenderCassette(named, '/rec', { RENDER_PROVIDER: 'anthropic' })).toBe('/rec/render/claude-haiku-5-5.jsonl');
    expect(replayedRenderProvider(named, { RENDER_PROVIDER: 'anthropic', RENDER_MODEL: 'claude-sonnet-5-5' })).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5-5' });
    // An app that names none: Anthropic's default, as before.
    expect(replayedRenderCassette(messageApp, '/rec', {})).toBe('/rec/render/claude-haiku-5-5.jsonl');
  });

  it('record and jev reach it with its key; without the key its lines are said fixed, and the header says why', () => {
    const env = { OPENROUTER_API_KEY: 'or-test-not-real' };
    expect(harnessRenderer('jev', named, '/rec', { env }).renderer!.client.model).toBe('google/gemini-3.1-flash-lite-preview');
    expect((harnessRenderer('record', named, '/rec', { env }).renderer!.client as RenderCassette).path).toBe('/rec/render/google__gemini-3.1-flash-lite-preview.jsonl');
    for (const kind of ['record', 'jev']) {
      expect(harnessRenderer(kind, named, '/rec', { env: {} })).toEqual({ renderer: null, header: ["generated lines said fixed (style.yaml's model, openrouter google/gemini-3.1-flash-lite-preview, and OPENROUTER_API_KEY is unset)"] });
    }
  });
});

describe('the run\'s line about its generated lines', () => {
  it('tried, said generated, fell back with the rate and reasons, and those said fixed untried', () => {
    const t = emptyRenderTally();
    const record = (lines: object[]): TraceRecord => ({ render: { group: 'generated', share: 100, lines, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001 } } }) as unknown as TraceRecord;
    tallyRender(t, record([{ mode: 'generated' }, { mode: 'fixed', fallback: 'items' }, { mode: 'fixed', fallback: 'items' }, { mode: 'fixed', skipped: 'when' }]));
    tallyRender(t, record([{ mode: 'fixed', fallback: 'timeout' }]));
    expect(formatRenderTally(t)).toBe('generated lines  4 tried, 1 said generated, 3 fell back (75.0%): items 2, timeout 1; 1 said fixed untried');
  });

  it('a failed request\'s fallbacks grouped by why, so a failed run says why; and each line\'s latency, p50 and p95', () => {
    const t = emptyRenderTally();
    const record = (lines: object[]): TraceRecord => ({ render: { group: 'generated', share: 100, lines } }) as unknown as TraceRecord;
    const refused = { mode: 'fixed', fallback: 'error', error: { reason: 'anthropic: HTTP 400 invalid_request_error', message: 'thinking.type: not supported' } };
    tallyRender(t, record(Array.from({ length: 36 }, (_, i) => ({ ...refused, ms: 100 + i }))));
    expect(formatRenderTally(t)).toBe('generated lines  36 tried, 0 said generated, 36 fell back (100.0%): error 36 (anthropic: HTTP 400 invalid_request_error); latency ms p50 117 p95 134');
    tallyRender(t, record([{ mode: 'fixed', fallback: 'error', error: { reason: 'anthropic: TypeError' }, ms: 700 }, { mode: 'fixed', fallback: 'drift', ms: 900 }, { mode: 'generated', ms: 400 }]));
    expect(formatRenderTally(t)).toBe('generated lines  39 tried, 1 said generated, 38 fell back (97.4%): drift 1, error 37 (anthropic: HTTP 400 invalid_request_error 36; anthropic: TypeError 1); latency ms p50 119 p95 700');
  });

  it('a run that changes how the model thinks records and replays a cassette of its own', () => {
    const env = { RENDER_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-test-not-real', RENDER_THINKING: 'adaptive', RENDER_EFFORT: 'low' };
    const rec = harnessRenderer('record', messageApp, '/rec', { env });
    expect(rec.header).toEqual(['generated lines worded by claude-haiku-5-5 from anthropic (thinking adaptive, effort low)', `render cassette ${join('/rec', 'render', 'claude-haiku-5-5.thinking-adaptive.effort-low.jsonl')}`]);
    expect((harnessRenderer('recorded', messageApp, '/rec', { env }).renderer!.client as RenderCassette).path).toBe(join('/rec', 'render', 'claude-haiku-5-5.thinking-adaptive.effort-low.jsonl'));
    expect((harnessRenderer('recorded', messageApp, '/rec', { env: {} }).renderer!.client as RenderCassette).path).toBe(join('/rec', 'render', 'claude-haiku-5-5.jsonl'));
  });
});

describe('stubRenderer: the renderer an app\'s own test runs its scripted calls with (the secretary\'s review, live findings item 21)', () => {
  const variants = messageVariants();
  afterAll(() => {
    variants.remove();
    resetAppsForTest();
  });

  it('is the stub regression\'s: the fake renderer with RENDER_SHARE and the budgets from the environment; none for an app that generates nothing', () => {
    const r = stubRenderer(messageApp, { RENDER_SHARE: '40', RENDER_TIMEOUT_MS: '900' })!;
    const regress = harnessRenderer('stub', messageApp, '/x', { env: { RENDER_SHARE: '40', RENDER_TIMEOUT_MS: '900' } }).renderer!;
    expect(r.client).toBeInstanceOf(FakeRenderClient);
    expect({ ...r, client: null }).toEqual({ ...regress, client: null });
    expect(r.share).toBe(40);
    expect(stubRenderer(callbackApp, {})).toBeNull();
  });

  it('says a framed line in a scripted call as regress does: a call that expects its summary frame passes with it, and would fail without one', async () => {
    const app = variants.variant(EXACT_FRAME);
    resetAppsForTest();
    registerApp(app);
    const corpusFile = join(MESSAGE_DIR, 'fixtures', 'corpus.jsonl');
    const scenario: Scenario = {
      id: 'summary-frame',
      steps: [{ say: 'can I leave a message for Dana' }, { say: "it's Morgan Lee" }, { say: 'five five five five five five zero one four two' }, { say: 'please call me about the March invoice before Friday, I think we were charged twice for the same delivery' }],
      expect: { decision: 'prompt', promptId: 'confirm_take_message', text: 'called and said, in short, please call me about the March invoice before Friday. Shall I pass it on?' },
    };
    const run = async (renderer: ReturnType<typeof stubRenderer>) => (await runAll([], [scenario], { client: buildClient('stub', corpusFile, { ...DEFAULT_THRESHOLDS }, '2026-10-14'), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-10-14', now: () => 0, renderer })).scenarios['summary-frame']!;
    expect((await run(stubRenderer(app, {}))).mismatches).toEqual([]);
    expect((await run(null)).mismatches).toEqual([expect.stringContaining('called and said: please call me about the March invoice before Friday')]);
  });
});
