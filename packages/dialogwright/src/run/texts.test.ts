import { beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import type { App, ToolDef } from '../core/app/types';
import { registerApp, resetAppsForTest } from '../core/app/registry';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { loadScenarios, runScenario, type ScenarioRun } from '../harness-text/runner';
import { loadCorpus } from '../jev/corpus';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { CALLBACK_DIR, callbackApp } from '../testing/callback/app';
import { fakeTextProvider, TextKeys } from '../texts/record';
import type { RunOptions } from './turn';

/**
 * A tool that texts (ToolContext.texts): the run's sender is the server's provider from the app's number,
 * each text recorded in the turn's audit (text_sent) and trace (TraceRecord.texts), the number by its last
 * four and the words by their length. With no sender the tool is given none, and nothing is sent. The
 * fixture callback line's write texts the callback number here; the provider is a fake: no test sends a text.
 */

const TODAY = '2026-10-09';
const FIXTURES = join(CALLBACK_DIR, 'fixtures');

/** The callback's write, texting the callback number that the callback is set up. */
const texting: ToolDef = {
  ...callbackApp.tools.requestCallback!,
  async run(call, sys, ctx) {
    const done = await callbackApp.tools.requestCallback!.run(call, sys, ctx);
    await ctx.texts?.send({ to: call.params.phone ?? '', body: 'Your callback is set up.', ...(ctx.idempotencyKey !== undefined ? { key: ctx.idempotencyKey } : {}) });
    return done;
  },
};
const app: App = { ...callbackApp, tools: { ...callbackApp.tools, requestCallback: texting } };

beforeAll(() => {
  resetAppsForTest();
  registerApp(app);
});

/** A callback set up and confirmed, with the sender given (or none). */
async function callback(texts: RunOptions['texts']): Promise<ScenarioRun> {
  const corpus = loadCorpus(join(FIXTURES, 'corpus.jsonl'), app);
  const client = new FixtureStubClient(corpus, { sharpness: DEFAULT_THRESHOLDS.STUB_SHARPNESS, fallback: new HeuristicStubClient({ todayIso: TODAY }) });
  const scenario = loadScenarios(join(FIXTURES, 'scenarios')).find((s) => s.id === 'standard-queue')!;
  return runScenario(scenario, { client, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, now: () => 0, texts });
}

describe('a tool that texts', () => {
  it('sends through the run\'s sender, from the app\'s number, recorded in the turn\'s audit and trace with no number whole and no words', async () => {
    const provider = fakeTextProvider();
    const run = await callback({ provider, from: '+15555550100', keys: new TextKeys() });
    expect(run.pass).toBe(true);
    const yes = run.runs.at(-1)!;
    expect(provider.sent).toEqual([expect.objectContaining({ from: '+15555550100', body: 'Your callback is set up.' })]);
    expect(provider.sent[0]!.to).toBe('5555550142');
    expect(yes.record.texts).toEqual([{ direction: 'sent', number: '...0142', bodyLength: 24, media: 0, id: 'SMfake1', status: 'queued', provider: 'fake' }]);
    const row = yes.result.audit.find((d) => d.type === 'text_sent');
    expect(row).toEqual({ type: 'text_sent', detail: { number: '...0142', bodyLength: 24, media: 0, id: 'SMfake1', status: 'queued', provider: 'fake' } });
    expect(JSON.stringify(yes.record.texts)).not.toContain('5555550142');
    // The text's row follows what the turn did (the write's own gate row and result).
    expect(yes.result.audit.findIndex((d) => d.type === 'text_sent')).toBe(yes.result.audit.length - 1);
  });

  it('with no sender, the tool is given none: nothing sent, nothing recorded', async () => {
    const run = await callback(null);
    expect(run.pass).toBe(true);
    const yes = run.runs.at(-1)!;
    expect(yes.record.texts).toBeUndefined();
    expect(yes.result.audit.some((d) => d.type === 'text_sent')).toBe(false);
    expect(yes.result.gateEvents.some((e) => e.decision.call.tool === 'requestCallback' && e.decision.verdict === 'ALLOW')).toBe(true);
  });
});
