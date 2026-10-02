import { describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replayFrameLog } from './replay';
import { testkitApp } from '../testing/testkit';
import { useTestkit } from '../testing/apps';
import { defaultCorpusFile } from '../run/fixtures';
import { handleSocketMessage, newConnectionContext } from '../server/adapter';
import { SessionStore } from '../server/sessions';
import { CallTokens } from '../server/tokens';
import { FrameLog } from '../server/frameLog';
import { newSession } from '../core/session';
import { CODE_DIGIT, runTurn } from '../run/turn';
import { frameToEvent } from '../channel/relay/map';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { loadCorpus } from '../jev/corpus';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import type { JevClient, JevRequest } from '../jev/types';
import { TraceWriter } from '../trace/writer';
import { VOICE_RELAY } from '../channel/caps';

useTestkit();

describe('replayFrameLog', () => {
  it('reproduces a live run decision for decision', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-'));
    const client = new FixtureStubClient(loadCorpus(defaultCorpusFile()), { sharpness: 0.9, fallback: new HeuristicStubClient() });
    const opts = { client, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18', now: () => 0 };
    const store = new SessionStore((callSid) => ({
      session: newSession(callSid, 0, VOICE_RELAY),
      opts: { ...opts, trace: new TraceWriter(join(dir, `${callSid}.jsonl`)) },
      trace: new TraceWriter(join(dir, `${callSid}.jsonl`)),
      frames: new FrameLog(join(dir, `${callSid}.frames.jsonl`), () => 0),
    }), 60_000, () => 0);
    const tokens = new CallTokens(60_000, () => 0);
    const deps = { store, tokens, log: () => {} };
    const sock = { send: (_d: string, cb?: (e?: Error) => void) => cb?.(), close: () => {} };
    const ctx = newConnectionContext(tokens.mint('CA1'));
    const say = (t: string) => handleSocketMessage(deps, sock, ctx, JSON.stringify({ type: 'prompt', voicePrompt: t, lang: 'en-US', last: true }));
    await handleSocketMessage(deps, sock, ctx, JSON.stringify({ type: 'setup', sessionId: 'VX1', callSid: 'CA1', from: '+1', to: '+2', customParameters: {} }));
    await say('can you tell me the status of parcel 7101');
    await handleSocketMessage(deps, sock, ctx, JSON.stringify({ type: 'interrupt', utteranceUntilInterrupt: 'x', durationUntilInterruptMs: 10 }));
    await say('five five five zero one two three four');
    for (const d of '04121985') await handleSocketMessage(deps, sock, ctx, JSON.stringify({ type: 'dtmf', digit: d }));
    for (const d of '123456') await handleSocketMessage(deps, sock, ctx, JSON.stringify({ type: 'dtmf', digit: d }));
    await say("no, that's all");

    const live = readFileSync(join(dir, 'CA1.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    // The frame log's clock is pinned to the epoch, so the date it would replay under is 1970;
    // the birthday slot is date-sensitive, so replay gets the date the live run used.
    const replay = await replayFrameLog(join(dir, 'CA1.frames.jsonl'), { ...opts, trace: null }, undefined, { todayIsoOverride: opts.todayIso });
    const shape = (r: { event: { type: string }; decision: { kind: string; promptId?: string } }) => [r.event.type, r.decision.kind, r.decision.promptId ?? null];
    expect(replay.records.map(shape)).toEqual(live.map(shape));
    expect(replay.records.at(-1)!.decision.kind).toBe('complete');
    expect(replay.skipped).toEqual([]);
  });

  it('passes the code prompt from a log whose code digits are masked, and reaches level 2', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-code-'));
    const client = new FixtureStubClient(loadCorpus(defaultCorpusFile()), { sharpness: 0.9, fallback: new HeuristicStubClient() });
    const opts = { client, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18', now: () => 0 };
    const store = new SessionStore((callSid) => ({
      session: newSession(callSid, 0, VOICE_RELAY),
      opts: { ...opts, trace: new TraceWriter(join(dir, `${callSid}.jsonl`)) },
      trace: new TraceWriter(join(dir, `${callSid}.jsonl`)),
      frames: new FrameLog(join(dir, `${callSid}.frames.jsonl`), () => 0),
    }), 60_000, () => 0);
    const tokens = new CallTokens(60_000, () => 0);
    const deps = { store, tokens, log: () => {} };
    const sock = { send: (_d: string, cb?: (e?: Error) => void) => cb?.(), close: () => {} };
    const ctx = newConnectionContext(tokens.mint('CA1'));
    const say = (t: string) => handleSocketMessage(deps, sock, ctx, JSON.stringify({ type: 'prompt', voicePrompt: t, lang: 'en-US', last: true }));
    await handleSocketMessage(deps, sock, ctx, JSON.stringify({ type: 'setup', sessionId: 'VX1', callSid: 'CA1', from: '+1', to: '+2', customParameters: {} }));
    await say('where is my parcel');
    await say('five five five zero one two three four');
    await say('april twelfth, nineteen eighty five');
    for (const d of '123456') await handleSocketMessage(deps, sock, ctx, JSON.stringify({ type: 'dtmf', digit: d }));

    // The adapter logged each digit of the code masked, so the code itself is not in the log.
    const logged = readFileSync(join(dir, 'CA1.frames.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { dir: string; msg: { type: string; digit?: string } });
    const digits = logged.filter((l) => l.dir === 'in' && l.msg.type === 'dtmf').map((l) => l.msg.digit);
    expect(digits).toEqual(Array(6).fill(CODE_DIGIT));

    const replay = await replayFrameLog(join(dir, 'CA1.frames.jsonl'), { ...opts, trace: null }, undefined, { todayIsoOverride: opts.todayIso });
    expect(replay.skipped).toEqual([]);
    const promptIds = replay.records.map((r) => (r.decision.kind === 'prompt' ? r.decision.promptId : r.decision.kind));
    expect(promptIds).toContain('ask_otp');
    expect(promptIds).not.toContain('otp_failed');
    expect(replay.records.at(-1)!.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_parcelSelect' });
    expect(replay.runs.at(-1)!.result.session.principal.level).toBe(2);
  });

  it('replays an account ID and birth date keyed on the keypad, masked in the log, as the seed customer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-identity-'));
    const client = new FixtureStubClient(loadCorpus(defaultCorpusFile()), { sharpness: 0.9, fallback: new HeuristicStubClient() });
    const opts = { client, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18', now: () => 0 };
    const store = new SessionStore((callSid) => ({
      session: newSession(callSid, 0, VOICE_RELAY),
      opts: { ...opts, trace: new TraceWriter(join(dir, `${callSid}.jsonl`)) },
      trace: new TraceWriter(join(dir, `${callSid}.jsonl`)),
      frames: new FrameLog(join(dir, `${callSid}.frames.jsonl`), () => 0),
    }), 60_000, () => 0);
    const tokens = new CallTokens(60_000, () => 0);
    const deps = { store, tokens, log: () => {} };
    const sock = { send: (_d: string, cb?: (e?: Error) => void) => cb?.(), close: () => {} };
    const ctx = newConnectionContext(tokens.mint('CA1'));
    const key = async (digits: string) => { for (const d of digits) await handleSocketMessage(deps, sock, ctx, JSON.stringify({ type: 'dtmf', digit: d })); };
    await handleSocketMessage(deps, sock, ctx, JSON.stringify({ type: 'setup', sessionId: 'VX1', callSid: 'CA1', from: '+1', to: '+2', customParameters: {} }));
    await handleSocketMessage(deps, sock, ctx, JSON.stringify({ type: 'prompt', voicePrompt: 'i want to book a delivery window', lang: 'en-US', last: true }));
    // A terminator at the account ID question carries nothing, so it is logged as itself and dropped.
    await key('5550#1234');
    await key('04121985');

    const logged = readFileSync(join(dir, 'CA1.frames.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { dir: string; msg: { type: string; digit?: string } });
    const digits = logged.filter((l) => l.dir === 'in' && l.msg.type === 'dtmf').map((l) => l.msg.digit);
    expect(digits).toEqual([...Array(4).fill(CODE_DIGIT), '#', ...Array(12).fill(CODE_DIGIT)]);
    expect(store.get('CA1')!.session.principal).toMatchObject({ kind: 'customer', level: 1 });

    const live = readFileSync(join(dir, 'CA1.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const replay = await replayFrameLog(join(dir, 'CA1.frames.jsonl'), { ...opts, trace: null }, undefined, { todayIsoOverride: opts.todayIso });
    expect(replay.skipped).toEqual([]);
    const shape = (r: { event: { type: string }; decision: { kind: string; promptId?: string } }) => [r.event.type, r.decision.kind, r.decision.promptId ?? null];
    expect(replay.records.map(shape)).toEqual(live.map(shape));
    const last = replay.runs.at(-1)!.result.session;
    expect(last.principal).toMatchObject({ kind: 'customer', level: 1, id: testkitApp.testing?.replay?.identityKeys?.accountId });
    expect(last.slots.dob!.value).toBe('1985-04-12');
  });

  it('skips a second setup for the same call and reports it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay2-'));
    const path = join(dir, 'x.frames.jsonl');
    const log = new FrameLog(path, () => 0);
    log.write('in', { type: 'setup', sessionId: 'VX1', callSid: 'CA1', from: '+1', to: '+2', customParameters: {} });
    log.write('out', { type: 'text', token: 'ignored' });
    log.write('in', { type: 'setup', sessionId: 'VX2', callSid: 'CA1', from: '+1', to: '+2', customParameters: {} });
    log.write('in', { type: 'bogus' });
    const client = new HeuristicStubClient();
    const r = await replayFrameLog(path, { client, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18', now: () => 0, trace: null });
    expect(r.records).toHaveLength(1);
    expect(r.skipped).toEqual(['line 3: setup for CA1 after the session started', 'line 4: unrecognized message']);
  });

  it('ignores frames after the call ended and reports them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-ended-'));
    const path = join(dir, 'CA1.frames.jsonl');
    const log = new FrameLog(path, () => 0);
    const client = new FixtureStubClient(loadCorpus(defaultCorpusFile()), { sharpness: 0.9, fallback: new HeuristicStubClient() });
    const opts = { client, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18', now: () => 0, trace: null };

    // Drive the same events straight through runTurn (bypassing the adapter) to build up a log
    // that ends in two user turns: a parcel question, then a request for a person where the account
    // ID was asked for. The request hands off, so the second turn is the one that ends the call.
    let session = newSession('CA1', 0, VOICE_RELAY);
    const setup = { type: 'setup' as const, sessionId: 'VX1', callSid: 'CA1', from: '+1', to: '+2', customParameters: {} };
    log.write('in', setup);
    session = (await runTurn(session, frameToEvent(setup), opts)).result.session;
    const prompt1 = { type: 'prompt' as const, voicePrompt: 'can you tell me the status of parcel 7101', lang: 'en-US', last: true };
    log.write('in', prompt1);
    session = (await runTurn(session, frameToEvent(prompt1), opts)).result.session;
    const prompt2 = { type: 'prompt' as const, voicePrompt: 'i want to talk to a person', lang: 'en-US', last: true };
    log.write('in', prompt2);
    const finalRun = await runTurn(session, frameToEvent(prompt2), opts);
    session = finalRun.result.session;
    expect(finalRun.result.decision.kind).toBe('handoff');
    expect(session.ended).toBe(true);

    // A stray prompt arrives after the call ended (e.g. a late socket message); replay must not
    // feed it to runTurn.
    log.write('in', { type: 'prompt', voicePrompt: 'hello?', lang: 'en-US', last: true });

    const replay = await replayFrameLog(path, opts);
    expect(replay.records).toHaveLength(3);
    expect(replay.records.at(-1)!.decision.kind).toBe('handoff');
    expect(replay.skipped).toEqual(['line 4: prompt after the call ended']);
  });

  it('uses the frame log clock and date', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-clock-'));
    const path = join(dir, 'CA1.frames.jsonl');
    let t = 0;
    const log = new FrameLog(path, () => t);
    log.write('in', { type: 'setup', sessionId: 'VX1', callSid: 'CA1', from: '+1', to: '+2', customParameters: {} });
    t = 3 * 60_000;
    log.write('in', { type: 'prompt', voicePrompt: 'still there?', lang: 'en-US', last: true });

    const client = new HeuristicStubClient();
    // opts carries a deliberately different clock and date; replay must ignore both in favor of
    // the frame log's own timestamps and the setup line's date.
    const opts = { client, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2099-01-01', now: () => 999_999, trace: null };
    const replay = await replayFrameLog(path, opts);
    expect(replay.skipped).toEqual([]);
    expect(replay.records).toHaveLength(2);
    expect(replay.records[0]!.ts).toBe(new Date(0).toISOString());
    expect(replay.records[1]!.ts).toBe(new Date(t).toISOString());
    expect(replay.records[1]!.turnState?.turn.elapsed).toBe('over_2m');
  });

  it('skips a non-final prompt, as the adapter did when it recorded the call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-partial-'));
    const path = join(dir, 'CA1.frames.jsonl');
    const log = new FrameLog(path, () => 0);
    log.write('in', { type: 'setup', sessionId: 'VX1', callSid: 'CA1', from: '+1', to: '+2', customParameters: {} });
    log.write('in', { type: 'prompt', voicePrompt: 'I need to', lang: 'en-US', last: false });
    log.write('in', { type: 'prompt', voicePrompt: 'I need to track a parcel', lang: 'en-US', last: true });

    const opts = { client: new HeuristicStubClient(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18', trace: null };
    const replay = await replayFrameLog(path, opts);
    expect(replay.skipped).toEqual(['line 2: non-final prompt']);
    expect(replay.records).toHaveLength(2);
    expect(replay.records[1]!.event.type).toBe('user.speech');
  });

  it('replays a recorded silence frame even though parseInbound rejects it live', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-silence-'));
    const path = join(dir, 'CA1.frames.jsonl');
    const log = new FrameLog(path, () => 0);
    log.write('in', { type: 'setup', sessionId: 'VX1', callSid: 'CA1', from: '+1', to: '+2', customParameters: {} });
    // The adapter logs the silence frame it synthesized just like any other inbound message;
    // parseInbound would reject this shape live (silence is server-generated, never on the wire).
    log.write('in', { type: 'silence' });

    const client = new HeuristicStubClient();
    const opts = { client, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18', now: () => 0, trace: null };
    const replay = await replayFrameLog(path, opts);
    expect(replay.skipped).toEqual([]);
    expect(replay.records).toHaveLength(2);
    expect(replay.records[1]!.event.type).toBe('user.silence');
    expect(replay.records[1]!.decision.kind).toBe('prompt');
  });

  it('continues after a turn throws', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-throws-'));
    const path = join(dir, 'CA1.frames.jsonl');
    const log = new FrameLog(path, () => 0);
    log.write('in', { type: 'setup', sessionId: 'VX1', callSid: 'CA1', from: '+1', to: '+2', customParameters: {} });
    log.write('in', { type: 'prompt', voicePrompt: 'hello', lang: 'en-US', last: true });
    log.write('in', { type: 'prompt', voicePrompt: 'still there', lang: 'en-US', last: true });
    log.write('in', { type: 'prompt', voicePrompt: 'yes', lang: 'en-US', last: true });

    const inner = new HeuristicStubClient();
    // The second prompt turn throws (both its asks: perception and the injection screen).
    const client: JevClient = {
      ask(req: JevRequest) {
        if ((req.state as { asr?: { text?: string } }).asr?.text === 'still there') throw new Error('boom');
        return inner.ask(req);
      },
    };
    const opts = { client, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18', now: () => 0, trace: null };
    const replay = await replayFrameLog(path, opts);
    expect(replay.skipped).toEqual(['line 3: turn failed: boom']);
    // setup + the first and third prompt turns; the second turn threw and produced no record.
    expect(replay.records).toHaveLength(3);
  });

  it('skips a line with a missing or unparsable ts instead of throwing or using NaN', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-badts-'));
    const path = join(dir, 'CA1.frames.jsonl');
    const write = (obj: unknown) => appendFileSync(path, JSON.stringify(obj) + '\n');
    write({ ts: new Date(0).toISOString(), dir: 'in', msg: { type: 'setup', sessionId: 'VX1', callSid: 'CA1', from: '+1', to: '+2', customParameters: {} } });
    // line 2: no ts field at all
    write({ dir: 'in', msg: { type: 'prompt', voicePrompt: 'hi', lang: 'en-US', last: true } });
    // line 3: ts is present but not a parsable date
    write({ ts: 'not-a-date', dir: 'in', msg: { type: 'prompt', voicePrompt: 'still there', lang: 'en-US', last: true } });
    write({ ts: new Date(1_000).toISOString(), dir: 'in', msg: { type: 'prompt', voicePrompt: 'yes', lang: 'en-US', last: true } });

    const client = new HeuristicStubClient();
    const opts = { client, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18', now: () => 0, trace: null };
    const replay = await replayFrameLog(path, opts);
    expect(replay.skipped).toEqual(['line 2: missing or invalid ts', 'line 3: missing or invalid ts']);
    // setup (line 1) + the valid prompt (line 4); the two bad-ts lines never reach runTurn.
    expect(replay.records).toHaveLength(2);
  });
});
