import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type RunningServer } from './index';
import { loadConfig } from './config';
import { registerApp, resetAppsForTest } from '../core/app/registry';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { libraryApp } from '../define/fixture/app';
import { routedApp } from '../testing/routed/app';
import type { App } from '../core/app/types';

/**
 * The server says at start what its carriers would be sent of the app's languages (channel/speechLanguages.ts),
 * as pnpm check and pnpm diagnose do: the live findings of 2026-10-13.
 */

/** A throwaway Telnyx public key, made for the test. */
const TEST_KEY = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');

let running: RunningServer | null = null;
const dirs: string[] = [];
afterEach(async () => {
  await running?.close();
  running = null;
  resetAppsForTest();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function startLogs(app: App, env: Record<string, string> = {}, appEnv: Record<string, string> = {}): Promise<string[]> {
  resetAppsForTest();
  registerApp(app);
  const dir = mkdtempSync(join(tmpdir(), 'languages-'));
  dirs.push(dir);
  const config = loadConfig({ PUBLIC_HOST: 'localhost', TWILIO_AUTH_TOKEN: 't', HANDOFF_NUMBER: '+15551234567', PORT: '0', SIGNATURE_CHECK: 'off', TRACE_DIR: dir, AUDIT_DIR: join(dir, 'audit'), AUDIO_DIR: dir, ...env });
  const logs: string[] = [];
  running = await startServer(config, { host: '127.0.0.1', client: new HeuristicStubClient({ app }), log: (l) => logs.push(l), env: appEnv });
  return logs;
}

describe('the languages at start', () => {
  it('warns of a locale with no region on Twilio, and of a language beside the server\'s English-only flux', async () => {
    const logs = (await startLogs(libraryApp)).filter((l) => l.startsWith('WARNING: the locale es'));
    expect(logs).toEqual([
      expect.stringMatching(/^WARNING: the locale es is spoken and heard as "es" .*: Twilio will refuse its calls' start document; set voice\.locales\.es\.tts and voice\.locales\.es\.transcription to a tag with its region, such as es-US or es-MX$/),
      expect.stringMatching(/^WARNING: the locale es \(heard as es\) names no recognizer of its own on Twilio, while en-US is heard with Deepgram flux \(the server's\), which hears English only: .*; name a recognizer that hears es for the locale: voice\.locales\.es\.recognition\.twilio: \{ provider: Deepgram, model: nova-3-general \}$/),
    ]);
    // With a model that hears more than English, the tag alone; on Telnyx alone, the tag without Twilio's refusal.
    expect((await startLogs(libraryApp, { TWILIO_SPEECH_MODEL: 'nova-3-general' })).filter((l) => l.startsWith('WARNING: the locale es'))).toHaveLength(1);
    const telnyx = (await startLogs(libraryApp, { VOICE_PROVIDERS: 'telnyx', TELNYX_PUBLIC_KEY: TEST_KEY })).filter((l) => l.startsWith('WARNING: the locale es'));
    expect(telnyx).toEqual([expect.stringContaining('whether Telnyx takes one is not known; set voice.locales.es.tts')]);
  });

  it('says nothing of an app whose locales name their regions and a recognizer that hears them', async () => {
    const lines = { SPANISH_LINE: '+15555550142', MAIN_LINE: '+15555550100', VIP_DESK: '+15555550101', AFTER_HOURS_DESK: '+15555550102' };
    expect((await startLogs(routedApp, {}, lines)).filter((l) => l.includes('the locale es'))).toEqual([]);
  });
});
