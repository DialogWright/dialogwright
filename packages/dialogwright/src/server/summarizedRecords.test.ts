import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
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
import type { JevClient } from '../jev/types';
import { FileCallStateStore } from './stores/file';
import { redactRecord } from './dashboard/events';
import { consoleMetaOf } from './dashboard/meta';
import { configure, reduce, wordingOf } from './dashboard/view.js';
import type { TraceRecord } from '../trace/types';
import { SESSION_SCHEMA } from '../core/session';

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
const SUMMARY = 'please call me about the March invoice before Friday';
/** Distinctive pieces of the message and of its summary: none may be in any record. */
const PIECES = ['charged twice', 'March invoice', 'same delivery', 'call me about'];
/** Short messages, given at the message's question. */
const SHORT = ['call me', 'yes'];

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
  const inner = new FixtureStubClient(corpus, { sharpness: DEFAULT_THRESHOLDS.STUB_SHARPNESS, fallback: new HeuristicStubClient({ todayIso: TODAY, app }), app });
  // A short message the corpus has no line for, given at the message's question: the model says it is the message.
  const client: JevClient = {
    ask: async (req) => {
      const r = await inner.ask(req);
      const heard = (req.state as { asr?: { text?: string }; node?: { id?: string } } | null);
      if (req.questions.messageGiven !== undefined && heard?.node?.id === 'ask_message' && SHORT.includes(heard.asr?.text ?? '')) return { ...r, answers: { ...r.answers, messageGiven: { type: 'noul', noul: 0.95 } } };
      return r;
    },
  };
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
  const logged: string[] = [];
  const d: AdapterDeps & { dir: string } = { store, tokens: new CallTokens(60_000, () => 0), log: (l) => logged.push(l), dir, bus, handoffNumber: '+15555550123' };
  return { d, events, appended, dir, logged };
}

const setup = JSON.stringify({ type: 'setup', sessionId: 'VX1', callSid: 'CA1', from: '+1', to: '+2', customParameters: {} });
const prompt = (t: string) => JSON.stringify({ type: 'prompt', voicePrompt: t, lang: 'en-US', last: true });
const said = (s: Fake): string => s.sent.filter((m) => (m as { type: string }).type === 'text').map((m) => (m as { token: string }).token).join(' ');

/** A step: words said, or an interruption of the line being said, with what the carrier heard of it. */
type Step = string | { interrupt: string };

async function call(render: FakeRenderOptions, steps: Step[]) {
  const h = harness(render);
  const sock = fakeSocket();
  const ctx = newConnectionContext(h.d.tokens.mint('CA1'), sock);
  await handleSocketMessage(h.d, sock, ctx, setup);
  for (const step of steps) {
    await handleSocketMessage(h.d, sock, ctx, typeof step === 'string' ? prompt(step) : JSON.stringify({ type: 'interrupt', utteranceUntilInterrupt: step.interrupt, durationUntilInterruptMs: 2400 }));
  }
  const records = {
    trace: readFileSync(join(h.dir, 'CA1.jsonl'), 'utf8'),
    frames: readFileSync(join(h.dir, 'CA1.frames.jsonl'), 'utf8'),
    console: JSON.stringify(h.events),
    audit: JSON.stringify(h.appended),
    log: h.logged.join('\n'),
  };
  return { said: said(sock), records, session: h.d.store.get('CA1')!.session };
}

const TO_YES = ['can I leave a message for Dana', "it's Morgan Lee", 'five five five five five five zero one four two', MESSAGE, 'yes, pass it on'];
const TO_READ_BACK = TO_YES.slice(0, 4);

/** No piece of `words` in any record. */
function nowhere(records: Record<string, string>, pieces: readonly string[]): void {
  for (const [where, text] of Object.entries(records)) {
    for (const piece of pieces) expect(text.toLowerCase(), `${where}: ${piece}`).not.toContain(piece.toLowerCase());
  }
}

