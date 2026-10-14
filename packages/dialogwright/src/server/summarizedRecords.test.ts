import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleSocketMessage, newConnectionContext, type AdapterDeps } from './adapter';
import { SessionStore, type SocketLike } from './sessions';
import { CallTokens } from './tokens';
import { FrameLog } from './frameLog';
import { DashboardBus } from './dashboard/bus';
import type { DashboardEvent } from './dashboard/events';
import { makeObserver } from './dashboard/observer';
import { TraceWriter } from '../trace/writer';
import { newSession } from '../core/session';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { loadCorpus } from '../jev/corpus';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { registerApp, resetAppsForTest } from '../core/app/registry';
import { ANONYMOUS } from '../gate/principal';
import { VOICE_RELAY } from '../channel/caps';
import { MESSAGE_DIR } from '../testing/message/app';
import { messageVariants, SUMMARIZED } from '../testing/message/variant';
import { FakeRenderClient, type FakeRenderOptions } from '../render/fake';
import { policyCardText } from '../testing/policyCard';
import type { App } from '../core/app/types';

/**
 * A slot masked in every record though a model summarizes it (a text slot's `redact: length-summarized`,
 * the message fixture's variant SUMMARIZED), end to end on the voice server: the read-back's span is
 * still worded from the message, the caller still hears the message word for word on a fallback, and
 * neither the message nor its summary is in the trace, the frame log, the console's events or the audit.
 */

const variants = messageVariants();
afterAll(() => variants.remove());
const app: App = variants.variant(SUMMARIZED);
const corpus = loadCorpus(join(MESSAGE_DIR, 'fixtures', 'corpus.jsonl'), app);
const TODAY = '2026-10-13';
const MESSAGE = 'please call me about the March invoice before Friday, I think we were charged twice for the same delivery';
const SUMMARY = 'please call me about the March invoice before';
/** Distinctive pieces of the message and of its summary: none may be in any record. */
const PIECES = ['charged twice', 'March invoice', 'same delivery', 'call me about'];

beforeEach(() => {
  resetAppsForTest();
  registerApp(app);
});

type Fake = SocketLike & { sent: unknown[] };
const fakeSocket = (): Fake => {
  const s: Fake = { sent: [], send(d, cb) { s.sent.push(JSON.parse(d)); cb?.(); }, close() {} };
  return s;
};

function harness(render: FakeRenderOptions) {
  const dir = mkdtempSync(join(tmpdir(), 'summarized-'));
  const bus = new DashboardBus();
  const events: DashboardEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const appended: unknown[] = [];
  const audit = {
    append: (callId: string, channel: 'voice' | 'chat', dr: { type: string; detail: Record<string, unknown> }) => {
      appended.push(dr);
      return { ...dr, seq: appended.length, at: 'x', callId, channel, prevHash: '0', hash: String(appended.length) } as never;
    },
  };
  const client = new FixtureStubClient(corpus, { sharpness: DEFAULT_THRESHOLDS.STUB_SHARPNESS, fallback: new HeuristicStubClient({ todayIso: TODAY, app }), app });
  const store: SessionStore = new SessionStore((callSid) => ({
    session: newSession(callSid, 0, VOICE_RELAY, ANONYMOUS, app.id),
    opts: {
      client, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, now: () => 0, render: null,
      trace: new TraceWriter(join(dir, `${callSid}.jsonl`)),
      observe: makeObserver(bus, store, callSid),
      audit,
      renderer: { client: new FakeRenderClient(render) },
    },
    trace: new TraceWriter(join(dir, `${callSid}.jsonl`)),
    frames: new FrameLog(join(dir, `${callSid}.frames.jsonl`), () => 0),
  }), 60_000, () => 0);
  const d: AdapterDeps & { dir: string } = { store, tokens: new CallTokens(60_000, () => 0), log: () => {}, dir, bus, handoffNumber: '+15555550123' };
  return { d, events, appended, dir };
}

const setup = JSON.stringify({ type: 'setup', sessionId: 'VX1', callSid: 'CA1', from: '+1', to: '+2', customParameters: {} });
const prompt = (t: string) => JSON.stringify({ type: 'prompt', voicePrompt: t, lang: 'en-US', last: true });
const said = (s: Fake): string => s.sent.filter((m) => (m as { type: string }).type === 'text').map((m) => (m as { token: string }).token).join(' ');

async function call(render: FakeRenderOptions, steps: string[]) {
  const h = harness(render);
  const sock = fakeSocket();
  const ctx = newConnectionContext(h.d.tokens.mint('CA1'), sock);
  await handleSocketMessage(h.d, sock, ctx, setup);
  for (const step of steps) await handleSocketMessage(h.d, sock, ctx, prompt(step));
  const records = {
    trace: readFileSync(join(h.dir, 'CA1.jsonl'), 'utf8'),
    frames: readFileSync(join(h.dir, 'CA1.frames.jsonl'), 'utf8'),
    console: JSON.stringify(h.events),
    audit: JSON.stringify(h.appended),
  };
  return { said: said(sock), records, session: h.d.store.get('CA1')!.session };
}

const TO_YES = ['can I leave a message for Dana', "it's Morgan Lee", 'five five five five five five zero one four two', MESSAGE, 'yes, pass it on'];

describe('redact: length-summarized (live findings, item 20)', () => {
  it('words the read-back\'s span from the message, and keeps neither the message nor its summary in any record', async () => {
    const r = await call({}, TO_YES);
    // The caller heard the summary, and the message was passed on.
    expect(r.said).toContain(`called and left this message: ${SUMMARY}. Shall I pass it on?`);
    expect(r.said).toContain('has been passed on');
    for (const [where, text] of Object.entries(r.records)) {
      for (const piece of PIECES) expect(text, `${where}: ${piece}`).not.toContain(piece);
    }
    // Masked by length, where the trace and the console hold the slot.
    expect(r.records.trace).toContain(`<${MESSAGE.length} chars>`);
    expect(r.records.console).toContain(`<${MESSAGE.length} chars>`);
    // The audit records the write's param by its length.
    expect(r.records.audit).toContain(`<${MESSAGE.length} chars>`);
  });

  it('says the message word for word when the span falls back, still in no record', async () => {
    const r = await call({ spans: { confirm_take_message: new Error('HTTP 500') } }, TO_YES.slice(0, 4));
    expect(r.said).toContain(`called and left this message: ${MESSAGE}. Shall I pass it on?`);
    expect(r.session.slots.message!.value).toBe(MESSAGE);
    for (const [where, text] of Object.entries(r.records)) {
      for (const piece of PIECES) expect(text, `${where}: ${piece}`).not.toContain(piece);
    }
  });

  it('is listed on the policy card as sent whole to the render model to summarize, masked in the records', () => {
    const card = policyCardText(app, MESSAGE_DIR);
    expect(card).toContain('Sent whole to the render model to summarize; masked in the records');
    expect(card).toContain('| `message` | `confirm_take_message` | by its length, in every record');
    expect(card).toContain('the drift check, which is given the words as quoted');
  });
});
