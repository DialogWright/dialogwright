import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type RunningServer } from './index';
import { loadConfig } from './config';
import { FakeRelay } from '../testing/fakeRelay';
import { registerApp, resetAppsForTest } from '../core/app/registry';
import type { App, ToolContext, ToolReply } from '../core/app/types';
import type { ToolCall } from '../gate/types';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { TOOLS, textingCode } from '../testing/texting/app';
import { both, replace, textingVariants } from '../testing/texting/variant';

/**
 * A call-start lookup that waits on its system, on the phone (Twilio's relay and Telnyx's): the welcome
 * goes to the caller at once, the lookup runs while it plays, and the greeting follows once the lookup
 * has replied. The lookup here replies only when the test lets it, so the welcome is seen to go out
 * before the greeting exists. No model is asked.
 */

const WELCOME = 'Thanks for calling. This call may be recorded.';
const GREETING = 'Thanks for calling Example Requests. I can open a request. How can I help?';

const variants = textingVariants();
afterAll(() => variants.remove());

/** The lookup's reply, held until the test releases it. */
class GatedLookup {
  private release: (() => void) | null = null;
  private onAsk: () => void = () => {};
  readonly asked = new Promise<void>((resolve) => { this.onAsk = resolve; });
  run(call: ToolCall, sys: unknown, ctx: ToolContext): Promise<ToolReply> {
    this.onAsk();
    return new Promise((resolve) => {
      this.release = () => resolve(TOOLS.findCallerByPhone!.run(call, sys, ctx) as ToolReply);
    });
  }
  reply(): void {
    this.release?.();
  }
}

let built = 0;
function appWith(lookup: GatedLookup): App {
  const code = { ...textingCode, tools: { ...TOOLS, findCallerByPhone: { ...TOOLS.findCallerByPhone!, run: (call: ToolCall, sys: unknown, ctx: ToolContext) => lookup.run(call, sys, ctx) } } };
  return variants.variant({
    'app.yaml': both(replace('id: texting', `id: texting-welcome-${++built}`), (t) => `${t}\nwaiting:\n  start: welcome_hold\n`),
    'prompts.yaml': replace('  greeting:\n', `  welcome_hold:\n    text: ${WELCOME}\n    interruptible: false\n  greeting:\n`),
  }, code);
}

const { publicKey } = generateKeyPairSync('ed25519');
const TELNYX_PUBLIC_KEY = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

let running: RunningServer | null = null;
const dirs: string[] = [];
afterEach(async () => {
  await running?.close();
  running = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function start(app: App): Promise<string> {
  resetAppsForTest();
  registerApp(app);
  const traceDir = mkdtempSync(join(tmpdir(), 'tool-wait-'));
  dirs.push(traceDir);
  const config = loadConfig({
    PUBLIC_HOST: 'localhost', TWILIO_AUTH_TOKEN: 't', VOICE_PROVIDERS: 'twilio,telnyx', TELNYX_PUBLIC_KEY, HANDOFF_NUMBER: '+15551234567', PORT: '0', SIGNATURE_CHECK: 'off',
    TODAY_OVERRIDE: '2026-09-18', TRACE_DIR: traceDir, AUDIT_DIR: join(traceDir, 'audit'), AUDIO_DIR: traceDir, DASHBOARD: 'off',
  });
  running = await startServer(config, { host: '127.0.0.1', client: new HeuristicStubClient(), log: () => {} });
  return `ws://127.0.0.1:${running.port}`;
}

describe('a call-start lookup behind the welcome', () => {
  for (const carrier of ['twilio', 'telnyx'] as const) {
    it(`${carrier}: the welcome goes out while the lookup runs, and the greeting once it has replied`, async () => {
      const lookup = new GatedLookup();
      const ws = await start(appWith(lookup));
      const path = carrier === 'twilio' ? '/conversation' : '/conversation/telnyx';
      const relay = await FakeRelay.connect(`${ws}${path}?token=${carrier === 'twilio' ? running!.tokens.mint('CA-wait') : running!.tokens.mint('CA-wait', 'telnyx')}`);
      try {
        // Telnyx sends the caller's number in customParameters (server/voice/telnyx.ts setupCallerOf).
        relay.setup('CA-wait', undefined, carrier === 'twilio' ? { from: '+15555550142' } : { from: null, customParameters: { telnyx_call_from: '+15555550142' } });
        await lookup.asked;
        // The lookup has not replied: the welcome has gone out, alone.
        expect((await relay.waitForTexts(1)).map((t) => t.trim())).toEqual([WELCOME]);
        lookup.reply();
        if (carrier === 'telnyx') {
          // A reply of its own: the greeting waits until Telnyx reports the welcome played.
          await new Promise((r) => setTimeout(r, 300));
          expect(relay.texts()).toHaveLength(1);
          relay.send({ type: 'info', name: 'agentSpeaking', value: 'on' });
          relay.send({ type: 'info', name: 'tokensPlayed', value: WELCOME });
        }
        const texts = await relay.waitForTexts(2);
        expect(texts.map((t) => t.trim())).toEqual([WELCOME, GREETING]);
      } finally {
        relay.close();
      }
    });
  }
});
