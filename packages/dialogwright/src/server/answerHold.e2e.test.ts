import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { startServer, type RunningServer } from './index';
import { loadConfig } from './config';
import { FakeRelay } from '../testing/fakeRelay';
import { registerApp, resetAppsForTest } from '../core/app/registry';
import { defineApp } from '../define/defineApp';
import { HeuristicStubClient } from '../jev/heuristicStub';
import type { AnswerMap, JevClient } from '../jev/types';
import { APP_EDITS, BASE, cleanScratch, codeFor, folder, TODAY } from '../kb/__fixtures__/libraryKbApp';
import { choice, noul } from '../testing/answers';
import { fixedRetriever } from '../testing/retrievers';
import type { Generation, RenderClient, RenderRequest, Renderer } from '../render/types';

/**
 * A knowledge answer worded for the caller's question, whose wording runs past its line's budget: on the
 * phone (Twilio's relay and Telnyx's) and in the chat, the lines before it and the hold line reach the
 * caller while the wording goes on, and the answer follows when it is ready. The render client here
 * answers only when the test lets it, so the hold line is seen to arrive before the answer exists. No
 * model is asked: the perception client, the render client and the judge are test doubles.
 */

const QUESTION = 'how much for a late book';
const HOLD = 'Just a moment while I look that up.';
const WORDED = 'A late book costs 25 cents a day, up to 5 dollars a book.';
const ACCOUNT = 'Your card has 2 dollars in late fees right now.';

const FRAMED_ANSWER = `  kb_answer:
    text: '{answer}'
    interruptible: false
    generate:
      answer:
        from: answer
        goal: Answer the caller's question from the passage.
  kb_hold:
    text: ${HOLD}
    interruptible: false
`;
const dir = folder('library-kb-hold', {
  'prompts.yaml': (t) => APP_EDITS['prompts.yaml']!(t).replace("  kb_answer:\n    text: '{answer}'\n    interruptible: false\n", FRAMED_ANSWER),
  'kb/topics.yaml': (t) => t.replace('    from: getFees\n', '    from: getFees\n  risk: low\n'),
});
const APP = defineApp(dir, { ...codeFor(dir), knowledge: { retriever: fixedRetriever({ [QUESTION]: ['late_fees'] }) } });

/** The same app with a second hold line (kb_hold_more), said past half the answer's limit. */
const MORE = 'Still looking, thanks for waiting.';
const moreDir = folder('library-kb-hold-more', {
  'prompts.yaml': (t) => APP_EDITS['prompts.yaml']!(t).replace("  kb_answer:\n    text: '{answer}'\n    interruptible: false\n", `${FRAMED_ANSWER}  kb_hold_more:\n    text: ${MORE}\n    interruptible: false\n`),
  'kb/topics.yaml': (t) => t.replace('    from: getFees\n', '    from: getFees\n  risk: low\n'),
});
const APP_MORE = defineApp(moreDir, { ...codeFor(moreDir), knowledge: { retriever: fixedRetriever({ [QUESTION]: ['late_fees'] }) } });

/** The decision model: the caller asks the library a question about the late fees, whatever the words. */
const ANSWERS: AnswerMap = { ...BASE, intent: choice({ ask_library: 0.95, none: 0.05 }), libraryTopicTopic: choice({ late_fees: 0.92, none: 0.08 }), manipulation: noul(0.02) };
const perception: JevClient = {
  ask: async (req) => ({ answers: Object.fromEntries(Object.keys(req.questions).filter((k) => Object.hasOwn(ANSWERS, k)).map((k) => [k, ANSWERS[k]!])), model: 'stub', usage: { inputTokens: 0, outputTokens: 0, estimated: true }, latencyMs: 0, source: 'stub:heuristic' }),
};

