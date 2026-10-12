import { describe, expect, it } from 'vitest';
import { callbackApp } from '../testing/callback/app';
import { messageApp } from '../testing/message/app';
import { RenderCassette } from './cassette';
import { FakeRenderClient } from './fake';
import { emptyRenderTally, formatRenderTally, harnessRenderer, tallyRender } from './harness';
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

describe('the run\'s line about its generated lines', () => {
  it('tried, said generated, fell back with the rate and reasons, and those said fixed untried', () => {
    const t = emptyRenderTally();
    const record = (lines: object[]): TraceRecord => ({ render: { group: 'generated', share: 100, lines, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001 } } }) as unknown as TraceRecord;
    tallyRender(t, record([{ mode: 'generated' }, { mode: 'fixed', fallback: 'items' }, { mode: 'fixed', fallback: 'items' }, { mode: 'fixed', skipped: 'when' }]));
    tallyRender(t, record([{ mode: 'fixed', fallback: 'timeout' }]));
    expect(formatRenderTally(t)).toBe('generated lines  4 tried, 1 said generated, 3 fell back (75.0%): items 2, timeout 1; 1 said fixed untried');
  });
});
