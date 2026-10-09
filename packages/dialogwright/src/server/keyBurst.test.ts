import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_KEY_WAIT_MS, MIN_KEY_WAIT_MS, forgetNoInput, handleSocketMessage, newConnectionContext, type AdapterDeps } from './adapter';
import { SessionStore, type SocketLike } from './sessions';
import { CallTokens } from './tokens';
import { FrameLog } from './frameLog';
import { loadConfig } from './config';
import { newSession } from '../core/session';
import { textConsentOf } from '../core/textConsent';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { loadCorpus } from '../jev/corpus';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import type { JevClient } from '../jev/types';
import { promptText } from '../prompts/render';
import { TraceWriter } from '../trace/writer';
import { replayFrameLog } from '../harness-text/replay';
import { registerApp, resetAppsForTest } from '../core/app/registry';
import { ANONYMOUS } from '../gate/principal';
import { VOICE_RELAY } from '../channel/caps';
import { CONSENT, textingVariants, YES_NO } from '../testing/texting/variant';
import type { App } from '../core/app/types';

/**
 * Keys at an offer that takes a yes or a no only (the consent question here) on a live call: each key
 * is a frame and a turn of its own, so the server holds them as one answer and settles it when the
 * keys stop (the no-input wait, shortened to KEY_WAIT_MS after a key) or when `#` ends them, which it
 * passes on only then. Replay does the same from the frame log.
 */

const variants = textingVariants();
afterAll(() => variants.remove());
const consent = variants.variant(CONSENT);
const yesNo = variants.variant(YES_NO);
resetAppsForTest();
registerApp(consent);
registerApp(yesNo);
const corpusOf = (app: App) => loadCorpus(join(variants.dirOf(app), 'fixtures', 'corpus.jsonl'), app);
const client = (app: App = consent): JevClient => new FixtureStubClient(corpusOf(app), { sharpness: 0.9, fallback: new HeuristicStubClient() });

type Fake = SocketLike & { sent: unknown[] };
function fakeSocket(): Fake {
  const s: Fake = { sent: [], send(d, cb) { s.sent.push(JSON.parse(d)); cb?.(); }, close() {} };
  return s;
}
const texts = (s: Fake) => s.sent.filter((m) => (m as { type: string }).type === 'text').map((m) => (m as { token: string }).token.trimEnd());

const WAIT = 60_000;

/** The audit drafts of every turn of the call, as its trace records them. */
const drafts = (dir: string): { type: string; detail: Record<string, unknown> }[] =>
  readFileSync(join(dir, 'CA1.jsonl'), 'utf8').trim().split('\n').flatMap((l) => (JSON.parse(l) as { audit?: { type: string; detail: Record<string, unknown> }[] }).audit ?? []);
function deps(keyWaitMs?: number, app: App = consent): AdapterDeps & { dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'keys-'));
  const c = client(app);
  const store = new SessionStore((callSid) => ({
    session: newSession(callSid, 0, VOICE_RELAY, ANONYMOUS, app.id),
    opts: { client: c, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-10-08', trace: new TraceWriter(join(dir, `${callSid}.jsonl`)), now: () => 0, render: null, observe: null },
    trace: new TraceWriter(join(dir, `${callSid}.jsonl`)),
    frames: new FrameLog(join(dir, `${callSid}.frames.jsonl`), () => 0),
  }), 60_000, () => 0);
  return { store, tokens: new CallTokens(60_000, () => 0), log: () => {}, dir, noInputMs: WAIT, clipDurations: new Map(), ...(keyWaitMs !== undefined ? { keyWaitMs } : {}) };
}

const setup = JSON.stringify({ type: 'setup', sessionId: 'VX1', callSid: 'CA1', from: '+15555550142', to: '+15555550100', customParameters: {} });
const digit = (d: string) => JSON.stringify({ type: 'dtmf', digit: d });
const CONSENT_Q = promptText(consent, 'consent_texts', { last4: '0142' });
const OPEN = promptText(consent, 'greet_after_offer', {});

async function call(d: AdapterDeps): Promise<{ sock: Fake; send: (m: string) => Promise<void> }> {
  const sock = fakeSocket();
  const ctx = newConnectionContext(d.tokens.mint('CA1'), sock);
  await handleSocketMessage(d, sock, ctx, setup);
  return { sock, send: (m) => handleSocketMessage(d, sock, ctx, m) };
}