/** A render client whose answer waits until the test releases it. */
class GatedRenderClient implements RenderClient {
  readonly model = 'fake-render';
  private release: (() => void) | null = null;
  private onAsk: () => void = () => {};
  readonly asked = new Promise<void>((resolve) => { this.onAsk = resolve; });
  generate(_req: RenderRequest, signal: AbortSignal): Promise<Generation> {
    this.onAsk();
    return new Promise((resolve, reject) => {
      this.release = () => resolve({ text: WORDED, model: this.model, usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 0, source: 'fake' });
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  }
  answer(): void {
    this.release?.();
  }
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
afterAll(cleanScratch);

async function start(client: GatedRenderClient, app = APP, answerMs = 10_000): Promise<string> {
  resetAppsForTest();
  registerApp(app);
  const traceDir = mkdtempSync(join(tmpdir(), 'answer-hold-'));
  dirs.push(traceDir);
  const config = loadConfig({
    PUBLIC_HOST: 'localhost', TWILIO_AUTH_TOKEN: 't', VOICE_PROVIDERS: 'twilio,telnyx', TELNYX_PUBLIC_KEY, HANDOFF_NUMBER: '+15551234567', PORT: '0', SIGNATURE_CHECK: 'off',
    TODAY_OVERRIDE: TODAY, TRACE_DIR: traceDir, AUDIT_DIR: join(traceDir, 'audit'), AUDIO_DIR: traceDir, DASHBOARD: 'off', CHAT: 'on', CHAT_ALLOWED_ORIGINS: 'https://www.example.com',
  });
  // The line's budgets small, the answer's own limit long: the hold line is due at once, the answer whenever the test lets it be.
  const renderer: Renderer = { client, timeoutMs: { voice: 30, chat: 30 }, checkTimeoutMs: { voice: 20, chat: 20 }, answerTimeoutMs: { voice: answerMs, chat: answerMs }, drift: new HeuristicStubClient({ todayIso: TODAY, app }) };
  running = await startServer(config, { host: '127.0.0.1', client: perception, log: () => {}, renderer });
  return `ws://127.0.0.1:${running.port}`;
}

/** Waits until `pred` holds, or fails after `ms`. */
async function until(pred: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('the hold line on the phone', () => {
  for (const carrier of ['twilio', 'telnyx'] as const) {
    it(`${carrier}: the lines before the answer and the hold line go out while the answer is worded, then the answer, each reply ending on its own last`, async () => {
      const render = new GatedRenderClient();
      const ws = await start(render);
      const path = carrier === 'twilio' ? '/conversation' : '/conversation/telnyx';
      const relay = await FakeRelay.connect(`${ws}${path}?token=${carrier === 'twilio' ? running!.tokens.mint('CA-hold') : running!.tokens.mint('CA-hold', 'telnyx')}`);
      try {
        relay.setup('CA-hold');
        await relay.waitForTexts(1);
        relay.prompt(QUESTION);
        await render.asked;
        // The answer is not worded yet: the acknowledgement and the hold line have gone out.
        expect((await relay.waitForTexts(3)).slice(1).map((t) => t.trim())).toEqual(['Sure, I can help you answer a question.', HOLD]);
        const textFrames = () => relay.received.filter((m) => m.type === 'text') as unknown as { token: string; last: boolean }[];
        // Telnyx ends a reply at its first last: true, so the hold line's reply ends there: the hold line carries it.
        expect(textFrames()[2]!.last).toBe(true);
        render.answer();
        if (carrier === 'telnyx') {
          // A reply of its own: the answer waits until Telnyx reports the hold line played (its tokensPlayed), so
          // two replies are never in flight and its report names the line that finished.
          await new Promise((r) => setTimeout(r, 300));
          expect(relay.texts()).toHaveLength(3);
          relay.send({ type: 'info', name: 'agentSpeaking', value: 'on' });
          relay.send({ type: 'info', name: 'tokensPlayed', value: `Sure, I can help you answer a question. ${HOLD}` });
        }
        const texts = await relay.waitForTexts(5);
        expect(texts.slice(3).map((t) => t.trim())).toEqual([`${WORDED} ${ACCOUNT}`, 'Is there anything else I can help with?']);
        const after = textFrames().slice(3);
        expect(after.at(-1)!.last).toBe(true);
        if (carrier === 'telnyx') expect(after.slice(0, -1).every((f) => f.last === false)).toBe(true);
      } finally {
        relay.close();
      }
    });
  }
});

describe('a hold line\'s turn on Telnyx, its answer reported played too soon', () => {
  it('says the answer again, never the acknowledgement or the hold line (a live call, 2026-10-18)', async () => {
    const render = new GatedRenderClient();
    const ws = await start(render);
    const relay = await FakeRelay.connect(`${ws}/conversation/telnyx?token=${running!.tokens.mint('CA-resay', 'telnyx')}`);
    try {
      relay.setup('CA-resay');
      await relay.waitForTexts(1);
      relay.prompt(QUESTION);
      await render.asked;
      await relay.waitForTexts(3);
      render.answer();
      relay.send({ type: 'info', name: 'agentSpeaking', value: 'on' });
      relay.send({ type: 'info', name: 'tokensPlayed', value: `Sure, I can help you answer a question. ${HOLD}` });
      await relay.waitForTexts(5);
      // The answer's reply starts, and Telnyx reports it played at once: a cut, by the estimate.
      relay.send({ type: 'info', name: 'agentSpeaking', value: 'on' });
      relay.send({ type: 'info', name: 'tokensPlayed', value: `${WORDED} ${ACCOUNT} Is there anything else I can help with?` });
      relay.send({ type: 'info', name: 'agentSpeaking', value: 'off' });
      const texts = await relay.waitForTexts(7, 5000);
      expect(texts.slice(5).map((t) => t.trim())).toEqual([`${WORDED} ${ACCOUNT}`, 'Is there anything else I can help with?']);
      expect(texts.filter((t) => t.trim() === HOLD)).toHaveLength(1);
    } finally {
      relay.close();
    }
  });
});

describe('the hold line in a chat', () => {
  it('is shown while the answer is worded, and the answer after it, never twice', async () => {
    const render = new GatedRenderClient();
    const ws = await start(render);
    const socket = new WebSocket(`${ws}/chat`, { origin: 'https://www.example.com' });
    const got: { type: string; text?: string }[] = [];
    socket.on('message', (d) => got.push(JSON.parse(d.toString()) as { type: string; text?: string }));
    await new Promise((resolve) => socket.once('open', resolve));
    try {
      socket.send(JSON.stringify({ type: 'start', v: 1 }));
      await until(() => got.some((m) => m.type === 'say'));
      const opening = got.length;
      socket.send(JSON.stringify({ type: 'text', text: QUESTION }));
      await render.asked;
      await until(() => got.slice(opening).filter((m) => m.type === 'say').length >= 2);
      expect(got.slice(opening).flatMap((m) => (m.type === 'say' ? [m.text] : []))).toEqual(['Sure, I can help you answer a question.', HOLD]);
      render.answer();
      await until(() => got.slice(opening).filter((m) => m.type === 'say').length >= 3);
      await new Promise((r) => setTimeout(r, 50));
      const shown = got.slice(opening).flatMap((m) => (m.type === 'say' ? [m.text] : []));
      expect(shown[0]).toBe('Sure, I can help you answer a question.');
      expect(shown[1]).toBe(HOLD);
      expect(shown.slice(2).join(' ')).toBe(`${WORDED} ${ACCOUNT} Is there anything else I can help with?`);
    } finally {
      socket.close();
    }
  });
});

describe('the second hold line, past half the answer\'s limit', () => {
  for (const carrier of ['twilio', 'telnyx'] as const) {
    it(`${carrier}: the hold line, then the second when the wording is still not ready, then the answer, in order and once each`, async () => {
      const render = new GatedRenderClient();
      const ws = await start(render, APP_MORE, 2000);
      const path = carrier === 'twilio' ? '/conversation' : '/conversation/telnyx';
      const relay = await FakeRelay.connect(`${ws}${path}?token=${carrier === 'twilio' ? running!.tokens.mint('CA-more') : running!.tokens.mint('CA-more', 'telnyx')}`);
      try {
        relay.setup('CA-more');
        await relay.waitForTexts(1);
        relay.prompt(QUESTION);
        await render.asked;
        expect((await relay.waitForTexts(3)).slice(1).map((t) => t.trim())).toEqual(['Sure, I can help you answer a question.', HOLD]);
        // On Telnyx each early reply waits for the one before it to have played (its tokensPlayed).
        if (carrier === 'telnyx') {
          relay.send({ type: 'info', name: 'agentSpeaking', value: 'on' });
          relay.send({ type: 'info', name: 'tokensPlayed', value: `Sure, I can help you answer a question. ${HOLD}` });
        }
        // Past half the 2 s limit, the second hold line, with the answer still not worded.
        expect((await relay.waitForTexts(4)).at(-1)!.trim()).toBe(MORE);
        render.answer();
        if (carrier === 'telnyx') {
          relay.send({ type: 'info', name: 'agentSpeaking', value: 'on' });
          relay.send({ type: 'info', name: 'tokensPlayed', value: MORE });
        }
        const texts = await relay.waitForTexts(6);
        expect(texts.slice(1).map((t) => t.trim())).toEqual(['Sure, I can help you answer a question.', HOLD, MORE, `${WORDED} ${ACCOUNT}`, 'Is there anything else I can help with?']);
        const textFrames = relay.received.filter((m) => m.type === 'text') as unknown as { token: string; last: boolean }[];
        // Each batch ends on its own last: the hold line's, the second's, and the answer's reply.
        expect([textFrames[2]!.last, textFrames[3]!.last, textFrames.at(-1)!.last]).toEqual([true, true, true]);
      } finally {
        relay.close();
      }
    });
  }

  it('in a chat: the hold line, the second, then the answer, never twice', async () => {
    const render = new GatedRenderClient();
    const ws = await start(render, APP_MORE, 2000);
    const socket = new WebSocket(`${ws}/chat`, { origin: 'https://www.example.com' });
    const got: { type: string; text?: string }[] = [];
    socket.on('message', (d) => got.push(JSON.parse(d.toString()) as { type: string; text?: string }));
    await new Promise((resolve) => socket.once('open', resolve));
    try {
      socket.send(JSON.stringify({ type: 'start', v: 1 }));
      await until(() => got.some((m) => m.type === 'say'));
      const opening = got.length;
      socket.send(JSON.stringify({ type: 'text', text: QUESTION }));
      await render.asked;
      await until(() => got.slice(opening).filter((m) => m.type === 'say').length >= 3);
      render.answer();
      await until(() => got.slice(opening).filter((m) => m.type === 'say').length >= 4);
      await new Promise((r) => setTimeout(r, 50));
      const shown = got.slice(opening).flatMap((m) => (m.type === 'say' ? [m.text] : []));
      expect(shown.slice(0, 3)).toEqual(['Sure, I can help you answer a question.', HOLD, MORE]);
      expect(shown.slice(3).join(' ')).toBe(`${WORDED} ${ACCOUNT} Is there anything else I can help with?`);
    } finally {
      socket.close();
    }
  });
});
