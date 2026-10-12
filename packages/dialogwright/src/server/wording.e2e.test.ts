import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type RunningServer } from './index';
import { loadConfig } from './config';
import { FakeRelay } from '../testing/fakeRelay';
import { registerApp, resetAppsForTest } from '../core/app/registry';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { FakeRenderClient } from '../render/fake';
import { messageApp } from '../testing/message/app';
import type { Renderer } from '../render/types';

/**
 * Generated wording on the phone line: an app that generates lines gets its renderer from its own
 * settings (none with RENDER_PROVIDER unset: every line said fixed, and the server says so), and a
 * call hears the generated words, the prescribed greeting word for word. No model is asked: the
 * renderer is a fake, and a provider's settings are only read.
 */

let running: RunningServer | null = null;
const dirs: string[] = [];
afterEach(async () => {
  await running?.close();
  running = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function start(env: Record<string, string>, renderer?: Renderer) {
  resetAppsForTest();
  registerApp(messageApp);
  const dir = mkdtempSync(join(tmpdir(), 'wording-'));
  dirs.push(dir);
  const config = loadConfig({ PUBLIC_HOST: 'localhost', TWILIO_AUTH_TOKEN: 't', HANDOFF_NUMBER: '+15551234567', PORT: '0', SIGNATURE_CHECK: 'off', TODAY_OVERRIDE: '2026-10-13', TRACE_DIR: dir, AUDIT_DIR: join(dir, 'audit'), AUDIO_DIR: dir });
  const logs: string[] = [];
  running = await startServer(config, { host: '127.0.0.1', client: new HeuristicStubClient({ todayIso: '2026-10-13', app: messageApp }), log: (l) => logs.push(l), env, ...(renderer ? { renderer } : {}) });
  return { logs, ws: `ws://127.0.0.1:${running.port}` };
}

describe('generated wording on the phone line', () => {
  it('with RENDER_PROVIDER unset, every line is said fixed, and the server says so', async () => {
    const { logs } = await start({});
    expect(logs).toContain('generated wording: 9 lines generated, RENDER_PROVIDER unset: every line said fixed');
  });

  it('with a provider, the server names the model, the share and the budget, never the key', async () => {
    const { logs } = await start({ RENDER_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-test-not-real', RENDER_SHARE: '50' });
    expect(logs).toContain('generated wording: 9 lines worded by claude-haiku-5-5 from anthropic, 50% of calls, within 700 ms on a call and 1500 ms in a chat, its checks 500 and 1000 ms');
    expect(logs.join('\n')).not.toContain('sk-test-not-real');
  });

  it('a call hears the prescribed greeting word for word, and a generated question worded for the moment', async () => {
    const { ws } = await start({}, { client: new FakeRenderClient({ say: { ask_recipient: 'Of course. Is it for Dana Reyes or Lee Park?' } }) });
    const relay = await FakeRelay.connect(`${ws}/conversation?token=${running!.tokens.mint('CA1')}`);
    try {
      relay.setup('CA1');
      const [greeting] = await relay.waitForTexts(1);
      expect(greeting).toBe('Thanks for calling Example Office. This call may be recorded. I can take a message. How can I help?');
      relay.prompt('can I leave a message for Dana');
      const texts = await relay.waitForTexts(3);
      expect(texts.slice(1)).toEqual(['Sure, I can help you take a message.', 'Of course. Is it for Dana Reyes or Lee Park?']);
    } finally {
      relay.close();
    }
  });
});
