import { afterEach, describe, expect, it, vi } from 'vitest';
import { converseCallResources, SessionStore, type SocketLike } from '../sessions';
import { CallTokens } from '../tokens';
import { endFrame, textFrame, type OutboundFrame } from '../../channel/relay/frames';
import { playbackEstimateMs } from '../../channel/relay/playback';
import { voiceIoOf, type AdapterTransportDeps } from './io';

type Fake = SocketLike & { sent: OutboundFrame[] };
function fakeSocket(): Fake {
  const s: Fake = {
    sent: [],
    send(d, cb) { s.sent.push(JSON.parse(d) as OutboundFrame); cb?.(); },
    close() {},
  };
  return s;
}

/** A call held as a converse entry (the io reads its transport fields only), its frame log kept in `logged`. */
function call(provider: string, o: Partial<AdapterTransportDeps> = {}) {
  const logged: { dir: string; msg: unknown }[] = [];
  const store = new SessionStore(
    (callSid, appId) => converseCallResources(callSid, appId ?? 'app', { trace: { write() {} }, frames: { write: (dir, msg) => logged.push({ dir, msg }) } }),
    60_000,
    () => 0,
  );
  const tokens = new CallTokens(60_000, () => 0);
  const socket = fakeSocket();
  const entry = store.createConverse('CA1', socket, provider, 'app');
  tokens.mint('CA1', provider);
  const deps: AdapterTransportDeps = { store, tokens, log: () => {}, ...o };
  return { io: voiceIoOf(entry, deps), socket, logged, store, tokens };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('VoiceIo', () => {
  it('send spaces non-final text on a final-only carrier', async () => {
    const { io, socket, logged } = call('telnyx');
    const first = { ...textFrame('The order is in.', true), last: false };
    const second = textFrame('Anything else?', true);
    expect(await io.send([first, second])).toBe(true);
    expect(socket.sent.map((f) => (f as { token: string }).token)).toEqual(['The order is in. ', 'Anything else?']);
    expect(socket.sent.map((f) => (f as { last: boolean }).last)).toEqual([false, true]);
    expect(logged.filter((l) => l.dir === 'out').map((l) => (l.msg as { token: string }).token)).toEqual(['The order is in. ', 'Anything else?']);
  });

  it('send is false when the call has no socket, and logs the frame dropped', async () => {
    const { io, store, logged } = call('twilio');
    store.detach('CA1');
    expect(await io.send([textFrame('Hello.', true)])).toBe(false);
    expect(logged.map((l) => l.msg)).toEqual([{ dropped: textFrame('Hello.', true) }]);
  });

  it('sendEnd waits for the lines to play on a carrier that drops speech', async () => {
    const { io, socket } = call('telnyx');
    const line = textFrame('Goodbye for now.', true);
    await io.send([line]);
    const done = io.sendEnd(endFrame('completed'));
    await Promise.resolve();
    expect(socket.sent.map((f) => f.type)).toEqual(['text']);
    io.playback({ kind: 'playback', state: 'started' });
    io.playback({ kind: 'playback', state: 'finished', text: 'Goodbye for now.' });
    await done;
    expect(socket.sent.map((f) => f.type)).toEqual(['text', 'end']);
  });

  it('sendEnd sends the end after the estimate times the factor when the report never comes', async () => {
    vi.useFakeTimers();
    const { io, socket } = call('telnyx', { endPlaybackFactor: 3, endPlaybackMarginMs: 0 });
    const line = textFrame('Goodbye for now.', true);
    await io.send([line]);
    // The carrier has reported playback on this call, so the wait is for its report, up to the ceiling.
    io.playback({ kind: 'playback', state: 'started' });
    const done = io.sendEnd(endFrame('completed'));
    const ceilingMs = playbackEstimateMs([line], new Map()) * 3;
    await vi.advanceTimersByTimeAsync(ceilingMs - 1);
    expect(socket.sent.map((f) => f.type)).toEqual(['text']);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(socket.sent.map((f) => f.type)).toEqual(['text', 'end']);
  });

  it('sendEnd sends the end with the lines on a carrier that plays them out', async () => {
    const { io, socket } = call('twilio');
    await io.send([textFrame('Goodbye for now.', true)]);
    await io.sendEnd(endFrame('completed'));
    expect(socket.sent.map((f) => f.type)).toEqual(['text', 'end']);
  });

  it('finish ends the call once', async () => {
    const { io, store, tokens } = call('twilio', { endCloseGraceMs: 60_000 });
    const end = vi.spyOn(store, 'end');
    const revoke = vi.spyOn(tokens, 'revoke');
    await io.finish();
    await io.finish();
    expect(end).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledWith('CA1');
  });
});