describe('redact: length-summarized (live findings, item 20)', () => {
  it('words the read-back\'s span from the message, and keeps neither the message nor its summary in any record', async () => {
    const r = await call({}, TO_YES);
    // The caller heard the summary, and the message was passed on.
    expect(r.said).toContain(`called and left this message: ${SUMMARY}. Shall I pass it on?`);
    expect(r.said).toContain('has been passed on');
    nowhere(r.records, PIECES);
    // Masked by length, where the trace and the console hold the slot.
    expect(r.records.trace).toContain(`<${MESSAGE.length} chars>`);
    expect(r.records.console).toContain(`<${MESSAGE.length} chars>`);
    // The audit records the write's param by its length.
    expect(r.records.audit).toContain(`<${MESSAGE.length} chars>`);
  });

  it('says the message word for word when the span falls back, still in no record', async () => {
    const r = await call({ spans: { confirm_take_message: new Error('HTTP 500') } }, TO_READ_BACK);
    expect(r.said).toContain(`called and left this message: ${MESSAGE}. Shall I pass it on?`);
    expect(r.session.slots.message!.value).toBe(MESSAGE);
    nowhere(r.records, PIECES);
  });

  it('a summary the checks refused is kept by its length, in the trace and on the console\'s call detail, never whole', async () => {
    // A figure the message does not have: the span falls back to the message, and its wording is refused.
    const refused = 'please call me about the March invoice, 99 dollars twice';
    const r = await call({ spans: { confirm_take_message: refused } }, TO_READ_BACK);
    expect(r.said).toContain(`called and left this message: ${MESSAGE}. Shall I pass it on?`);
    nowhere(r.records, [...PIECES, '99 dollars']);
    // The trace's render line holds the refused wording by its length alone.
    const records = r.records.trace.trim().split('\n').map((l) => JSON.parse(l) as TraceRecord);
    const line = records.flatMap((x) => x.render?.lines ?? []).find((l) => l.promptId === 'confirm_take_message' && l.refused !== undefined)!;
    expect(line).toMatchObject({ mode: 'fixed', fallback: 'foreign', refused: `<${refused.length} chars>` });
    // The console shows what the trace holds: the mask, on the replay's records and on the live events alike.
    const fromTrace = records.flatMap((x) => (x.render ? wordingOf(redactRecord(x, app).render!) : [])).find((w) => w.refused !== undefined)!;
    expect(fromTrace).toMatchObject({ why: 'fell back: a number, date or name it was not given', refused: `<${refused.length} chars>` });
    configure(consoleMetaOf(app));
    const live = reduce(JSON.parse(r.records.console) as DashboardEvent[]).lines.flatMap((l) => l.wording ?? []).find((w) => w.refused !== undefined)!;
    expect(live.refused).toBe(`<${refused.length} chars>`);
  });

  it('an interruption during the read-back: what was heard of our line is kept by its length, in the records and in the session at rest', async () => {
    const heard = "Okay, thanks! I'll make sure Dana Reyes hears that Morgan Lee, on 555 555 0142, called and left this message: please call me about the March";
    const r = await call({}, [...TO_READ_BACK, { interrupt: heard }]);
    nowhere(r.records, PIECES);
    // The session as a store keeps it between turns: only that an interruption happened, the heard words by their length.
    expect(r.session.lastInterrupt).toEqual({ heard: `<${heard.length} chars>`, afterMs: expect.any(Number) });
    const dir = mkdtempSync(join(tmpdir(), 'summarized-store-'));
    const store = new FileCallStateStore(dir);
    await store.save({ callId: 'CA1', provider: 'twilio', schema: SESSION_SCHEMA, session: r.session, reconnects: 0, createdAtMs: 0, lastActivityMs: 0, auditTail: [] });
    const loaded = await store.load('CA1');
    expect(loaded?.session.lastInterrupt?.heard).toBe(`<${heard.length} chars>`);
    // The saved record's interruption carries no words (the slot itself holds the message while the call is open, as every slot holds its value).
    const saved = JSON.parse(readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readFileSync(join(dir, f), 'utf8'))[0]!) as { session: { lastInterrupt: unknown } };
    expect(JSON.stringify(saved.session.lastInterrupt)).not.toContain('March');
  });

  it('"read that back word for word": the exact words are said again, and recorded by their length', async () => {
    const r = await call({}, [...TO_READ_BACK, 'can you read that back word for word']);
    expect(r.said).toContain(`called and left this message: ${MESSAGE}. Shall I pass it on?`);
    nowhere(r.records, PIECES);
  });

  it('the message on a retry, at the name question, and with the request: every caller\'s words by their length', async () => {
    for (const steps of [
      ['can I leave a message for Dana', "it's Morgan Lee", 'five five five five five five zero one four two', 'um', MESSAGE],
      ['can I leave a message for Dana', `it's Morgan Lee, ${MESSAGE}`],
      [`can I leave a message for Dana, ${MESSAGE}`],
    ]) {
      const r = await call({}, steps);
      nowhere(r.records, PIECES);
    }
  });

  it('a short message ("call me") is masked in our lines too; a message "yes" does not corrupt the questions, options or answers', async () => {
    const short = await call({}, [...TO_READ_BACK.slice(0, 3), 'call me']);
    expect(short.session.slots.message!.value).toBe('call me');
    expect(short.said).toContain('left this message: call me');
    nowhere(short.records, ['call me']);
    const yes = await call({}, [...TO_READ_BACK.slice(0, 3), 'yes']);
    expect(yes.session.slots.message!.value).toBe('yes');
    // The questions and the options are the app's words, kept whole: the intent's options among them.
    expect(yes.records.trace).toContain('"dana":"The message is for Dana Reyes');
    expect(yes.records.trace).toContain('"intent":{"type":"choice"');
  });

  it('is listed on the policy card as sent whole to the render model to summarize, masked in the records', () => {
    const card = policyCardText(app, MESSAGE_DIR);
    expect(card).toContain('Sent whole to the render model to summarize; masked in the records');
    expect(card).toContain('| `message` | `confirm_take_message` | by its length, in every record');
    expect(card).toContain('the drift check, which is given the words as quoted. No other line is sent the caller\'s words.');
    expect(card).toContain('a handoff (by its length, whatever app.yaml\'s handoff.data says)');
  });
});
