import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_KEY_WAIT_MS, forgetNoInput, handleSocketMessage, newConnectionContext, type AdapterDeps } from './adapter';
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
import { CONSENT, textingVariants } from '../testing/texting/variant';

/**
 * Keys at an offer that takes a yes or a no only (the consent question here) on a live call: each key
 * is a frame and a turn of its own, so the server holds them as one answer and settles it when the
 * keys stop (the no-input wait, shortened to KEY_WAIT_MS after a key) or when `#` ends them, which it
 * passes on only then. Replay does the same from the frame log.
 */

const variants = textingVariants();
afterAll(() => variants.remove());
const consent = variants.variant(CONSENT);
resetAppsForTest();
registerApp(consent);
const corpus = loadCorpus(join(variants.dirOf(consent), 'fixtures', 'corpus.jsonl'), consent);
const client = (): JevClient => new FixtureStubClient(corpus, { sharpness: 0.9, fallback: new HeuristicStubClient() });

type Fake = SocketLike & { sent: unknown[] };
function fakeSocket(): Fake {
  const s: Fake = { sent: [], send(d, cb) { s.sent.push(JSON.parse(d)); cb?.(); }, close() {} };
  return s;
}
const texts = (s: Fake) => s.sent.filter((m) => (m as { type: string }).type === 'text').map((m) => (m as { token: string }).token.trimEnd());

const WAIT = 60_000;
function deps(keyWaitMs?: number): AdapterDeps & { dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'keys-'));
  const c = client();
  const store = new SessionStore((callSid) => ({
    session: newSession(callSid, 0, VOICE_RELAY, ANONYMOUS, consent.id),
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
    expect(d.store.get('CA1')!.auditEntries.map((e) => e.type)).not.toContain('consent');
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
});
