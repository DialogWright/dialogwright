import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replayFrameLog } from './replay';
import { handleSocketMessage, newConnectionContext } from '../server/adapter';
import { SessionStore } from '../server/sessions';
import { CallTokens } from '../server/tokens';
import { FrameLog } from '../server/frameLog';
import { newSession } from '../core/session';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { TraceWriter } from '../trace/writer';
import type { TraceRecord } from '../trace/types';
import { VOICE_RELAY } from '../channel/caps';
import { registerApp, resetAppsForTest } from '../core/app/registry';
import { registerTestkit } from '../testing/testkit';
import { ANONYMOUS } from '../gate/principal';
import { PLACE_APP_ID, placeApp, placeClient } from '../testing/placeApp';

// A replayed session is the default app's (the first registered), so here that is the place app.
resetAppsForTest();
registerApp(placeApp());
registerTestkit();

/**
 * A caller who had not finished (voice.continueWithinMs, run/continuation.ts), on the wire: the live
 * call from the frames, and the same call replayed from its frame log.
 */
describe('a caller who had not finished, live and replayed', () => {

  function liveCall(app = placeApp()) {
    resetAppsForTest();
    registerApp(app);
    registerTestkit();
    const dir = mkdtempSync(join(tmpdir(), 'replay-joined-'));
    const client = placeClient();
    const opts = { client, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18', now: () => 0 };
    const store = new SessionStore((callSid) => ({
      session: newSession(callSid, 0, VOICE_RELAY, ANONYMOUS, PLACE_APP_ID),
      opts: { ...opts, trace: new TraceWriter(join(dir, `${callSid}.jsonl`)) },
      trace: new TraceWriter(join(dir, `${callSid}.jsonl`)),
      frames: new FrameLog(join(dir, `${callSid}.frames.jsonl`), () => 0),
    }), 60_000, () => 0);
    const tokens = new CallTokens(60_000, () => 0);
    const deps = { store, tokens, log: () => {} };
    const sent: { type: string; token?: string }[] = [];
    const sock = { send: (d: string, cb?: (e?: Error) => void) => { sent.push(JSON.parse(d)); cb?.(); }, close: () => {} };
    const ctx = newConnectionContext(tokens.mint('CA9'));
    const frame = (m: object) => handleSocketMessage(deps, sock, ctx, JSON.stringify(m));
    const records = () => readFileSync(join(dir, 'CA9.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as TraceRecord);
    const replay = () => replayFrameLog(join(dir, 'CA9.frames.jsonl'), { ...opts, client: placeClient(), trace: null }, undefined, { todayIsoOverride: opts.todayIso });
    const start = () => frame({ type: 'setup', sessionId: 'VX9', callSid: 'CA9', from: '+15555550100', to: '+15555550199', customParameters: {} });
    // The relay drops and the carrier opens a new socket for the same call, with a new token.
    let socket = sock;
    let conn = ctx;
    const reconnect = async () => {
      socket = { send: sock.send, close: () => {} };
      conn = newConnectionContext(tokens.mint('CA9'));
      await handleSocketMessage(deps, socket, conn, JSON.stringify({ type: 'setup', sessionId: 'VX10', callSid: 'CA9', from: '+15555550100', to: '+15555550199', customParameters: {} }));
    };
    const send = (m: object) => handleSocketMessage(deps, socket, conn, JSON.stringify(m));
    return { dir, store, sent, frame: send, say: (t: string) => send({ type: 'prompt', voicePrompt: t, lang: 'en-US', last: true }), cut: (heard: string, ms: number) => send({ type: 'interrupt', utteranceUntilInterrupt: heard, durationUntilInterruptMs: ms }), reconnect, records, replay, start, framesPath: join(dir, 'CA9.frames.jsonl') };
  }

  const shape = (r: TraceRecord) => [r.event.type, (r.event as { text?: string }).text ?? null, r.decision.kind, (r.decision as { promptId?: string }).promptId ?? null, r.joined?.fragments ?? null];

  it('joins the fragments on the live call, and replay of its frame log joins them the same way', async () => {
    const call = liveCall();
    await call.start();
    await call.say('i want to report a problem');
    await call.say('at');
    await call.cut('Sorry, where', 119);
    await call.say('22');
    await call.cut('Sorry', 154);
    await call.say('Alder Street.');
    expect(call.store.get('CA9')!.session.slots.place!.value).toBe('at 22 Alder Street.');
    const live = call.records();
    expect(live.at(-1)!.joined).toEqual({ fragments: ['at', '22', 'Alder Street.'] });
    expect(live.at(-1)!.decision).toMatchObject({ kind: 'prompt', promptId: 'confirm_report' });
    // The interrupted re-asks went out once each; the joined turn's line is the read-back, not a re-ask.
    const texts = call.sent.filter((f) => f.type === 'text').map((f) => f.token);
    expect(texts.filter((t) => t === 'Sorry, where is the problem?')).toHaveLength(2);
    expect(texts.at(-1)).toBe('A problem at at 22 Alder Street.. Is that right?');

    const replayed = await call.replay();
    expect(replayed.skipped).toEqual([]);
    expect(replayed.records.map(shape)).toEqual(live.map(shape));
    expect(replayed.runs.at(-1)!.result.session.slots.place!.value).toBe('at 22 Alder Street.');
  });

  it('replays a frame log written before the option (no continueWithinMs line) as that call ran: no joining', async () => {
    const call = liveCall(placeApp({ voice: { continueWithinMs: 0 } }));
    await call.start();
    await call.say('i want to report a problem');
    await call.say('at');
    await call.cut('Sorry, where', 119);
    await call.say('Alder Street.');
    const live = call.records();
    expect(live.every((r) => r.joined === undefined)).toBe(true);
    expect(readFileSync(call.framesPath, 'utf8')).not.toContain('continueWithinMs');
    // The app now joins; the log says the call did not, and replay follows the log.
    resetAppsForTest();
    registerApp(placeApp());
    registerTestkit();
    const replayed = await call.replay();
    expect(replayed.records.map(shape)).toEqual(live.map(shape));
    expect(replayed.runs.at(-1)!.result.session.slots.place!.value).toBe('Alder Street.');
  });

  it('ends joining at a keypad # the server drops, live and replayed', async () => {
    const call = liveCall();
    await call.start();
    await call.say('i want to report a problem');
    await call.say('at');
    await call.cut('Sorry, where', 119);
    await call.frame({ type: 'dtmf', digit: '#' });
    await call.say('22 Alder Street.');
    const live = call.records();
    expect(live.at(-1)!.joined).toBeUndefined();
    expect(call.store.get('CA9')!.session.slots.place!.value).toBe('22 Alder Street.');
    const replayed = await call.replay();
    expect(replayed.records.map(shape)).toEqual(live.map(shape));
  });

  it('ends joining at a reconnect: the caller hears the question again, live and replayed', async () => {
    const call = liveCall();
    await call.start();
    await call.say('i want to report a problem');
    await call.say('at');
    await call.cut('Sorry, where', 119);
    await call.reconnect();
    await call.say('22 Alder Street.');
    const live = call.records();
    expect(live.at(-1)!.joined).toBeUndefined();
    expect(call.store.get('CA9')!.session.slots.place!.value).toBe('22 Alder Street.');
    const replayed = await call.replay();
    expect(replayed.records.map(shape)).toEqual(live.map(shape));
  });

  it('ends joining at a no-input silence in the log', async () => {
    const write = (lines: object[][]) => {
      const path = join(mkdtempSync(join(tmpdir(), 'replay-silence-')), 'x.frames.jsonl');
      const log = new FrameLog(path, () => 0);
      log.write('in', { type: 'setup', sessionId: 'VX8', callSid: 'CA8', from: '+15555550100', to: '+15555550199', customParameters: {} });
      log.write('log', { continueWithinMs: 300 });
      for (const [msg] of lines) log.write('in', msg as never);
      return path;
    };
    const prompt = (t: string) => [{ type: 'prompt', voicePrompt: t, lang: 'en-US', last: true }];
    const cut = [{ type: 'interrupt', utteranceUntilInterrupt: 'Sorry', durationUntilInterruptMs: 119 }];
    const opts = { client: placeClient(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18', now: () => 0, trace: null };
    const joined = await replayFrameLog(write([prompt('i want to report a problem'), prompt('at'), cut, prompt('22')]), opts, undefined, { todayIsoOverride: '2026-09-18' });
    expect(joined.records.at(-1)!.joined).toEqual({ fragments: ['at', '22'] });
    const apart = await replayFrameLog(write([prompt('i want to report a problem'), prompt('at'), cut, [{ type: 'silence' }], prompt('22')]), opts, undefined, { todayIsoOverride: '2026-09-18' });
    expect(apart.records.at(-1)!.joined).toBeUndefined();
    expect(apart.records.at(-1)!.event).toMatchObject({ text: '22' });
  });
});
