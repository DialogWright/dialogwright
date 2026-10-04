// Test support only: never imported by the widget itself, and kept out of the bundle (bundle.test.ts).
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { startServer, type RunningServer } from 'dialogwright';
import { loadConfig } from 'dialogwright/server/config';
import { registerApp, resetAppsForTest } from 'dialogwright/core/app/registry';
import type { App } from 'dialogwright/core/app/types';
import { testkitApp } from 'dialogwright/testing/testkit/index';
import { loadCorpus } from 'dialogwright/jev/corpus';
import { FixtureStubClient } from 'dialogwright/jev/fixtureStub';
import { HeuristicStubClient } from 'dialogwright/jev/heuristicStub';
import { DEFAULT_THRESHOLDS } from 'dialogwright/core/thresholds';
import webScenarios from 'dialogwright/testing/testkit/fixtures/scenarios/web.json';

/** The site the tests' pages are on: what their sockets send as Origin. */
export const TEST_ORIGIN = 'http://localhost:5173';
const TODAY = '2026-09-18';

/** The testkit's own folder, wherever the workspace put the engine. */
const testkitDir = dirname(createRequire(import.meta.url).resolve('dialogwright/testing/testkit/index'));
const corpus = loadCorpus(join(testkitDir, 'fixtures', 'corpus.jsonl'), testkitApp);

/** The testkit's web chat scenario (web.json): what a person types first, then the customer who signs in. */
const scenario = (webScenarios as Array<{ id: string; steps: Array<{ say?: string; signIn?: string }> }>).find((s) => s.id === 'web-signin-track')!;

export interface TestServer {
  running: RunningServer;
  /** ws://localhost:<port>/chat */
  chatUrl: string;
  /** What the testkit's web chat scenario types first. */
  opener: string;
  /** A customer the testkit signs in (the scenario's sign-in step). */
  subjectId: string;
  /** A line the testkit's corpus labels as asking for a person: the chat is transferred. */
  agentLine: string;
  close(): Promise<void>;
}

/**
 * The engine's server with its web chat on, for a page at TEST_ORIGIN, mock sign-in (a laptop's),
 * on a free port. The app is the testkit unless `app` names another; `env` adds or replaces variables.
 */
export async function startTestServer(o: { app?: App; env?: Record<string, string> } = {}): Promise<TestServer> {
  resetAppsForTest();
  registerApp(o.app ?? testkitApp);
  const dir = mkdtempSync(join(tmpdir(), 'widget-'));
  const config = loadConfig({
    PUBLIC_HOST: 'localhost',
    TWILIO_AUTH_TOKEN: 't',
    HANDOFF_NUMBER: '+15551234567',
    PORT: '0',
    SIGNATURE_CHECK: 'off',
    TODAY_OVERRIDE: TODAY,
    TRACE_DIR: dir,
    AUDIT_DIR: join(dir, 'audit'),
    AUDIO_DIR: dir,
    DASHBOARD: 'off',
    CHAT: 'on',
    CHAT_ALLOWED_ORIGINS: TEST_ORIGIN,
    CHAT_SIGNIN: 'mock',
    ...o.env,
  });
  const fallback = new HeuristicStubClient({ todayIso: TODAY });
  const client = o.app === undefined ? new FixtureStubClient(corpus, { sharpness: DEFAULT_THRESHOLDS.STUB_SHARPNESS, fallback }) : fallback;
  const running = await startServer(config, { client, log: () => {} });
  const agent = corpus.find((e) => e.intent === 'agent' && e.context === 'no_form');
  return {
    running,
    chatUrl: `ws://localhost:${running.port}/chat`,
    opener: scenario.steps.find((s) => s.say !== undefined)!.say!,
    subjectId: scenario.steps.find((s) => s.signIn !== undefined)!.signIn!,
    agentLine: agent!.text,
    async close() {
      await running.close();
      // The server's side of each socket closes after the client's: let it, before the trace directory goes.
      await new Promise((resolve) => setTimeout(resolve, 20));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