describe('keys at the consent question, on a live call', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    forgetNoInput('CA1');
    vi.useRealTimers();
  });

  it('a 1 alone is held until the keys stop, KEY_WAIT_MS later, then granted', async () => {
    const d = deps();
    const { sock, send } = await call(d);
    expect(texts(sock).at(-1)).toBe(CONSENT_Q);
    await send(digit('1'));
    expect(texts(sock).at(-1)).toBe(CONSENT_Q);
    await vi.advanceTimersByTimeAsync(DEFAULT_KEY_WAIT_MS - 1);
    expect(textConsentOf(d.store.get('CA1')!.session)).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(texts(sock).at(-1)).toBe(OPEN);
    expect(textConsentOf(d.store.get('CA1')!.session)).toBe('granted');
    expect(drafts(d.dir).filter((e) => e.type === 'consent').map((e) => [e.detail.granted, e.detail.by])).toEqual([[true, 'keypad']]);
  });

  it('# ends the keys at once', async () => {
    const d = deps();
    const { sock, send } = await call(d);
    await send(digit('2'));
    await send(digit('#'));
    await vi.advanceTimersByTimeAsync(0);
    expect(texts(sock).at(-1)).toBe(OPEN);
    expect(textConsentOf(d.store.get('CA1')!.session)).toBe('declined');
  });

  it('keyWaitMs (KEY_WAIT_MS) sets the wait', async () => {
    const d = deps(500);
    const { sock, send } = await call(d);
    await send(digit('1'));
    await vi.advanceTimersByTimeAsync(499);
    expect(texts(sock).at(-1)).toBe(CONSENT_Q);
    await vi.advanceTimersByTimeAsync(1);
    expect(texts(sock).at(-1)).toBe(OPEN);
  });

  it('a number keyed is asked again once, reaches no menu, and replays the same', async () => {
    const d = deps();
    const { sock, send } = await call(d);
    const before = texts(sock).length;
    for (const k of '2125550199') await send(digit(k));
    // Nothing said while the keys come.
    expect(texts(sock)).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(DEFAULT_KEY_WAIT_MS);
    expect(texts(sock)).toHaveLength(before + 1);
    expect(texts(sock).at(-1)).toBe(CONSENT_Q);
    const s = d.store.get('CA1')!.session;
    expect([textConsentOf(s), s.menuActive, s.dtmfBuffer]).toEqual([null, false, '']);
    expect(drafts(d.dir).map((e) => e.type)).not.toContain('consent');
    expect(drafts(d.dir).filter((e) => e.type === 'gate').map((e) => e.detail.tool)).toEqual(['findCallerByPhone']);
    // Replay holds the keys and settles them at the silence turn, as the call did.
    const replay = await replayFrameLog(join(d.dir, 'CA1.frames.jsonl'), { client: client(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-10-08', trace: null }, undefined, { todayIsoOverride: '2026-10-08' });
    const live = readFileSync(join(d.dir, 'CA1.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { event: { type: string }; decision: { kind: string; promptId?: string } });
    const shape = (r: { event: { type: string }; decision: { kind: string; promptId?: string } }) => [r.event.type, r.decision.kind, r.decision.promptId ?? null];
    expect(replay.records.map(shape)).toEqual(live.map(shape));
  });

  it('replays a # that ended the keys as the call took it', async () => {
    const d = deps();
    const { send } = await call(d);
    await send(digit('1'));
    await send(digit('#'));
    await vi.advanceTimersByTimeAsync(0);
    const replay = await replayFrameLog(join(d.dir, 'CA1.frames.jsonl'), { client: client(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-10-08', trace: null }, undefined, { todayIsoOverride: '2026-10-08' });
    expect(textConsentOf(replay.runs.at(-1)!.result.session)).toBe('granted');
  });
});

describe('KEY_WAIT_MS', () => {
  it('is 2000 unless set', () => {
    const base = { PUBLIC_HOST: 'example.test', TWILIO_AUTH_TOKEN: 'tok', HANDOFF_NUMBER: '+15555550100' };
    expect(loadConfig(base).keyWaitMs).toBe(DEFAULT_KEY_WAIT_MS);
    expect(DEFAULT_KEY_WAIT_MS).toBe(2000);
    expect(loadConfig({ ...base, KEY_WAIT_MS: '1200' }).keyWaitMs).toBe(1200);
  });

  it('refuses a wait under 300 ms, which would settle the keys of a number one at a time', () => {
    const base = { PUBLIC_HOST: 'example.test', TWILIO_AUTH_TOKEN: 'tok', HANDOFF_NUMBER: '+15555550100' };
    expect(MIN_KEY_WAIT_MS).toBe(300);
    for (const raw of ['0', '299']) expect(() => loadConfig({ ...base, KEY_WAIT_MS: raw }), raw).toThrow('KEY_WAIT_MS must be at least 300 milliseconds');
    expect(loadConfig({ ...base, KEY_WAIT_MS: '300' }).keyWaitMs).toBe(300);
  });
});

describe('keys at a slot\'s own yes-or-no offer, on a live call', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    forgetNoInput('CA1');
    vi.useRealTimers();
  });
  const say = (t: string) => JSON.stringify({ type: 'prompt', voicePrompt: t, lang: 'en-US', last: true });
  const OFFER = promptText(yesNo, 'offer_textTo', { last4: '0142' });

  it('a number keyed is asked again once, files nothing, and the 1 after it is the yes', async () => {
    const d = deps(undefined, yesNo);
    const { sock, send } = await call(d);
    await send(say("I'd like to open a request"));
    await send(say("it's about an order"));
    expect(texts(sock).at(-1)).toBe(OFFER);
    const before = texts(sock).length;
    for (const k of '2125550199') await send(digit(k));
    expect(texts(sock)).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(DEFAULT_KEY_WAIT_MS);
    expect(texts(sock).slice(before)).toEqual([OFFER]);
    const entry = d.store.get('CA1')!;
    expect([entry.session.slots.textTo!.value, entry.session.slots.textTo!.declined, entry.session.pendingConfirmation?.target]).toEqual([null, undefined, 'slot']);
    expect(drafts(d.dir).map((e) => e.type)).not.toContain('offer');
    expect(drafts(d.dir).filter((e) => e.type === 'gate').map((e) => e.detail.tool)).toEqual(['findCallerByPhone']);
    // A 1 alone, ended by #: the yes, and the summary is read, nothing filed.
    await send(digit('1'));
    await send(digit('#'));
    await vi.advanceTimersByTimeAsync(0);
    expect(texts(sock).at(-1)).toBe(promptText(yesNo, 'confirm_open_request_text', { topic: 'an order', textTo: '555 555 0142' }));
    expect(entry.session.slots.textTo).toMatchObject({ value: '5555550142', confirmed: true });
    expect(drafts(d.dir).filter((e) => e.type === 'offer').map((e) => [e.detail.answer, e.detail.by])).toEqual([['yes', 'keypad']]);
    expect(drafts(d.dir).filter((e) => e.type === 'gate').map((e) => e.detail.tool)).toEqual(['findCallerByPhone']);
  });
});

